import { AuthorizationError } from '@xecret/core/authz';
import { DEFAULT_ENVIRONMENTS } from '@xecret/core/validation';
import {
  createEnvironment,
  createProject,
  listProjects,
  RepositoryError,
} from '@xecret/db/repositories';
import type { EnvironmentRecord, ProjectRecord } from '@xecret/db/repositories';
import { actorId } from '@/server/actor';
import { assertSelfGrant, callerHasVault, requireSealingUser } from '@/server/env-keys-service';
import { errors } from '@/server/errors';
import { json, parseJsonBody, parseQuery } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { toGrantSeed } from '@/server/schemas/env-keys';
import {
  pageQuerySchema,
  projectCreateSchema,
  resolveProjectSlug,
  toEnvironment,
  toProject,
  toProjectListItem,
} from '@/server/schemas/resources';
import type { ProjectEnvironmentInit } from '@/server/schemas/resources';
import { authorize, resolveOrg } from '@/server/tenancy';
import type { OrgScope } from '@/server/tenancy';

/**
 * The projects of one organisation, and the endpoint that creates one.
 */

type Params = { orgSlug: string };

export const GET = authenticatedRoute<Params>(async ({ request, params, principal, services }) => {
  const scope = await resolveOrg(principal, params.orgSlug, services);

  // The listing is an organisation-level read, and `project.read` is
  // project-scoped — asked about an organisation, `can()` denies it, because
  // there is no project to resolve a grant against. `member.read` is the
  // org-scoped read capability, and settling it here is what stops a suspended
  // member from enumerating the organisation. Per-project visibility is then
  // decided below, against each project.
  authorize(scope, 'member.read');

  const { page, pageSize } = parseQuery(request, pageQuerySchema);

  // `listProjects` aggregates the environment count in the same statement. A
  // follow-up count per project would be an N+1 on a page the dashboard opens
  // first, in a runtime holding a single pooled connection.
  const result = await listProjects(services.db, scope.organization.id, { page, pageSize });

  return json({
    // Filtered after the query rather than in it: an access grant of `none`
    // denies even an owner (see `grants.ts`), and that rule lives in `can()`,
    // not in SQL. The consequence is honest — a page may return fewer than
    // `pageSize` items — and it is the right way round: the listing must never
    // show a project whose detail route would refuse the same caller.
    projects: result.items.filter((project) => readable(scope, project)).map(toProjectListItem),
    page,
    pageSize,
    // Read one row past the page, so this answers "is there another page?"
    // without a second COUNT(*) over the organisation. Unaffected by the filter
    // above, which is a statement about visibility rather than about rows.
    hasMore: result.hasMore,
  });
});

/**
 * Creates a project, its three default environments, and an Env Data Key for
 * each — atomically.
 */
export const POST = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    await enforce(services.env, 'RL_MUTATION', rateLimitKey([actorId(principal)]));

    const scope = await resolveOrg(principal, params.orgSlug, services);
    const orgId = scope.organization.id;

    try {
      authorize(scope, 'project.create');
    } catch (cause) {
      // `id: null` because the project the caller was refused does not exist and
      // never will. The record still says who tried, in which organisation.
      if (cause instanceof AuthorizationError) {
        record(
          audit(orgId).denied('project.created', { type: 'project', id: null }, cause.decision),
        );
      }
      throw cause;
    }

    // A project arrives with three end-to-end encrypted environments, so the
    // caller has to be a principal that can *seal* — a stricter requirement
    // than this route used to have, and deliberately the same one
    // `POST …/environments` applies. A CLI or service token has no vault, so it
    // has no public key to seal to and no signing key to sign with; it is
    // refused here rather than deep inside a transaction.
    //
    // This also settles `projects.created_by`, which is NOT NULL and must never
    // name a CI credential as the author of anything (T5).
    const createdBy = requireSealingUser(principal);

    const body = await parseJsonBody(request, projectCreateSchema);
    const slug = resolveProjectSlug(body);

    // ── The three default environments, and the keys that come with them ──
    // `environments.encryption_mode` defaults to `e2ee` from migration 0013
    // onward. Before this gate existed the route called `createEnvironment` with
    // no key material at all, and every attempt to create a project died inside
    // the transaction as an unmapped repository error — a 500 reading
    // "Something went wrong." for what is really a caller holding the wrong kind
    // of credential, or a browser whose vault is locked.
    if (body.environments === undefined) {
      throw errors.badRequest(
        "A project's environments are end-to-end encrypted, so it must be created with client-generated keys from an unlocked browser session.",
      );
    }

    if (!(await callerHasVault(services, principal))) {
      throw errors.badRequest(
        'Set up your vault before creating a project: its environment keys are sealed to your public key.',
      );
    }

    // Exactly the defaults, no more and no fewer, and the refusal names what is
    // wrong. The client does not get to choose this set: `DEFAULT_ENVIRONMENTS`
    // owns which environment is production, and that flag decides who may read
    // it.
    const inits = indexEnvironmentInits(body.environments);

    // Every grant must be the creator's own. Without this the route would accept
    // a first grant addressed to any principal of any kind — `grantSchema` takes
    // a `recipientKind` and a uuid, and the foreign keys check that the row
    // exists, not that it belongs to this tenant. At creation there is exactly
    // one public key the caller could honestly have sealed to, and it is theirs.
    // The same assertion `POST …/environments` makes, for the same reason.
    for (const init of inits.values()) assertSelfGrant(init.keys.grant, createdBy);

    /**
     * One transaction for the project and its environments.
     *
     * A project with no environments is a dead end: there is nowhere to put a
     * secret, and the dashboard has nothing to open. Worse, an environment
     * without its Env Data Key is unrepairable from inside the product —
     * `secret_versions.env_key_id` is NOT NULL, and minting a key requires
     * unwrapping the Org Master Key, which only the creation path does. Either
     * all of it commits or none of it does.
     *
     * The environments are created in sequence rather than concurrently:
     * `createEnvironment` opens a SAVEPOINT of its own, and three of those
     * interleaved on one connection would nest in an order nobody chose. Three
     * key derivations on a path a user walks once are not worth that.
     */
    const created = await services.db
      .transaction(async (tx) => {
        const project = await createProject(tx, {
          orgId,
          name: body.name,
          slug,
          description: body.description,
          createdBy,
        });

        const environments: EnvironmentRecord[] = [];
        for (const environment of DEFAULT_ENVIRONMENTS) {
          const init = inits.get(environment.slug);
          // Unreachable — `indexEnvironmentInits` has already established that
          // every default has an entry. A throw rather than a non-null
          // assertion, so a future edit that loosens that check fails loudly
          // instead of writing an environment nobody can ever open.
          if (init === undefined) {
            throw errors.badRequest(`No keys were supplied for "${environment.slug}".`);
          }

          environments.push(
            await createEnvironment(tx, {
              orgId,
              projectId: project.id,
              // The id the grant was sealed against, not one minted here: the
              // AAD names the environment (spec §4.2), so a row written under
              // any other id holds a grant nobody can open — and unlike every
              // other broken state in this system there is no repair, because
              // the key bytes existed only in the browser that generated them.
              id: init.id,
              name: environment.name,
              slug: environment.slug,
              isProduction: environment.isProduction,
              sortOrder: environment.sortOrder,
              encryptionMode: 'e2ee',
              keyInit: { createdBy, grant: toGrantSeed(init.keys.grant) },
            }),
          );
        }

        return { project, environments };
      })
      .catch((cause: unknown) => {
        // The partial unique index on (org_id, slug) is the arbiter, so a
        // conflict here is a genuine race or a repeat submission — a 409 the
        // caller can act on, naming the slug they are competing for.
        if (cause instanceof RepositoryError && cause.code === 'conflict') {
          throw errors.conflict(`A project with the slug "${slug}" already exists.`);
        }
        // `invalid` is the repository refusing the material it was handed — key
        // init that does not match the encryption mode, above all. That is a
        // property of the request, so it answers 400 naming the problem rather
        // than the bare 500 an unmapped `RepositoryError` produces, which is the
        // shape the bug this route is fixing took for every project anyone tried
        // to create.
        if (cause instanceof RepositoryError && cause.code === 'invalid') {
          throw errors.badRequest(cause.message);
        }
        throw cause;
      });

    // The environments are recorded as their own events, not folded into the
    // project's. They are rows a member can later delete, and "who created
    // production?" must have an answer that does not depend on inferring it from
    // a project record.
    record(
      audit(orgId).success(
        'project.created',
        { type: 'project', id: created.project.id, projectId: created.project.id },
        { projectSlug: created.project.slug },
      ),
      ...created.environments.map((environment) =>
        audit(orgId).success(
          'environment.created',
          {
            type: 'environment',
            id: environment.id,
            projectId: created.project.id,
            environmentId: environment.id,
          },
          { projectSlug: created.project.slug, environmentSlug: environment.slug },
        ),
      ),
    );

    return json(
      {
        project: toProject(created.project),
        environments: created.environments.map(toEnvironment),
      },
      { status: 201 },
    );
  },
);

/**
 * Whether the caller may read one project of the listing.
 *
 * Calls `authorize` — the same function every other route uses — rather than
 * re-deriving the decision, so there is no second implementation of the policy
 * to drift from the first. It costs nothing: the scope is already loaded, and
 * `can()` touches neither the network nor the clock.
 */
function readable(scope: OrgScope, project: ProjectRecord): boolean {
  try {
    authorize({ ...scope, project }, 'project.read');
    return true;
  } catch (cause) {
    if (cause instanceof AuthorizationError) return false;
    throw cause;
  }
}

/**
 * Indexes the supplied environment keys by slug, having checked the set is
 * exactly `DEFAULT_ENVIRONMENTS`.
 *
 * The three refusals are separate because they are different mistakes. A
 * *missing* entry is a client that would have created an environment with no key
 * — the unrepairable state this whole path exists to prevent. A *surplus* one
 * names an environment this route does not create, which is the shape of a
 * caller trying to have an environment of its own choosing written under a
 * project's creation permission. A *duplicate* would silently drop one of two
 * grants, and which one depends on iteration order.
 */
function indexEnvironmentInits(
  supplied: readonly ProjectEnvironmentInit[],
): Map<string, ProjectEnvironmentInit> {
  const inits = new Map<string, ProjectEnvironmentInit>();
  for (const init of supplied) {
    if (inits.has(init.slug)) {
      throw errors.badRequest(`Two sets of keys were supplied for "${init.slug}".`);
    }
    inits.set(init.slug, init);
  }

  const expected = DEFAULT_ENVIRONMENTS.map((environment) => environment.slug);

  const missing = expected.filter((slug) => !inits.has(slug));
  if (missing.length > 0) {
    throw errors.badRequest(`Keys are missing for ${missing.join(', ')}.`);
  }

  const surplus = [...inits.keys()].filter(
    (slug) => !expected.includes(slug as (typeof expected)[number]),
  );
  if (surplus.length > 0) {
    throw errors.badRequest(
      `A project starts with ${expected.join(', ')}; keys were supplied for ${surplus.join(', ')}.`,
    );
  }

  return inits;
}

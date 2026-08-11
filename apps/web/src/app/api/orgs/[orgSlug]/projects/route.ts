import { AuthorizationError } from '@xecret/core/authz';
import { DEFAULT_ENVIRONMENTS } from '@xecret/core/validation';
import {
  createEnvironment,
  createProject,
  listProjects,
  RepositoryError,
} from '@xecret/db/repositories';
import type { EnvironmentRecord, ProjectRecord } from '@xecret/db/repositories';
import { actingUserId, actorId } from '@/server/actor';
import { errors } from '@/server/errors';
import { json, parseJsonBody, parseQuery } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import {
  pageQuerySchema,
  projectCreateSchema,
  resolveProjectSlug,
  toEnvironment,
  toProject,
  toProjectListItem,
} from '@/server/schemas/resources';
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

    // Unreachable: `project.create` is not in `SERVICE_TOKEN_ACTIONS`, so the
    // authorization above has already refused the only principal without a user
    // behind it. Written out because `projects.created_by` is NOT NULL and an
    // assertion here would be a claim the type system cannot check — a CI
    // credential must never be able to appear as the author of anything (T5).
    const createdBy = actingUserId(principal);
    if (createdBy === null) throw errors.forbidden('Service tokens cannot create projects.');

    const body = await parseJsonBody(request, projectCreateSchema);
    const slug = resolveProjectSlug(body);

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
          environments.push(
            await createEnvironment(tx, {
              orgId,
              projectId: project.id,
              name: environment.name,
              slug: environment.slug,
              isProduction: environment.isProduction,
              sortOrder: environment.sortOrder,
              envelope: services.envelope,
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

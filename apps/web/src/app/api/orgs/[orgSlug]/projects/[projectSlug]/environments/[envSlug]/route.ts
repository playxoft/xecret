import { AuthorizationError } from '@xecret/core/authz';
import {
  countSecrets,
  RepositoryError,
  softDeleteEnvironment,
  updateEnvironment,
} from '@xecret/db/repositories';
import { actorId } from '@/server/actor';
import { errors } from '@/server/errors';
import { json, noContent, parseJsonBody } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import {
  assertSlugImmutable,
  confirmationMatches,
  destructiveRequestSchema,
  environmentPatchSchema,
  toEnvironment,
} from '@/server/schemas/resources';
import { authorize, resolveEnvironmentPath } from '@/server/tenancy';

/**
 * One environment: its detail, its editable fields, and its removal.
 *
 * `environments` has no `org_id` column — it reaches the organisation through
 * `projects` — which makes this the level where an id lifted from a URL looks
 * most usable on its own. `resolveEnvironmentPath` is the answer: organisation,
 * then project, then environment, each filtered by its parent, and a service
 * token refused anything outside the single environment it is pinned to.
 */

type Params = { orgSlug: string; projectSlug: string; envSlug: string };

export const GET = authenticatedRoute<Params>(async ({ params, principal, services }) => {
  const scope = await resolveEnvironmentPath(principal, params, services);

  // Environment-scoped, and production is deny-by-default: a developer with no
  // explicit grant is refused here even though they can see the project that
  // contains it.
  authorize(scope, 'environment.read');

  // A count, not the secrets. This route says how much is in the environment;
  // producing a plaintext value is a different route, so "where can a secret be
  // decrypted?" stays answerable by grep.
  const secretCount = await countSecrets(services.db, scope.organization.id, scope.environment.id);

  return json({ environment: { ...toEnvironment(scope.environment), secretCount } });
});

export const PATCH = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    await enforce(services.env, 'RL_MUTATION', rateLimitKey([actorId(principal)]));

    const scope = await resolveEnvironmentPath(principal, params, services);
    const orgId = scope.organization.id;
    const resource = {
      type: 'environment' as const,
      id: scope.environment.id,
      projectId: scope.project.id,
      environmentId: scope.environment.id,
    };

    try {
      /**
       * `environment.update` requires `admin` on this environment — a stronger
       * level than deleting a secret in it — and that is not an oversight.
       *
       * This endpoint can flip `is_production`, and that flag is what makes
       * production deny-by-default for everyone below admin: turning it off
       * hands every developer in the organisation write access to an
       * environment that still holds the production secrets it accumulated
       * while the flag was on. No data moves, no permission is granted, and
       * nothing in the audit log for the *secrets* changes — the entire effect
       * is that a boolean now reads `false`. It is the cheapest privilege
       * escalation in the product, so it is gated at the level that also gates
       * granting someone access outright.
       */
      authorize(scope, 'environment.update');
    } catch (cause) {
      if (cause instanceof AuthorizationError) {
        record(audit(orgId).denied('environment.updated', resource, cause.decision));
      }
      throw cause;
    }

    const patch = await parseJsonBody(request, environmentPatchSchema);
    assertSlugImmutable(patch, 'environment');

    const previouslyProduction = scope.environment.isProduction;

    const environment = await updateEnvironment(services.db, orgId, scope.environment.id, {
      name: patch.name,
      isProduction: patch.isProduction,
      sortOrder: patch.sortOrder,
    }).catch(rethrowVanished);

    // Both values, in the record, whenever the classification moved. An audit
    // entry that says only "environment.updated" cannot answer the question this
    // change provokes six months later — "when did production stop being
    // production, and who did it?" — and the row it points at holds only the
    // current value.
    const reclassified = environment.isProduction !== previouslyProduction;

    record(
      audit(orgId).success('environment.updated', resource, {
        projectSlug: scope.project.slug,
        environmentSlug: environment.slug,
        ...(reclassified
          ? { reason: `is_production ${previouslyProduction} -> ${environment.isProduction}` }
          : {}),
      }),
    );

    return json({ environment: toEnvironment(environment) });
  },
);

/**
 * Soft-deletes an environment.
 *
 * The `env_keys` row is left exactly where it is. Deleting it would be
 * cryptographic erasure — every secret ever written in this environment becomes
 * unreadable, including from every backup taken since — and that is far too
 * consequential to happen as a side effect of a delete a user may want to undo.
 * This operation is therefore reversible: the rows are hidden, the key still
 * unwraps them, and restoring the environment restores its contents intact.
 * Crypto-erasure is a separate, deliberate operation on the key itself.
 */
export const DELETE = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    await enforce(services.env, 'RL_MUTATION', rateLimitKey([actorId(principal)]));

    const scope = await resolveEnvironmentPath(principal, params, services);
    const orgId = scope.organization.id;
    const resource = {
      type: 'environment' as const,
      id: scope.environment.id,
      projectId: scope.project.id,
      environmentId: scope.environment.id,
    };

    try {
      authorize(scope, 'environment.delete');
    } catch (cause) {
      if (cause instanceof AuthorizationError) {
        record(audit(orgId).denied('environment.deleted', resource, cause.decision));
      }
      throw cause;
    }

    const body = await parseJsonBody(request, destructiveRequestSchema);

    // The same reasoning as deleting a project that contains production: holding
    // the permission establishes that the caller *may* do this, never that they
    // meant to do it to *this* row. Everything that reads these secrets keeps
    // working until its next deploy, so a misclick here is discovered late, by
    // someone else, in an outage.
    if (
      scope.environment.isProduction &&
      !confirmationMatches(scope.environment.slug, body.confirm)
    ) {
      record(
        audit(orgId).error('environment.deleted', resource, 'invalidInput', {
          projectSlug: scope.project.slug,
          environmentSlug: scope.environment.slug,
        }),
      );

      throw errors.badRequest(
        'This is a production environment. Repeat the request with {"confirm": "<environment slug>"} to delete it.',
      );
    }

    const environment = await softDeleteEnvironment(services.db, orgId, scope.environment.id).catch(
      rethrowVanished,
    );

    record(
      audit(orgId).success('environment.deleted', resource, {
        projectSlug: scope.project.slug,
        environmentSlug: environment.slug,
      }),
    );

    return noContent();
  },
);

/**
 * The environment resolved a moment ago, so a repository miss means it — or the
 * project above it — was deleted concurrently. Answered as absent, which is what
 * the caller would have been told a second later, rather than as the 500 an
 * unmapped `RepositoryError` becomes at the route boundary.
 */
function rethrowVanished(cause: unknown): never {
  if (cause instanceof RepositoryError && cause.code === 'notFound') {
    throw errors.notFound('environment deleted concurrently');
  }
  throw cause;
}

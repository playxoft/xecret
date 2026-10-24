import { auditingDenials } from '@xecret/core/authz';
import type { Denial } from '@xecret/core/authz';
import {
  countSecrets,
  lockReferenceGraph,
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
import {
  assertEnvironmentRemovable,
  crossingRefusal,
  parentSlugOf,
  productionFlagCrossings,
  productionFlagDependents,
  productionFlagDependentsRefusal,
} from '@/server/references-service';
import type { ProtectionCrossing, ProtectionDependency } from '@/server/references-service';
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

  const parentSlug = await parentSlugOf(services, scope.organization.id, scope.environment);
  return json({ environment: { ...toEnvironment(scope.environment, parentSlug), secretCount } });
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

    const refused = (decision: Denial): void =>
      record(audit(orgId).denied('environment.updated', resource, decision));

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
    auditingDenials(refused, () => authorize(scope, 'environment.update'));

    const patch = await parseJsonBody(request, environmentPatchSchema);
    assertSlugImmutable(patch, 'environment');

    const previouslyProduction = scope.environment.isProduction;

    /**
     * Turning the flag *on* is asked again, of the environment as it will be.
     *
     * Everything already written against this environment keeps working once
     * it is production: every grant on it, and every service token pinned to
     * it — a token's level is its own, and never consults the flag. So a
     * caller whose authority stops short of production (a custom role's
     * ceiling of `none` there) could write a colleague `admin` here, or mint
     * a `write` token, while it is staging, then reclassify it: production
     * access past a ceiling nobody lifted. Asking `environment.update` with
     * the flag set asks whether the caller holds `admin` on this environment
     * *as production* — the most anything written here could then confer.
     */
    if (patch.isProduction === true && !previouslyProduction) {
      auditingDenials(refused, () =>
        authorize(
          { ...scope, environment: { ...scope.environment, isProduction: true } },
          'environment.update',
        ),
      );
    }

    /**
     * Flipping `is_production` crosses production's protection exactly as
     * creating a link does (review round 2, F1) — the M3 defense otherwise
     * only ran when a link was made, never when one side's classification
     * changed underneath an unchanged link.
     *
     * Turning it *on* asks about this environment's existing parent and
     * references, same as `parentCrossing`/`referenceCrossings` ask of a
     * link about to be created — nothing moved, only which side is now
     * production. Turning it *off* asks about every still-production
     * environment, here or in another project, that depends on this one:
     * once every developer can write here, each of those reads values whose
     * own access rules no longer apply.
     */
    let crossings: ProtectionCrossing[] = [];
    let dependents: ProtectionDependency[] = [];
    if (patch.isProduction === true && !previouslyProduction) {
      crossings = await productionFlagCrossings(scope, services);
      if (crossings.length > 0 && patch.confirmCrossesProtection !== true) {
        await crossingRefusal(scope, services, crossings);
      }
    } else if (patch.isProduction === false && previouslyProduction) {
      dependents = await productionFlagDependents(scope, services);
      if (dependents.length > 0 && patch.confirmCrossesProtection !== true) {
        productionFlagDependentsRefusal(scope, dependents);
      }
    }

    const update = {
      name: patch.name,
      isProduction: patch.isProduction,
      sortOrder: patch.sortOrder,
    };

    // A confirmed crossing is written under the graph lock, like every other
    // confirmed link (review round 1, L8) — serialised against a concurrent
    // reference or parent change that the crossing list above could not see.
    const environment =
      crossings.length > 0 || dependents.length > 0
        ? await services.db
            .transaction(async (tx) => {
              await lockReferenceGraph(tx, orgId);
              return updateEnvironment(tx, orgId, scope.environment.id, update);
            })
            .catch(rethrowVanished)
        : await updateEnvironment(services.db, orgId, scope.environment.id, update).catch(
            rethrowVanished,
          );

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
      // Its own record per crossing, named against whichever side is
      // production — this environment when the flag just turned on, the
      // dependent when it just turned off — so "since when may staging's
      // writers change production?" stays one filter away (review round 1, M3).
      ...crossings.map(({ source }) =>
        audit(orgId).success('environment.link_crosses_protection', resource, {
          projectSlug: scope.project.slug,
          environmentSlug: scope.environment.slug,
          sourceProjectSlug: source.projectSlug,
          sourceEnvironmentSlug: source.slug,
          reason: 'is_production',
        }),
      ),
      ...dependents.map(({ dependent }) =>
        audit(orgId).success(
          'environment.link_crosses_protection',
          {
            type: 'environment' as const,
            id: dependent.id,
            projectId: dependent.projectId,
            environmentId: dependent.id,
          },
          {
            projectSlug: dependent.projectSlug,
            environmentSlug: dependent.slug,
            sourceProjectSlug: scope.project.slug,
            sourceEnvironmentSlug: scope.environment.slug,
            reason: 'is_production',
          },
        ),
      ),
    );

    return json({
      environment: toEnvironment(
        environment,
        await parentSlugOf(services, scope.organization.id, environment),
      ),
    });
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

    auditingDenials(
      (decision) => record(audit(orgId).denied('environment.deleted', resource, decision)),
      () => authorize(scope, 'environment.delete'),
    );

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

    // P19 §1: an environment another inherits from, or that a template elsewhere
    // points into, would take somebody else's deploy down with it.
    // Checked and deleted in one transaction, under the graph lock, so a parent
    // or a template pointing here cannot land between the two (review round 1, L8).
    const environment = await services.db
      .transaction(async (tx) => {
        await lockReferenceGraph(tx, orgId);
        await assertEnvironmentRemovable(scope, tx);
        return softDeleteEnvironment(tx, orgId, scope.environment.id);
      })
      .catch(rethrowVanished);

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

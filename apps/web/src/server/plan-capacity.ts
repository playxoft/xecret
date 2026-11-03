import { checkLimit } from '@xecret/core/entitlements';
import type { Entitlements, LimitedResource } from '@xecret/core/entitlements';
import { countSecrets, lockCapacity } from '@xecret/db/repositories';
import type { CapacityScope, Executor } from '@xecret/db/repositories';
import { hasCeiling, requireCapacity } from './entitlements';
import type { CapacityOptions } from './entitlements';
import { errors } from './errors';
import type { SecretCapacity } from './secrets-service';
import type { EnvironmentScope } from './tenancy';

/**
 * Plan ceilings, counted where they cannot be raced.
 *
 * A ceiling is "at most n", which no index can say, so it is held by a count —
 * and a count taken before the transaction that writes is a count two
 * concurrent requests both pass. Everything here runs **inside** the creating
 * transaction, **first**: it takes `lockCapacity` for the scope being added to,
 * counts what is live there, and refuses with `requireCapacity` before a row is
 * written. A second creation into the same scope waits on the lock and counts
 * again after the first commits. `server/entitlements.ts` lists the routes that
 * call these, and why only creation is ever refused.
 */

/**
 * What somebody at the CLI-device ceiling can do short of upgrading, said where
 * the refusal reaches them — the consent screen and `xecret login`. Each login
 * is a device, so an old laptop or a login this machine replaced is usually
 * what is holding the place.
 *
 * The Go CLI recognises its opening words ("Revoke a device you no longer use")
 * and then prints no hint of its own beneath it (`cli/internal/api/client.go`),
 * so change them in both places or not at all.
 */
export const CLI_DEVICE_REMEDY =
  'Revoke a device you no longer use — on the Tokens page of this organisation in the ' +
  'dashboard, or by running `xecret logout` on it — then log in again.';

/**
 * Lock `scopeId` for `resource`, count, and refuse unless `adding` more fit.
 *
 * Call it as the first statement of the transaction that creates — before any
 * row lock or write — so the lock it takes can never be waited on by something
 * holding a row this transaction needs (see `lockCapacity`).
 *
 * Where the organisation has no ceiling on `resource` (Enterprise, or a support
 * override to unlimited) it returns at once: no refusal is possible, so there is
 * nothing to count and no reason to serialise its creations behind each other.
 */
export async function withinCapacity(
  tx: Executor,
  entitlements: Entitlements,
  resource: CapacityScope & LimitedResource,
  scopeId: string,
  count: (exec: Executor) => Promise<number>,
  options: CapacityOptions = {},
): Promise<void> {
  if (!hasCeiling(entitlements, resource)) return;
  await lockCapacity(tx, resource, scopeId);
  requireCapacity(entitlements, resource, await count(tx), options);
}

/**
 * The `secretsPerEnvironment` ceiling, as the check every secret write takes.
 *
 * Built by the route and handed to `secrets-service.ts`, which runs it inside
 * its write transaction — after the reference-graph lock when there is one,
 * before any row is touched — and on a dry run too, so an import's preview
 * says what the import would refuse. Handed in rather than imported, so the
 * module that serves secret fetches never reaches a billing decision.
 *
 * A batch that creates nothing passes without counting: an environment past
 * its ceiling can still have every secret it holds rotated, retyped, renamed or
 * removed. One that creates is weighed whole, against what the environment
 * will hold once the batch's own removals are applied.
 *
 * A create whose name a live secret already holds is answered as the `409` it
 * is — "already exists" — even at the ceiling: the request would be refused
 * with room to spare, and a 403 naming the plan would send the person to
 * upgrade for a write that would still fail.
 *
 * `refused` records the attempt (`planRefusal`); a dry run passes none, as a
 * preview is not audited. An environment with no ceiling (Enterprise) is
 * neither counted nor locked.
 */
export function secretCapacity(scope: EnvironmentScope, refused?: () => void): SecretCapacity {
  return async (exec, change) => {
    if (change.creates <= 0 || !hasCeiling(scope.entitlements, 'secretsPerEnvironment')) return;
    if (change.inTransaction) {
      await lockCapacity(exec, 'secretsPerEnvironment', scope.environment.id);
    }
    const orgId = scope.organization.id;
    const environmentId = scope.environment.id;
    const current = await countSecrets(exec, orgId, environmentId, { excluding: change.removals });

    const verdict = checkLimit(
      scope.entitlements,
      'secretsPerEnvironment',
      current,
      change.creates,
    );
    if (verdict.kind === 'exceeded') {
      const taken = await countSecrets(exec, orgId, environmentId, {
        excluding: change.removals,
        named: change.names,
      });
      if (taken > 0) {
        throw errors.conflict('A secret with that name already exists in this environment.');
      }
    }
    requireCapacity(scope.entitlements, 'secretsPerEnvironment', current, {
      adding: change.creates,
      refused,
    });
  };
}

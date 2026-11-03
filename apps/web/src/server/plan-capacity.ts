import type { Entitlements, LimitedResource } from '@xecret/core/entitlements';
import { countSecrets, lockCapacity } from '@xecret/db/repositories';
import type { CapacityScope, Executor } from '@xecret/db/repositories';
import { requireCapacity } from './entitlements';
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
 * Lock `scopeId` for `resource`, count, and refuse unless `adding` more fit.
 *
 * Returns the count it decided from. Call it as the first statement of the
 * transaction that creates — before any row lock or write — so the lock it
 * takes can never be waited on by something holding a row this transaction
 * needs (see `lockCapacity`).
 */
export async function withinCapacity(
  tx: Executor,
  entitlements: Entitlements,
  resource: CapacityScope & LimitedResource,
  scopeId: string,
  count: (exec: Executor) => Promise<number>,
  options: { adding?: number; refused?: (() => void) | undefined } = {},
): Promise<number> {
  await lockCapacity(tx, resource, scopeId);
  const current = await count(tx);
  requireCapacity(entitlements, resource, current, options.adding ?? 1, options.refused);
  return current;
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
 * `refused` records the attempt (`planRefusal`); a dry run passes none, as a
 * preview is not audited.
 */
export function secretCapacity(scope: EnvironmentScope, refused?: () => void): SecretCapacity {
  return async (exec, change) => {
    if (change.creates <= 0) return;
    if (change.inTransaction) {
      await lockCapacity(exec, 'secretsPerEnvironment', scope.environment.id);
    }
    const current = await countSecrets(exec, scope.organization.id, scope.environment.id, {
      excluding: change.removals,
    });
    requireCapacity(scope.entitlements, 'secretsPerEnvironment', current, change.creates, refused);
  };
}

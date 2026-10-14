import { createAuditBuilder } from '@xecret/core/audit';
import type { AuditRecord } from '@xecret/core/audit';
import { listOrganizationsForUser, purgeExpiredRetainedVaults } from '@xecret/db/repositories';
import { DatabaseAuditSink } from './audit-sink';
import type { ServiceContext } from './context';

/**
 * The retained-vault purge: deletes every reset vault whose seven days are over.
 *
 * Batches of {@link PURGE_BATCH}, up to {@link PURGE_MAX_BATCHES} per run, so
 * one run is bounded however far behind it has fallen; the next hourly run takes
 * the rest. Each purged vault is one `vault.purged` record with a `system`
 * actor, in the account's primary organisation — the moment its old passphrase
 * and recovery codes stopped opening anything this server holds.
 *
 * Correctness does not depend on this running on time. Every read of a retained
 * vault filters on its window, so a vault is unrecoverable the instant its seven
 * days end; the purge is what makes it *gone*. And it cannot run early: the
 * database refuses to delete a vault inside its window, by its own clock.
 */

export const PURGE_BATCH = 100;
export const PURGE_MAX_BATCHES = 10;

export async function purgeRetainedVaults(
  services: ServiceContext,
  now: Date = new Date(),
): Promise<number> {
  let total = 0;

  for (let batch = 0; batch < PURGE_MAX_BATCHES; batch += 1) {
    const purged = await purgeExpiredRetainedVaults(services.db, now, PURGE_BATCH);
    total += purged.length;

    const records: AuditRecord[] = [];
    for (const vault of purged) {
      const [primary] = await listOrganizationsForUser(services.db, vault.userId);
      if (primary === undefined) continue;
      records.push(
        createAuditBuilder({
          orgId: primary.organization.id,
          actorType: 'system',
          actorId: null,
          actorLabel: 'retained-vault purge',
          ipAddress: null,
          userAgent: null,
          requestId: services.meta.requestId,
        }).success(
          'vault.purged',
          { type: 'user', id: vault.userId },
          { grantCount: vault.grantCount, reason: 'seven-day retention ended' },
        ),
      );
    }
    // Written before the next batch rather than deferred: this is a scheduled
    // run, nobody is waiting on a response, and a record that a deletion
    // happened must not depend on a flush after it.
    await new DatabaseAuditSink(services.db).write(records);

    if (purged.length < PURGE_BATCH) break;
  }

  if (total > 0) {
    services.log
      .at('purgeRetainedVaults')
      .info(`Purged ${total} retained vault(s) past their window`, {
        purged: total,
      });
  }
  return total;
}

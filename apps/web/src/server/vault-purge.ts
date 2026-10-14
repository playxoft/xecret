import { createAuditBuilder } from '@xecret/core/audit';
import type { AuditRecord } from '@xecret/core/audit';
import {
  appendAuditEvents,
  listOrganizationsForUser,
  purgeExpiredRetainedVaults,
} from '@xecret/db/repositories';
import type { ServiceContext } from './context';

/**
 * The retained-vault purge: deletes every reset vault whose seven days are over.
 *
 * Batches of {@link PURGE_BATCH}, up to {@link PURGE_MAX_BATCHES} per run, so
 * one run is bounded however far behind it has fallen; the next hourly run takes
 * the rest. Which vaults are due is the **database's** answer (`now()`), not
 * this Worker's clock.
 *
 * Each purged vault is one `vault.purged` record with a `system` actor, in the
 * account's primary organisation — the moment its old passphrase and recovery
 * codes stopped opening anything this server holds — written **inside the
 * purge's transaction**, so a deletion and its record commit together or not at
 * all. An account in no organisation has nowhere an audit record can be filed
 * (`audit_logs.org_id` is required); its purge is logged instead, with the
 * account id, and is not skipped.
 *
 * Correctness does not depend on this running on time. Every read of a retained
 * vault filters on its window, so a vault is unrecoverable the instant its seven
 * days end; the purge is what makes it *gone*. And it cannot run early: the
 * database refuses to delete a vault inside its window, by its own clock.
 */

export const PURGE_BATCH = 100;
export const PURGE_MAX_BATCHES = 10;

export async function purgeRetainedVaults(services: ServiceContext): Promise<number> {
  let total = 0;
  const unfiled: string[] = [];

  for (let batch = 0; batch < PURGE_MAX_BATCHES; batch += 1) {
    const purged = await purgeExpiredRetainedVaults(
      services.db,
      PURGE_BATCH,
      async (tx, vaults) => {
        const records: AuditRecord[] = [];
        for (const vault of vaults) {
          const [primary] = await listOrganizationsForUser(tx, vault.userId);
          if (primary === undefined) {
            unfiled.push(vault.userId);
            continue;
          }
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
        if (records.length > 0) await appendAuditEvents(tx, records);
      },
    );
    total += purged.length;
    if (purged.length < PURGE_BATCH) break;
  }

  if (unfiled.length > 0) {
    services.log
      .at('purgeRetainedVaults')
      .info('Purged retained vaults of accounts in no organisation, so with no audit record', {
        accounts: unfiled.length,
        userIds: unfiled,
      });
  }
  if (total > 0) {
    services.log
      .at('purgeRetainedVaults')
      .info(`Purged ${total} retained vault(s) past their window`, { purged: total });
  }
  return total;
}

import { FREE_SEAT_LIMIT, WARN_AT } from '@xecret/core/entitlements';
import {
  appendAuditEvents,
  currentUsage,
  entitlementsFromRow,
  listEndedCancellations,
  listProviderSubscriptions,
  listSeatSyncs,
  lockSubscription,
  pruneReminders,
  writeSubscriptionState,
} from '@xecret/db/repositories';
import type { SubscriptionRecord } from '@xecret/db/repositories';
import type { ServiceContext } from '../context';
import { describeError } from '../logging';
import { subscriptionResource, systemAudit } from './audit';
import { billingProvider } from './client';
import { billingSetup } from './config';
import type { BillingConfig } from './config';
import { sendBillingReminder } from './reminders';
import { syncSeats } from './seats';
import { flushUsageToDodo } from './usage';
import type { UsageReport } from './usage';

/**
 * The hourly billing job (P12), run by the Worker's Cron Trigger beside the
 * retained-vault purge (`worker.ts`, `server/scheduled.ts`).
 *
 * Four steps, each independent of the others — one failing is logged and the
 * rest still run:
 *
 *  1. **Ended cancellations.** A subscription cancelled with its period still
 *     running keeps the paid plan until `current_period_end`. Dodo normally
 *     says when that boundary passes; this is the fallback when it does not,
 *     and it waits {@link CANCELLATION_GRACE_MS} past the boundary so Dodo's
 *     own event lands first. The organisation returns to Free, nothing deleted.
 *     If a later Dodo event says the subscription lives on after all, the
 *     webhook re-applies it.
 *  2. **Seat-sync debts**, retried with backoff and pushed as the count is now.
 *  3. **The overage report** (`flushUsageToDodo`).
 *  4. **The billing reminders** that come from a date rather than an event:
 *     trials ending, yearly renewals, usage at 80% and 100% of the allowance,
 *     and — once a day — cards about to expire.
 *
 * Nothing here ever touches the data path, and nothing here corrects a
 * difference between our rows and Dodo's: that is the nightly reconciler's to
 * *report* (`reconcile.ts`), never to fix.
 */

/** How long after a cancelled period's end the job waits for Dodo's own event. */
export const CANCELLATION_GRACE_MS = 2 * 60 * 60 * 1000;

/** The UTC hour the card-expiry check runs in — once a day, one Dodo call per paying customer. */
export const CARD_CHECK_HOUR_UTC = 9;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface HourlyReport {
  ended: number;
  seatSyncs: number;
  usage: UsageReport | null;
  reminders: number;
  failures: string[];
}

export async function runHourlyBillingJob(
  services: ServiceContext,
  now: Date = new Date(),
): Promise<HourlyReport> {
  const report: HourlyReport = { ended: 0, seatSyncs: 0, usage: null, reminders: 0, failures: [] };
  const setup = billingSetup(services.env);
  if (setup.state === 'disabled') return report;
  const log = services.log.at('runHourlyBillingJob');

  const step = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (cause) {
      report.failures.push(name);
      log.error(`The hourly billing job's ${name} step failed; the next run tries again`, {
        error: describeError(cause),
      });
    }
  };

  await step('ended-cancellations', async () => {
    report.ended = await endLapsedCancellations(services, now);
  });
  await step('seat-syncs', async () => {
    report.seatSyncs = await retrySeatSyncs(services, now);
  });
  await step('usage', async () => {
    report.usage = await flushUsageToDodo(services);
  });
  await step('reminders', async () => {
    report.reminders = await sendDueReminders(services, setup.config, now);
  });
  await step('prune', async () => {
    // A reminder's occasion is long past after a year; the row only stops a repeat.
    await pruneReminders(services.db, new Date(now.getTime() - 400 * DAY_MS));
  });

  log.info('Ran the hourly billing job', {
    ended: report.ended,
    seatSyncs: report.seatSyncs,
    unitsReported: report.usage?.units ?? 0,
    reminders: report.reminders,
    failedSteps: report.failures.length,
  });
  return report;
}

/** Step 1. */
async function endLapsedCancellations(services: ServiceContext, now: Date): Promise<number> {
  let ended = 0;
  for (const candidate of await listEndedCancellations(services.db, 100)) {
    const due = candidate.currentPeriodEnd;
    if (due === null || due.getTime() + CANCELLATION_GRACE_MS > now.getTime()) continue;

    const changed = await services.db.transaction(async (tx) => {
      // Re-read under the row's lock: a webhook may have moved it since.
      const row = await lockSubscription(tx, candidate.orgId);
      if (
        row === null ||
        row.plan === 'free' ||
        !row.cancelAtPeriodEnd ||
        row.currentPeriodEnd === null ||
        row.currentPeriodEnd.getTime() + CANCELLATION_GRACE_MS > now.getTime()
      ) {
        return false;
      }
      await writeSubscriptionState(
        tx,
        row.orgId,
        {
          plan: 'free',
          billingInterval: null,
          status: 'active',
          cancelAtPeriodEnd: false,
          currentPeriodStart: null,
          currentPeriodEnd: null,
          trialEndsAt: null,
          dodoProductId: null,
          renewalAmountMinor: null,
        },
        { billed: 1, enforced: FREE_SEAT_LIMIT },
      );
      await appendAuditEvents(tx, [
        systemAudit(services, row.orgId, 'billing job').success(
          'plan.changed',
          subscriptionResource(row.orgId),
          {
            plan: 'free',
            previousPlan: row.plan,
            subscriptionStatus: 'active',
            previousSubscriptionStatus: row.status,
            seatCount: 1,
            previousSeatCount: row.seats,
            reason: 'cancelled subscription reached the end of its paid period',
          },
        ),
      ]);
      return true;
    });
    if (changed) ended += 1;
  }
  return ended;
}

/**
 * Step 2. A debt is retried at once the first time, then after 2, 4, 8 …
 * minutes, capped at a day, and raised for a human after six failures.
 */
async function retrySeatSyncs(services: ServiceContext, now: Date): Promise<number> {
  let attempted = 0;
  for (const debt of await listSeatSyncs(services.db, 50)) {
    if (debt.attempts > 0 && debt.lastAttemptAt !== null) {
      const waitMs = Math.min(2 ** debt.attempts * 60_000, DAY_MS);
      if (debt.lastAttemptAt.getTime() + waitMs > now.getTime()) continue;
    }
    attempted += 1;
    const outcome = await syncSeats(services, debt.orgId);
    if (outcome === 'failed' && debt.attempts + 1 === 6) {
      services.log
        .at('retrySeatSyncs')
        .error(
          'A seat change has failed to reach Dodo six times; the organisation is billed for a ' +
            'seat count its membership no longer has. Check the subscription in Dodo',
          { orgId: debt.orgId, lastError: debt.lastError },
        );
    }
  }
  return attempted;
}

/** Step 4. */
async function sendDueReminders(
  services: ServiceContext,
  config: BillingConfig,
  now: Date,
): Promise<number> {
  let sent = 0;
  const send = async (
    row: SubscriptionRecord,
    occasion: string,
    reminder: Parameters<typeof sendBillingReminder>[1]['reminder'],
  ) => {
    const outcome = await sendBillingReminder(services, { orgId: row.orgId, occasion, reminder });
    if (outcome === 'sent') sent += 1;
  };
  const checkCards = now.getUTCHours() === CARD_CHECK_HOUR_UTC;
  const provider = checkCards ? billingProvider(config) : null;

  let after: string | undefined;
  for (;;) {
    const page = await listProviderSubscriptions(services.db, { limit: 100, afterOrgId: after });
    if (page.length === 0) break;
    after = page[page.length - 1]!.orgId;

    for (const row of page) {
      try {
        // Trials ending: three days out, then one.
        if (row.status === 'trialing' && row.trialEndsAt !== null) {
          const left = row.trialEndsAt.getTime() - now.getTime();
          const occasion = row.trialEndsAt.toISOString();
          if (left > 0 && left <= DAY_MS) {
            await send(row, occasion, {
              kind: 'trial_ending_1d',
              plan: row.plan,
              trialEndsAt: row.trialEndsAt,
            });
          } else if (left > DAY_MS && left <= 3 * DAY_MS) {
            await send(row, occasion, {
              kind: 'trial_ending_3d',
              plan: row.plan,
              trialEndsAt: row.trialEndsAt,
            });
          }
        }

        // A yearly renewal, seven days out, with the amount: an unannounced
        // yearly charge is the commonest cause of a chargeback.
        if (
          row.billingInterval === 'yearly' &&
          !row.cancelAtPeriodEnd &&
          row.currentPeriodEnd !== null &&
          row.status !== 'trialing'
        ) {
          const left = row.currentPeriodEnd.getTime() - now.getTime();
          if (left > 0 && left <= 7 * DAY_MS) {
            await send(row, row.currentPeriodEnd.toISOString(), {
              kind: 'renewal_upcoming',
              plan: row.plan,
              renewsAt: row.currentPeriodEnd,
              amountMinor: row.renewalAmountMinor,
              currency: row.currency,
            });
          }
        }

        // Usage at 80% and 100% of the allowance, once each per period.
        const included = entitlementsFromRow(row).limits.includedFetchesPerMonth;
        if (included > 0) {
          const usage = await currentUsage(services.db, row.orgId);
          const occasion = usage.periodStart.toISOString();
          if (usage.secretFetches >= included) {
            await send(row, occasion, { kind: 'usage_100', used: usage.secretFetches, included });
          } else if (usage.secretFetches >= included * WARN_AT) {
            await send(row, occasion, { kind: 'usage_80', used: usage.secretFetches, included });
          }
        }

        // A card about to expire, fourteen days out — when no saved card
        // outlives the window, so a customer who already added a new one is
        // not told to.
        if (provider !== null && row.dodoCustomerId !== null && !row.cancelAtPeriodEnd) {
          const expiries = [...(await provider.cardExpiries(row.dodoCustomerId)).values()];
          if (expiries.length > 0) {
            const lastUsableDay = (expiry: { month: number; year: number }) =>
              new Date(Date.UTC(expiry.year, expiry.month, 0, 23, 59, 59));
            const latest = expiries
              .map(lastUsableDay)
              .sort((a, b) => b.getTime() - a.getTime())[0]!;
            const left = latest.getTime() - now.getTime();
            if (left > 0 && left <= 14 * DAY_MS) {
              await send(
                row,
                `card:${row.currentPeriodEnd?.toISOString() ?? latest.toISOString()}`,
                {
                  kind: 'card_expiring',
                  expiresAfter: latest,
                  renewsAt: row.currentPeriodEnd,
                },
              );
            }
          }
        }
      } catch (cause) {
        services.log
          .at('sendDueReminders')
          .warn('Could not work out one organisation’s reminders', {
            orgId: row.orgId,
            error: describeError(cause),
          });
      }
    }
    if (page.length < 100) break;
  }
  return sent;
}

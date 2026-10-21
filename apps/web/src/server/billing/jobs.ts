import { FREE_SEAT_LIMIT, WARN_AT } from '@xecret/core/entitlements';
import {
  appendAuditEvents,
  awaitingActivation,
  claimBillingAlert,
  currentUsage,
  entitlementsFromRow,
  listAwaitingActivation,
  listDueSeatSyncs,
  listEndedCancellations,
  listLapsedTrials,
  listLongHolds,
  listProviderSubscriptions,
  lockSubscription,
  operatorManaged,
  pruneBillingRequests,
  pruneReminders,
  writeSubscriptionState,
} from '@xecret/db/repositories';
import type {
  ProviderSubscriptionPatch,
  SubscriptionRecord,
  Transaction,
} from '@xecret/db/repositories';
import type { ServiceContext } from '../context';
import { describeError } from '../logging';
import { subscriptionResource, systemAudit } from './audit';
import { billingProvider, DodoApiError } from './client';
import { billingSetup } from './config';
import type { BillingConfig } from './config';
import { runBillingEffects } from './effects';
import type { BillingEffect } from './effects';
import { applySubscriptionSnapshot } from './handlers/subscription';
import type { SnapshotOutcome } from './handlers/subscription';
import type { DodoSubscription } from './payloads';
import { sendBillingReminder } from './reminders';
import { syncSeats } from './seats';
import { flushUsageToDodo } from './usage';
import type { UsageReport } from './usage';

/**
 * The hourly billing job (P12), run by the Worker's Cron Trigger beside the
 * retained-vault purge (`worker.ts`, `server/scheduled.ts`).
 *
 * Its steps are independent of each other — one failing is logged and the
 * rest still run:
 *
 *  1. **Ended cancellations.** A subscription cancelled with its period still
 *     running keeps the paid plan until `current_period_end`. Dodo normally
 *     says when that boundary passes; this is the fallback when it does not,
 *     and it waits {@link CANCELLATION_GRACE_MS} past the boundary so Dodo's
 *     own event lands first. The organisation returns to Free, nothing deleted.
 *     If a later Dodo event says the subscription lives on after all, the
 *     webhook re-applies it.
 *  2. **Long holds.** A subscription on hold for {@link HOLD_LIMIT_MS} — a
 *     card that never paid, a trial that ended with no card — ends here, to
 *     Free, with an alert for a human and an email to the owners. Without it,
 *     a subscription Dodo keeps on hold would keep its plan for ever. Nothing
 *     is deleted, and the subscription itself is left to Dodo: if it is paid
 *     after all, its `active` snapshot gives the plan back.
 *  3. **Stale trials.** A row still `trialing` hours after its trial ended has
 *     missed whatever Dodo sent at the conversion. Dodo is asked what the
 *     subscription is now, and that snapshot is applied as a webhook's would
 *     be. **Stranded checkouts** the same way: a Free row a checkout's payment
 *     linked to a subscription whose snapshot never arrived.
 *  4. **Seat-sync debts** that are due, pushed as the count is now.
 *  5. **The overage report** (`flushUsageToDodo`).
 *  6. **The billing reminders** that come from a date rather than an event:
 *     trials ending, yearly renewals, usage at 80% and 100% of the allowance,
 *     and — once a day — cards about to expire.
 *
 * Nothing here ever touches the data path. Only steps 1–3 change a row, and
 * each only what its own date already decided; every other difference between
 * our rows and Dodo's is the nightly reconciler's to *report* (`reconcile.ts`),
 * never to fix. Steps 1–3 never touch an operator's grant either — a paid row
 * following a subscription id with no product recorded (`operatorManaged`) is
 * left out of their lists, and the reconciler reports it once.
 */

/** How long after a cancelled period's end the job waits for Dodo's own event. */
export const CANCELLATION_GRACE_MS = 2 * 60 * 60 * 1000;

/** How long a subscription may stay on hold before it is ended here. */
export const HOLD_LIMIT_MS = 14 * 24 * 60 * 60 * 1000;

/** How long after a trial's end a row still `trialing` is asked about. */
export const TRIAL_GRACE_MS = 2 * 60 * 60 * 1000;

/**
 * How long after a checkout's payment linked its subscription the job asks
 * Dodo why it never activated. Dodo's own `active` normally lands within a
 * minute of the payment; this leaves its retries a good while first.
 */
export const ACTIVATION_GRACE_MS = 30 * 60 * 1000;

/**
 * How long after a checkout's payment linked its subscription a wait Dodo
 * cannot end — the subscription still pending, or unknown to it — is raised
 * for a human. Once: the row keeps waiting, and is still asked about hourly.
 */
export const ACTIVATION_ALERT_AFTER_MS = 24 * 60 * 60 * 1000;

/** Stranded checkouts asked about per run, at one Dodo call each. */
const ACTIVATION_CHECKS_PER_RUN = 500;

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
    report.ended += await endLapsedCancellations(services, now);
  });
  await step('long-holds', async () => {
    report.ended += await endLongHolds(services, now);
  });
  await step('stale-trials', async () => {
    await refreshLapsedTrials(services, setup.config, now);
  });
  await step('stranded-activations', async () => {
    await refreshStrandedActivations(services, setup.config, now);
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
    // An idempotency key only has to outlive a browser's retries.
    await pruneBillingRequests(services.db, new Date(now.getTime() - DAY_MS));
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

/**
 * The row of a subscription that ended here: Free, nothing deleted, and every
 * provider column that only meant something while it was paid cleared —
 * support's limit overrides included, which were granted on the plan that
 * ended. The subscription id stays, so Dodo's later events still find it.
 */
const ENDED_HERE: ProviderSubscriptionPatch = {
  plan: 'free',
  billingInterval: null,
  status: 'active',
  cancelAtPeriodEnd: false,
  currentPeriodStart: null,
  currentPeriodEnd: null,
  trialEndsAt: null,
  dodoProductId: null,
  renewalAmountMinor: null,
  meteredFrom: null,
  onHoldSince: null,
  dodoScheduledChangeAt: null,
  limitOverrides: null,
};

/** Step 1. */
async function endLapsedCancellations(services: ServiceContext, now: Date): Promise<number> {
  let ended = 0;
  for (const candidate of await listEndedCancellations(services.db, 100)) {
    const due = candidate.currentPeriodEnd;
    if (due === null || due.getTime() + CANCELLATION_GRACE_MS > now.getTime()) continue;

    const changed = await services.db.transaction(async (tx) => {
      // Re-read under the row's lock: a webhook — or an operator — may have
      // moved it since.
      const row = await lockSubscription(tx, candidate.orgId);
      if (
        row === null ||
        row.plan === 'free' ||
        operatorManaged(row) ||
        !row.cancelAtPeriodEnd ||
        row.currentPeriodEnd === null ||
        row.currentPeriodEnd.getTime() + CANCELLATION_GRACE_MS > now.getTime()
      ) {
        return false;
      }
      await writeSubscriptionState(tx, row.orgId, ENDED_HERE, {
        billed: 1,
        enforced: FREE_SEAT_LIMIT,
      });
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

/** Step 2. */
async function endLongHolds(services: ServiceContext, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - HOLD_LIMIT_MS);
  let ended = 0;
  for (const candidate of await listLongHolds(services.db, { since: cutoff, limit: 100 })) {
    const endedRow = await services.db.transaction(async (tx) => {
      const row = await lockSubscription(tx, candidate.orgId);
      if (
        row === null ||
        row.plan === 'free' ||
        operatorManaged(row) ||
        row.status !== 'on_hold' ||
        row.onHoldSince === null ||
        row.onHoldSince > cutoff
      ) {
        return null;
      }
      await writeSubscriptionState(tx, row.orgId, ENDED_HERE, {
        billed: 1,
        enforced: FREE_SEAT_LIMIT,
      });
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
            reason: 'subscription on hold for 14 days without a payment',
          },
        ),
      ]);
      return row;
    });
    if (endedRow === null) continue;
    ended += 1;
    const days = Math.floor((now.getTime() - endedRow.onHoldSince!.getTime()) / DAY_MS);
    await runBillingEffects(services, [
      {
        kind: 'alert',
        message:
          `A subscription was on hold for ${days} days and has been ended here: the organisation ` +
          'is on Free. Dodo still has the subscription — cancel it there, or leave it if the ' +
          'customer is about to pay (its next active event gives the plan back)',
        fields: { orgId: endedRow.orgId, previousPlan: endedRow.plan },
      },
      {
        kind: 'mail',
        orgId: endedRow.orgId,
        occasion: `${endedRow.dodoSubscriptionId ?? 'none'}:${endedRow.onHoldSince!.toISOString()}`,
        reminder: { kind: 'plan_ended_unpaid', plan: endedRow.plan, days },
      },
    ]);
  }
  return ended;
}

/**
 * Applies what Dodo says a subscription is now, as a webhook's snapshot would
 * be — for the steps that ask Dodo themselves (stale trials, stranded
 * checkouts). `then` runs in the same transaction, with the outcome, for what
 * the step itself does about the decision.
 *
 * One difference from a webhook: a step asks again every hour, so a
 * subscription on a product this deployment does not sell would be raised —
 * the alert and the drift record — every hour until the catalogue is fixed.
 * It is raised once per subscription and product (`claimBillingAlert`), and
 * still applied by the first run after the fix.
 */
async function applyRefreshedSnapshot(
  services: ServiceContext,
  config: BillingConfig,
  orgId: string,
  snapshot: DodoSubscription,
  now: Date,
  then?: (tx: Transaction, outcome: SnapshotOutcome) => Promise<void>,
): Promise<void> {
  const outcome = await services.db.transaction(async (tx) => {
    const applied = await applySubscriptionSnapshot(tx, {
      orgId,
      eventType: 'subscription.refreshed',
      // Dodo's answer now is the newest thing known about it.
      eventAt: now,
      now,
      snapshot,
      config,
      audit: systemAudit(services, orgId, 'billing job'),
      webhookId: null,
      checkout: null,
    });
    if (
      applied.ignored === 'unknown-product' &&
      !(await claimBillingAlert(tx, {
        orgId,
        kind: 'alert_unknown_product',
        occasion: `${snapshot.subscription_id}:${snapshot.product_id}`,
      }))
    ) {
      applied.audit = [];
      applied.effects = [];
    }
    if (then) await then(tx, applied);
    if (applied.audit.length > 0) await appendAuditEvents(tx, applied.audit);
    return applied;
  });
  if (outcome.effects.length > 0) await runBillingEffects(services, outcome.effects);
}

/** Step 3. */
async function refreshLapsedTrials(
  services: ServiceContext,
  config: BillingConfig,
  now: Date,
): Promise<void> {
  const log = services.log.at('refreshLapsedTrials');
  const provider = billingProvider(config);
  const rows = await listLapsedTrials(services.db, {
    endedBefore: new Date(now.getTime() - TRIAL_GRACE_MS),
    mode: config.mode,
    limit: 50,
  });
  for (const row of rows) {
    if (row.dodoSubscriptionId === null) continue;
    try {
      const snapshot = await provider.getSubscription(row.dodoSubscriptionId);
      if (snapshot.subscription_id !== row.dodoSubscriptionId) continue;
      await applyRefreshedSnapshot(services, config, row.orgId, snapshot, now);
    } catch (cause) {
      log.warn('Could not ask Dodo what a lapsed trial became; the next run asks again', {
        orgId: row.orgId,
        ...(cause instanceof DodoApiError
          ? { category: cause.category }
          : { error: describeError(cause) }),
      });
    }
  }
}

/**
 * Step 3b. A checkout whose payment linked its subscription to a Free row,
 * and whose snapshot never came — the `subscription.active` lost, or
 * refused until Dodo stopped retrying. The customer has paid and is still on
 * Free, and the row refuses another checkout while it waits. Dodo is asked
 * what the subscription is, and that is applied as a webhook's snapshot
 * would be: the plan, if it is live.
 *
 * If it ended before it ever activated — `decideSnapshot`'s own reading of
 * ended (`subscriptionHasEnded`): expired, failed, or cancelled with its
 * period over — the link is marked as resolved, so the row stops waiting (and
 * a new checkout is offered again), and a human is told. A wait Dodo cannot
 * end — the subscription still pending, or unknown to it — is raised once,
 * {@link ACTIVATION_ALERT_AFTER_MS} after the link, and keeps being asked.
 */
async function refreshStrandedActivations(
  services: ServiceContext,
  config: BillingConfig,
  now: Date,
): Promise<void> {
  const log = services.log.at('refreshStrandedActivations');
  const provider = billingProvider(config);
  const linkedBefore = new Date(now.getTime() - ACTIVATION_GRACE_MS);

  let after: string | undefined;
  let asked = 0;
  while (asked < ACTIVATION_CHECKS_PER_RUN) {
    const page = await listAwaitingActivation(services.db, {
      linkedBefore,
      mode: config.mode,
      limit: 50,
      afterOrgId: after,
    });
    if (page.length === 0) break;
    after = page[page.length - 1]!.orgId;

    for (const row of page) {
      const subscriptionId = row.dodoSubscriptionId;
      if (subscriptionId === null) continue;
      asked += 1;
      const overdue = now.getTime() - row.updatedAt.getTime() >= ACTIVATION_ALERT_AFTER_MS;
      const stillWaiting = (dodoSays: string): BillingEffect => ({
        kind: 'alert',
        message:
          `A checkout was paid a day ago but Dodo ${dodoSays} — the organisation is still on ` +
          'Free and cannot check out again while it waits. Check the subscription and its ' +
          'payment in Dodo; the hourly job keeps asking, and applies the plan once it is active',
        fields: { orgId: row.orgId },
      });

      try {
        const snapshot = await provider.getSubscription(subscriptionId);
        if (snapshot.subscription_id !== subscriptionId) continue;
        await applyRefreshedSnapshot(
          services,
          config,
          row.orgId,
          snapshot,
          now,
          async (tx, outcome) => {
            if (outcome.ignored === 'already-free') {
              // Ended before it activated: nothing to grant, and the wait is over.
              const current = await lockSubscription(tx, row.orgId);
              if (
                current !== null &&
                awaitingActivation(current) &&
                current.dodoSubscriptionId === subscriptionId
              ) {
                await writeSubscriptionState(tx, row.orgId, {
                  dodoEventAt: now,
                  dodoEventId: null,
                });
                outcome.effects.push({
                  kind: 'alert',
                  message:
                    'A checkout was paid but its subscription ended at Dodo before it ever ' +
                    'activated — the organisation stays on Free and may check out again. Check ' +
                    'whether the payment was refunded in Dodo',
                  fields: { orgId: row.orgId, subscriptionStatus: snapshot.status },
                });
              }
            } else if (
              outcome.ignored === 'pending' &&
              overdue &&
              (await claimBillingAlert(tx, {
                orgId: row.orgId,
                kind: 'alert_activation_waiting',
                occasion: subscriptionId,
              }))
            ) {
              outcome.effects.push(stillWaiting('still has its subscription pending'));
            }
          },
        );
      } catch (cause) {
        log.warn(
          'Could not ask Dodo what a paid checkout’s subscription became; the next run asks again',
          {
            orgId: row.orgId,
            ...(cause instanceof DodoApiError
              ? { category: cause.category }
              : { error: describeError(cause) }),
          },
        );
        if (
          cause instanceof DodoApiError &&
          cause.category === 'not_found' &&
          overdue &&
          (await claimBillingAlert(services.db, {
            orgId: row.orgId,
            kind: 'alert_activation_waiting',
            occasion: subscriptionId,
          }))
        ) {
          await runBillingEffects(services, [stillWaiting('does not know its subscription')]);
        }
      }
    }
    if (page.length < 50) break;
  }
}

/**
 * Step 4. Only debts that are due: past their backoff (2, 4, 8 … minutes,
 * capped at a day), not waiting for a scheduled plan change, not held by a
 * push in flight, and not given up on — so stuck debts wait outside the list
 * and cannot crowd out a newer one. A debt that fails too often is given up
 * on, and raised once, by `syncSeats`.
 */
async function retrySeatSyncs(services: ServiceContext, now: Date): Promise<number> {
  let attempted = 0;
  for (const debt of await listDueSeatSyncs(services.db, now, 50)) {
    attempted += 1;
    await syncSeats(services, debt.orgId);
  }
  return attempted;
}

/** Step 6. */
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
      // A row of the other Dodo mode is not this deployment's to remind about.
      if (row.dodoMode !== null && row.dodoMode !== config.mode) continue;
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
              // The amount is in the currency Dodo reported it in.
              currency: row.dodoCurrency ?? row.currency,
            });
          }
        }

        // Usage at 80% and 100% of the allowance, once each per month — the
        // allowance the month recorded, which is the one it is billed past.
        const usage = await currentUsage(services.db, row.orgId);
        const included =
          usage.includedFetches ?? entitlementsFromRow(row).limits.includedFetchesPerMonth;
        if (included > 0) {
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

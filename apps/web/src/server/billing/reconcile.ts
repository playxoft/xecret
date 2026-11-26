import type { BillingDriftField } from '@xecret/core/audit';
import { providerSeats, resolvePlanId } from '@xecret/core/entitlements';
import {
  appendAuditEvents,
  claimBillingAlert,
  listProviderSubscriptions,
  listSeatSyncs,
  operatorManaged,
  SEAT_SYNC_SCHEDULED_CHANGE,
  seatedMemberCount,
} from '@xecret/db/repositories';
import type { SeatSyncRecord, SubscriptionRecord } from '@xecret/db/repositories';
import type { ServiceContext } from '../context';
import { describeError } from '../logging';
import { subscriptionResource, systemAudit } from './audit';
import { billingProvider, DodoApiError } from './client';
import { billingSetup, catalogEntryFor } from './config';
import type { BillingConfig } from './config';
import type { DodoSubscription } from './payloads';
import { readTrial } from './snapshot';

/**
 * The daily reconciler (P12): every subscription Dodo bills, compared with
 * our row — plan, interval, product, status, seats, period end, trial end,
 * cancellation, add-on.
 *
 * **Alert-only.** A difference is recorded (`billing.drift_detected`, naming
 * the fields) and raised as an error line for a human. Nothing is corrected:
 * silent correction hides the bug that caused the drift, and the bug is the
 * thing worth finding (01-billing §P12). The webhook is how state changes;
 * this is how we find out it did not.
 *
 * **Seats are compared with the membership, not only with our row.** What Dodo
 * should bill is `providerSeats(plan, seated members)` — the count the seat
 * sync pushes — so a membership change whose push never reached Dodo, and
 * whose debt was lost or given up on, is drift even when our `seats` column
 * agrees with Dodo's quantity. Our row disagreeing with Dodo is drift too.
 *
 * Two differences are expected and not reported: seats with a seat-sync debt
 * still being retried (the hourly job is already pushing them — a debt given
 * up on is reported), and a period end within a day of Dodo's (renewals land
 * minutes apart from the date they name).
 *
 * **A debt waiting for a scheduled plan change is not "being retried".** The
 * seat sync bills an increase over a scheduled change at once (`seats.ts`),
 * and waits only where it cannot — the change due within a day, or one whose
 * product Dodo did not name. An increase still waiting after
 * {@link DEFERRED_INCREASE_GRACE_MS} is people using seats nobody is billed
 * for until the change lands: reported as `seats` drift, with its own line
 * saying so. Before 2026-11-25 every debt not given up on hid the seats, and
 * an increase put off for a yearly plan's downgrade was invisible for a year.
 * A waiting *decrease* is the customer paying for a seat until the change
 * lands, then credited: expected, and not reported.
 *
 * Rows recorded under the other Dodo mode are not compared: this deployment's
 * key cannot see them, and they would all read as missing. Nor is an
 * operator's grant written over an old subscription's id (a paid row with the
 * id and no product, `operatorManaged`): it is reported once, not nightly.
 */

/** How far apart the two period ends — or trial ends — may be before it is drift. */
const PERIOD_END_TOLERANCE_MS = 24 * 60 * 60 * 1000;
/** Subscriptions compared per run; at one Dodo call each. */
const MAX_PER_RUN = 2_000;

/**
 * How long a seat debt may wait for a scheduled plan change before an
 * unbilled increase behind it is reported. Short: the push that waits is the
 * exception (`seats.ts`), and every day it waits is seats given away.
 */
export const DEFERRED_INCREASE_GRACE_MS = 2 * 60 * 60 * 1000;

/**
 * What the organisation's seat debt says about a seat difference:
 *
 *  - `none`: no debt, or one given up on — the difference is drift.
 *  - `pending`: a debt being retried — the hourly job is already pushing it.
 *  - `waiting`: a debt put off past {@link DEFERRED_INCREASE_GRACE_MS} for a
 *    plan change Dodo has scheduled — an increase behind it is drift; a
 *    decrease is expected.
 */
export type SeatDebtState = 'none' | 'pending' | 'waiting';

/** The state of one debt, by `now`. Exported for tests. */
export function seatDebtState(debt: SeatSyncRecord | undefined, now: Date): SeatDebtState {
  if (debt === undefined || debt.deadLetteredAt !== null) return 'none';
  const waiting =
    debt.lastError === SEAT_SYNC_SCHEDULED_CHANGE &&
    debt.notBefore !== null &&
    debt.notBefore > now &&
    now.getTime() - debt.queuedAt.getTime() > DEFERRED_INCREASE_GRACE_MS;
  return waiting ? 'waiting' : 'pending';
}

export interface ReconcileReport {
  checked: number;
  drifted: number;
  unreachable: number;
}

/** Which of our fields disagree with Dodo's subscription. Pure; exported for tests. */
export function driftBetween(
  row: SubscriptionRecord,
  dodo: DodoSubscription,
  config: BillingConfig,
  seatDebt: SeatDebtState,
  /** Members holding a seat now — what the bill should follow. */
  seatedMembers: number,
): BillingDriftField[] {
  const drift: BillingDriftField[] = [];
  const entry = catalogEntryFor(config, dodo.product_id);

  if (entry === null || dodo.product_id !== row.dodoProductId) drift.push('product');
  if (entry !== null && entry.plan !== resolvePlanId(row.plan)) drift.push('plan');
  if (entry !== null && entry.interval !== row.billingInterval) drift.push('interval');

  const expected: Record<string, readonly string[]> = {
    active: ['active', 'trialing'],
    past_due: ['past_due'],
    on_hold: ['on_hold'],
    paused: ['on_hold'],
    // A running cancellation keeps its status; the flag carries it.
    cancelled: ['active', 'trialing', 'past_due', 'on_hold'],
    // Ended, failed or never started: our row should already be on Free —
    // and the rows compared here are not.
    expired: [],
    failed: [],
    pending: [],
  };
  if (!(expected[dodo.status] ?? []).includes(row.status)) drift.push('status');

  // What the membership says Dodo should bill, on the plan Dodo has.
  const owed = providerSeats(entry?.plan ?? resolvePlanId(row.plan), seatedMembers).billed;
  if (
    seatDebt === 'none'
      ? dodo.quantity !== owed || dodo.quantity !== row.seats
      : seatDebt === 'waiting' && owed > dodo.quantity
  ) {
    drift.push('seats');
  }

  const dodoEnd = new Date(dodo.next_billing_date).getTime();
  if (
    row.currentPeriodEnd === null ||
    Number.isNaN(dodoEnd) ||
    Math.abs(row.currentPeriodEnd.getTime() - dodoEnd) > PERIOD_END_TOLERANCE_MS
  ) {
    drift.push('periodEnd');
  }

  // The trial, read from Dodo by the rule the webhook wrote the row by
  // (`readTrial`). Dodo's status says `active` through a trial, so a row
  // whose trial was ended by a declined upgrade — or kept running after a
  // paid one — disagrees only here.
  //
  // The row's own end is an input only where Dodo no longer carries the fact:
  // while a trial runs the reading is Dodo's alone (its length, its next
  // charge); once one is over, the row's end is the history a renewal's dates
  // no longer show; and where Dodo stops reporting the length, the row's end
  // stands in for the booked one only if a paid period could have begun there
  // — an end Dodo's next charge contradicts reads as a trial still running to
  // it, and is reported here instead of agreeing with itself.
  const trialEnd = readTrial(dodo, row.trialEndsAt).endsAt;
  if (
    (trialEnd === null) !== (row.trialEndsAt === null) ||
    (trialEnd !== null &&
      row.trialEndsAt !== null &&
      Math.abs(row.trialEndsAt.getTime() - trialEnd.getTime()) > PERIOD_END_TOLERANCE_MS)
  ) {
    drift.push('trialEnd');
  }

  const dodoCancels = dodo.cancel_at_next_billing_date || dodo.status === 'cancelled';
  if (dodoCancels !== row.cancelAtPeriodEnd) drift.push('cancelAtPeriodEnd');

  if (config.samlAddonId !== null) {
    const dodoHasSaml = (dodo.addons ?? []).some(
      (addon) => addon.addon_id === config.samlAddonId && addon.quantity > 0,
    );
    // Our row holding the add-on without Dodo billing it may be an operator's
    // grant; either way a human decides, which is what reporting it is for.
    if (dodoHasSaml !== row.addonSaml) drift.push('addon');
  }

  return drift;
}

export async function reconcileSubscriptions(services: ServiceContext): Promise<ReconcileReport> {
  const report: ReconcileReport = { checked: 0, drifted: 0, unreachable: 0 };
  const setup = billingSetup(services.env);
  if (setup.state === 'disabled') return report;
  const { config } = setup;
  const provider = billingProvider(config);
  const log = services.log.at('reconcileSubscriptions');

  // Debts still being retried explain a seat difference; one given up on
  // explains nothing, and is reported like any other — and one waiting for a
  // scheduled change explains a decrease, never an increase.
  const now = new Date();
  const debts = new Map(
    (await listSeatSyncs(services.db, 10_000)).map((debt) => [debt.orgId, debt] as const),
  );

  let after: string | undefined;
  while (report.checked < MAX_PER_RUN) {
    const page = await listProviderSubscriptions(services.db, { limit: 100, afterOrgId: after });
    if (page.length === 0) break;
    after = page[page.length - 1]!.orgId;

    for (const row of page) {
      if (row.dodoSubscriptionId === null) continue;
      if (row.dodoMode !== null && row.dodoMode !== config.mode) continue;
      if (operatorManaged(row)) {
        await reportOperatorGrant(services, row, row.dodoSubscriptionId);
        continue;
      }
      report.checked += 1;

      let drift: BillingDriftField[];
      const seatDebt = seatDebtState(debts.get(row.orgId), now);
      /** An increase waiting for a scheduled change: what Dodo bills, and what is seated. */
      let unbilled: { billed: number; owed: number } | null = null;
      try {
        const dodo = await provider.getSubscription(row.dodoSubscriptionId);
        const seated = await seatedMemberCount(services.db, row.orgId);
        drift = driftBetween(row, dodo, config, seatDebt, seated);
        if (seatDebt === 'waiting' && drift.includes('seats')) {
          const entry = catalogEntryFor(config, dodo.product_id);
          unbilled = {
            billed: dodo.quantity,
            owed: providerSeats(entry?.plan ?? resolvePlanId(row.plan), seated).billed,
          };
        }
      } catch (cause) {
        if (cause instanceof DodoApiError && cause.category === 'not_found') {
          drift = ['missing'];
        } else {
          report.unreachable += 1;
          log.warn('Could not compare one subscription with Dodo tonight', {
            orgId: row.orgId,
            ...(cause instanceof DodoApiError
              ? { category: cause.category }
              : { error: describeError(cause) }),
          });
          continue;
        }
      }

      if (drift.length === 0) continue;
      report.drifted += 1;
      await appendAuditEvents(services.db, [
        systemAudit(services, row.orgId, 'billing reconciler').error(
          'billing.drift_detected',
          subscriptionResource(row.orgId),
          'conflict',
          { driftFields: drift, plan: row.plan },
        ),
      ]);
      log.error(
        'A subscription disagrees with Dodo — nothing was corrected. Find out why before ' +
          'changing either side (docs/operations/billing.md, "Drift")',
        { orgId: row.orgId, driftFields: drift },
      );
      if (unbilled !== null) {
        log.error(
          'Seats added while a plan change is scheduled are not billed yet: Dodo bills ' +
            `${unbilled.billed}, the membership holds ${unbilled.owed}, and the seat push is ` +
            'waiting for the scheduled change to land. Check the scheduled change in Dodo ' +
            '(docs/operations/billing.md, "Seat-sync debts")',
          {
            orgId: row.orgId,
            billedSeats: unbilled.billed,
            owedSeats: unbilled.owed,
            scheduledChangeAt: row.dodoScheduledChangeAt?.toISOString() ?? null,
          },
        );
      }
    }
    if (page.length < 100) break;
  }

  log.info(`Reconciled ${report.checked} subscription(s) with Dodo`, { ...report });
  return report;
}

/**
 * A paid row that follows a subscription id with no product recorded — an
 * operator's grant written over the id of a subscription that ended
 * (`operatorManaged`). Not compared: Dodo's record of the old subscription is
 * not what the grant follows, and every night would report the same product
 * drift (or `missing`). Reported once instead, per subscription id, for a
 * human to take the row off it.
 */
async function reportOperatorGrant(
  services: ServiceContext,
  row: SubscriptionRecord,
  subscriptionId: string,
): Promise<void> {
  const first = await services.db.transaction(async (tx) => {
    const claimed = await claimBillingAlert(tx, {
      orgId: row.orgId,
      kind: 'alert_operator_managed',
      occasion: subscriptionId,
    });
    if (claimed) {
      await appendAuditEvents(tx, [
        systemAudit(services, row.orgId, 'billing reconciler').error(
          'billing.drift_detected',
          subscriptionResource(row.orgId),
          'conflict',
          { driftFields: ['product'], plan: row.plan },
        ),
      ]);
    }
    return claimed;
  });
  if (!first) return;
  services.log
    .at('reconcileSubscriptions')
    .error(
      'A paid organisation follows a Dodo subscription id with no product recorded — an ' +
        'operator’s grant written over the id of a subscription that ended. It is not compared ' +
        'with Dodo, and the hourly job leaves it alone. Check the subscription is not live in ' +
        'Dodo, then take the organisation off it with plan:set --over-dodo',
      { orgId: row.orgId, plan: row.plan },
    );
}

import type { BillingDriftField } from '@xecret/core/audit';
import { providerSeats, resolvePlanId } from '@xecret/core/entitlements';
import {
  appendAuditEvents,
  claimBillingAlert,
  listProviderSubscriptions,
  listSeatSyncs,
  operatorManaged,
  seatedMemberCount,
} from '@xecret/db/repositories';
import type { SubscriptionRecord } from '@xecret/db/repositories';
import type { ServiceContext } from '../context';
import { describeError } from '../logging';
import { subscriptionResource, systemAudit } from './audit';
import { billingProvider, DodoApiError } from './client';
import { billingSetup, catalogEntryFor } from './config';
import type { BillingConfig } from './config';
import type { DodoSubscription } from './payloads';

/**
 * The nightly reconciler (P12): every subscription Dodo bills, compared with
 * our row — plan, interval, product, status, seats, period end, cancellation,
 * add-on.
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
 * Rows recorded under the other Dodo mode are not compared: this deployment's
 * key cannot see them, and they would all read as missing. Nor is an
 * operator's grant written over an old subscription's id (a paid row with the
 * id and no product, `operatorManaged`): it is reported once, not nightly.
 */

/** How far apart the two period ends may be before it is drift. */
const PERIOD_END_TOLERANCE_MS = 24 * 60 * 60 * 1000;
/** Subscriptions compared per run; at one Dodo call each. */
const MAX_PER_RUN = 2_000;

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
  seatSyncPending: boolean,
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
  if (!seatSyncPending && (dodo.quantity !== owed || dodo.quantity !== row.seats)) {
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
  // explains nothing, and is reported like any other.
  const pending = new Set(
    (await listSeatSyncs(services.db, 10_000))
      .filter((debt) => debt.deadLetteredAt === null)
      .map((debt) => debt.orgId),
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
      try {
        const dodo = await provider.getSubscription(row.dodoSubscriptionId);
        const seated = await seatedMemberCount(services.db, row.orgId);
        drift = driftBetween(row, dodo, config, pending.has(row.orgId), seated);
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

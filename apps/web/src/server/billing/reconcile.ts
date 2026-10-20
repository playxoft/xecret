import type { BillingDriftField } from '@xecret/core/audit';
import { resolvePlanId } from '@xecret/core/entitlements';
import {
  appendAuditEvents,
  listProviderSubscriptions,
  listSeatSyncs,
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
 * Two differences are expected and not reported: seats with a seat-sync debt
 * still queued (the hourly job is already pushing them), and a period end
 * within a day of Dodo's (renewals land minutes apart from the date they name).
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

  if (!seatSyncPending && dodo.quantity !== row.seats) drift.push('seats');

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

  const pending = new Set((await listSeatSyncs(services.db, 10_000)).map((debt) => debt.orgId));

  let after: string | undefined;
  while (report.checked < MAX_PER_RUN) {
    const page = await listProviderSubscriptions(services.db, { limit: 100, afterOrgId: after });
    if (page.length === 0) break;
    after = page[page.length - 1]!.orgId;

    for (const row of page) {
      if (row.dodoSubscriptionId === null) continue;
      report.checked += 1;

      let drift: BillingDriftField[];
      try {
        const dodo = await provider.getSubscription(row.dodoSubscriptionId);
        drift = driftBetween(row, dodo, config, pending.has(row.orgId));
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

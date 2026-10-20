import { FREE_SEAT_LIMIT, providerSeats } from '@xecret/core/entitlements';
import type { BillingInterval, PlanId, SubscriptionStatus } from '@xecret/core/entitlements';
import type { SubscriptionRecord } from '@xecret/db/repositories';
import type { CatalogEntry } from './config';
import type { DodoSubscription, DodoSubscriptionStatus } from './payloads';

/**
 * What a subscription snapshot from Dodo means for an organisation's row.
 *
 * Pure: no query, no clock but the `now` it is handed, no IO. Every
 * `subscription.*` webhook carries the whole subscription, so the handler does
 * not apply *events* — "renewed", "plan changed" — as deltas to whatever the
 * row says. It applies the **snapshot**, the provider's statement of what the
 * subscription is, and this function is the only place that statement is
 * turned into our access truth (D15). Deltas are how a missed or reordered
 * delivery corrupts state; a snapshot can only ever be applied or skipped.
 *
 * ── The rules, in the order they are asked ──
 *
 *  1. **Ordering.** A snapshot of the subscription the row already follows,
 *     timestamped before the last one applied, is stale and skipped — a
 *     `renewed` delivered before its `active` leaves the row as `renewed`
 *     made it, because `active` is older.
 *  2. **Whose subscription.** A row on a paid plan follows one subscription.
 *     Another *live* subscription for the same organisation is two checkouts
 *     completed: it is not applied, and a human is alerted to refund one. A row
 *     on Free may be taken over by a new live subscription. A paid row with no
 *     subscription at all is an operator's grant (`plan:set`, an Enterprise
 *     contract) and is never overwritten by a webhook.
 *  3. **What was bought.** A product this catalogue does not sell is never
 *     turned into a plan: it is skipped and reported as drift.
 *  4. **Ended or live.** Expired, failed, or cancelled with its paid period
 *     over: the organisation returns to Free — plan, interval and period
 *     cleared, seats back to the Free ceiling, **nothing deleted**. Otherwise
 *     the snapshot is written: plan and interval from the product, status
 *     mapped below, the period, the trial, the seats Dodo bills, and
 *     `cancel_at_period_end` for a cancellation that has not reached its end.
 *
 * ── Status, and why "cancelled" is not a status here until the end ──
 * A customer who cancels keeps the period they paid for (pricing FAQ). Dodo
 * reports `cancelled` either at the request or at the boundary; either way the
 * row stays on the paid plan with `cancel_at_period_end` set until
 * `current_period_end` passes, and then returns to Free — here, if the
 * snapshot already says the period is over, or in the hourly sweep
 * (`jobs.ts`) if no further webhook comes. `paused` is held as `on_hold`.
 * **None of these touches the data plane**: `isDataPlaneActive` is `true` for
 * every status, and a secret fetch never reads this row's status at all.
 *
 * ── The region lock (pricing-plan §4) ──
 * The first activation stamps `region_locked_until` twelve months out. While
 * it holds, the billing country and currency recorded at activation are kept
 * even if Dodo reports others — a region change re-prices at renewal, never
 * mid-term — and the disagreement is raised for a human, never acted on.
 */

export const REGION_LOCK_MONTHS = 12;

/** Dodo statuses under which the customer holds the plan right now. */
const LIVE: ReadonlySet<DodoSubscriptionStatus> = new Set([
  'active',
  'past_due',
  'on_hold',
  'paused',
  'cancelled',
]);

export type IgnoreReason =
  /** Not active yet — nothing has been paid, nothing is granted. */
  | 'pending'
  /** Older than the snapshot already applied for this subscription. */
  | 'stale'
  /** A product this deployment does not sell. Reported as drift. */
  | 'unknown-product'
  /** A second live subscription beside the one the row follows. Reported. */
  | 'duplicate-subscription'
  /** A subscription the row does not follow, ending or never live. Nothing to do. */
  | 'other-subscription'
  /** The organisation's plan was set by an operator, not by checkout. */
  | 'operator-managed'
  /** The subscription has ended and the row is already on Free. */
  | 'already-free';

/** The columns a decision writes. Matches `writeSubscriptionState`'s patch. */
export interface SubscriptionStatePatch {
  plan: PlanId;
  billingInterval: BillingInterval | null;
  status: SubscriptionStatus;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  trialEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
  dodoSubscriptionId: string;
  dodoCustomerId: string;
  dodoProductId: string | null;
  dodoEventAt: Date;
  renewalAmountMinor: number | null;
  currency?: string;
  billingCountry?: string;
  regionLockedUntil?: Date | null;
  addonSaml?: boolean;
}

/** What changed, for the audit record and the emails. */
export interface SnapshotChange {
  previousPlan: string;
  plan: PlanId;
  previousInterval: BillingInterval | null;
  interval: BillingInterval | null;
  previousStatus: SubscriptionStatus;
  status: SubscriptionStatus;
  previousSeats: number;
  seats: number;
  previousCancelAtPeriodEnd: boolean;
  cancelAtPeriodEnd: boolean;
  /** Something a reviewer would want dated changed — plan, interval, status, seats, cancellation. */
  material: boolean;
}

export type SnapshotDecision =
  | { kind: 'ignore'; reason: IgnoreReason }
  | {
      kind: 'apply';
      patch: SubscriptionStatePatch;
      seats: { billed: number; enforced: number };
      change: SnapshotChange;
      /** Free (or another subscription) → this one: a first activation. */
      activated: boolean;
      /** The subscription is over and the organisation returns to Free. */
      ended: boolean;
      /** Dodo reports a country or currency other than the locked one. */
      regionMismatch: boolean;
      /** The SAML add-on was switched on by this snapshot. */
      addonTurnedOn: boolean;
    };

const DAY_MS = 24 * 60 * 60 * 1000;

function addMonths(date: Date, months: number): Date {
  const next = new Date(date.getTime());
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

function parseDate(value: string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function decideSnapshot(input: {
  row: SubscriptionRecord;
  snapshot: DodoSubscription;
  entry: CatalogEntry | null;
  eventAt: Date;
  now: Date;
  samlAddonId: string | null;
}): SnapshotDecision {
  const { row, snapshot, entry, eventAt, now } = input;
  const sameSubscription = row.dodoSubscriptionId === snapshot.subscription_id;
  const periodEnd = parseDate(snapshot.next_billing_date);
  const periodStart = parseDate(snapshot.previous_billing_date);

  if (snapshot.status === 'pending') return { kind: 'ignore', reason: 'pending' };

  // 1. Ordering — within one subscription's history.
  if (sameSubscription && row.dodoEventAt !== null && eventAt < row.dodoEventAt) {
    return { kind: 'ignore', reason: 'stale' };
  }

  const ended =
    snapshot.status === 'expired' ||
    snapshot.status === 'failed' ||
    (snapshot.status === 'cancelled' && (periodEnd === null || periodEnd <= now));
  const live = LIVE.has(snapshot.status) && !ended;

  // 2. Whose subscription.
  if (!sameSubscription) {
    if (row.plan !== 'free') {
      if (row.dodoSubscriptionId === null) {
        // An operator's grant. A checkout is refused for these, so a snapshot
        // here is somebody buying around the operator; it is reported, never
        // allowed to replace a contract.
        return { kind: 'ignore', reason: live ? 'operator-managed' : 'other-subscription' };
      }
      return { kind: 'ignore', reason: live ? 'duplicate-subscription' : 'other-subscription' };
    }
    if (!live) return { kind: 'ignore', reason: 'other-subscription' };
  }

  const previous = {
    plan: row.plan,
    interval: row.billingInterval,
    status: row.status,
    seats: row.seats,
    cancel: row.cancelAtPeriodEnd,
  };

  // 4a. Ended: back to Free, nothing deleted.
  if (ended) {
    if (row.plan === 'free') return { kind: 'ignore', reason: 'already-free' };
    const patch: SubscriptionStatePatch = {
      plan: 'free',
      billingInterval: null,
      status: 'active',
      currentPeriodStart: null,
      currentPeriodEnd: null,
      trialEndsAt: null,
      cancelAtPeriodEnd: false,
      dodoSubscriptionId: snapshot.subscription_id,
      dodoCustomerId: snapshot.customer.customer_id,
      dodoProductId: null,
      dodoEventAt: eventAt,
      renewalAmountMinor: null,
    };
    return {
      kind: 'apply',
      patch,
      seats: { billed: 1, enforced: FREE_SEAT_LIMIT },
      change: changeOf(previous, patch, 1),
      activated: false,
      ended: true,
      regionMismatch: false,
      addonTurnedOn: false,
    };
  }

  // 3. What was bought — asked of a live subscription only, so that one on a
  // product since removed from the catalogue still ends cleanly.
  if (entry === null) return { kind: 'ignore', reason: 'unknown-product' };

  // 4b. Live.
  const activated = !sameSubscription || row.plan === 'free';
  const trialEndsAt =
    snapshot.trial_period_days > 0
      ? (() => {
          const created = parseDate(snapshot.created_at);
          return created ? new Date(created.getTime() + snapshot.trial_period_days * DAY_MS) : null;
        })()
      : null;

  const status: SubscriptionStatus =
    snapshot.status === 'past_due'
      ? 'past_due'
      : snapshot.status === 'on_hold' || snapshot.status === 'paused'
        ? 'on_hold'
        : trialEndsAt !== null && now < trialEndsAt
          ? 'trialing'
          : 'active';

  const patch: SubscriptionStatePatch = {
    plan: entry.plan,
    billingInterval: entry.interval,
    status,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    trialEndsAt,
    cancelAtPeriodEnd: snapshot.cancel_at_next_billing_date || snapshot.status === 'cancelled',
    dodoSubscriptionId: snapshot.subscription_id,
    dodoCustomerId: snapshot.customer.customer_id,
    dodoProductId: snapshot.product_id,
    dodoEventAt: eventAt,
    renewalAmountMinor: snapshot.recurring_pre_tax_amount,
  };

  // The region lock.
  const lockHolds = row.regionLockedUntil !== null && row.regionLockedUntil > now;
  let regionMismatch = false;
  if (lockHolds && row.billingCountry !== null && row.currency !== null) {
    regionMismatch =
      row.billingCountry !== snapshot.billing.country || row.currency !== snapshot.currency;
  } else {
    patch.currency = snapshot.currency;
    patch.billingCountry = snapshot.billing.country;
  }
  if (activated && !lockHolds) {
    patch.regionLockedUntil = addMonths(now, REGION_LOCK_MONTHS);
  }

  // The SAML add-on: switched on by a subscription carrying it, never off.
  let addonTurnedOn = false;
  if (
    input.samlAddonId !== null &&
    !row.addonSaml &&
    (snapshot.addons ?? []).some(
      (addon) => addon.addon_id === input.samlAddonId && addon.quantity > 0,
    )
  ) {
    patch.addonSaml = true;
    addonTurnedOn = true;
  }

  // Seats: what Dodo bills, and the ceiling a per-seat plan never refuses at.
  const billed = Math.max(1, snapshot.quantity);
  const seats = { billed, enforced: providerSeats(entry.plan, billed).enforced };

  return {
    kind: 'apply',
    patch,
    seats,
    change: changeOf(previous, patch, billed),
    activated,
    ended: false,
    regionMismatch,
    addonTurnedOn,
  };
}

function changeOf(
  previous: {
    plan: string;
    interval: BillingInterval | null;
    status: SubscriptionStatus;
    seats: number;
    cancel: boolean;
  },
  patch: SubscriptionStatePatch,
  seats: number,
): SnapshotChange {
  const material =
    previous.plan !== patch.plan ||
    previous.interval !== patch.billingInterval ||
    previous.status !== patch.status ||
    previous.seats !== seats ||
    previous.cancel !== patch.cancelAtPeriodEnd ||
    patch.addonSaml === true;
  return {
    previousPlan: previous.plan,
    plan: patch.plan,
    previousInterval: previous.interval,
    interval: patch.billingInterval,
    previousStatus: previous.status,
    status: patch.status,
    previousSeats: previous.seats,
    seats,
    previousCancelAtPeriodEnd: previous.cancel,
    cancelAtPeriodEnd: patch.cancelAtPeriodEnd,
    material,
  };
}

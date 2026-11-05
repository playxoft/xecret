import { FREE_SEAT_LIMIT, providerSeats } from '@xecret/core/entitlements';
import type { BillingInterval, PlanId, SubscriptionStatus } from '@xecret/core/entitlements';
import type { SubscriptionRecord } from '@xecret/db/repositories';
import type { CatalogEntry, DodoMode } from './config';
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
 *  0. **Which Dodo.** A row whose ids were recorded under the other Dodo mode
 *     (a test subscription on a deployment now taking live payments, or the
 *     reverse) is never written by this one: reported, not applied.
 *  1. **Ordering.** A snapshot of the subscription the row already follows,
 *     timestamped before the last one applied, is stale and skipped — a
 *     `renewed` delivered before its `active` leaves the row as `renewed`
 *     made it, because `active` is older. Two with the *same* timestamp are
 *     ordered by webhook id, so whichever arrives first the same one wins.
 *  2. **Whose subscription.** A row on a paid plan follows one subscription.
 *     Another *live* subscription for the same organisation is two checkouts
 *     completed: it is not applied, and a human is alerted to refund one. A row
 *     on Free may be taken over by a new live subscription **only if it came
 *     from an open checkout of that organisation's** — its metadata carries
 *     the checkout's nonce (`attachable`); anything else is reported and never
 *     attached. A paid row with no subscription at all is an operator's grant
 *     (`plan:set`, an Enterprise contract) and is never overwritten by a
 *     webhook — nor is a paid row that follows the subscription by id with no
 *     product recorded, which no snapshot ever leaves behind: that is a grant
 *     written over the id of a subscription that ended, and whatever Dodo
 *     later says of that subscription is reported, never applied. And a row
 *     that returned to Free from a subscription is given
 *     its plan back by that subscription only when Dodo says it is `active`
 *     again — never by one still on hold, which is how an unpaid subscription
 *     the hourly job ended would otherwise grant itself back.
 *  3. **What was bought.** A product this catalogue does not sell is never
 *     turned into a plan: it is skipped and reported as drift.
 *  4. **Ended or live.** Expired, failed, or cancelled with its paid period
 *     over: the organisation returns to Free — plan, interval and period
 *     cleared, seats back to the Free ceiling, support's limit overrides
 *     dropped with the plan they were granted on, **nothing deleted**.
 *     Otherwise the snapshot is written: plan and interval from the product,
 *     status mapped below, the period, the trial, the seats Dodo bills,
 *     `cancel_at_period_end` for a cancellation that has not reached its end,
 *     when it went on hold, any plan change Dodo has scheduled, and the moment
 *     from which its usage may be billed (`metered_from`: the activation, or
 *     the trial's end). A trial runs to Dodo's next charge until a payment
 *     moves that charge past the booked end — an upgrade during the trial
 *     that was paid starts a paid period — and then ends at that payment
 *     (`readTrial`).
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
 * mid-term — and the disagreement is raised for a human, never acted on. It is
 * raised once, when Dodo's report changes (`dodo_currency`,
 * `dodo_billing_country` keep what Dodo last said), not on every snapshot
 * while it lasts.
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
  | 'already-free'
  /** The row's ids belong to the other Dodo mode. Reported. */
  | 'other-mode'
  /** A live subscription for a Free row that no open checkout of its own produced. Reported. */
  | 'unverified-checkout'
  /** The subscription the row returned to Free from, not `active` again. Nothing to do. */
  | 'not-reactivating';

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
  dodoEventId: string | null;
  dodoMode: DodoMode;
  renewalAmountMinor: number | null;
  meteredFrom: Date | null;
  onHoldSince: Date | null;
  dodoScheduledChangeAt: Date | null;
  dodoCurrency: string;
  dodoBillingCountry: string;
  currency?: string;
  billingCountry?: string;
  regionLockedUntil?: Date | null;
  addonSaml?: boolean;
  limitOverrides?: null;
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

/**
 * How far past a trial's booked end Dodo's `next_billing_date` must be before
 * the trial reads as over: a day, for the two being stamped apart. A paid
 * period moves the next charge a month or a year past the booked end, so a
 * day can only separate an untouched trial from one that was paid for.
 */
export const TRIAL_OVER_MARGIN_MS = DAY_MS;

/**
 * How much later than the subscription's creation a date must be to name a
 * payment: `previous_billing_date`, or a trial end recorded at one. A trial's
 * `previous_billing_date` is its creation until Dodo charges — or *tries* to:
 * a declined upgrade stamps it too (staging, 2026-11-05), which is why a
 * payment-shaped date never ends a trial on its own.
 */
export const PAYMENT_AFTER_CREATION_MS = 60_000;

/**
 * The shortest paid period, less a day: a February. A trial that ended at a
 * date began a paid period there, so Dodo's next charge is at least this far
 * past it.
 */
export const PAID_PERIOD_MIN_MS = 27 * DAY_MS;

/** What a snapshot says of the subscription's trial. */
export interface TrialReading {
  /** When the trial ends, or ended; `null` for a subscription that never had one. */
  endsAt: Date | null;
  /**
   * Dodo's current cycle is still the trial: no payment has moved its next
   * charge past the booked end. Past `endsAt` with no charge yet it is still
   * running — and no longer `trialing` by the clock.
   */
  running: boolean;
  /** The snapshot's own payment, before the booked end, began a paid period: the trial ended at it. */
  endedEarly: boolean;
}

/**
 * Whether a subscription's trial is still running, and when it ends — the one
 * statement of it: `decideSnapshot` writes the row's status, trial end, period
 * start and `metered_from` by it, and the nightly reconciler compares the
 * row's trial end with it.
 *
 * ── The rule ──
 * The booked end is `created_at` plus `trial_period_days`. During an untouched
 * trial Dodo's next charge **is** the booked end; a paid upgrade starts a paid
 * period, which moves the next charge a month or a year past it. So the trial
 * is over only when `next_billing_date` is later than the booked end by more
 * than {@link TRIAL_OVER_MARGIN_MS} — the one date Dodo must get right to bill
 * at all — **and** a payment has been taken: `previous_billing_date` more than
 * {@link PAYMENT_AFTER_CREATION_MS} after the creation. Each alone is not
 * enough. A declined upgrade stamps the payment date but leaves the next
 * charge at the booked end: still running. A next charge moved with no payment
 * — a pause and a resume, a trial extended in Dodo — is the trial running to
 * the new date: the trial emails and the meter follow it there.
 *
 * ── When it ended ──
 * At the snapshot's payment when that came before the end the trial was
 * running to — the booked end, or a later one the row already followed there
 * (an extension) — which is an upgrade during the trial; else at an earlier
 * end this subscription already recorded at a payment (`recorded`, after
 * creation and before the booked end), so the renewals after an upgrade —
 * whose payment dates no longer say when the trial ended — never move the
 * end, or `metered_from`, later; else at the end it was running to (an
 * ordinary conversion).
 *
 * ── When Dodo stops reporting the length ──
 * Dodo may zero `trial_period_days` once a trial ends early. The booked end is
 * then `recorded` — the row's own `trial_ends_at` for this same subscription
 * — so the snapshot that ends a trial never forgets it had one. An end of our
 * own fed back that way is trusted only as far as Dodo bears it out: a paid
 * period that began there would put the next charge at least
 * {@link PAID_PERIOD_MIN_MS} past it, and one sooner than that says the
 * recorded end was never a payment's (the earlier rule's reading of a declined
 * upgrade) — the trial is read as running to Dodo's next charge instead.
 */
export function readTrial(
  snapshot: Pick<
    DodoSubscription,
    'created_at' | 'trial_period_days' | 'next_billing_date' | 'previous_billing_date'
  >,
  /** The trial end the row holds for this same subscription, or `null`. */
  recorded: Date | null,
): TrialReading {
  const created = parseDate(snapshot.created_at);
  const lengthReported = snapshot.trial_period_days > 0 && created !== null;
  const booked = lengthReported
    ? new Date(created.getTime() + snapshot.trial_period_days * DAY_MS)
    : recorded;
  if (booked === null) return { endsAt: null, running: false, endedEarly: false };

  // Still the booked end: the trial runs to it, whatever Dodo stamped as paid.
  const next = parseDate(snapshot.next_billing_date);
  if (next === null || next.getTime() <= booked.getTime() + TRIAL_OVER_MARGIN_MS) {
    return { endsAt: booked, running: true, endedEarly: false };
  }
  const extended: TrialReading = { endsAt: next, running: true, endedEarly: false };

  const afterCreation = (date: Date | null): date is Date =>
    date !== null &&
    created !== null &&
    date.getTime() - created.getTime() > PAYMENT_AFTER_CREATION_MS;
  // Moved with no payment behind it: the trial runs to the new date.
  const paid = parseDate(snapshot.previous_billing_date);
  if (!afterCreation(paid)) return extended;

  // A paid period has begun. The trial was running to its booked end, or to
  // a later one the row followed there (an extension); a payment before that
  // ended it early.
  const runningTo = recorded !== null && recorded > booked ? recorded : booked;
  const endedEarly = paid < runningTo;
  const endsAt = endedEarly
    ? paid
    : afterCreation(recorded) && recorded < booked
      ? recorded
      : runningTo;

  // Our own end, fed back as the booked one, that no paid period can have
  // begun at: never a payment's. The trial runs to Dodo's next charge.
  if (!lengthReported && next.getTime() - endsAt.getTime() < PAID_PERIOD_MIN_MS) return extended;
  return { endsAt, running: false, endedEarly };
}

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

/**
 * Whether the subscription is over (rule 4): expired, failed, or cancelled
 * with its paid period run out — a cancellation keeps the plan until then.
 * The one statement of it: `decideSnapshot` returns an ended subscription's
 * row to Free by it (`already-free` when the row is there already), and the
 * hourly job's stranded-checkout sweep stops waiting on that decision.
 */
export function subscriptionHasEnded(snapshot: DodoSubscription, now: Date): boolean {
  if (snapshot.status === 'expired' || snapshot.status === 'failed') return true;
  if (snapshot.status !== 'cancelled') return false;
  const periodEnd = parseDate(snapshot.next_billing_date);
  return periodEnd === null || periodEnd <= now;
}

export function decideSnapshot(input: {
  row: SubscriptionRecord;
  snapshot: DodoSubscription;
  entry: CatalogEntry | null;
  eventAt: Date;
  now: Date;
  samlAddonId: string | null;
  /** This deployment's Dodo mode — the mode the snapshot came from. */
  mode: DodoMode;
  /** The delivery's webhook id, for ordering two snapshots stamped alike; `null` from a job. */
  webhookId: string | null;
  /**
   * Whether the snapshot's subscription came from an open checkout of this
   * organisation's — the only way a subscription the row does not follow yet
   * may attach to it.
   */
  attachable: boolean;
}): SnapshotDecision {
  const { row, snapshot, entry, eventAt, now } = input;
  const sameSubscription = row.dodoSubscriptionId === snapshot.subscription_id;
  const periodEnd = parseDate(snapshot.next_billing_date);
  const periodStart = parseDate(snapshot.previous_billing_date);

  if (snapshot.status === 'pending') return { kind: 'ignore', reason: 'pending' };

  // 0. Which Dodo.
  if (row.dodoMode !== null && row.dodoMode !== input.mode) {
    return { kind: 'ignore', reason: 'other-mode' };
  }

  // 1. Ordering — within one subscription's history.
  if (sameSubscription && row.dodoEventAt !== null) {
    if (eventAt < row.dodoEventAt) return { kind: 'ignore', reason: 'stale' };
    if (
      eventAt.getTime() === row.dodoEventAt.getTime() &&
      input.webhookId !== null &&
      row.dodoEventId !== null &&
      input.webhookId <= row.dodoEventId
    ) {
      return { kind: 'ignore', reason: 'stale' };
    }
  }

  const ended = subscriptionHasEnded(snapshot, now);
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
    if (!input.attachable) return { kind: 'ignore', reason: 'unverified-checkout' };
    // Still waiting for the subscription an earlier checkout's payment linked:
    // two checkouts paid. The first link stands; this one is reported.
    if (row.dodoSubscriptionId !== null && row.dodoEventAt === null) {
      return { kind: 'ignore', reason: 'duplicate-subscription' };
    }
  } else if (row.plan !== 'free' && row.dodoProductId === null) {
    // The row follows this subscription by id but on a paid plan no snapshot
    // wrote — a snapshot always records the product. An operator set the plan
    // by hand over the id an ended subscription left behind (`plan:set` now
    // takes such a row off it first; this is the second lock). Whatever Dodo
    // says of the old subscription — a late `cancelled`, or that it is
    // `active` again — is reported, never applied over the grant.
    return { kind: 'ignore', reason: 'operator-managed' };
  } else if (
    row.plan === 'free' &&
    row.dodoEventAt !== null &&
    live &&
    snapshot.status !== 'active'
  ) {
    // Back on Free from this very subscription — ended, or ended here after
    // fourteen days on hold — and Dodo still has it on hold, past due or
    // paused: nothing was paid, so nothing comes back.
    return { kind: 'ignore', reason: 'not-reactivating' };
  }

  const previous = {
    plan: row.plan,
    interval: row.billingInterval,
    status: row.status,
    seats: row.seats,
    cancel: row.cancelAtPeriodEnd,
  };

  // What Dodo reported, whatever the region lock keeps.
  const reported = {
    dodoEventAt: eventAt,
    dodoEventId: input.webhookId,
    dodoMode: input.mode,
    dodoCurrency: snapshot.currency,
    dodoBillingCountry: snapshot.billing.country,
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
      renewalAmountMinor: null,
      meteredFrom: null,
      onHoldSince: null,
      dodoScheduledChangeAt: null,
      // Support's raises were granted on the plan that just ended.
      limitOverrides: null,
      ...reported,
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
  // The trial, by the one rule (`readTrial`): over only when a payment has
  // moved Dodo's next charge past its booked end — never because Dodo stamped
  // a payment date alone, which a declined upgrade stamps too, nor because
  // the next charge moved alone, which a trial extended in Dodo does. The
  // row's own trial end counts — as the booked end when Dodo stops reporting
  // the length, and as the history a renewal no longer shows — for the
  // subscription it follows, never for one it is only now attaching.
  const trial = readTrial(snapshot, activated ? null : row.trialEndsAt);
  const trialEndsAt = trial.endsAt;

  const status: SubscriptionStatus =
    snapshot.status === 'past_due'
      ? 'past_due'
      : snapshot.status === 'on_hold' || snapshot.status === 'paused'
        ? 'on_hold'
        : trial.running && trialEndsAt !== null && now < trialEndsAt
          ? 'trialing'
          : 'active';

  // While the trial is Dodo's current cycle, the period is the trial, from
  // the subscription's creation: an attempt to charge — a declined upgrade —
  // moves `previous_billing_date` without starting anything, and the usage
  // month must not restart at it.
  const currentPeriodStart = trial.running
    ? (parseDate(snapshot.created_at) ?? periodStart)
    : periodStart;

  // Usage is billable from the activation — or from the trial's end, if that
  // is later — and never from before it: what was fetched on Free, or on
  // trial, is not billed by the subscription that followed (`listMeterableUsage`).
  const meteredBase =
    activated || row.meteredFrom === null ? (currentPeriodStart ?? now) : row.meteredFrom;
  let meteredFrom =
    trialEndsAt !== null && trialEndsAt.getTime() > meteredBase.getTime()
      ? trialEndsAt
      : meteredBase;
  // A trial that ended early ended at a payment, and a payment proves a paid
  // period began by then: billing never starts later than it. The row's
  // `metered_from` still says the trial's end as it was running to, and is
  // moved back to the payment. Only then — a declined upgrade leaves the
  // trial running, and `metered_from` where it was.
  // A conversion Dodo charges a minute before the booked end lands here too,
  // ending the trial and starting the meter that minute early: accepted.
  if (trial.endedEarly && meteredFrom.getTime() > trialEndsAt!.getTime()) {
    meteredFrom = trialEndsAt!;
  }

  const patch: SubscriptionStatePatch = {
    plan: entry.plan,
    billingInterval: entry.interval,
    status,
    currentPeriodStart,
    currentPeriodEnd: periodEnd,
    trialEndsAt,
    cancelAtPeriodEnd: snapshot.cancel_at_next_billing_date || snapshot.status === 'cancelled',
    dodoSubscriptionId: snapshot.subscription_id,
    dodoCustomerId: snapshot.customer.customer_id,
    dodoProductId: snapshot.product_id,
    renewalAmountMinor: snapshot.recurring_pre_tax_amount,
    meteredFrom,
    // When it went on hold, kept across the snapshots that leave it there.
    onHoldSince:
      status === 'on_hold'
        ? row.status === 'on_hold' && row.onHoldSince !== null
          ? row.onHoldSince
          : now
        : null,
    dodoScheduledChangeAt: parseDate(snapshot.scheduled_change?.effective_at),
    ...reported,
  };

  // The region lock.
  const lockHolds = row.regionLockedUntil !== null && row.regionLockedUntil > now;
  let regionMismatch = false;
  if (lockHolds && row.billingCountry !== null && row.currency !== null) {
    // Raised when Dodo's report *becomes* a disagreement — not again on every
    // snapshot that repeats it.
    const disagrees =
      row.billingCountry !== snapshot.billing.country || row.currency !== snapshot.currency;
    const reportChanged =
      row.dodoBillingCountry !== snapshot.billing.country || row.dodoCurrency !== snapshot.currency;
    regionMismatch = disagrees && reportChanged;
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

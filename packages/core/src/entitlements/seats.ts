/**
 * How many seats a change should bill, and enforce.
 *
 * Its own module rather than a helper inside the operator script, because the
 * rule is commercial rather than operational: it decides what a customer is
 * charged for and what their invitations are refused against. Checkout (P12)
 * has to reach the same answer as an operator at a shell, and two
 * implementations of a pricing rule is how they stop agreeing.
 *
 * Pure, and it returns a decision rather than printing one. The caller owns the
 * wording — an operator at a terminal and a checkout page are told the same
 * facts in very different sentences.
 */

import { resolvePlanId } from './entitlements';
import { MINIMUM_SEATS, PLANS } from './plans';
import type { StoredPlanId } from './types';

/**
 * The access ceiling written for a paid plan whose seats are not capped.
 *
 * Pro and Team publish no seat limit (`limits.seats` is `null`) — they bill per
 * seat and admit as many people as are paid for, and when a subscription the
 * payment provider manages gains a member, the seat count follows it there
 * (P12 seat sync). `organizations.seat_limit` is an integer that invitations
 * are refused against, so "uncapped" has to be a number; this is a number no
 * real organisation reaches and the column's CHECK accepts. Seats are billed,
 * so abuse is self-limiting — the reason `FAIR_USE.seats` is `null` too.
 */
export const UNCAPPED_SEAT_LIMIT = 100_000;

/**
 * The seat ceiling a Free organisation is held to: `organizations.seat_limit`'s
 * column default, and what every Free organisation is refused against today.
 *
 * Not `PLANS.free.limits.seats` (3). That divergence is the one documented on
 * `FREE_LIMITS.seats` and is left to the owner to close, with the thirty days'
 * notice pricing-plan §5 promises before any limit applies. A paid subscription
 * that ends returns the organisation to this — the number every Free
 * organisation already has — rather than to a tighter one no other Free
 * organisation is held to. Nobody already seated is removed by it: the ceiling
 * refuses new invitations, never existing members.
 */
export const FREE_SEAT_LIMIT = 5;

/**
 * Seats for a subscription the payment provider manages: what to bill for the
 * organisation's membership, and what invitations are refused against.
 *
 * `seatedMembers` is every member holding a seat, **whatever their status** —
 * suspension is a security act, never a discount — and nothing else. A pending
 * invitation is not billed: the pricing page says so ("a pending invitation is
 * not counted until it is accepted"), and a charge for somebody who never
 * accepted is exactly the line on an invoice that becomes a chargeback.
 *
 * Billed is floored at the plan's minimum (`MINIMUM_SEATS`) — published on the
 * pricing page as "billed from 3 members up" — and never below one.
 *
 * Enforced is the plan's own seat limit, or {@link UNCAPPED_SEAT_LIMIT} where
 * the plan has none: an organisation on a per-seat plan is never refused an
 * invitation for want of a seat, because the seat is bought the moment the
 * invitation is accepted. It is never below billed.
 */
export function providerSeats(
  plan: StoredPlanId,
  seatedMembers: number,
): { billed: number; enforced: number } {
  const resolved = resolvePlanId(plan);
  if (resolved === 'free') return { billed: 1, enforced: FREE_SEAT_LIMIT };

  const seated = Number.isFinite(seatedMembers) ? Math.max(0, Math.trunc(seatedMembers)) : 0;
  const billed = Math.max(MINIMUM_SEATS[resolved], seated, 1);
  const ceiling = PLANS[resolved].limits.seats ?? UNCAPPED_SEAT_LIMIT;
  return { billed, enforced: Math.max(ceiling, billed) };
}

export interface SeatRequest {
  /**
   * The plan the organisation will be on **after** this change, as stored.
   *
   * `StoredPlanId` rather than `PlanId`, and resolved inside rather than by the
   * caller. A `scale` row reaching `MINIMUM_SEATS['scale']` gives `undefined`,
   * `Math.max(n, undefined)` gives `NaN`, and `NaN` reaches two `integer`
   * columns — which is what happened, because `scripts/` is in no tsconfig and
   * the operator tool was the one call site the type split did not police.
   * Widening the parameter and resolving here means no caller can get it wrong,
   * which is worth more than a rule they have to remember.
   */
  readonly plan: StoredPlanId;
  /** What the operator asked for, or `null` when they said nothing. */
  readonly requested: number | null;
  /** `org_subscriptions.seats` — what the invoice currently says. */
  readonly billed: number;
  /** `organizations.seat_limit` — what invitations are currently refused against. */
  readonly enforced: number;
}

export interface SeatDecision {
  /** What to write to `org_subscriptions.seats` — the number the invoice uses. */
  readonly billed: number;
  /** What to write to `organizations.seat_limit` — the number invitations are refused against. */
  readonly enforced: number;
  /** An explicit request was below the plan's minimum and was raised to it. */
  readonly raisedToMinimum: boolean;
  /** `enforced` is below what invitations were previously refused against. */
  readonly lowersEnforced: boolean;
}

/**
 * ── Why this returns two numbers rather than one ──
 * They are not the same question and on Free they are not the same number.
 * `billed` is what the invoice says; Free bills one seat by definition, which
 * `org_subscriptions_seats_check` and the pricing page both agree on. `enforced`
 * is `organizations.seat_limit`, a column that predates plans, defaults to 5 and
 * is not set from the plan at provisioning — the divergence documented on
 * `FREE_LIMITS.seats` and on the column itself, which stands until payments.
 *
 * Collapsing them to one number is a bug in the shape of a simplification: it
 * writes the Free invoice figure of 1 into `seat_limit` and a three-person
 * organisation can suddenly invite nobody. The whole reason two columns exist is
 * that one is money and the other is access.
 *
 * ── Why a run that was told nothing never lowers `enforced` ──
 * Deriving from the *billed* count alone let an upgrade tighten it: a Free
 * organisation bills 1 and enforces 5, so moving it to Team with no seat count
 * gave `max(1, 3) = 3` — an organisation with four members instantly over its
 * own limit, immediately after the upgrade that was meant to give it more.
 *
 * So `requested: null` takes the largest of what is billed, what is enforced,
 * and the plan's minimum. Reducing access is a deliberate act and requires
 * saying a number.
 *
 * ── Why the minimum applies to an explicit request too ──
 * `MINIMUM_SEATS` is what stops a solo developer buying one Scale seat. It is a
 * floor on what may be *billed*, so it binds whether the number was typed or
 * derived. It is a floor and never a ceiling: asking for more than the minimum
 * always gets what was asked for.
 */
export function resolveBilledSeats(request: SeatRequest): SeatDecision {
  const { requested, billed, enforced } = request;
  const plan = resolvePlanId(request.plan);

  // Free bills one seat, and its enforced ceiling only ever moves upward. A
  // downgrade to Free does not confiscate access from members already seated;
  // an explicit request may still raise the ceiling, which is the only thing
  // `--seats` could sensibly mean on a plan that bills a fixed one. What it
  // cannot do is cut — a plan change is not the place to evict a team.
  if (plan === 'free') {
    return {
      billed: 1,
      enforced: requested === null ? enforced : Math.max(requested, enforced),
      raisedToMinimum: false,
      lowersEnforced: false,
    };
  }

  const minimum = MINIMUM_SEATS[plan];

  if (requested === null) {
    // Two numbers, from two sources, and conflating them put people on the wrong
    // invoice. `enforced` is `organizations.seat_limit`, which defaults to 5 and
    // is never set from a plan — so folding it into `billed` charged a
    // one-person Free organisation for five Pro seats the moment somebody
    // upgraded it, with nothing warning because `raisedToMinimum` was false.
    //
    // An access ceiling must never set a price. It may only stop itself being
    // lowered, which is what the second line does.
    const billedSeats = Math.max(billed, minimum);
    return {
      billed: billedSeats,
      enforced: Math.max(billedSeats, enforced, minimum),
      raisedToMinimum: false,
      lowersEnforced: false,
    };
  }

  const seats = Math.max(requested, minimum);
  return {
    billed: seats,
    enforced: seats,
    raisedToMinimum: seats > requested,
    lowersEnforced: seats < enforced,
  };
}

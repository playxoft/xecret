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

import { MINIMUM_SEATS } from './plans';
import type { PlanId } from './types';

export interface SeatRequest {
  /** The plan the organisation will be on **after** this change. */
  readonly plan: PlanId;
  /** What the operator asked for, or `null` when they said nothing. */
  readonly requested: number | null;
  /** `org_subscriptions.seats` — what the invoice currently says. */
  readonly billed: number;
  /** `organizations.seat_limit` — what invitations are currently refused against. */
  readonly enforced: number;
}

export interface SeatDecision {
  /** The number to write to **both** seat columns. */
  readonly seats: number;
  /** An explicit request was below the plan's minimum and was raised to it. */
  readonly raisedToMinimum: boolean;
  /** The result is below what invitations are currently refused against. */
  readonly lowersEnforced: boolean;
}

/**
 * ── Why a run that was told nothing never lowers a number ──
 * The result is written to `organizations.seat_limit` as well as to
 * `org_subscriptions.seats`, and `seat_limit` is the one that refuses an
 * invitation. Deriving from the *billed* count alone let an upgrade tighten it:
 * a Free organisation bills 1 seat and enforces 5 (the column default), so
 * moving it to Team with no seat count gave `max(1, 3) = 3` — an organisation
 * with four members instantly over its own limit and unable to invite anybody,
 * immediately after the upgrade that was meant to give it more.
 *
 * So `requested: null` takes the largest of what is billed, what is enforced,
 * and the plan's minimum. Reducing seats is a deliberate act and requires
 * saying a number.
 *
 * ── Why the minimum applies to an explicit request too ──
 * `MINIMUM_SEATS` is what stops a solo developer buying one Scale seat. It is a
 * floor on what may be *billed*, so it binds whether the number was typed or
 * derived. It is a floor and never a ceiling: asking for more than the minimum
 * always gets what was asked for.
 *
 * ── Free ──
 * Bills one seat by definition — `org_subscriptions_seats_check` and the pricing
 * page agree — so no floor above it applies and none of the above runs.
 */
export function resolveBilledSeats(request: SeatRequest): SeatDecision {
  const { plan, requested, billed, enforced } = request;

  if (plan === 'free') {
    return { seats: 1, raisedToMinimum: false, lowersEnforced: enforced > 1 };
  }

  const minimum = MINIMUM_SEATS[plan];

  if (requested === null) {
    return {
      seats: Math.max(billed, enforced, minimum),
      raisedToMinimum: false,
      lowersEnforced: false,
    };
  }

  const seats = Math.max(requested, minimum);
  return {
    seats,
    raisedToMinimum: seats > requested,
    lowersEnforced: seats < enforced,
  };
}

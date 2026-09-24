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
  const { plan, requested, billed, enforced } = request;

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
    const seats = Math.max(billed, enforced, minimum);
    return { billed: seats, enforced: seats, raisedToMinimum: false, lowersEnforced: false };
  }

  const seats = Math.max(requested, minimum);
  return {
    billed: seats,
    enforced: seats,
    raisedToMinimum: seats > requested,
    lowersEnforced: seats < enforced,
  };
}

import { describe, expect, it } from 'vitest';
import { MINIMUM_SEATS } from './plans';
import { resolveBilledSeats } from './seats';

/**
 * The seat rule: what a change bills, and what it enforces.
 *
 * Two columns are written from this one number — `org_subscriptions.seats`,
 * which the invoice is computed from, and `organizations.seat_limit`, which
 * `assertSeatAvailable` refuses an invitation against. That is why "never lower
 * a number nobody asked to lower" is a property worth testing rather than a
 * nicety: the failure is felt by a teammate who cannot be invited, days after
 * the operator who caused it has closed the terminal.
 */

describe('resolveBilledSeats', () => {
  /**
   * The regression this rule exists for.
   *
   * A Free organisation bills 1 seat and enforces 5 — `seat_limit`'s column
   * default, which nothing sets from the plan. Deriving the new count from the
   * billed one alone gave `max(1, 3) = 3` on an upgrade to Team, so an
   * organisation with four members came out of the upgrade over its own limit
   * and unable to invite anybody. The upgrade was run to give it *more*.
   */
  it('never tightens the enforced ceiling on an upgrade nobody gave a number for', () => {
    const decision = resolveBilledSeats({
      plan: 'team',
      requested: null,
      billed: 1,
      enforced: 5,
    });

    expect(decision.seats).toBe(5);
    expect(decision.lowersEnforced).toBe(false);
  });

  it('takes the plan minimum when it is the largest of the three', () => {
    const decision = resolveBilledSeats({
      plan: 'scale',
      requested: null,
      billed: 1,
      enforced: 5,
    });

    expect(decision.seats).toBe(MINIMUM_SEATS.scale);
  });

  it('keeps a billed count above both the minimum and the enforced ceiling', () => {
    const decision = resolveBilledSeats({
      plan: 'team',
      requested: null,
      billed: 40,
      enforced: 5,
    });

    expect(decision.seats).toBe(40);
  });

  /**
   * `MINIMUM_SEATS` is what stops a solo developer buying one Scale seat. It
   * used to be applied only on the `--plan` path, so setting seats alone on an
   * existing Scale organisation under-billed it silently.
   */
  it('raises an explicit request to the plan minimum, and says it did', () => {
    const decision = resolveBilledSeats({
      plan: 'scale',
      requested: 1,
      billed: 10,
      enforced: 10,
    });

    expect(decision.seats).toBe(MINIMUM_SEATS.scale);
    expect(decision.raisedToMinimum).toBe(true);
  });

  it('is a floor and never a ceiling', () => {
    const decision = resolveBilledSeats({
      plan: 'team',
      requested: 25,
      billed: 3,
      enforced: 3,
    });

    expect(decision.seats).toBe(25);
    expect(decision.raisedToMinimum).toBe(false);
  });

  /**
   * Reducing seats is legitimate — a team shrank — but it is a decision, and the
   * caller is told so it can be said out loud rather than discovered later by
   * whoever tries to invite the next person.
   */
  it('honours an explicit reduction and flags that it lowers enforcement', () => {
    const decision = resolveBilledSeats({
      plan: 'team',
      requested: 3,
      billed: 25,
      enforced: 25,
    });

    expect(decision.seats).toBe(3);
    expect(decision.lowersEnforced).toBe(true);
  });

  it('bills Free at one seat whatever was asked for', () => {
    expect(resolveBilledSeats({ plan: 'free', requested: 9, billed: 9, enforced: 9 }).seats).toBe(
      1,
    );
    expect(
      resolveBilledSeats({ plan: 'free', requested: null, billed: 1, enforced: 5 }).seats,
    ).toBe(1);
  });

  /**
   * A downgrade to Free does reduce what is enforced, from the column default of
   * five to one. That is the plan's published limit and not a mistake — but it
   * is still reported, because it is the same surprise from the other direction.
   */
  it('reports a downgrade to Free as lowering enforcement', () => {
    expect(
      resolveBilledSeats({ plan: 'free', requested: null, billed: 1, enforced: 5 }).lowersEnforced,
    ).toBe(true);
  });
});

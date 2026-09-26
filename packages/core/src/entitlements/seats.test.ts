import { describe, expect, it } from 'vitest';
import { MINIMUM_SEATS } from './plans';
import { resolveBilledSeats } from './seats';

/**
 * The seat rule: what a change bills, and what it enforces.
 *
 * Two columns, and **two numbers** — `org_subscriptions.seats`, which the
 * invoice is computed from, and `organizations.seat_limit`, which
 * `assertSeatAvailable` refuses an invitation against. They agree on every paid
 * plan and disagree on Free, which bills one seat while enforcing the column's
 * default of five.
 *
 * That is why "never lower a number nobody asked to lower" is a property worth
 * testing rather than a nicety: the failure is felt by a teammate who cannot be
 * invited, days after the operator who caused it has closed the terminal.
 */

describe('resolveBilledSeats', () => {
  /**
   * Two regressions in one case, pulling opposite ways.
   *
   * A Free organisation bills 1 seat and enforces 5 — `seat_limit`'s column
   * default, which nothing sets from the plan. Deriving the new count from the
   * *billed* one alone gave `max(1, 3) = 3` on an upgrade to Team, so an
   * organisation with four members came out of the upgrade over its own limit
   * and unable to invite anybody; the upgrade was run to give it more.
   *
   * Folding `enforced` into `billed` fixed that and broke the invoice instead: a
   * one-person organisation upgrading to Pro was charged for five seats, because
   * a column default nobody had chosen became a price. An access ceiling may
   * stop itself being lowered. It may never set what somebody pays.
   */
  it('keeps the enforced ceiling without letting it set the invoice', () => {
    const decision = resolveBilledSeats({
      plan: 'team',
      requested: null,
      billed: 1,
      enforced: 5,
    });

    // The plan minimum, not the 5 that `seat_limit` happened to be sitting at.
    expect(decision.billed).toBe(MINIMUM_SEATS.team);
    expect(decision.enforced).toBe(5);
    expect(decision.lowersEnforced).toBe(false);
  });

  it('never charges a one-person organisation for a column default', () => {
    const decision = resolveBilledSeats({
      plan: 'pro',
      requested: null,
      billed: 1,
      enforced: 5,
    });

    expect(decision.billed).toBe(1);
    expect(decision.enforced).toBe(5);
  });

  it('takes the plan minimum when it is the largest of the three', () => {
    const decision = resolveBilledSeats({
      plan: 'enterprise',
      requested: null,
      billed: 1,
      enforced: 5,
    });

    expect(decision.billed).toBe(MINIMUM_SEATS.enterprise);
  });

  it('keeps a billed count above both the minimum and the enforced ceiling', () => {
    const decision = resolveBilledSeats({
      plan: 'team',
      requested: null,
      billed: 40,
      enforced: 5,
    });

    expect(decision.billed).toBe(40);
  });

  /**
   * `MINIMUM_SEATS` is what stops a solo developer buying one Enterprise seat.
   * It used to be applied only on the `--plan` path, so setting seats alone on
   * an organisation already on that tier under-billed it silently.
   */
  it('raises an explicit request to the plan minimum, and says it did', () => {
    const decision = resolveBilledSeats({
      plan: 'enterprise',
      requested: 1,
      billed: 10,
      enforced: 10,
    });

    expect(decision.billed).toBe(MINIMUM_SEATS.enterprise);
    expect(decision.raisedToMinimum).toBe(true);
  });

  it('is a floor and never a ceiling', () => {
    const decision = resolveBilledSeats({
      plan: 'team',
      requested: 25,
      billed: 3,
      enforced: 3,
    });

    expect(decision.billed).toBe(25);
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

    expect(decision.billed).toBe(3);
    expect(decision.lowersEnforced).toBe(true);
  });

  it('bills Free at one seat whatever was asked for', () => {
    expect(resolveBilledSeats({ plan: 'free', requested: 9, billed: 9, enforced: 9 }).billed).toBe(
      1,
    );
    expect(
      resolveBilledSeats({ plan: 'free', requested: null, billed: 1, enforced: 5 }).billed,
    ).toBe(1);
  });

  /**
   * The regression that made splitting the return value necessary.
   *
   * One number meant Free's *invoice* figure of 1 was written into
   * `organizations.seat_limit`, so `plan:set --org acme --seats 10` on a Free
   * organisation — or any `--plan free` downgrade — dropped the enforced ceiling
   * from 5 to 1 and a three-person team could suddenly invite nobody. It also
   * contradicted the divergence documented on `FREE_LIMITS.seats` and on the
   * column, which says the looser number is the one that applies until payments.
   */
  it('never writes Free’s invoice figure into the enforced ceiling', () => {
    const decision = resolveBilledSeats({ plan: 'free', requested: null, billed: 1, enforced: 5 });

    expect(decision.billed).toBe(1);
    expect(decision.enforced).toBe(5);
    expect(decision.lowersEnforced).toBe(false);
  });

  it('leaves a downgrade to Free with the access its members already had', () => {
    const decision = resolveBilledSeats({
      plan: 'free',
      requested: null,
      billed: 20,
      enforced: 20,
    });

    expect(decision.billed).toBe(1);
    expect(decision.enforced).toBe(20);
  });

  /**
   * `--seats` on a Free organisation cannot buy billed seats, but it can still
   * raise the ceiling invitations are refused against — which is the only thing
   * the flag could sensibly mean there, and is a raise rather than a cut.
   */
  it('lets an explicit request raise Free’s enforced ceiling but never lower it', () => {
    expect(
      resolveBilledSeats({ plan: 'free', requested: 10, billed: 1, enforced: 5 }).enforced,
    ).toBe(10);
    expect(
      resolveBilledSeats({ plan: 'free', requested: 2, billed: 1, enforced: 5 }).enforced,
    ).toBe(5);
  });

  /** On every paid plan the two numbers are the same, and stay that way. */
  it('keeps billed and enforced equal on a paid plan', () => {
    for (const requested of [null, 4, 40]) {
      const decision = resolveBilledSeats({ plan: 'team', requested, billed: 5, enforced: 5 });
      expect(decision.billed).toBe(decision.enforced);
    }
  });
});

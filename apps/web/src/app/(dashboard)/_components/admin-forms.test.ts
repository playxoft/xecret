import { describe, expect, it } from 'vitest';

import {
  dateInputAfter,
  dateInputToIso,
  endInstant,
  grantRequest,
  optionalWhole,
  parseEmailList,
  promoCodeRequest,
  toDateInput,
} from './admin-forms';
import type { GrantForm, PromoCodeForm } from './admin-forms';

/**
 * The admin page's two forms, from what was typed to what is sent.
 *
 * What is pinned is what reaches the server: the instant a picked date means,
 * an allow-list as a list, a code left empty as no code at all — and the one
 * flag that leaves work behind at Dodo, never sent unless it was asked for and
 * ticked.
 */

/** Midday on 11 November 2026, in whatever zone the suite runs in. */
const NOW = new Date(2026, 10, 11, 12, 0, 0).getTime();

describe('a date picked in the form', () => {
  it('means the start of that day, in the browser’s own zone', () => {
    const at = new Date(dateInputToIso('2027-03-01') ?? 'invalid');

    expect(at.getFullYear()).toBe(2027);
    expect(at.getMonth()).toBe(2);
    expect(at.getDate()).toBe(1);
    expect(at.getHours()).toBe(0);
    expect(at.getMinutes()).toBe(0);
  });

  it('is refused when it is not a real day, rather than rolled into the next month', () => {
    expect(dateInputToIso('2027-02-31')).toBeNull();
    expect(dateInputToIso('2027-13-01')).toBeNull();
    expect(dateInputToIso('')).toBeNull();
    expect(dateInputToIso('1 March')).toBeNull();
  });

  it('round-trips through the picker’s own format', () => {
    expect(toDateInput(new Date(2027, 0, 5))).toBe('2027-01-05');
    expect(dateInputAfter(new Date(NOW), 30)).toBe('2026-12-11');
    // Across a year end, by calendar days.
    expect(dateInputAfter(new Date(2026, 11, 31, 23, 0), 1)).toBe('2027-01-01');
  });

  it('must be after today, and no more than ten years off', () => {
    expect(endInstant({ kind: 'never', date: '' }, NOW)).toEqual({ ok: true, iso: null });
    expect(endInstant({ kind: 'on', date: '2026-11-11' }, NOW)).toEqual({
      ok: false,
      problem: 'Choose a date after today.',
    });
    expect(endInstant({ kind: 'on', date: '2040-01-01' }, NOW)).toEqual({
      ok: false,
      problem: 'At most ten years from now.',
    });
    expect(endInstant({ kind: 'on', date: '' }, NOW)).toEqual({
      ok: false,
      problem: 'Choose a date.',
    });
    const ok = endInstant({ kind: 'on', date: '2026-11-12' }, NOW);
    expect(ok.ok && ok.iso).toBe(dateInputToIso('2026-11-12'));
  });
});

describe('an optional whole number', () => {
  it('is null when empty, the number when it is one, and undefined otherwise', () => {
    expect(optionalWhole('', 1, 10)).toBeNull();
    expect(optionalWhole('  ', 1, 10)).toBeNull();
    expect(optionalWhole('7', 1, 10)).toBe(7);
    expect(optionalWhole('1,000', 1, 100_000)).toBe(1000);
    expect(optionalWhole('0', 1, 10)).toBeUndefined();
    expect(optionalWhole('11', 1, 10)).toBeUndefined();
    expect(optionalWhole('2.5', 1, 10)).toBeUndefined();
    expect(optionalWhole('ten', 1, 10)).toBeUndefined();
  });
});

describe('the allowed-emails box', () => {
  it('takes one per line or comma-separated, lower-cased and de-duplicated', () => {
    expect(
      parseEmailList('Ada@Example.com\nbob@example.com, ADA@example.com;  cy@example.org '),
    ).toEqual(['ada@example.com', 'bob@example.com', 'cy@example.org']);
  });

  it('is null when empty — "anybody with the code" — never an empty list', () => {
    expect(parseEmailList('')).toBeNull();
    expect(parseEmailList(' \n , ')).toBeNull();
  });
});

const GRANT: GrantForm = {
  plan: 'team',
  ends: { kind: 'on', date: '2027-02-11' },
  seats: '',
  reason: '  Launch partner  ',
  overDodo: false,
};

describe('a free plan for one organisation', () => {
  it('sends the plan, the instant, the seat ceiling and the trimmed reason', () => {
    const request = grantRequest({ ...GRANT, seats: '12' }, { needsOverDodo: false, now: NOW });

    expect(request).toEqual({
      ok: true,
      body: {
        plan: 'team',
        seats: 12,
        endsAt: dateInputToIso('2027-02-11'),
        reason: 'Launch partner',
        overDodo: false,
      },
    });
  });

  it('sends no end and no ceiling when none was chosen', () => {
    const request = grantRequest(
      { ...GRANT, ends: { kind: 'never', date: '2027-02-11' } },
      { needsOverDodo: false, now: NOW },
    );

    expect(request.ok && request.body.endsAt).toBeNull();
    expect(request.ok && request.body.seats).toBeNull();
  });

  it('asks for a reason, because it goes in the customer’s audit log', () => {
    const request = grantRequest({ ...GRANT, reason: '   ' }, { needsOverDodo: false, now: NOW });

    expect(request).toEqual({
      ok: false,
      problems: { reason: 'Say why — it goes in the organisation’s audit log.' },
    });
  });

  it('refuses a seat ceiling that is not a whole number', () => {
    const request = grantRequest({ ...GRANT, seats: 'lots' }, { needsOverDodo: false, now: NOW });
    expect(request.ok).toBe(false);
    expect(!request.ok && request.problems.seats).toBeTruthy();
  });

  it('will not take an organisation off Dodo unless it was asked and ticked', () => {
    // Dodo bills it and the box is not ticked: nothing is sent.
    const unticked = grantRequest(GRANT, { needsOverDodo: true, now: NOW });
    expect(unticked.ok).toBe(false);
    expect(!unticked.ok && unticked.problems.overDodo).toBeTruthy();

    // Ticked: sent.
    const ticked = grantRequest({ ...GRANT, overDodo: true }, { needsOverDodo: true, now: NOW });
    expect(ticked.ok && ticked.body.overDodo).toBe(true);

    // A tick left over from somewhere it was asked never travels to an
    // organisation it was not asked about.
    const stale = grantRequest({ ...GRANT, overDodo: true }, { needsOverDodo: false, now: NOW });
    expect(stale.ok && stale.body.overDodo).toBe(false);
  });
});

const CODE: PromoCodeForm = {
  kind: 'grant',
  code: '',
  description: '',
  allowedEmails: '',
  maxRedemptions: '',
  expires: { kind: 'never', date: '' },
  plan: 'team',
  lasts: 'days',
  days: '30',
  seats: '',
  discountType: 'percentage',
  value: '',
  currency: 'USD',
  cycles: 'count',
  cycleCount: '3',
  plans: ['pro', 'team'],
};

describe('a free-plan code', () => {
  it('leaves the code out for a random one, and sends only the grant', () => {
    expect(promoCodeRequest(CODE, { now: NOW })).toEqual({
      ok: true,
      body: {
        kind: 'grant',
        description: null,
        allowedEmails: null,
        maxRedemptions: null,
        expiresAt: null,
        grant: { plan: 'team', days: 30, seats: null },
      },
    });
  });

  it('sends a chosen code upper-cased, its limits, and "for good" as no days', () => {
    const request = promoCodeRequest(
      {
        ...CODE,
        code: 'launch 30',
        lasts: 'forever',
        allowedEmails: 'ada@example.com',
        maxRedemptions: '50',
        description: ' Product Hunt ',
      },
      { now: NOW },
    );

    expect(request.ok && request.body).toMatchObject({
      code: 'LAUNCH30',
      allowedEmails: ['ada@example.com'],
      maxRedemptions: 50,
      description: 'Product Hunt',
      grant: { plan: 'team', days: null, seats: null },
    });
    expect(request.ok && 'discount' in request.body).toBe(false);
  });

  it('refuses a code Dodo would not accept, and an address that is not one', () => {
    const request = promoCodeRequest(
      { ...CODE, code: 'AB', allowedEmails: 'ada@example.com, not-an-address' },
      { now: NOW },
    );

    expect(request.ok).toBe(false);
    expect(!request.ok && request.problems.code).toBe('A code is 3 to 16 letters and digits.');
    expect(!request.ok && request.problems.allowedEmails).toContain('not-an-address');
  });
});

describe('a checkout discount', () => {
  it('sends a percentage with no currency, on the plans ticked, in the pricing page’s order', () => {
    const request = promoCodeRequest(
      { ...CODE, kind: 'discount', value: '12.5', plans: ['team', 'pro'] },
      { now: NOW },
    );

    expect(request.ok && request.body).toEqual({
      kind: 'discount',
      description: null,
      allowedEmails: null,
      maxRedemptions: null,
      expiresAt: null,
      discount: {
        type: 'percentage',
        value: 12.5,
        currency: null,
        cycles: 3,
        plans: ['pro', 'team'],
      },
    });
  });

  it('sends a fixed amount with its currency, for every renewal', () => {
    const request = promoCodeRequest(
      {
        ...CODE,
        kind: 'discount',
        discountType: 'flat',
        value: '5',
        currency: 'eur',
        cycles: 'forever',
        plans: ['pro'],
      },
      { now: NOW },
    );

    expect(request.ok && request.body.discount).toEqual({
      type: 'flat',
      value: 5,
      currency: 'EUR',
      cycles: null,
      plans: ['pro'],
    });
  });

  it('refuses more than 100% off, a missing currency, and no plan at all', () => {
    const over = promoCodeRequest({ ...CODE, kind: 'discount', value: '120' }, { now: NOW });
    expect(!over.ok && over.problems.value).toBe('A percentage from 0.01 to 100.');

    const flat = promoCodeRequest(
      { ...CODE, kind: 'discount', discountType: 'flat', value: '5', currency: '' },
      { now: NOW },
    );
    expect(!flat.ok && flat.problems.currency).toBeTruthy();

    const none = promoCodeRequest(
      { ...CODE, kind: 'discount', value: '50', plans: [] },
      { now: NOW },
    );
    expect(!none.ok && none.problems.plans).toBe('Choose at least one plan.');
  });

  it('takes 100% off — a free plan with a card on file', () => {
    const request = promoCodeRequest({ ...CODE, kind: 'discount', value: '100' }, { now: NOW });
    expect(request.ok && request.body.discount?.value).toBe(100);
  });
});

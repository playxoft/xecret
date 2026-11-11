import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PromoCodeRecord } from '@xecret/db/repositories';
import { discountValueText, promoCodeState, summarizePromoCode } from './promo-codes';

/**
 * What a promo code says it gives, and whether it can still be used — the
 * two sentences an owner and an admin read about every code. Pure; the routes
 * that spend codes are tested end to end in `admin-routes.test.ts`.
 */

const NOW = new Date('2026-11-11T12:00:00Z');

function grantCode(overrides: Partial<PromoCodeRecord> = {}): PromoCodeRecord {
  return {
    id: randomUUID(),
    code: 'FRIENDS',
    kind: 'grant',
    description: null,
    grantPlan: 'team',
    grantDays: 30,
    grantSeats: null,
    discountType: null,
    discountAmount: null,
    discountCurrency: null,
    discountCycles: null,
    discountPlans: null,
    dodoDiscountId: null,
    dodoMode: null,
    allowedEmails: null,
    maxRedemptions: null,
    redemptions: 0,
    expiresAt: null,
    createdBy: null,
    createdAt: new Date('2026-11-01T00:00:00Z'),
    revokedAt: null,
    revokedBy: null,
    ...overrides,
  };
}

function discountCode(overrides: Partial<PromoCodeRecord> = {}): PromoCodeRecord {
  return grantCode({
    code: 'HALFOFF',
    kind: 'discount',
    grantPlan: null,
    grantDays: null,
    discountType: 'percentage',
    discountAmount: 5_000,
    discountCycles: 3,
    discountPlans: ['pro', 'team'],
    dodoDiscountId: 'dsc_example0001',
    dodoMode: 'test_mode',
    ...overrides,
  });
}

describe('summarizePromoCode', () => {
  it('says what a free-plan code gives, for how long', () => {
    expect(summarizePromoCode(grantCode())).toBe('Team free for 30 days');
    expect(summarizePromoCode(grantCode({ grantPlan: 'pro', grantDays: 1 }))).toBe(
      'Pro free for 1 day',
    );
    expect(summarizePromoCode(grantCode({ grantPlan: 'enterprise', grantDays: 14 }))).toBe(
      'Enterprise free for 14 days',
    );
  });

  it('says a free-plan code with no days has no end', () => {
    expect(summarizePromoCode(grantCode({ grantPlan: 'pro', grantDays: null }))).toBe(
      'Pro free, with no end date',
    );
  });

  it('counts in the unit a person would say — years, then months from two of them, else days', () => {
    const lasting = (grantDays: number) => summarizePromoCode(grantCode({ grantDays }));
    expect(lasting(365)).toBe('Team free for 1 year');
    expect(lasting(730)).toBe('Team free for 2 years');
    expect(lasting(60)).toBe('Team free for 2 months');
    expect(lasting(90)).toBe('Team free for 3 months');
    // A single month stays in days: "1 month" would be a promise about February.
    expect(lasting(30)).toBe('Team free for 30 days');
    expect(lasting(45)).toBe('Team free for 45 days');
    expect(lasting(400)).toBe('Team free for 400 days');
  });

  it('says what a percentage discount takes off, from which plans, for how many periods', () => {
    expect(summarizePromoCode(discountCode())).toBe(
      '50% off Pro and Team for the first 3 billing periods',
    );
    expect(summarizePromoCode(discountCode({ discountCycles: 1, discountPlans: ['team'] }))).toBe(
      '50% off Team for the first billing period',
    );
    expect(summarizePromoCode(discountCode({ discountAmount: 10_000, discountCycles: null }))).toBe(
      '100% off Pro and Team for every billing period',
    );
  });

  it('keeps the fraction of a percentage that has one', () => {
    expect(discountValueText(discountCode({ discountAmount: 1_250 }))).toBe('12.50%');
    expect(discountValueText(discountCode({ discountAmount: 1 }))).toBe('0.01%');
  });

  it('writes a fixed amount in its own currency, from minor units', () => {
    const flat = discountCode({
      discountType: 'flat',
      discountAmount: 500,
      discountCurrency: 'USD',
      discountPlans: ['pro'],
      discountCycles: 1,
    });
    expect(summarizePromoCode(flat)).toBe('$5.00 off Pro for the first billing period');
    // A currency with no minor unit: 500 is ¥500, not ¥5.
    expect(discountValueText({ ...flat, discountCurrency: 'JPY' })).toBe('¥500');
  });
});

describe('promoCodeState', () => {
  it('is active for a live code', () => {
    expect(promoCodeState(grantCode(), NOW)).toBe('active');
    expect(promoCodeState(grantCode({ expiresAt: new Date(NOW.getTime() + 60_000) }), NOW)).toBe(
      'active',
    );
  });

  it('is revoked once revoked, whatever else is true of it', () => {
    expect(
      promoCodeState(
        grantCode({
          revokedAt: new Date(NOW.getTime() - 60_000),
          expiresAt: new Date(NOW.getTime() - 120_000),
          maxRedemptions: 1,
          redemptions: 1,
        }),
        NOW,
      ),
    ).toBe('revoked');
  });

  it('is expired from the moment it expires', () => {
    expect(promoCodeState(grantCode({ expiresAt: NOW }), NOW)).toBe('expired');
    expect(promoCodeState(grantCode({ expiresAt: new Date(NOW.getTime() - 1) }), NOW)).toBe(
      'expired',
    );
  });

  it('is used up when a free-plan code has been redeemed as often as it allows', () => {
    expect(promoCodeState(grantCode({ maxRedemptions: 2, redemptions: 1 }), NOW)).toBe('active');
    expect(promoCodeState(grantCode({ maxRedemptions: 2, redemptions: 2 }), NOW)).toBe('used-up');
  });

  it('never calls a discount code used up — Dodo counts its uses, not this table', () => {
    expect(promoCodeState(discountCode({ maxRedemptions: 1, redemptions: 1 }), NOW)).toBe('active');
  });
});

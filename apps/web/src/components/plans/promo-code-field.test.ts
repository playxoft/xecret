import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PromoCodePreviewPayload } from '@/server/schemas/admin';

import { checkoutPromoCode, normalisePromoCode, PromoCodeField } from './promo-code-field';

/**
 * "Have a code?", as an owner meets it on the billing screen and the plans
 * page — and the one rule both screens use to decide which checkout carries an
 * applied discount.
 */

const TEAM_HALF_OFF: PromoCodePreviewPayload = {
  code: 'TEAMHALF',
  kind: 'discount',
  summary: '50% off Team for 3 months',
  plan: null,
  plans: ['team'],
};

const TEAM_FREE: PromoCodePreviewPayload = {
  code: 'TEAM30',
  kind: 'grant',
  summary: 'Team free for 30 days',
  plan: 'team',
  plans: null,
};

describe('which checkout carries a code', () => {
  it('is a checkout for a plan the discount names, and no other', () => {
    expect(checkoutPromoCode(TEAM_HALF_OFF, 'team')).toBe('TEAMHALF');
    expect(checkoutPromoCode(TEAM_HALF_OFF, 'pro')).toBeNull();
  });

  it('is none for a free-plan code, which is redeemed, never checked out with', () => {
    expect(checkoutPromoCode(TEAM_FREE, 'team')).toBeNull();
    expect(checkoutPromoCode(null, 'team')).toBeNull();
  });
});

describe('a code as typed', () => {
  it('is read as the server reads it', () => {
    expect(normalisePromoCode(' team half ')).toBe('TEAMHALF');
    expect(normalisePromoCode('launch50')).toBe('LAUNCH50');
  });
});

function render(applied: PromoCodePreviewPayload | null): string {
  return renderToStaticMarkup(
    createElement(PromoCodeField, {
      orgSlug: 'acme',
      applied,
      onApplied: () => {},
      onRedeemed: () => {},
      discounts: true,
    }),
  );
}

describe('PromoCodeField', () => {
  it('starts as a link, not a field most people never use', () => {
    const html = render(null);

    expect(html).toContain('Have a code?');
    expect(html).not.toContain('<input');
  });

  it('shows an applied discount, what it takes off, and a way to remove it', () => {
    const html = render(TEAM_HALF_OFF);

    expect(html).toContain('TEAMHALF');
    expect(html).toContain('50% off Team for 3 months');
    expect(html).toContain('Applied at checkout.');
    expect(html).toContain('aria-label="Remove the code TEAMHALF"');
    expect(html).not.toContain('Have a code?');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { authoritySummary } from '@xecret/core/authz';
import { MINIMUM_SEATS } from '@xecret/core/entitlements';
import type { BillingStatusPayload } from '@/server/schemas/billing';
import type { SessionOrganization } from './session';

/**
 * The billing screen's change form, rendered to static markup for an owner
 * with a subscription — the form the plans page's "Switch to …" lands on.
 *
 * Two things are pinned. It opens on the plan and period it was sent, so the
 * choice made on the plans page survives the trip. And it sells nothing the
 * server does not gate: the sentence under the plan picker is the seat floor
 * and no more, because custom roles are Enterprise's and no plan gates
 * per-environment access (see the note at the top of `upgrade-plans.ts`).
 */

const viewer = vi.hoisted(() => ({ organization: null as SessionOrganization | null }));

vi.mock('./session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session')>()),
  useOrganization: () => viewer.organization,
}));

const resource = vi.hoisted(() => ({ billing: null as BillingStatusPayload | null }));

vi.mock('../_lib/use-api-resource', () => ({
  useApiResource: (path: string | null) => ({
    data: path === null || resource.billing === null ? null : { billing: resource.billing },
    error: null,
    loading: false,
    reload: async () => {},
  }),
}));

const { Toaster } = await import('@/components/ui');
const { BillingScreen } = await import('./billing-screen');

const OWNER: SessionOrganization = {
  id: 'org-1',
  name: 'Acme',
  slug: 'acme',
  role: 'owner',
  authority: { role: 'owner', customRole: null, ...authoritySummary({ role: 'owner' }) },
};

/** A Pro subscription on `interval`, changeable from here — yearly unless said otherwise. */
function subscribed(interval: 'monthly' | 'yearly' = 'yearly'): BillingStatusPayload {
  return {
    enabled: true,
    mode: 'live_mode',
    plan: 'pro',
    status: 'active',
    interval,
    managedBy: 'checkout',
    grant: null,
    seats: { billed: 4, seated: 4, pendingInvitations: 0, minimum: 1 },
    currency: 'USD',
    renewsAt: '2027-11-01T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    trialEndsAt: null,
    renewalAmount: '$240.00',
    regionLock: null,
    usage: {
      periodStart: '2026-11-01T00:00:00.000Z',
      secretFetches: 1_000,
      includedFetches: 200_000,
      unitsReported: 0,
      overageRate: '$0.01 per 1,000 secret fetches past the allowance ($1 per 100,000)',
    },
    warnings: [],
    addons: { saml: false },
    actions: { checkout: false, changePlan: true, portal: true, promoCode: false },
  };
}

function render(initialChoice?: { plan?: 'pro' | 'team'; interval?: 'monthly' | 'yearly' }) {
  return renderToStaticMarkup(
    createElement(
      Toaster,
      null,
      createElement(BillingScreen, {
        orgSlug: 'acme',
        returnedFromCheckout: false,
        ...(initialChoice === undefined ? {} : { initialChoice }),
      }),
    ),
  );
}

/** Whether the pill radio labelled `label` is the checked one. */
function checked(html: string, label: string): boolean {
  return new RegExp(`aria-checked="true"[^>]*>${label}<`).test(html);
}

beforeEach(() => {
  viewer.organization = OWNER;
  resource.billing = subscribed();
});

describe('BillingScreen’s change form', () => {
  it('opens on the plan and period the plans page sent', () => {
    const html = render({ plan: 'team', interval: 'monthly' });

    expect(checked(html, 'Team')).toBe(true);
    expect(checked(html, 'Monthly')).toBe(true);
    expect(checked(html, 'Yearly')).toBe(false);
  });

  it('opens as it always did when sent nothing', () => {
    // Monthly, because yearly is also the form's fallback: only a monthly
    // subscriber can show the default follows the subscription's own period.
    resource.billing = subscribed('monthly');
    const html = render();

    // The next rung up from Pro, on the subscription's own period.
    expect(checked(html, 'Team')).toBe(true);
    expect(checked(html, 'Monthly')).toBe(true);
    expect(checked(html, 'Yearly')).toBe(false);
  });

  it('says only the seat floor under Team — no roles, no per-environment access', () => {
    const html = render({ plan: 'team' });

    // Read from the engine, so a floor raised in `plans.ts` is checked at its
    // new value rather than leaving a stale "3" passing here.
    expect(html).toContain(`Team is billed from ${MINIMUM_SEATS.team} members up.`);
    expect(html).not.toMatch(/per-environment/i);
    expect(html).not.toMatch(/\broles\b/i);
  });

  it('does not describe Pro by a gate nothing enforces', () => {
    const html = render({ plan: 'pro' });

    expect(html).toContain('Pro has no seat minimum.');
    expect(html).not.toMatch(/every environment/i);
  });

  it('says machines never take a seat, not that they never cost anything', () => {
    const html = render();

    expect(html).toContain('Service tokens and CI never take a seat.');
    expect(html).not.toContain('never cost anything');
  });
});

/** A Team plan an admin gave, or a free-plan code redeemed: nothing at Dodo behind it. */
function complimentary(endsAt: string | null): BillingStatusPayload {
  return {
    ...subscribed(),
    plan: 'team',
    // The schema keeps an interval on every paid plan, a grant's included.
    interval: 'yearly',
    managedBy: 'support',
    grant: { endsAt, note: 'Launch partner' },
    currency: null,
    renewsAt: null,
    renewalAmount: null,
    actions: { checkout: false, changePlan: false, portal: false, promoCode: false },
  };
}

describe('BillingScreen, on a complimentary plan', () => {
  it('says it is complimentary, until when, and where it came from', () => {
    resource.billing = complimentary('2027-03-01T00:00:00.000Z');
    const html = render();

    expect(html).toContain('Complimentary Team plan');
    expect(html).toContain('until ');
    expect(html).toContain('Launch partner');
    expect(html).toContain('When it ends the organisation moves to Free, and nothing is deleted.');
    // It replaces the support notice, rather than sitting under it.
    expect(html).not.toContain('Managed by xecret support');
  });

  it('says so when it has no end', () => {
    resource.billing = complimentary(null);
    const html = render();

    expect(html).toContain('with no end date');
    expect(html).toContain('No end date');
    expect(html).not.toContain('When it ends');
  });

  it('invents no invoice: no billing period, no billed seats, no overage charge', () => {
    resource.billing = complimentary(null);
    const html = render();

    expect(html).toContain('· complimentary');
    expect(html).not.toContain('billed yearly');
    expect(html).not.toMatch(/\d+ billed/);
    expect(html).not.toContain('on the next invoice');
  });

  it('keeps the support notice for a plan arranged without a grant', () => {
    resource.billing = { ...complimentary(null), plan: 'enterprise', grant: null };
    const html = render();

    expect(html).toContain('Managed by xecret support');
    expect(html).not.toContain('Complimentary');
  });
});

/** An owner's Free organisation, which may check out — and, where the server says so, use a code. */
function free(promoCode: boolean): BillingStatusPayload {
  return {
    ...subscribed(),
    plan: 'free',
    interval: null,
    managedBy: 'none',
    seats: { billed: 1, seated: 2, pendingInvitations: 0, minimum: 1 },
    currency: null,
    renewsAt: null,
    renewalAmount: null,
    actions: { checkout: true, changePlan: false, portal: false, promoCode },
  };
}

describe('BillingScreen’s "Have a code?"', () => {
  it('is offered beside the checkout when the server allows a code', () => {
    resource.billing = free(true);
    const html = render();

    expect(html).toContain('Have a code?');
    // In the plan card, above the button it feeds.
    expect(html.indexOf('Have a code?')).toBeLessThan(html.indexOf('Continue to checkout'));
  });

  it('is not offered when it does not', () => {
    resource.billing = free(false);
    expect(render()).not.toContain('Have a code?');

    resource.billing = subscribed();
    expect(render()).not.toContain('Have a code?');
  });

  it('is offered on its own where nothing is sold, for a free-plan code', () => {
    resource.billing = {
      ...free(true),
      enabled: false,
      mode: null,
      actions: { checkout: false, changePlan: false, portal: false, promoCode: true },
    };
    const html = render();

    expect(html).toContain('Have a code?');
    expect(html).not.toContain('Continue to checkout');
  });
});

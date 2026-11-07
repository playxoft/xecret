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
    actions: { checkout: false, changePlan: true, portal: true },
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

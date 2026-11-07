import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Where "Compare plans" goes.
 *
 * Inside an organisation, to that organisation's own plans page — where an
 * owner can act on it without leaving the dashboard. Anywhere without one, to
 * the public pricing page.
 */

const navigation = vi.hoisted(() => ({ pathname: null as string | null }));

vi.mock('next/navigation', () => ({ usePathname: () => navigation.pathname }));

const { ApiError } = await import('@/lib/api');
const { ChangeError, PLANS_HREF, PlanLock, plansHref } = await import('./plan-notice');

beforeEach(() => {
  navigation.pathname = null;
});

describe('plansHref', () => {
  it.each([
    ['/app/acme', '/app/acme/upgrade'],
    ['/app/acme/payments-api/production', '/app/acme/upgrade'],
    ['/app/acme/payments-api/production/settings', '/app/acme/upgrade'],
    ['/app/acme/settings', '/app/acme/upgrade'],
  ])('sends %s to its organisation’s plans', (pathname, expected) => {
    expect(plansHref(pathname)).toBe(expected);
  });

  it.each([['/app/settings/account'], ['/app'], ['/pricing']])(
    'sends %s, which names no organisation, to the pricing page',
    (pathname) => {
      expect(plansHref(pathname)).toBe(PLANS_HREF);
    },
  );

  it('falls back to the pricing page with no router at all', () => {
    expect(plansHref(null)).toBe('/pricing');
  });
});

describe('the notices link there', () => {
  it('PlanLock, inside an organisation', () => {
    navigation.pathname = '/app/acme/payments-api/staging/settings';
    const html = renderToStaticMarkup(
      createElement(PlanLock, { what: 'Disabling plaintext export', upgradeTo: 'team' }),
    );

    expect(html).toContain('Disabling plaintext export needs the Team plan.');
    expect(html).toContain('href="/app/acme/upgrade"');
  });

  it('ChangeError, for a plan refusal', () => {
    navigation.pathname = '/app/acme/payments-api/production';
    const error = new ApiError({
      code: 'plan_limit',
      message: 'Promotion needs the Pro plan.',
      status: 403,
      requestId: 'req-1',
      plan: {
        resource: 'environmentPromotion',
        limit: null,
        current: null,
        plan: 'free',
        upgradeTo: 'pro',
      },
    });
    const html = renderToStaticMarkup(createElement(ChangeError, { error }));

    expect(html).toContain('Available on the Pro plan');
    expect(html).toContain('href="/app/acme/upgrade"');
  });

  it('the pricing page, where there is no organisation', () => {
    const html = renderToStaticMarkup(
      createElement(PlanLock, { what: 'Delivering webhooks', upgradeTo: 'pro' }),
    );

    expect(html).toContain('href="/pricing"');
  });
});

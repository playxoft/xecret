import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { authoritySummary } from '@xecret/core/authz';
import type { OrgRole } from '@xecret/core/authz';
import { DEFAULT_SECRET_POLICY, DEFAULT_TOKEN_POLICY } from '@xecret/core/policy';
import type { SessionOrganization } from '@/app/(dashboard)/_components/session';
import type { OrgPoliciesResponse } from './types';

/**
 * The two policy cards, rendered to static markup with the policies they would
 * fetch handed to them — a server render runs no effects, so the data hook is
 * stubbed with what the API would answer.
 *
 * What is pinned is the plan rule as the cards draw it: a rule that is off, on
 * a plan without the feature, is drawn locked with the plan named; a rule that
 * is *on* is never locked, because switching it off is always allowed; and a
 * policy is never hidden from anybody, only made read-only.
 */

const resource = vi.hoisted(() => ({
  current: { data: null as unknown, error: null as unknown, loading: false },
  paths: [] as (string | null)[],
}));

vi.mock('@/app/(dashboard)/_lib/use-api-resource', () => ({
  useApiResource: (path: string | null) => {
    resource.paths.push(path);
    return { ...resource.current, reload: async () => {} };
  },
}));

const { Toaster } = await import('@/components/ui');
const { PolicyCards } = await import('./policy-cards');

function organization(role: OrgRole): SessionOrganization {
  return {
    id: 'org-1',
    name: 'Acme',
    slug: 'acme',
    role,
    authority: { role, customRole: null, ...authoritySummary({ role }) },
  };
}

function policies(over: Partial<OrgPoliciesResponse> = {}): OrgPoliciesResponse {
  return {
    tokens: DEFAULT_TOKEN_POLICY,
    secrets: DEFAULT_SECRET_POLICY,
    features: {
      tokenIpAllowlist: { enabled: true, upgradeTo: null },
      secretPolicy: { enabled: true, upgradeTo: null },
      disableEnvExport: { enabled: true, upgradeTo: null },
      newIpReadAlerts: { enabled: true, upgradeTo: null },
    },
    updatedAt: null,
    ...over,
  };
}

/** A free organisation: neither policy feature included. */
const FREE_FEATURES: OrgPoliciesResponse['features'] = {
  tokenIpAllowlist: { enabled: false, upgradeTo: 'pro' },
  secretPolicy: { enabled: false, upgradeTo: 'team' },
  disableEnvExport: { enabled: false, upgradeTo: 'team' },
  newIpReadAlerts: { enabled: false, upgradeTo: 'pro' },
};

function shows(data: OrgPoliciesResponse): void {
  resource.current = { data, error: null, loading: false };
}

function render(role: OrgRole): string {
  return renderToStaticMarkup(
    createElement(
      Toaster,
      null,
      createElement(PolicyCards, { orgSlug: 'acme', organization: organization(role) }),
    ),
  );
}

/**
 * Whether the `<button role="checkbox">` with one id carries the `disabled`
 * attribute — the attribute, not the word, which every checkbox's class list
 * contains as a Tailwind variant.
 */
function disabled(html: string, id: string): boolean {
  const tag = new RegExp(`<button[^>]*id="${id}"[^>]*>`).exec(html)?.[0];
  if (tag === undefined) throw new Error(`no checkbox with id ${id}`);
  return /\sdisabled=""/.test(tag);
}

beforeEach(() => {
  resource.paths = [];
  resource.current = { data: null, error: null, loading: false };
});

describe('PolicyCards', () => {
  it('reads the policies once for both cards', () => {
    shows(policies());
    render('owner');
    expect(resource.paths).toEqual(['/api/orgs/acme/policies']);
  });

  it('locks a rule that is off on a plan without the feature, naming the plan', () => {
    shows(policies({ features: FREE_FEATURES }));
    const html = render('owner');

    expect(html).toContain('Setting a token policy needs the Pro plan.');
    expect(disabled(html, 'token-policy-allowlist')).toBe(true);
    expect(disabled(html, 'token-policy-cap')).toBe(true);

    expect(html).toContain('Switching the secret policy on needs the Team plan.');
    expect(disabled(html, 'secret-policy-enabled')).toBe(true);
    // Preparing the rules while the policy is off never needs a plan.
    expect(disabled(html, 'secret-policy-names')).toBe(false);
    expect(html).toContain('Compare plans');
  });

  it('never locks a rule that is already on, so a downgraded organisation can switch it off', () => {
    shows(
      policies({
        tokens: { requireIpAllowlist: true, maxLifetimeDays: null },
        secrets: { ...DEFAULT_SECRET_POLICY, enabled: true },
        features: FREE_FEATURES,
      }),
    );
    const html = render('owner');

    expect(disabled(html, 'token-policy-allowlist')).toBe(false);
    expect(disabled(html, 'secret-policy-enabled')).toBe(false);
    // The cap is off and the plan cannot switch it on.
    expect(disabled(html, 'token-policy-cap')).toBe(true);
    expect(html).toContain('plan no longer includes the token policy');
    expect(html).toContain('plan no longer includes the secret policy');
  });

  it('shows every member the policy, read-only, and says who may change it', () => {
    shows(
      policies({
        tokens: { requireIpAllowlist: true, maxLifetimeDays: 30 },
        secrets: { ...DEFAULT_SECRET_POLICY, enabled: true },
      }),
    );
    const html = render('developer');

    expect(html).toContain('Only an owner or admin can change the token policy.');
    expect(html).toContain('Only an owner or admin can change the secret policy.');
    expect(disabled(html, 'token-policy-allowlist')).toBe(true);
    expect(disabled(html, 'secret-policy-enabled')).toBe(true);
    expect(html).not.toContain('Save token policy');
    expect(html).not.toContain('Save secret policy');
  });

  it('says which party enforces each secret rule, and that existing secrets are never blocked', () => {
    shows(policies());
    const html = render('owner');

    expect(html).toContain('Who enforces which rule');
    expect(html).toContain('checked by the server');
    expect(html).toContain('checked by the dashboard and the CLI');
    expect(html).toContain('never blocked on read');
  });

  it('reports a stored pattern that does not compile', () => {
    shows(policies({ secrets: { ...DEFAULT_SECRET_POLICY, enabled: true, namePattern: '[A-Z' } }));
    const html = render('owner');
    expect(html).toContain('The stored policy does not pass today’s checks');
  });
});

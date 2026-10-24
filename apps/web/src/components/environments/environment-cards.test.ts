import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { EnvironmentDetail } from '@/components/projects/types';
import type { OrgPoliciesResponse } from '@/components/policies/types';
import type { ReadSightingsResponse } from './read-sightings';

/**
 * The two environment-settings cards, rendered to static markup with what the
 * API would answer handed to the data hook — a server render runs no effects.
 *
 * What is pinned: a control the plan does not include is drawn locked with the
 * plan that unlocks it, never hidden; a control that is already on is never
 * locked; somebody who cannot manage the environment is told so and fetches
 * nothing they could not read.
 */

const resource = vi.hoisted(() => ({
  answers: new Map<string, unknown>(),
  paths: [] as (string | null)[],
}));

vi.mock('@/app/(dashboard)/_lib/use-api-resource', () => ({
  useApiResource: (path: string | null) => {
    resource.paths.push(path);
    const data = path === null ? null : (resource.answers.get(path) ?? null);
    return { data, error: null, loading: false, reload: async () => {} };
  },
}));

const { Toaster } = await import('@/components/ui');
const { InheritanceCard } = await import('./inheritance-card');
const { EnvironmentPolicyCard } = await import('./environment-policy-card');

const PROJECT = '/api/orgs/acme/projects/api';
const POLICIES = '/api/orgs/acme/policies';
const SIGHTINGS = '/api/orgs/acme/projects/api/environments/production/read-sightings?limit=50';

function environment(over: Partial<EnvironmentDetail> = {}): EnvironmentDetail {
  return {
    name: 'Production',
    slug: 'production',
    isProduction: true,
    sortOrder: 2,
    encryptionMode: 'e2ee',
    parent: null,
    plaintextExport: 'allowed',
    readAlerts: null,
    readAlertsActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    secretCount: 4,
    ...over,
  };
}

function policies(entitled: boolean): OrgPoliciesResponse {
  const status = (upgradeTo: string) => ({
    enabled: entitled,
    upgradeTo: entitled ? null : upgradeTo,
  });
  return {
    tokens: { requireIpAllowlist: false, maxLifetimeDays: null },
    secrets: {
      enabled: false,
      scope: 'all',
      namePattern: null,
      minValueEntropyBits: null,
      entropyAppliesTo: [],
      forbiddenSubstrings: [],
    },
    features: {
      tokenIpAllowlist: status('pro'),
      secretPolicy: status('team'),
      disableEnvExport: status('team'),
      newIpReadAlerts: status('pro'),
    },
    updatedAt: null,
  };
}

function render(element: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(createElement(Toaster, null, element));
}

/** The `<button role="switch">` with this id. */
function switchFor(html: string, id: string): string {
  return new RegExp(`<button[^>]*id="${id}"[^>]*>`).exec(html)?.[0] ?? '';
}

beforeEach(() => {
  resource.answers.clear();
  resource.paths = [];
  resource.answers.set(PROJECT, {
    project: { name: 'API', slug: 'api', description: null, createdAt: '', updatedAt: '' },
    environments: [
      { ...environment({ name: 'Development', slug: 'dev', isProduction: false }) },
      { ...environment({ name: 'Staging', slug: 'staging', isProduction: false, parent: 'dev' }) },
      environment(),
    ],
  });
});

describe('InheritanceCard', () => {
  it('explains that a server-mode environment cannot inherit, and offers nothing', () => {
    const html = render(
      createElement(InheritanceCard, {
        orgSlug: 'acme',
        projectSlug: 'api',
        environment: environment({ encryptionMode: 'server' }),
        canManage: true,
        onChanged: () => {},
      }),
    );

    expect(html).toContain('Inheritance needs end-to-end encryption');
    expect(html).not.toContain('Stop inheriting');
  });

  it('names the whole chain, and lets a manager stop inheriting', () => {
    const html = render(
      createElement(InheritanceCard, {
        orgSlug: 'acme',
        projectSlug: 'api',
        environment: environment({ parent: 'staging' }),
        canManage: true,
        onChanged: () => {},
      }),
    );

    expect(html).toContain('Staging');
    expect(html).toContain('which inherits from');
    expect(html).toContain('Development');
    expect(html).toContain('Stop inheriting');
    expect(html).toContain('clearing one never needs a plan');
  });

  it('tells somebody who cannot manage the environment who can', () => {
    const html = render(
      createElement(InheritanceCard, {
        orgSlug: 'acme',
        projectSlug: 'api',
        environment: environment({ parent: 'staging' }),
        canManage: false,
        onChanged: () => {},
      }),
    );

    expect(html).toContain('Only an owner or admin can change what this environment inherits from');
    expect(html).not.toContain('Stop inheriting');
  });
});

describe('EnvironmentPolicyCard', () => {
  it('locks each switch’s on direction with the plan that unlocks it', () => {
    resource.answers.set(POLICIES, policies(false));
    resource.answers.set(SIGHTINGS, {
      sightings: [],
      alerts: { active: false, entitled: false, upgradeTo: 'pro' },
    } satisfies ReadSightingsResponse);

    const html = render(
      createElement(EnvironmentPolicyCard, {
        orgSlug: 'acme',
        projectSlug: 'api',
        environment: environment({ readAlerts: false, readAlertsActive: false }),
        canManage: true,
        onChanged: () => {},
      }),
    );

    expect(html).toContain('Disabling plaintext export needs the Team plan.');
    expect(html).toContain('Switching read alerts on needs the Pro plan.');
    expect(switchFor(html, 'export-production')).toContain('disabled=""');
    expect(switchFor(html, 'alerts-production')).toContain('disabled=""');
    // Resetting production back to its default would switch alerts on, so the
    // reset is locked too — and says why.
    expect(html).toContain('Reset to default (on)');
    expect(html).toContain('which switches alerts on here, needs the Pro plan.');
  });

  it('never locks a switch that is already on, and says a downgrade keeps it', () => {
    resource.answers.set(POLICIES, policies(false));

    const html = render(
      createElement(EnvironmentPolicyCard, {
        orgSlug: 'acme',
        projectSlug: 'api',
        environment: environment({ plaintextExport: 'disabled' }),
        canManage: true,
        onChanged: () => {},
      }),
    );

    expect(switchFor(html, 'export-production')).not.toContain('disabled=""');
    expect(switchFor(html, 'export-production')).toContain('aria-checked="true"');
    expect(html).not.toContain('Disabling plaintext export needs');
    expect(html).toContain('not removed by a downgrade');
    // On by default for production, but not delivered on this plan.
    expect(html).toContain('On, but nothing is being sent');
  });

  it('leaves the switches usable while the plan is unknown', () => {
    const html = render(
      createElement(EnvironmentPolicyCard, {
        orgSlug: 'acme',
        projectSlug: 'api',
        environment: environment({ isProduction: false, readAlertsActive: false }),
        canManage: true,
        onChanged: () => {},
      }),
    );

    expect(switchFor(html, 'export-production')).not.toContain('disabled=""');
    expect(switchFor(html, 'alerts-production')).not.toContain('disabled=""');
  });

  it('lists who read from where, and whether the alert went out', () => {
    resource.answers.set(POLICIES, policies(true));
    resource.answers.set(SIGHTINGS, {
      sightings: [
        {
          id: 's1',
          principalKind: 'service_token',
          principalLabel: 'deploy-bot',
          address: '203.0.113.7',
          firstSeenAt: '2026-10-19T10:00:00.000Z',
          lastSeenAt: '2026-10-20T09:00:00.000Z',
          notifiedAt: null,
        },
      ],
      alerts: { active: true, entitled: true, upgradeTo: null },
    } satisfies ReadSightingsResponse);

    const html = render(
      createElement(EnvironmentPolicyCard, {
        orgSlug: 'acme',
        projectSlug: 'api',
        environment: environment(),
        canManage: true,
        onChanged: () => {},
      }),
    );

    expect(html).toContain('Recent new addresses');
    expect(html).toContain('deploy-bot');
    expect(html).toContain('Service token');
    expect(html).toContain('203.0.113.7');
    expect(html).toContain('In the next digest');
  });

  it('fetches no read list for somebody who cannot manage the environment', () => {
    const html = render(
      createElement(EnvironmentPolicyCard, {
        orgSlug: 'acme',
        projectSlug: 'api',
        environment: environment(),
        canManage: false,
        onChanged: () => {},
      }),
    );

    expect(html).toContain('Only an owner or admin can change this environment’s policy.');
    expect(html).not.toContain('Recent new addresses');
    expect(resource.paths).not.toContain(SIGHTINGS);
    expect(resource.paths).toContain(null);
  });
});

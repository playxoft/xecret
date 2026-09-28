import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { authoritySummary, CUSTOM_ROLE_FLOOR } from '@xecret/core/authz';
import type { Action, CustomRole, OrgRole } from '@xecret/core/authz';
import type { ServiceTokenListResponse } from '@/components/tokens/types';
import type { SessionOrganization } from './session';

/**
 * The Tokens page, rendered to static markup for roles that hold minting and
 * revoking apart: the service tokens are listed for either, and each control
 * is drawn for its own action. A server render runs no effects, so the data
 * hook answers with what the API would.
 */

const viewer = vi.hoisted(() => ({ organization: null as SessionOrganization | null }));

vi.mock('./session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session')>()),
  useOrganization: () => viewer.organization,
}));

const SERVICE_TOKENS: ServiceTokenListResponse = {
  data: [
    {
      id: 'token-1',
      name: 'deploy',
      tokenPrefix: 'xst_live_ab12',
      projectSlug: 'api',
      environmentSlug: 'staging',
      accessLevel: 'read',
      ipAllowlist: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    },
  ],
};

const fetched = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock('../_lib/use-api-resource', () => ({
  useApiResource: (path: string | null) => {
    if (path !== null) fetched.paths.push(path);
    const data = path?.includes('/tokens/service')
      ? SERVICE_TOKENS
      : path === null
        ? null
        : { data: [] };
    return { data, error: null, loading: false, reload: async () => {} };
  },
}));

const { Toaster } = await import('@/components/ui');
const { TokensScreen } = await import('./tokens-screen');

function organization(role: OrgRole, allowedActions?: readonly Action[]): SessionOrganization {
  const customRole: CustomRole | undefined =
    allowedActions === undefined
      ? undefined
      : { id: 'role-1', name: 'Narrowed', baseRole: role, allowedActions: [...allowedActions] };
  return {
    id: 'org-1',
    name: 'Acme',
    slug: 'acme',
    role,
    authority: {
      role,
      customRole:
        customRole === undefined
          ? null
          : { id: customRole.id, name: customRole.name, baseRole: customRole.baseRole },
      ...authoritySummary({ role, customRole }),
    },
  };
}

function render(org: SessionOrganization): string {
  viewer.organization = org;
  return renderToStaticMarkup(
    createElement(Toaster, null, createElement(TokensScreen, { orgSlug: 'acme' })),
  );
}

beforeEach(() => {
  fetched.paths.length = 0;
});

describe('TokensScreen', () => {
  it('lists the service tokens for a role that may only revoke them, with Revoke and no New', () => {
    const html = render(organization('admin', [...CUSTOM_ROLE_FLOOR, 'token.revoke']));

    expect(fetched.paths.some((path) => path.includes('/tokens/service'))).toBe(true);
    expect(html).toContain('aria-label="Revoke deploy"');
    expect(html).not.toContain('New service token');
  });

  it('offers a role that may only mint New, and no Revoke', () => {
    const html = render(organization('admin', [...CUSTOM_ROLE_FLOOR, 'token.create']));

    expect(html).toContain('New service token');
    expect(html).not.toContain('aria-label="Revoke deploy"');
  });

  it('asks nothing about service tokens of a role that may do neither', () => {
    const html = render(organization('developer'));

    expect(fetched.paths.some((path) => path.includes('/tokens/service'))).toBe(false);
    expect(html).not.toContain('Service tokens');
  });
});

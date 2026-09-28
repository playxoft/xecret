import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { authoritySummary } from '@xecret/core/authz';
import type { CustomRole as EngineRole, OrgRole } from '@xecret/core/authz';
import { CUSTOM_ROLES_PER_ORGANIZATION } from '@xecret/core/validation';
import type { SessionOrganization } from '@/app/(dashboard)/_components/session';
import type { CustomRole, CustomRoleListResponse } from '@/components/members/types';

/**
 * The Roles card, rendered to static markup with the list it would fetch
 * handed to it — a server render runs no effects, so the data hook is stubbed
 * with what the API would answer. Each absent control must say why.
 */

const resource = vi.hoisted(() => ({
  current: { data: null as unknown, error: null as unknown, loading: false },
}));

vi.mock('@/app/(dashboard)/_lib/use-api-resource', () => ({
  useApiResource: (path: string | null) =>
    path === null
      ? { data: null, error: null, loading: false, reload: async () => {} }
      : { ...resource.current, reload: async () => {} },
}));

const { Toaster } = await import('@/components/ui');
const { RolesCard } = await import('./roles-card');

function organization(role: OrgRole, customRole?: EngineRole): SessionOrganization {
  const summary = authoritySummary({ role, customRole });
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
      ...summary,
    },
  };
}

function role(over: Partial<CustomRole> = {}): CustomRole {
  return {
    id: `role-${Math.random()}`,
    name: 'Deployer',
    baseRole: 'developer',
    allowedActions: ['member.read', 'secret.read'],
    accessCeiling: { nonProduction: 'write', production: 'none' },
    holderCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function listed(roles: CustomRole[], enabled = true): void {
  const data: CustomRoleListResponse = {
    data: roles,
    feature: { enabled, upgradeTo: enabled ? null : 'enterprise' },
  };
  resource.current = { data, error: null, loading: false };
}

function render(org: SessionOrganization): string {
  return renderToStaticMarkup(
    createElement(Toaster, null, createElement(RolesCard, { orgSlug: 'acme', organization: org })),
  );
}

beforeEach(() => listed([role()]));

describe('RolesCard', () => {
  it('tells somebody who cannot change members who manages roles, and fetches nothing', () => {
    const html = render(organization('developer'));

    expect(html).toContain('managed by owners and admins who can change members');
    expect(html).not.toContain('New role');
    expect(html).not.toContain('Delete role');
  });

  it('offers an unnarrowed admin New role, Edit and Delete', () => {
    const html = render(organization('admin'));

    expect(html).toContain('New role');
    expect(html).toContain('aria-label="Edit role Deployer"');
    expect(html).toContain('aria-label="Delete role Deployer"');
  });

  it('draws Delete unavailable, with the reason, for a role somebody holds', () => {
    listed([role({ holderCount: 2 })]);

    const html = render(organization('admin'));

    const button = /<button[^>]*aria-label="Delete role Deployer[^"]*"[^>]*>/.exec(html)?.[0] ?? '';
    expect(button).toMatch(/\sdisabled=""/);
    expect(button).toContain('unavailable while 2 members hold it');
    expect(button).toContain('move its members to another role, or to none, first');
  });

  it('gives way to a sentence at the role ceiling, instead of a New role that would fail', () => {
    listed(
      Array.from({ length: CUSTOM_ROLES_PER_ORGANIZATION }, (_, index) =>
        role({ id: `role-${index}`, name: `Role ${index}` }),
      ),
    );

    const html = render(organization('admin'));

    expect(html).not.toContain('New role');
    expect(html).toContain('defined the most roles it can');
  });

  it('names the plan that has the feature, and still lets a role nobody holds be deleted', () => {
    listed([role()], false);

    const html = render(organization('owner'));

    expect(html).toContain('needs the Enterprise plan');
    expect(html).not.toContain('New role');
    expect(html).not.toContain('Edit role');
    expect(html).toContain('aria-label="Delete role Deployer"');
  });

  it('shows a narrowed admin the list without the definer controls, and says why', () => {
    const narrowed: EngineRole = {
      id: 'held',
      name: 'Access manager',
      baseRole: 'admin',
      allowedActions: ['member.read', 'member.update'],
    };

    const html = render(organization('admin', narrowed));

    expect(html).toContain('Deployer');
    expect(html).toContain('Only an owner or admin who holds no custom role');
    expect(html).not.toContain('New role');
    expect(html).not.toContain('Delete role');
  });
});

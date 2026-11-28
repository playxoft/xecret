import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { authoritySummary } from '@xecret/core/authz';
import type { OrgRole } from '@xecret/core/authz';
import type { OrgEntitlements } from '@/components/plans/plan-gate';
import type { SessionOrganization } from './session';

/**
 * Each screen that creates something a plan counts, at the ceiling and below
 * it: the control is drawn locked, with the plan's words, at the ceiling, and
 * is the plain button below it.
 *
 * The screens are rendered to static markup under a plan view, the one the
 * dashboard shell shares from its single read of `GET …/entitlements`, with
 * the data hook answering what the API would. A server render runs no effects,
 * so nothing here is fetched.
 */

const viewer = vi.hoisted(() => ({ organization: null as SessionOrganization | null }));

vi.mock('./session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session')>()),
  useOrganization: () => viewer.organization,
  // Two memberships, so the organisations screen lists them rather than
  // opening the only one.
  useSession: () => ({
    refreshTrail: () => {},
    createOrganization: () => {},
    organizations: [viewer.organization, { ...viewer.organization, slug: 'zebra', name: 'Zebra' }],
  }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  usePathname: () => '/app/acme',
}));

/** What each API path answers, by a substring of the path. */
const answers = vi.hoisted(() => ({ current: [] as [string, unknown][] }));

vi.mock('../_lib/use-api-resource', () => ({
  useApiResource: (path: string | null) => {
    const found = path === null ? undefined : answers.current.find(([key]) => path.includes(key));
    return { data: found?.[1] ?? null, error: null, loading: false, reload: async () => {} };
  },
}));

const { Toaster, TooltipProvider } = await import('@/components/ui');
const { entitlementsFor, planView, withPlan } = await import('@/components/plans/plan-test-view');
const { ProjectsScreen } = await import('./projects-screen');
const { ProjectScreen } = await import('./project-screen');
const { TokensScreen } = await import('./tokens-screen');
const { MembersScreen } = await import('./members-screen');
const { OrganizationsScreen } = await import('./organizations-screen');

function organization(role: OrgRole): SessionOrganization {
  return {
    id: 'org-1',
    name: 'Acme',
    slug: 'acme',
    role,
    authority: { role, customRole: null, ...authoritySummary({ role }) },
  };
}

function render(element: ReactElement, entitlements: OrgEntitlements, role: OrgRole = 'owner') {
  viewer.organization = organization(role);
  return renderToStaticMarkup(
    withPlan(
      planView({ entitlements, owner: role === 'owner' }),
      createElement(TooltipProvider, null, createElement(Toaster, null, element)),
    ),
  );
}

/** Whether the button whose text includes `label` is drawn locked. */
function locked(html: string, label: string): boolean {
  return new RegExp(
    `<button[^>]*aria-disabled="true"[^>]*data-plan-locked=""[^>]*>(?:(?!</button>)[\\s\\S])*${label}`,
  ).test(html);
}

function usage(over: Partial<OrgEntitlements['usage']>): Partial<OrgEntitlements> {
  return { usage: { projects: 0, serviceTokens: 0, webhooks: 0, seats: 1, ...over } };
}

beforeEach(() => {
  answers.current = [];
});

const PROJECT = {
  id: '018f3f6a-0000-7000-8000-000000000a01',
  name: 'API',
  slug: 'api',
  description: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('Projects: the project ceiling', () => {
  beforeEach(() => {
    answers.current = [
      [
        '/projects',
        {
          projects: [{ ...PROJECT, environmentCount: 3 }],
          page: 1,
          pageSize: 200,
          hasMore: false,
        },
      ],
    ];
  });

  it('locks New project at the ceiling, counted by the organisation rather than the page', () => {
    const html = render(
      createElement(ProjectsScreen, { orgSlug: 'acme' }),
      entitlementsFor('free', usage({ projects: 5 })),
    );
    expect(locked(html, 'New project')).toBe(true);
    expect(html).toContain('Your Free plan allows 5 projects. Upgrade to Pro to add more.');
  });

  it('leaves it a plain button below the ceiling', () => {
    const html = render(
      createElement(ProjectsScreen, { orgSlug: 'acme' }),
      entitlementsFor('free', usage({ projects: 4 })),
    );
    expect(html).toContain('New project');
    expect(locked(html, 'New project')).toBe(false);
  });

  it('never shows the server’s long refusal sentence', () => {
    const html = render(
      createElement(ProjectsScreen, { orgSlug: 'acme' }),
      entitlementsFor('free', usage({ projects: 5 })),
    );
    expect(html).not.toContain('This organisation is on the Free plan, which allows 5 projects.');
  });
});

describe('A project: the environment ceiling', () => {
  function environments(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      name: `Env ${index}`,
      slug: `env-${index}`,
      isProduction: false,
      sortOrder: index,
      encryptionMode: 'e2ee',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }));
  }

  it('locks New environment once the project holds as many as the plan allows', () => {
    answers.current = [['/projects/', { project: PROJECT, environments: environments(3) }]];
    const html = render(
      createElement(ProjectScreen, { orgSlug: 'acme', projectId: PROJECT.id }),
      entitlementsFor('free'),
    );
    expect(locked(html, 'New environment')).toBe(true);
    expect(html).toContain('Your Free plan allows 3 environments per project.');
  });

  it('leaves it a plain button below the ceiling', () => {
    answers.current = [['/projects/', { project: PROJECT, environments: environments(2) }]];
    const html = render(
      createElement(ProjectScreen, { orgSlug: 'acme', projectId: PROJECT.id }),
      entitlementsFor('free'),
    );
    expect(html).toContain('New environment');
    expect(locked(html, 'New environment')).toBe(false);
  });
});

describe('Tokens: the service-token ceiling', () => {
  beforeEach(() => {
    answers.current = [
      [
        '/tokens/service',
        { data: [], policy: { requireIpAllowlist: false, maxLifetimeDays: null } },
      ],
      ['/tokens/cli', { data: [] }],
    ];
  });

  it('locks New service token at the ceiling, and tells an admin to ask an owner', () => {
    const html = render(
      createElement(TokensScreen, { orgSlug: 'acme' }),
      entitlementsFor('free', usage({ serviceTokens: 10 })),
      'admin',
    );
    expect(locked(html, 'New service token')).toBe(true);
    expect(html).toContain('Your Free plan allows 10 service tokens. Ask an owner to upgrade.');
  });

  it('leaves it a plain button below the ceiling', () => {
    const html = render(
      createElement(TokensScreen, { orgSlug: 'acme' }),
      entitlementsFor('free', usage({ serviceTokens: 9 })),
      'admin',
    );
    expect(locked(html, 'New service token')).toBe(false);
  });
});

describe('Members: the seat ceiling', () => {
  function members(seats: { used: number; pendingInvitations: number; limit: number }) {
    answers.current = [
      [
        '/members',
        {
          data: [
            {
              id: 'member-1',
              userId: 'user-1',
              email: 'owner@example.com',
              displayName: 'Owner',
              avatarUrl: null,
              role: 'owner',
              customRole: null,
              status: 'active',
              joinedAt: '2026-01-01T00:00:00.000Z',
              isYou: true,
            },
          ],
          seats,
          nextCursor: null,
        },
      ],
      ['/invitations', { data: [] }],
      ['/roles', { data: [], feature: { enabled: false, upgradeTo: 'enterprise' } }],
      ['/projects', { projects: [], page: 1, pageSize: 200, hasMore: false }],
    ];
  }

  it('locks Invite once members and open invitations fill every seat', () => {
    members({ used: 2, pendingInvitations: 1, limit: 3 });
    const html = render(createElement(MembersScreen, { orgSlug: 'acme' }), entitlementsFor('free'));
    expect(locked(html, 'Invite')).toBe(true);
    expect(html).toContain('Your Free plan allows 3 members. Upgrade to Pro to add more.');
  });

  it('leaves it a plain button while a seat is free', () => {
    members({ used: 2, pendingInvitations: 0, limit: 3 });
    const html = render(createElement(MembersScreen, { orgSlug: 'acme' }), entitlementsFor('free'));
    expect(html).toContain('Invite');
    expect(locked(html, 'Invite')).toBe(false);
  });

  it('never locks a per-seat plan, which has no ceiling', () => {
    members({ used: 40, pendingInvitations: 5, limit: 100_000 });
    const pro = entitlementsFor('pro', {
      limits: { ...entitlementsFor('pro').limits, seats: null },
    });
    const html = render(createElement(MembersScreen, { orgSlug: 'acme' }), pro);
    expect(locked(html, 'Invite')).toBe(false);
  });
});

describe('An organisation awaiting a paid plan', () => {
  it('locks every create, with the one sentence that says why', () => {
    answers.current = [
      [
        '/projects',
        { projects: [{ ...PROJECT, environmentCount: 3 }], page: 1, pageSize: 200, hasMore: false },
      ],
    ];
    const html = render(
      createElement(ProjectsScreen, { orgSlug: 'acme' }),
      entitlementsFor('free', { awaitingPaidPlan: true, controlPlaneActive: false }),
    );
    expect(locked(html, 'New project')).toBe(true);
    expect(html).toContain('Choose a plan to start using this organisation.');
  });
});

describe('Creating an organisation', () => {
  function twoMemberships() {
    viewer.organization = organization('owner');
  }

  it('locks New organisation while the account holds one waiting for a plan', () => {
    twoMemberships();
    const html = renderToStaticMarkup(
      withPlan(
        planView({
          entitlements: entitlementsFor('free', {
            account: { freeOrganizations: 2, awaitingOrganizations: 1 },
          }),
        }),
        createElement(OrganizationsScreen, {}),
      ),
    );
    expect(locked(html, 'New organisation')).toBe(true);
    expect(html).toContain('You already have an organisation waiting for a paid plan.');
  });

  it('leaves it a plain button otherwise, a third Free one included', () => {
    twoMemberships();
    const html = renderToStaticMarkup(
      withPlan(
        planView({
          entitlements: entitlementsFor('free', {
            account: { freeOrganizations: 2, awaitingOrganizations: 0 },
          }),
        }),
        createElement(OrganizationsScreen, {}),
      ),
    );
    expect(html).toContain('New organisation');
    expect(locked(html, 'New organisation')).toBe(false);
  });
});

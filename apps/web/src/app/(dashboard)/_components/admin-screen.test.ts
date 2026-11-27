import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, Fragment } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  AdminAccountPayload,
  AdminGrantPayload,
  AdminOrganizationPayload,
  AdminPromoCodePayload,
  AdminUserPayload,
} from '@/server/schemas/admin';
import type { GrantTarget } from './admin-grant-dialogs';

/**
 * The admin page, rendered to static markup. A server render runs no effects,
 * so the data hook answers with what the API would, and records what it was
 * asked for.
 *
 * Pinned: that nobody but an admin is shown anything — the page is a 404, as
 * the API is, and asks the API nothing — and that what an admin is shown says
 * what each action will do before it is pressed: a Dodo subscription a grant
 * would take an organisation off, a discount made in a mode that applies to
 * nothing here, and which codes can still be revoked.
 */

const viewer = vi.hoisted(() => ({ admin: false, query: '' }));

vi.mock('./session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session')>()),
  useSession: () => ({ admin: viewer.admin, refresh: async () => {} }),
}));

/**
 * The tab asks for the router; nothing here navigates through it. The page
 * reads its tab from the address, which a case sets. `notFound` stays real.
 */
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams(viewer.query),
}));

/** What the API was sent, and how it answers — a success unless a case says otherwise. */
const api = vi.hoisted(() => ({
  posts: [] as { path: string; body: unknown }[],
  answer: (() => Promise.resolve(undefined)) as () => Promise<unknown>,
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...real,
    api: {
      ...real.api,
      post: (path: string, body?: unknown) => {
        api.posts.push({ path, body });
        return api.answer();
      },
    },
  };
});

const served = vi.hoisted(() => ({
  paths: [] as (string | null)[],
  answers: new Map<string, unknown>(),
  /** Paths the API refuses, and with what. */
  errors: new Map<string, unknown>(),
}));

vi.mock('../_lib/use-api-resource', () => ({
  useApiResource: (path: string | null) => {
    served.paths.push(path);
    const data = path === null ? null : (served.answers.get(path) ?? null);
    const error = path === null ? null : (served.errors.get(path) ?? null);
    return { data, error, loading: false, reload: async () => {} };
  },
}));

/**
 * Radix portals a dialog's content into the document once mounted, which a
 * server render never is — so the dialog primitives are replaced with plain
 * elements, and an open dialog renders where it stands.
 */
vi.mock('@/components/ui', async (importOriginal) => {
  const ui = await importOriginal<typeof import('@/components/ui')>();
  type Props = { children?: ReactNode; open?: boolean };
  return {
    ...ui,
    Dialog: ({ open, children }: Props) =>
      open === true ? createElement(Fragment, null, children) : null,
    DialogContent: ({ children }: Props) => createElement('div', { role: 'dialog' }, children),
    DialogTitle: ({ children }: Props) => createElement('h2', null, children),
    DialogDescription: ({ children }: Props) => createElement('p', null, children),
  };
});

const { Toaster } = await import('@/components/ui');
const { AdminScreen } = await import('./admin-screen');
const { OrganizationsTab } = await import('./admin-organizations');
const { GrantsTab } = await import('./admin-grants');
const { PromoCodesTab, CreatePromoCodeDialog } = await import('./admin-promo-codes');
const { GrantDialog } = await import('./admin-grant-dialogs');
const { AddAdminForm, AdminsTab, addAdmin, removalCopy, removeAdmin } =
  await import('./admin-admins');
const { adminPageState } = await import('./admin-screen');
const { OverviewTab } = await import('./admin-overview');
const { UsersTab } = await import('./admin-users');
const { AdminOrganizationScreen } = await import('./admin-organization-screen');
const { AdminUserScreen } = await import('./admin-user-screen');
const { ApiError } = await import('@/lib/api');

function render(element: ReactNode): string {
  return renderToStaticMarkup(createElement(Toaster, null, element));
}

beforeEach(() => {
  viewer.admin = false;
  viewer.query = '';
  served.paths = [];
  served.answers = new Map();
  served.errors = new Map();
  api.posts = [];
  api.answer = () => Promise.resolve(undefined);
});

describe('the admin page, for somebody who is not an admin', () => {
  it('is the 404 an unknown address is, and asks the API nothing', () => {
    let thrown: unknown = null;
    try {
      render(createElement(AdminScreen));
    } catch (cause) {
      thrown = cause;
    }

    expect((thrown as { digest?: string } | null)?.digest).toBe('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(served.paths).toEqual([]);
  });
});

describe('the admin page, for an admin', () => {
  it('opens on the overview, and asks for the totals and nothing else', () => {
    viewer.admin = true;
    const html = render(createElement(AdminScreen));

    expect(html).toContain('>Admin<');
    for (const tab of ['Overview', 'Organisations', 'Users', 'Grants', 'Promo codes', 'Admins']) {
      expect(html).toContain(`>${tab}<`);
    }
    // Said up front: the customer can read what is done here, and nothing of
    // what they keep is shown but counts.
    expect(html).toContain('audit log as xecret support, with the reason you give');
    expect(html).toContain('Your own address is not shown to them.');
    expect(html).toContain('you see counts only');
    expect(html).toContain('looking leaves no trace there');
    expect(served.paths).toEqual(['/api/admin/overview']);
  });

  it('opens on the tab the address names, and on the overview for one it does not have', () => {
    viewer.admin = true;
    viewer.query = 'tab=users';
    render(createElement(AdminScreen));
    expect(served.paths).toEqual(['/api/admin/users']);

    served.paths = [];
    viewer.query = 'tab=organizations';
    render(createElement(AdminScreen));
    // No search yet, and so the whole list.
    expect(served.paths).toEqual([null, '/api/admin/organizations']);

    served.paths = [];
    viewer.query = 'tab=billing';
    render(createElement(AdminScreen));
    expect(served.paths).toEqual(['/api/admin/overview']);
  });
});

describe('the Overview tab', () => {
  it('shows every total and the recent sign-ups', () => {
    served.answers.set('/api/admin/overview', {
      totals: { users: 1234, organizations: 56, projects: 78, environments: 210, secrets: 4321 },
      signups: { last7Days: 9, last30Days: 41 },
    });
    const html = render(createElement(OverviewTab));

    for (const label of ['Users', 'Organisations', 'Projects', 'Environments', 'Secrets']) {
      expect(html).toContain(`>${label}<`);
    }
    for (const figure of ['1,234', '>56<', '>78<', '>210<', '4,321', '>9<', '>41<']) {
      expect(html).toContain(figure);
    }
    expect(html).toContain('Last 7 days');
    expect(html).toContain('Last 30 days');
    expect(html).toContain('never sent to this page');
  });
});

function organization(over: Partial<AdminOrganizationPayload> = {}): AdminOrganizationPayload {
  return {
    id: 'org-1',
    name: 'Acme',
    slug: 'acme',
    role: 'owner',
    createdAt: '2026-01-02T00:00:00.000Z',
    plan: 'free',
    status: 'active',
    interval: null,
    managedBy: 'none',
    seats: { billed: 1, limit: 3 },
    grant: null,
    billedByDodo: false,
    awaitingActivation: false,
    ownerEmails: ['ada@example.com'],
    counts: { members: 4, pendingInvitations: 1, projects: 2, environments: 6, secrets: 37 },
    ...over,
  };
}

const SEARCH = '/api/admin/organizations?q=ada%40example.com';

describe('the Organisations tab', () => {
  function search(organizations: AdminOrganizationPayload[]): string {
    served.answers.set(SEARCH, { organizations });
    return render(
      createElement(OrganizationsTab, { query: 'ada@example.com', onSearch: () => {} }),
    );
  }

  it('searches by the address or slug it was given', () => {
    search([organization()]);
    expect(served.paths).toEqual([SEARCH]);
  });

  it('offers a free plan to an organisation on Free, and names the searched-for person’s role', () => {
    const html = search([organization()]);

    expect(html).toContain('Acme');
    expect(html).toContain('their role: Owner');
    expect(html).toContain('Give a free plan');
    expect(html).not.toContain('End it');
  });

  it('offers to change or end a free plan it already has, and says until when', () => {
    const html = search([
      organization({
        plan: 'team',
        managedBy: 'support',
        interval: 'yearly',
        grant: { endsAt: null, note: 'Launch partner' },
      }),
    ]);

    expect(html).toContain('Team');
    expect(html).toContain('free with no end date');
    expect(html).toContain('Launch partner');
    expect(html).toContain('Change the free plan');
    expect(html).toContain('aria-label="End Acme’s free plan"');
  });

  it('says when Dodo bills it, before anybody opens the grant dialog', () => {
    const html = search([
      organization({ plan: 'pro', managedBy: 'checkout', interval: 'monthly', billedByDodo: true }),
    ]);

    expect(html).toContain('Paid at checkout · monthly');
  });

  it('says plainly when nothing matched', () => {
    const html = search([]);
    expect(html).toContain('Nothing found for “ada@example.com”');
  });

  it('opens each result’s own page, and says who owns it and how much is in it', () => {
    const html = search([organization({ ownerEmails: ['ada@example.com', 'bob@example.com'] })]);
    expect(html).toContain('href="/app/admin/organizations/org-1"');
    expect(html).toContain('Owner: ada@example.com and 1 more');
    expect(html).toContain('37 secrets');
    // A search is shown in place of the list, with the way back to it.
    expect(html).toContain('Show every organisation');
    expect(served.paths).not.toContain('/api/admin/organizations');
  });

  it('lists every organisation newest first, with counts, and a way to the next page', () => {
    served.answers.set('/api/admin/organizations', {
      organizations: [
        organization({ plan: 'team', managedBy: 'support', grant: { endsAt: null, note: null } }),
        organization({ id: 'org-2', name: 'Zebra', slug: 'zebra', ownerEmails: [] }),
      ],
      nextCursor: 'next-page',
    });
    const html = render(createElement(OrganizationsTab, { query: null, onSearch: () => {} }));

    expect(served.paths).toEqual([null, '/api/admin/organizations']);
    // The search stays, above the list.
    expect(html).toContain('Find an organisation');
    expect(html.indexOf('Acme')).toBeLessThan(html.indexOf('Zebra'));
    expect(html).toContain('href="/app/admin/organizations/org-1"');
    expect(html).toContain('href="/app/admin/organizations/org-2"');
    expect(html).toContain('ada@example.com');
    expect(html).toContain('No owner');
    expect(html).toContain('Team · free');
    for (const heading of ['Owner', 'Plan', 'Members', 'Projects', 'Environments', 'Secrets']) {
      expect(html).toContain(`>${heading}<`);
    }
    expect(html).toContain('>Created<');
    expect(html).toContain('>37<');
    expect(html).toContain('Load more');
  });

  it('says when the list has been read to its end', () => {
    served.answers.set('/api/admin/organizations', {
      organizations: [organization()],
      nextCursor: null,
    });
    const html = render(createElement(OrganizationsTab, { query: null, onSearch: () => {} }));
    expect(html).not.toContain('Load more');
    expect(html).toContain('That is every one of the organisations.');
  });
});

/* ── The Users tab ─────────────────────────────────────────────────────────── */

function account(over: Partial<AdminAccountPayload> = {}): AdminAccountPayload {
  return {
    id: 'user-1',
    email: 'ada@example.com',
    displayName: 'Ada Lovelace',
    emailVerified: true,
    signedUpAt: '2026-10-01T00:00:00.000Z',
    lastSignInAt: '2026-11-20T00:00:00.000Z',
    lastSignInMethod: 'passkey',
    organizationCount: 2,
    ...over,
  };
}

describe('the Users tab', () => {
  it('lists every account newest first: who, when they signed up and in, how, and in how many organisations', () => {
    served.answers.set('/api/admin/users', {
      users: [
        account(),
        account({
          id: 'user-2',
          email: 'bob@example.com',
          displayName: null,
          emailVerified: false,
          lastSignInAt: null,
          lastSignInMethod: null,
          organizationCount: 0,
        }),
      ],
      nextCursor: 'next-page',
    });
    const html = render(createElement(UsersTab, { query: null, onSearch: () => {} }));

    expect(served.paths).toEqual(['/api/admin/users']);
    expect(html).toContain('Find an account');
    expect(html.indexOf('ada@example.com')).toBeLessThan(html.indexOf('bob@example.com'));
    expect(html).toContain('href="/app/admin/users/user-1"');
    expect(html).toContain('href="/app/admin/users/user-2"');
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('>Verified<');
    expect(html).toContain('>Not verified<');
    expect(html).toContain('Passkey');
    expect(html).toContain('>Never<');
    expect(html).toContain('Load more');
  });

  it('asks for the accounts whose address contains what was searched for', () => {
    served.answers.set('/api/admin/users?q=example.org', { users: [], nextCursor: null });
    const html = render(createElement(UsersTab, { query: 'example.org', onSearch: () => {} }));

    expect(served.paths).toEqual(['/api/admin/users?q=example.org']);
    expect(html).toContain('No address contains “example.org”');
    expect(html).toContain('Show every account');
  });
});

/* ── One organisation, one account ─────────────────────────────────────────── */

function notFoundOf(element: ReactNode): string | undefined {
  try {
    render(element);
  } catch (cause) {
    return (cause as { digest?: string }).digest;
  }
  return undefined;
}

const NOT_FOUND = new ApiError({
  code: 'not_found',
  message: 'Not found.',
  status: 404,
  requestId: 'req-404',
});

describe('an organisation’s page', () => {
  const DETAIL = '/api/admin/organizations/org-1';

  it('is the 404 an unknown address is to somebody who is not an admin, and asks nothing', () => {
    expect(notFoundOf(createElement(AdminOrganizationScreen, { orgId: 'org-1' }))).toBe(
      'NEXT_HTTP_ERROR_FALLBACK;404',
    );
    expect(served.paths).toEqual([]);
  });

  it('shows the plan, the counts and the members — each opening the account’s page — and the grant actions', () => {
    viewer.admin = true;
    served.answers.set(DETAIL, {
      organization: organization({
        plan: 'team',
        managedBy: 'support',
        grant: { endsAt: null, note: 'Launch partner' },
      }),
      members: [
        {
          userId: 'user-1',
          email: 'ada@example.com',
          displayName: 'Ada Lovelace',
          role: 'owner',
          joinedAt: '2026-01-02T00:00:00.000Z',
        },
        {
          userId: 'user-2',
          email: 'bob@example.com',
          displayName: null,
          role: 'developer',
          joinedAt: '2026-02-02T00:00:00.000Z',
        },
      ],
    });
    const html = render(createElement(AdminOrganizationScreen, { orgId: 'org-1' }));

    expect(served.paths).toEqual([DETAIL]);
    expect(html).toContain('href="/app/admin?tab=organizations"');
    expect(html).toContain('All organisations');
    expect(html).toContain('>Acme<');
    expect(html).toContain('owned by ada@example.com');
    for (const label of ['Members', 'Pending invitations', 'Projects', 'Environments', 'Secrets']) {
      expect(html).toContain(`>${label}<`);
    }
    expect(html).toContain('>37<');
    expect(html).toContain('Counts only.');
    expect(html).toContain('Launch partner');
    expect(html).toContain('href="/app/admin/users/user-1"');
    expect(html).toContain('href="/app/admin/users/user-2"');
    expect(html).toContain('>Owner<');
    expect(html).toContain('>Developer<');
    expect(html).toContain('Change the free plan');
    expect(html).toContain('aria-label="End Acme’s free plan"');
  });

  it('offers a free plan to an organisation on Free, from its own page', () => {
    viewer.admin = true;
    served.answers.set(DETAIL, { organization: organization(), members: [] });
    const html = render(createElement(AdminOrganizationScreen, { orgId: 'org-1' }));
    expect(html).toContain('Give a free plan');
    expect(html).not.toContain('End it');
  });

  it('says when there is no such organisation — or none any more', () => {
    viewer.admin = true;
    served.errors.set(DETAIL, NOT_FOUND);
    const html = render(createElement(AdminOrganizationScreen, { orgId: 'org-1' }));
    expect(html).toContain('No such organisation');
    expect(html).toContain('href="/app/admin?tab=organizations"');
  });
});

describe('an account’s page', () => {
  const DETAIL = '/api/admin/users/user-1';

  it('is the 404 an unknown address is to somebody who is not an admin, and asks nothing', () => {
    expect(notFoundOf(createElement(AdminUserScreen, { userId: 'user-1' }))).toBe(
      'NEXT_HTTP_ERROR_FALLBACK;404',
    );
    expect(served.paths).toEqual([]);
  });

  it('shows the account and its organisations, each opening the organisation’s page', () => {
    viewer.admin = true;
    served.answers.set(DETAIL, {
      user: account(),
      organizations: [
        {
          id: 'org-1',
          name: 'Acme',
          slug: 'acme',
          role: 'owner',
          joinedAt: '2026-01-02T00:00:00Z',
        },
      ],
    });
    const html = render(createElement(AdminUserScreen, { userId: 'user-1' }));

    expect(served.paths).toEqual([DETAIL]);
    expect(html).toContain('href="/app/admin?tab=users"');
    expect(html).toContain('All users');
    expect(html).toContain('ada@example.com');
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('>Verified<');
    expect(html).toContain('Passkey');
    expect(html).toContain('href="/app/admin/organizations/org-1"');
    expect(html).toContain('>Owner<');
  });

  it('says when there is no such account — or none any more', () => {
    viewer.admin = true;
    served.errors.set(DETAIL, NOT_FOUND);
    const html = render(createElement(AdminUserScreen, { userId: 'user-1' }));
    expect(html).toContain('No such account');
    expect(html).toContain('href="/app/admin?tab=users"');
  });
});

describe('the grant dialog', () => {
  const target = (over: Partial<GrantTarget> = {}): GrantTarget => ({
    id: 'org-1',
    name: 'Acme',
    slug: 'acme',
    plan: 'free',
    seatLimit: 3,
    grant: null,
    billedByDodo: false,
    awaitingActivation: false,
    ...over,
  });

  function dialog(over: Partial<GrantTarget> = {}): string {
    return render(
      createElement(GrantDialog, {
        target: target(over),
        open: true,
        onOpenChange: () => {},
        onGranted: () => {},
      }),
    );
  }

  it('gives a plan to an organisation Dodo does not bill, with nothing to tick', () => {
    const html = dialog();

    expect(html).toContain('Give Acme a free plan');
    expect(html).toContain('No end date');
    expect(html).toContain('Reason');
    expect(html).toContain('Give Pro free');
    expect(html).not.toContain('Dodo subscription');
  });

  it('asks, on its own, before taking an organisation off a Dodo subscription — and says what is left', () => {
    const html = dialog({ plan: 'pro', billedByDodo: true });

    expect(html).toContain('Acme pays through Dodo');
    expect(html).toContain('keeps billing the card at Dodo until somebody cancels it there');
    expect(html).toContain('Take Acme off its Dodo subscription');
    // Unticked by default, and nothing can be sent until it is ticked.
    expect(html).toMatch(/role="checkbox" aria-checked="false"/);
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""/);
  });

  it('asks the same of a paid checkout that is still waiting to activate', () => {
    const html = dialog({ awaitingActivation: true });
    expect(html).toContain('A checkout Acme paid for is waiting to activate');
  });

  it('opens on the plan and the end a grant already has', () => {
    const html = dialog({
      plan: 'team',
      grant: { endsAt: new Date(2027, 2, 1).toISOString(), note: null },
    });

    expect(html).toContain('Change Acme’s free plan');
    expect(html).toMatch(/aria-checked="true"[^>]*>Team</);
    expect(html).toContain('value="2027-03-01"');
  });
});

describe('the Grants tab', () => {
  const GRANTS: AdminGrantPayload[] = [
    {
      orgId: 'org-1',
      orgName: 'Acme',
      orgSlug: 'acme',
      plan: 'team',
      seatLimit: 10,
      endsAt: '2026-12-01T00:00:00.000Z',
      note: 'Launch partner',
    },
    {
      orgId: 'org-2',
      orgName: 'Zebra',
      orgSlug: 'zebra',
      plan: 'enterprise',
      seatLimit: 50,
      endsAt: null,
      note: null,
    },
  ];

  it('lists every free plan in force, in the order the server sends — soonest to end first', () => {
    served.answers.set('/api/admin/grants', { grants: GRANTS });
    const html = render(createElement(GrantsTab));

    expect(html.indexOf('Acme')).toBeLessThan(html.indexOf('Zebra'));
    expect(html).toContain('Launch partner');
    expect(html).toContain('No end date');
    expect(html).toContain('aria-label="Change Zebra’s free plan"');
    expect(html).toContain('aria-label="End Acme’s free plan"');
  });

  it('says when there are none', () => {
    served.answers.set('/api/admin/grants', { grants: [] });
    expect(render(createElement(GrantsTab))).toContain('No organisation has a free plan');
  });
});

function code(over: Partial<AdminPromoCodePayload> = {}): AdminPromoCodePayload {
  return {
    id: 'code-1',
    code: 'TEAM30',
    kind: 'grant',
    summary: 'Team free for 30 days',
    description: 'Product Hunt',
    grant: { plan: 'team', days: 30, seats: null },
    discount: null,
    allowedEmails: null,
    maxRedemptions: 100,
    redemptions: 7,
    checkoutsStarted: 0,
    expiresAt: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    revokedAt: null,
    state: 'active',
    ...over,
  };
}

const HALF_OFF = code({
  id: 'code-2',
  code: 'HALFOFF',
  kind: 'discount',
  summary: '50% off Pro and Team for 3 months',
  description: null,
  grant: null,
  discount: {
    type: 'percentage',
    value: 50,
    currency: null,
    cycles: 3,
    plans: ['pro', 'team'],
    mode: 'test_mode',
  },
  maxRedemptions: null,
  redemptions: 0,
  checkoutsStarted: 4,
});

describe('the Promo codes tab', () => {
  function tab(codes: AdminPromoCodePayload[], mode: 'test_mode' | 'live_mode' | null): string {
    served.answers.set('/api/admin/promo-codes', {
      codes,
      billing: { enabled: mode !== null, mode },
    });
    return render(createElement(PromoCodesTab));
  }

  it('lists each code with what it gives, who may use it, how often it was used and its state', () => {
    const html = tab(
      [
        code({ allowedEmails: ['ada@example.com', 'bob@example.com'] }),
        code({ id: 'code-3', code: 'GONE', state: 'revoked', revokedAt: '2026-11-05T00:00:00Z' }),
        code({ id: 'code-4', code: 'FULL', state: 'used-up', redemptions: 100 }),
        code({ id: 'code-5', code: 'OLD', state: 'expired' }),
      ],
      'live_mode',
    );

    expect(html).toContain('Team free for 30 days');
    expect(html).toContain('Product Hunt');
    expect(html).toContain('Only ada@example.com and 1 other');
    expect(html).toContain('7 of 100');
    for (const label of ['Active', 'Revoked', 'Used up', 'Expired']) expect(html).toContain(label);
    // Only a code still in force can be revoked.
    expect(html).toContain('aria-label="Revoke TEAM30"');
    expect(html).not.toContain('aria-label="Revoke GONE"');
    expect(html).not.toContain('aria-label="Revoke FULL"');
    expect(html).not.toContain('aria-label="Revoke OLD"');
  });

  it('flags a discount made in the other Dodo mode, which applies to nothing here', () => {
    const html = tab([HALF_OFF], 'live_mode');

    expect(html).toContain('Test mode');
    expect(html).toContain(
      'Made in Dodo’s test mode; this deployment is live, so it applies to nothing.',
    );
    // A discount's uses are Dodo's to count; this side counts checkouts.
    expect(html).toContain('4 checkouts started');
  });

  it('does not flag one made in the mode the deployment is in', () => {
    const html = tab([HALF_OFF], 'test_mode');
    expect(html).not.toContain('applies to nothing');
  });

  it('says where payments are not configured at all', () => {
    expect(tab([], null)).toContain('Not configured');
    expect(tab([], 'live_mode')).toContain('No promo codes yet');
  });
});

describe('a new promo code', () => {
  function dialog(mode: 'test_mode' | 'live_mode' | null): string {
    return render(
      createElement(CreatePromoCodeDialog, {
        open: true,
        onOpenChange: () => {},
        payments: { enabled: mode !== null, mode },
        onCreated: () => {},
      }),
    );
  }

  it('offers both kinds where payments are configured', () => {
    const html = dialog('live_mode');

    expect(html).toContain('Free plan');
    expect(html).toContain('Checkout discount');
    expect(html).toContain('Leave it empty for a random one.');
    expect(html).toContain('Leave it empty to let anybody with the code use it.');
  });

  it('offers only free-plan codes where there is no checkout for a discount to come off', () => {
    const html = dialog(null);

    expect(html).toContain('Free-plan codes only');
    expect(html).not.toContain('Checkout discount');
  });
});

/* ── The Admins tab ────────────────────────────────────────────────────────── */

function adminUser(over: Partial<AdminUserPayload> = {}): AdminUserPayload {
  return {
    userId: 'user-1',
    email: 'ada@example.com',
    displayName: 'Ada Lovelace',
    addedAt: '2026-11-01T00:00:00.000Z',
    addedByEmail: null,
    you: true,
    ...over,
  };
}

const BOB = adminUser({
  userId: 'user-2',
  email: 'bob@example.com',
  displayName: null,
  addedAt: '2026-11-05T00:00:00.000Z',
  addedByEmail: 'ada@example.com',
  you: false,
});

const NO_ACCOUNT =
  'No xecret account uses that address. Ask them to sign in to xecret once, then add them.';
const LAST_ADMIN = 'There must always be at least one admin. Add another before removing this one.';

/** The server's 409 for an address it will not make an admin, with the problem on `email`. */
function refusedOn(message: string) {
  return new ApiError({
    code: 'conflict',
    message,
    status: 409,
    requestId: 'req-add-1',
    fields: [{ field: 'email', message }],
  });
}

describe('the Admins tab', () => {
  function tab(admins: AdminUserPayload[]): string {
    served.answers.set('/api/admin/admins', { admins });
    return render(createElement(AdminsTab));
  }

  it('lists every admin: who, which one is you, and who added them, when', () => {
    const html = tab([adminUser(), BOB]);

    expect(served.paths).toContain('/api/admin/admins');
    // Longest-serving first, as the server answers.
    expect(html.indexOf('Ada Lovelace')).toBeLessThan(html.indexOf('bob@example.com'));
    expect(html).toContain('ada@example.com');
    expect(html.match(/>You</g)).toHaveLength(1);
    // An operator at a shell, or an admin whose account is gone, has no address to name.
    expect(html).toContain('by an operator');
    expect(html).toContain('by ada@example.com');
    expect(html).toContain('aria-label="Remove yourself as an admin"');
    expect(html).toContain('aria-label="Remove bob@example.com"');
    // Said before anybody adds or removes anyone.
    expect(html).toContain('Every admin is emailed when this list');
    expect(html).toContain('Add an admin');
  });

  it('does not offer to remove the only admin, and says why', () => {
    const html = tab([adminUser()]);

    expect(html).not.toContain('>Remove<');
    expect(html).toContain('The only admin cannot be removed');
  });
});

describe('adding an admin', () => {
  function form(problem: string | null, error: unknown): string {
    return render(
      createElement(AddAdminForm, {
        email: 'someone@example.com',
        onEmailChange: () => {},
        problem,
        error,
        busy: false,
        onCancel: () => {},
        onSubmit: () => {},
      }),
    );
  }

  it('sends the address and answers with the new admin', async () => {
    api.answer = () => Promise.resolve({ admin: BOB });
    const outcome = await addAdmin('  bob@example.com ');

    expect(api.posts).toEqual([{ path: '/api/admin/admins', body: { email: 'bob@example.com' } }]);
    expect(outcome).toEqual({ ok: true, admin: BOB });
  });

  it('says the server’s refusal of the address beside the field', async () => {
    api.answer = () => Promise.reject(refusedOn(NO_ACCOUNT));
    const outcome = await addAdmin('nobody@example.com');
    expect(outcome).toEqual({ ok: false, problem: NO_ACCOUNT, error: null });

    const html = form(NO_ACCOUNT, null);
    // In the field's own error, which the input is described by and marked with.
    const said = /<p id="([^"]+-error)" class="text-danger-text[^"]*">([^<]+)<\/p>/.exec(html);
    expect(said?.[2]).toBe(NO_ACCOUNT);
    expect(html).toContain(`aria-describedby="${said?.[1]}`);
    expect(html).toContain('aria-invalid="true"');
    expect(html).not.toContain('Nobody was added');
    expect(html).toContain('Every admin is emailed when this list changes.');
  });

  it('keeps any other failure for the form, with its request id', async () => {
    const outage = new ApiError({
      code: 'internal_error',
      message: 'Something went wrong. Please try again.',
      status: 500,
      requestId: 'req-add-2',
    });
    api.answer = () => Promise.reject(outage);
    expect(await addAdmin('bob@example.com')).toEqual({ ok: false, problem: null, error: outage });

    const html = form(null, outage);
    expect(html).toContain('Nobody was added');
    expect(html).toContain('req-add-2');
  });

  it('asks nothing of the server for something that is not an address', async () => {
    expect(await addAdmin('bob')).toEqual({
      ok: false,
      problem: 'Enter the address they sign in to xecret with.',
      error: null,
    });
    // Including one with an "s" in it, which is an address like any other.
    api.answer = () => Promise.resolve({ admin: BOB });
    expect((await addAdmin('sam@example.com')).ok).toBe(true);
    expect(api.posts.map((post) => post.body)).toEqual([{ email: 'sam@example.com' }]);
  });
});

describe('removing an admin', () => {
  function effects() {
    const calls: string[] = [];
    return {
      calls,
      refresh: async () => {
        calls.push('refresh');
      },
      navigate: (href: string) => calls.push(`navigate ${href}`),
      reload: () => calls.push('reload'),
      notify: (title: string) => calls.push(`notify ${title}`),
    };
  }

  it('removes somebody else, and re-reads the list', async () => {
    const after = effects();
    await removeAdmin(BOB, after);

    expect(api.posts).toEqual([{ path: '/api/admin/admins/user-2/remove', body: undefined }]);
    expect(after.calls).toEqual(['notify bob@example.com is no longer an admin', 'reload']);
  });

  it('throws the server’s refusal of the last admin, for the dialog to say, and does nothing else', async () => {
    api.answer = () =>
      Promise.reject(
        new ApiError({ code: 'conflict', message: LAST_ADMIN, status: 409, requestId: 'req-rm-1' }),
      );
    const after = effects();

    await expect(removeAdmin(BOB, after)).rejects.toThrow(LAST_ADMIN);
    expect(after.calls).toEqual([]);
  });

  it('removing yourself re-reads the session, then leaves for /app', async () => {
    const after = effects();
    await removeAdmin(adminUser(), after);

    expect(api.posts).toEqual([{ path: '/api/admin/admins/user-1/remove', body: undefined }]);
    // The session first — it draws the account menu's "Admin" — then away.
    expect(after.calls).toEqual(['notify You are no longer an admin', 'refresh', 'navigate /app']);
  });

  it('warns, before you remove yourself, that the page goes with it', () => {
    const self = removalCopy(adminUser());
    expect(self.title).toBe('Remove yourself as an admin?');
    expect(self.description).toContain('You lose this page the moment it is done');
    expect(self.description).toContain('Every admin is emailed about it.');
    expect(self.confirmLabel).toBe('Remove myself');

    const other = removalCopy(BOB);
    expect(other.title).toBe('Remove bob@example.com as an admin?');
    expect(other.description).toContain('Every admin, them included, is emailed about it.');
    expect(other.confirmLabel).toBe('Remove');
  });
});

describe('the page, for somebody who stops being an admin while it is open', () => {
  it('says so, rather than turning into the 404 a stranger gets', () => {
    expect(adminPageState(true, false)).toBe('admin');
    expect(adminPageState(true, true)).toBe('admin');
    expect(adminPageState(false, true)).toBe('left');
    expect(adminPageState(false, false)).toBe('not-found');
  });
});

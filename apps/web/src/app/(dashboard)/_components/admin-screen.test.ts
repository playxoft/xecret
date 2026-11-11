import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, Fragment } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
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

const viewer = vi.hoisted(() => ({ admin: false }));

vi.mock('./session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session')>()),
  useSession: () => ({ admin: viewer.admin, refresh: async () => {} }),
}));

/** The tab asks for the router; nothing here navigates through it. `notFound` stays real. */
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ replace: () => {}, push: () => {} }),
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
}));

vi.mock('../_lib/use-api-resource', () => ({
  useApiResource: (path: string | null) => {
    served.paths.push(path);
    const data = path === null ? null : (served.answers.get(path) ?? null);
    return { data, error: null, loading: false, reload: async () => {} };
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
const { ApiError } = await import('@/lib/api');

function render(element: ReactNode): string {
  return renderToStaticMarkup(createElement(Toaster, null, element));
}

beforeEach(() => {
  viewer.admin = false;
  served.paths = [];
  served.answers = new Map();
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
  it('opens on finding an organisation, and asks nothing until something is searched for', () => {
    viewer.admin = true;
    const html = render(createElement(AdminScreen));

    expect(html).toContain('>Admin<');
    expect(html).toContain('>Organisations<');
    expect(html).toContain('>Grants<');
    expect(html).toContain('>Promo codes<');
    expect(html).toContain('>Admins<');
    expect(html).toContain('Find an organisation');
    // Said up front: the customer can read what is done here.
    expect(html).toContain('audit log as xecret support, with the reason you give');
    expect(html).toContain('Your own address is not shown to them.');
    expect(served.paths).toEqual([null]);
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

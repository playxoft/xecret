import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AuditRecord } from '@xecret/core/audit';
import { FREE_SEAT_LIMIT } from '@xecret/core/entitlements';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '@xecret/db/testing';
import type { TestDatabase } from '@xecret/db/testing';
import { createPromoCode, findPromoCodeById, findSubscription } from '@xecret/db/repositories';
import type { NewPromoCode, PromoCodeRecord } from '@xecret/db/repositories';
import type { Principal } from './actor';
import type { BillingProvider } from './billing/client';
import { createLogger } from './logging';
import type { LogEntry, RequestLog } from './logging';

/**
 * The admin page's API and the owner's side of a promo code (migration 0035),
 * end to end against a real database, with Dodo stubbed at `billingProvider`
 * — **no request here reaches Dodo**.
 *
 * What is asserted first, for every admin route: that it does not exist for
 * anybody without a live `platform_admins` row and a verified session — a
 * signed-in stranger, the admin's own CLI token, an admin just removed,
 * everybody when the table is empty — and that such a request writes nothing.
 * Then who the admins are and how they change, what an admin's change leaves
 * in the customer's audit log, and that a code is only ever spent by the
 * checks that guard it.
 */

const ORIGIN = 'https://xecret.playxoft.com';
const ADMIN_EMAIL = 'ops@support.example.com';

const context = vi.hoisted(() => ({ workerContext: vi.fn(), createServiceContext: vi.fn() }));
const actor = vi.hoisted(() => ({
  authenticate: vi.fn(),
  assertCsrf: vi.fn(),
  isUnlocked: vi.fn(() => true),
}));
const auditSink = vi.hoisted(() => ({ write: vi.fn() }));
const logging = vi.hoisted(() => ({ createRequestLog: vi.fn() }));
const mail = vi.hoisted(() => ({
  sent: [] as { to: string; subject: string; text: string }[],
  /** Addresses whose delivery fails, as a provider's refusal would. */
  failFor: [] as string[],
}));
const dodo = vi.hoisted(() => ({
  createCheckoutSession: vi.fn(),
  changePlan: vi.fn(),
  previewPlanChange: vi.fn(),
  getSubscription: vi.fn(),
  createPortalSession: vi.fn(),
  ingestUsage: vi.fn(),
  cardExpiries: vi.fn(),
  createDiscount: vi.fn(),
  deleteDiscount: vi.fn(),
}));

vi.mock('./context', () => context);
vi.mock('./actor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./actor')>()),
  ...actor,
}));
vi.mock('./audit-sink', () => ({
  DatabaseAuditSink: class {
    write = auditSink.write;
  },
}));
vi.mock('./logging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./logging')>()),
  createRequestLog: logging.createRequestLog,
}));
vi.mock('./billing/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./billing/client')>()),
  billingProvider: (): BillingProvider => dodo as unknown as BillingProvider,
}));
// A mailer only where the deployment would have one — ZeptoMail configured.
vi.mock('./mail', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mail')>()),
  mailerFrom: (bindings: { ZEPTOMAIL_TOKEN?: string }) =>
    bindings.ZEPTOMAIL_TOKEN
      ? {
          send: async (message: { to: string; subject: string; text: string }) => {
            if (mail.failFor.includes(message.to)) throw new Error('mailbox unavailable');
            mail.sent.push(message);
          },
        }
      : null,
}));

const searchRoute = await import('@/app/api/admin/organizations/route');
const grantRoute = await import('@/app/api/admin/organizations/[orgId]/grant/route');
const endGrantRoute = await import('@/app/api/admin/organizations/[orgId]/grant/end/route');
const grantsRoute = await import('@/app/api/admin/grants/route');
const codesRoute = await import('@/app/api/admin/promo-codes/route');
const revokeRoute = await import('@/app/api/admin/promo-codes/[codeId]/revoke/route');
const previewRoute = await import('@/app/api/orgs/[orgSlug]/billing/promo-code/route');
const redeemRoute = await import('@/app/api/orgs/[orgSlug]/billing/promo-code/redeem/route');
const checkoutRoute = await import('@/app/api/orgs/[orgSlug]/billing/checkout/route');
const statusRoute = await import('@/app/api/orgs/[orgSlug]/billing/route');
const meRoute = await import('@/app/api/auth/me/route');
const adminsRoute = await import('@/app/api/admin/admins/route');
const removeAdminRoute = await import('@/app/api/admin/admins/[userId]/remove/route');
const { DodoApiError } = await import('./billing/client');

let t: TestDatabase;
let lines: LogEntry[] = [];
let audit: AuditRecord[] = [];
let deferred: Promise<unknown>[] = [];
let env: Record<string, unknown> = {};
let caller: Principal;
/** xecret's own admin: a user with a `platform_admins` row, in no organisation. */
let adminUser: { id: string; email: string };

const BILLING_ENV = {
  DODO_API_KEY: 'dodo-example-not-a-real-key',
  DODO_WEBHOOK_SECRET: `whsec_${btoa('example-not-a-real-key-32-bytes!')}`,
  DODO_ENVIRONMENT: 'test_mode',
  DODO_PRODUCT_PRO_MONTHLY: 'pdt_pro_m',
  DODO_PRODUCT_PRO_YEARLY: 'pdt_pro_y',
  DODO_PRODUCT_TEAM_MONTHLY: 'pdt_team_m',
  DODO_PRODUCT_TEAM_YEARLY: 'pdt_team_y',
  DODO_METER_SECRET_FETCH: 'secret_fetch_kilo',
};
const BASE_ENV = { XECRET_PUBLIC_URL: ORIGIN, XECRET_ENV: 'production' };
const MAIL_ENV = {
  ZEPTOMAIL_TOKEN: 'zepto-test-token',
  ZEPTOMAIL_FROM_ADDRESS: 'no-reply@example.com',
};

const DAY = 86_400_000;

beforeAll(async () => {
  t = await createTestDatabase();
  adminUser = await seedUser(ADMIN_EMAIL);
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  for (const fn of Object.values(dodo)) fn.mockReset();
  lines = [];
  audit = [];
  deferred = [];
  mail.sent = [];
  mail.failFor = [];
  env = { ...BASE_ENV, ...BILLING_ENV };
  // Whatever a test before did to the list, the main admin is one again.
  await makeAdmin(adminUser.id);

  logging.createRequestLog.mockImplementation((_env: unknown, base: Record<string, unknown>) =>
    createLogger({
      sink: { write: (entry) => lines.push(entry), flush: () => Promise.resolve() },
      minimum: 'debug',
      base,
    }),
  );
  context.workerContext.mockImplementation(async () => ({ env, ctx: { waitUntil: () => {} } }));
  context.createServiceContext.mockImplementation(
    async (
      request: Request,
      _worker: unknown,
      requestId: string,
      log: RequestLog,
      startedAt: number,
    ) => ({
      env,
      db: t.db,
      envelope: {},
      meta: {
        requestId,
        rayId: null,
        ipAddress: '203.0.113.5',
        userAgent: 'vitest',
        method: request.method,
        path: new URL(request.url).pathname,
        startedAt,
      },
      log: log.logger,
      bindLog: log.bind,
      waitUntil: (promise: Promise<unknown>) => void deferred.push(promise),
      settled: () => Promise.allSettled(deferred),
      dispose: () => {},
    }),
  );
  actor.authenticate.mockImplementation(async () => ({
    principal: caller,
    source: caller.kind === 'user' ? 'cookie' : 'bearer',
  }));
  actor.assertCsrf.mockReturnValue(undefined);
  actor.isUnlocked.mockReturnValue(true);
  auditSink.write.mockImplementation(async (events: AuditRecord[]) => {
    audit.push(...events);
  });
  caller = sessionOf(adminUser);
});

/* ── fixtures ─────────────────────────────────────────────────────────────── */

async function seedUser(email?: string, verified = true): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const address = email ?? `person-${id.slice(0, 8)}@example.com`;
  await t.pg.query(
    `insert into users (id, workos_user_id, email, email_verified) values ($1, $2, $3, $4)`,
    [id, `user_01${id.replaceAll('-', '').slice(0, 20)}`, address, verified],
  );
  return { id, email: address };
}

/** A `platform_admins` row, as `npm run admin` writes the first one. */
async function makeAdmin(userId: string, addedBy: string | null = null): Promise<void> {
  await t.pg.query(
    `insert into platform_admins (user_id, added_by) values ($1, $2) on conflict do nothing`,
    [userId, addedBy],
  );
}

function sessionOf(user: { id: string; email: string }, emailVerified = true): Principal {
  return {
    kind: 'user',
    sessionId: randomUUID(),
    user: { id: user.id, email: user.email, emailVerified, displayName: 'Person', avatarUrl: null },
    vaultUnlockedAt: new Date(),
    lastSeenAt: new Date(),
    vaultAutoLockMinutes: null,
    signIn: { method: 'password', ssoWorkosOrgId: null },
  };
}

function cliTokenOf(user: { id: string }): Principal {
  return {
    kind: 'cliToken',
    tokenId: randomUUID(),
    tokenName: 'laptop',
    userId: user.id,
    orgId: randomUUID(),
    signIn: { method: 'password', ssoWorkosOrgId: null },
  };
}

async function addMember(orgId: string, userId: string, role: string) {
  await t.pg.query(
    `insert into org_members (id, org_id, user_id, role, status) values ($1, $2, $3, $4, 'active')`,
    [randomUUID(), orgId, userId, role],
  );
}

/**
 * An organisation with its owner and its subscription row. Does not change
 * the caller — admin tests act as the admin, owner tests say so.
 */
async function seedOrg(
  subscription: Record<string, unknown> = {},
  owner?: { id: string; email: string },
): Promise<{ orgId: string; slug: string; owner: { id: string; email: string } }> {
  const person = owner ?? (await seedUser());
  const orgId = randomUUID();
  const slug = `acme-${orgId.slice(0, 8)}`;
  await t.pg.query(
    `insert into organizations (id, name, slug, created_by) values ($1, 'Acme', $2, $3)`,
    [orgId, slug, person.id],
  );
  // A subscription id is unique across organisations, and so is a customer.
  const row = { ...subscription };
  for (const column of ['dodo_subscription_id', 'dodo_customer_id'] as const) {
    if (typeof row[column] === 'string') row[column] = `${row[column]}-${orgId.slice(0, 8)}`;
  }
  const columns = ['org_id', ...Object.keys(row)];
  await t.pg.query(
    `insert into org_subscriptions (${columns.join(', ')})
     values (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
    [orgId, ...Object.values(row)],
  );
  await addMember(orgId, person.id, 'owner');
  return { orgId, slug, owner: person };
}

/** A Team subscription Dodo bills, activated by its webhook. */
const SUBSCRIBED = {
  plan: 'team',
  billing_interval: 'monthly',
  seats: 3,
  currency: 'USD',
  billing_country: 'US',
  dodo_customer_id: 'cus_example0001',
  dodo_subscription_id: 'sub_example0001',
  dodo_product_id: 'pdt_team_m',
  dodo_event_at: new Date(Date.now() - DAY),
  current_period_end: new Date(Date.now() + 20 * DAY),
};

/** A code nobody else in this file has: upper-case letters and digits. */
const freshCode = (prefix = 'T') =>
  `${prefix}${randomUUID().replaceAll('-', '').slice(0, 11).toUpperCase()}`;

type CodeOverrides = Partial<{
  code: string;
  allowedEmails: string[] | null;
  maxRedemptions: number | null;
  expiresAt: Date | null;
}>;

/** A free-plan code, written as the admin route writes one. */
async function grantCode(
  grant: { plan?: 'pro' | 'team' | 'enterprise'; days?: number | null; seats?: number | null } = {},
  overrides: CodeOverrides = {},
): Promise<PromoCodeRecord> {
  return createPromoCode(t.db, {
    code: freshCode('G'),
    description: null,
    allowedEmails: null,
    maxRedemptions: null,
    expiresAt: null,
    createdBy: adminUser.id,
    kind: 'grant',
    grantPlan: grant.plan ?? 'team',
    grantDays: grant.days === undefined ? 30 : grant.days,
    grantSeats: grant.seats ?? null,
    ...overrides,
  } as NewPromoCode);
}

/** A discount code, written as the admin route writes one after Dodo created it. */
async function discountCode(
  discount: { plans?: ('pro' | 'team')[]; mode?: 'test_mode' | 'live_mode' } = {},
  overrides: CodeOverrides = {},
): Promise<PromoCodeRecord> {
  return createPromoCode(t.db, {
    code: freshCode('D'),
    description: null,
    allowedEmails: null,
    maxRedemptions: null,
    expiresAt: null,
    createdBy: adminUser.id,
    kind: 'discount',
    discountType: 'percentage',
    discountAmount: 2_000,
    discountCurrency: null,
    discountCycles: 3,
    discountPlans: discount.plans ?? ['pro', 'team'],
    dodoDiscountId: `dsc_${randomUUID().slice(0, 12)}`,
    dodoMode: discount.mode ?? 'test_mode',
    ...overrides,
  } as NewPromoCode);
}

type Handler<P> = (request: Request, args?: { params?: Promise<P> }) => Promise<Response>;
type Answer = { status: number; body: Record<string, unknown> };

async function send<P>(
  handler: Handler<P>,
  method: string,
  path: string,
  params: P,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Answer> {
  const response = await handler(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve(params) },
  );
  await Promise.allSettled(deferred);
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

const search = (q: string) =>
  send(searchRoute.GET, 'GET', `/api/admin/organizations?q=${encodeURIComponent(q)}`, {});
const grant = (orgId: string, body: unknown) =>
  send(grantRoute.POST, 'POST', `/api/admin/organizations/${orgId}/grant`, { orgId }, body);
const endGrant = (orgId: string, body: unknown) =>
  send(endGrantRoute.POST, 'POST', `/api/admin/organizations/${orgId}/grant/end`, { orgId }, body);
const listGrants = () => send(grantsRoute.GET, 'GET', '/api/admin/grants', {});
const listCodes = () => send(codesRoute.GET, 'GET', '/api/admin/promo-codes', {});
const createCode = (body: unknown) =>
  send(codesRoute.POST, 'POST', '/api/admin/promo-codes', {}, body);
const revoke = (codeId: string) =>
  send(revokeRoute.POST, 'POST', `/api/admin/promo-codes/${codeId}/revoke`, { codeId });
const preview = (slug: string, code: string) =>
  send(
    previewRoute.POST,
    'POST',
    `/api/orgs/${slug}/billing/promo-code`,
    { orgSlug: slug },
    {
      code,
    },
  );
const redeem = (slug: string, code: string) =>
  send(
    redeemRoute.POST,
    'POST',
    `/api/orgs/${slug}/billing/promo-code/redeem`,
    { orgSlug: slug },
    { code },
  );
const checkout = (slug: string, body: unknown, key?: string) =>
  send(
    checkoutRoute.POST,
    'POST',
    `/api/orgs/${slug}/billing/checkout`,
    { orgSlug: slug },
    body,
    key === undefined ? {} : { 'idempotency-key': key },
  );
const billing = (slug: string) =>
  send(statusRoute.GET, 'GET', `/api/orgs/${slug}/billing`, { orgSlug: slug });
const me = () => send(meRoute.GET, 'GET', '/api/auth/me', {});
const listAdmins = () => send(adminsRoute.GET, 'GET', '/api/admin/admins', {});
const addAdmin = (email: string) =>
  send(adminsRoute.POST, 'POST', '/api/admin/admins', {}, { email });
const removeAdmin = (userId: string) =>
  send(removeAdminRoute.POST, 'POST', `/api/admin/admins/${userId}/remove`, { userId });

/** A grant body the schema accepts; the test overrides what it is about. */
const grantBody = (overrides: Record<string, unknown> = {}) => ({
  plan: 'team',
  seats: null,
  endsAt: new Date(Date.now() + 30 * DAY).toISOString(),
  reason: 'Design partner, ticket 4211',
  overDodo: false,
  ...overrides,
});

const grantCodeBody = (overrides: Record<string, unknown> = {}) => ({
  kind: 'grant',
  description: null,
  allowedEmails: null,
  maxRedemptions: null,
  expiresAt: null,
  grant: { plan: 'team', days: 30, seats: null },
  ...overrides,
});

const discountCodeBody = (
  discount: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
) => ({
  kind: 'discount',
  description: 'Launch week',
  allowedEmails: null,
  maxRedemptions: null,
  expiresAt: null,
  discount: {
    type: 'percentage',
    value: 50,
    currency: null,
    cycles: 3,
    plans: ['pro'],
    ...discount,
  },
  ...overrides,
});

async function planChangesOf(orgId: string) {
  const rows = await t.pg.query<{
    actor_type: string;
    actor_id: string | null;
    actor_label: string | null;
    outcome: string;
    metadata: Record<string, unknown>;
  }>(
    `select actor_type, actor_id, actor_label, outcome, metadata from audit_logs
     where org_id = $1 and action = 'plan.changed' order by created_at`,
    [orgId],
  );
  return rows.rows;
}

async function seatLimitOf(orgId: string): Promise<number> {
  const rows = await t.pg.query<{ seat_limit: number }>(
    `select seat_limit from organizations where id = $1`,
    [orgId],
  );
  return rows.rows[0]!.seat_limit;
}

async function count(sql: string, values: unknown[] = []): Promise<number> {
  const rows = await t.pg.query<{ n: number }>(`select count(*)::int as n from ${sql}`, values);
  return rows.rows[0]!.n;
}

const errorOf = (answer: Answer) => answer.body['error'] as { code: string; message: string };

/* ── who may ──────────────────────────────────────────────────────────────── */

/** A verified account nobody has made an admin — its address has no "s" (see the schema bug). */
const candidate = () => seedUser(`cand-${randomUUID().slice(0, 8)}@example.com`);

describe('who may reach the admin API', () => {
  /** Every admin route, with a body it would accept from an admin. */
  async function everyAdminRoute(
    orgId: string,
    codeId: string,
    otherAdminId: string,
  ): Promise<Answer[]> {
    const newcomer = await candidate();
    return [
      await search('acme'),
      await grant(orgId, grantBody()),
      await endGrant(orgId, { reason: 'Partnership ended' }),
      await listGrants(),
      await listCodes(),
      await createCode(grantCodeBody({ code: freshCode('X') })),
      await createCode(discountCodeBody({}, { code: freshCode('X') })),
      await revoke(codeId),
      await listAdmins(),
      await addAdmin(newcomer.email),
      await removeAdmin(otherAdminId),
    ];
  }

  const callers: [string, () => Promise<Principal>][] = [
    ['a signed-in person who is not an admin', async () => sessionOf(await seedUser())],
    ['the admin’s own session, its address not verified', async () => sessionOf(adminUser, false)],
    ['the admin’s own CLI token', async () => cliTokenOf(adminUser)],
    [
      'an admin just removed, while another remains',
      async () => {
        const remaining = await seedUser();
        await makeAdmin(remaining.id);
        await t.pg.query(`delete from platform_admins where user_id = $1`, [adminUser.id]);
        return sessionOf(adminUser);
      },
    ],
    [
      'an admin whose account was deleted',
      async () => {
        const gone = await seedUser();
        await makeAdmin(gone.id);
        await t.pg.query(`update users set deleted_at = now() where id = $1`, [gone.id]);
        return sessionOf(gone);
      },
    ],
    [
      'anybody, when there are no admins at all',
      async () => {
        await t.pg.query(`delete from platform_admins`);
        return sessionOf(adminUser);
      },
    ],
  ];

  for (const [who, arrange] of callers) {
    it(`answers ${who} 404 on every route, and writes nothing`, async () => {
      const { orgId } = await seedOrg();
      // A grant to end and a code to revoke, so a write would have something to do.
      const granted = await seedOrg({
        plan: 'team',
        billing_interval: 'yearly',
        seats: 3,
        grant_ends_at: new Date(Date.now() + 10 * DAY),
        grant_note: 'Granted by xecret support',
      });
      const code = await grantCode();
      const codesBefore = await count('promo_codes');
      // An admin to remove, so a removal would have somebody to act on.
      const other = await seedUser();
      await makeAdmin(other.id, adminUser.id);

      caller = await arrange();
      const adminsBefore = await count('platform_admins');
      const changesBefore = await count('platform_admin_changes');
      const answers = [
        ...(await everyAdminRoute(orgId, code.id, other.id)),
        await endGrant(granted.orgId, { reason: 'Partnership ended' }),
      ];

      for (const answer of answers) {
        expect(answer.status).toBe(404);
        expect(errorOf(answer).code).toBe('not_found');
      }
      expect(await findSubscription(t.db, orgId)).toMatchObject({
        plan: 'free',
        grantEndsAt: null,
      });
      expect(await findSubscription(t.db, granted.orgId)).toMatchObject({ plan: 'team' });
      expect(await count('promo_codes')).toBe(codesBefore);
      expect((await findPromoCodeById(t.db, code.id))?.revokedAt).toBeNull();
      expect(await planChangesOf(orgId)).toEqual([]);
      expect(await planChangesOf(granted.orgId)).toEqual([]);
      expect(await count('platform_admins')).toBe(adminsBefore);
      expect(await count('platform_admin_changes')).toBe(changesBefore);
      expect(dodo.createDiscount).not.toHaveBeenCalled();
      expect(dodo.deleteDiscount).not.toHaveBeenCalled();
      expect(mail.sent).toEqual([]);
      // Each refusal is a line somebody can see.
      expect(
        lines.filter((line) => line.level === 'warn' && /not an admin/.test(line.message)),
      ).toHaveLength(answers.length);
    });
  }

  it('answers an admin, from its very first request', async () => {
    expect((await listGrants()).status).toBe(200);
  });
});

describe('/api/auth/me', () => {
  it('says admin only to a verified session whose account has a row', async () => {
    caller = sessionOf(adminUser);
    expect((await me()).body['admin']).toBe(true);

    caller = sessionOf(adminUser, false);
    expect((await me()).body['admin']).toBe(false);

    caller = sessionOf(await seedUser());
    expect((await me()).body['admin']).toBe(false);

    // The admin's own token: a script never drives the admin page.
    caller = cliTokenOf(adminUser);
    const asToken = await me();
    expect(asToken.status).toBe(200);
    expect(asToken.body['admin']).toBe(false);

    // Removed: the menu stops offering the page on the next load.
    const remaining = await seedUser();
    await makeAdmin(remaining.id);
    await t.pg.query(`delete from platform_admins where user_id = $1`, [adminUser.id]);
    caller = sessionOf(adminUser);
    expect((await me()).body['admin']).toBe(false);
  });
});

/* ── the admins ───────────────────────────────────────────────────────────── */

describe('the admins', () => {
  /** The list as `npm run admin` leaves it: the main admin alone. */
  async function onlyTheMainAdmin(): Promise<void> {
    await t.pg.query(`delete from platform_admins where user_id <> $1`, [adminUser.id]);
  }

  async function changesFor(userId: string) {
    const rows = await t.pg.query<{
      action: string;
      email: string;
      by_user_id: string | null;
      by_label: string | null;
    }>(
      `select action, email, by_user_id, by_label from platform_admin_changes
       where user_id = $1 order by at`,
      [userId],
    );
    return rows.rows;
  }

  const isAdminRow = async (userId: string) =>
    (await count('platform_admins where user_id = $1', [userId])) === 1;

  const recipients = () => mail.sent.map((message) => message.to).sort();

  it('lists every admin, longest-serving first, with who added each and which is you', async () => {
    await onlyTheMainAdmin();
    const second = await seedUser();
    await makeAdmin(second.id, adminUser.id);

    const answer = await listAdmins();

    expect(answer.status).toBe(200);
    expect(answer.body['admins']).toEqual([
      {
        userId: adminUser.id,
        email: ADMIN_EMAIL,
        displayName: null,
        addedAt: expect.any(String),
        // The first admin was made at a shell: nobody added them.
        addedByEmail: null,
        you: true,
      },
      {
        userId: second.id,
        email: second.email,
        displayName: null,
        addedAt: expect.any(String),
        addedByEmail: ADMIN_EMAIL,
        you: false,
      },
    ]);

    caller = sessionOf(second);
    const theirs = (await listAdmins()).body['admins'] as { userId: string; you: boolean }[];
    expect(theirs.map((row) => [row.userId, row.you])).toEqual([
      [adminUser.id, false],
      [second.id, true],
    ]);
  });

  it('never lists an admin whose account was deleted', async () => {
    const gone = await seedUser();
    await makeAdmin(gone.id);
    await t.pg.query(`update users set deleted_at = now() where id = $1`, [gone.id]);
    const listed = (await listAdmins()).body['admins'] as { userId: string }[];
    expect(listed.some((row) => row.userId === gone.id)).toBe(false);
  });

  describe('adding one', () => {
    it('makes a verified account an admin by its address, in any case, and records who did', async () => {
      const newcomer = await candidate();

      const answer = await addAdmin(`  ${newcomer.email.toUpperCase()} `);

      expect(answer.status).toBe(201);
      expect(answer.body['admin']).toEqual({
        userId: newcomer.id,
        email: newcomer.email,
        displayName: null,
        addedAt: expect.any(String),
        addedByEmail: ADMIN_EMAIL,
        you: false,
      });
      const row = await t.pg.query<{ added_by: string }>(
        `select added_by from platform_admins where user_id = $1`,
        [newcomer.id],
      );
      expect(row.rows).toEqual([{ added_by: adminUser.id }]);
      expect(await changesFor(newcomer.id)).toEqual([
        { action: 'added', email: newcomer.email, by_user_id: adminUser.id, by_label: null },
      ]);
      expect(lines.find((line) => /added another admin/.test(line.message))).toMatchObject({
        adminUserId: adminUser.id,
        addedUserId: newcomer.id,
      });
    });

    it('lets the new admin in on their very next request', async () => {
      const newcomer = await candidate();
      expect((await addAdmin(newcomer.email)).status).toBe(201);

      caller = sessionOf(newcomer);
      expect((await listGrants()).status).toBe(200);
      expect((await me()).body['admin']).toBe(true);
    });

    it('refuses a look-alike address rather than folding it into somebody else’s account', async () => {
      const hex = randomUUID().slice(0, 8);
      const kelly = await seedUser(`kelly-${hex}@example.com`);
      // U+212A KELVIN SIGN lower-cases to "k" in Unicode, and `users.email` is citext.
      const answer = await addAdmin(`Kelly-${hex}@example.com`);
      expect(answer.status).toBe(409);
      expect(answer.body['error']).toMatchObject({ fields: [{ field: 'email' }] });
      expect(await isAdminRow(kelly.id)).toBe(false);

      // And the reverse: an account whose own address carries the look-alike
      // is not named by the plain one.
      const lookAlike = await seedUser(`Kate-${hex}@example.com`);
      expect((await addAdmin(`kate-${hex}@example.com`)).status).toBe(409);
      expect(await isAdminRow(lookAlike.id)).toBe(false);
    });

    it('refuses an address no live account uses, on the email field', async () => {
      const unknown = await addAdmin(`nobody-${randomUUID().slice(0, 8)}@example.com`);
      expect(unknown.status).toBe(409);
      expect(unknown.body['error']).toMatchObject({
        code: 'conflict',
        fields: [{ field: 'email' }],
      });
      expect(errorOf(unknown).message).toContain('No xecret account uses that address');

      const deleted = await candidate();
      await t.pg.query(`update users set deleted_at = now() where id = $1`, [deleted.id]);
      expect((await addAdmin(deleted.email)).status).toBe(409);
      expect(await isAdminRow(deleted.id)).toBe(false);
    });

    it('refuses an account whose address is not verified yet', async () => {
      const unverified = await seedUser(
        `unverified-${randomUUID().slice(0, 8)}@example.com`,
        false,
      );
      const answer = await addAdmin(unverified.email);
      expect(answer.status).toBe(409);
      expect(answer.body['error']).toMatchObject({ fields: [{ field: 'email' }] });
      expect(errorOf(answer).message).toContain('not verified');
      expect(await isAdminRow(unverified.id)).toBe(false);
      expect(await changesFor(unverified.id)).toEqual([]);
    });

    it('refuses one who is an admin already, and records nothing', async () => {
      const newcomer = await candidate();
      await addAdmin(newcomer.email);
      const again = await addAdmin(newcomer.email);
      expect(again.status).toBe(409);
      expect(again.body['error']).toMatchObject({ fields: [{ field: 'email' }] });
      expect(errorOf(again).message).toContain('admin already');
      expect(await changesFor(newcomer.id)).toHaveLength(1);
    });

    it('takes an address and nothing else', async () => {
      expect((await addAdmin('not an address')).status).toBe(422);
      const extra = await send(
        adminsRoute.POST,
        'POST',
        '/api/admin/admins',
        {},
        { email: (await candidate()).email, role: 'owner' },
      );
      expect(extra.status).toBe(422);
    });

    // The address pattern once lost its backslashes, and refused every address
    // with a lower-case "s" in it before the lookup.
    it('accepts an ordinary address with an "s" in it', async () => {
      const sam = await seedUser(`sam-${randomUUID().slice(0, 8)}@example.com`);
      expect((await addAdmin(sam.email)).status).toBe(201);
    });
  });

  describe('removing one', () => {
    it('removes an admin: their next request is a 404, and the change is recorded', async () => {
      const second = await seedUser();
      await makeAdmin(second.id, adminUser.id);

      const answer = await removeAdmin(second.id);

      expect(answer).toEqual({ status: 204, body: {} });
      expect(await isAdminRow(second.id)).toBe(false);
      expect(await changesFor(second.id)).toEqual([
        { action: 'removed', email: second.email, by_user_id: adminUser.id, by_label: null },
      ]);
      caller = sessionOf(second);
      expect((await listGrants()).status).toBe(404);
      expect((await me()).body['admin']).toBe(false);
    });

    it('never removes the last admin — a deleted account’s row does not count', async () => {
      await onlyTheMainAdmin();
      // A row whose account cannot sign in any more is nobody to fall back on.
      const ghost = await seedUser();
      await makeAdmin(ghost.id);
      await t.pg.query(`update users set deleted_at = now() where id = $1`, [ghost.id]);

      const answer = await removeAdmin(adminUser.id);

      expect(answer.status).toBe(409);
      expect(errorOf(answer).message).toContain('at least one admin');
      expect(await isAdminRow(adminUser.id)).toBe(true);
      expect((await changesFor(adminUser.id)).some((row) => row.action === 'removed')).toBe(false);
      expect((await listGrants()).status).toBe(200);
    });

    it('lets an admin step down while another remains', async () => {
      await onlyTheMainAdmin();
      const second = await seedUser();
      await makeAdmin(second.id);

      expect((await removeAdmin(adminUser.id)).status).toBe(204);

      expect(await isAdminRow(adminUser.id)).toBe(false);
      expect((await changesFor(adminUser.id)).at(-1)).toEqual({
        action: 'removed',
        email: ADMIN_EMAIL,
        by_user_id: adminUser.id,
        by_label: null,
      });
      expect((await listGrants()).status).toBe(404);
      caller = sessionOf(second);
      expect((await listGrants()).status).toBe(200);
    });

    it('answers 404 for an account that is not an admin, an unknown id, or a malformed one', async () => {
      const notAdmin = await seedUser();
      const changesBefore = await count('platform_admin_changes');
      for (const id of [notAdmin.id, randomUUID(), 'not-a-uuid']) {
        const answer = await removeAdmin(id);
        expect(answer.status, id).toBe(404);
        expect(errorOf(answer).code).toBe('not_found');
      }
      expect(await count('platform_admin_changes')).toBe(changesBefore);
    });
  });

  describe('telling the admins', () => {
    it('emails every admin, the new one included, when one is added', async () => {
      env = { ...env, ...MAIL_ENV };
      await onlyTheMainAdmin();
      const second = await seedUser();
      await makeAdmin(second.id);
      const newcomer = await candidate();

      expect((await addAdmin(newcomer.email)).status).toBe(201);

      expect(recipients()).toEqual([ADMIN_EMAIL, second.email, newcomer.email].sort());
      for (const message of mail.sent) {
        expect(message.subject).toBe('A new xecret admin was added');
        expect(message.text).toContain(
          `${newcomer.email} was made a xecret admin by ${ADMIN_EMAIL}.`,
        );
        expect(message.text).toContain(`${ORIGIN}/app/admin`);
      }
    });

    it('emails every remaining admin and the one removed', async () => {
      env = { ...env, ...MAIL_ENV };
      await onlyTheMainAdmin();
      const second = await seedUser();
      const third = await seedUser();
      await makeAdmin(second.id);
      await makeAdmin(third.id);

      expect((await removeAdmin(third.id)).status).toBe(204);

      expect(recipients()).toEqual([ADMIN_EMAIL, second.email, third.email].sort());
      for (const message of mail.sent) {
        expect(message.subject).toBe('A xecret admin was removed');
        expect(message.text).toContain(
          `${third.email} is no longer a xecret admin; ${ADMIN_EMAIL} removed them.`,
        );
      }
    });

    it('says an admin stepped down when they removed themselves', async () => {
      env = { ...env, ...MAIL_ENV };
      await onlyTheMainAdmin();
      const second = await seedUser();
      await makeAdmin(second.id);

      expect((await removeAdmin(adminUser.id)).status).toBe(204);

      expect(recipients()).toEqual([ADMIN_EMAIL, second.email].sort());
      expect(mail.sent[0]!.text).toContain(`${ADMIN_EMAIL} stepped down as a xecret admin.`);
    });

    it('keeps the change when a mail is not delivered, and logs it without the address', async () => {
      env = { ...env, ...MAIL_ENV };
      await onlyTheMainAdmin();
      const second = await seedUser();
      await makeAdmin(second.id);
      mail.failFor = [second.email];
      const newcomer = await candidate();

      expect((await addAdmin(newcomer.email)).status).toBe(201);

      expect(await isAdminRow(newcomer.id)).toBe(true);
      expect(recipients()).toEqual([ADMIN_EMAIL, newcomer.email].sort());
      const warning = lines.find((line) => /was not delivered/.test(line.message));
      expect(warning?.level).toBe('warn');
      expect(JSON.stringify(warning)).not.toContain(second.email);
    });

    it('changes the list all the same on a deployment with no mail', async () => {
      const newcomer = await candidate();
      expect((await addAdmin(newcomer.email)).status).toBe(201);
      expect(mail.sent).toEqual([]);
      expect(await isAdminRow(newcomer.id)).toBe(true);
    });
  });
});

/* ── finding an organisation ──────────────────────────────────────────────── */

describe('searching organisations', () => {
  it('finds a person’s organisations by address, whatever its case, with their role', async () => {
    const { orgId, slug, owner } = await seedOrg();
    const other = await seedOrg();
    await addMember(other.orgId, owner.id, 'developer');

    const answer = await search(owner.email.toUpperCase());

    expect(answer.status).toBe(200);
    const found = answer.body['organizations'] as Record<string, unknown>[];
    expect(found.map((org) => [org['id'], org['role']]).sort()).toEqual(
      [
        [orgId, 'owner'],
        [other.orgId, 'developer'],
      ].sort(),
    );
    expect(found.find((org) => org['id'] === orgId)).toMatchObject({
      slug,
      plan: 'free',
      managedBy: 'none',
      grant: null,
      billedByDodo: false,
    });
  });

  it('finds one organisation by its slug, with how it is billed', async () => {
    const { orgId, slug } = await seedOrg(SUBSCRIBED);
    const answer = await search(slug.toUpperCase());
    expect(answer.body['organizations']).toEqual([
      expect.objectContaining({
        id: orgId,
        role: null,
        plan: 'team',
        managedBy: 'checkout',
        billedByDodo: true,
        awaitingActivation: false,
      }),
    ]);
  });

  it('never finds a deleted organisation, by slug or by address', async () => {
    const { orgId, slug, owner } = await seedOrg();
    await t.pg.query(`update organizations set deleted_at = now() where id = $1`, [orgId]);
    expect((await search(slug)).body['organizations']).toEqual([]);
    expect((await search(owner.email)).body['organizations']).toEqual([]);
  });

  it('refuses a query too short to mean anything', async () => {
    expect((await search('ab')).status).toBe(422);
  });
});

/* ── granting a plan ──────────────────────────────────────────────────────── */

describe('granting a complimentary plan', () => {
  it('puts a Free organisation on the plan, with its end and seats, and audits it as xecret support', async () => {
    const { orgId } = await seedOrg();
    const endsAt = new Date(Date.now() + 45 * DAY);

    const answer = await grant(
      orgId,
      grantBody({ endsAt: endsAt.toISOString(), seats: 7, reason: 'Design partner, ticket 4211' }),
    );

    expect(answer.status).toBe(200);
    expect(answer.body['detachedSubscriptionId']).toBeNull();
    expect(answer.body['organization']).toMatchObject({
      id: orgId,
      plan: 'team',
      status: 'active',
      managedBy: 'support',
      seats: { billed: 7, limit: 7 },
      grant: { endsAt: endsAt.toISOString(), note: 'Granted by xecret support' },
    });
    expect(await findSubscription(t.db, orgId)).toMatchObject({
      plan: 'team',
      status: 'active',
      seats: 7,
      grantEndsAt: endsAt,
      grantNote: 'Granted by xecret support',
      dodoSubscriptionId: null,
    });
    expect(await seatLimitOf(orgId)).toBe(7);

    const changes = await planChangesOf(orgId);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      actor_type: 'system',
      actor_id: null,
      actor_label: 'xecret support',
      outcome: 'success',
      metadata: {
        operator: 'xecret support',
        plan: 'team',
        previousPlan: 'free',
        seatCount: 7,
      },
    });
    const reason = String(changes[0]!.metadata['reason']);
    expect(reason).toContain(`complimentary team plan until ${endsAt.toISOString().slice(0, 10)}`);
    expect(reason).toContain('Design partner, ticket 4211');
    // The customer reads this row: which admin did it is the server log's to say.
    expect(JSON.stringify(changes[0])).not.toContain(ADMIN_EMAIL);
    expect(JSON.stringify(changes[0])).not.toContain(adminUser.id);
    expect(
      lines.find((line) => /gave an organisation a complimentary plan/.test(line.message)),
    ).toMatchObject({ adminUserId: adminUser.id });

    // The owner's billing screen says the same, and offers no code over it.
    caller = sessionOf((await seedOwnerOf(orgId))!);
    expect((await billing((await slugOf(orgId))!)).body['billing']).toMatchObject({
      plan: 'team',
      managedBy: 'support',
      grant: { endsAt: endsAt.toISOString(), note: 'Granted by xecret support' },
      actions: { promoCode: false, checkout: false },
    });
  });

  it('grants with no end date', async () => {
    const { orgId } = await seedOrg();
    const answer = await grant(orgId, grantBody({ plan: 'enterprise', endsAt: null }));
    expect(answer.status).toBe(200);
    expect(answer.body['organization']).toMatchObject({
      plan: 'enterprise',
      grant: { endsAt: null },
    });
    expect(String((await planChangesOf(orgId))[0]!.metadata['reason'])).toContain(
      'with no end date',
    );
  });

  it('refuses an end date in the past, or ten years out, and writes nothing', async () => {
    const { orgId } = await seedOrg();
    for (const endsAt of [
      new Date(Date.now() - DAY).toISOString(),
      new Date(Date.now() + 3651 * DAY).toISOString(),
      'next tuesday',
    ]) {
      const answer = await grant(orgId, grantBody({ endsAt }));
      expect(answer.status, endsAt).toBe(422);
      expect(errorOf(answer).code).toBe('validation_failed');
    }
    expect((await findSubscription(t.db, orgId))?.plan).toBe('free');
    expect(await planChangesOf(orgId)).toEqual([]);
  });

  it('refuses an organisation Dodo bills — unless told to take it off its subscription', async () => {
    const { orgId } = await seedOrg(SUBSCRIBED);

    const refused = await grant(orgId, grantBody());
    expect(refused.status).toBe(409);
    expect(errorOf(refused).message).toContain('pays through Dodo');
    expect(await findSubscription(t.db, orgId)).toMatchObject({
      plan: 'team',
      dodoSubscriptionId: `sub_example0001-${orgId.slice(0, 8)}`,
      grantEndsAt: null,
    });

    const answer = await grant(orgId, grantBody({ plan: 'enterprise', overDodo: true }));
    expect(answer.status).toBe(200);
    // Still live at Dodo until somebody cancels it there: the admin is told which.
    expect(answer.body['detachedSubscriptionId']).toBe(`sub_example0001-${orgId.slice(0, 8)}`);
    expect(await findSubscription(t.db, orgId)).toMatchObject({
      plan: 'enterprise',
      dodoSubscriptionId: null,
      dodoCustomerId: null,
      dodoProductId: null,
      grantNote: 'Granted by xecret support',
    });
    const changes = await planChangesOf(orgId);
    expect(changes).toHaveLength(1);
    expect(String(changes[0]!.metadata['reason'])).toContain('taken off its Dodo subscription');
  });

  it('treats a Free organisation whose paid checkout is still activating as one Dodo bills', async () => {
    const { orgId, slug } = await seedOrg({
      dodo_subscription_id: 'sub_linked0001',
      dodo_customer_id: 'cus_linked0001',
    });
    expect((await search(slug)).body['organizations']).toEqual([
      expect.objectContaining({ plan: 'free', awaitingActivation: true }),
    ]);

    const refused = await grant(orgId, grantBody());
    expect(refused.status).toBe(409);
    expect(errorOf(refused).message).toContain('pays through Dodo');
    expect((await findSubscription(t.db, orgId))?.plan).toBe('free');

    // Told to, it is taken off the subscription the payment linked — which the
    // admin is named, to cancel at Dodo — exactly as one already billed.
    const forced = await grant(orgId, grantBody({ overDodo: true }));
    expect(forced.status).toBe(200);
    expect(forced.body['detachedSubscriptionId']).toBe(`sub_linked0001-${orgId.slice(0, 8)}`);
    expect(await findSubscription(t.db, orgId)).toMatchObject({
      plan: 'team',
      dodoSubscriptionId: null,
    });
  });

  it('replaces a grant it already gave — a later end, another plan', async () => {
    const { orgId } = await seedOrg();
    await grant(orgId, grantBody({ plan: 'pro' }));
    const later = new Date(Date.now() + 90 * DAY);
    const answer = await grant(orgId, grantBody({ plan: 'team', endsAt: later.toISOString() }));
    expect(answer.status).toBe(200);
    expect(await findSubscription(t.db, orgId)).toMatchObject({ plan: 'team', grantEndsAt: later });
    expect(await planChangesOf(orgId)).toHaveLength(2);
  });

  it('answers 404 for an id that is malformed, unknown or a deleted organisation', async () => {
    expect((await grant('not-a-uuid', grantBody())).status).toBe(404);
    expect((await grant(randomUUID(), grantBody())).status).toBe(404);
    const { orgId } = await seedOrg();
    await t.pg.query(`update organizations set deleted_at = now() where id = $1`, [orgId]);
    expect((await grant(orgId, grantBody())).status).toBe(404);
  });

  it('takes no field it does not know', async () => {
    const { orgId } = await seedOrg();
    expect((await grant(orgId, grantBody({ price: 0 }))).status).toBe(422);
    expect((await grant(orgId, grantBody({ plan: 'free' }))).status).toBe(422);
    expect((await grant(orgId, grantBody({ reason: '   ' }))).status).toBe(422);
  });
});

async function slugOf(orgId: string): Promise<string | undefined> {
  const rows = await t.pg.query<{ slug: string }>(`select slug from organizations where id = $1`, [
    orgId,
  ]);
  return rows.rows[0]?.slug;
}

async function seedOwnerOf(orgId: string): Promise<{ id: string; email: string } | undefined> {
  const rows = await t.pg.query<{ id: string; email: string }>(
    `select u.id, u.email from org_members m join users u on u.id = m.user_id
     where m.org_id = $1 and m.role = 'owner'`,
    [orgId],
  );
  return rows.rows[0];
}

describe('ending a complimentary plan', () => {
  it('returns the organisation to Free and Free’s seat ceiling, and audits why', async () => {
    const { orgId } = await seedOrg();
    await grant(orgId, grantBody({ seats: 12 }));
    expect(await seatLimitOf(orgId)).toBe(12);

    const answer = await endGrant(orgId, { reason: 'Partnership ended' });

    expect(answer.status).toBe(200);
    expect(answer.body['organization']).toMatchObject({
      plan: 'free',
      managedBy: 'none',
      grant: null,
    });
    expect(await findSubscription(t.db, orgId)).toMatchObject({
      plan: 'free',
      billingInterval: null,
      seats: 1,
      grantEndsAt: null,
      grantNote: null,
    });
    expect(await seatLimitOf(orgId)).toBe(FREE_SEAT_LIMIT);

    const ended = (await planChangesOf(orgId)).at(-1)!;
    expect(ended).toMatchObject({
      actor_type: 'system',
      actor_label: 'xecret support',
      metadata: {
        operator: 'xecret support',
        plan: 'free',
        previousPlan: 'team',
        reason: 'complimentary plan ended by support: Partnership ended',
      },
    });
    expect(JSON.stringify(ended)).not.toContain(ADMIN_EMAIL);
  });

  it('refuses when there is no grant to end — on Free, or billed by Dodo', async () => {
    const free = await seedOrg();
    const paying = await seedOrg(SUBSCRIBED);
    for (const orgId of [free.orgId, paying.orgId]) {
      const answer = await endGrant(orgId, { reason: 'Mistake' });
      expect(answer.status).toBe(409);
      expect(await planChangesOf(orgId)).toEqual([]);
    }
    expect((await findSubscription(t.db, paying.orgId))?.plan).toBe('team');
  });

  it('wants a reason, and a well-formed id', async () => {
    const { orgId } = await seedOrg();
    await grant(orgId, grantBody());
    expect((await endGrant(orgId, {})).status).toBe(422);
    expect((await endGrant('nope', { reason: 'x' })).status).toBe(404);
    expect((await findSubscription(t.db, orgId))?.plan).toBe('team');
  });
});

describe('listing grants', () => {
  it('lists every organisation on a complimentary plan, and none Dodo bills', async () => {
    const granted = await seedOrg();
    const endsAt = new Date(Date.now() + 5 * DAY);
    await grant(granted.orgId, grantBody({ plan: 'pro', endsAt: endsAt.toISOString() }));
    const paying = await seedOrg(SUBSCRIBED);

    const answer = await listGrants();

    expect(answer.status).toBe(200);
    const grants = answer.body['grants'] as Record<string, unknown>[];
    expect(grants).toContainEqual(
      expect.objectContaining({
        orgId: granted.orgId,
        orgSlug: granted.slug,
        plan: 'pro',
        endsAt: endsAt.toISOString(),
        note: 'Granted by xecret support',
      }),
    );
    expect(grants.some((row) => row['orgId'] === paying.orgId)).toBe(false);
  });
});

/* ── promo codes, the admin side ──────────────────────────────────────────── */

describe('creating promo codes', () => {
  it('makes a random free-plan code from the unambiguous alphabet when none is given', async () => {
    const answer = await createCode(grantCodeBody());
    expect(answer.status).toBe(201);
    const code = answer.body['code'] as Record<string, unknown>;
    expect(code['code']).toMatch(/^[A-Z0-9]{10}$/);
    // Nothing that reads as something else: no 0/O, no 1/I/L.
    expect(code['code']).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$/);
    expect(code).toMatchObject({
      kind: 'grant',
      summary: 'Team free for 30 days',
      grant: { plan: 'team', days: 30, seats: null },
      discount: null,
      redemptions: 0,
      state: 'active',
      revokedAt: null,
    });
    expect(dodo.createDiscount).not.toHaveBeenCalled();
  });

  it('takes a chosen code in any case, and refuses it a second time — revoked or not', async () => {
    const chosen = freshCode('F');
    const first = await createCode(grantCodeBody({ code: chosen.toLowerCase() }));
    expect(first.status).toBe(201);
    expect(first.body['code']).toMatchObject({ code: chosen });

    const again = await createCode(grantCodeBody({ code: chosen }));
    expect(again.status).toBe(409);
    expect(errorOf(again).message).toContain('already exists');

    await revoke((first.body['code'] as { id: string }).id);
    expect((await createCode(grantCodeBody({ code: chosen }))).status).toBe(409);
    expect(await count('promo_codes where code = $1', [chosen])).toBe(1);
  });

  it('lower-cases and de-duplicates the addresses a code is for', async () => {
    const answer = await createCode(
      grantCodeBody({
        allowedEmails: ['Priya@Example.com', 'priya@example.com', 'sam@example.com'],
      }),
    );
    expect(answer.body['code']).toMatchObject({
      allowedEmails: ['priya@example.com', 'sam@example.com'],
    });
  });

  it('creates a discount at Dodo restricted to exactly the chosen plans’ products, then records it', async () => {
    dodo.createDiscount.mockResolvedValue({ discountId: 'dsc_half0001' });
    const code = freshCode('H');
    const expiresAt = new Date(Date.now() + 14 * DAY);

    const answer = await createCode(
      discountCodeBody(
        { value: 50, cycles: 3, plans: ['pro', 'team'] },
        { code, maxRedemptions: 40, expiresAt: expiresAt.toISOString() },
      ),
    );

    expect(answer.status).toBe(201);
    expect(dodo.createDiscount).toHaveBeenCalledTimes(1);
    expect(dodo.createDiscount).toHaveBeenCalledWith({
      code,
      // The code, never the admin's description: Dodo may show a discount's name.
      name: `xecret ${code}`,
      type: 'percentage',
      amount: 5_000,
      currency: null,
      cycles: 3,
      productIds: ['pdt_pro_m', 'pdt_pro_y', 'pdt_team_m', 'pdt_team_y'],
      usageLimit: 40,
      expiresAt,
    });
    expect(answer.body['code']).toMatchObject({
      code,
      kind: 'discount',
      summary: '50% off Pro and Team for the first 3 billing periods',
      discount: {
        type: 'percentage',
        value: 50,
        currency: null,
        cycles: 3,
        plans: ['pro', 'team'],
        mode: 'test_mode',
      },
      grant: null,
    });
    const row = await t.pg.query<{
      dodo_discount_id: string;
      dodo_mode: string;
      discount_amount: number;
    }>(`select dodo_discount_id, dodo_mode, discount_amount from promo_codes where code = $1`, [
      code,
    ]);
    expect(row.rows).toEqual([
      { dodo_discount_id: 'dsc_half0001', dodo_mode: 'test_mode', discount_amount: 5_000 },
    ]);
  });

  it('restricts a one-plan discount to that plan’s two products only', async () => {
    dodo.createDiscount.mockResolvedValue({ discountId: 'dsc_team0001' });
    await createCode(discountCodeBody({ plans: ['team'] }, { code: freshCode('P') }));
    expect(dodo.createDiscount.mock.calls[0]![0]).toMatchObject({
      productIds: ['pdt_team_m', 'pdt_team_y'],
    });
  });

  it('converts a fixed amount from major to minor units', async () => {
    dodo.createDiscount.mockResolvedValue({ discountId: 'dsc_flat0001' });
    const answer = await createCode(
      discountCodeBody(
        { type: 'flat', value: 5, currency: 'usd', cycles: 1 },
        { code: freshCode('M') },
      ),
    );
    expect(answer.status).toBe(201);
    expect(dodo.createDiscount.mock.calls[0]![0]).toMatchObject({
      type: 'flat',
      amount: 500,
      currency: 'USD',
    });
    expect(answer.body['code']).toMatchObject({
      summary: '$5.00 off Pro for the first billing period',
      discount: { type: 'flat', value: 5, currency: 'USD' },
    });
  });

  it('refuses a percentage with a currency, and a fixed amount without one, before Dodo', async () => {
    expect(
      (await createCode(discountCodeBody({ currency: 'USD' }, { code: freshCode('V') }))).status,
    ).toBe(422);
    expect(
      (await createCode(discountCodeBody({ type: 'flat', value: 5 }, { code: freshCode('V') })))
        .status,
    ).toBe(422);
    expect(
      (await createCode(discountCodeBody({ value: 101 }, { code: freshCode('V') }))).status,
    ).toBe(422);
    expect(dodo.createDiscount).not.toHaveBeenCalled();
  });

  it('refuses a discount code on a deployment that takes no payments — nothing at Dodo, nothing here', async () => {
    env = { ...BASE_ENV };
    const code = freshCode('N');
    const answer = await createCode(discountCodeBody({}, { code }));
    expect(answer.status).toBe(409);
    expect(errorOf(answer).message).toContain('does not take payments');
    expect(dodo.createDiscount).not.toHaveBeenCalled();
    expect(await count('promo_codes where code = $1', [code])).toBe(0);
  });

  it('deletes the Dodo discount again when the code cannot be recorded', async () => {
    const code = freshCode('R');
    // Somebody else takes the code between the check and the insert.
    dodo.createDiscount.mockImplementation(async () => {
      await grantCode({}, { code });
      return { discountId: 'dsc_orphan0001' };
    });
    dodo.deleteDiscount.mockResolvedValue(undefined);

    const answer = await createCode(discountCodeBody({}, { code }));

    expect(answer.status).toBe(409);
    expect(dodo.deleteDiscount).toHaveBeenCalledWith('dsc_orphan0001');
    const rows = await t.pg.query<{ kind: string }>(
      `select kind from promo_codes where code = $1`,
      [code],
    );
    expect(rows.rows).toEqual([{ kind: 'grant' }]);
  });

  it('says the code is taken when Dodo already has one by that name', async () => {
    dodo.createDiscount.mockRejectedValue(new DodoApiError('conflict', 409));
    const code = freshCode('C');
    const answer = await createCode(discountCodeBody({}, { code }));
    expect(answer.status).toBe(409);
    expect(await count('promo_codes where code = $1', [code])).toBe(0);
    expect(dodo.deleteDiscount).not.toHaveBeenCalled();
  });

  it('wants exactly the part its kind describes', async () => {
    expect(
      (
        await createCode({
          ...grantCodeBody({ code: freshCode('K') }),
          discount: discountCodeBody()['discount'],
        })
      ).status,
    ).toBe(422);
    const noGrant: Record<string, unknown> = grantCodeBody({ code: freshCode('K') });
    delete noGrant['grant'];
    expect((await createCode(noGrant)).status).toBe(422);
  });
});

describe('revoking and listing promo codes', () => {
  it('revokes a free-plan code, and refuses to revoke it twice', async () => {
    const code = await grantCode();
    const answer = await revoke(code.id);
    expect(answer.status).toBe(200);
    expect(answer.body['code']).toMatchObject({ id: code.id, state: 'revoked' });
    expect((answer.body['code'] as { revokedAt: string | null }).revokedAt).not.toBeNull();
    expect((await findPromoCodeById(t.db, code.id))?.revokedBy).toBe(adminUser.id);
    expect(dodo.deleteDiscount).not.toHaveBeenCalled();

    expect((await revoke(code.id)).status).toBe(409);
  });

  it('deletes a revoked discount code at Dodo too', async () => {
    dodo.deleteDiscount.mockResolvedValue(undefined);
    const code = await discountCode();
    expect((await revoke(code.id)).status).toBe(200);
    expect(dodo.deleteDiscount).toHaveBeenCalledWith(code.dodoDiscountId);
  });

  it('revokes even when Dodo cannot delete the discount — nothing here applies it any more', async () => {
    dodo.deleteDiscount.mockRejectedValue(new DodoApiError('upstream_5xx', 503));
    const code = await discountCode();
    const answer = await revoke(code.id);
    expect(answer.status).toBe(200);
    expect(answer.body['code']).toMatchObject({ state: 'revoked' });
    expect(
      lines.some(
        (line) => line.level === 'warn' && /could not be deleted at Dodo/.test(line.message),
      ),
    ).toBe(true);
  });

  it('leaves a discount of the other Dodo mode alone at Dodo', async () => {
    const code = await discountCode({ mode: 'live_mode' });
    expect((await revoke(code.id)).status).toBe(200);
    expect(dodo.deleteDiscount).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown or malformed code id', async () => {
    expect((await revoke(randomUUID())).status).toBe(404);
    expect((await revoke('FRIENDS')).status).toBe(404);
  });

  it('lists codes newest first, with whether this deployment takes payments', async () => {
    const older = await grantCode();
    const newer = await discountCode();

    const answer = await listCodes();

    expect(answer.status).toBe(200);
    expect(answer.body['billing']).toEqual({ enabled: true, mode: 'test_mode' });
    const ids = (answer.body['codes'] as { id: string }[]).map((code) => code.id);
    expect(ids).toContain(older.id);
    expect(ids).toContain(newer.id);
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));

    env = { ...BASE_ENV };
    expect((await listCodes()).body['billing']).toEqual({ enabled: false, mode: null });
  });
});

/* ── promo codes, the owner side ──────────────────────────────────────────── */

describe('previewing a code', () => {
  it('tells an owner what a free-plan code gives, whatever case they typed it in', async () => {
    const { slug, owner } = await seedOrg();
    const code = await grantCode({ plan: 'team', days: 30 });
    caller = sessionOf(owner);

    const answer = await preview(slug, code.code.toLowerCase());

    expect(answer.status).toBe(200);
    expect(answer.body['promo']).toEqual({
      code: code.code,
      kind: 'grant',
      summary: 'Team free for 30 days',
      plan: 'team',
      plans: null,
    });
    // A preview spends nothing.
    expect((await findPromoCodeById(t.db, code.id))?.redemptions).toBe(0);
  });

  it('gives one answer for a code that does not exist, was revoked or is for somebody else', async () => {
    const { slug, owner } = await seedOrg();
    const revoked = await grantCode();
    await t.pg.query(`update promo_codes set revoked_at = now() where id = $1`, [revoked.id]);
    const forOthers = await grantCode({}, { allowedEmails: ['someone.else@example.com'] });
    caller = sessionOf(owner);

    const answers = [
      await preview(slug, 'NOSUCHCODE1'),
      await preview(slug, revoked.code),
      await preview(slug, forOthers.code),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(400);
      expect(errorOf(answer).code).toBe('bad_request');
    }
    // A guesser learns nothing from which it was.
    expect(new Set(answers.map((answer) => JSON.stringify(errorOf(answer).message))).size).toBe(1);
    expect(errorOf(answers[0]!).message).toContain('not a code we issued');
  });

  it('accepts a code for the owner’s own address, and refuses it to an unverified one', async () => {
    const { slug, owner } = await seedOrg();
    const code = await grantCode({}, { allowedEmails: [owner.email.toLowerCase()] });
    caller = sessionOf({ id: owner.id, email: owner.email.toUpperCase() });
    expect((await preview(slug, code.code)).status).toBe(200);

    caller = sessionOf(owner, false);
    expect((await preview(slug, code.code)).status).toBe(400);
  });

  it('says a code has expired', async () => {
    const { slug, owner } = await seedOrg();
    const code = await grantCode({}, { expiresAt: new Date(Date.now() - 60_000) });
    caller = sessionOf(owner);
    const answer = await preview(slug, code.code);
    expect(answer.status).toBe(409);
    expect(errorOf(answer).message).toContain('expired');
  });

  it('describes a discount code only where it can be used — this deployment’s Dodo mode', async () => {
    const { slug, owner } = await seedOrg();
    const here = await discountCode({ plans: ['team'] });
    const elsewhere = await discountCode({ mode: 'live_mode' });
    caller = sessionOf(owner);

    expect((await preview(slug, here.code)).body['promo']).toEqual({
      code: here.code,
      kind: 'discount',
      summary: '20% off Team for the first 3 billing periods',
      plan: null,
      plans: ['team'],
    });
    expect((await preview(slug, elsewhere.code)).status).toBe(400);

    env = { ...BASE_ENV };
    expect((await preview(slug, here.code)).status).toBe(400);
  });

  it('refuses a code that is not shaped like one before looking it up', async () => {
    const { slug, owner } = await seedOrg();
    caller = sessionOf(owner);
    expect((await preview(slug, 'no')).status).toBe(422);
    expect((await preview(slug, 'has-dash')).status).toBe(422);
  });
});

describe('redeeming a free-plan code', () => {
  it('puts the organisation on the plan for the code’s days, counts it, and audits it as the owner', async () => {
    const { orgId, slug, owner } = await seedOrg();
    const code = await grantCode({ plan: 'team', days: 30, seats: 5 });
    caller = sessionOf(owner);
    const before = Date.now();

    const answer = await redeem(slug, code.code);

    expect(answer.status).toBe(200);
    const shown = answer.body['billing'] as { grant: { endsAt: string } };
    expect(shown).toMatchObject({
      plan: 'team',
      managedBy: 'support',
      grant: { note: `Promo code ${code.code}` },
      actions: { promoCode: false, checkout: false },
    });
    const endsAt = Date.parse(shown.grant.endsAt);
    expect(endsAt).toBeGreaterThanOrEqual(before + 30 * DAY);
    expect(endsAt).toBeLessThanOrEqual(Date.now() + 30 * DAY);

    expect(await findSubscription(t.db, orgId)).toMatchObject({
      plan: 'team',
      seats: 5,
      grantNote: `Promo code ${code.code}`,
      dodoSubscriptionId: null,
    });
    expect(await seatLimitOf(orgId)).toBe(5);
    expect((await findPromoCodeById(t.db, code.id))?.redemptions).toBe(1);
    const redemptions = await t.pg.query<{ org_id: string; user_id: string }>(
      `select org_id, user_id from promo_code_redemptions where code_id = $1`,
      [code.id],
    );
    expect(redemptions.rows).toEqual([{ org_id: orgId, user_id: owner.id }]);

    const changes = await planChangesOf(orgId);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      actor_type: 'user',
      actor_id: owner.id,
      outcome: 'success',
      metadata: { plan: 'team', previousPlan: 'free' },
    });
    expect(String(changes[0]!.metadata['reason'])).toContain(`promo code ${code.code} redeemed`);
    // Nothing about a free-plan code is Dodo's.
    for (const fn of Object.values(dodo)) expect(fn).not.toHaveBeenCalled();
  });

  it('gives a code with no days a plan with no end', async () => {
    const { slug, owner } = await seedOrg();
    const code = await grantCode({ plan: 'pro', days: null });
    caller = sessionOf(owner);
    const answer = await redeem(slug, code.code);
    expect(answer.body['billing']).toMatchObject({ plan: 'pro', grant: { endsAt: null } });
  });

  it('works on a deployment that takes no payments', async () => {
    env = { ...BASE_ENV };
    const { slug, owner } = await seedOrg();
    const code = await grantCode();
    caller = sessionOf(owner);
    expect((await redeem(slug, code.code)).status).toBe(200);
  });

  it('is spent once per organisation', async () => {
    const { orgId, slug, owner } = await seedOrg();
    const code = await grantCode();
    caller = sessionOf(owner);
    expect((await redeem(slug, code.code)).status).toBe(200);

    const again = await redeem(slug, code.code);
    expect(again.status).toBe(409);
    expect(errorOf(again).message).toContain('already used that code');
    expect((await findPromoCodeById(t.db, code.id))?.redemptions).toBe(1);
    expect(await planChangesOf(orgId)).toHaveLength(1);
  });

  it('is spent once per person — not again on another organisation they own', async () => {
    const first = await seedOrg();
    const second = await seedOrg({}, first.owner);
    const code = await grantCode();
    caller = sessionOf(first.owner);
    expect((await redeem(first.slug, code.code)).status).toBe(200);

    const again = await redeem(second.slug, code.code);
    expect(again.status).toBe(409);
    expect(errorOf(again).message).toContain('for another organisation');
    expect((await findSubscription(t.db, second.orgId))?.plan).toBe('free');
    expect((await findPromoCodeById(t.db, code.id))?.redemptions).toBe(1);
  });

  it('stops at the code’s limit', async () => {
    const code = await grantCode({}, { maxRedemptions: 1 });
    const first = await seedOrg();
    caller = sessionOf(first.owner);
    expect((await redeem(first.slug, code.code)).status).toBe(200);

    const second = await seedOrg();
    caller = sessionOf(second.owner);
    const answer = await redeem(second.slug, code.code);
    expect(answer.status).toBe(409);
    expect(errorOf(answer).message).toContain('used as many times as it allows');
    expect((await findSubscription(t.db, second.orgId))?.plan).toBe('free');
  });

  it('refuses an organisation that already has a plan, and gives the redemption back', async () => {
    const granted = await seedOrg({
      plan: 'enterprise',
      billing_interval: 'yearly',
      seats: 25,
      grant_note: 'Contract 2026-14',
    });
    const paying = await seedOrg(SUBSCRIBED);
    const code = await grantCode();

    caller = sessionOf(granted.owner);
    const overGrant = await redeem(granted.slug, code.code);
    expect(overGrant.status).toBe(409);
    expect(errorOf(overGrant).message).toContain('managed by xecret support');

    caller = sessionOf(paying.owner);
    const overSubscription = await redeem(paying.slug, code.code);
    expect(overSubscription.status).toBe(409);
    expect(errorOf(overSubscription).message).toContain('already pays for a plan');

    // Rolled back with the refusal: the code is as good as new.
    expect((await findPromoCodeById(t.db, code.id))?.redemptions).toBe(0);
    expect(await count('promo_code_redemptions where code_id = $1', [code.id])).toBe(0);
    expect((await findSubscription(t.db, granted.orgId))?.plan).toBe('enterprise');
    expect((await findSubscription(t.db, paying.orgId))?.dodoSubscriptionId).not.toBeNull();
  });

  it('refuses a discount code — it is applied at checkout', async () => {
    const { slug, owner } = await seedOrg();
    const code = await discountCode();
    caller = sessionOf(owner);
    const answer = await redeem(slug, code.code);
    expect(answer.status).toBe(400);
    expect(errorOf(answer).message).toContain('at checkout');
  });

  it('refuses a member who is not an owner, and a token, as every billing route does', async () => {
    const { orgId, slug } = await seedOrg();
    const developer = await seedUser();
    await addMember(orgId, developer.id, 'developer');
    const code = await grantCode();

    caller = sessionOf(developer);
    expect((await redeem(slug, code.code)).status).toBe(403);
    expect((await preview(slug, code.code)).status).toBe(403);
    expect(
      audit.some((record) => record.action === 'plan.changed' && record.outcome === 'denied'),
    ).toBe(true);

    caller = cliTokenOf(developer);
    expect((await redeem(slug, code.code)).status).toBe(403);

    caller = sessionOf(await seedUser());
    expect((await redeem(slug, code.code)).status).toBe(404);

    expect((await findSubscription(t.db, orgId))?.plan).toBe('free');
    expect((await findPromoCodeById(t.db, code.id))?.redemptions).toBe(0);
  });
});

/* ── a discount code at checkout ──────────────────────────────────────────── */

describe('checkout with a promo code', () => {
  it('pre-applies a discount code for the plan at Dodo, and records which code it was', async () => {
    const { orgId, slug, owner } = await seedOrg();
    const code = await discountCode({ plans: ['pro'] });
    dodo.createCheckoutSession.mockResolvedValue({
      sessionId: `cks_${randomUUID()}`,
      url: 'https://test.checkout.dodopayments.com/session/discounted',
    });
    caller = sessionOf(owner);

    const answer = await checkout(slug, {
      plan: 'pro',
      interval: 'monthly',
      promoCode: code.code.toLowerCase(),
    });

    expect(answer.status).toBe(200);
    expect(dodo.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ productId: 'pdt_pro_m', discountCode: code.code }),
    );
    const recorded = await t.pg.query<{ promo_code_id: string | null }>(
      `select promo_code_id from billing_checkouts where org_id = $1`,
      [orgId],
    );
    expect(recorded.rows).toEqual([{ promo_code_id: code.id }]);
    expect(
      audit.find((record) => record.action === 'billing.checkout_started')?.metadata,
    ).toMatchObject({ reason: `with promo code ${code.code}` });

    // The admin page counts the checkouts a code started.
    caller = sessionOf(adminUser);
    const listed = (await listCodes()).body['codes'] as { id: string; checkoutsStarted: number }[];
    expect(listed.find((row) => row.id === code.id)?.checkoutsStarted).toBe(1);
  });

  it('sends no code when none was given', async () => {
    const { slug, owner } = await seedOrg();
    dodo.createCheckoutSession.mockResolvedValue({
      sessionId: `cks_${randomUUID()}`,
      url: 'https://pay.example/plain',
    });
    caller = sessionOf(owner);
    expect((await checkout(slug, { plan: 'team', interval: 'yearly' })).status).toBe(200);
    expect(dodo.createCheckoutSession.mock.calls[0]![0]).toMatchObject({ discountCode: null });
  });

  /** A checkout refused before Dodo is asked for anything, and nothing recorded. */
  async function refusedBeforeDodo(slug: string, orgId: string, body: unknown): Promise<Answer> {
    const answer = await checkout(slug, body);
    expect(dodo.createCheckoutSession).not.toHaveBeenCalled();
    expect(await count('billing_checkouts where org_id = $1', [orgId])).toBe(0);
    return answer;
  }

  it('refuses a discount code for another plan, before Dodo', async () => {
    const { orgId, slug, owner } = await seedOrg();
    const code = await discountCode({ plans: ['team'] });
    caller = sessionOf(owner);
    const answer = await refusedBeforeDodo(slug, orgId, {
      plan: 'pro',
      interval: 'monthly',
      promoCode: code.code,
    });
    expect(answer.status).toBe(400);
    expect(errorOf(answer).message).toContain('applies to Team only');
  });

  it('refuses a free-plan code at checkout, before Dodo', async () => {
    const { orgId, slug, owner } = await seedOrg();
    const code = await grantCode();
    caller = sessionOf(owner);
    const answer = await refusedBeforeDodo(slug, orgId, {
      plan: 'team',
      interval: 'monthly',
      promoCode: code.code,
    });
    expect(answer.status).toBe(400);
    expect(errorOf(answer).message).toContain('gives a free plan');
  });

  it('refuses a live-mode code on a test-mode deployment as if it were not ours', async () => {
    const { orgId, slug, owner } = await seedOrg();
    const code = await discountCode({ mode: 'live_mode' });
    caller = sessionOf(owner);
    const answer = await refusedBeforeDodo(slug, orgId, {
      plan: 'pro',
      interval: 'monthly',
      promoCode: code.code,
    });
    expect(answer.status).toBe(400);
    expect(errorOf(answer).message).toContain('not a code we issued');
  });

  it('refuses an unknown, revoked, expired or somebody else’s code, before Dodo', async () => {
    const { orgId, slug, owner } = await seedOrg();
    const revoked = await discountCode();
    await t.pg.query(`update promo_codes set revoked_at = now() where id = $1`, [revoked.id]);
    const expired = await discountCode({}, { expiresAt: new Date(Date.now() - 60_000) });
    const forOthers = await discountCode({}, { allowedEmails: ['other@example.com'] });
    caller = sessionOf(owner);

    for (const [promoCode, status] of [
      ['NOSUCHCODE2', 400],
      [revoked.code, 400],
      [expired.code, 409],
      [forOthers.code, 400],
    ] as const) {
      const answer = await refusedBeforeDodo(slug, orgId, {
        plan: 'pro',
        interval: 'monthly',
        promoCode,
      });
      expect(answer.status, promoCode).toBe(status);
    }
  });

  it('treats the same key with another code as another request, and refuses it', async () => {
    const { slug, owner } = await seedOrg();
    const first = await discountCode();
    const second = await discountCode();
    dodo.createCheckoutSession.mockResolvedValue({
      sessionId: `cks_${randomUUID()}`,
      url: 'https://pay.example/keyed',
    });
    caller = sessionOf(owner);
    const key = randomUUID();

    const answer = await checkout(
      slug,
      { plan: 'team', interval: 'monthly', promoCode: first.code },
      key,
    );
    expect(answer.status).toBe(200);
    // The same request again is the same checkout.
    expect(
      await checkout(slug, { plan: 'team', interval: 'monthly', promoCode: first.code }, key),
    ).toEqual(answer);

    for (const body of [
      { plan: 'team', interval: 'monthly', promoCode: second.code },
      { plan: 'team', interval: 'monthly' },
    ]) {
      const other = await checkout(slug, body, key);
      expect(other.status).toBe(400);
      expect(errorOf(other).message).toContain('reuses the idempotency key');
    }
    expect(dodo.createCheckoutSession).toHaveBeenCalledTimes(1);
  });
});

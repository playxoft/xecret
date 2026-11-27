import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AuditRecord } from '@xecret/core/audit';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '@xecret/db/testing';
import type { TestDatabase } from '@xecret/db/testing';
import type { Principal } from './actor';
import { createLogger } from './logging';
import type { LogEntry, RequestLog } from './logging';

/**
 * The admin page's monitoring API — the totals, every organisation and every
 * account newest first, and one of either in detail — end to end against a
 * real database.
 *
 * What is asserted first: that none of it exists for anybody but an admin.
 * Then the owner's rule for an open-source staff page, pinned two ways: every
 * payload's exact set of keys, so a field cannot be added without this file
 * changing; and a sweep of every endpoint's answer for the strings a customer
 * typed into xecret or that identify a device — a project, environment and
 * secret named `TOPSECRET…`, a session's address and browser, an invitee who
 * never signed up — none of which may appear anywhere. And that looking
 * leaves a line on the server's log, never a row in the customer's audit log.
 */

const ORIGIN = 'https://xecret.playxoft.com';
const ADMIN_EMAIL = 'monitor@support.example.com';

const context = vi.hoisted(() => ({ workerContext: vi.fn(), createServiceContext: vi.fn() }));
const actor = vi.hoisted(() => ({
  authenticate: vi.fn(),
  assertCsrf: vi.fn(),
  isUnlocked: vi.fn(() => true),
}));
const auditSink = vi.hoisted(() => ({ write: vi.fn() }));
const logging = vi.hoisted(() => ({ createRequestLog: vi.fn() }));

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

const {
  adminAccountPayloadSchema,
  adminOrganizationPayloadSchema,
  allowlisted,
  decodeAdminCursor,
  encodeAdminCursor,
} = await import('./schemas/admin');
const { ApiError } = await import('./errors');
const overviewRoute = await import('@/app/api/admin/overview/route');
const organizationsRoute = await import('@/app/api/admin/organizations/route');
const organizationRoute = await import('@/app/api/admin/organizations/[orgId]/route');
const usersRoute = await import('@/app/api/admin/users/route');
const userRoute = await import('@/app/api/admin/users/[userId]/route');

let t: TestDatabase;
let lines: LogEntry[] = [];
let audit: AuditRecord[] = [];
let deferred: Promise<unknown>[] = [];
let caller: Principal;
let adminUser: { id: string; email: string };

const DAY = 86_400_000;

beforeAll(async () => {
  t = await createTestDatabase();
  adminUser = await seedUser({ email: ADMIN_EMAIL });
  await t.pg.query(`insert into platform_admins (user_id) values ($1)`, [adminUser.id]);
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  lines = [];
  audit = [];
  deferred = [];
  const env = { XECRET_PUBLIC_URL: ORIGIN, XECRET_ENV: 'production' };

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
        ipAddress: '198.51.100.9',
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

async function seedUser(
  over: { email?: string; createdAt?: string; deleted?: boolean } = {},
): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = over.email ?? `person-${id.slice(0, 8)}@example.com`;
  await t.pg.query(
    `insert into users (id, workos_user_id, email, email_verified, created_at, deleted_at)
     values ($1, $2, $3, true, coalesce($4::timestamptz, now()), $5)`,
    [
      id,
      `user_01${id.replaceAll('-', '').slice(0, 20)}`,
      email,
      over.createdAt ?? null,
      over.deleted ? new Date() : null,
    ],
  );
  return { id, email };
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

async function seedOrg(
  over: { createdAt?: string; deleted?: boolean; owner?: { id: string; email: string } } = {},
): Promise<{ orgId: string; slug: string; owner: { id: string; email: string } }> {
  const owner = over.owner ?? (await seedUser());
  const orgId = randomUUID();
  const slug = `acme-${orgId.slice(0, 8)}`;
  await t.pg.query(
    `insert into organizations (id, name, slug, created_by, created_at, deleted_at)
     values ($1, 'Acme', $2, $3, coalesce($4::timestamptz, now()), $5)`,
    [orgId, slug, owner.id, over.createdAt ?? null, over.deleted ? new Date() : null],
  );
  await t.pg.query(`insert into org_subscriptions (org_id) values ($1)`, [orgId]);
  await addMember(orgId, owner.id, 'owner');
  return { orgId, slug, owner };
}

async function seedProject(
  orgId: string,
  createdBy: string,
  over: { name?: string; slug?: string; description?: string; deleted?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await t.pg.query(
    `insert into projects (id, org_id, name, slug, description, created_by, deleted_at)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      orgId,
      over.name ?? 'Project',
      over.slug ?? `p-${id.slice(0, 8)}`,
      over.description ?? null,
      createdBy,
      over.deleted ? new Date() : null,
    ],
  );
  return id;
}

async function seedEnvironment(
  projectId: string,
  over: { name?: string; slug?: string; deleted?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await t.pg.query(
    `insert into environments (id, project_id, name, slug, encryption_mode, deleted_at)
     values ($1, $2, $3, $4, 'e2ee', $5)`,
    [
      id,
      projectId,
      over.name ?? 'env',
      over.slug ?? `e-${id.slice(0, 8)}`,
      over.deleted ? new Date() : null,
    ],
  );
  return id;
}

async function seedSecret(
  environmentId: string,
  createdBy: string,
  over: { name?: string; note?: string; deleted?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await t.pg.query(
    `insert into secrets (id, environment_id, name, note, created_by, deleted_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      environmentId,
      over.name ?? `KEY_${id.slice(0, 8).replaceAll('-', '_')}`,
      over.note ?? null,
      createdBy,
      over.deleted ? new Date() : null,
    ],
  );
  return id;
}

type Handler<P> = (request: Request, args?: { params?: Promise<P> }) => Promise<Response>;
type Answer = { status: number; body: Record<string, unknown>; text: string };

async function get<P>(handler: Handler<P>, path: string, params: P): Promise<Answer> {
  const response = await handler(
    new Request(`${ORIGIN}${path}`, { method: 'GET', headers: { origin: ORIGIN } }),
    { params: Promise.resolve(params) },
  );
  await Promise.allSettled(deferred);
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
    text,
  };
}

const withParams = (path: string, params: Record<string, string | number | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const query = search.toString();
  return query === '' ? path : `${path}?${query}`;
};

const overview = () => get(overviewRoute.GET, '/api/admin/overview', {});
const organizations = (params: Record<string, string | number | undefined> = {}) =>
  get(organizationsRoute.GET, withParams('/api/admin/organizations', params), {});
const organization = (orgId: string) =>
  get(organizationRoute.GET, `/api/admin/organizations/${orgId}`, { orgId });
const users = (params: Record<string, string | number | undefined> = {}) =>
  get(usersRoute.GET, withParams('/api/admin/users', params), {});
const user = (userId: string) => get(userRoute.GET, `/api/admin/users/${userId}`, { userId });

type Row = Record<string, unknown>;
const orgRows = (answer: Answer) => answer.body['organizations'] as Row[];
const userRows = (answer: Answer) => answer.body['users'] as Row[];
const errorOf = (answer: Answer) => answer.body['error'] as { code: string; message: string };
const keysOf = (value: unknown) => Object.keys(value as Row).sort();

/** Follows a list from its first page by its cursors, and every row on the way. */
async function everyPage(
  read: (cursor: string | undefined) => Promise<Answer>,
  rowsOf: (answer: Answer) => Row[],
): Promise<{ rows: Row[]; pages: number }> {
  const rows: Row[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const answer = await read(cursor);
    expect(answer.status).toBe(200);
    pages += 1;
    rows.push(...rowsOf(answer));
    const next = answer.body['nextCursor'] as string | null;
    if (next === null) return { rows, pages };
    cursor = next;
  }
}

async function auditRows(): Promise<number> {
  const result = await t.pg.query<{ n: number }>(`select count(*)::int as n from audit_logs`);
  return result.rows[0]!.n;
}

/* ── who may ──────────────────────────────────────────────────────────────── */

describe('who may read the monitoring API', () => {
  const callers: [string, () => Promise<Principal>][] = [
    ['a signed-in person who is not an admin', async () => sessionOf(await seedUser())],
    ['the admin’s own session, its address not verified', async () => sessionOf(adminUser, false)],
    ['the admin’s own CLI token', async () => cliTokenOf(adminUser)],
  ];

  for (const [who, arrange] of callers) {
    it(`answers ${who} 404 on every endpoint`, async () => {
      const { orgId, owner } = await seedOrg();
      caller = await arrange();

      const answers = [
        await overview(),
        await organizations(),
        await organizations({ q: owner.email }),
        await organization(orgId),
        await users(),
        await users({ q: 'example.com' }),
        await user(owner.id),
      ];
      for (const answer of answers) {
        expect(answer.status).toBe(404);
        expect(errorOf(answer).code).toBe('not_found');
        // Not one figure, name or address in a refusal.
        expect(answer.text).not.toContain(owner.email);
        expect(answer.text).not.toContain(orgId);
      }
      expect(
        lines.filter((line) => line.level === 'warn' && /not an admin/.test(line.message)),
      ).toHaveLength(answers.length);
    });
  }
});

/* ── the totals ───────────────────────────────────────────────────────────── */

describe('the overview', () => {
  it('counts what is live, inside live parents, and the recent sign-ups', async () => {
    const before = (await overview()).body;

    const { orgId, owner } = await seedOrg();
    const project = await seedProject(orgId, owner.id);
    const env = await seedEnvironment(project);
    await seedSecret(env, owner.id);
    await seedSecret(env, owner.id);
    await seedSecret(env, owner.id, { deleted: true });
    // Live secrets in a deleted environment, in a deleted project, and in a
    // deleted organisation: none of them counts, nor anything they sit in.
    await seedSecret(await seedEnvironment(project, { deleted: true }), owner.id);
    const goneProject = await seedProject(orgId, owner.id, { deleted: true });
    await seedSecret(await seedEnvironment(goneProject), owner.id);
    const gone = await seedOrg({ deleted: true });
    await seedSecret(await seedEnvironment(await seedProject(gone.orgId, gone.owner.id)), owner.id);
    await seedUser({ deleted: true });
    await seedUser({ createdAt: new Date(Date.now() - 20 * DAY).toISOString() });

    const answer = await overview();
    expect(answer.status).toBe(200);
    expect(keysOf(answer.body)).toEqual(['signups', 'totals']);
    expect(keysOf(answer.body['totals'])).toEqual([
      'environments',
      'organizations',
      'projects',
      'secrets',
      'users',
    ]);
    expect(keysOf(answer.body['signups'])).toEqual(['last30Days', 'last7Days']);

    const delta = (section: 'totals' | 'signups', key: string) =>
      (answer.body[section] as Record<string, number>)[key]! -
      (before[section] as Record<string, number>)[key]!;
    expect(delta('totals', 'organizations')).toBe(1);
    expect(delta('totals', 'projects')).toBe(1);
    expect(delta('totals', 'environments')).toBe(1);
    expect(delta('totals', 'secrets')).toBe(2);
    // Two owners, and the account from twenty days ago; never the deleted one.
    expect(delta('totals', 'users')).toBe(3);
    expect(delta('signups', 'last7Days')).toBe(2);
    expect(delta('signups', 'last30Days')).toBe(3);

    expect(
      lines.find((line) => /^An admin read the service’s totals/.test(line.message)),
    ).toMatchObject({ adminUserId: adminUser.id });
  });
});

/* ── organisations ────────────────────────────────────────────────────────── */

const ORGANIZATION_KEYS = [
  'awaitingActivation',
  'billedByDodo',
  'counts',
  'createdAt',
  'grant',
  'id',
  'interval',
  'managedBy',
  'name',
  'ownerEmails',
  'plan',
  'role',
  'seats',
  'slug',
  'status',
];
const COUNT_KEYS = ['environments', 'members', 'pendingInvitations', 'projects', 'secrets'];

describe('listing organisations', () => {
  it('lists every live organisation newest first, a page at a time, without skipping or repeating one', async () => {
    const at = (micro: number) => `2040-01-01T00:00:00.4321${micro}Z`;
    const seeded = [
      await seedOrg({ createdAt: at(11) }),
      await seedOrg({ createdAt: at(12) }),
      await seedOrg({ createdAt: at(13) }),
    ];
    const deleted = await seedOrg({ createdAt: at(14), deleted: true });

    const first = await organizations({ limit: 2 });
    expect(first.status).toBe(200);
    expect(keysOf(first.body)).toEqual(['nextCursor', 'organizations']);
    expect(orgRows(first).map((row) => row['id'])).toEqual([seeded[2]!.orgId, seeded[1]!.orgId]);
    expect(first.body['nextCursor']).toEqual(expect.any(String));

    const second = await organizations({ limit: 2, cursor: first.body['nextCursor'] as string });
    expect(orgRows(second)[0]!['id']).toBe(seeded[0]!.orgId);

    const { rows, pages } = await everyPage(
      (cursor) => organizations({ limit: 3, cursor }),
      orgRows,
    );
    const ids = rows.map((row) => row['id']);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(deleted.orgId);
    // One row past each page is read, so a full last page is known to be the last.
    expect(pages).toBe(Math.ceil(ids.length / 3));
    const created = rows.map((row) => Date.parse(row['createdAt'] as string));
    expect([...created].sort((a, b) => b - a)).toEqual(created);
  });

  it('answers each row with its plan, its owners and how much is in it — counts, never names', async () => {
    const { orgId, slug, owner } = await seedOrg({ createdAt: '2041-01-01T00:00:00Z' });
    const coOwner = await seedUser();
    await addMember(orgId, coOwner.id, 'owner');
    // A second later than the first owner, so "longest-standing first" has an
    // order to find: two memberships made in the same instant are ordered by
    // their random ids, and the test would pass or fail on a coin toss.
    await t.pg.query(
      `update org_members set created_at = created_at + interval '1 second'
       where org_id = $1 and user_id = $2`,
      [orgId, coOwner.id],
    );
    await addMember(orgId, (await seedUser()).id, 'developer');
    await t.pg.query(
      `insert into invitations (id, org_id, email, role, token_hash, invited_by, expires_at)
       values ($1, $2, $3, 'viewer', $4, $5, now() + interval '7 days')`,
      [
        randomUUID(),
        orgId,
        `later-${randomUUID().slice(0, 6)}@example.com`,
        randomBytes(32),
        owner.id,
      ],
    );
    const project = await seedProject(orgId, owner.id);
    const env = await seedEnvironment(project);
    await seedEnvironment(project);
    await seedSecret(env, owner.id);

    const [row] = orgRows(await organizations({ limit: 1 }));
    expect(keysOf(row)).toEqual(ORGANIZATION_KEYS);
    expect(keysOf(row!['counts'])).toEqual(COUNT_KEYS);
    expect(row).toEqual({
      id: orgId,
      name: 'Acme',
      slug,
      role: null,
      createdAt: '2041-01-01T00:00:00.000Z',
      plan: 'free',
      status: 'active',
      interval: null,
      managedBy: 'none',
      seats: { billed: 1, limit: 3 },
      grant: null,
      billedByDodo: false,
      awaitingActivation: false,
      ownerEmails: [owner.email, coOwner.email],
      counts: { members: 3, pendingInvitations: 1, projects: 1, environments: 2, secrets: 1 },
    });
  });

  it('keeps the search by address or slug, with the same row and no next page', async () => {
    const { orgId, slug, owner } = await seedOrg();
    const other = await seedOrg();
    await addMember(other.orgId, owner.id, 'developer');

    const byAddress = await organizations({ q: owner.email.toUpperCase() });
    expect(byAddress.status).toBe(200);
    expect(byAddress.body['nextCursor']).toBeNull();
    expect(
      orgRows(byAddress)
        .map((row) => [row['id'], row['role']])
        .sort(),
    ).toEqual(
      [
        [orgId, 'owner'],
        [other.orgId, 'developer'],
      ].sort(),
    );
    for (const row of orgRows(byAddress)) expect(keysOf(row)).toEqual(ORGANIZATION_KEYS);

    const bySlug = await organizations({ q: slug.toUpperCase() });
    expect(orgRows(bySlug)).toEqual([
      expect.objectContaining({ id: orgId, role: null, ownerEmails: [owner.email] }),
    ]);
    expect((await organizations({ q: 'ab' })).status).toBe(422);
    expect(lines.find((line) => /searched the organisations/.test(line.message))).toMatchObject({
      adminUserId: adminUser.id,
    });
    // The term is somebody's address: it is never on the log line.
    expect(JSON.stringify(lines)).not.toContain(owner.email.toUpperCase());
  });

  it('refuses a cursor it did not issue, and a page past its limit', async () => {
    expect((await organizations({ cursor: 'not-a-cursor' })).status).toBe(400);
    const forged = Buffer.from(`2026-01-01T00:00:00.000Z|${randomUUID()}`).toString('base64url');
    expect((await organizations({ cursor: forged })).status).toBe(400);
    expect((await organizations({ limit: 101 })).status).toBe(422);
    expect((await organizations({ limit: 0 })).status).toBe(422);
    expect(orgRows(await organizations({ limit: 100 })).length).toBeLessThanOrEqual(100);
  });
});

describe('one organisation', () => {
  it('answers its row and its members on live accounts, and leaves no audit row', async () => {
    const { orgId, owner } = await seedOrg();
    const developer = await seedUser();
    await addMember(orgId, developer.id, 'developer');
    const gone = await seedUser();
    await addMember(orgId, gone.id, 'admin');
    await t.pg.query(`update users set deleted_at = now() where id = $1`, [gone.id]);
    const auditBefore = await auditRows();

    const answer = await organization(orgId);

    expect(answer.status).toBe(200);
    expect(keysOf(answer.body)).toEqual(['members', 'organization']);
    const org = answer.body['organization'] as Row;
    expect(keysOf(org)).toEqual(ORGANIZATION_KEYS);
    expect(org).toMatchObject({ id: orgId, counts: { members: 2 } });
    const members = answer.body['members'] as Row[];
    expect(members).toEqual([
      {
        userId: owner.id,
        email: owner.email,
        displayName: null,
        role: 'owner',
        joinedAt: expect.any(String),
      },
      {
        userId: developer.id,
        email: developer.email,
        displayName: null,
        role: 'developer',
        joinedAt: expect.any(String),
      },
    ]);

    // Looking changes nothing: not a row in the organisation's audit log.
    expect(await auditRows()).toBe(auditBefore);
    expect(audit).toEqual([]);
    expect(lines.find((line) => /looked at an organisation/.test(line.message))).toMatchObject({
      adminUserId: adminUser.id,
      orgId,
    });
  });

  it('answers 404 for an id that is malformed, unknown or a deleted organisation’s', async () => {
    const { orgId } = await seedOrg({ deleted: true });
    for (const id of [orgId, randomUUID(), 'not-a-uuid', orgId.toUpperCase()]) {
      const answer = await organization(id);
      expect(answer.status, id).toBe(404);
      expect(answer.text).not.toContain('Acme');
    }
  });
});

/* ── accounts ─────────────────────────────────────────────────────────────── */

const ACCOUNT_KEYS = [
  'displayName',
  'email',
  'emailVerified',
  'id',
  'lastSignInAt',
  'lastSignInMethod',
  'organizationCount',
  'signedUpAt',
];

describe('listing accounts', () => {
  it('lists live accounts newest first, a page at a time, and finds one by part of its address', async () => {
    const marker = randomUUID().slice(0, 8);
    const at = (micro: number) => `2042-01-01T00:00:00.8765${micro}Z`;
    const oldest = await seedUser({ email: `a-${marker}@example.com`, createdAt: at(11) });
    const middle = await seedUser({ email: `b-${marker}@example.com`, createdAt: at(12) });
    const newest = await seedUser({ email: `c-${marker}@example.com`, createdAt: at(13) });
    await seedUser({ email: `d-${marker}@example.com`, createdAt: at(14), deleted: true });
    await t.pg.query(
      `insert into sessions (id, user_id, token_hash, expires_at, sign_in_method)
       values ($1, $2, $3, now() + interval '30 days', 'oauth')`,
      [randomUUID(), middle.id, randomBytes(32)],
    );
    await t.pg.query(`update users set last_login_at = '2042-02-01T00:00:00Z' where id = $1`, [
      middle.id,
    ]);
    await seedOrg({ owner: middle });

    const first = await users({ limit: 2 });
    expect(first.status).toBe(200);
    expect(keysOf(first.body)).toEqual(['nextCursor', 'users']);
    expect(userRows(first).map((row) => row['id'])).toEqual([newest.id, middle.id]);

    const { rows, pages } = await everyPage(
      (cursor) => users({ q: marker.toUpperCase(), limit: 2, cursor }),
      userRows,
    );
    expect(pages).toBe(2);
    expect(rows.map((row) => row['id'])).toEqual([newest.id, middle.id, oldest.id]);
    for (const row of rows) expect(keysOf(row)).toEqual(ACCOUNT_KEYS);
    expect(rows[1]).toEqual({
      id: middle.id,
      email: middle.email,
      displayName: null,
      emailVerified: true,
      signedUpAt: '2042-01-01T00:00:00.876Z',
      lastSignInAt: '2042-02-01T00:00:00.000Z',
      lastSignInMethod: 'oauth',
      organizationCount: 1,
    });

    // Never the search term on the log line: it is part of somebody's address.
    expect(lines.find((line) => /listed the accounts/.test(line.message))).toMatchObject({
      adminUserId: adminUser.id,
    });
    expect(JSON.stringify(lines)).not.toContain(marker.toUpperCase());
  });

  it('matches a wildcard as a character, and refuses a term too short to mean anything', async () => {
    const marker = randomUUID().slice(0, 8);
    await seedUser({ email: `x_${marker}@example.com` });
    await seedUser({ email: `xy${marker}@example.com` });
    const found = userRows(await users({ q: `x_${marker}` }));
    expect(found.map((row) => row['email'])).toEqual([`x_${marker}@example.com`]);
    expect(userRows(await users({ q: '%%%' }))).toEqual([]);
    expect((await users({ q: 'ab' })).status).toBe(422);
    expect((await users({ cursor: 'garbage' })).status).toBe(400);
  });
});

describe('one account', () => {
  it('answers its row and its live organisations, and leaves no audit row', async () => {
    const person = await seedUser();
    const own = await seedOrg({ owner: person });
    const joined = await seedOrg();
    await addMember(joined.orgId, person.id, 'viewer');
    const gone = await seedOrg({ deleted: true });
    await addMember(gone.orgId, person.id, 'admin');
    const auditBefore = await auditRows();

    const answer = await user(person.id);

    expect(answer.status).toBe(200);
    expect(keysOf(answer.body)).toEqual(['organizations', 'user']);
    expect(keysOf(answer.body['user'])).toEqual(ACCOUNT_KEYS);
    expect(answer.body['user']).toMatchObject({ id: person.id, organizationCount: 2 });
    const memberships = answer.body['organizations'] as Row[];
    expect(memberships.map((row) => [row['id'], row['role']])).toEqual([
      [own.orgId, 'owner'],
      [joined.orgId, 'viewer'],
    ]);
    for (const row of memberships) {
      expect(keysOf(row)).toEqual(['id', 'joinedAt', 'name', 'role', 'slug']);
    }

    expect(await auditRows()).toBe(auditBefore);
    expect(lines.find((line) => /looked at an account/.test(line.message))).toMatchObject({
      adminUserId: adminUser.id,
      targetUserId: person.id,
    });
  });

  it('answers 404 for an id that is malformed, unknown or a deleted account’s', async () => {
    const gone = await seedUser({ deleted: true });
    for (const id of [gone.id, randomUUID(), 'nope']) {
      const answer = await user(id);
      expect(answer.status, id).toBe(404);
      expect(answer.text).not.toContain(gone.email);
    }
  });
});

/* ── the owner's rule ─────────────────────────────────────────────────────── */

describe('what no admin endpoint ever answers with', () => {
  it('names no project, environment or secret, no session’s address or browser, and no invitee', async () => {
    const owner = await seedUser({ email: `owner-${randomUUID().slice(0, 8)}@example.com` });
    await t.pg.query(
      `update users set avatar_url = 'https://avatars.example.com/TOPSECRET-AVATAR.png' where id = $1`,
      [owner.id],
    );
    const { orgId, slug } = await seedOrg({ owner });
    const project = await seedProject(orgId, owner.id, {
      name: 'TOPSECRET-PROJECT',
      slug: 'topsecret-project',
      description: 'TOPSECRET-DESC',
    });
    const environment = await seedEnvironment(project, {
      name: 'TOPSECRET-ENV',
      slug: 'topsecret-env',
    });
    const secretId = await seedSecret(environment, owner.id, {
      name: 'TOPSECRET_KEY',
      note: 'TOPSECRET-NOTE',
    });
    const sessionId = randomUUID();
    await t.pg.query(
      `insert into sessions (id, user_id, token_hash, ip_address, user_agent, expires_at, sign_in_method)
       values ($1, $2, $3, '203.0.113.77', 'TopSecretBrowser/1.0', now() + interval '30 days', 'password')`,
      [sessionId, owner.id, randomBytes(32)],
    );
    await t.pg.query(
      `insert into invitations (id, org_id, email, role, token_hash, invited_by, expires_at)
       values ($1, $2, 'invitee-topsecret@example.com', 'viewer', $3, $4, now() + interval '7 days')`,
      [randomUUID(), orgId, randomBytes(32), owner.id],
    );

    const answers = [
      await overview(),
      await organizations(),
      await organizations({ limit: 100 }),
      await organizations({ q: owner.email }),
      await organizations({ q: slug }),
      await organization(orgId),
      await users(),
      await users({ q: owner.email.slice(0, 12) }),
      await user(owner.id),
    ];

    const FORBIDDEN = [
      'TOPSECRET',
      'topsecret-project',
      'topsecret-env',
      '203.0.113.77',
      'TopSecretBrowser',
      'invitee-topsecret@example.com',
      project,
      environment,
      secretId,
      sessionId,
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(200);
      for (const forbidden of FORBIDDEN) {
        expect(answer.text.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
    }

    // What *is* there, so the sweep above is not passing over empty answers:
    // the organisation's counts include the project, environment, secret and
    // invitation it does not name, and the account is listed.
    const detail = answers[5]!.body;
    expect((detail['organization'] as Row)['counts']).toEqual({
      members: 1,
      pendingInvitations: 1,
      projects: 1,
      environments: 1,
      secrets: 1,
    });
    expect((answers[8]!.body['user'] as Row)['lastSignInMethod']).toBe('password');
    expect(userRows(answers[7]!).map((row) => row['id'])).toContain(owner.id);
    expect(orgRows(answers[4]!).map((row) => row['id'])).toEqual([orgId]);
  });
});

/* ── the pieces ───────────────────────────────────────────────────────────── */

describe('the list cursor', () => {
  it('carries the microseconds back exactly as they were sent', () => {
    const cursor = { at: '2026-11-27T09:15:02.123456Z', id: randomUUID() };
    expect(decodeAdminCursor(encodeAdminCursor(cursor))).toEqual(cursor);
  });

  it('refuses anything this server did not write as a bad request, never a database error', () => {
    const id = randomUUID();
    const pack = (text: string) => Buffer.from(text).toString('base64url');
    for (const value of [
      '',
      'not base64 at all!',
      pack(`2026-11-27T09:15:02.123Z|${id}`),
      pack(`2026-11-27T09:15:02.123456Z|not-a-uuid`),
      pack(`2026-11-27T09:15:02.123456Z|${id}|extra`),
      pack(`2026-13-45T99:99:99.123456Z|${id}`),
      pack(`'; drop table users; --|${id}`),
      Buffer.from([0xff, 0xfe, 0xfd]).toString('base64url'),
    ]) {
      let thrown: unknown = null;
      try {
        decodeAdminCursor(value);
      } catch (cause) {
        thrown = cause;
      }
      expect(thrown, value).toBeInstanceOf(ApiError);
      expect((thrown as InstanceType<typeof ApiError>).code, value).toBe('bad_request');
    }
  });
});

describe('the allowlist', () => {
  it('drops every key it does not name, at every level', () => {
    const row = {
      id: 'user-1',
      email: 'ada@example.com',
      displayName: null,
      emailVerified: true,
      signedUpAt: '2026-01-01T00:00:00.000Z',
      lastSignInAt: null,
      lastSignInMethod: null,
      organizationCount: 0,
      // What a careless spread of a row would have carried.
      avatarUrl: 'https://avatars.example.com/a.png',
      ipAddress: '203.0.113.77',
    };
    expect(keysOf(allowlisted(adminAccountPayloadSchema, row))).toEqual(ACCOUNT_KEYS);

    const organization = {
      id: 'org-1',
      name: 'Acme',
      slug: 'acme',
      role: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      plan: 'free' as const,
      status: 'active' as const,
      interval: null,
      managedBy: 'none' as const,
      seats: { billed: 1, limit: 3, dodoCustomerId: 'cus_1' },
      grant: null,
      billedByDodo: false,
      awaitingActivation: false,
      ownerEmails: [],
      counts: {
        members: 1,
        pendingInvitations: 0,
        projects: 0,
        environments: 0,
        secrets: 0,
        projectNames: ['payments'],
      },
    };
    const kept = allowlisted(adminOrganizationPayloadSchema, organization);
    expect(keysOf(kept)).toEqual(ORGANIZATION_KEYS);
    expect(keysOf(kept.seats)).toEqual(['billed', 'limit']);
    expect(keysOf(kept.counts)).toEqual(COUNT_KEYS);
  });

  it('refuses, as a server fault, a payload that does not fit at all', () => {
    expect(() =>
      allowlisted(adminAccountPayloadSchema, {
        id: 'user-1',
        email: 'ada@example.com',
        displayName: null,
        emailVerified: true,
        signedUpAt: '2026-01-01T00:00:00.000Z',
        lastSignInAt: null,
        lastSignInMethod: 'carrier-pigeon' as never,
        organizationCount: 0,
      }),
    ).toThrow(ApiError);
  });
});

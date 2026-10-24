import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AuditRecord } from '@xecret/core/audit';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '@xecret/db/testing';
import type { TestDatabase } from '@xecret/db/testing';
import type { Principal } from './actor';
import { createLogger } from './logging';
import type { LogEntry, RequestLog } from './logging';
import type { WorkosApi } from './workos';

/**
 * The organisation SSO settings (WS-5), end to end: `GET`, `POST` and `PATCH
 * /api/orgs/{orgSlug}/sso` and `POST …/sso/portal`, against a real database.
 *
 * ── What is real, and what is stubbed ──
 * Real: the four routes and `authenticatedRoute`; `resolveOrg`, `authorize`
 * and the authorization engine, reading memberships, custom roles and the
 * subscription row from PGlite with every migration applied; the repositories
 * (`setOrgWorkosOrgId`, `updateOrgSsoSettings`, `findFreshSignIn`,
 * `countNonSsoAccess`); the WorkOS provider's own code, down to the SDK calls.
 *
 * Stubbed: who is asking (`authenticate` hands back the principal a test
 * names, so each guard is asked of the real handler by a real member row), the
 * SDK calls that would leave the process, the audit sink (captured), and the
 * logger (captured).
 *
 * Every refusal is asserted three ways: the status, that WorkOS was not asked
 * for anything it should not have been, and the audit record of the attempt.
 */

const ORIGIN = 'https://xecret.playxoft.com';
const CLIENT_ID = 'client_01TESTCLIENT';

const context = vi.hoisted(() => ({ workerContext: vi.fn(), createServiceContext: vi.fn() }));
const actor = vi.hoisted(() => ({
  authenticate: vi.fn(),
  assertCsrf: vi.fn(),
  isUnlocked: vi.fn(() => true),
}));
const auditSink = vi.hoisted(() => ({ write: vi.fn() }));
const logging = vi.hoisted(() => ({ createRequestLog: vi.fn() }));
const workos = vi.hoisted(() => ({
  createOrganization: vi.fn(),
  getOrganization: vi.fn(),
  getOrganizationByExternalId: vi.fn(),
  deleteOrganization: vi.fn(),
  generateLink: vi.fn(),
  listConnections: vi.fn(),
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
vi.mock('./workos', async (importOriginal) => {
  const original = await importOriginal<typeof import('./workos')>();
  const api = {
    userManagement: {},
    multiFactorAuth: {},
    organizations: {
      createOrganization: workos.createOrganization,
      getOrganization: workos.getOrganization,
      getOrganizationByExternalId: workos.getOrganizationByExternalId,
      deleteOrganization: workos.deleteOrganization,
    },
    adminPortal: { generateLink: workos.generateLink },
    sso: { listConnections: workos.listConnections },
  } as unknown as WorkosApi;
  return {
    ...original,
    workosProvider: (env: { XECRET_PUBLIC_URL: string; WORKOS_CLIENT_ID?: string }) =>
      new original.WorkosIdentityProvider(api, {
        clientId: env.WORKOS_CLIENT_ID ?? 'client_01TESTCLIENT',
        redirectUri: `${env.XECRET_PUBLIC_URL}/api/auth/callback`,
      }),
  };
});

const ssoRoute = await import('@/app/api/orgs/[orgSlug]/sso/route');
const portalRoute = await import('@/app/api/orgs/[orgSlug]/sso/portal/route');
const { resetWorkosListCacheForTesting, WORKOS_LIST_CACHE_TTL_MS } = await import('./sso-service');

let t: TestDatabase;
let lines: LogEntry[] = [];
let audit: AuditRecord[] = [];
let deferred: Promise<unknown>[] = [];
let env: Record<string, unknown> = {};
let caller: Principal;

beforeAll(async () => {
  t = await createTestDatabase();
  // This database belongs to the test deployment's WorkOS environment, as an
  // operator records it (migration 0023; docs/self-hosting.md).
  await t.pg.query(`update workos_home set client_id = $1`, [CLIENT_ID]);
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  for (const fn of Object.values(workos)) fn.mockReset();
  resetWorkosListCacheForTesting();
  lines = [];
  audit = [];
  deferred = [];
  env = { XECRET_PUBLIC_URL: ORIGIN, XECRET_ENV: 'production', WORKOS_CLIENT_ID: CLIENT_ID };

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
});

/* ── fixtures ─────────────────────────────────────────────────────────────── */

async function seedUser(email?: string): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const address = email ?? `person-${id.slice(0, 8)}@example.com`;
  await t.pg.query(
    `insert into users (id, workos_user_id, email, email_verified) values ($1, $2, $3, true)`,
    [id, `user_01${id.replaceAll('-', '').slice(0, 20)}`, address],
  );
  return { id, email: address };
}

interface Seeded {
  orgId: string;
  slug: string;
  name: string;
}

/** An organisation, its founder an owner, with or without the add-on and a WorkOS link. */
async function seedOrg(
  over: {
    addon?: boolean;
    workosOrgId?: string;
    clientId?: string;
    ssoRequired?: boolean;
    jit?: boolean;
  } = {},
): Promise<Seeded & { founder: { id: string; email: string } }> {
  const founder = await seedUser();
  const orgId = randomUUID();
  const slug = `acme-${orgId.slice(0, 8)}`;
  await t.pg.query(
    `insert into organizations
       (id, name, slug, created_by, workos_org_id, workos_client_id, sso_required, jit_join_enabled)
     values ($1, 'Acme Corp', $2, $3, $4, $5, $6, $7)`,
    [
      orgId,
      slug,
      founder.id,
      over.workosOrgId ?? null,
      over.workosOrgId === undefined ? null : (over.clientId ?? CLIENT_ID),
      over.ssoRequired ?? false,
      over.jit ?? false,
    ],
  );
  await t.pg.query(`insert into org_subscriptions (org_id, addon_saml) values ($1, $2)`, [
    orgId,
    over.addon ?? true,
  ]);
  await addMember(orgId, founder.id, 'owner');
  return { orgId, slug, name: 'Acme Corp', founder };
}

async function addMember(orgId: string, userId: string, role: string, customRoleId?: string) {
  await t.pg.query(
    `insert into org_members (id, org_id, user_id, role, custom_role_id) values ($1, $2, $3, $4, $5)`,
    [randomUUID(), orgId, userId, role, customRoleId ?? null],
  );
}

/** A member of `orgId` at `role`, signed in from a browser. */
async function signedInAs(orgId: string, role: string, customRoleId?: string): Promise<string> {
  const user = await seedUser();
  await addMember(orgId, user.id, role, customRoleId);
  caller = sessionOf(user);
  return user.id;
}

function sessionOf(
  user: { id: string; email: string },
  sessionId: string = randomUUID(),
): Principal {
  return {
    kind: 'user',
    sessionId,
    user: {
      id: user.id,
      email: user.email,
      emailVerified: true,
      displayName: null,
      avatarUrl: null,
    },
    vaultUnlockedAt: new Date(),
    lastSeenAt: new Date(),
    vaultAutoLockMinutes: null,
    signIn: { method: 'password', ssoWorkosOrgId: null },
  };
}

/**
 * The owner as signed in again just now: a real session row recording the
 * fresh authentication that issued it (`fresh_auth_at`, migration 0023) — what
 * the setup portal asks for (review S2, round 2's L7).
 */
async function ownerFreshlySignedIn(
  org: { orgId: string; founder: { id: string; email: string } },
  signedInAt: Date = new Date(),
): Promise<string> {
  const sessionId = randomUUID();
  await t.pg.query(
    `insert into sessions (id, user_id, token_hash, expires_at, fresh_auth_at)
     values ($1, $2, $3, now() + interval '1 day', $4)`,
    [
      sessionId,
      org.founder.id,
      new Uint8Array(32).map(() => Math.floor(Math.random() * 256)),
      signedInAt,
    ],
  );
  caller = sessionOf(org.founder, sessionId);
  return sessionId;
}

async function linkOf(orgId: string) {
  const result = await t.pg.query<{
    workos_org_id: string | null;
    workos_client_id: string | null;
    sso_required: boolean;
    jit_join_enabled: boolean;
  }>(
    `select workos_org_id, workos_client_id, sso_required, jit_join_enabled
       from organizations where id = $1`,
    [orgId],
  );
  return result.rows[0]!;
}

const workosOrgId = () => `org_01${randomUUID().replaceAll('-', '').slice(0, 20).toUpperCase()}`;

/* ── requests ─────────────────────────────────────────────────────────────── */

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

async function call(
  handler: (
    request: Request,
    args?: { params?: Promise<{ orgSlug: string }> },
  ) => Promise<Response>,
  method: string,
  slug: string,
  path = '',
  body?: unknown,
): Promise<Answer> {
  const response = await handler(
    new Request(`${ORIGIN}/api/orgs/${slug}/sso${path}`, {
      method,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ orgSlug: slug }) },
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

const getStatus = (slug: string) => call(ssoRoute.GET, 'GET', slug);
const enable = (slug: string) => call(ssoRoute.POST, 'POST', slug);
const patch = (slug: string, body: unknown) => call(ssoRoute.PATCH, 'PATCH', slug, '', body);
const portal = (slug: string) => call(portalRoute.POST, 'POST', slug, '/portal');

function errorCode(answer: Answer): unknown {
  return (answer.body['error'] as { code?: unknown } | undefined)?.code;
}

function errorMessage(answer: Answer): string {
  return (answer.body['error'] as { message?: string } | undefined)?.message ?? '';
}

function sso(answer: Answer): Record<string, unknown> {
  return answer.body['sso'] as Record<string, unknown>;
}

function workosWasAskedNothing(): void {
  for (const fn of Object.values(workos)) expect(fn).not.toHaveBeenCalled();
}

function connectionsAre(...states: string[]) {
  workos.listConnections.mockResolvedValue({
    data: states.map((state, index) => ({ id: `conn_${index}`, state, type: 'OktaSAML' })),
  });
}

function domainsAre(...domains: Array<[string, string]>) {
  workos.getOrganization.mockResolvedValue({
    id: 'x',
    domains: domains.map(([domain, state]) => ({ domain, state })),
  });
}

/* ── who may ──────────────────────────────────────────────────────────────── */

describe('who may use the SSO settings', () => {
  it.each(['developer', 'viewer'])(
    'refuses a %s every route, audits each attempted change, and asks WorkOS nothing',
    async (role) => {
      const org = await seedOrg();
      const userId = await signedInAs(org.orgId, role);

      for (const answer of [
        await getStatus(org.slug),
        await enable(org.slug),
        await portal(org.slug),
        await patch(org.slug, { ssoRequired: true }),
      ]) {
        expect(answer.status).toBe(403);
        expect(errorCode(answer)).toBe('forbidden');
      }

      workosWasAskedNothing();
      expect((await linkOf(org.orgId)).workos_org_id).toBeNull();
      // A read files nothing; each refused change files a denial of what it
      // reached for, against the organisation, by this caller.
      expect(audit.map((e) => [e.action, e.outcome, e.actorId])).toEqual([
        ['org.sso.enabled', 'denied', userId],
        ['org.sso.portal_link_created', 'denied', userId],
        ['org.sso.required_toggled', 'denied', userId],
        ['org.sso.jit_toggled', 'denied', userId],
      ]);
      expect(audit.every((e) => e.orgId === org.orgId)).toBe(true);
    },
  );

  it('refuses an admin everything that points the organisation at an identity provider (review S2)', async () => {
    // An admin able to enable SSO, open the portal or require it could wire the
    // organisation to an identity provider of their own and sign in as any
    // member — an owner included. Owners only.
    const linked = workosOrgId();
    const org = await seedOrg({ workosOrgId: linked });
    const userId = await signedInAs(org.orgId, 'admin');
    connectionsAre('active');
    domainsAre(['acme.example', 'verified']);

    for (const answer of [
      await portal(org.slug),
      await patch(org.slug, { ssoRequired: true }),
      await patch(org.slug, { jitJoinEnabled: true }),
    ]) {
      expect(answer.status).toBe(403);
      expect(errorCode(answer)).toBe('forbidden');
    }
    expect(workos.generateLink).not.toHaveBeenCalled();
    expect(await linkOf(org.orgId)).toMatchObject({ sso_required: false, jit_join_enabled: false });
    expect(audit.map((e) => [e.action, e.outcome, e.actorId])).toEqual([
      ['org.sso.portal_link_created', 'denied', userId],
      ['org.sso.required_toggled', 'denied', userId],
      ['org.sso.jit_toggled', 'denied', userId],
    ]);

    // And turning it on, on an organisation that has not.
    const fresh = await seedOrg();
    await signedInAs(fresh.orgId, 'admin');
    const answer = await enable(fresh.slug);
    expect(answer.status).toBe(403);
    expect(workos.createOrganization).not.toHaveBeenCalled();
  });

  it('lets an admin read the settings and switch a policy off', async () => {
    const org = await seedOrg({ workosOrgId: workosOrgId(), ssoRequired: true, jit: true });
    caller = sessionOf(org.founder); // the owner signs in; the admin works through it below
    await signedInAs(org.orgId, 'admin');
    // An admin of an organisation that requires SSO reaches it through its SSO.
    caller = {
      ...(caller as Extract<Principal, { kind: 'user' }>),
      signIn: { method: 'sso', ssoWorkosOrgId: (await linkOf(org.orgId)).workos_org_id },
    };
    connectionsAre('active');
    domainsAre(['acme.example', 'verified']);

    expect((await getStatus(org.slug)).status).toBe(200);
    const off = await patch(org.slug, { ssoRequired: false, jitJoinEnabled: false });
    expect(off.status).toBe(200);
    expect(await linkOf(org.orgId)).toMatchObject({ sso_required: false, jit_join_enabled: false });
  });

  it('refuses an admin whose custom role took org.update away', async () => {
    // The same `can()` every organisation setting goes through: a narrowed
    // admin is refused here as they are on the rename.
    const org = await seedOrg();
    const roleId = randomUUID();
    await t.pg.query(
      `insert into custom_roles (id, org_id, name, base_role, allowed_actions)
       values ($1, $2, 'Member manager', 'admin', $3)`,
      [roleId, org.orgId, ['member.read', 'member.invite', 'member.update', 'member.remove']],
    );
    await signedInAs(org.orgId, 'admin', roleId);

    expect((await enable(org.slug)).status).toBe(403);
    expect((await getStatus(org.slug)).status).toBe(403);
    workosWasAskedNothing();
  });

  it('answers 404 to somebody who is not a member, exactly as for a slug that does not exist', async () => {
    const org = await seedOrg();
    caller = sessionOf(await seedUser());

    expect((await enable(org.slug)).status).toBe(404);
    expect((await getStatus('no-such-organisation')).status).toBe(404);
    workosWasAskedNothing();
    expect(audit).toEqual([]);
  });

  it('refuses a CLI token, even its owner’s, before resolving anything', async () => {
    const org = await seedOrg();
    caller = {
      kind: 'cliToken',
      tokenId: randomUUID(),
      tokenName: 'laptop',
      userId: org.founder.id,
      orgId: org.orgId,
      signIn: { method: null, ssoWorkosOrgId: null },
    };

    for (const answer of [
      await getStatus(org.slug),
      await enable(org.slug),
      await portal(org.slug),
      await patch(org.slug, { jitJoinEnabled: true }),
    ]) {
      expect(answer.status).toBe(403);
      expect((answer.body['error'] as { message: string }).message).toMatch(/browser session/);
    }
    workosWasAskedNothing();
  });

  it('lets an owner and an admin read the status', async () => {
    const org = await seedOrg();

    caller = sessionOf(org.founder);
    expect((await getStatus(org.slug)).status).toBe(200);

    await signedInAs(org.orgId, 'admin');
    expect((await getStatus(org.slug)).status).toBe(200);
  });

  it('spends the mutation rate limit on every change, keyed by the caller', async () => {
    const org = await seedOrg();
    caller = sessionOf(org.founder);
    const keys: string[] = [];
    env['RL_MUTATION'] = {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: false };
      },
    };

    for (const answer of [
      await enable(org.slug),
      await portal(org.slug),
      await patch(org.slug, { jitJoinEnabled: true }),
    ]) {
      expect(answer.status).toBe(429);
    }
    expect(keys).toEqual([org.founder.id, org.founder.id, org.founder.id]);
    workosWasAskedNothing();
  });
});

/* ── POST /sso: turning it on ─────────────────────────────────────────────── */

describe('turning SSO on', () => {
  it('creates the WorkOS organisation with a name and the organisation id, and no domains at all', async () => {
    const org = await seedOrg();
    caller = sessionOf(org.founder);
    const created = workosOrgId();
    workos.createOrganization.mockResolvedValue({ id: created });

    const answer = await enable(org.slug);

    expect(answer.status).toBe(201);
    expect(workos.createOrganization).toHaveBeenCalledTimes(1);
    const [payload, options] = workos.createOrganization.mock.calls[0]!;
    // PR #114: never `domainData`, verified or otherwise. Domains are WorkOS's
    // to verify, and the callback trusts only what it reports as verified.
    expect(payload).toEqual({ name: org.name, externalId: org.orgId });
    expect(Object.keys(payload as object)).not.toContain('domainData');
    expect(options).toEqual({ idempotencyKey: `xecret-sso-enable-${org.orgId}` });

    // The link, and the WorkOS environment it was made in (review S9).
    expect(await linkOf(org.orgId)).toEqual({
      workos_org_id: created,
      workos_client_id: CLIENT_ID,
      sso_required: false,
      jit_join_enabled: false,
    });
    expect(sso(answer)).toEqual({
      enabled: true,
      ssoRequired: false,
      jitJoinEnabled: false,
      seatLimit: 5,
      addon: { enabled: true },
      connections: [],
      domains: [],
      membersOutsideVerifiedDomains: null,
      providerReachable: true,
    });
    // The WorkOS id is nobody's business on the client.
    expect(JSON.stringify(answer.body)).not.toContain(created);

    const enabled = audit.filter((e) => e.action === 'org.sso.enabled');
    expect(enabled).toHaveLength(1);
    expect(enabled[0]).toMatchObject({
      outcome: 'success',
      orgId: org.orgId,
      resourceId: org.orgId,
    });
  });

  it('is idempotent: a second enable creates nothing, files nothing, and answers the status', async () => {
    const org = await seedOrg();
    caller = sessionOf(org.founder);
    const created = workosOrgId();
    workos.createOrganization.mockResolvedValue({ id: created });
    expect((await enable(org.slug)).status).toBe(201);
    audit = [];
    domainsAre();
    connectionsAre();

    const again = await enable(org.slug);

    expect(again.status).toBe(200);
    expect(sso(again)['enabled']).toBe(true);
    expect(workos.createOrganization).toHaveBeenCalledTimes(1);
    expect((await linkOf(org.orgId)).workos_org_id).toBe(created);
    expect(audit).toEqual([]);
  });

  it('answers two concurrent enables with one 201 and one 200, and files `org.sso.enabled` once (review C5)', async () => {
    // WorkOS's idempotency key hands both requests the same organisation; the
    // setter used to answer both as having linked it.
    const org = await seedOrg();
    caller = sessionOf(org.founder);
    const created = workosOrgId();
    workos.createOrganization.mockResolvedValue({ id: created });
    domainsAre();
    connectionsAre();

    const answers = await Promise.all([enable(org.slug), enable(org.slug)]);

    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 201]);
    expect(audit.filter((e) => e.action === 'org.sso.enabled')).toHaveLength(1);
    expect((await linkOf(org.orgId)).workos_org_id).toBe(created);
  });

  it('refuses an organisation without the add-on, files why, and asks WorkOS nothing', async () => {
    const org = await seedOrg({ addon: false });
    caller = sessionOf(org.founder);

    const answer = await enable(org.slug);

    expect(answer.status).toBe(403);
    expect(errorCode(answer)).toBe('plan_limit');
    workosWasAskedNothing();
    expect((await linkOf(org.orgId)).workos_org_id).toBeNull();
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'org.sso.enabled',
        outcome: 'error',
        metadata: expect.objectContaining({ reason: 'quotaExceeded', addonName: 'saml' }),
      }),
    ]);
  });

  it('adopts the WorkOS organisation an earlier, half-finished attempt left behind', async () => {
    // Created at WorkOS, never linked here (the database write was lost), and
    // past WorkOS's idempotency window: the externalId is taken (409). Only
    // this deployment's key creates organisations there, with this id.
    const org = await seedOrg();
    caller = sessionOf(org.founder);
    const earlier = workosOrgId();
    workos.createOrganization.mockRejectedValue({ status: 409, code: 'conflict' });
    workos.getOrganizationByExternalId.mockResolvedValue({ id: earlier, externalId: org.orgId });

    const answer = await enable(org.slug);

    expect(answer.status).toBe(201);
    expect(workos.getOrganizationByExternalId).toHaveBeenCalledWith(org.orgId);
    expect((await linkOf(org.orgId)).workos_org_id).toBe(earlier);
  });

  it('links nothing when WorkOS is down, says to try again, and files the failure', async () => {
    const org = await seedOrg();
    caller = sessionOf(org.founder);
    workos.createOrganization.mockRejectedValue({ status: 503 });

    const answer = await enable(org.slug);

    expect(answer.status).toBe(503);
    expect(errorMessage(answer)).toMatch(/nothing was changed/);
    expect(errorMessage(answer)).toMatch(/Try again/);
    expect((await linkOf(org.orgId)).workos_org_id).toBeNull();
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'org.sso.enabled',
        outcome: 'error',
        metadata: { reason: 'upstreamUnavailable' },
      }),
    ]);
  });

  it('tells a WorkOS refusal from an outage: a 502 naming WorkOS’s category, not "try again" (review C7)', async () => {
    const org = await seedOrg();
    caller = sessionOf(org.founder);
    workos.createOrganization.mockRejectedValue({ status: 422, code: 'invalid_organization_name' });

    const answer = await enable(org.slug);

    expect(answer.status).toBe(502);
    expect(errorCode(answer)).toBe('upstream_refused');
    expect(errorMessage(answer)).toContain('invalid_organization_name');
    expect(errorMessage(answer)).not.toMatch(/could not be reached|Try again/);
    expect((await linkOf(org.orgId)).workos_org_id).toBeNull();
  });

  it('losing a race to another enable deletes its own orphan and answers with the winner', async () => {
    const org = await seedOrg();
    caller = sessionOf(org.founder);
    const winner = workosOrgId();
    const orphan = workosOrgId();
    // The other request links its WorkOS organisation while this one is
    // still waiting on WorkOS for its own.
    workos.createOrganization.mockImplementation(async () => {
      await t.pg.query(
        `update organizations set workos_org_id = $2, workos_client_id = $3 where id = $1`,
        [org.orgId, winner, CLIENT_ID],
      );
      return { id: orphan };
    });
    workos.deleteOrganization.mockResolvedValue(undefined);
    domainsAre();
    connectionsAre();

    const answer = await enable(org.slug);
    await Promise.allSettled(deferred);

    expect(answer.status).toBe(200);
    expect(sso(answer)['enabled']).toBe(true);
    expect((await linkOf(org.orgId)).workos_org_id).toBe(winner);
    expect(workos.deleteOrganization).toHaveBeenCalledWith(orphan);
    expect(workos.deleteOrganization).not.toHaveBeenCalledWith(winner);
    // The winner filed `org.sso.enabled`; this request linked nothing.
    expect(audit.map((e) => e.action)).not.toContain('org.sso.enabled');
  });

  it('never adopts a link another WorkOS environment made, answering why (review S9)', async () => {
    // Local development runs against WorkOS Staging over the production
    // database; its enable must not pass for production's, nor the reverse.
    const org = await seedOrg({ workosOrgId: workosOrgId(), clientId: 'client_01STAGING' });
    caller = sessionOf(org.founder);

    const answer = await enable(org.slug);

    expect(answer.status).toBe(409);
    expect(errorMessage(answer)).toMatch(/different WorkOS environment/);
    workosWasAskedNothing();
    expect(audit).toEqual([
      expect.objectContaining({ action: 'org.sso.enabled', outcome: 'error' }),
    ]);
  });

  /** Runs `body` with `workos_home` set as asked, restoring the test environment's after. */
  async function withHome(clientId: string | null, body: () => Promise<void>): Promise<void> {
    await t.pg.query(`delete from workos_home`);
    if (clientId !== null) {
      await t.pg.query(`insert into workos_home (id, client_id) values (true, $1)`, [clientId]);
    }
    try {
      await body();
    } finally {
      await t.pg.query(`delete from workos_home`);
      await t.pg.query(`insert into workos_home (id, client_id) values (true, $1)`, [CLIENT_ID]);
    }
  }

  it('writes no link from a deployment whose WorkOS environment this database does not belong to (review round 2)', async () => {
    // Round 1 refused to act on a foreign link; nothing stopped one being
    // written. Local development (Staging) clicking Enable on an unlinked
    // production organisation wrote a permanent Staging link.
    const org = await seedOrg();
    caller = sessionOf(org.founder);

    await withHome('client_01PRODUCTIONHOME', async () => {
      const answer = await enable(org.slug);

      expect(answer.status).toBe(409);
      expect(errorMessage(answer)).toMatch(/different WorkOS environment/);
      expect(errorMessage(answer)).toMatch(/nothing was changed/);
      // Review round 3: a self-hosted database still holding the client id
      // 0023 seeded lands here too, and "make this change from that
      // deployment" alone was a dead end — so the message, and the log line,
      // name the operator step and where it is written down.
      expect(errorMessage(answer)).toMatch(/UPDATE workos_home SET client_id/);
      expect(errorMessage(answer)).toMatch(/docs\/self-hosting\.md/);
      const warning = lines.find(
        (line) => line.level === 'warn' && line.message.includes('Refused an SSO change'),
      );
      expect(warning?.message).toMatch(/UPDATE workos_home SET client_id/);
      expect(warning?.message).toMatch(/docs\/self-hosting\.md/);
      expect(warning).toMatchObject({
        clientId: CLIENT_ID,
        recordedClientId: 'client_01PRODUCTIONHOME',
      });
      workosWasAskedNothing();
      expect((await linkOf(org.orgId)).workos_org_id).toBeNull();
      expect(audit).toEqual([
        expect.objectContaining({
          action: 'org.sso.enabled',
          outcome: 'error',
          metadata: { reason: 'conflict' },
        }),
      ]);
    });
  });

  it('refuses to turn SSO on at all while the database has no WorkOS environment recorded, naming the step', async () => {
    const org = await seedOrg();
    caller = sessionOf(org.founder);

    await withHome(null, async () => {
      const answer = await enable(org.slug);

      expect(answer.status).toBe(409);
      expect(errorMessage(answer)).toMatch(/self-hosting/);
      workosWasAskedNothing();
      expect((await linkOf(org.orgId)).workos_org_id).toBeNull();
    });
  });

  it('refuses to switch a policy on, or open the portal, from such a deployment — and still lets one off', async () => {
    const org = await seedOrg({ workosOrgId: workosOrgId(), jit: true });

    await withHome('client_01PRODUCTIONHOME', async () => {
      await ownerFreshlySignedIn(org);
      const portalAnswer = await portal(org.slug);
      expect(portalAnswer.status).toBe(409);
      expect(workos.generateLink).not.toHaveBeenCalled();

      caller = sessionOf(org.founder);
      connectionsAre('active');
      domainsAre(['example.com', 'verified']);
      const on = await patch(org.slug, { ssoRequired: true });
      expect(on.status).toBe(409);
      expect((await linkOf(org.orgId)).sso_required).toBe(false);

      // Relaxing a policy can never lock anybody out, from anywhere.
      const off = await patch(org.slug, { jitJoinEnabled: false });
      expect(off.status).toBe(200);
      expect((await linkOf(org.orgId)).jit_join_enabled).toBe(false);
    });
  });
});

/* ── POST /sso/portal ─────────────────────────────────────────────────────── */

describe('the setup portal link', () => {
  it('mints an SSO Admin Portal link for an owner who signed in again just now, and audits it', async () => {
    const linked = workosOrgId();
    const org = await seedOrg({ workosOrgId: linked });
    await ownerFreshlySignedIn(org);
    const link = 'https://setup.workos.com/portal/launch?secret=not-a-real-one';
    workos.generateLink.mockResolvedValue({ link });

    const answer = await portal(org.slug);

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ link });
    expect(workos.generateLink).toHaveBeenCalledWith({
      organization: linked,
      intent: 'sso',
      returnUrl: `${ORIGIN}/app/${org.slug}/settings#single-sign-on`,
    });
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'org.sso.portal_link_created',
        outcome: 'success',
        orgId: org.orgId,
        actorId: org.founder.id,
        resourceType: 'org',
        resourceId: org.orgId,
      }),
    ]);
    // A credential for a few minutes: in the response, and nowhere else.
    expect(JSON.stringify(audit)).not.toContain('not-a-real-one');
    expect(JSON.stringify(lines)).not.toContain('not-a-real-one');
  });

  it('refuses an owner whose session has not signed in again, asking for exactly that (review S2)', async () => {
    const org = await seedOrg({ workosOrgId: workosOrgId() });
    caller = sessionOf(org.founder);

    const answer = await portal(org.slug);

    expect(answer.status).toBe(403);
    expect(errorCode(answer)).toBe('reauth_required');
    expect(workos.generateLink).not.toHaveBeenCalled();
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'org.sso.portal_link_created',
        outcome: 'error',
        metadata: { reason: 'invalidCredentials' },
      }),
    ]);
  });

  it('refuses a fresh sign-in that is no longer fresh, or that was another session’s', async () => {
    const org = await seedOrg({ workosOrgId: workosOrgId() });
    await ownerFreshlySignedIn(org, new Date(Date.now() - 11 * 60_000));
    expect(errorCode(await portal(org.slug))).toBe('reauth_required');

    await ownerFreshlySignedIn(org);
    caller = sessionOf(org.founder); // the same owner, from a different session
    expect(errorCode(await portal(org.slug))).toBe('reauth_required');
    expect(workos.generateLink).not.toHaveBeenCalled();
  });

  it('refuses before SSO is on, files the attempt, and asks WorkOS nothing', async () => {
    const org = await seedOrg();
    await ownerFreshlySignedIn(org);

    const answer = await portal(org.slug);

    expect(answer.status).toBe(409);
    workosWasAskedNothing();
    expect(audit).toEqual([
      expect.objectContaining({ action: 'org.sso.portal_link_created', outcome: 'error' }),
    ]);
  });

  it('refuses once the add-on has lapsed', async () => {
    const org = await seedOrg({ workosOrgId: workosOrgId(), addon: false });
    await ownerFreshlySignedIn(org);

    const answer = await portal(org.slug);

    expect(answer.status).toBe(403);
    expect(errorCode(answer)).toBe('plan_limit');
    workosWasAskedNothing();
  });

  it('refuses a link another WorkOS environment made (review S9)', async () => {
    const org = await seedOrg({ workosOrgId: workosOrgId(), clientId: 'client_01STAGING' });
    await ownerFreshlySignedIn(org);

    const answer = await portal(org.slug);

    expect(answer.status).toBe(409);
    workosWasAskedNothing();
  });

  it('never hands the dashboard something that is not an https page', async () => {
    const org = await seedOrg({ workosOrgId: workosOrgId() });
    await ownerFreshlySignedIn(org);

    for (const link of ['javascript:alert(1)', '/relative', 'http://setup.workos.com/x', '']) {
      workos.generateLink.mockResolvedValueOnce({ link });
      const answer = await portal(org.slug);
      expect(answer.status).toBe(502);
      expect(answer.body['link']).toBeUndefined();
    }
    expect(audit.map((e) => [e.action, e.outcome])).toEqual(
      Array.from({ length: 4 }, () => ['org.sso.portal_link_created', 'error']),
    );
  });
});

/* ── GET /sso ─────────────────────────────────────────────────────────────── */

describe('the status', () => {
  it('answers from the row alone while SSO is off, asking WorkOS nothing', async () => {
    const org = await seedOrg();
    await signedInAs(org.orgId, 'admin');

    const answer = await getStatus(org.slug);

    expect(answer.status).toBe(200);
    expect(sso(answer)).toEqual({
      enabled: false,
      ssoRequired: false,
      jitJoinEnabled: false,
      seatLimit: 5,
      addon: { enabled: true },
      connections: null,
      domains: null,
      membersOutsideVerifiedDomains: null,
      providerReachable: true,
    });
    workosWasAskedNothing();
  });

  it('lists the connections and domains WorkOS reports once SSO is on', async () => {
    const linked = workosOrgId();
    const org = await seedOrg({ workosOrgId: linked, jit: true });
    caller = sessionOf(org.founder);
    workos.listConnections.mockResolvedValue({
      data: [
        { id: 'conn_1', state: 'active', type: 'OktaSAML', name: 'Acme', domains: [] },
        { id: 'conn_2', state: 'draft', type: 'GenericOIDC', name: 'Acme', domains: [] },
      ],
    });
    workos.getOrganization.mockResolvedValue({
      id: linked,
      domains: [
        { domain: 'Acme.example', state: 'verified' },
        { domain: 'acme-labs.example', state: 'pending' },
      ],
    });

    const answer = await getStatus(org.slug);

    expect(answer.status).toBe(200);
    expect(workos.listConnections).toHaveBeenCalledWith({ organizationId: linked, limit: 100 });
    expect(sso(answer)).toMatchObject({
      enabled: true,
      jitJoinEnabled: true,
      connections: [
        { id: 'conn_1', state: 'active', type: 'OktaSAML' },
        { id: 'conn_2', state: 'draft', type: 'GenericOIDC' },
      ],
      domains: [
        { domain: 'acme.example', state: 'verified' },
        { domain: 'acme-labs.example', state: 'pending' },
      ],
      providerReachable: true,
    });
    expect(JSON.stringify(answer.body)).not.toContain(linked);
  });

  it('counts the members whose address is outside the verified domains — who would be shut out (review C2)', async () => {
    const org = await seedOrg({ workosOrgId: workosOrgId() });
    caller = sessionOf(org.founder); // the founder, an owner, is exempt and not counted
    for (const email of [
      `a-${randomUUID().slice(0, 6)}@acme.example`,
      `b-${randomUUID().slice(0, 6)}@ACME.example`,
      `c-${randomUUID().slice(0, 6)}@contractor.example`,
      `d-${randomUUID().slice(0, 6)}@acme-labs.example`,
    ]) {
      const member = await seedUser(email);
      await addMember(org.orgId, member.id, 'developer');
    }
    connectionsAre('active');
    domainsAre(['acme.example', 'verified'], ['acme-labs.example', 'pending']);

    const answer = await getStatus(org.slug);

    // The contractor, and the pending domain's member.
    expect(sso(answer)['membersOutsideVerifiedDomains']).toBe(2);
  });

  it('still answers, without the lists, when WorkOS cannot be reached', async () => {
    const org = await seedOrg({ workosOrgId: workosOrgId(), ssoRequired: true });
    caller = sessionOf(org.founder);
    workos.listConnections.mockRejectedValue({ status: 502 });
    workos.getOrganization.mockRejectedValue({ status: 502 });

    const answer = await getStatus(org.slug);

    expect(answer.status).toBe(200);
    expect(sso(answer)).toMatchObject({
      enabled: true,
      ssoRequired: true,
      connections: null,
      domains: null,
      membersOutsideVerifiedDomains: null,
      providerReachable: false,
    });
  });

  it('refuses, with a reason, a link made in another WorkOS environment (review S9)', async () => {
    const org = await seedOrg({ workosOrgId: workosOrgId(), clientId: 'client_01STAGING' });
    caller = sessionOf(org.founder);

    const answer = await getStatus(org.slug);

    expect(answer.status).toBe(409);
    expect(errorMessage(answer)).toMatch(/different WorkOS environment/);
    workosWasAskedNothing();
  });

  it('reuses what WorkOS said for a few seconds, so a reloading page does not spend its rate limit (review S7)', async () => {
    const org = await seedOrg({ workosOrgId: workosOrgId() });
    caller = sessionOf(org.founder);
    connectionsAre('active');
    domainsAre(['acme.example', 'verified']);
    vi.useFakeTimers({ toFake: ['Date'] });

    await getStatus(org.slug);
    await getStatus(org.slug);
    await getStatus(org.slug);
    expect(workos.listConnections).toHaveBeenCalledTimes(1);
    expect(workos.getOrganization).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + WORKOS_LIST_CACHE_TTL_MS + 1);
    await getStatus(org.slug);
    expect(workos.listConnections).toHaveBeenCalledTimes(2);
  });

  it('does not answer one organisation from another’s cached lists', async () => {
    const one = await seedOrg({ workosOrgId: workosOrgId() });
    const two = await seedOrg({ workosOrgId: workosOrgId() });
    connectionsAre('active');
    domainsAre(['one.example', 'verified']);
    caller = sessionOf(one.founder);
    await getStatus(one.slug);

    connectionsAre('draft');
    domainsAre(['two.example', 'pending']);
    caller = sessionOf(two.founder);
    const answer = await getStatus(two.slug);

    expect(sso(answer)['connections']).toEqual([
      { id: 'conn_0', state: 'draft', type: 'OktaSAML' },
    ]);
  });
});

/* ── PATCH /sso: the two policies ─────────────────────────────────────────── */

describe('the sign-in policies', () => {
  it('requires SSO once a connection is active and a domain verified, audits it, and counts who it holds back', async () => {
    const linked = workosOrgId();
    const org = await seedOrg({ workosOrgId: linked });
    caller = sessionOf(org.founder);
    connectionsAre('draft', 'active');
    domainsAre(['acme.example', 'verified']);
    // A developer with a password session and a CLI token approved from it,
    // and one with this organisation's own SSO: only the first two count.
    const developer = await seedUser();
    await addMember(org.orgId, developer.id, 'developer');
    await t.pg.query(
      `insert into sessions (id, user_id, token_hash, expires_at, sign_in_method)
       values ($1, $2, $3, now() + interval '1 day', 'password'),
              ($4, $2, $5, now() + interval '1 day', 'sso')`,
      [
        randomUUID(),
        developer.id,
        new Uint8Array(32).fill(7),
        randomUUID(),
        new Uint8Array(32).fill(8),
      ],
    );
    await t.pg.query(
      `update sessions set sso_workos_org_id = $2 where user_id = $1 and sign_in_method = 'sso'`,
      [developer.id, linked],
    );
    await t.pg.query(
      `insert into cli_tokens (id, user_id, org_id, name, token_hash, token_prefix)
       values ($1, $2, $3, 'laptop', $4, 'xct_live_ab')`,
      [randomUUID(), developer.id, org.orgId, new Uint8Array(32).fill(9)],
    );

    const answer = await patch(org.slug, { ssoRequired: true });

    expect(answer.status).toBe(200);
    expect(sso(answer)['ssoRequired']).toBe(true);
    expect(answer.body['nonSsoAccess']).toEqual({ sessions: 1, cliTokens: 1 });
    expect((await linkOf(org.orgId)).sso_required).toBe(true);
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'org.sso.required_toggled',
        outcome: 'success',
        actorId: org.founder.id,
        metadata: { enabled: true },
      }),
    ]);
  });

  it('refuses to require SSO without an active connection — only owners could sign in', async () => {
    const org = await seedOrg({ workosOrgId: workosOrgId() });
    caller = sessionOf(org.founder);
    connectionsAre('draft', 'validating', 'inactive');
    domainsAre(['acme.example', 'verified']);

    const answer = await patch(org.slug, { ssoRequired: true });

    expect(answer.status).toBe(409);
    expect((await linkOf(org.orgId)).sso_required).toBe(false);
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'org.sso.required_toggled',
        outcome: 'error',
        metadata: { reason: 'invalidInput' },
      }),
    ]);
  });

  it('refuses to require SSO without a verified domain, even with an active connection (review C2)', async () => {
    const org = await seedOrg({ workosOrgId: workosOrgId() });
    caller = sessionOf(org.founder);
    connectionsAre('active');
    domainsAre(['acme.example', 'pending'], ['acme-labs.example', 'failed']);

    const answer = await patch(org.slug, { ssoRequired: true });

    expect(answer.status).toBe(409);
    expect(errorMessage(answer)).toMatch(/verified domain/);
    expect((await linkOf(org.orgId)).sso_required).toBe(false);
  });

  it('asks WorkOS itself before requiring SSO, never the settings’ cache', async () => {
    const org = await seedOrg({ workosOrgId: workosOrgId() });
    caller = sessionOf(org.founder);
    connectionsAre('active');
    domainsAre(['acme.example', 'verified']);
    await getStatus(org.slug); // cached: active

    connectionsAre('inactive'); // the connection was switched off at WorkOS since
    const answer = await patch(org.slug, { ssoRequired: true });

    expect(answer.status).toBe(409);
  });

  it('gates a request for "on" on what it asks for, even when the row already says on (review C4)', async () => {
    // Comparing with a snapshot read before the lock let a request skip the
    // gates while a concurrent one switched the flag off. Asking for "on" now
    // passes the gates for "on" every time.
    const org = await seedOrg({ workosOrgId: workosOrgId(), ssoRequired: true, addon: false });
    caller = sessionOf(org.founder);
    connectionsAre('active');
    domainsAre(['acme.example', 'verified']);

    const lapsed = await patch(org.slug, { ssoRequired: true });
    expect(lapsed.status).toBe(403);
    expect(errorCode(lapsed)).toBe('plan_limit');

    const withAddon = await seedOrg({ workosOrgId: workosOrgId(), ssoRequired: true });
    caller = sessionOf(withAddon.founder);
    connectionsAre('inactive');
    expect((await patch(withAddon.slug, { ssoRequired: true })).status).toBe(409);
  });

  it('refuses either policy before SSO is on, asking WorkOS nothing', async () => {
    const org = await seedOrg();
    caller = sessionOf(org.founder);

    for (const body of [{ ssoRequired: true }, { jitJoinEnabled: true }]) {
      expect((await patch(org.slug, body)).status).toBe(409);
    }
    workosWasAskedNothing();
    expect(await linkOf(org.orgId)).toEqual({
      workos_org_id: null,
      workos_client_id: null,
      sso_required: false,
      jit_join_enabled: false,
    });
  });

  it('refuses switching a policy on for a link another WorkOS environment made, but lets one be switched off (review S9)', async () => {
    const org = await seedOrg({
      workosOrgId: workosOrgId(),
      clientId: 'client_01STAGING',
      jit: true,
    });
    caller = sessionOf(org.founder);

    expect((await patch(org.slug, { ssoRequired: true })).status).toBe(409);
    const off = await patch(org.slug, { jitJoinEnabled: false });
    expect(off.status).toBe(200);
    expect((await linkOf(org.orgId)).jit_join_enabled).toBe(false);
    workosWasAskedNothing();
  });

  it('opts in to just-in-time joins, and out again, auditing each move', async () => {
    const org = await seedOrg({ workosOrgId: workosOrgId() });
    caller = sessionOf(org.founder);
    connectionsAre('active');
    domainsAre();

    expect((await patch(org.slug, { jitJoinEnabled: true })).status).toBe(200);
    expect((await linkOf(org.orgId)).jit_join_enabled).toBe(true);
    expect((await patch(org.slug, { jitJoinEnabled: false })).status).toBe(200);
    expect((await linkOf(org.orgId)).jit_join_enabled).toBe(false);

    expect(audit.map((e) => [e.action, e.metadata.enabled])).toEqual([
      ['org.sso.jit_toggled', true],
      ['org.sso.jit_toggled', false],
    ]);
  });

  it('files nothing for a switch already where it was asked to be', async () => {
    const org = await seedOrg({ workosOrgId: workosOrgId(), jit: true });
    caller = sessionOf(org.founder);
    connectionsAre('active');
    domainsAre();

    expect((await patch(org.slug, { jitJoinEnabled: true, ssoRequired: false })).status).toBe(200);
    expect(audit).toEqual([]);
  });

  it('lets a policy be switched off after the add-on lapsed, but not on', async () => {
    const org = await seedOrg({ workosOrgId: workosOrgId(), addon: false, ssoRequired: true });
    caller = sessionOf(org.founder);
    connectionsAre('active');
    domainsAre();

    const on = await patch(org.slug, { jitJoinEnabled: true });
    expect(on.status).toBe(403);
    expect(errorCode(on)).toBe('plan_limit');

    const off = await patch(org.slug, { ssoRequired: false });
    expect(off.status).toBe(200);
    expect(off.body['nonSsoAccess']).toBeNull();
    expect(await linkOf(org.orgId)).toMatchObject({ sso_required: false, jit_join_enabled: false });
    expect(audit.map((e) => [e.action, e.outcome])).toEqual([
      ['org.sso.jit_toggled', 'error'],
      ['org.sso.required_toggled', 'success'],
    ]);
  });

  it.each([
    ['a string where a boolean belongs', { ssoRequired: 'true' }],
    ['a misspelt field', { ssoRequried: true }],
    ['an empty patch', {}],
  ])('refuses %s with 422, changing nothing', async (_label, body) => {
    const org = await seedOrg({ workosOrgId: workosOrgId() });
    caller = sessionOf(org.founder);

    const answer = await patch(org.slug, body);

    expect(answer.status).toBe(422);
    expect(await linkOf(org.orgId)).toMatchObject({ sso_required: false, jit_join_enabled: false });
    workosWasAskedNothing();
  });

  it('refuses to require SSO when WorkOS cannot say whether a connection is active', async () => {
    const org = await seedOrg({ workosOrgId: workosOrgId() });
    caller = sessionOf(org.founder);
    workos.listConnections.mockRejectedValue({ status: 500 });
    domainsAre(['acme.example', 'verified']);

    const answer = await patch(org.slug, { ssoRequired: true });

    expect(answer.status).toBe(503);
    expect((await linkOf(org.orgId)).sso_required).toBe(false);
  });

  it('answers the setter’s own refusal in the ordinary envelope, filing it (review C7)', async () => {
    // The gates saw a link; by the time the setter holds the lock there is
    // none. Nothing in the product can do that — the test stands in for the
    // next thing that might.
    const org = await seedOrg({ workosOrgId: workosOrgId() });
    caller = sessionOf(org.founder);
    domainsAre();
    workos.listConnections.mockImplementation(async () => {
      await t.pg.query(
        `update organizations set workos_org_id = null, workos_client_id = null where id = $1`,
        [org.orgId],
      );
      return { data: [{ id: 'conn_0', state: 'active', type: 'OktaSAML' }] };
    });
    domainsAre(['acme.example', 'verified']);

    const answer = await patch(org.slug, { ssoRequired: true });

    expect(answer.status).toBe(409);
    expect(errorCode(answer)).toBe('conflict');
    expect(errorMessage(answer)).toMatch(/not set up/);
    expect(audit).toEqual([
      expect.objectContaining({ action: 'org.sso.required_toggled', outcome: 'error' }),
    ]);
  });
});

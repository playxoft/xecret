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
 * (`setOrgWorkosOrgId`, `updateOrgSsoSettings`); the WorkOS provider's own
 * code, down to the SDK calls.
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
    workosProvider: (env: { XECRET_PUBLIC_URL: string }) =>
      new original.WorkosIdentityProvider(api, {
        clientId: 'client_01TESTCLIENT',
        redirectUri: `${env.XECRET_PUBLIC_URL}/api/auth/callback`,
      }),
  };
});

const ssoRoute = await import('@/app/api/orgs/[orgSlug]/sso/route');
const portalRoute = await import('@/app/api/orgs/[orgSlug]/sso/portal/route');

let t: TestDatabase;
let lines: LogEntry[] = [];
let audit: AuditRecord[] = [];
let deferred: Promise<unknown>[] = [];
let env: Record<string, unknown> = {};
let caller: Principal;

beforeAll(async () => {
  t = await createTestDatabase();
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(workos)) fn.mockReset();
  lines = [];
  audit = [];
  deferred = [];
  env = { XECRET_PUBLIC_URL: ORIGIN, XECRET_ENV: 'production' };

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

async function seedUser(): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `person-${id.slice(0, 8)}@example.com`;
  await t.pg.query(
    `insert into users (id, workos_user_id, email, email_verified) values ($1, $2, $3, true)`,
    [id, `user_01${id.replaceAll('-', '').slice(0, 20)}`, email],
  );
  return { id, email };
}

interface Seeded {
  orgId: string;
  slug: string;
  name: string;
}

/** An organisation, its founder an owner, with or without the add-on and a WorkOS link. */
async function seedOrg(
  over: { addon?: boolean; workosOrgId?: string; ssoRequired?: boolean; jit?: boolean } = {},
): Promise<Seeded & { founder: { id: string; email: string } }> {
  const founder = await seedUser();
  const orgId = randomUUID();
  const slug = `acme-${orgId.slice(0, 8)}`;
  await t.pg.query(
    `insert into organizations (id, name, slug, created_by, workos_org_id, sso_required, jit_join_enabled)
     values ($1, 'Acme Corp', $2, $3, $4, $5, $6)`,
    [
      orgId,
      slug,
      founder.id,
      over.workosOrgId ?? null,
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

function sessionOf(user: { id: string; email: string }): Principal {
  return {
    kind: 'user',
    sessionId: randomUUID(),
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
  } as Principal;
}

async function linkOf(orgId: string) {
  const result = await t.pg.query<{
    workos_org_id: string | null;
    sso_required: boolean;
    jit_join_enabled: boolean;
  }>(`select workos_org_id, sso_required, jit_join_enabled from organizations where id = $1`, [
    orgId,
  ]);
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

  it('lets an owner and an admin in', async () => {
    const org = await seedOrg();

    caller = sessionOf(org.founder);
    expect((await getStatus(org.slug)).status).toBe(200);

    await signedInAs(org.orgId, 'admin');
    expect((await getStatus(org.slug)).status).toBe(200);
  });

  it('spends the mutation rate limit on every change, keyed by the caller', async () => {
    const org = await seedOrg();
    const userId = await signedInAs(org.orgId, 'admin');
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
    expect(keys).toEqual([userId, userId, userId]);
    workosWasAskedNothing();
  });
});

/* ── POST /sso: turning it on ─────────────────────────────────────────────── */

describe('turning SSO on', () => {
  it('creates the WorkOS organisation with a name and the organisation id, and no domains at all', async () => {
    const org = await seedOrg();
    await signedInAs(org.orgId, 'admin');
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

    expect(await linkOf(org.orgId)).toEqual({
      workos_org_id: created,
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
    await signedInAs(org.orgId, 'owner');
    const created = workosOrgId();
    workos.createOrganization.mockResolvedValue({ id: created });
    expect((await enable(org.slug)).status).toBe(201);
    audit = [];
    workos.getOrganization.mockResolvedValue({ id: created, domains: [] });
    connectionsAre();

    const again = await enable(org.slug);

    expect(again.status).toBe(200);
    expect(sso(again)['enabled']).toBe(true);
    expect(workos.createOrganization).toHaveBeenCalledTimes(1);
    expect((await linkOf(org.orgId)).workos_org_id).toBe(created);
    expect(audit).toEqual([]);
  });

  it('refuses an organisation without the add-on, files why, and asks WorkOS nothing', async () => {
    const org = await seedOrg({ addon: false });
    await signedInAs(org.orgId, 'owner');

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
    await signedInAs(org.orgId, 'owner');
    const earlier = workosOrgId();
    workos.createOrganization.mockRejectedValue({ status: 409, code: 'conflict' });
    workos.getOrganizationByExternalId.mockResolvedValue({ id: earlier, externalId: org.orgId });

    const answer = await enable(org.slug);

    expect(answer.status).toBe(201);
    expect(workos.getOrganizationByExternalId).toHaveBeenCalledWith(org.orgId);
    expect((await linkOf(org.orgId)).workos_org_id).toBe(earlier);
  });

  it('links nothing when WorkOS is down, says so, and files the failure', async () => {
    const org = await seedOrg();
    await signedInAs(org.orgId, 'owner');
    workos.createOrganization.mockRejectedValue({ status: 503 });

    const answer = await enable(org.slug);

    expect(answer.status).toBe(503);
    expect((answer.body['error'] as { message: string }).message).toMatch(/nothing was changed/);
    expect((await linkOf(org.orgId)).workos_org_id).toBeNull();
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'org.sso.enabled',
        outcome: 'error',
        metadata: { reason: 'upstreamUnavailable' },
      }),
    ]);
  });

  it('losing a race to another enable deletes its own orphan and answers with the winner', async () => {
    const org = await seedOrg();
    await signedInAs(org.orgId, 'owner');
    const winner = workosOrgId();
    const orphan = workosOrgId();
    // The other request links its WorkOS organisation while this one is
    // still waiting on WorkOS for its own.
    workos.createOrganization.mockImplementation(async () => {
      await t.pg.query(`update organizations set workos_org_id = $2 where id = $1`, [
        org.orgId,
        winner,
      ]);
      return { id: orphan };
    });
    workos.deleteOrganization.mockResolvedValue(undefined);
    workos.getOrganization.mockResolvedValue({ id: winner, domains: [] });
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
});

/* ── POST /sso/portal ─────────────────────────────────────────────────────── */

describe('the setup portal link', () => {
  it('mints an SSO Admin Portal link for the linked organisation, returning to its settings, and audits it', async () => {
    const linked = workosOrgId();
    const org = await seedOrg({ workosOrgId: linked });
    const userId = await signedInAs(org.orgId, 'admin');
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
        actorId: userId,
        resourceType: 'org',
        resourceId: org.orgId,
      }),
    ]);
    // A credential for a few minutes: in the response, and nowhere else.
    expect(JSON.stringify(audit)).not.toContain('not-a-real-one');
    expect(JSON.stringify(lines)).not.toContain('not-a-real-one');
  });

  it('refuses before SSO is on, files the attempt, and asks WorkOS nothing', async () => {
    const org = await seedOrg();
    await signedInAs(org.orgId, 'owner');

    const answer = await portal(org.slug);

    expect(answer.status).toBe(409);
    workosWasAskedNothing();
    expect(audit).toEqual([
      expect.objectContaining({ action: 'org.sso.portal_link_created', outcome: 'error' }),
    ]);
  });

  it('refuses once the add-on has lapsed', async () => {
    const org = await seedOrg({ workosOrgId: workosOrgId(), addon: false });
    await signedInAs(org.orgId, 'owner');

    const answer = await portal(org.slug);

    expect(answer.status).toBe(403);
    expect(errorCode(answer)).toBe('plan_limit');
    workosWasAskedNothing();
  });

  it('never hands the dashboard something that is not an https page', async () => {
    const org = await seedOrg({ workosOrgId: workosOrgId() });
    await signedInAs(org.orgId, 'owner');

    for (const link of ['javascript:alert(1)', '/relative', 'http://setup.workos.com/x', '']) {
      workos.generateLink.mockResolvedValueOnce({ link });
      const answer = await portal(org.slug);
      expect(answer.status).toBe(503);
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
      providerReachable: true,
    });
    workosWasAskedNothing();
  });

  it('lists the connections and domains WorkOS reports once SSO is on', async () => {
    const linked = workosOrgId();
    const org = await seedOrg({ workosOrgId: linked, jit: true });
    await signedInAs(org.orgId, 'owner');
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
    expect(workos.listConnections).toHaveBeenCalledWith({ organizationId: linked });
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

  it('still answers, without the lists, when WorkOS cannot be reached', async () => {
    const org = await seedOrg({ workosOrgId: workosOrgId(), ssoRequired: true });
    await signedInAs(org.orgId, 'owner');
    workos.listConnections.mockRejectedValue({ status: 502 });
    workos.getOrganization.mockRejectedValue({ status: 502 });

    const answer = await getStatus(org.slug);

    expect(answer.status).toBe(200);
    expect(sso(answer)).toMatchObject({
      enabled: true,
      ssoRequired: true,
      connections: null,
      domains: null,
      providerReachable: false,
    });
  });
});

/* ── PATCH /sso: the two policies ─────────────────────────────────────────── */

describe('the sign-in policies', () => {
  it('requires SSO once a connection is active, and audits the new value', async () => {
    const org = await seedOrg({ workosOrgId: workosOrgId() });
    const userId = await signedInAs(org.orgId, 'admin');
    connectionsAre('draft', 'active');
    workos.getOrganization.mockResolvedValue({ id: 'x', domains: [] });

    const answer = await patch(org.slug, { ssoRequired: true });

    expect(answer.status).toBe(200);
    expect(sso(answer)['ssoRequired']).toBe(true);
    expect((await linkOf(org.orgId)).sso_required).toBe(true);
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'org.sso.required_toggled',
        outcome: 'success',
        actorId: userId,
        metadata: { enabled: true },
      }),
    ]);
  });

  it('refuses to require SSO without an active connection — only owners could sign in', async () => {
    const org = await seedOrg({ workosOrgId: workosOrgId() });
    await signedInAs(org.orgId, 'owner');
    connectionsAre('draft', 'validating', 'inactive');

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

  it('refuses either policy before SSO is on, asking WorkOS nothing', async () => {
    const org = await seedOrg();
    await signedInAs(org.orgId, 'owner');

    for (const body of [{ ssoRequired: true }, { jitJoinEnabled: true }]) {
      expect((await patch(org.slug, body)).status).toBe(409);
    }
    workosWasAskedNothing();
    expect(await linkOf(org.orgId)).toEqual({
      workos_org_id: null,
      sso_required: false,
      jit_join_enabled: false,
    });
  });

  it('opts in to just-in-time joins, and out again, auditing each move', async () => {
    const org = await seedOrg({ workosOrgId: workosOrgId() });
    await signedInAs(org.orgId, 'admin');
    connectionsAre('active');
    workos.getOrganization.mockResolvedValue({ id: 'x', domains: [] });

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
    await signedInAs(org.orgId, 'owner');
    connectionsAre('active');
    workos.getOrganization.mockResolvedValue({ id: 'x', domains: [] });

    expect((await patch(org.slug, { jitJoinEnabled: true, ssoRequired: false })).status).toBe(200);
    expect(audit).toEqual([]);
  });

  it('lets a policy be switched off after the add-on lapsed, but not on', async () => {
    const org = await seedOrg({ workosOrgId: workosOrgId(), addon: false, ssoRequired: true });
    await signedInAs(org.orgId, 'owner');
    connectionsAre('active');
    workos.getOrganization.mockResolvedValue({ id: 'x', domains: [] });

    const on = await patch(org.slug, { jitJoinEnabled: true });
    expect(on.status).toBe(403);
    expect(errorCode(on)).toBe('plan_limit');

    const off = await patch(org.slug, { ssoRequired: false });
    expect(off.status).toBe(200);
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
    await signedInAs(org.orgId, 'owner');

    const answer = await patch(org.slug, body);

    expect(answer.status).toBe(422);
    expect(await linkOf(org.orgId)).toMatchObject({ sso_required: false, jit_join_enabled: false });
    workosWasAskedNothing();
  });

  it('refuses to require SSO when WorkOS cannot say whether a connection is active', async () => {
    const org = await seedOrg({ workosOrgId: workosOrgId() });
    await signedInAs(org.orgId, 'owner');
    workos.listConnections.mockRejectedValue({ status: 500 });

    const answer = await patch(org.slug, { ssoRequired: true });

    expect(answer.status).toBe(503);
    expect((await linkOf(org.orgId)).sso_required).toBe(false);
  });
});

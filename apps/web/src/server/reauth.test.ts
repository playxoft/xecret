import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { generateToken, hashToken } from '@xecret/core/auth';
import type { AuditRecord } from '@xecret/core/audit';
import { consumeReauthProof, createSession, recordFreshSignIn } from '@xecret/db/repositories';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '@xecret/db/testing';
import type { TestDatabase } from '@xecret/db/testing';
import { createLogger } from './logging';
import type { LogEntry, RequestLog } from './logging';
import type { WorkosApi } from './workos';

/**
 * The vault reset's two locks — a forced fresh sign-in, then an emailed code —
 * and the one-time proof they produce, through the real routes and the real
 * `authenticatedRoute` (cookie, CSRF, origin), against a real database.
 *
 * The fresh sign-in itself is the callback's job and is tested in
 * `sign-in-route.test.ts`; here it is recorded directly with the same
 * repository function the callback calls. WorkOS's two Magic Auth calls are
 * stubbed: which code is right is WorkOS's business, and what is under test is
 * everything xecret does around it — the order, the bindings, the counters, the
 * single use.
 *
 * Plan: `.local/workos-auth.md` §8 Q5 ("both"), WS-4.
 */

const ORIGIN = 'https://xecret.playxoft.com';
const CSRF = 'csrf-token-for-tests';

const context = vi.hoisted(() => ({ workerContext: vi.fn(), createServiceContext: vi.fn() }));
const auditSink = vi.hoisted(() => ({ write: vi.fn() }));
const logging = vi.hoisted(() => ({ createRequestLog: vi.fn() }));
const workos = vi.hoisted(() => ({
  createMagicAuth: vi.fn(),
  authenticateWithMagicAuth: vi.fn(),
}));

vi.mock('./context', () => context);
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
    userManagement: {
      getAuthorizationUrl: vi.fn(),
      authenticateWithCode: vi.fn(),
      createMagicAuth: workos.createMagicAuth,
      authenticateWithMagicAuth: workos.authenticateWithMagicAuth,
    },
    organizations: { getOrganization: vi.fn(), createOrganization: vi.fn() },
    adminPortal: { generateLink: vi.fn() },
    sso: { listConnections: vi.fn() },
  } as unknown as WorkosApi;
  return {
    ...original,
    workosProvider: () =>
      new original.WorkosIdentityProvider(api, {
        clientId: 'client_01TESTCLIENT',
        redirectUri: 'https://xecret.playxoft.com/api/auth/callback',
      }),
  };
});

const statusRoute = await import('@/app/api/auth/reauth/route');
const startRoute = await import('@/app/api/auth/reauth/start/route');
const verifyRoute = await import('@/app/api/auth/reauth/verify/route');
const resetRoute = await import('@/app/api/auth/vault/reset/route');
const { REAUTH_MAX_CODE_FAILURES, VAULT_RESET_CONFIRMATION } = await import('./schemas/vault');

let t: TestDatabase;
let lines: LogEntry[] = [];
let audit: AuditRecord[] = [];
/** Work a route deferred past its response — the audit flush among it. */
let deferred: Promise<unknown>[] = [];

beforeAll(async () => {
  t = await createTestDatabase();
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  workos.createMagicAuth.mockReset();
  workos.authenticateWithMagicAuth.mockReset();
  t.reset();
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
  context.workerContext.mockResolvedValue({ env, ctx: { waitUntil: () => {} } });
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
      waitUntil: (promise: Promise<unknown>) => deferred.push(promise),
      settled: () => Promise.allSettled(deferred),
      dispose: () => {},
    }),
  );
  auditSink.write.mockImplementation(async (events: AuditRecord[]) => {
    audit.push(...events);
  });
});

/* ── fixtures ─────────────────────────────────────────────────────────────── */

interface Account {
  userId: string;
  workosUserId: string;
  email: string;
  sessionId: string;
  token: string;
}

async function account(): Promise<Account> {
  const userId = randomUUID();
  const workosUserId = `user_01${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const email = `owner-${userId.slice(0, 8)}@example.com`;
  await t.pg.query(
    `insert into users (id, workos_user_id, email, email_verified) values ($1, $2, $3, true)`,
    [userId, workosUserId, email],
  );
  return { userId, workosUserId, email, ...(await anotherSession(userId)) };
}

/** Audit records are filed under the account's primary organisation, so it needs one. */
async function withOrganization(who: Account): Promise<string> {
  const orgId = randomUUID();
  await t.pg.query(
    `insert into organizations (id, name, slug, created_by) values ($1, 'Acme', $2, $3)`,
    [orgId, `acme-${orgId.slice(0, 8)}`, who.userId],
  );
  await t.pg.query(
    `insert into org_members (id, org_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), orgId, who.userId],
  );
  return orgId;
}

async function anotherSession(userId: string): Promise<{ sessionId: string; token: string }> {
  const { token } = await generateToken('session');
  const session = await createSession(t.db, { userId, token, ipAddress: null, userAgent: null });
  return { sessionId: session.id, token };
}

async function signedInFreshly(who: Account, secondsAgo = 30): Promise<void> {
  await recordFreshSignIn(t.db, {
    userId: who.userId,
    sessionId: who.sessionId,
    at: new Date(Date.now() - secondsAgo * 1000),
  });
}

function call(
  route: { GET?: unknown; POST?: unknown },
  method: 'GET' | 'POST',
  path: string,
  who: Pick<Account, 'token'>,
  body?: unknown,
): Promise<Response> {
  const handler = (route as Record<string, (request: Request) => Promise<Response>>)[method]!;
  return handler(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        cookie: `__Host-xecret_session=${who.token}; __Host-xecret_csrf=${CSRF}`,
        'x-xecret-csrf': CSRF,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

const status = (who: Account) => call(statusRoute, 'GET', '/api/auth/reauth', who);
const start = (who: Account) => call(startRoute, 'POST', '/api/auth/reauth/start', who);
const verify = (who: Account, code: string) =>
  call(verifyRoute, 'POST', '/api/auth/reauth/verify', who, { code });
const reset = (
  who: Pick<Account, 'token'>,
  reauthProof: unknown,
  confirm = VAULT_RESET_CONFIRMATION,
) => call(resetRoute, 'POST', '/api/auth/vault/reset', who, { confirm, reauthProof });

function magicAuthReaches(workosUserId: string) {
  workos.createMagicAuth.mockResolvedValue({
    object: 'magic_auth',
    id: 'magic_auth_01',
    userId: workosUserId,
    email: 'irrelevant@example.com',
    code: '424242',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

function codeProves(workosUserId: string, extra: Record<string, unknown> = {}) {
  workos.authenticateWithMagicAuth.mockResolvedValue({
    user: { id: workosUserId, email: 'x@example.com', emailVerified: true },
    accessToken: 'at',
    refreshToken: 'rt',
    authenticationMethod: 'MagicAuth',
    ...extra,
  });
}

function wrongCode() {
  workos.authenticateWithMagicAuth.mockRejectedValue(
    Object.assign(new Error('Invalid code'), { status: 400, code: 'invalid_one_time_code' }),
  );
}

async function attempt(who: Account) {
  return (
    await t.pg.query<{
      code_sent_at: Date | null;
      code_failures: number;
      proof_hash: Uint8Array | null;
      proof_expires_at: Date | null;
      used_at: Date | null;
    }>(
      `select code_sent_at, code_failures, proof_hash, proof_expires_at, used_at
         from reauthentications where session_id = $1`,
      [who.sessionId],
    )
  ).rows[0];
}

async function proofFor(who: Account): Promise<string> {
  codeProves(who.workosUserId);
  const response = await verify(who, '123456');
  expect(response.status).toBe(200);
  return ((await response.json()) as { reauthProof: string }).reauthProof;
}

async function errorOf(response: Response) {
  return ((await response.json()) as { error: { code: string; message: string } }).error;
}

/* ── lock one: the fresh sign-in ──────────────────────────────────────────── */

describe('where an attempt stands', () => {
  it('has nothing to report before the fresh sign-in', async () => {
    const who = await account();

    const body = (await (await status(who)).json()) as Record<string, unknown>;

    expect(body).toEqual({
      signedIn: false,
      signedInUntil: null,
      codeSent: false,
      email: who.email,
    });
  });

  it('reports a fresh sign-in, and until when it counts', async () => {
    const who = await account();
    await signedInFreshly(who, 60);

    const body = (await (await status(who)).json()) as { signedIn: boolean; signedInUntil: string };

    expect(body.signedIn).toBe(true);
    const remaining = Date.parse(body.signedInUntil) - Date.now();
    expect(remaining).toBeGreaterThan(8 * 60_000);
    expect(remaining).toBeLessThanOrEqual(9 * 60_000 + 1000);
  });

  it('no longer counts a sign-in more than ten minutes old', async () => {
    const who = await account();
    await signedInFreshly(who, 11 * 60);

    expect(((await (await status(who)).json()) as { signedIn: boolean }).signedIn).toBe(false);
  });

  it('does not count another session’s sign-in — not even the same account’s', async () => {
    const who = await account();
    const other = { ...who, ...(await anotherSession(who.userId)) };
    await signedInFreshly(other);

    expect(((await (await status(who)).json()) as { signedIn: boolean }).signedIn).toBe(false);
  });
});

/* ── lock two: the emailed code ───────────────────────────────────────────── */

describe('asking for the code', () => {
  it('is refused before the fresh sign-in, without asking WorkOS to send anything', async () => {
    const who = await account();

    const response = await start(who);

    expect(response.status).toBe(403);
    expect(workos.createMagicAuth).not.toHaveBeenCalled();
  });

  it('has WorkOS email the account’s own address, and never returns or logs the code', async () => {
    const who = await account();
    await signedInFreshly(who);
    magicAuthReaches(who.workosUserId);

    const response = await start(who);

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(workos.createMagicAuth).toHaveBeenCalledWith(
      expect.objectContaining({ email: who.email }),
    );
    expect(JSON.stringify(lines)).not.toContain('424242');
    expect((await attempt(who))?.code_sent_at).not.toBeNull();
  });

  it('refuses when the address reaches a different WorkOS user than this account', async () => {
    const who = await account();
    await signedInFreshly(who);
    magicAuthReaches('user_01SOMEBODYELSE');

    expect((await start(who)).status).toBe(403);
    expect((await attempt(who))?.code_sent_at).toBeNull();
  });

  it('answers 503, not "sign in again", while Magic Auth is switched off at WorkOS', async () => {
    // What WorkOS Staging actually answered on 2026-10-12 with Magic Auth
    // disabled. A loop back to the sign-in page would have no exit.
    const who = await account();
    await signedInFreshly(who);
    workos.createMagicAuth.mockRejectedValue(
      Object.assign(new Error('Magic Auth is disabled.'), {
        status: 400,
        error: 'authentication_method_not_allowed',
      }),
    );

    expect((await start(who)).status).toBe(503);
    expect((await attempt(who))?.code_sent_at).toBeNull();
  });

  it('is refused once the sign-in is more than ten minutes old', async () => {
    const who = await account();
    await signedInFreshly(who, 11 * 60);
    magicAuthReaches(who.workosUserId);

    expect((await start(who)).status).toBe(403);
    expect(workos.createMagicAuth).not.toHaveBeenCalled();
  });
});

describe('checking the code', () => {
  it('is refused before the fresh sign-in, without asking WorkOS', async () => {
    const who = await account();
    codeProves(who.workosUserId);

    expect((await verify(who, '123456')).status).toBe(403);
    expect(workos.authenticateWithMagicAuth).not.toHaveBeenCalled();
  });

  it('refuses anything but six digits before asking WorkOS', async () => {
    const who = await account();
    await signedInFreshly(who);

    for (const code of ['12345', '1234567', 'abcdef', '']) {
      expect((await verify(who, code)).status).toBe(422);
    }
    expect(workos.authenticateWithMagicAuth).not.toHaveBeenCalled();
  });

  it('mints a five-minute proof, stores only its hash, and audits the re-authentication', async () => {
    const who = await account();
    const orgId = await withOrganization(who);
    await signedInFreshly(who);
    codeProves(who.workosUserId);

    const response = await verify(who, '123456');

    expect(response.status).toBe(200);
    const body = (await response.json()) as { reauthProof: string; expiresAt: string };
    expect(body.reauthProof).toMatch(/^xrp_live_[A-Za-z0-9_-]{43}$/);
    const remaining = Date.parse(body.expiresAt) - Date.now();
    expect(remaining).toBeGreaterThan(4 * 60_000);
    expect(remaining).toBeLessThanOrEqual(5 * 60_000);

    const row = await attempt(who);
    expect(Buffer.from(row!.proof_hash!)).toEqual(Buffer.from(await hashToken(body.reauthProof)));
    expect(Buffer.from(row!.proof_hash!).toString()).not.toContain(body.reauthProof);
    await Promise.allSettled(deferred);
    const recorded = audit.find((e) => e.action === 'auth.reauthenticated');
    expect(recorded?.resourceId).toBe(who.sessionId);
    expect(recorded?.orgId).toBe(orgId);
  });

  it('counts a wrong code, and ends the attempt after five of them', async () => {
    const who = await account();
    await signedInFreshly(who);
    wrongCode();

    for (let i = 1; i <= REAUTH_MAX_CODE_FAILURES; i += 1) {
      expect((await verify(who, '000000')).status).toBe(403);
      expect((await attempt(who))?.code_failures).toBe(i);
    }

    // Even the right code is refused now, and WorkOS is no longer asked: the
    // six digits cannot be walked, rate limiter or not.
    codeProves(who.workosUserId);
    const calls = workos.authenticateWithMagicAuth.mock.calls.length;
    expect((await verify(who, '123456')).status).toBe(403);
    expect(workos.authenticateWithMagicAuth.mock.calls.length).toBe(calls);
    expect(((await (await status(who)).json()) as { signedIn: boolean }).signedIn).toBe(false);
  });

  it('refuses a code that proved a different WorkOS user', async () => {
    const who = await account();
    await signedInFreshly(who);
    codeProves('user_01SOMEBODYELSE');

    expect((await verify(who, '123456')).status).toBe(403);
    expect((await attempt(who))?.proof_hash).toBeNull();
  });

  it('refuses an impersonated code', async () => {
    const who = await account();
    await signedInFreshly(who);
    codeProves(who.workosUserId, {
      impersonator: { email: 'support@workos.example', reason: null },
    });

    expect((await verify(who, '123456')).status).toBe(403);
    expect((await attempt(who))?.proof_hash).toBeNull();
  });

  it('is refused once the sign-in is more than ten minutes old, even with the right code', async () => {
    const who = await account();
    await signedInFreshly(who, 11 * 60);
    codeProves(who.workosUserId);

    expect((await verify(who, '123456')).status).toBe(403);
  });

  it('replaces an earlier proof rather than adding a second one', async () => {
    const who = await account();
    await signedInFreshly(who);
    const first = await proofFor(who);
    const second = await proofFor(who);

    expect(second).not.toBe(first);
    expect((await reset(who, first)).status).toBe(403);
  });
});

/* ── the reset spends the proof ───────────────────────────────────────────── */

describe('the reset’s gate', () => {
  // No vault is seeded, so a reset that passes the gate answers 404 ("no vault
  // to reset") rather than destroying anything. 404 therefore means "the gate
  // let it through"; 403 means it did not.

  it('lets a fresh proof through, once', async () => {
    const who = await account();
    await signedInFreshly(who);
    const proof = await proofFor(who);

    expect((await reset(who, proof)).status).toBe(404);
    expect((await attempt(who))?.used_at).not.toBeNull();

    const again = await reset(who, proof);
    expect(again.status).toBe(403);
    expect((await errorOf(again)).code).toBe('forbidden');
  });

  it('does not spend the proof on a mistyped confirmation phrase', async () => {
    const who = await account();
    await signedInFreshly(who);
    const proof = await proofFor(who);

    expect((await reset(who, proof, 'rest my vault')).status).toBe(400);
    expect((await attempt(who))?.used_at).toBeNull();
    expect((await reset(who, proof)).status).toBe(404);
  });

  it('refuses a proof past its five minutes', async () => {
    const who = await account();
    await signedInFreshly(who);
    const proof = await proofFor(who);
    await t.pg.query(
      `update reauthentications set proof_expires_at = now() - interval '1 second' where session_id = $1`,
      [who.sessionId],
    );

    expect((await reset(who, proof)).status).toBe(403);
  });

  it('refuses a proof presented by another session of the same account', async () => {
    const who = await account();
    await signedInFreshly(who);
    const proof = await proofFor(who);
    const otherSession = await anotherSession(who.userId);

    expect((await reset(otherSession, proof)).status).toBe(403);
    expect((await attempt(who))?.used_at).toBeNull();
  });

  it('refuses a proof presented by another account', async () => {
    const who = await account();
    await signedInFreshly(who);
    const proof = await proofFor(who);
    const stranger = await account();

    expect((await reset(stranger, proof)).status).toBe(403);
    expect((await attempt(who))?.used_at).toBeNull();
  });

  it.each([
    ['a missing proof', undefined],
    ['the retired Firebase field instead', null],
  ])('refuses %s as a malformed request', async (_label, proof) => {
    const who = await account();
    const body: Record<string, unknown> =
      proof === null
        ? { confirm: VAULT_RESET_CONFIRMATION, idToken: 'eyJ.a-firebase-id-token' }
        : { confirm: VAULT_RESET_CONFIRMATION };

    const response = await call(resetRoute, 'POST', '/api/auth/vault/reset', who, body);

    expect(response.status).toBe(422);
  });

  it.each([
    ['garbage', 'not-a-proof'],
    ['a session token', 'xes_live_' + 'a'.repeat(43)],
    ['a well-formed proof nobody minted', 'xrp_live_' + 'a'.repeat(43)],
  ])('refuses %s with the same message as any other failure', async (_label, proof) => {
    const who = await account();
    await signedInFreshly(who);
    const spentElsewhere = await proofFor(who);
    await reset(who, spentElsewhere);
    const used = await errorOf(await reset(who, spentElsewhere));

    const error = await errorOf(await reset(who, proof));

    expect(error.code).toBe('forbidden');
    expect(error.message).toBe(used.message);
  });

  it('lets exactly one of two concurrent resets spend a proof', async () => {
    const who = await account();
    await signedInFreshly(who);
    const proof = await proofFor(who);
    const proofHash = await hashToken(proof);
    const spend = () =>
      consumeReauthProof(t.db, {
        userId: who.userId,
        sessionId: who.sessionId,
        proofHash,
        now: new Date(),
      });

    const race = t.beforeNextWrite(async () => {
      expect(await spend()).toBe(true);
    });
    const second = await spend();

    expect(race.fired()).toBe(true);
    expect(second).toBe(false);
  });
});

/* ── every route here is a browser session's, and reachable while locked ──── */

describe('the routes', () => {
  it('are reachable from a locked session — everybody here is locked out by definition', async () => {
    const who = await account();
    // `vault_unlocked_at` is null: this session has never been unlocked.
    expect((await status(who)).status).toBe(200);
  });

  it('refuse a cross-site request and a mutation without the CSRF pair', async () => {
    const who = await account();
    await signedInFreshly(who);

    const crossSite = await startRoute.POST(
      new Request(`${ORIGIN}/api/auth/reauth/start`, {
        method: 'POST',
        headers: {
          origin: 'https://evil.example',
          cookie: `__Host-xecret_session=${who.token}; __Host-xecret_csrf=${CSRF}`,
          'x-xecret-csrf': CSRF,
        },
      }),
    );
    expect(crossSite.status).toBe(403);

    const noCsrf = await startRoute.POST(
      new Request(`${ORIGIN}/api/auth/reauth/start`, {
        method: 'POST',
        headers: { origin: ORIGIN, cookie: `__Host-xecret_session=${who.token}` },
      }),
    );
    expect(noCsrf.status).toBe(403);
    expect(workos.createMagicAuth).not.toHaveBeenCalled();
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { WorkOS } from '@workos-inc/node';
import {
  deriveEmailVerificationKey,
  deriveKnownDeviceKey,
  deriveSignInConfirmationKey,
  EMAIL_VERIFICATION_COOKIE_NAME,
  openKnownDevice,
  openSignInConfirmation,
  sealEmailVerification,
  SIGN_IN_CONFIRMATION_COOKIE_NAME,
} from '@xecret/core/auth';
import type { AuditRecord } from '@xecret/core/audit';
import {
  EnvelopeService,
  generateKeyBytes,
  InMemoryKeyProvider,
  parseRootKeyMaterial,
  toBase64Url,
} from '@xecret/core/crypto';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '@xecret/db/testing';
import type { TestDatabase } from '@xecret/db/testing';
import { SIGN_IN_ERROR_MESSAGES, SIGN_IN_FORM_MESSAGES } from '@/lib/sign-in-errors';
import { createLogger } from './logging';
import type { LogEntry, RequestLog } from './logging';
import type { WorkosApi } from './workos';

/**
 * Signing in on xecret's own page, end to end: the four in-app routes —
 * password, code request, code, email verification — against a real database.
 *
 * ── What is real, and what is stubbed ──
 * Real: the routes and `publicRoute`; the origin and content-type guard; the
 * rate-limit keys; the WorkOS provider's shape checks, failure sorting and
 * `workosIdentity()` minting; and everything behind them that the callback
 * runs too — `prepareSignIn`, the linker, the personal organisation, the
 * confirmation and `issueSignIn` — on PGlite with every migration applied.
 *
 * Stubbed: the WorkOS calls that would leave the process, at the SDK's own
 * method names (`authenticateWithPassword`, `createMagicAuth`,
 * `authenticateWithMagicAuth`, `authenticateWithEmailVerification`,
 * `authenticateWithOrganizationSelection`, `getOrganization`), the audit sink
 * and the logger — both captured. No real WorkOS endpoint is ever called.
 *
 * Every refusal is asserted the same three ways as the callback's: what the
 * page is told, that no session cookie was issued, and what the database holds
 * afterwards.
 */

const ORIGIN = 'https://xecret.playxoft.com';
const CLIENT_ID = 'client_01TESTCLIENT';
const COOKIE_PASSWORD = 'a-cookie-password-that-is-comfortably-over-32-characters';
const PASSWORD = 'correct horse battery staple 9';

const context = vi.hoisted(() => ({ workerContext: vi.fn(), createServiceContext: vi.fn() }));
const auditSink = vi.hoisted(() => ({ write: vi.fn() }));
const logging = vi.hoisted(() => ({ createRequestLog: vi.fn() }));
const workos = vi.hoisted(() => ({
  authenticateWithPassword: vi.fn(),
  authenticateWithMagicAuth: vi.fn(),
  authenticateWithEmailVerification: vi.fn(),
  authenticateWithOrganizationSelection: vi.fn(),
  createMagicAuth: vi.fn(),
  getOrganization: vi.fn(),
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
  const sdk = new WorkOS('sk_test_not_a_real_key', { clientId: 'client_01TESTCLIENT' });
  const api = {
    userManagement: {
      getAuthorizationUrl: (
        options: Parameters<WorkOS['userManagement']['getAuthorizationUrl']>[0],
      ) => sdk.userManagement.getAuthorizationUrl(options),
      authenticateWithCode: vi.fn(),
      authenticateWithPassword: workos.authenticateWithPassword,
      authenticateWithMagicAuth: workos.authenticateWithMagicAuth,
      authenticateWithEmailVerification: workos.authenticateWithEmailVerification,
      authenticateWithOrganizationSelection: workos.authenticateWithOrganizationSelection,
      createMagicAuth: workos.createMagicAuth,
      getLogoutUrl: (options: Parameters<WorkOS['userManagement']['getLogoutUrl']>[0]) =>
        sdk.userManagement.getLogoutUrl(options),
    },
    organizations: { getOrganization: workos.getOrganization, createOrganization: vi.fn() },
    adminPortal: { generateLink: vi.fn() },
    sso: { listConnections: vi.fn() },
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

const passwordRoute = await import('@/app/api/auth/sign-in/password/route');
const codeRoute = await import('@/app/api/auth/sign-in/code/route');
const codeVerifyRoute = await import('@/app/api/auth/sign-in/code/verify/route');
const verifyEmailRoute = await import('@/app/api/auth/sign-in/verify-email/route');
const confirmRoute = await import('@/app/api/auth/confirm/route');
const { setEmailVerificationStepForTesting } = await import('./in-app-sign-in');
const { SIGN_IN_FREE_FAILURES, addressPool, devicePool, deviceAddressTag } =
  await import('./sign-in-throttle');
/** The shared pool's row key for an address, as the routes compute it. */
const signInSubject = (email: string) => addressPool(env as never, email);

const ROUTES = {
  '/api/auth/sign-in/password': passwordRoute.POST,
  '/api/auth/sign-in/code': codeRoute.POST,
  '/api/auth/sign-in/code/verify': codeVerifyRoute.POST,
  '/api/auth/sign-in/verify-email': verifyEmailRoute.POST,
} as const;

type RoutePath = keyof typeof ROUTES;

let t: TestDatabase;
let envelope: EnvelopeService;
let lines: LogEntry[] = [];
let audit: AuditRecord[] = [];
let env: Record<string, unknown> = {};
let deferred: Promise<unknown>[] = [];
/** The caller's address, as `CF-Connecting-IP` would give it — changed to rotate. */
let clientIp = '203.0.113.5';

beforeAll(async () => {
  t = await createTestDatabase();
  const rootKeys = JSON.stringify({ '1': toBase64Url(generateKeyBytes()) });
  envelope = new EnvelopeService(new InMemoryKeyProvider(parseRootKeyMaterial(rootKeys, 1)));
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

function capturingLog(base: Record<string, unknown> = {}): RequestLog {
  return createLogger({
    sink: { write: (entry) => lines.push(entry), flush: () => Promise.resolve() },
    minimum: 'debug',
    base,
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  for (const call of Object.values(workos)) call.mockReset();
  t.reset();
  // Fixed addresses recur across tests; the durable counter must not carry
  // one test's failures into the next.
  await t.pg.query('delete from sign_in_failures');
  setEmailVerificationStepForTesting(null);
  clientIp = '203.0.113.5';
  lines = [];
  audit = [];
  deferred = [];
  env = {
    XECRET_PUBLIC_URL: ORIGIN,
    XECRET_ENV: 'production',
    WORKOS_CLIENT_ID: CLIENT_ID,
    WORKOS_API_KEY: 'sk_test_not_a_real_key',
    WORKOS_COOKIE_PASSWORD: COOKIE_PASSWORD,
  };

  logging.createRequestLog.mockImplementation((_env: unknown, base: Record<string, unknown>) =>
    capturingLog(base),
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
      envelope,
      meta: {
        requestId,
        rayId: null,
        ipAddress: clientIp,
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
  workos.getOrganization.mockResolvedValue({ id: 'org_unused', domains: [] });
  workos.createMagicAuth.mockResolvedValue({
    object: 'magic_auth',
    id: 'magic_auth_01',
    userId: 'user_01MAGIC',
    email: 'whoever@example.com',
    code: '918273',
    expiresAt: '2026-11-07T10:10:00Z',
    createdAt: '2026-11-07T10:00:00Z',
    updatedAt: '2026-11-07T10:00:00Z',
  });
});

/* ── fixtures ─────────────────────────────────────────────────────────────── */

let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}${sequence}${randomUUID().replaceAll('-', '').slice(0, 10)}`;
}

function workosUser(over: Record<string, unknown> = {}) {
  return {
    object: 'user',
    id: unique('user_01'),
    email: `${unique('person-')}@example.com`,
    emailVerified: true,
    firstName: 'Pat',
    lastName: null,
    profilePictureUrl: null,
    ...over,
  };
}

/** An access token as WorkOS shapes one: `auth_time` now, and a session id. */
function accessToken(authTime: number = Math.floor(Date.now() / 1000)): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${part({ alg: 'RS256' })}.${part({ sub: 'user_01', sid: 'session_01HEADLESS', iat: now, auth_time: authTime })}.c2ln`;
}

/** What WorkOS's authenticate endpoint answers for a person who just proved themselves. */
function authenticated(user: Record<string, unknown>, method: string, extra = {}) {
  return {
    user,
    authenticationMethod: method,
    accessToken: accessToken(),
    refreshToken: 'workos-refresh-token',
    ...extra,
  };
}

/** A WorkOS refusal, shaped as the SDK raises it. */
function refusal(status: number, fields: Record<string, unknown>) {
  return Object.assign(new Error('workos said no'), { status, ...fields });
}

/** A WorkOS "one more step", shaped as the SDK's `AuthenticationException`. */
function step(code: string, raw: Record<string, unknown> = {}) {
  return Object.assign(new Error(code), {
    name: 'AuthenticationException',
    status: 403,
    code,
    pendingAuthenticationToken: raw['pending_authentication_token'],
    rawData: { code, ...raw },
  });
}

interface Answer {
  status: number;
  body: Record<string, unknown>;
  text: string;
  cookies: string[];
}

/**
 * Posts the way the sign-in page's `fetch` does: same origin, JSON. Every part
 * is overridable, so a test can take away exactly one.
 */
async function post(
  path: RoutePath,
  body: unknown,
  options: {
    origin?: string | null;
    site?: string | null;
    contentType?: string;
    cookie?: string;
  } = {},
): Promise<Answer> {
  const headers: Record<string, string> = {
    'content-type': options.contentType ?? 'application/json',
  };
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (origin !== null) headers['origin'] = origin;
  const site = options.site === undefined ? 'same-origin' : options.site;
  if (site !== null) headers['sec-fetch-site'] = site;
  if (options.cookie !== undefined) headers['cookie'] = options.cookie;

  const response = await ROUTES[path](
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
  await Promise.allSettled(deferred);
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    if (text !== '') parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Not JSON.
  }
  return { status: response.status, body: parsed, text, cookies: response.headers.getSetCookie() };
}

function errorOf(answer: Answer): { code?: unknown; message?: unknown; fields?: unknown } {
  return (answer.body['error'] ?? {}) as { code?: unknown; message?: unknown; fields?: unknown };
}

function sessionCookieIssued(answer: Answer): boolean {
  return answer.cookies.some(
    (c) => c.startsWith('__Host-xecret_session=') && !c.includes('Max-Age=0'),
  );
}

function cookieValue(answer: Answer, name: string): string | null {
  const header = answer.cookies.find((c) => c.startsWith(`${name}=`) && !c.includes('Max-Age=0'));
  return header === undefined ? null : header.slice(name.length + 1, header.indexOf(';'));
}

/** Records every rate-limit key spent, allowing all of them unless `refuse` says otherwise. */
function recordLimits(refuse: (key: string) => boolean = () => false): string[] {
  const keys: string[] = [];
  env['RL_LOGIN'] = {
    limit: async ({ key }: { key: string }) => {
      keys.push(key);
      return { success: !refuse(key) };
    },
  };
  return keys;
}

async function userRows(column: 'email' | 'workos_user_id' | 'id', value: string) {
  return (
    await t.pg.query<{ id: string; workos_user_id: string | null; email: string }>(
      `select id, workos_user_id, email::text as email from users where ${column} = $1`,
      [value],
    )
  ).rows;
}

/** The durable counter's consecutive failures against an address, or 0 with no row. */
async function failuresFor(email: string): Promise<number> {
  const rows = (
    await t.pg.query<{ failed_attempts: number }>(
      `select failed_attempts from sign_in_failures where subject_hash = $1`,
      [await signInSubject(email)],
    )
  ).rows;
  return rows[0]?.failed_attempts ?? 0;
}

/** When the durable lockout against an address ends, or `null`. */
async function lockedUntil(email: string): Promise<Date | null> {
  const rows = (
    await t.pg.query<{ locked_until: Date | null }>(
      `select locked_until from sign_in_failures where subject_hash = $1`,
      [await signInSubject(email)],
    )
  ).rows;
  return rows[0]?.locked_until ?? null;
}

/** Puts an address under a running lockout, as a burst of failures would have. */
async function lockOut(email: string): Promise<void> {
  await t.pg.query(
    `insert into sign_in_failures (subject_hash, failed_attempts, locked_until, last_failed_at)
     values ($1, $2, now() + interval '10 minutes', now())`,
    [await signInSubject(email), SIGN_IN_FREE_FAILURES + 3],
  );
}

/**
 * The error the real SDK raises when its timeout fires — produced, not
 * restated: a `fetch` that never answers, the interactive options with a
 * 20 ms timeout, and whatever the SDK throws is what the stubs then throw.
 */
async function realSdkTimeout(): Promise<unknown> {
  vi.stubGlobal(
    'fetch',
    (_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      }),
  );
  try {
    const sdk = new WorkOS('sk_test_not_a_real_key', {
      clientId: CLIENT_ID,
      timeout: 20,
      maxRetries: 0,
    });
    return await sdk.userManagement
      .authenticateWithPassword({ clientId: CLIENT_ID, email: 'slow@example.com', password: 'x' })
      .catch((error: unknown) => error);
  } finally {
    vi.unstubAllGlobals();
  }
}

/**
 * Signs `who` in once with a password, as their own browser would, and answers
 * the `name=value` of the known-device cookie that browser was handed.
 */
async function signInOnce(who: Record<string, unknown>): Promise<string> {
  workos.authenticateWithPassword.mockResolvedValueOnce(authenticated(who, 'Password'));
  const answer = await post('/api/auth/sign-in/password', { email: who.email, password: PASSWORD });
  const set = answer.cookies.find((c) => c.startsWith('__Host-xecret_known_device='));
  if (set === undefined) throw new Error('the sign-in handed this browser no known-device cookie');
  workos.authenticateWithPassword.mockClear();
  return set.slice(0, set.indexOf(';'));
}

/** One wrong password for `email`, from the current `clientIp`, without a known-device cookie. */
async function wrongPassword(email: string): Promise<Answer> {
  workos.authenticateWithPassword.mockRejectedValueOnce(
    refusal(400, { code: 'invalid_credentials' }),
  );
  return post('/api/auth/sign-in/password', { email, password: 'not it' });
}

async function membershipsOf(userId: string) {
  return (
    await t.pg.query<{ org_id: string; role: string }>(
      `select org_id, role from org_members where user_id = $1`,
      [userId],
    )
  ).rows;
}

async function seedUser(over: { workosUserId?: string; email?: string; deleted?: boolean } = {}) {
  const id = randomUUID();
  const email = over.email ?? `${unique('seeded-')}@example.com`;
  await t.pg.query(
    `insert into users (id, firebase_uid, workos_user_id, email, email_verified, deleted_at)
     values ($1, $2, $3, $4, true, $5)`,
    [
      id,
      over.workosUserId === undefined ? unique('fb') : null,
      over.workosUserId ?? null,
      email,
      over.deleted ? new Date() : null,
    ],
  );
  return { id, email };
}

async function seedOrg(over: { workosOrgId?: string; ssoRequired?: boolean } = {}) {
  const founder = await seedUser();
  const id = randomUUID();
  await t.pg.query(
    `insert into organizations (id, name, slug, created_by, workos_org_id, workos_client_id, sso_required)
     values ($1, 'BigCorp', $2, $3, $4, $5, $6)`,
    [
      id,
      `bigcorp-${id.slice(0, 8)}`,
      founder.id,
      over.workosOrgId ?? null,
      over.workosOrgId === undefined ? null : CLIENT_ID,
      over.ssoRequired ?? false,
    ],
  );
  await addMember(id, founder.id, 'owner');
  return id;
}

async function addMember(orgId: string, userId: string, role = 'developer') {
  await t.pg.query(`insert into org_members (id, org_id, user_id, role) values ($1, $2, $3, $4)`, [
    randomUUID(),
    orgId,
    userId,
    role,
  ]);
}

/** Every line this request logged, and every answer it gave, as one string. */
function everythingSaid(...answers: Answer[]): string {
  return JSON.stringify(lines) + answers.map((a) => a.text + a.cookies.join(';')).join('\n');
}

const CLI_AUTHORIZE =
  '/cli/authorize?challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&port=52310' +
  '&device=Nitheesh%27s%20MacBook%20Pro&state=a%2Bb%3Dc';

/* ── POST /api/auth/sign-in/password ──────────────────────────────────────── */

describe('a password sign-in', () => {
  it('signs a new person in: a session, a personal organisation, auth.signup by password', async () => {
    const who = workosUser();
    workos.authenticateWithPassword.mockResolvedValueOnce(authenticated(who, 'Password'));

    const answer = await post('/api/auth/sign-in/password', {
      email: who.email,
      password: PASSWORD,
    });

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ redirect: '/app' });
    expect(sessionCookieIssued(answer)).toBe(true);
    expect(answer.cookies).toContainEqual(expect.stringMatching(/^__Host-xecret_csrf=/));
    expect(workos.authenticateWithPassword).toHaveBeenCalledWith({
      clientId: CLIENT_ID,
      email: who.email,
      password: PASSWORD,
      ipAddress: '203.0.113.5',
      userAgent: 'vitest',
    });
    const [row] = await userRows('workos_user_id', who.id as string);
    expect(await membershipsOf(row!.id)).toEqual([expect.objectContaining({ role: 'owner' })]);
    expect(audit.find((e) => e.action === 'auth.signup')?.metadata.signInMethod).toBe('password');
  });

  it('signs a Firebase-era account in by its existing password, adopting it by its verified address', async () => {
    const existing = await seedUser();
    const org = await seedOrg();
    await addMember(org, existing.id);
    const who = workosUser({ email: existing.email });
    workos.authenticateWithPassword.mockResolvedValueOnce(authenticated(who, 'Password'));

    const answer = await post('/api/auth/sign-in/password', {
      email: existing.email,
      password: PASSWORD,
    });

    expect(answer.status).toBe(200);
    expect(sessionCookieIssued(answer)).toBe(true);
    expect((await userRows('id', existing.id))[0]?.workos_user_id).toBe(who.id);
    expect(audit.map((e) => e.action)).toEqual(
      expect.arrayContaining(['auth.identity_linked', 'auth.login']),
    );
  });

  it.each([
    ['an invitation', '/invite/tok_abc', '/invite/tok_abc'],
    ['the CLI consent screen, query string intact', CLI_AUTHORIZE, CLI_AUTHORIZE],
    ['an API route', '/api/auth/login?org=attacker-co', '/app'],
    ['a sign-in screen', '/sign-in?org=attacker-co', '/app'],
    ['another site', '//evil.example', '/app'],
  ])('lands on next when it is %s — and only where it is safe', async (_label, next, lands) => {
    const who = workosUser();
    workos.authenticateWithPassword.mockResolvedValueOnce(authenticated(who, 'Password'));

    const answer = await post('/api/auth/sign-in/password', {
      email: who.email,
      password: PASSWORD,
      next,
    });

    expect(answer.body).toEqual({ redirect: lands });
  });

  it.each([
    ['a 400 naming invalid_credentials', refusal(400, { code: 'invalid_credentials' })],
    ['a 403 naming invalid_credentials', refusal(403, { code: 'invalid_credentials' })],
    ['an address with no account (the same answer)', refusal(400, { code: 'invalid_credentials' })],
  ])('answers %s beside the password field, and issues nothing', async (_label, cause) => {
    const who = workosUser();
    workos.authenticateWithPassword.mockRejectedValueOnce(cause);

    const answer = await post('/api/auth/sign-in/password', {
      email: who.email,
      password: 'not it',
    });

    expect(answer.status).toBe(400);
    expect(errorOf(answer)).toMatchObject({
      code: 'bad_request',
      message: SIGN_IN_FORM_MESSAGES['wrong-password'],
      fields: [{ field: 'password', message: SIGN_IN_FORM_MESSAGES['wrong-password'] }],
    });
    expect(sessionCookieIssued(answer)).toBe(false);
    expect(await userRows('email', who.email as string)).toHaveLength(0);
  });

  it('answers WorkOS’s email_verification_required exactly like a wrong password, by default — no oracle for unverified accounts', async () => {
    // Until staging shows WorkOS checks the password first, a code step here
    // could be given for *any* password: the answer, the status, the field and
    // the counter are a wrong password's, byte for byte.
    const unverified = workosUser({ emailVerified: false });
    workos.authenticateWithPassword.mockRejectedValueOnce(
      step('email_verification_required', {
        pending_authentication_token: 'pending_tok_01',
        email: unverified.email,
        email_verification_id: 'email_verification_01',
      }),
    );
    const paused = await post('/api/auth/sign-in/password', {
      email: unverified.email,
      password: PASSWORD,
    });

    const nobody = workosUser();
    workos.authenticateWithPassword.mockRejectedValueOnce(
      refusal(400, { code: 'invalid_credentials' }),
    );
    const wrong = await post('/api/auth/sign-in/password', {
      email: nobody.email,
      password: PASSWORD,
    });

    expect(paused.status).toBe(wrong.status);
    expect(paused.body['error']).toEqual({
      ...(wrong.body['error'] as object),
      requestId: (paused.body['error'] as { requestId: string }).requestId,
    });
    expect(paused.cookies).toEqual([]);
    expect(paused.text).not.toContain('pending_tok_01');
    expect(await failuresFor(unverified.email as string)).toBe(1);
    expect(await userRows('email', unverified.email as string)).toHaveLength(0);
  });

  it('with the verification step enabled, asks for the emailed code — the pending token sealed in an HttpOnly, SameSite=Strict cookie, never in the body', async () => {
    setEmailVerificationStepForTesting(true);
    const who = workosUser({ emailVerified: false });
    workos.authenticateWithPassword.mockRejectedValueOnce(
      step('email_verification_required', {
        pending_authentication_token: 'pending_tok_01',
        email: who.email,
        email_verification_id: 'email_verification_01',
      }),
    );

    const answer = await post('/api/auth/sign-in/password', {
      email: who.email,
      password: PASSWORD,
    });

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ step: 'verify-email' });
    expect(answer.text).not.toContain('pending_tok_01');
    const cookie = answer.cookies.find((c) => c.startsWith(`${EMAIL_VERIFICATION_COOKIE_NAME}=`));
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(answer.cookies.some((c) => c.startsWith('__Host-xecret_session='))).toBe(false);
    expect(await failuresFor(who.email as string)).toBe(0);
    expect(await userRows('email', who.email as string)).toHaveLength(0);
  });

  it('refuses an address WorkOS answers as unverified without a step: the gate in prepareSignIn holds', async () => {
    const who = workosUser({ emailVerified: false });
    workos.authenticateWithPassword.mockResolvedValueOnce(authenticated(who, 'Password'));

    const answer = await post('/api/auth/sign-in/password', {
      email: who.email,
      password: PASSWORD,
    });

    expect(answer.status).toBe(403);
    expect(errorOf(answer).message).toBe(SIGN_IN_ERROR_MESSAGES['verify-email']);
    expect(sessionCookieIssued(answer)).toBe(false);
    expect(await userRows('email', who.email as string)).toHaveLength(0);
  });

  it('passes the linker’s address conflict through as a 409 that names nobody', async () => {
    const holder = await seedUser({ workosUserId: unique('user_01HOLDER') });
    const intruder = workosUser({ email: holder.email });
    workos.authenticateWithPassword.mockResolvedValueOnce(authenticated(intruder, 'Password'));

    const answer = await post('/api/auth/sign-in/password', {
      email: holder.email,
      password: PASSWORD,
    });

    expect(answer.status).toBe(409);
    expect(errorOf(answer)).toMatchObject({
      code: 'conflict',
      message: SIGN_IN_ERROR_MESSAGES['account-conflict'],
    });
    expect(answer.text).not.toContain(holder.id);
    expect(sessionCookieIssued(answer)).toBe(false);
    expect(await userRows('workos_user_id', intruder.id as string)).toHaveLength(0);
  });

  it('refuses a deleted account as deleted', async () => {
    const who = workosUser();
    await seedUser({ workosUserId: who.id as string, email: who.email as string, deleted: true });
    workos.authenticateWithPassword.mockResolvedValueOnce(authenticated(who, 'Password'));

    const answer = await post('/api/auth/sign-in/password', {
      email: who.email,
      password: PASSWORD,
    });

    expect(answer.status).toBe(403);
    expect(errorOf(answer).message).toBe(SIGN_IN_ERROR_MESSAGES['account-deleted']);
    expect(sessionCookieIssued(answer)).toBe(false);
  });

  it('refuses an impersonated authentication outright, writing nothing', async () => {
    const who = workosUser();
    workos.authenticateWithPassword.mockResolvedValueOnce(
      authenticated(who, 'Password', {
        impersonator: { email: 'support@workos.example', reason: null },
      }),
    );

    const answer = await post('/api/auth/sign-in/password', {
      email: who.email,
      password: PASSWORD,
    });

    expect(answer.status).toBe(403);
    expect(errorOf(answer).message).toBe(SIGN_IN_ERROR_MESSAGES.impersonation);
    expect(await userRows('email', who.email as string)).toHaveLength(0);
  });

  it('holds sso_required: an account whose every organisation requires its single sign-on is refused', async () => {
    const who = workosUser();
    const member = await seedUser({ workosUserId: who.id as string, email: who.email as string });
    const org = await seedOrg({ workosOrgId: unique('org_01'), ssoRequired: true });
    await addMember(org, member.id);
    workos.authenticateWithPassword.mockResolvedValueOnce(authenticated(who, 'Password'));

    const answer = await post('/api/auth/sign-in/password', {
      email: who.email,
      password: PASSWORD,
    });

    expect(answer.status).toBe(403);
    expect(errorOf(answer).message).toBe(SIGN_IN_ERROR_MESSAGES['sso-required']);
    expect(sessionCookieIssued(answer)).toBe(false);
  });

  it.each([
    ['mfa_challenge', 'authenticator-required'],
    ['mfa_enrollment', 'authenticator-required'],
    ['sso_required', 'sso-required'],
    ['radar_sms_challenge', 'extra-check'],
  ] as const)('refuses a WorkOS %s step with its own sentence', async (stepCode, code) => {
    const who = workosUser();
    workos.authenticateWithPassword.mockRejectedValueOnce(
      step(stepCode, {
        pending_authentication_token: 'pending',
        authentication_factors: [{ id: 'auth_factor_01', type: 'totp' }],
      }),
    );

    const answer = await post('/api/auth/sign-in/password', {
      email: who.email,
      password: PASSWORD,
    });

    expect(answer.status).toBe(403);
    expect(errorOf(answer).message).toBe(SIGN_IN_ERROR_MESSAGES[code]);
    expect(sessionCookieIssued(answer)).toBe(false);
  });

  it('finishes WorkOS’s organisation selection, holds the sign-in for confirmation, and the confirmation issues it', async () => {
    const who = workosUser();
    workos.authenticateWithPassword.mockRejectedValueOnce(
      step('organization_selection_required', {
        pending_authentication_token: 'pending_org',
        organizations: [
          { id: 'org_01ONE', name: 'One' },
          { id: 'org_01TWO', name: 'Two' },
        ],
      }),
    );
    workos.authenticateWithOrganizationSelection.mockResolvedValueOnce(
      authenticated(who, 'Password', { organizationId: 'org_01ONE' }),
    );

    const answer = await post('/api/auth/sign-in/password', {
      email: who.email,
      password: PASSWORD,
      next: '/app/acme',
    });

    expect(workos.authenticateWithOrganizationSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingAuthenticationToken: 'pending_org',
        organizationId: 'org_01ONE',
      }),
    );
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ redirect: '/sign-in/confirm' });
    expect(sessionCookieIssued(answer)).toBe(false);
    const parked = cookieValue(answer, SIGN_IN_CONFIRMATION_COOKIE_NAME);
    expect(parked).not.toBeNull();
    const opened = await openSignInConfirmation(
      await deriveSignInConfirmationKey(COOKIE_PASSWORD),
      parked!,
      new Date(),
    );
    expect(opened.ok && opened.value.reason).toBe('organization');
    expect(opened.ok && opened.value.signInMethod).toBe('password');

    // The page's "Continue" — the confirmation route, unchanged.
    const confirmed = await confirmRoute.POST(
      new Request(`${ORIGIN}/api/auth/confirm`, {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/x-www-form-urlencoded',
          cookie: `${SIGN_IN_CONFIRMATION_COOKIE_NAME}=${parked}`,
        },
        body: new URLSearchParams({
          confirmation: opened.ok ? opened.value.nonce : '',
          decision: 'continue',
        }).toString(),
      }),
    );
    expect(confirmed.status).toBe(303);
    expect(confirmed.headers.get('location')).toBe('/app/acme');
    expect(
      confirmed.headers.getSetCookie().some((c) => c.startsWith('__Host-xecret_session=')),
    ).toBe(true);
  });

  it.each([
    ['WorkOS down', refusal(503, {}), 503, 'unavailable'],
    ['our API key refused', refusal(401, {}), 503, 'unavailable'],
    ['WorkOS rate-limiting us', refusal(429, {}), 429, 'rate-limited'],
    [
      'password sign-in switched off',
      refusal(400, { code: 'authentication_method_not_allowed' }),
      503,
      'unavailable',
    ],
  ] as const)(
    'reports %s as the service’s trouble, not the person’s',
    async (_label, cause, status, code) => {
      workos.authenticateWithPassword.mockRejectedValueOnce(cause);

      const answer = await post('/api/auth/sign-in/password', {
        email: 'someone@example.com',
        password: PASSWORD,
      });

      expect(answer.status).toBe(status);
      expect(errorOf(answer).message).toBe(SIGN_IN_ERROR_MESSAGES[code]);
    },
  );

  it('answers a deployment without its WorkOS key as unavailable, not as a crash', async () => {
    delete env['WORKOS_COOKIE_PASSWORD'];
    const who = workosUser();
    workos.authenticateWithPassword.mockResolvedValueOnce(authenticated(who, 'Password'));

    const answer = await post('/api/auth/sign-in/password', {
      email: who.email,
      password: PASSWORD,
    });

    expect(answer.status).toBe(503);
    expect(errorOf(answer).message).toBe(SIGN_IN_ERROR_MESSAGES.unavailable);
    expect(sessionCookieIssued(answer)).toBe(false);
  });

  it('refuses a body without a password, or with a field it does not take, before asking WorkOS', async () => {
    for (const body of [
      { email: 'someone@example.com' },
      { email: 'someone@example.com', password: '' },
      { email: 'not an address', password: PASSWORD },
      { email: 'someone@example.com', password: PASSWORD, admin: true },
      'not json',
    ]) {
      const answer = await post('/api/auth/sign-in/password', body);
      expect([400, 422]).toContain(answer.status);
    }
    expect(workos.authenticateWithPassword).not.toHaveBeenCalled();
  });

  it('never logs, echoes or stores the password, whether it was right or wrong', async () => {
    const who = workosUser();
    workos.authenticateWithPassword.mockRejectedValueOnce(
      refusal(400, { code: 'invalid_credentials' }),
    );
    const wrong = await post('/api/auth/sign-in/password', {
      email: who.email,
      password: 'the-wrong-one-zq81',
    });
    workos.authenticateWithPassword.mockResolvedValueOnce(authenticated(who, 'Password'));
    const right = await post('/api/auth/sign-in/password', {
      email: who.email,
      password: PASSWORD,
    });

    expect(right.status).toBe(200);
    const said = everythingSaid(wrong, right) + JSON.stringify(audit);
    expect(said).not.toContain('the-wrong-one-zq81');
    expect(said).not.toContain(PASSWORD);
    const stored = await t.pg.query(`select * from users where workos_user_id = $1`, [who.id]);
    expect(JSON.stringify(stored.rows)).not.toContain(PASSWORD);
  });
});

/* ── POST /api/auth/sign-in/code ──────────────────────────────────────────── */

describe('asking for an emailed code', () => {
  it('has WorkOS email a code, and answers 204 with nothing in it — the code WorkOS returned included', async () => {
    const answer = await post('/api/auth/sign-in/code', { email: 'new.person@example.com' });

    expect(answer.status).toBe(204);
    expect(answer.text).toBe('');
    expect(answer.cookies).toEqual([]);
    expect(workos.createMagicAuth).toHaveBeenCalledWith({
      email: 'new.person@example.com',
      ipAddress: '203.0.113.5',
      userAgent: 'vitest',
    });
    expect(JSON.stringify(lines)).not.toContain('918273');
  });

  it.each([
    ['a 404', refusal(404, { code: 'entity_not_found' })],
    ['a 422', refusal(422, { code: 'invalid_email' })],
  ])(
    'answers the same 204 when WorkOS refuses the address with %s — no oracle for accounts',
    async (_label, cause) => {
      workos.createMagicAuth.mockRejectedValueOnce(cause);

      const answer = await post('/api/auth/sign-in/code', { email: 'who@example.com' });

      expect(answer.status).toBe(204);
      expect(lines.some((l) => l.level === 'warn' && l.message.includes('refused to email'))).toBe(
        true,
      );
    },
  );

  it('says so when WorkOS’s policy sends the address to its organisation’s single sign-on', async () => {
    workos.createMagicAuth.mockRejectedValueOnce(refusal(400, { error: 'sso_required' }));

    const answer = await post('/api/auth/sign-in/code', { email: 'someone@bigcorp.example' });

    expect(answer.status).toBe(403);
    expect(errorOf(answer).message).toBe(SIGN_IN_ERROR_MESSAGES['sso-required']);
  });

  it('reports Magic Auth switched off in WorkOS as unavailable', async () => {
    workos.createMagicAuth.mockRejectedValueOnce(
      refusal(400, { error: 'authentication_method_not_allowed' }),
    );

    const answer = await post('/api/auth/sign-in/code', { email: 'someone@example.com' });

    expect(answer.status).toBe(503);
  });

  it('caps mail per address, keyed on the address alone, before WorkOS is asked', async () => {
    const keys = recordLimits((key) => key.startsWith('sign_in_code:'));

    const answer = await post('/api/auth/sign-in/code', { email: 'Victim@Example.com' });

    expect(answer.status).toBe(429);
    expect(errorOf(answer).message).toBe(SIGN_IN_ERROR_MESSAGES['rate-limited']);
    expect(workos.createMagicAuth).not.toHaveBeenCalled();
    const mailKey = keys.find((k) => k.startsWith('sign_in_code:'));
    expect(mailKey).toBe('sign_in_code:victim%40example.com');
    expect(mailKey).not.toContain('203.0.113.5');
  });

  it('refuses by address, on its own key, before the body is read', async () => {
    const keys = recordLimits((key) => key === 'sign_in_code_send_ip:203.0.113.5');

    const answer = await post('/api/auth/sign-in/code', { email: 'someone@example.com' });

    expect(answer.status).toBe(429);
    expect(keys).toEqual(['sign_in_code_send_ip:203.0.113.5']);
    expect(workos.createMagicAuth).not.toHaveBeenCalled();
  });

  it.each([
    ['a 403 that names a reason', refusal(403, { code: 'user_blocked' })],
    [
      'organization_authentication_methods_required (organisation membership)',
      step('organization_authentication_methods_required'),
    ],
  ])('answers %s with the same 204, not a tell', async (_label, cause) => {
    workos.createMagicAuth.mockRejectedValueOnce(cause);

    const answer = await post('/api/auth/sign-in/code', { email: 'member@bigcorp.example' });

    expect(answer.status).toBe(204);
  });

  it('still reads a bare 403 as the deployment’s key, not the address', async () => {
    workos.createMagicAuth.mockRejectedValueOnce(refusal(403, {}));

    const answer = await post('/api/auth/sign-in/code', { email: 'someone@example.com' });

    expect(answer.status).toBe(503);
  });

  it('spends nothing of the durable throttle: asking for a code is not a guess', async () => {
    const who = workosUser();
    for (let i = 0; i < SIGN_IN_FREE_FAILURES; i += 1) {
      workos.authenticateWithPassword.mockRejectedValueOnce(
        refusal(400, { code: 'invalid_credentials' }),
      );
      await post('/api/auth/sign-in/password', { email: who.email, password: 'x' });
    }

    const answer = await post('/api/auth/sign-in/code', { email: who.email });

    expect(answer.status).toBe(204);
    expect(workos.createMagicAuth).toHaveBeenCalledTimes(1);
    expect(await failuresFor(who.email as string)).toBe(SIGN_IN_FREE_FAILURES);
  });

  it('mails no code while the pool it would be checked against is locked — and says so', async () => {
    const who = workosUser();
    await lockOut(who.email as string);

    const answer = await post('/api/auth/sign-in/code', { email: who.email });

    expect(answer.status).toBe(429);
    expect(errorOf(answer).message).toBe(SIGN_IN_ERROR_MESSAGES['rate-limited']);
    expect(workos.createMagicAuth).not.toHaveBeenCalled();
  });

  it('still mails a code to the owner’s known browser while the shared pool is locked', async () => {
    const who = workosUser();
    const device = await signInOnce(who);
    await lockOut(who.email as string);

    const answer = await post('/api/auth/sign-in/code', { email: who.email }, { cookie: device });

    expect(answer.status).toBe(204);
    expect(workos.createMagicAuth).toHaveBeenCalledTimes(1);
  });

  it('answers a WorkOS timeout as unavailable, not as a refusal of the address', async () => {
    workos.createMagicAuth.mockRejectedValueOnce(await realSdkTimeout());

    const answer = await post('/api/auth/sign-in/code', { email: 'someone@example.com' });

    expect(answer.status).toBe(503);
    expect(errorOf(answer).message).toBe(SIGN_IN_ERROR_MESSAGES.unavailable);
  });
});

/* ── POST /api/auth/sign-in/code/verify ───────────────────────────────────── */

describe('signing in with an emailed code', () => {
  it('creates the account a new address signs up for: auth.signup by magic_auth', async () => {
    const who = workosUser();
    workos.authenticateWithMagicAuth.mockResolvedValueOnce(authenticated(who, 'MagicAuth'));

    const answer = await post('/api/auth/sign-in/code/verify', {
      email: who.email,
      code: '482913',
      next: '/invite/tok_abc',
    });

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ redirect: '/invite/tok_abc' });
    expect(sessionCookieIssued(answer)).toBe(true);
    expect(workos.authenticateWithMagicAuth).toHaveBeenCalledWith({
      clientId: CLIENT_ID,
      code: '482913',
      email: who.email,
      ipAddress: '203.0.113.5',
      userAgent: 'vitest',
    });
    const [row] = await userRows('workos_user_id', who.id as string);
    expect(row).toBeDefined();
    expect(audit.find((e) => e.action === 'auth.signup')?.metadata.signInMethod).toBe('magic_auth');
  });

  it('answers a wrong or expired code beside the code field, and issues nothing', async () => {
    const who = workosUser();
    workos.authenticateWithMagicAuth.mockRejectedValueOnce(
      refusal(400, { code: 'invalid_one_time_code' }),
    );

    const answer = await post('/api/auth/sign-in/code/verify', {
      email: who.email,
      code: '000000',
    });

    expect(answer.status).toBe(400);
    expect(errorOf(answer)).toMatchObject({
      message: SIGN_IN_FORM_MESSAGES['wrong-code'],
      fields: [{ field: 'code', message: SIGN_IN_FORM_MESSAGES['wrong-code'] }],
    });
    expect(sessionCookieIssued(answer)).toBe(false);
    expect(await userRows('email', who.email as string)).toHaveLength(0);
  });

  it('refuses a code that is not six digits before asking WorkOS', async () => {
    for (const code of ['12345', '1234567', '12a456', '']) {
      const answer = await post('/api/auth/sign-in/code/verify', {
        email: 'someone@example.com',
        code,
      });
      expect(answer.status).toBe(422);
    }
    expect(workos.authenticateWithMagicAuth).not.toHaveBeenCalled();
  });

  it('bounds guesses per address from anywhere, before WorkOS is asked', async () => {
    const keys = recordLimits((key) => key.startsWith('sign_in_code_guess:'));

    const answer = await post('/api/auth/sign-in/code/verify', {
      email: 'Target@Example.com',
      code: '123456',
    });

    expect(answer.status).toBe(429);
    expect(workos.authenticateWithMagicAuth).not.toHaveBeenCalled();
    expect(keys).toContain('sign_in_code_guess:target%40example.com');
    // And the address-and-IP bucket the password route spends.
    expect(keys).toContain('203.0.113.5:target%40example.com');
  });

  it('refuses by identity once WorkOS has named one, as the callback does', async () => {
    const who = workosUser();
    const keys = recordLimits((key) => key.includes((who.id as string).toLowerCase()));
    workos.authenticateWithMagicAuth.mockResolvedValueOnce(authenticated(who, 'MagicAuth'));

    const answer = await post('/api/auth/sign-in/code/verify', {
      email: who.email,
      code: '123456',
    });

    expect(answer.status).toBe(429);
    expect(keys.some((k) => k.includes((who.id as string).toLowerCase()))).toBe(true);
    expect(await userRows('workos_user_id', who.id as string)).toHaveLength(0);
  });

  it('passes the linker’s address conflict through, as for a password', async () => {
    const holder = await seedUser({ workosUserId: unique('user_01HOLDER') });
    const intruder = workosUser({ email: holder.email });
    workos.authenticateWithMagicAuth.mockResolvedValueOnce(authenticated(intruder, 'MagicAuth'));

    const answer = await post('/api/auth/sign-in/code/verify', {
      email: holder.email,
      code: '123456',
    });

    expect(answer.status).toBe(409);
    expect(errorOf(answer).message).toBe(SIGN_IN_ERROR_MESSAGES['account-conflict']);
    expect(sessionCookieIssued(answer)).toBe(false);
  });

  it('never logs or echoes the code', async () => {
    const who = workosUser();
    workos.authenticateWithMagicAuth.mockRejectedValueOnce(
      refusal(400, { code: 'invalid_one_time_code' }),
    );
    const wrong = await post('/api/auth/sign-in/code/verify', { email: who.email, code: '730416' });
    workos.authenticateWithMagicAuth.mockResolvedValueOnce(authenticated(who, 'MagicAuth'));
    const right = await post('/api/auth/sign-in/code/verify', { email: who.email, code: '591827' });

    expect(right.status).toBe(200);
    const said = everythingSaid(wrong, right) + JSON.stringify(audit);
    expect(said).not.toContain('730416');
    expect(said).not.toContain('591827');
  });
});

/* ── POST /api/auth/sign-in/verify-email ──────────────────────────────────── */

describe('finishing a password sign-in by verifying the address', () => {
  /** The verification cookie, sealed as the password route seals it. */
  async function pausedCookie(
    email: string,
    over: { pendingToken?: string; issuedAt?: number } = {},
  ): Promise<string> {
    const sealed = await sealEmailVerification(await deriveEmailVerificationKey(COOKIE_PASSWORD), {
      email,
      pendingToken: over.pendingToken ?? 'pending_tok_02',
      issuedAt: over.issuedAt ?? Math.floor(Date.now() / 1000),
    });
    return `${EMAIL_VERIFICATION_COOKIE_NAME}=${sealed}`;
  }

  function cleared(answer: Answer): boolean {
    return answer.cookies.some(
      (c) => c.startsWith(`${EMAIL_VERIFICATION_COOKIE_NAME}=;`) && c.includes('Max-Age=0'),
    );
  }

  it('signs in only once the emailed code verifies the address: password, then code, the token never leaving the cookie', async () => {
    setEmailVerificationStepForTesting(true);
    const unverified = workosUser({ emailVerified: false });
    workos.authenticateWithPassword.mockRejectedValueOnce(
      step('email_verification_required', { pending_authentication_token: 'pending_tok_02' }),
    );
    const paused = await post('/api/auth/sign-in/password', {
      email: unverified.email,
      password: PASSWORD,
    });
    expect(paused.body).toEqual({ step: 'verify-email' });
    const set = paused.cookies.find((c) => c.startsWith(`${EMAIL_VERIFICATION_COOKIE_NAME}=`))!;
    expect(await userRows('email', unverified.email as string)).toHaveLength(0);

    workos.authenticateWithEmailVerification.mockResolvedValueOnce(
      authenticated({ ...unverified, emailVerified: true }, 'Password'),
    );
    const answer = await post(
      '/api/auth/sign-in/verify-email',
      { email: unverified.email, code: '246810', next: '/app/acme' },
      { cookie: set.slice(0, set.indexOf(';')) },
    );

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ redirect: '/app/acme' });
    expect(sessionCookieIssued(answer)).toBe(true);
    expect(cleared(answer)).toBe(true);
    expect(workos.authenticateWithEmailVerification).toHaveBeenCalledWith({
      clientId: CLIENT_ID,
      code: '246810',
      pendingAuthenticationToken: 'pending_tok_02',
      ipAddress: '203.0.113.5',
      userAgent: 'vitest',
    });
    expect(await userRows('workos_user_id', unverified.id as string)).toHaveLength(1);
  });

  it('dates the flow from the paused password step, so minutes spent finding the email do not read as a reused session', async () => {
    const who = workosUser();
    const pausedAt = Math.floor(Date.now() / 1000) - 5 * 60;
    // WorkOS dates the authentication by the password step, five minutes ago.
    workos.authenticateWithEmailVerification.mockResolvedValueOnce(
      authenticated(who, 'Password', { accessToken: accessToken(pausedAt) }),
    );

    const answer = await post(
      '/api/auth/sign-in/verify-email',
      { email: who.email, code: '246810' },
      { cookie: await pausedCookie(who.email as string, { issuedAt: pausedAt }) },
    );

    expect(answer.body).toEqual({ redirect: '/app' });
    expect(sessionCookieIssued(answer)).toBe(true);
  });

  it.each([
    ['no cookie at all', async () => undefined, 400],
    ['a cookie sealed for another address', async () => pausedCookie('victim@example.com'), 403],
    [
      'a cookie past its ten minutes',
      async () =>
        pausedCookie('someone@example.com', { issuedAt: Math.floor(Date.now() / 1000) - 11 * 60 }),
      400,
    ],
    [
      'a cookie altered on the way',
      async () => `${(await pausedCookie('someone@example.com')).slice(0, -2)}AA`,
      400,
    ],
  ])(
    'refuses %s as an expired attempt, clears it, and never asks WorkOS',
    async (_label, cookie, status) => {
      const value = await cookie();
      const answer = await post(
        '/api/auth/sign-in/verify-email',
        { email: 'someone@example.com', code: '111111' },
        value === undefined ? {} : { cookie: value },
      );

      expect(answer.status).toBe(status);
      expect(errorOf(answer).message).toBe(SIGN_IN_ERROR_MESSAGES.expired);
      expect(cleared(answer)).toBe(true);
      expect(workos.authenticateWithEmailVerification).not.toHaveBeenCalled();
    },
  );

  it('answers a wrong code beside the code field, keeps the cookie for the right one, and counts it', async () => {
    const who = workosUser();
    workos.authenticateWithEmailVerification.mockRejectedValueOnce(
      refusal(400, { code: 'email_verification_code_invalid' }),
    );

    const answer = await post(
      '/api/auth/sign-in/verify-email',
      { email: who.email, code: '111111' },
      { cookie: await pausedCookie(who.email as string, { pendingToken: 'pending_tok_03' }) },
    );

    expect(answer.status).toBe(400);
    expect(errorOf(answer).fields).toEqual([
      { field: 'code', message: SIGN_IN_FORM_MESSAGES['wrong-code'] },
    ]);
    expect(sessionCookieIssued(answer)).toBe(false);
    expect(cleared(answer)).toBe(false);
    expect(await failuresFor(who.email as string)).toBe(1);
  });

  it('still refuses an address WorkOS answers as unverified', async () => {
    const who = workosUser({ emailVerified: false });
    workos.authenticateWithEmailVerification.mockResolvedValueOnce(authenticated(who, 'Password'));

    const answer = await post(
      '/api/auth/sign-in/verify-email',
      { email: who.email, code: '111111' },
      { cookie: await pausedCookie(who.email as string, { pendingToken: 'pending_tok_04' }) },
    );

    expect(answer.status).toBe(403);
    expect(errorOf(answer).message).toBe(SIGN_IN_ERROR_MESSAGES['verify-email']);
    expect(sessionCookieIssued(answer)).toBe(false);
  });

  it('spends the address’s code-guess bucket, as an emailed sign-in code does, before asking WorkOS', async () => {
    const keys = recordLimits((key) => key.startsWith('sign_in_code_guess:'));

    const answer = await post(
      '/api/auth/sign-in/verify-email',
      { email: 'Guess@Example.com', code: '111111' },
      { cookie: await pausedCookie('guess@example.com') },
    );

    expect(answer.status).toBe(429);
    expect(keys).toContain('sign_in_verify_email_ip:203.0.113.5');
    expect(keys).toContain('sign_in_code_guess:guess%40example.com');
    expect(workos.authenticateWithEmailVerification).not.toHaveBeenCalled();
  });

  it('refuses a locked address before asking WorkOS', async () => {
    const who = workosUser();
    await lockOut(who.email as string);

    const answer = await post(
      '/api/auth/sign-in/verify-email',
      { email: who.email, code: '111111' },
      { cookie: await pausedCookie(who.email as string) },
    );

    expect(answer.status).toBe(429);
    expect(errorOf(answer).message).toBe(SIGN_IN_ERROR_MESSAGES['rate-limited']);
    expect(workos.authenticateWithEmailVerification).not.toHaveBeenCalled();
  });

  it('ends every request as an expired attempt while the step is off: no cookie can exist', async () => {
    workos.authenticateWithPassword.mockRejectedValueOnce(
      step('email_verification_required', { pending_authentication_token: 'pending_tok_05' }),
    );
    const paused = await post('/api/auth/sign-in/password', {
      email: 'someone@example.com',
      password: PASSWORD,
    });
    expect(paused.cookies).toEqual([]);

    const answer = await post('/api/auth/sign-in/verify-email', {
      email: 'someone@example.com',
      code: '111111',
    });

    expect(answer.status).toBe(400);
    expect(workos.authenticateWithEmailVerification).not.toHaveBeenCalled();
  });
});

/* ── the durable per-address lockout ──────────────────────────────────────── */

describe('the durable per-address lockout', () => {
  it('lets a person mistype five times freely, then locks the address — before WorkOS is asked, whatever IP comes next', async () => {
    const who = workosUser();
    for (let i = 1; i <= SIGN_IN_FREE_FAILURES; i += 1) {
      clientIp = `198.51.100.${i}`;
      expect((await wrongPassword(who.email as string)).status).toBe(400);
    }
    expect(await lockedUntil(who.email as string)).toBeNull();

    // The sixth failure is still asked of WorkOS, and earns the first lockout.
    clientIp = '198.51.100.6';
    expect((await wrongPassword(who.email as string)).status).toBe(400);
    expect(await failuresFor(who.email as string)).toBe(SIGN_IN_FREE_FAILURES + 1);
    expect((await lockedUntil(who.email as string))!.getTime()).toBeGreaterThan(Date.now());

    // From a fresh address, even with the right password: refused, and WorkOS never asked.
    clientIp = '192.0.2.77';
    workos.authenticateWithPassword.mockClear();
    workos.authenticateWithPassword.mockResolvedValueOnce(authenticated(who, 'Password'));
    const locked = await post('/api/auth/sign-in/password', {
      email: who.email,
      password: PASSWORD,
    });
    expect(locked.status).toBe(429);
    expect(errorOf(locked).message).toBe(SIGN_IN_ERROR_MESSAGES['rate-limited']);
    expect(workos.authenticateWithPassword).not.toHaveBeenCalled();
    expect(sessionCookieIssued(locked)).toBe(false);
  });

  it('is one count per address across passwords and emailed codes, whatever case it is typed in', async () => {
    const who = workosUser();
    const email = who.email as string;
    await lockOut(email);

    const answer = await post('/api/auth/sign-in/code/verify', {
      email: email.toUpperCase(),
      code: '123456',
    });

    expect(answer.status).toBe(429);
    expect(workos.authenticateWithMagicAuth).not.toHaveBeenCalled();
  });

  it('counts wrong codes like wrong passwords', async () => {
    const who = workosUser();
    workos.authenticateWithMagicAuth.mockRejectedValueOnce(
      refusal(400, { code: 'invalid_one_time_code' }),
    );

    await post('/api/auth/sign-in/code/verify', { email: who.email, code: '000000' });

    expect(await failuresFor(who.email as string)).toBe(1);
  });

  it('is wiped by a success, which then starts again with every free attempt', async () => {
    const who = workosUser();
    for (let i = 0; i < SIGN_IN_FREE_FAILURES - 1; i += 1) await wrongPassword(who.email as string);
    expect(await failuresFor(who.email as string)).toBe(SIGN_IN_FREE_FAILURES - 1);

    workos.authenticateWithPassword.mockResolvedValueOnce(authenticated(who, 'Password'));
    const right = await post('/api/auth/sign-in/password', {
      email: who.email,
      password: PASSWORD,
    });

    expect(right.status).toBe(200);
    expect(await failuresFor(who.email as string)).toBe(0);
  });

  it('forgets failures older than its window: the next one starts the count again', async () => {
    const who = workosUser();
    for (let i = 0; i < SIGN_IN_FREE_FAILURES; i += 1) await wrongPassword(who.email as string);
    await t.pg.query(
      `update sign_in_failures set last_failed_at = now() - interval '25 hours'
        where subject_hash = $1`,
      [await signInSubject(who.email as string)],
    );

    await wrongPassword(who.email as string);

    expect(await failuresFor(who.email as string)).toBe(1);
    expect(await lockedUntil(who.email as string)).toBeNull();
  });

  it('does not count what is not a guess: WorkOS down, a refusal after WorkOS accepted, a request refused in front', async () => {
    const holder = await seedUser({ workosUserId: unique('user_01HOLDER') });
    const intruder = workosUser({ email: holder.email });

    workos.authenticateWithPassword.mockRejectedValueOnce(refusal(503, {}));
    await post('/api/auth/sign-in/password', { email: holder.email, password: PASSWORD });
    workos.authenticateWithPassword.mockResolvedValueOnce(authenticated(intruder, 'Password'));
    const conflict = await post('/api/auth/sign-in/password', {
      email: holder.email,
      password: PASSWORD,
    });
    await post(
      '/api/auth/sign-in/password',
      { email: holder.email, password: PASSWORD },
      {
        origin: 'https://evil.example',
      },
    );

    expect(conflict.status).toBe(409);
    expect(await failuresFor(holder.email)).toBe(0);
  });

  it('folds organization_authentication_methods_required into a wrong password — and counts it', async () => {
    const who = workosUser();
    workos.authenticateWithPassword.mockRejectedValueOnce(
      step('organization_authentication_methods_required'),
    );

    const answer = await post('/api/auth/sign-in/password', {
      email: who.email,
      password: PASSWORD,
    });

    expect(answer.status).toBe(400);
    expect(errorOf(answer).message).toBe(SIGN_IN_FORM_MESSAGES['wrong-password']);
    expect(await failuresFor(who.email as string)).toBe(1);
  });

  it('keys the counter on an HMAC under the deployment’s secret: never the address, nor a plain hash of it', async () => {
    const email = 'never-stored@example.com';
    await wrongPassword(email);

    const rows = await t.pg.query<{ subject_hash: Uint8Array }>(
      `select subject_hash from sign_in_failures`,
    );
    expect(rows.rows).toHaveLength(1);
    const stored = Buffer.from(rows.rows[0]!.subject_hash);
    expect(stored.toString('latin1')).not.toContain('never-stored');
    const plain = Buffer.from(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email)),
    );
    expect(stored.equals(plain)).toBe(false);
    expect(stored.equals(Buffer.from(await signInSubject(email)))).toBe(true);
    // Another deployment's secret keys the same address somewhere else entirely.
    const elsewhere = await addressPool(
      { WORKOS_COOKIE_PASSWORD: 'a-different-cookie-password-also-over-32-characters' } as never,
      email,
    );
    expect(stored.equals(Buffer.from(elsewhere))).toBe(false);
  });
});

/* ── review round 2: timeouts, bursts, and the owner's own browser ────────── */

describe('a WorkOS timeout (the real SDK’s)', () => {
  it('is answered as unavailable on a password, never as a wrong password, and counts nothing', async () => {
    const who = workosUser();
    workos.authenticateWithPassword.mockRejectedValueOnce(await realSdkTimeout());

    const answer = await post('/api/auth/sign-in/password', {
      email: who.email,
      password: PASSWORD,
    });

    expect(answer.status).toBe(503);
    expect(errorOf(answer).message).toBe(SIGN_IN_ERROR_MESSAGES.unavailable);
    expect(errorOf(answer).fields).toBeUndefined();
    expect(await failuresFor(who.email as string)).toBe(0);
  });

  it('is answered as unavailable on an emailed code, never as a wrong code, and counts nothing', async () => {
    const who = workosUser();
    workos.authenticateWithMagicAuth.mockRejectedValueOnce(await realSdkTimeout());

    const answer = await post('/api/auth/sign-in/code/verify', {
      email: who.email,
      code: '123456',
    });

    expect(answer.status).toBe(503);
    expect(errorOf(answer).message).toBe(SIGN_IN_ERROR_MESSAGES.unavailable);
    expect(await failuresFor(who.email as string)).toBe(0);
  });
});

describe('a burst of concurrent guesses (counted before WorkOS is asked)', () => {
  function everyGuessWrong() {
    workos.authenticateWithPassword.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw refusal(400, { code: 'invalid_credentials' });
    });
  }

  it('lets exactly one of forty through at the end of the free attempts', async () => {
    const who = workosUser();
    for (let i = 0; i < SIGN_IN_FREE_FAILURES; i += 1) await wrongPassword(who.email as string);
    workos.authenticateWithPassword.mockReset();
    everyGuessWrong();

    const answers = await Promise.all(
      Array.from({ length: 40 }, (_, i) => {
        clientIp = `198.51.100.${i + 1}`;
        return post('/api/auth/sign-in/password', { email: who.email, password: `guess-${i}` });
      }),
    );

    expect(workos.authenticateWithPassword).toHaveBeenCalledTimes(1);
    expect(answers.filter((a) => a.status === 400)).toHaveLength(1);
    expect(answers.filter((a) => a.status === 429)).toHaveLength(39);
    expect(await failuresFor(who.email as string)).toBe(SIGN_IN_FREE_FAILURES + 1);
  });

  it('lets exactly the free attempts and one more of forty through on a fresh address', async () => {
    const who = workosUser();
    everyGuessWrong();

    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        post('/api/auth/sign-in/password', { email: who.email, password: `guess-${i}` }),
      ),
    );

    expect(workos.authenticateWithPassword).toHaveBeenCalledTimes(SIGN_IN_FREE_FAILURES + 1);
  });
});

describe('the owner’s own browser (known-device cookie)', () => {
  it('is handed a sealed, HttpOnly, SameSite=Strict, ninety-day cookie by every sign-in that issues a session', async () => {
    const who = workosUser();
    workos.authenticateWithPassword.mockResolvedValueOnce(authenticated(who, 'Password'));

    const answer = await post('/api/auth/sign-in/password', {
      email: who.email,
      password: PASSWORD,
    });

    const set = answer.cookies.find((c) => c.startsWith('__Host-xecret_known_device='));
    expect(set).toContain('HttpOnly');
    expect(set).toContain('Secure');
    expect(set).toContain('SameSite=Strict');
    expect(set).toContain(`Max-Age=${90 * 24 * 60 * 60}`);
    expect(set).not.toContain(who.email as string);
  });

  it('is never handed out by an answer that issues no session — a held-back sign-in or any refusal', async () => {
    const knownDevice = (answer: Answer) =>
      answer.cookies.some((c) => c.startsWith('__Host-xecret_known_device='));
    const holder = await seedUser({ workosUserId: unique('user_01HOLDER') });

    workos.authenticateWithPassword.mockRejectedValueOnce(
      step('organization_selection_required', {
        pending_authentication_token: 'pending_org',
        organizations: [{ id: 'org_01ONE', name: 'One' }],
      }),
    );
    workos.authenticateWithOrganizationSelection.mockResolvedValueOnce(
      authenticated(workosUser(), 'Password', { organizationId: 'org_01ONE' }),
    );
    const parked = await post('/api/auth/sign-in/password', {
      email: 'parked@example.com',
      password: PASSWORD,
    });
    workos.authenticateWithPassword.mockRejectedValueOnce(
      refusal(400, { code: 'invalid_credentials' }),
    );
    const wrong = await post('/api/auth/sign-in/password', {
      email: 'wrong@example.com',
      password: 'x',
    });
    workos.authenticateWithPassword.mockResolvedValueOnce(
      authenticated(workosUser({ email: holder.email }), 'Password'),
    );
    const conflict = await post('/api/auth/sign-in/password', {
      email: holder.email,
      password: PASSWORD,
    });
    workos.authenticateWithMagicAuth.mockRejectedValueOnce(
      refusal(400, { code: 'invalid_one_time_code' }),
    );
    const wrongCode = await post('/api/auth/sign-in/code/verify', {
      email: 'code@example.com',
      code: '000000',
    });
    const csrf = await post(
      '/api/auth/sign-in/password',
      { email: 'csrf@example.com', password: PASSWORD },
      { origin: 'https://evil.example' },
    );

    expect(parked.body).toEqual({ redirect: '/sign-in/confirm' });
    expect([wrong.status, conflict.status, wrongCode.status, csrf.status]).toEqual([
      400, 409, 400, 403,
    ]);
    for (const answer of [parked, wrong, conflict, wrongCode, csrf]) {
      expect(knownDevice(answer)).toBe(false);
    }
  });

  it('signs its owner in while an attacker holds the address’s shared pool locked', async () => {
    const who = workosUser();
    const device = await signInOnce(who);
    // The attacker, from anywhere, without the cookie.
    for (let i = 0; i < SIGN_IN_FREE_FAILURES + 1; i += 1) {
      clientIp = `203.0.113.${100 + i}`;
      await wrongPassword(who.email as string);
    }
    clientIp = '203.0.113.200';
    expect((await wrongPassword(who.email as string)).status).toBe(429);
    // That refusal never reached WorkOS, so its queued answer is still queued.
    workos.authenticateWithPassword.mockReset();

    // The owner, from their own browser.
    clientIp = '192.0.2.10';
    workos.authenticateWithPassword.mockResolvedValueOnce(authenticated(who, 'Password'));
    const owner = await post(
      '/api/auth/sign-in/password',
      { email: who.email, password: PASSWORD },
      { cookie: device },
    );

    expect(owner.status).toBe(200);
    expect(sessionCookieIssued(owner)).toBe(true);
    // And the attacker's lock is still where they left it.
    expect((await lockedUntil(who.email as string))!.getTime()).toBeGreaterThan(Date.now());
  });

  it('gives the owner’s browser a budget of its own: five free, then its own backoff', async () => {
    const who = workosUser();
    const device = await signInOnce(who);
    for (let i = 0; i < SIGN_IN_FREE_FAILURES + 1; i += 1) {
      workos.authenticateWithPassword.mockRejectedValueOnce(
        refusal(400, { code: 'invalid_credentials' }),
      );
      await post(
        '/api/auth/sign-in/password',
        { email: who.email, password: 'typo' },
        {
          cookie: device,
        },
      );
    }

    const seventh = await post(
      '/api/auth/sign-in/password',
      { email: who.email, password: PASSWORD },
      { cookie: device },
    );

    expect(seventh.status).toBe(429);
    // The shared pool was never touched by the owner's typos.
    expect(await failuresFor(who.email as string)).toBe(0);
  });

  it('counts a browser known to another address in that address’s shared pool, like any stranger', async () => {
    const owner = workosUser();
    const device = await signInOnce(owner);
    const target = workosUser();
    workos.authenticateWithPassword.mockRejectedValueOnce(
      refusal(400, { code: 'invalid_credentials' }),
    );

    await post(
      '/api/auth/sign-in/password',
      { email: target.email, password: 'x' },
      {
        cookie: device,
      },
    );

    expect(await failuresFor(target.email as string)).toBe(1);
  });

  it('ignores a cookie it did not seal — the shared pool counts the request', async () => {
    const who = workosUser();
    const device = await signInOnce(who);
    const forged = `${device.slice(0, -4)}AAAA`;
    workos.authenticateWithPassword.mockRejectedValueOnce(
      refusal(400, { code: 'invalid_credentials' }),
    );

    await post(
      '/api/auth/sign-in/password',
      { email: who.email, password: 'x' },
      {
        cookie: forged,
      },
    );

    expect(await failuresFor(who.email as string)).toBe(1);
  });

  it('counts the device by its own key, not by the address', async () => {
    const who = workosUser();
    const device = await signInOnce(who);
    workos.authenticateWithPassword.mockRejectedValueOnce(
      refusal(400, { code: 'invalid_credentials' }),
    );

    await post(
      '/api/auth/sign-in/password',
      { email: who.email, password: 'x' },
      {
        cookie: device,
      },
    );

    const rows = (
      await t.pg.query<{ subject_hash: Uint8Array; failed_attempts: number }>(
        `select subject_hash, failed_attempts from sign_in_failures`,
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.failed_attempts).toBe(1);
    expect(await failuresFor(who.email as string)).toBe(0);
    // Keyed by the device the cookie names — read back with the cookie's own key.
    const opened = await openKnownDevice(
      await deriveKnownDeviceKey(COOKIE_PASSWORD),
      device.slice(device.indexOf('=') + 1),
      new Date(),
    );
    // The cookie carries a tag of the address, never the address.
    expect(opened?.addressTag).toBe(await deviceAddressTag(env as never, who.email as string));
    expect(device).not.toContain(who.email as string);
    const expected = await devicePool(env as never, opened!.deviceId);
    expect(Buffer.from(rows[0]!.subject_hash).equals(Buffer.from(expected))).toBe(true);
  });
});

/* ── login CSRF and the address bucket, on every route ────────────────────── */

describe('every in-app sign-in route', () => {
  const BODIES: Record<RoutePath, unknown> = {
    '/api/auth/sign-in/password': { email: 'someone@example.com', password: PASSWORD },
    '/api/auth/sign-in/code': { email: 'someone@example.com' },
    '/api/auth/sign-in/code/verify': { email: 'someone@example.com', code: '123456' },
    '/api/auth/sign-in/verify-email': { email: 'someone@example.com', code: '123456' },
  };
  /** Each route's own address bucket (finding L5): a sign-in's two steps do not spend one twice. */
  const ADDRESS_KEYS: Record<RoutePath, string> = {
    '/api/auth/sign-in/password': '203.0.113.5:-',
    '/api/auth/sign-in/code': 'sign_in_code_send_ip:203.0.113.5',
    '/api/auth/sign-in/code/verify': '203.0.113.5:-',
    '/api/auth/sign-in/verify-email': 'sign_in_verify_email_ip:203.0.113.5',
  };
  const PATHS = Object.keys(BODIES) as RoutePath[];

  function workosCalled(): boolean {
    return Object.values(workos).some((call) => call.mock.calls.length > 0);
  }

  it.each(
    PATHS.flatMap((path) =>
      (
        [
          ['no Origin (not a browser on our page)', { origin: null }],
          ['another site’s Origin', { origin: 'https://evil.example' }],
          ['a sibling subdomain', { origin: 'https://evil.xecret.playxoft.com' }],
          ['Sec-Fetch-Site: cross-site', { site: 'cross-site' }],
          ['Sec-Fetch-Site: same-site', { site: 'same-site' }],
          ['a form post, not JSON', { contentType: 'application/x-www-form-urlencoded' }],
          ['text/plain, the other simple type', { contentType: 'text/plain' }],
        ] as const
      ).map(([label, options]) => [path, label, options] as const),
    ),
  )(
    '%s refuses %s before anything is spent or asked (login CSRF)',
    async (path, _label, options) => {
      const keys = recordLimits();

      const answer = await post(path, BODIES[path], options);

      expect(answer.status).toBe(403);
      expect(errorOf(answer).code).toBe('csrf_failed');
      expect(answer.cookies).toEqual([]);
      expect(keys).toEqual([]);
      expect(workosCalled()).toBe(false);
    },
  );

  it.each(PATHS)('%s spends its address bucket first, and stops there', async (path) => {
    const keys = recordLimits((key) => key === ADDRESS_KEYS[path]);

    const answer = await post(path, BODIES[path]);

    expect(answer.status).toBe(429);
    expect(keys).toEqual([ADDRESS_KEYS[path]]);
    expect(workosCalled()).toBe(false);
  });

  it('spends the address-and-email bucket for a password before asking WorkOS', async () => {
    const keys = recordLimits((key) => key === '203.0.113.5:someone%40example.com');

    const answer = await post('/api/auth/sign-in/password', BODIES['/api/auth/sign-in/password']);

    expect(answer.status).toBe(429);
    expect(keys).toContain('203.0.113.5:someone%40example.com');
    expect(workos.authenticateWithPassword).not.toHaveBeenCalled();
  });
});

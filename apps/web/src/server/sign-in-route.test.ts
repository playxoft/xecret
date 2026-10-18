import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { WorkOS } from '@workos-inc/node';
import {
  deriveOAuthStateKey,
  deriveSignInConfirmationKey,
  generateToken,
  hashToken,
  OAUTH_STATE_COOKIE_NAME,
  openSignInConfirmation,
  sealOAuthState,
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
import {
  createCliToken,
  createInvitation,
  createSession,
  removeMember,
} from '@xecret/db/repositories';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '@xecret/db/testing';
import type { TestDatabase } from '@xecret/db/testing';
import { createLogger } from './logging';
import type { LogEntry, RequestLog } from './logging';
import type { WorkosApi } from './workos';

/**
 * Signing in through WorkOS, end to end: `GET /api/auth/login`, then
 * `GET /api/auth/callback`, against a real database.
 *
 * ── What is real, and what is stubbed ──
 * Real: both routes and `publicRoute`; the signed state cookie; the WorkOS
 * provider's mapping and `workosIdentity()` minting; the linking pass, session
 * issue, personal-organisation provisioning (with a real envelope service and a
 * throwaway root key), just-in-time membership, the reauth record — all on
 * PGlite with every migration applied. The authorization URL is built by the
 * real SDK.
 *
 * Stubbed: the two WorkOS calls that would leave the process
 * (`authenticateWithCode`, `getOrganization`), the audit sink (captured, so the
 * events can be asserted), and the logger (captured, likewise).
 *
 * Every refusal is asserted the same three ways: where the browser is sent,
 * that no session cookie was issued, and what the database holds afterwards.
 */

const ORIGIN = 'https://xecret.playxoft.com';
const CLIENT_ID = 'client_01TESTCLIENT';
const COOKIE_PASSWORD = 'a-cookie-password-that-is-comfortably-over-32-characters';

const context = vi.hoisted(() => ({ workerContext: vi.fn(), createServiceContext: vi.fn() }));
const auditSink = vi.hoisted(() => ({ write: vi.fn() }));
const logging = vi.hoisted(() => ({ createRequestLog: vi.fn() }));
const workos = vi.hoisted(() => ({
  authenticateWithCode: vi.fn(),
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
      authenticateWithCode: workos.authenticateWithCode,
      createMagicAuth: vi.fn(),
      authenticateWithMagicAuth: vi.fn(),
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

const { GET: login } = await import('@/app/api/auth/login/route');
const { GET: callback } = await import('@/app/api/auth/callback/route');
const confirmRoute = await import('@/app/api/auth/confirm/route');
const sessionRoute = await import('@/app/api/auth/session/route');
const orgRoute = await import('@/app/api/orgs/[orgSlug]/route');
const acceptRoute = await import('@/app/api/invitations/accept/route');
const { confirmationView } = await import('./sign-in-confirmation');

let t: TestDatabase;
let envelope: EnvelopeService;
let lines: LogEntry[] = [];
let audit: AuditRecord[] = [];
let env: Record<string, unknown> = {};

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

beforeEach(() => {
  vi.clearAllMocks();
  // Reset, not just cleared: a test whose callback is refused before the
  // exchange leaves its queued answer unconsumed, and the next test would be
  // handed somebody else's user.
  workos.authenticateWithCode.mockReset();
  t.reset();
  lines = [];
  audit = [];
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
  context.workerContext.mockImplementation(async () => ({
    env,
    ctx: { waitUntil: () => {} },
  }));
  context.createServiceContext.mockImplementation(
    async (
      request: Request,
      _worker: unknown,
      requestId: string,
      log: RequestLog,
      startedAt: number,
    ) => {
      const pending: Promise<unknown>[] = [];
      return {
        env,
        db: t.db,
        envelope,
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
        waitUntil: (promise: Promise<unknown>) => pending.push(promise),
        settled: () => Promise.allSettled(pending),
        dispose: () => {},
      };
    },
  );
  auditSink.write.mockImplementation(async (events: AuditRecord[]) => {
    audit.push(...events);
  });
  workos.getOrganization.mockResolvedValue({ id: 'org_unused', domains: [] });
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

/**
 * An access token as WorkOS shapes one, carrying `auth_time` — when the person
 * last actively authenticated. Only that claim is read; the signature never is.
 */
function accessTokenAuthenticatedAt(authTime: number | null): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const claims = { sub: 'user_01', sid: 'session_01', iat: Math.floor(Date.now() / 1000) };
  return `${part({ alg: 'RS256' })}.${part(authTime === null ? claims : { ...claims, auth_time: authTime })}.c2ln`;
}

/**
 * What WorkOS will answer to the next code exchange. By default, an
 * authentication that happened just now, as a real one does.
 */
function workosAnswers(response: Record<string, unknown>) {
  workos.authenticateWithCode.mockResolvedValueOnce({
    accessToken: accessTokenAuthenticatedAt(Math.floor(Date.now() / 1000)),
    refreshToken: 'workos-refresh-token',
    ...response,
  });
}

interface Started {
  status: number;
  location: URL;
  /** The state cookie's value, as the browser would hold it. */
  cookie: string;
  setCookie: string;
  state: string;
}

/** What a browser sends when the sign-in page's own button is followed. */
const FROM_THIS_SITE = { 'sec-fetch-site': 'same-origin' } as const;

async function startSignIn(query = '', headers: Record<string, string> = {}): Promise<Started> {
  const response = await login(new Request(`${ORIGIN}/api/auth/login${query}`, { headers }));
  const setCookie = response.headers.getSetCookie()[0] ?? '';
  const location = new URL(response.headers.get('location') ?? 'about:blank');
  return {
    status: response.status,
    location,
    setCookie,
    cookie: setCookie.slice(`${OAUTH_STATE_COOKIE_NAME}=`.length, setCookie.indexOf(';')),
    state: location.searchParams.get('state') ?? '',
  };
}

interface Finished {
  status: number;
  location: string;
  cookies: string[];
  error: string | null;
  /** The sealed confirmation cookie, when the callback held the sign-in back. */
  parked: string | null;
}

function finished(response: Response): Finished {
  const location = response.headers.get('location') ?? '';
  const cookies = response.headers.getSetCookie();
  const parkedCookie = cookies.find(
    (c) => c.startsWith(`${SIGN_IN_CONFIRMATION_COOKIE_NAME}=`) && !c.includes('Max-Age=0'),
  );
  return {
    status: response.status,
    location,
    cookies,
    error: location.startsWith('/sign-in?')
      ? new URLSearchParams(location.slice('/sign-in?'.length)).get('error')
      : null,
    parked:
      parkedCookie === undefined
        ? null
        : parkedCookie.slice(
            `${SIGN_IN_CONFIRMATION_COOKIE_NAME}=`.length,
            parkedCookie.indexOf(';'),
          ),
  };
}

async function finishSignIn(
  flow: { cookie: string | null; state: string | null },
  options: { code?: string; extra?: string; sessionToken?: string } = {},
): Promise<Finished> {
  const query = new URLSearchParams();
  if (flow.state !== null) query.set('state', flow.state);
  query.set('code', options.code ?? 'a-code-from-authkit');
  const cookies = [
    ...(flow.cookie === null ? [] : [`${OAUTH_STATE_COOKIE_NAME}=${flow.cookie}`]),
    ...(options.sessionToken === undefined
      ? []
      : [`__Host-xecret_session=${options.sessionToken}`]),
  ];
  const response = await callback(
    new Request(`${ORIGIN}/api/auth/callback?${query.toString()}${options.extra ?? ''}`, {
      headers: cookies.length === 0 ? {} : { cookie: cookies.join('; ') },
    }),
  );
  return finished(response);
}

/** What the parked cookie holds — read the way the confirmation page reads it. */
async function parkedValue(cookie: string) {
  const opened = await openSignInConfirmation(
    await deriveSignInConfirmationKey(COOKIE_PASSWORD),
    cookie,
    new Date(),
  );
  if (!opened.ok) throw new Error(`the parked cookie did not open: ${opened.reason}`);
  return opened.value;
}

/**
 * Answers the confirmation the way the page's form does: a same-origin POST
 * carrying the cookie and its nonce. Every part is overridable, so a test can
 * take away exactly one.
 */
async function confirm(
  parked: string,
  options: {
    decision?: string;
    token?: string | null;
    origin?: string | null;
    site?: string;
    sessionToken?: string;
  } = {},
): Promise<Finished> {
  const token = options.token === undefined ? (await parkedValue(parked)).nonce : options.token;
  const form = new URLSearchParams();
  if (token !== null) form.set('confirmation', token);
  form.set('decision', options.decision ?? 'continue');
  const cookies = [
    `${SIGN_IN_CONFIRMATION_COOKIE_NAME}=${parked}`,
    ...(options.sessionToken === undefined
      ? []
      : [`__Host-xecret_session=${options.sessionToken}`]),
  ];
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    cookie: cookies.join('; '),
    'sec-fetch-site': options.site ?? 'same-origin',
  };
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (origin !== null) headers['origin'] = origin;
  return finished(
    await confirmRoute.POST(
      new Request(`${ORIGIN}/api/auth/confirm`, {
        method: 'POST',
        headers,
        body: form.toString(),
      }),
    ),
  );
}

/**
 * Starts and finishes a sign-in as `user`, the way a browser would — answering
 * the confirmation too, when the callback holds the sign-in back, unless told
 * not to (`confirm: false`).
 */
async function signIn(
  user: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  options: {
    query?: string;
    headers?: Record<string, string>;
    sessionToken?: string;
    confirm?: boolean;
  } = {},
): Promise<Finished> {
  const flow = await startSignIn(options.query ?? '', options.headers ?? {});
  workosAnswers({ user, ...extra });
  const result = await finishSignIn(
    flow,
    options.sessionToken === undefined ? {} : { sessionToken: options.sessionToken },
  );
  if (result.parked === null || options.confirm === false) return result;
  return confirm(
    result.parked,
    options.sessionToken === undefined ? {} : { sessionToken: options.sessionToken },
  );
}

function sessionCookieIssued(result: Finished): boolean {
  return result.cookies.some(
    (c) => c.startsWith('__Host-xecret_session=') && !c.includes('Max-Age=0'),
  );
}

/** A `Set-Cookie` value's value, by cookie name. */
function cookieValue(result: Finished, name: string): string {
  const header = result.cookies.find((c) => c.startsWith(`${name}=`) && !c.includes('Max-Age=0'));
  if (header === undefined) throw new Error(`no ${name} cookie was issued`);
  return header.slice(name.length + 1, header.indexOf(';'));
}

/** The session token a sign-in issued. */
function sessionTokenOf(result: Finished): string {
  return cookieValue(result, '__Host-xecret_session');
}

/**
 * Asks `GET /api/orgs/{slug}` with a credential — the real `authenticate` and
 * `resolveOrg`, so what this answers is what every organisation route answers.
 * A session is unlocked first: the vault lock is a different gate, in front.
 */
async function reachOrg(
  slug: string,
  credential: { session?: string; bearer?: string },
): Promise<{ status: number; code: unknown }> {
  let headers: Record<string, string>;
  if (credential.session !== undefined) {
    await t.pg.query(
      `update sessions set vault_unlocked_at = now(), last_seen_at = now() where token_hash = $1`,
      [await hashToken(credential.session)],
    );
    headers = { cookie: `__Host-xecret_session=${credential.session}`, origin: ORIGIN };
  } else {
    headers = { authorization: `Bearer ${credential.bearer ?? ''}` };
  }
  const response = await orgRoute.GET(new Request(`${ORIGIN}/api/orgs/${slug}`, { headers }), {
    params: Promise.resolve({ orgSlug: slug }),
  });
  const body = (await response.json()) as { error?: { code?: unknown } };
  return { status: response.status, code: body.error?.code };
}

/** Accepts an invitation with the session a sign-in issued, CSRF pair and all. */
async function acceptWith(
  signedIn: Finished,
  invitation: string,
): Promise<{ status: number; code: unknown }> {
  const session = sessionTokenOf(signedIn);
  const csrf = cookieValue(signedIn, '__Host-xecret_csrf');
  await t.pg.query(
    `update sessions set vault_unlocked_at = now(), last_seen_at = now() where token_hash = $1`,
    [await hashToken(session)],
  );
  const response = await acceptRoute.POST(
    new Request(`${ORIGIN}/api/invitations/accept`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        cookie: `__Host-xecret_session=${session}; __Host-xecret_csrf=${csrf}`,
        'x-xecret-csrf': csrf,
      },
      body: JSON.stringify({ token: invitation }),
    }),
  );
  const body = (await response.json()) as { error?: { code?: unknown } };
  return { status: response.status, code: body.error?.code };
}

interface UserRow {
  id: string;
  workos_user_id: string | null;
  firebase_uid: string | null;
  email: string;
  deleted_at: Date | null;
  last_login_at: Date | null;
}

async function userRows(column: 'email' | 'workos_user_id' | 'id', value: string) {
  return (
    await t.pg.query<UserRow>(
      `select id, workos_user_id, firebase_uid, email::text as email, deleted_at, last_login_at
         from users where ${column} = $1`,
      [value],
    )
  ).rows;
}

async function sessionsFor(userId: string) {
  return (
    await t.pg.query<{ id: string; revoked_at: Date | null }>(
      `select id, revoked_at from sessions where user_id = $1 order by created_at`,
      [userId],
    )
  ).rows;
}

async function membershipsOf(userId: string) {
  return (
    await t.pg.query<{ org_id: string; role: string; status: string }>(
      `select org_id, role, status from org_members where user_id = $1`,
      [userId],
    )
  ).rows;
}

async function seedUser(
  over: { workosUserId?: string | null; email?: string; deleted?: boolean } = {},
) {
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

async function seedOrg(
  over: {
    workosOrgId?: string;
    clientId?: string;
    ssoRequired?: boolean;
    jitJoinEnabled?: boolean;
    seatLimit?: number;
  } = {},
): Promise<string> {
  const founder = await seedUser();
  const id = randomUUID();
  await t.pg.query(
    `insert into organizations
       (id, name, slug, created_by, workos_org_id, workos_client_id, sso_required,
        jit_join_enabled, seat_limit)
     values ($1, 'BigCorp', $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      `bigcorp-${id.slice(0, 8)}`,
      founder.id,
      over.workosOrgId ?? null,
      over.workosOrgId === undefined ? null : (over.clientId ?? CLIENT_ID),
      over.ssoRequired ?? false,
      over.jitJoinEnabled ?? false,
      over.seatLimit ?? 5,
    ],
  );
  await addMember(id, founder.id, 'owner');
  return id;
}

async function slugOf(orgId: string): Promise<string> {
  const result = await t.pg.query<{ slug: string }>(
    `select slug::text from organizations where id = $1`,
    [orgId],
  );
  return result.rows[0]!.slug;
}

async function addMember(orgId: string, userId: string, role = 'developer', status = 'active') {
  await t.pg.query(
    `insert into org_members (id, org_id, user_id, role, status) values ($1, $2, $3, $4, $5)`,
    [randomUUID(), orgId, userId, role, status],
  );
}

function organizationAt(workosOrgId: string, domains: Array<[string, string]>) {
  workos.getOrganization.mockResolvedValue({
    id: workosOrgId,
    domains: domains.map(([domain, state]) => ({ domain, state })),
  });
}

function warned(fragment: string): boolean {
  return lines.some((line) => line.level === 'warn' && line.message.includes(fragment));
}

/* ── GET /api/auth/login ──────────────────────────────────────────────────── */

describe('starting a sign-in', () => {
  it('sends the browser to AuthKit with this client, the derived redirect, a state and PKCE', async () => {
    const flow = await startSignIn('?next=%2Fapp%2Facme');

    expect(flow.status).toBe(307);
    expect(flow.location.origin).toBe('https://api.workos.com');
    expect(flow.location.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(flow.location.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback`);
    expect(flow.location.searchParams.get('provider')).toBe('authkit');
    expect(flow.location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(flow.location.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(flow.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(flow.location.searchParams.has('max_age')).toBe(false);
  });

  it('binds the flow to this browser with a __Host-, HttpOnly, Lax, ten-minute cookie', async () => {
    const flow = await startSignIn();

    expect(flow.setCookie.startsWith(`${OAUTH_STATE_COOKIE_NAME}=v1.`)).toBe(true);
    expect(flow.setCookie).toContain('HttpOnly');
    expect(flow.setCookie).toContain('Secure');
    expect(flow.setCookie).toContain('SameSite=Lax');
    expect(flow.setCookie).toContain('Path=/');
    expect(flow.setCookie).toContain('Max-Age=600');
    // The challenge is sent; the verifier never is.
    expect(flow.location.toString()).not.toContain(flow.cookie);
  });

  it('asks AuthKit to demand the credential again for a re-authentication', async () => {
    const flow = await startSignIn('?reauth=1');

    expect(flow.location.searchParams.get('max_age')).toBe('0');
    expect(flow.location.searchParams.has('screen_hint')).toBe(false);
  });

  it('opens AuthKit on its sign-up screen when asked', async () => {
    const flow = await startSignIn('?hint=sign-up');

    expect(flow.location.searchParams.get('screen_hint')).toBe('sign-up');
  });

  it('deep-links an organisation’s SSO by slug, and falls through for one without', async () => {
    const workosOrgId = unique('org_01');
    const orgId = await seedOrg({ workosOrgId });
    const slug = await slugOf(orgId);

    const deep = await startSignIn(`?org=${slug}`, FROM_THIS_SITE);
    expect(deep.location.searchParams.get('organization_id')).toBe(workosOrgId);
    expect(deep.location.searchParams.has('provider')).toBe(false);

    const plain = await startSignIn('?org=no-such-org', FROM_THIS_SITE);
    expect(plain.location.searchParams.has('organization_id')).toBe(false);
    expect(plain.location.searchParams.get('provider')).toBe('authkit');
  });

  it.each([
    ['a link on another site', { 'sec-fetch-site': 'cross-site' }],
    ['a sibling subdomain', { 'sec-fetch-site': 'same-site' }],
    ['an email, a bookmark or a typed address', { 'sec-fetch-site': 'none' }],
    ['a browser that says nothing', {}],
    ['a browser whose only clue is another site’s referrer', { referer: 'https://evil.example/x' }],
  ] as Array<[string, Record<string, string>]>)(
    'sends an SSO deep link from %s to the sign-in page to be confirmed, minting nothing (login CSRF)',
    async (_label, headers) => {
      // PR #114's constraint for WS-5: an organisation an attacker linked to an
      // identity provider of their own must not be able to sign a victim in to
      // the attacker's account through a link the victim merely followed.
      const workosOrgId = unique('org_01');
      const slug = await slugOf(await seedOrg({ workosOrgId }));
      const keys: string[] = [];
      env['RL_LOGIN'] = {
        limit: async ({ key }: { key: string }) => {
          keys.push(key);
          return { success: true };
        },
      };

      const response = await login(
        new Request(`${ORIGIN}/api/auth/login?org=${slug}&next=%2Fapp%2Facme`, { headers }),
      );

      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe(`/sign-in?org=${slug}&next=%2Fapp%2Facme`);
      // No state cookie, no flow, and not even the slug lookup's rate-limit token.
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(keys).toEqual([]);
    },
  );

  it('honours the deep link from a browser that sends only a same-origin referrer', async () => {
    const workosOrgId = unique('org_01');
    const slug = await slugOf(await seedOrg({ workosOrgId }));

    const deep = await startSignIn(`?org=${slug}`, { referer: `${ORIGIN}/sign-in?org=${slug}` });

    expect(deep.status).toBe(307);
    expect(deep.location.searchParams.get('organization_id')).toBe(workosOrgId);
  });

  it('ignores a malformed org= rather than sending it anywhere', async () => {
    const flow = await startSignIn('?org=%3Cscript%3E');

    expect(flow.status).toBe(307);
    expect(flow.location.searchParams.has('organization_id')).toBe(false);
  });

  it('sends the browser to the sign-in page’s "unavailable" error rather than signing state with a weak or missing key', async () => {
    for (const misconfigure of [
      () => (env['WORKOS_COOKIE_PASSWORD'] = 'too-short'),
      () => delete env['WORKOS_COOKIE_PASSWORD'],
    ]) {
      env['WORKOS_COOKIE_PASSWORD'] = COOKIE_PASSWORD;
      env['WORKOS_API_KEY'] = 'sk_test_not_a_real_key';
      misconfigure();

      const response = await login(new Request(`${ORIGIN}/api/auth/login?next=%2Fapp%2Facme`));

      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe(
        '/sign-in?error=unavailable&next=%2Fapp%2Facme',
      );
      expect(response.headers.getSetCookie()).toEqual([]);
    }
  });

  it('ignores org= on a re-authentication, from wherever it came', async () => {
    const workosOrgId = unique('org_01');
    const slug = await slugOf(await seedOrg({ workosOrgId }));

    for (const headers of [FROM_THIS_SITE, { 'sec-fetch-site': 'cross-site' }]) {
      const flow = await startSignIn(`?reauth=1&org=${slug}`, headers);

      expect(flow.status).toBe(307);
      expect(flow.location.searchParams.has('organization_id')).toBe(false);
      expect(flow.location.searchParams.get('provider')).toBe('authkit');
    }
  });

  it('stops resolving org= for an address that has looked up too many, silently', async () => {
    const workosOrgId = unique('org_01');
    const slug = await slugOf(await seedOrg({ workosOrgId }));
    const keys: string[] = [];
    env['RL_LOGIN'] = {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: !key.startsWith('login_org') };
      },
    };

    const flow = await startSignIn(`?org=${slug}`, FROM_THIS_SITE);

    expect(flow.status).toBe(307);
    expect(flow.location.searchParams.has('organization_id')).toBe(false);
    expect(keys.some((k) => k.startsWith('login_org'))).toBe(true);
  });
});

/* ── where a sign-in lands ────────────────────────────────────────────────── */

describe('next', () => {
  it('lands on the validated next', async () => {
    const result = await signIn(workosUser(), {}, { query: '?next=%2Fapp%2Facme%2Fapi' });

    expect(result.status).toBe(303);
    expect(result.location).toBe('/app/acme/api');
  });

  it.each([
    ['an absolute URL', 'https://evil.example/'],
    ['a protocol-relative URL', '//evil.example'],
    ['a backslash trick', '/\\evil.example'],
    ['a tab trick', '/\t/evil.example'],
    // Round 1: these normalise to `//evil.example` under dot-segment removal.
    ['a dot segment before a double slash', '/.//evil.example/phish'],
    ['a parent segment before a double slash', '/..//evil.example'],
    ['an encoded dot segment', '/%2e//evil.example'],
    ['a climb out of a real segment', '/app/..//evil.example'],
  ])('lands on /app, after a real sign-in, instead of %s', async (_label, next) => {
    const result = await signIn(workosUser(), {}, { query: `?next=${encodeURIComponent(next)}` });

    expect(result.status).toBe(303);
    expect(sessionCookieIssued(result)).toBe(true);
    expect(result.location).toBe('/app');
    expect(new URL(result.location, `${ORIGIN}/api/auth/callback`).origin).toBe(ORIGIN);
  });

  it('re-checks next from the cookie before redirecting, even one a key holder sealed', async () => {
    // The state cookie refuses `//…` when it is parsed, so a forged `//` never
    // gets this far. This pins the second check: a value the parser accepts
    // but the redirect rule does not is still not followed.
    const key = await deriveOAuthStateKey(COOKIE_PASSWORD);
    const state = 'S'.repeat(43);
    const cookie = await sealOAuthState(key, {
      state,
      verifier: 'V'.repeat(43),
      next: '/a/..//evil.example',
      purpose: 'sign-in',
      issuedAt: Math.floor(Date.now() / 1000),
      organizationId: null,
    });
    workosAnswers({ user: workosUser() });

    const result = await finishSignIn({ cookie, state });

    expect(result.location).toBe('/app');
  });

  it('brings `xecret login` back to its consent screen with every parameter intact', async () => {
    // The CLI's browser hand-off: `/cli/authorize` answers 401 for a browser
    // with no session, `lib/api.ts` bounces it to `/sign-in?next=…`, and the
    // sign-in page hands `next` to the login route. It has to come back out of
    // the callback exactly as it went in, or the consent screen refuses the
    // request and the CLI waits forever on its loopback port.
    const next =
      '/cli/authorize?challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&port=50123' +
      '&device=Pat%E2%80%99s%20MacBook%20Pro&state=Zm9vYmFy&handoff=hT0TJxGaBpj2h4hhGkh2yQ6P5HIHJ8E4Lt1oNjb1eW4';

    const result = await signIn(workosUser(), {}, { query: `?next=${encodeURIComponent(next)}` });

    expect(result.status).toBe(303);
    expect(result.location).toBe(next);
    expect(sessionCookieIssued(result)).toBe(true);
  });
});

/* ── the state cookie ─────────────────────────────────────────────────────── */

describe('the request log', () => {
  it('describes the callback neutrally and binds the real outcome — a refusal is never a sign-in', async () => {
    const refused = await finishSignIn({ cookie: null, state: 'x' });
    expect(refused.error).toBe('expired');
    const refusedLine = lines.findLast((l) => l.fn === 'request');
    expect(refusedLine?.message).toBe('Completed a sign-in callback from the identity provider');
    expect(refusedLine?.signInOutcome).toBe('refused');
    expect(refusedLine?.signInRefusal).toBe('expired');

    lines = [];
    await signIn(workosUser());
    const okLine = lines.findLast((l) => l.fn === 'request');
    expect(okLine?.signInOutcome).toBe('created');
    expect(okLine?.signInRefusal).toBeUndefined();
  });

  it('says a malformed code was refused before WorkOS was asked, not that WorkOS refused it', async () => {
    const flow = await startSignIn();

    const result = await finishSignIn(flow, { code: 'not a code!' });

    expect(result.error).toBe('expired');
    expect(workos.authenticateWithCode).not.toHaveBeenCalled();
    const line = lines.find((l) => l.reason === 'malformed-code');
    expect(line?.message).toMatch(/^Refused a sign-in before asking WorkOS/);
    expect(line?.message).not.toMatch(/would not exchange/);
  });

  it('says WorkOS would not exchange a code it refused', async () => {
    const flow = await startSignIn();
    workos.authenticateWithCode.mockRejectedValueOnce(
      Object.assign(new Error('invalid grant'), { status: 400, error: 'invalid_grant' }),
    );

    await finishSignIn(flow);

    const line = lines.find((l) => l.reason === 'invalid_grant');
    expect(line?.message).toMatch(/WorkOS would not exchange its code \(invalid_grant\)/);
  });
});

describe('the state check', () => {
  it('refuses a callback with no state cookie — a flow this browser never started', async () => {
    const flow = await startSignIn();
    workosAnswers({ user: workosUser() });

    const result = await finishSignIn({ cookie: null, state: flow.state });

    expect(result.error).toBe('expired');
    expect(sessionCookieIssued(result)).toBe(false);
    expect(workos.authenticateWithCode).not.toHaveBeenCalled();
  });

  it('refuses a real cookie presented with somebody else’s state (login CSRF)', async () => {
    const victim = await startSignIn();
    const attacker = await startSignIn();

    const result = await finishSignIn({ cookie: victim.cookie, state: attacker.state });

    expect(result.error).toBe('expired');
    expect(workos.authenticateWithCode).not.toHaveBeenCalled();
  });

  it('refuses a cookie whose payload was altered, before the code is looked at', async () => {
    const flow = await startSignIn('?next=%2Fapp');
    const [version, payload = '', mac] = flow.cookie.split('.');
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    decoded['p'] = 'reauth';
    const forged = `${version}.${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${mac}`;

    const result = await finishSignIn({ cookie: forged, state: flow.state });

    expect(result.error).toBe('expired');
    expect(workos.authenticateWithCode).not.toHaveBeenCalled();
    expect(warned('state signature')).toBe(true);
  });

  it('refuses a cookie past its ten minutes', async () => {
    const key = await deriveOAuthStateKey(COOKIE_PASSWORD);
    const state = 'S'.repeat(43);
    const cookie = await sealOAuthState(key, {
      state,
      verifier: 'V'.repeat(43),
      next: '/app',
      purpose: 'sign-in',
      issuedAt: Math.floor(Date.now() / 1000) - 11 * 60,
      organizationId: null,
    });

    const result = await finishSignIn({ cookie, state });

    expect(result.error).toBe('expired');
    expect(warned('state expired')).toBe(true);
    expect(workos.authenticateWithCode).not.toHaveBeenCalled();
  });

  it('refuses a repeated state or code rather than choosing one', async () => {
    const flow = await startSignIn();

    const twoStates = await finishSignIn(flow, { extra: `&state=${flow.state}` });
    expect(twoStates.error).toBe('expired');

    const twoCodes = await finishSignIn(flow, { extra: '&code=another' });
    expect(twoCodes.error).toBe('expired');
    expect(workos.authenticateWithCode).not.toHaveBeenCalled();
  });

  it('clears the state cookie on every answer, so a state is spent once per browser', async () => {
    const ok = await signIn(workosUser());
    const refused = await finishSignIn({ cookie: null, state: 'x' });

    for (const result of [ok, refused]) {
      expect(result.cookies).toContainEqual(
        expect.stringMatching(/^__Host-xecret_oauth_state=;.*Max-Age=0/),
      );
    }
  });

  it('cannot replay a flow: the code was spent at WorkOS, and the second exchange is refused', async () => {
    const flow = await startSignIn();
    workosAnswers({ user: workosUser() });
    const first = await finishSignIn(flow);
    expect(first.status).toBe(303);
    expect(first.error).toBeNull();

    // The same cookie and state, replayed — what somebody holding a copy of
    // this browser's cookie jar could try. WorkOS codes are single-use.
    workos.authenticateWithCode.mockRejectedValueOnce(
      Object.assign(new Error('invalid_grant'), { status: 400, error: 'invalid_grant' }),
    );
    const replay = await finishSignIn(flow);

    expect(replay.error).toBe('expired');
    expect(sessionCookieIssued(replay)).toBe(false);
  });

  it('passes PKCE through: the exchange carries the verifier the cookie holds', async () => {
    const flow = await startSignIn();
    workosAnswers({ user: workosUser() });

    await finishSignIn(flow);

    const [call] = workos.authenticateWithCode.mock.calls[0] as [
      { codeVerifier: string; clientId: string },
    ];
    expect(call.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(call.clientId).toBe(CLIENT_ID);
    // And the challenge AuthKit was sent is that verifier's S256.
    const digest = Buffer.from(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(call.codeVerifier)),
    ).toString('base64url');
    expect(flow.location.searchParams.get('code_challenge')).toBe(digest);
  });
});

/* ── what WorkOS said ─────────────────────────────────────────────────────── */

describe('the provider’s answer', () => {
  it.each([
    ['access_denied', 'cancelled'],
    ['organization_invalid', 'failed'],
  ])('maps a provider error=%s to %s, without exchanging anything', async (providerError, code) => {
    const flow = await startSignIn();

    const result = await finishSignIn(flow, { extra: `&error=${providerError}` });

    expect(result.error).toBe(code);
    expect(workos.authenticateWithCode).not.toHaveBeenCalled();
  });

  it.each([
    ['a refused code', { status: 400, error: 'invalid_grant' }, 'expired'],
    ['a refused API key', { status: 401 }, 'unavailable'],
    ['WorkOS down', { status: 503 }, 'unavailable'],
    ['WorkOS rate-limiting us', { status: 429 }, 'rate-limited'],
  ])('reports %s as %s', async (_label, fields, code) => {
    const flow = await startSignIn();
    workos.authenticateWithCode.mockRejectedValueOnce(Object.assign(new Error('no'), fields));

    const result = await finishSignIn(flow);

    expect(result.error).toBe(code);
    expect(sessionCookieIssued(result)).toBe(false);
  });

  it('refuses an impersonated sign-in outright, writing nothing', async () => {
    const who = workosUser();

    const result = await signIn(who, {
      impersonator: { email: 'support@workos.example', reason: 'debugging' },
    });

    expect(result.error).toBe('impersonation');
    expect(sessionCookieIssued(result)).toBe(false);
    expect(await userRows('email', who.email as string)).toHaveLength(0);
  });

  it('refuses an unverified address with 403, before any account is written', async () => {
    const who = workosUser({ emailVerified: false });

    const result = await signIn(who);

    expect(result.error).toBe('verify-email');
    expect(lines.find((l) => l.message.includes('email not verified'))?.status).toBe(403);
    expect(await userRows('email', who.email as string)).toHaveLength(0);
  });

  it('never adopts an existing account for an unverified address', async () => {
    const existing = await seedUser();

    const result = await signIn(workosUser({ email: existing.email, emailVerified: false }));

    expect(result.error).toBe('verify-email');
    expect((await userRows('id', existing.id))[0]?.workos_user_id).toBeNull();
  });
});

/* ── the linker's outcomes ────────────────────────────────────────────────── */

describe('the linking pass, as the callback reports it', () => {
  it('creates a new account, its personal organisation and a session: auth.signup', async () => {
    const who = workosUser();

    const result = await signIn(who, { authenticationMethod: 'Password' });

    expect(result.status).toBe(303);
    expect(sessionCookieIssued(result)).toBe(true);
    expect(result.cookies).toContainEqual(expect.stringMatching(/^__Host-xecret_csrf=/));
    const [row] = await userRows('workos_user_id', who.id as string);
    expect(row?.firebase_uid).toBeNull();
    expect(await membershipsOf(row!.id)).toEqual([expect.objectContaining({ role: 'owner' })]);
    expect(await sessionsFor(row!.id)).toHaveLength(1);
    expect(audit.map((e) => e.action)).toEqual(
      expect.arrayContaining(['org.created', 'auth.signup']),
    );
    expect(audit.find((e) => e.action === 'auth.signup')?.metadata.signInMethod).toBe('password');
  });

  it('signs a returning WorkOS user in to the same account: auth.login', async () => {
    const who = workosUser();
    await signIn(who);
    audit = [];

    const again = await signIn(who, { authenticationMethod: 'GoogleOAuth' });

    expect(again.status).toBe(303);
    expect(await userRows('workos_user_id', who.id as string)).toHaveLength(1);
    expect(audit.find((e) => e.action === 'auth.login')?.metadata.signInMethod).toBe('oauth');
  });

  it('adopts a Firebase-era account by its verified address: auth.identity_linked', async () => {
    const existing = await seedUser();
    const org = await seedOrg();
    await addMember(org, existing.id);
    const who = workosUser({ email: existing.email });

    const result = await signIn(who);

    expect(result.status).toBe(303);
    const [row] = await userRows('id', existing.id);
    expect(row?.workos_user_id).toBe(who.id);
    expect(row?.firebase_uid).not.toBeNull();
    expect(audit.map((e) => e.action)).toContain('auth.identity_linked');
    // An existing member is not given a personal organisation on top.
    expect(await membershipsOf(existing.id)).toHaveLength(1);
  });

  it('refuses a deleted account as deleted (403), and issues nothing', async () => {
    const who = workosUser();
    await seedUser({ workosUserId: who.id as string, email: who.email as string, deleted: true });

    const result = await signIn(who);

    expect(result.error).toBe('account-deleted');
    expect(lines.find((l) => l.message.includes('account deleted'))?.status).toBe(403);
    expect(sessionCookieIssued(result)).toBe(false);
  });

  it('refuses an address bound to a different identity as a 409 that names nobody', async () => {
    const holder = await seedUser({ workosUserId: unique('user_01HOLDER') });
    const intruder = workosUser({ email: holder.email });

    const result = await signIn(intruder);

    expect(result.error).toBe('account-conflict');
    expect(lines.find((l) => l.message.includes('linker:'))?.status).toBe(409);
    // The browser learns a code and nothing else: no id, no address.
    expect(result.location).not.toContain(holder.id);
    expect(result.location).not.toContain(encodeURIComponent(holder.email));
    expect(sessionCookieIssued(result)).toBe(false);
    expect(await userRows('workos_user_id', intruder.id as string)).toHaveLength(0);
  });
});

/* ── SSO: verified domains, sso_required, JIT ─────────────────────────────── */

describe('an SSO sign-in is believed only for its organisation’s verified domains', () => {
  it('accepts an address in a verified domain', async () => {
    const workosOrgId = unique('org_01');
    organizationAt(workosOrgId, [['bigcorp.example', 'verified']]);

    const result = await signIn(workosUser({ email: `${unique('alice')}@BigCorp.example` }), {
      authenticationMethod: 'SSO',
      organizationId: workosOrgId,
    });

    expect(result.error).toBeNull();
    expect(workos.getOrganization).toHaveBeenCalledWith(workosOrgId);
  });

  it.each([
    ['a domain the organisation never claimed', [['bigcorp.example', 'verified']]],
    ['a domain still pending verification', [['othercorp.example', 'pending']]],
    ['a domain whose verification failed', [['othercorp.example', 'failed']]],
    ['a parent of a verified domain', [['eng.othercorp.example', 'verified']]],
  ] as Array<[string, Array<[string, string]>]>)(
    'refuses %s, before the linker runs',
    async (_label, domains) => {
      const workosOrgId = unique('org_01');
      organizationAt(workosOrgId, domains);
      // Somebody else's existing account at the asserted address. A customer's
      // identity provider can assert any address it likes; this one must not be
      // adopted, and must not even be touched.
      const victim = await seedUser({ email: `${unique('victim')}@othercorp.example` });
      const before = (await userRows('id', victim.id))[0];

      const result = await signIn(workosUser({ email: victim.email }), {
        authenticationMethod: 'SSO',
        organizationId: workosOrgId,
      });

      expect(result.error).toBe('sso-domain');
      expect(sessionCookieIssued(result)).toBe(false);
      expect((await userRows('id', victim.id))[0]).toEqual(before);
    },
  );

  it('refuses it for an already-linked identity too — not only for adoption', async () => {
    const workosOrgId = unique('org_01');
    const who = workosUser({ email: `${unique('pat')}@othercorp.example` });
    await signIn(who, { authenticationMethod: 'Password' });
    organizationAt(workosOrgId, [['bigcorp.example', 'verified']]);

    const result = await signIn(who, { authenticationMethod: 'SSO', organizationId: workosOrgId });

    expect(result.error).toBe('sso-domain');
  });

  it('refuses an SSO sign-in that names no organisation', async () => {
    const result = await signIn(workosUser(), { authenticationMethod: 'SSO' });

    expect(result.error).toBe('sso-domain');
    expect(workos.getOrganization).not.toHaveBeenCalled();
  });

  it('does not consult the domains for a sign-in that was not SSO', async () => {
    const result = await signIn(workosUser(), {
      authenticationMethod: 'Password',
      organizationId: unique('org_01'),
    });

    expect(result.error).toBeNull();
    expect(workos.getOrganization).not.toHaveBeenCalled();
  });
});

describe('sso_required', () => {
  async function memberOfSsoOrg() {
    const workosOrgId = unique('org_01');
    const orgId = await seedOrg({ workosOrgId, ssoRequired: true });
    const who = workosUser({ email: `${unique('pat')}@bigcorp.example` });
    const row = await seedUser({ workosUserId: who.id as string, email: who.email as string });
    await addMember(orgId, row.id);
    organizationAt(workosOrgId, [['bigcorp.example', 'verified']]);
    return { workosOrgId, orgId, who, userId: row.id };
  }

  it('audits an adoption even when the sign-in that made it is then refused', async () => {
    // Round 1: a Firebase-era member of an SSO-required organisation signs in
    // with a password. The linker adopts the row (WorkOS id written), then
    // sso_required refuses the sign-in — and the link used to go unrecorded.
    const workosOrgId = unique('org_01');
    const orgId = await seedOrg({ workosOrgId, ssoRequired: true });
    const existing = await seedUser({ email: `${unique('fb')}@bigcorp.example` });
    await addMember(orgId, existing.id);
    const who = workosUser({ email: existing.email });

    const result = await signIn(who, { authenticationMethod: 'Password' });

    expect(result.error).toBe('sso-required');
    expect((await userRows('id', existing.id))[0]?.workos_user_id).toBe(who.id);
    const linked = audit.find((e) => e.action === 'auth.identity_linked');
    expect(linked?.orgId).toBe(orgId);
    expect(linked?.resourceId).toBe(existing.id);
    expect(audit.map((e) => e.action)).not.toContain('auth.login');
  });

  it('refuses a password sign-in for a member', async () => {
    const { who, userId } = await memberOfSsoOrg();

    const result = await signIn(who, { authenticationMethod: 'Password' });

    expect(result.error).toBe('sso-required');
    expect(await sessionsFor(userId)).toHaveLength(0);
  });

  it('refuses an OAuth sign-in even when AuthKit names the organisation (organisation selection is not SSO)', async () => {
    const { who, workosOrgId, userId } = await memberOfSsoOrg();

    const result = await signIn(who, {
      authenticationMethod: 'GoogleOAuth',
      organizationId: workosOrgId,
    });

    expect(result.error).toBe('sso-required');
    expect(await sessionsFor(userId)).toHaveLength(0);
  });

  it('refuses SSO through a different organisation’s connection', async () => {
    const { who } = await memberOfSsoOrg();
    const elsewhere = unique('org_01');
    organizationAt(elsewhere, [['bigcorp.example', 'verified']]);

    const result = await signIn(who, { authenticationMethod: 'SSO', organizationId: elsewhere });

    expect(result.error).toBe('sso-required');
  });

  it('admits SSO through the organisation’s own connection', async () => {
    const { who, workosOrgId, userId } = await memberOfSsoOrg();

    const result = await signIn(who, { authenticationMethod: 'SSO', organizationId: workosOrgId });

    expect(result.error).toBeNull();
    expect(await sessionsFor(userId)).toHaveLength(1);
  });

  it('leaves members of organisations that do not require it alone', async () => {
    const orgId = await seedOrg({ workosOrgId: unique('org_01'), ssoRequired: false });
    const who = workosUser();
    const row = await seedUser({ workosUserId: who.id as string, email: who.email as string });
    await addMember(orgId, row.id);

    expect((await signIn(who, { authenticationMethod: 'Password' })).error).toBeNull();
  });

  it('exempts an owner, so a broken identity provider cannot lock the organisation out', async () => {
    // The break-glass migration 0018 promised: with the IdP misconfigured,
    // somebody must still be able to sign in and switch the requirement off.
    const workosOrgId = unique('org_01');
    const orgId = await seedOrg({ workosOrgId, ssoRequired: true });
    const who = workosUser();
    const row = await seedUser({ workosUserId: who.id as string, email: who.email as string });
    await addMember(orgId, row.id, 'owner');

    const result = await signIn(who, { authenticationMethod: 'Password' });

    expect(result.error).toBeNull();
    expect(sessionCookieIssued(result)).toBe(true);
    expect(await sessionsFor(row.id)).toHaveLength(1);
    // Findable afterwards: the sign-in is audited with its method, and logged —
    // and the exemption itself is filed in the organisation it bypassed.
    const login = audit.find((e) => e.action === 'auth.login');
    expect(login?.metadata.signInMethod).toBe('password');
    expect(
      lines.some((line) => line.level === 'info' && line.message.includes('owners are exempt')),
    ).toBe(true);
    expect(audit.filter((e) => e.action === 'auth.sso_exemption_used')).toEqual([
      expect.objectContaining({
        orgId,
        actorId: row.id,
        outcome: 'success',
        resourceType: 'session',
        metadata: expect.objectContaining({ signInMethod: 'password' }),
      }),
    ]);
  });

  it('files the owner exemption in every organisation it was used in, and only those (review C3)', async () => {
    // `auth.login` lands in one organisation; each organisation whose identity
    // provider the owner bypassed gets its own record.
    const first = await seedOrg({ workosOrgId: unique('org_01'), ssoRequired: true });
    const second = await seedOrg({ workosOrgId: unique('org_01'), ssoRequired: true });
    const relaxed = await seedOrg({ workosOrgId: unique('org_01'), ssoRequired: false });
    const satisfied = unique('org_01');
    const viaSso = await seedOrg({ workosOrgId: satisfied, ssoRequired: true });
    const who = workosUser({ email: `${unique('owner')}@bigcorp.example` });
    const row = await seedUser({ workosUserId: who.id as string, email: who.email as string });
    for (const orgId of [first, second, relaxed, viaSso]) await addMember(orgId, row.id, 'owner');
    organizationAt(satisfied, [['bigcorp.example', 'verified']]);

    await signIn(who, { authenticationMethod: 'SSO', organizationId: satisfied });

    const exempted = audit.filter((e) => e.action === 'auth.sso_exemption_used');
    expect(exempted.map((e) => e.orgId).sort()).toEqual([first, second].sort());
    expect(exempted.every((e) => e.metadata.signInMethod === 'sso')).toBe(true);
    expect(audit.filter((e) => e.action === 'auth.login')).toHaveLength(1);
  });

  it('does not exempt an admin — only owners', async () => {
    const workosOrgId = unique('org_01');
    const orgId = await seedOrg({ workosOrgId, ssoRequired: true });
    const who = workosUser();
    const row = await seedUser({ workosUserId: who.id as string, email: who.email as string });
    await addMember(orgId, row.id, 'admin');

    const result = await signIn(who, { authenticationMethod: 'GoogleOAuth' });

    expect(result.error).toBe('sso-required');
    expect(await sessionsFor(row.id)).toHaveLength(0);
  });

  it('signs in somebody with another organisation to use, and holds the session to the requirement there (review S6)', async () => {
    // One organisation's requirement used to refuse the whole sign-in, locking
    // a contractor out of every other organisation they belong to. Now the
    // sign-in goes ahead and the requiring organisation refuses this session
    // on each request, while the exemption stays per organisation: owning your
    // own does not excuse you from the company one you are a developer in.
    const theirs = await seedOrg({ workosOrgId: unique('org_01'), ssoRequired: true });
    const own = await seedOrg({ workosOrgId: unique('org_01'), ssoRequired: true });
    const who = workosUser();
    const row = await seedUser({ workosUserId: who.id as string, email: who.email as string });
    await addMember(own, row.id, 'owner');
    await addMember(theirs, row.id, 'developer');

    const result = await signIn(who, { authenticationMethod: 'Password' });

    expect(result.error).toBeNull();
    const session = sessionTokenOf(result);
    expect(await reachOrg(await slugOf(theirs), { session })).toEqual({
      status: 403,
      code: 'sso_required',
    });
    expect((await reachOrg(await slugOf(own), { session })).status).toBe(200);
  });
});

/* ── sso_required, on every request (review S3) ───────────────────────────── */

describe('sso_required on every request', () => {
  async function companyWithMember(role = 'developer') {
    const workosOrgId = unique('org_01');
    const orgId = await seedOrg({ workosOrgId });
    const personal = await seedOrg();
    const who = workosUser({ email: `${unique('pat')}@bigcorp.example` });
    const row = await seedUser({ workosUserId: who.id as string, email: who.email as string });
    await addMember(orgId, row.id, role);
    await addMember(personal, row.id, 'owner');
    organizationAt(workosOrgId, [['bigcorp.example', 'verified']]);
    return { workosOrgId, orgId, personal, who, userId: row.id };
  }

  async function requireSso(orgId: string) {
    await t.pg.query(`update organizations set sso_required = true where id = $1`, [orgId]);
  }

  it('takes the organisation from a session issued before the flag went on, the moment it does', async () => {
    // The hole: the requirement was checked at sign-in only, so a session
    // issued the day before kept the organisation for its thirty days.
    const company = await companyWithMember();
    const session = sessionTokenOf(await signIn(company.who, { authenticationMethod: 'Password' }));
    const slug = await slugOf(company.orgId);
    expect((await reachOrg(slug, { session })).status).toBe(200);

    await requireSso(company.orgId);

    expect(await reachOrg(slug, { session })).toEqual({ status: 403, code: 'sso_required' });
    // Every other organisation the member is in is untouched.
    expect((await reachOrg(await slugOf(company.personal), { session })).status).toBe(200);
  });

  it('lets a session from the organisation’s own single sign-on through', async () => {
    const company = await companyWithMember();
    await requireSso(company.orgId);
    const slug = await slugOf(company.orgId);

    const result = await signIn(
      company.who,
      { authenticationMethod: 'SSO', organizationId: company.workosOrgId },
      { query: `?org=${slug}`, headers: FROM_THIS_SITE },
    );

    expect(result.parked).toBeNull(); // the flow asked for exactly this organisation
    expect((await reachOrg(slug, { session: sessionTokenOf(result) })).status).toBe(200);
  });

  it('refuses a session from another organisation’s single sign-on', async () => {
    const company = await companyWithMember();
    const elsewhere = unique('org_01');
    await seedOrg({ workosOrgId: elsewhere });
    organizationAt(elsewhere, [['bigcorp.example', 'verified']]);
    await requireSso(company.orgId);

    const result = await signIn(company.who, {
      authenticationMethod: 'SSO',
      organizationId: elsewhere,
    });

    expect(
      await reachOrg(await slugOf(company.orgId), { session: sessionTokenOf(result) }),
    ).toEqual({ status: 403, code: 'sso_required' });
  });

  it('exempts an owner on every request too', async () => {
    const company = await companyWithMember('owner');
    await requireSso(company.orgId);

    const result = await signIn(company.who, { authenticationMethod: 'Password' });

    expect(
      (await reachOrg(await slugOf(company.orgId), { session: sessionTokenOf(result) })).status,
    ).toBe(200);
  });

  it('refuses a CLI token approved from a password session, and keeps one approved from the SSO', async () => {
    // A CLI token's expiry can be never: checked at sign-in only, one minted
    // the day before the flag went on was a permanent way round it.
    const company = await companyWithMember();
    await requireSso(company.orgId);
    const slug = await slugOf(company.orgId);
    const fromPassword = await createCliToken(t.db, {
      orgId: company.orgId,
      userId: company.userId,
      name: 'laptop',
      signInMethod: 'password',
    });
    const fromSso = await createCliToken(t.db, {
      orgId: company.orgId,
      userId: company.userId,
      name: 'laptop (sso)',
      signInMethod: 'sso',
      ssoWorkosOrgId: company.workosOrgId,
    });
    const minted = await createCliToken(t.db, {
      orgId: company.orgId,
      userId: company.userId,
      name: 'old laptop',
    });

    expect(await reachOrg(slug, { bearer: fromPassword.token })).toEqual({
      status: 403,
      code: 'sso_required',
    });
    expect(await reachOrg(slug, { bearer: minted.token })).toEqual({
      status: 403,
      code: 'sso_required',
    });
    expect((await reachOrg(slug, { bearer: fromSso.token })).status).toBe(200);
  });

  it('refuses a password newcomer an invitation into an organisation that requires SSO, and admits an owner’s', async () => {
    // A newcomer has no memberships, so nothing was refused at sign-in; the
    // invitation was the way round the requirement.
    const workosOrgId = unique('org_01');
    const orgId = await seedOrg({ workosOrgId, ssoRequired: true });
    const founder = (
      await t.pg.query<{ created_by: string }>(
        `select created_by from organizations where id = $1`,
        [orgId],
      )
    ).rows[0]!.created_by;

    for (const [role, expected] of [
      ['developer', 403],
      ['owner', 200],
    ] as const) {
      const who = workosUser({ email: `${unique('newcomer')}@example.com` });
      const signedIn = await signIn(who, { authenticationMethod: 'Password' });
      const issued = await createInvitation(t.db, {
        orgId,
        email: who.email as string,
        role,
        invitedBy: founder,
      });

      const answer = await acceptWith(signedIn, issued.token);

      expect(answer.status, role).toBe(expected);
      if (expected === 403) expect(answer.code).toBe('sso_required');
      const [row] = await userRows('workos_user_id', who.id as string);
      expect(
        (await membershipsOf(row!.id)).some((m) => m.org_id === orgId),
        role,
      ).toBe(expected === 200);
    }
  });
});

/* ── the planted-session login CSRF (review S1) ───────────────────────────── */

describe('a sign-in that came back through an organisation the flow did not ask for', () => {
  /** An organisation an attacker set up, wired to an identity provider they control. */
  async function attackersOrg() {
    const workosOrgId = unique('org_01');
    const orgId = await seedOrg({ workosOrgId });
    await t.pg.query(`update organizations set name = 'Your Company' where id = $1`, [orgId]);
    organizationAt(workosOrgId, [['attacker.example', 'verified']]);
    return { workosOrgId, orgId, slug: await slugOf(orgId) };
  }

  const attacker = () => workosUser({ email: `${unique('mallory')}@attacker.example` });

  it.each([
    ['the victim’s own click on “Sign in”', FROM_THIS_SITE],
    ['a link on another site', { 'sec-fetch-site': 'cross-site' }],
    [
      'the identity provider’s initiate-login redirect',
      { 'sec-fetch-site': 'cross-site', referer: 'https://idp.attacker.example/' },
    ],
  ] as Array<[string, Record<string, string>]>)(
    'issues no session for a plain sign-in answered through an organisation’s SSO — from %s',
    async (_label, headers) => {
      // The attack: the attacker first planted their own AuthKit session in
      // the victim's browser. The victim's next plain sign-in — valid state,
      // valid PKCE — comes back as the attacker.
      const org = await attackersOrg();
      const who = attacker();

      const result = await signIn(
        who,
        { authenticationMethod: 'SSO', organizationId: org.workosOrgId },
        { headers, confirm: false },
      );

      expect(result.status).toBe(303);
      expect(result.location).toBe('/sign-in/confirm');
      expect(sessionCookieIssued(result)).toBe(false);
      expect(result.cookies).toContain(
        `${OAUTH_STATE_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
      );
      const [row] = await userRows('workos_user_id', who.id as string);
      expect(await sessionsFor(row!.id)).toEqual([]);
      // Parked: sealed, HttpOnly, for five minutes at most.
      const header = result.cookies.find((c) =>
        c.startsWith(`${SIGN_IN_CONFIRMATION_COOKIE_NAME}=c1.`),
      );
      expect(header?.split('; ')).toEqual(
        expect.arrayContaining(['HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=300']),
      );
      expect(await parkedValue(result.parked!)).toMatchObject({
        userId: row!.id,
        email: who.email,
        signInMethod: 'sso',
        ssoWorkosOrgId: org.workosOrgId,
        organization: { name: 'Your Company', slug: org.slug },
        reason: 'organization',
      });
      expect(audit.map((e) => e.action)).not.toContain('auth.login');
    },
  );

  it('issues the session on the confirmation POST, once — the same cookie a second time issues nothing', async () => {
    const org = await attackersOrg();
    const who = attacker();
    const parked = await signIn(
      who,
      { authenticationMethod: 'SSO', organizationId: org.workosOrgId },
      { query: '?next=%2Fapp%2Fsomewhere', confirm: false },
    );

    const first = await confirm(parked.parked!);
    const second = await confirm(parked.parked!);

    expect(first.location).toBe('/app/somewhere');
    expect(sessionCookieIssued(first)).toBe(true);
    expect(first.cookies).toContain(
      `${SIGN_IN_CONFIRMATION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    );
    expect(second.error).toBe('expired');
    expect(sessionCookieIssued(second)).toBe(false);
    const [row] = await userRows('workos_user_id', who.id as string);
    expect(await sessionsFor(row!.id)).toHaveLength(1);
    // The session it issued is the SSO one, and is recorded as such.
    const facts = await t.pg.query<{ sign_in_method: string; sso_workos_org_id: string }>(
      `select sign_in_method, sso_workos_org_id from sessions where user_id = $1`,
      [row!.id],
    );
    expect(facts.rows).toEqual([{ sign_in_method: 'sso', sso_workos_org_id: org.workosOrgId }]);
    expect(audit.filter((e) => e.action === 'auth.signup')).toHaveLength(1);
  });

  it('refuses a confirmation more than five minutes old', async () => {
    const org = await attackersOrg();
    const parked = await signIn(
      attacker(),
      { authenticationMethod: 'SSO', organizationId: org.workosOrgId },
      { confirm: false },
    );
    const token = (await parkedValue(parked.parked!)).nonce;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 5 * 60_000 + 1_000);
      const late = await confirm(parked.parked!, { token });
      expect(late.error).toBe('expired');
      expect(sessionCookieIssued(late)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['no Origin at all', { origin: null }],
    ['another site’s Origin', { origin: 'https://evil.example' }],
    ['a cross-site fetch', { site: 'cross-site' }],
    ['no token', { token: null }],
    ['somebody else’s token', { token: 'A'.repeat(43) }],
  ] as Array<[string, Parameters<typeof confirm>[1]]>)(
    'refuses a confirmation with %s — the CSRF check — and leaves the cookie unspent',
    async (_label, options) => {
      const org = await attackersOrg();
      const who = attacker();
      const parked = await signIn(
        who,
        { authenticationMethod: 'SSO', organizationId: org.workosOrgId },
        { confirm: false },
      );

      const forged = await confirm(parked.parked!, options);

      expect(forged.error).toBe('expired');
      expect(sessionCookieIssued(forged)).toBe(false);
      const [row] = await userRows('workos_user_id', who.id as string);
      expect(await sessionsFor(row!.id)).toEqual([]);
      // Refused before the nonce was spent: the person's own answer still works.
      expect(sessionCookieIssued(await confirm(parked.parked!))).toBe(true);
    },
  );

  it('issues nothing when the person says it is not them, spends the cookie, and keeps the session they had', async () => {
    const victim = workosUser();
    await signIn(victim);
    const [victimRow] = await userRows('workos_user_id', victim.id as string);
    const { token: victimSession } = await generateToken('session');
    await createSession(t.db, {
      userId: victimRow!.id,
      token: victimSession,
      ipAddress: null,
      userAgent: null,
    });
    const org = await attackersOrg();
    const parked = await signIn(
      attacker(),
      { authenticationMethod: 'SSO', organizationId: org.workosOrgId },
      { confirm: false, sessionToken: victimSession },
    );

    const declined = await confirm(parked.parked!, {
      decision: 'cancel',
      sessionToken: victimSession,
    });

    expect(declined.location).toBe('/sign-in');
    expect(sessionCookieIssued(declined)).toBe(false);
    expect((await sessionsFor(victimRow!.id)).every((s) => s.revoked_at === null)).toBe(true);
    expect(warned('declined')).toBe(true);
    expect((await confirm(parked.parked!)).error).toBe('expired');
  });

  it('leaves the expected flow alone: a deep link answered through the organisation it asked for signs in at once', async () => {
    const workosOrgId = unique('org_01');
    const slug = await slugOf(await seedOrg({ workosOrgId }));
    organizationAt(workosOrgId, [['bigcorp.example', 'verified']]);

    const result = await signIn(
      workosUser({ email: `${unique('alice')}@bigcorp.example` }),
      { authenticationMethod: 'SSO', organizationId: workosOrgId },
      { query: `?org=${slug}`, headers: FROM_THIS_SITE, confirm: false },
    );

    expect(result.parked).toBeNull();
    expect(sessionCookieIssued(result)).toBe(true);
    expect(result.location).toBe('/app');
  });

  it('holds back a deep link answered through a different organisation', async () => {
    const asked = unique('org_01');
    const slug = await slugOf(await seedOrg({ workosOrgId: asked }));
    const org = await attackersOrg();

    const result = await signIn(
      attacker(),
      { authenticationMethod: 'SSO', organizationId: org.workosOrgId },
      { query: `?org=${slug}`, headers: FROM_THIS_SITE, confirm: false },
    );

    expect(result.location).toBe('/sign-in/confirm');
    expect(sessionCookieIssued(result)).toBe(false);
  });

  it('holds back a sign-in WorkOS answered from a session it reused without asking, whatever it names', async () => {
    const anHourAgo = Math.floor(Date.now() / 1000) - 3600;

    const result = await signIn(
      workosUser(),
      { authenticationMethod: 'Password', accessToken: accessTokenAuthenticatedAt(anHourAgo) },
      { confirm: false },
    );

    expect(result.location).toBe('/sign-in/confirm');
    expect(await parkedValue(result.parked!)).toMatchObject({
      reason: 'reused-session',
      signInMethod: 'password',
      ssoWorkosOrgId: null,
      organization: null,
    });
  });

  it('signs a fresh plain sign-in that named no organisation in at once', async () => {
    const result = await signIn(
      workosUser(),
      { authenticationMethod: 'Password' },
      { confirm: false },
    );

    expect(result.parked).toBeNull();
    expect(sessionCookieIssued(result)).toBe(true);
  });

  it('shows the organisation as the claim it is, from the cookie alone', async () => {
    const org = await attackersOrg();
    const parked = await signIn(
      attacker(),
      { authenticationMethod: 'SSO', organizationId: org.workosOrgId },
      { confirm: false },
    );

    const view = await confirmationView(
      await deriveSignInConfirmationKey(COOKIE_PASSWORD),
      parked.parked!,
    );

    expect(view).toMatchObject({
      sso: true,
      organization: { name: 'Your Company', slug: org.slug },
      reason: 'organization',
    });
    expect(
      await confirmationView(await deriveSignInConfirmationKey(COOKIE_PASSWORD), 'c1.x.y'),
    ).toBeNull();
  });
});

describe('just-in-time membership', () => {
  /** An organisation linked to WorkOS that opted in to just-in-time joins, unless told otherwise. */
  async function ssoOrg(over: { seatLimit?: number; jitJoinEnabled?: boolean } = {}) {
    const workosOrgId = unique('org_01');
    const orgId = await seedOrg({ workosOrgId, jitJoinEnabled: true, ...over });
    organizationAt(workosOrgId, [['bigcorp.example', 'verified']]);
    return { workosOrgId, orgId };
  }

  it('does not join anybody to an organisation that has not opted in', async () => {
    // PR #114's constraint for WS-5: a WorkOS link and an IdP connection are
    // not, on their own, consent to admit everybody that IdP signs in.
    const { workosOrgId, orgId } = await ssoOrg({ jitJoinEnabled: false });
    const who = workosUser({ email: `${unique('new')}@bigcorp.example` });

    const result = await signIn(who, { authenticationMethod: 'SSO', organizationId: workosOrgId });

    // Signed in all the same — to a personal organisation of their own.
    expect(result.error).toBeNull();
    const [row] = await userRows('workos_user_id', who.id as string);
    const memberships = await membershipsOf(row!.id);
    expect(memberships.map((m) => m.org_id)).not.toContain(orgId);
    expect(memberships).toEqual([expect.objectContaining({ role: 'owner' })]);
    expect(audit.map((e) => e.action)).not.toContain('member.jit_joined');
    expect(audit.map((e) => e.action)).not.toContain('member.jit_denied');
  });

  it('does not refuse a newcomer for want of a seat in an organisation that never offered one', async () => {
    // A full organisation that has not opted in is not a "no seat" refusal:
    // there was never an offer to refuse.
    const { workosOrgId } = await ssoOrg({ jitJoinEnabled: false, seatLimit: 1 });
    const who = workosUser({ email: `${unique('new')}@bigcorp.example` });

    const result = await signIn(who, { authenticationMethod: 'SSO', organizationId: workosOrgId });

    expect(result.error).toBeNull();
    expect(audit.map((e) => e.action)).not.toContain('member.jit_denied');
  });

  it('joins a newcomer arriving through the organisation’s SSO as a viewer, with no personal organisation', async () => {
    const { workosOrgId, orgId } = await ssoOrg();
    const who = workosUser({ email: `${unique('new')}@bigcorp.example` });

    const result = await signIn(who, { authenticationMethod: 'SSO', organizationId: workosOrgId });

    expect(result.error).toBeNull();
    const [row] = await userRows('workos_user_id', who.id as string);
    expect(await membershipsOf(row!.id)).toEqual([
      { org_id: orgId, role: 'viewer', status: 'active' },
    ]);
    const joined = audit.find((e) => e.action === 'member.jit_joined');
    expect(joined?.orgId).toBe(orgId);
    expect(joined?.metadata.newRole).toBe('viewer');
    expect(audit.map((e) => e.action)).not.toContain('org.created');
  });

  it('does not join on organisation selection in a password sign-in', async () => {
    const { workosOrgId, orgId } = await ssoOrg();
    const who = workosUser({ email: `${unique('new')}@bigcorp.example` });

    await signIn(who, { authenticationMethod: 'Password', organizationId: workosOrgId });

    const [row] = await userRows('workos_user_id', who.id as string);
    const memberships = await membershipsOf(row!.id);
    expect(memberships.map((m) => m.org_id)).not.toContain(orgId);
    expect(memberships).toEqual([expect.objectContaining({ role: 'owner' })]);
  });

  it('refuses the sign-in when the organisation has no free seat, and audits who was turned away', async () => {
    // The founder already holds the one seat.
    const { workosOrgId, orgId } = await ssoOrg({ seatLimit: 1 });
    const who = workosUser({ email: `${unique('late')}@bigcorp.example` });

    const result = await signIn(who, { authenticationMethod: 'SSO', organizationId: workosOrgId });

    expect(result.error).toBe('no-seat');
    expect(sessionCookieIssued(result)).toBe(false);
    const denied = audit.find((e) => e.action === 'member.jit_denied');
    expect(denied?.orgId).toBe(orgId);
    expect(denied?.outcome).toBe('error');
    const [row] = await userRows('workos_user_id', who.id as string);
    expect(await membershipsOf(row!.id)).toEqual([]);
  });

  it('audits an adoption refused for want of a seat, even with no organisation of its own', async () => {
    // A Firebase-era account with no membership anywhere, adopted by an SSO
    // sign-in that JIT then cannot seat: no personal organisation is created
    // on this path, so the link is filed under the organisation it was for.
    const { workosOrgId, orgId } = await ssoOrg({ seatLimit: 1 });
    const existing = await seedUser({ email: `${unique('fbsso')}@bigcorp.example` });
    const who = workosUser({ email: existing.email });

    const result = await signIn(who, { authenticationMethod: 'SSO', organizationId: workosOrgId });

    expect(result.error).toBe('no-seat');
    expect((await userRows('id', existing.id))[0]?.workos_user_id).toBe(who.id);
    expect(audit.find((e) => e.action === 'auth.identity_linked')?.orgId).toBe(orgId);
  });

  it('does not re-admit somebody the organisation removed, and files who was turned away (review S4)', async () => {
    // Removal deleted the membership and left nothing behind: still in the
    // identity provider, the person rejoined as a viewer at their next sign-in.
    const { workosOrgId, orgId } = await ssoOrg();
    const who = workosUser({ email: `${unique('gone')}@bigcorp.example` });
    await signIn(who, { authenticationMethod: 'SSO', organizationId: workosOrgId });
    const [row] = await userRows('workos_user_id', who.id as string);
    const member = (
      await t.pg.query<{ id: string }>(
        `select id from org_members where org_id = $1 and user_id = $2`,
        [orgId, row!.id],
      )
    ).rows[0]!;
    const founder = (
      await t.pg.query<{ created_by: string }>(
        `select created_by from organizations where id = $1`,
        [orgId],
      )
    ).rows[0]!.created_by;
    await removeMember(t.db, { orgId, memberId: member.id, removedBy: founder }, () => {});
    audit = [];

    const result = await signIn(who, { authenticationMethod: 'SSO', organizationId: workosOrgId });

    // Signed in — to a personal organisation of their own — and not back in.
    expect(result.error).toBeNull();
    const memberships = await membershipsOf(row!.id);
    expect(memberships.map((m) => m.org_id)).not.toContain(orgId);
    expect(audit.map((e) => e.action)).not.toContain('member.jit_joined');
    expect(audit.filter((e) => e.action === 'member.jit_denied')).toEqual([
      expect.objectContaining({
        orgId,
        outcome: 'error',
        metadata: expect.objectContaining({ reason: 'removed', targetEmail: who.email }),
      }),
    ]);
  });

  it('never reinstates a suspended member', async () => {
    const { workosOrgId, orgId } = await ssoOrg();
    const who = workosUser({ email: `${unique('sus')}@bigcorp.example` });
    const row = await seedUser({ workosUserId: who.id as string, email: who.email as string });
    await addMember(orgId, row.id, 'developer', 'suspended');

    const result = await signIn(who, { authenticationMethod: 'SSO', organizationId: workosOrgId });

    expect(result.error).toBeNull();
    expect(await membershipsOf(row.id)).toContainEqual({
      org_id: orgId,
      role: 'developer',
      status: 'suspended',
    });
    expect(audit.map((e) => e.action)).not.toContain('member.jit_joined');
  });
});

/* ── sessions, and the reauth record ──────────────────────────────────────── */

describe('the session a sign-in issues', () => {
  async function liveSession(userId: string): Promise<string> {
    const { token } = await generateToken('session');
    await createSession(t.db, { userId, token, ipAddress: null, userAgent: null });
    return token;
  }

  it('replaces this browser’s previous session of the same account, revoking it', async () => {
    const who = workosUser();
    await signIn(who);
    const [row] = await userRows('workos_user_id', who.id as string);
    const old = await liveSession(row!.id);

    await signIn(who, {}, { sessionToken: old });

    const sessions = await sessionsFor(row!.id);
    expect(sessions.filter((s) => s.revoked_at === null)).toHaveLength(2);
    expect(sessions.filter((s) => s.revoked_at !== null)).toHaveLength(1);
  });

  it('keeps the browser’s previous session when the sign-in fails before issuing a new one', async () => {
    // The old session is retired only once the new one has committed: a
    // sign-in that fails on the way must not leave the browser with neither.
    const who = workosUser();
    await signIn(who);
    const [row] = await userRows('workos_user_id', who.id as string);
    const old = await liveSession(row!.id);
    await t.pg.exec(`
      create function refuse_reauthentication() returns trigger language plpgsql as $$
        begin raise exception 'refused for the test'; end $$;
      create trigger refuse_reauthentication before insert on reauthentications
        for each row execute function refuse_reauthentication();
    `);
    try {
      const result = await signIn(
        who,
        { authenticationMethod: 'Password' },
        { query: '?reauth=1', sessionToken: old },
      );

      expect(result.error).not.toBeNull();
      expect(sessionCookieIssued(result)).toBe(false);
      expect((await sessionsFor(row!.id)).every((s) => s.revoked_at === null)).toBe(true);
    } finally {
      await t.pg.exec(`
        drop trigger refuse_reauthentication on reauthentications;
        drop function refuse_reauthentication();
      `);
    }
  });

  it('still signs in when the previous session cannot be revoked, and logs it as an error', async () => {
    const who = workosUser();
    await signIn(who);
    const [row] = await userRows('workos_user_id', who.id as string);
    const old = await liveSession(row!.id);
    await t.pg.exec(`
      create function refuse_session_update() returns trigger language plpgsql as $$
        begin raise exception 'refused for the test'; end $$;
      create trigger refuse_session_update before update on sessions
        for each row execute function refuse_session_update();
    `);
    try {
      const result = await signIn(who, {}, { sessionToken: old });

      expect(result.error).toBeNull();
      expect(sessionCookieIssued(result)).toBe(true);
      expect(lines.find((l) => l.message.includes('could not revoke the session'))?.level).toBe(
        'error',
      );
      expect((await sessionsFor(row!.id)).every((s) => s.revoked_at === null)).toBe(true);
    } finally {
      await t.pg.exec(`
        drop trigger refuse_session_update on sessions;
        drop function refuse_session_update();
      `);
    }
  });

  it('leaves another account’s session alone', async () => {
    const other = await seedUser({ workosUserId: unique('user_01OTHER') });
    const theirs = await liveSession(other.id);

    await signIn(workosUser(), {}, { sessionToken: theirs });

    expect((await sessionsFor(other.id)).every((s) => s.revoked_at === null)).toBe(true);
  });

  async function reauthRows(userId: string) {
    return (
      await t.pg.query<{ session_id: string }>(
        `select session_id from reauthentications where user_id = $1`,
        [userId],
      )
    ).rows;
  }

  it.each([['Password'], ['Passkey'], ['GoogleOAuth'], ['SSO']])(
    'records a forced re-authentication by %s against the session it issued',
    async (method) => {
      const workosOrgId = unique('org_01');
      organizationAt(workosOrgId, [['example.com', 'verified']]);
      const who = workosUser();

      await signIn(
        who,
        {
          authenticationMethod: method,
          ...(method === 'SSO' ? { organizationId: workosOrgId } : {}),
        },
        { query: '?reauth=1' },
      );

      const [row] = await userRows('workos_user_id', who.id as string);
      const [session] = await sessionsFor(row!.id);
      expect(await reauthRows(row!.id)).toEqual([{ session_id: session!.id }]);
    },
  );

  it.each([['MagicAuth'], [null], ['GitHubOAuth'], ['MicrosoftOAuth'], ['CrossAppAuth']])(
    'does not count a re-authentication by %s — only the named methods are lock one',
    async (method) => {
      const who = workosUser();

      const result = await signIn(who, method === null ? {} : { authenticationMethod: method }, {
        query: '?reauth=1',
      });

      expect(result.error).toBeNull();
      const [row] = await userRows('workos_user_id', who.id as string);
      expect(await reauthRows(row!.id)).toEqual([]);
    },
  );

  it('does not count a re-authentication AuthKit answered from a session it already held', async () => {
    // `max_age=0` stripped from the URL, or not honoured: AuthKit signs the
    // person straight back in, and the code is dated by the earlier sign-in.
    const who = workosUser();
    const anHourAgo = Math.floor(Date.now() / 1000) - 3600;

    const result = await signIn(
      who,
      { authenticationMethod: 'Password', accessToken: accessTokenAuthenticatedAt(anHourAgo) },
      { query: '?reauth=1' },
    );

    expect(result.error).toBeNull();
    expect(sessionCookieIssued(result)).toBe(true);
    const [row] = await userRows('workos_user_id', who.id as string);
    expect(await reauthRows(row!.id)).toEqual([]);
    const warning = lines.find((l) => l.message.includes('did not show a fresh authentication'));
    expect(warning).toMatchObject({ level: 'warn', reason: 'stale' });
    expect(warning?.authenticatedSecondsBeforeFlow).toBeGreaterThanOrEqual(3590);
  });

  it.each([
    ['an opaque access token', 'workos-access-token'],
    ['a token with no auth_time', accessTokenAuthenticatedAt(null)],
    ['no access token at all', undefined],
  ])('does not count a re-authentication with %s — fails closed', async (_name, accessToken) => {
    const who = workosUser();

    const result = await signIn(
      who,
      { authenticationMethod: 'Passkey', accessToken },
      { query: '?reauth=1' },
    );

    expect(sessionCookieIssued(result)).toBe(true);
    const [row] = await userRows('workos_user_id', who.id as string);
    expect(await reauthRows(row!.id)).toEqual([]);
    expect(lines.find((l) => l.reason === 'no-auth-time')).toBeDefined();
  });

  it('counts one authenticated a few seconds before the flow began, for clock difference', async () => {
    const who = workosUser();

    await signIn(
      who,
      {
        authenticationMethod: 'Password',
        accessToken: accessTokenAuthenticatedAt(Math.floor(Date.now() / 1000) - 15),
      },
      { query: '?reauth=1' },
    );

    const [row] = await userRows('workos_user_id', who.id as string);
    expect(await reauthRows(row!.id)).toHaveLength(1);
  });

  it('does not count one authenticated a minute before the flow began', async () => {
    const who = workosUser();

    await signIn(
      who,
      {
        authenticationMethod: 'GoogleOAuth',
        accessToken: accessTokenAuthenticatedAt(Math.floor(Date.now() / 1000) - 60),
      },
      { query: '?reauth=1' },
    );

    const [row] = await userRows('workos_user_id', who.id as string);
    expect(await reauthRows(row!.id)).toEqual([]);
  });

  it('needs no auth_time for an ordinary sign-in', async () => {
    const who = workosUser();

    const result = await signIn(who, {
      authenticationMethod: 'Password',
      accessToken: 'workos-access-token',
    });

    expect(result.error).toBeNull();
    expect(sessionCookieIssued(result)).toBe(true);
  });

  it('records nothing for an ordinary sign-in', async () => {
    const who = workosUser();

    await signIn(who, { authenticationMethod: 'Password' });

    const [row] = await userRows('workos_user_id', who.id as string);
    expect(await reauthRows(row!.id)).toEqual([]);
  });

  it('issues no session when the re-authentication cannot be recorded — one transaction', async () => {
    // The database itself refuses the row (the test database's statement hooks
    // do not reach inside a transaction), so the session issued just before it
    // must go with it.
    await t.pg.exec(`
      create function refuse_reauthentication() returns trigger language plpgsql as $$
        begin raise exception 'refused for the test'; end $$;
      create trigger refuse_reauthentication before insert on reauthentications
        for each row execute function refuse_reauthentication();
    `);
    try {
      const who = workosUser();

      const result = await signIn(
        who,
        { authenticationMethod: 'Password' },
        { query: '?reauth=1' },
      );

      expect(result.error).not.toBeNull();
      expect(sessionCookieIssued(result)).toBe(false);
      const [row] = await userRows('workos_user_id', who.id as string);
      expect(row).toBeDefined();
      expect(await sessionsFor(row!.id)).toEqual([]);
      expect(await reauthRows(row!.id)).toEqual([]);
    } finally {
      await t.pg.exec(`
        drop trigger refuse_reauthentication on reauthentications;
        drop function refuse_reauthentication();
      `);
    }
  });
});

describe('rate limiting', () => {
  it('refuses by address before the state or the code is looked at', async () => {
    env['RL_LOGIN'] = { limit: async () => ({ success: false }) };
    const flow = await startSignIn();

    const result = await finishSignIn(flow);

    expect(result.error).toBe('rate-limited');
    expect(workos.authenticateWithCode).not.toHaveBeenCalled();
  });

  it('refuses by identity once the code has named one', async () => {
    const keys: string[] = [];
    env['RL_LOGIN'] = {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: !key.includes('user_') };
      },
    };
    const who = workosUser();

    const result = await signIn(who);

    expect(result.error).toBe('rate-limited');
    expect(keys.some((k) => k.includes((who.id as string).toLowerCase()))).toBe(true);
    expect(await userRows('workos_user_id', who.id as string)).toHaveLength(0);
  });
});

/* ── what is gone, and what is unchanged ──────────────────────────────────── */

describe('the session route', () => {
  it('no longer accepts a sign-in: the Firebase ID-token exchange is gone', () => {
    expect('POST' in sessionRoute).toBe(false);
  });

  it('still signs out exactly as before: CSRF-checked, revoked, cookies cleared', async () => {
    const who = workosUser();
    await signIn(who);
    const [row] = await userRows('workos_user_id', who.id as string);
    const { token } = await generateToken('session');
    await createSession(t.db, { userId: row!.id, token, ipAddress: null, userAgent: null });

    const refused = await sessionRoute.DELETE(
      new Request(`${ORIGIN}/api/auth/session`, {
        method: 'DELETE',
        headers: { cookie: `__Host-xecret_session=${token}; __Host-xecret_csrf=abc` },
      }),
    );
    expect(refused.status).toBe(403);

    const response = await sessionRoute.DELETE(
      new Request(`${ORIGIN}/api/auth/session`, {
        method: 'DELETE',
        headers: {
          cookie: `__Host-xecret_session=${token}; __Host-xecret_csrf=abc`,
          'x-xecret-csrf': 'abc',
        },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.getSetCookie()).toEqual([
      '__Host-xecret_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
      '__Host-xecret_csrf=; Path=/; Max-Age=0; Secure; SameSite=Lax',
    ]);
    const revoked = (await sessionsFor(row!.id)).filter((s) => s.revoked_at !== null);
    expect(revoked).toHaveLength(1);
    expect(audit.map((e) => e.action)).toContain('auth.logout');
  });
});

describe('whether a re-authentication arms lock one', () => {
  const flowIssuedAt = 1_800_000_000;

  it('arms only for a counting method with a fresh, numeric authentication time', async () => {
    const { armsLockOne } = await import('./sign-in');
    expect(
      armsLockOne({ authenticationMethod: 'Passkey', authenticatedAt: flowIssuedAt }, flowIssuedAt),
    ).toBe('armed');
    expect(
      armsLockOne(
        { authenticationMethod: 'MagicAuth', authenticatedAt: flowIssuedAt },
        flowIssuedAt,
      ),
    ).toBe('method');
    expect(
      armsLockOne(
        { authenticationMethod: 'Passkey', authenticatedAt: flowIssuedAt - 3600 },
        flowIssuedAt,
      ),
    ).toBe('stale');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a numeric string', String(flowIssuedAt)],
    ['NaN', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
  ])('fails closed when the authentication time is %s', async (_name, authenticatedAt) => {
    const { armsLockOne } = await import('./sign-in');
    expect(
      armsLockOne(
        { authenticationMethod: 'Passkey', authenticatedAt: authenticatedAt as number | null },
        flowIssuedAt,
      ),
    ).toBe('no-auth-time');
  });
});

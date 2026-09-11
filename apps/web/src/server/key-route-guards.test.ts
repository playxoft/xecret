import { beforeEach, describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '@xecret/core/ids';
import type { AuditRecord } from '@xecret/core/audit';
import { createLogger } from './logging';
import type { RequestLog } from './logging';

/**
 * Two guards that live in route modules rather than in a service, and therefore
 * cannot be asserted anywhere else.
 *
 * ── Why this file exists at all ──
 * Most of what a route does is delegated: `routes.test.ts` says plainly that the
 * handlers are not invoked there, because everything they decide is decided by a
 * schema or a service that can be tested directly. Metering and auditing are the
 * exceptions. They are wiring — a call in the right place in the right handler —
 * and the failure mode is a route that simply does not make it. A test that
 * exercised the service would pass either way.
 *
 * So the two handlers are invoked for real, with the wrapper's dependencies
 * stubbed the way `route.test.ts` stubs them, and what is asserted is the two
 * things the wrapper cannot do on the route's behalf: which bucket was spent,
 * and which record was filed.
 */

const context = vi.hoisted(() => ({
  workerContext: vi.fn(),
  createServiceContext: vi.fn(),
}));

const actor = vi.hoisted(() => ({
  authenticate: vi.fn(),
  assertCsrf: vi.fn(),
  isUnlocked: vi.fn(() => true),
  actorType: vi.fn(() => 'user' as const),
  actorId: vi.fn(() => 'actor-id'),
  actorLabel: vi.fn(() => 'nitheesh@playxoft.com'),
}));

const auditSink = vi.hoisted(() => ({ write: vi.fn() }));
const logging = vi.hoisted(() => ({ createRequestLog: vi.fn() }));

/**
 * The rate limiter is stubbed rather than left absent.
 *
 * With no binding the real `enforce` allows everything and reports
 * `enforced: false`, so a route that never called it would be indistinguishable
 * from one that did — which is exactly the regression this file is for.
 */
const limiter = vi.hoisted(() => ({ enforce: vi.fn(), consume: vi.fn() }));

const tenancy = vi.hoisted(() => ({ resolveEnvironmentPath: vi.fn(), authorize: vi.fn() }));
const envKeys = vi.hoisted(() => ({ environmentKeyState: vi.fn(), initializeKeys: vi.fn() }));
const vault = vi.hoisted(() => ({
  vaultStatus: vi.fn(),
  vaultMaterial: vi.fn(),
  vaultMaterialOwner: vi.fn(),
  primaryOrgId: vi.fn(),
  createVault: vi.fn(),
  requireUserPrincipal: vi.fn(),
  setAutoLock: vi.fn(),
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
vi.mock('./rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rate-limit')>()),
  ...limiter,
}));
vi.mock('./tenancy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tenancy')>()),
  ...tenancy,
}));
vi.mock('./env-keys-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./env-keys-service')>()),
  ...envKeys,
}));
vi.mock('./vault-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./vault-service')>()),
  ...vault,
}));

const { GET: readKeys } =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/keys/route');
const { GET: readVault } = await import('@/app/api/auth/vault/route');

const ORG_ID = uuidv7();
const PROJECT_ID = uuidv7();
const ENVIRONMENT_ID = uuidv7();
const USER_ID = uuidv7();
const TOKEN_ID = uuidv7();

const deferred: Promise<unknown>[] = [];
const runtimeDeferred: Promise<unknown>[] = [];

const sessionPrincipal = {
  kind: 'user' as const,
  vaultUnlockedAt: new Date(),
  lastSeenAt: new Date(),
  vaultAutoLockMinutes: null,
  sessionId: uuidv7(),
  user: {
    id: USER_ID,
    email: 'nitheesh@playxoft.com',
    emailVerified: true,
    displayName: null,
    avatarUrl: null,
  },
};

const cliTokenPrincipal = {
  kind: 'cliToken' as const,
  tokenId: TOKEN_ID,
  tokenName: 'laptop',
  userId: USER_ID,
  orgId: ORG_ID,
};

function request(path: string): Request {
  return new Request(`https://xecret.playxoft.com${path}`, { method: 'GET' });
}

function silentLog(base: Record<string, unknown> = {}): RequestLog {
  return createLogger({
    sink: { write: () => {}, flush: () => Promise.resolve() },
    minimum: 'error',
    base,
  });
}

/** Every audit record the request queued, once its deferred work has run. */
async function recorded(): Promise<AuditRecord[]> {
  await Promise.allSettled(deferred);
  await Promise.allSettled(runtimeDeferred);
  return auditSink.write.mock.calls.flatMap((call) => (call[0] ?? []) as AuditRecord[]);
}

beforeEach(() => {
  vi.clearAllMocks();
  deferred.length = 0;
  runtimeDeferred.length = 0;

  auditSink.write.mockResolvedValue(undefined);
  logging.createRequestLog.mockImplementation((_env: unknown, base: Record<string, unknown>) =>
    silentLog(base),
  );

  context.workerContext.mockResolvedValue({
    env: {},
    ctx: { waitUntil: (promise: Promise<unknown>) => void runtimeDeferred.push(promise) },
  });
  context.createServiceContext.mockImplementation(
    async (
      _request: Request,
      _worker: unknown,
      requestId: string,
      log: RequestLog,
      startedAt: number,
    ) => ({
      env: { XECRET_PUBLIC_URL: 'https://xecret.playxoft.com', XECRET_ENV: 'production' },
      db: {},
      envelope: {},
      meta: {
        requestId,
        rayId: null,
        ipAddress: '203.0.113.5',
        userAgent: 'vitest',
        method: 'GET',
        path: '/api/test',
        startedAt,
      },
      log: log.logger,
      bindLog: log.bind,
      waitUntil: (promise: Promise<unknown>) => void deferred.push(promise),
      settled: () => Promise.allSettled(deferred),
      dispose: () => {},
    }),
  );

  actor.authenticate.mockResolvedValue({ principal: sessionPrincipal, source: 'cookie' });
  actor.assertCsrf.mockReturnValue(undefined);
  actor.isUnlocked.mockReturnValue(true);
  actor.actorId.mockReturnValue(USER_ID);

  limiter.enforce.mockResolvedValue({ allowed: true, enforced: true });

  tenancy.resolveEnvironmentPath.mockResolvedValue({
    organization: { id: ORG_ID, slug: 'acme' },
    project: { id: PROJECT_ID, slug: 'api' },
    environment: {
      id: ENVIRONMENT_ID,
      projectId: PROJECT_ID,
      slug: 'production',
      isProduction: true,
      encryptionMode: 'e2ee',
    },
    actor: { kind: 'user', userId: USER_ID, orgId: ORG_ID },
    membership: {
      orgId: ORG_ID,
      userId: USER_ID,
      memberId: USER_ID,
      role: 'owner',
      status: 'active',
      grants: [],
    },
  });
  envKeys.environmentKeyState.mockResolvedValue({
    encryptionMode: 'e2ee',
    environmentId: ENVIRONMENT_ID,
    activeEdk: null,
    myGrant: null,
    ehkExists: false,
    pendingGrants: null,
    needsRotation: null,
    missingGrants: null,
    currentMaxSecretVersion: 0,
  });

  vault.vaultStatus.mockResolvedValue({
    configured: true,
    unlocked: true,
    unlockedUntil: null,
    autoLockMinutes: 0,
  });
  vault.vaultMaterial.mockResolvedValue({ passphraseWrap: 'xk2.gcm.AAAA' });
  vault.primaryOrgId.mockResolvedValue(ORG_ID);
});

describe('GET …/environments/{envSlug}/keys', () => {
  it('spends the read allowance before it answers', async () => {
    // ── The gap this closes ──
    // The endpoint that hands out sealed key material had no rate limit at all.
    // For an administrator it also reads the organisation's active roster and its
    // access grants to decide `needsRotation` and `missingGrants` — cheap per
    // call, unbounded in calls.
    const response = await readKeys(request('/api/orgs/acme/projects/api/environments/prod/keys'));

    expect(response.status).toBe(200);
    expect(limiter.enforce).toHaveBeenCalledWith(
      expect.anything(),
      'RL_SECRET_READ',
      expect.any(String),
    );
  });

  it('spends the service bucket for a token, not a human’s', async () => {
    // The same helper the reveal and pull paths use, so the bucket is not a
    // decision this route makes for itself — a runaway CI pipeline cannot spend
    // the budget a dashboard depends on.
    actor.authenticate.mockResolvedValue({
      principal: {
        kind: 'serviceToken',
        tokenId: TOKEN_ID,
        tokenName: 'deploy',
        orgId: ORG_ID,
        projectId: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
        accessLevel: 'read',
      },
      source: 'bearer',
    });

    await readKeys(request('/api/orgs/acme/projects/api/environments/prod/keys'));

    expect(limiter.enforce).toHaveBeenCalledWith(
      expect.anything(),
      'RL_SERVICE',
      expect.any(String),
    );
  });

  it('does not read the key state when the allowance is exhausted', async () => {
    limiter.enforce.mockRejectedValue(
      Object.assign(new Error('rate limited'), { name: 'ApiError' }),
    );

    await readKeys(request('/api/orgs/acme/projects/api/environments/prod/keys')).catch(() => null);

    expect(envKeys.environmentKeyState).not.toHaveBeenCalled();
  });
});

describe('GET /api/auth/vault', () => {
  it('meters and audits a bearer credential reading the wraps', async () => {
    // ── The disclosure this makes visible ──
    // What a CLI token receives here is the passphrase wrap, the KDF salt and the
    // Argon2 parameters: everything an offline attack on the passphrase needs,
    // held by a credential that lives in a file on a laptop or an environment
    // variable in a CI runner and is good for months. It is not removable —
    // headless `xecret login --passphrase` cannot open a single grant without the
    // user's wrapped private key — so the read is metered and recorded instead.
    actor.authenticate.mockResolvedValue({ principal: cliTokenPrincipal, source: 'bearer' });
    vault.vaultMaterialOwner.mockReturnValue(USER_ID);

    const response = await readVault(request('/api/auth/vault'));
    expect(response.status).toBe(200);

    expect(limiter.enforce).toHaveBeenCalledWith(
      expect.anything(),
      'RL_CLI_TOKEN',
      expect.any(String),
    );

    const events = await recorded();
    const read = events.find((event) => event.action === 'vault.material_read');
    expect(read, 'expected the token read to be audited').toBeDefined();
    expect(read?.metadata?.principalKind).toBe('token');
  });

  it('neither meters nor audits a browser session reading its own', async () => {
    // A session reads its material on every lock screen, several times a day.
    // Metering it would throttle the unlock flow, and auditing it would bury
    // `vault.unlocked` under page views — the same argument the masked secret
    // listing makes.
    vault.vaultMaterialOwner.mockReturnValue(USER_ID);

    await readVault(request('/api/auth/vault'));

    expect(limiter.enforce).not.toHaveBeenCalled();

    const events = await recorded();
    expect(events.some((event) => event.action === 'vault.material_read')).toBe(false);
  });

  it('records nothing for a principal with no vault to read', async () => {
    // A service token: not a person, no vault, and its own key travels in its
    // token string rather than under anybody's User Key.
    actor.authenticate.mockResolvedValue({
      principal: {
        kind: 'serviceToken',
        tokenId: TOKEN_ID,
        tokenName: 'deploy',
        orgId: ORG_ID,
        projectId: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
        accessLevel: 'read',
      },
      source: 'bearer',
    });
    vault.vaultMaterialOwner.mockReturnValue(null);

    await readVault(request('/api/auth/vault'));

    expect(limiter.enforce).not.toHaveBeenCalled();
    expect(vault.vaultMaterial).not.toHaveBeenCalled();

    const events = await recorded();
    expect(events.some((event) => event.action === 'vault.material_read')).toBe(false);
  });
});

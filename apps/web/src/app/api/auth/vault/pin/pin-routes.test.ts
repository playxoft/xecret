import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditRecord } from '@xecret/core/audit';
import { hashUnlockVerifier } from '@xecret/core/auth';
import { randomBytes, toBase64Url } from '@xecret/core/crypto';
import { uuidv7 } from '@xecret/core/ids';
import type { RequestLog } from '@/server/logging';
import { createLogger } from '@/server/logging';

/**
 * The device-PIN routes, invoked for real.
 *
 * ── What these prove ──
 * The gates that live in the handlers and in `vault-service.ts`, which no schema
 * test can see: who may enrol, which route a locked session may reach, that the
 * attempt endpoint spends the same edge allowance a passphrase unlock does, that
 * a successful attempt marks the session unlocked and a failed one does not, and
 * that a burn is audited as its own event rather than folded into an ordinary
 * refusal.
 *
 * ── What they cannot prove ──
 * That `attemptPinUnlock`'s transaction really serialises two concurrent
 * guesses, and that `FOR UPDATE` really blocks the second reader. The repository
 * is replaced outright here, so nothing below claims to know what SQL ran — the
 * shape of it is pinned in `packages/db`, and the isolation belongs to the
 * integration pass, for the reason `orgs-routes.test.ts` records.
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

const repository = vi.hoisted(() => ({
  findVaultKeys: vi.fn(),
  mintPinPepper: vi.fn(),
  attemptPinUnlock: vi.fn(),
  disablePinPepper: vi.fn(),
  listPinPeppers: vi.fn(),
  revokeAllPinPeppers: vi.fn(),
  markSessionUnlocked: vi.fn(),
  listOrganizationsForUser: vi.fn(),
}));

const rateLimit = vi.hoisted(() => ({ enforce: vi.fn() }));

const auditSink = vi.hoisted(() => ({ write: vi.fn() }));

vi.mock('@/server/context', () => context);
vi.mock('@/server/actor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/actor')>()),
  ...actor,
}));
vi.mock('@/server/audit-sink', () => ({
  DatabaseAuditSink: class {
    write = auditSink.write;
  },
}));

vi.mock('@xecret/db/repositories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xecret/db/repositories')>()),
  ...repository,
}));

/**
 * The limiter allows, so a test expecting a particular outcome cannot pass by
 * accidentally being rate-limited instead. That it is consulted at all, and
 * against which bucket, is asserted directly.
 */
vi.mock('@/server/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/rate-limit')>()),
  ...rateLimit,
}));

function log(base: Record<string, unknown> = {}): RequestLog {
  return createLogger({
    sink: { write: () => {}, flush: () => Promise.resolve() },
    minimum: 'error',
    base,
  });
}

vi.mock('@/server/logging', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/server/logging')>();
  return {
    ...original,
    createRequestLog: (_env: unknown, base: Record<string, unknown>) => log(base),
  };
});

const pins = await import('./route');
const attempt = await import('./attempt/route');
const device = await import('./[deviceId]/route');
const { errors } = await import('@/server/errors');

const USER_ID = uuidv7();
const ORG_ID = uuidv7();
const SESSION_ID = uuidv7();
const DEVICE_ID = uuidv7();

const userPrincipal = {
  kind: 'user' as const,
  vaultUnlockedAt: new Date(),
  lastSeenAt: new Date(),
  vaultAutoLockMinutes: null,
  sessionId: SESSION_ID,
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
  tokenId: uuidv7(),
  userId: USER_ID,
  orgId: ORG_ID,
  vaultUnlockedAt: new Date(),
};

const deferred: Promise<unknown>[] = [];
let written: AuditRecord[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  deferred.length = 0;
  written = [];

  auditSink.write.mockImplementation((batch: AuditRecord[]) => {
    written.push(...batch);
    return Promise.resolve();
  });

  context.workerContext.mockResolvedValue({ env: {}, ctx: { waitUntil: () => {} } });
  context.createServiceContext.mockImplementation(
    async (
      _request: Request,
      _worker: unknown,
      requestId: string,
      requestLog: RequestLog,
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
        method: 'POST',
        path: '/api/auth/vault/pin',
        startedAt,
      },
      log: requestLog.logger,
      bindLog: requestLog.bind,
      waitUntil: (promise: Promise<unknown>) => void deferred.push(promise),
      settled: () => Promise.allSettled(deferred),
      dispose: () => {},
    }),
  );

  actor.authenticate.mockResolvedValue({ principal: userPrincipal, source: 'cookie' });
  actor.assertCsrf.mockReturnValue(undefined);
  actor.isUnlocked.mockReturnValue(true);
  actor.actorId.mockReturnValue(USER_ID);

  rateLimit.enforce.mockResolvedValue({ allowed: true, enforced: true });

  repository.findVaultKeys.mockResolvedValue({ userId: USER_ID, autoLockMinutes: null });
  repository.listOrganizationsForUser.mockResolvedValue([{ organization: { id: ORG_ID } }]);
  repository.markSessionUnlocked.mockResolvedValue(undefined);
  repository.listPinPeppers.mockResolvedValue([]);
  repository.revokeAllPinPeppers.mockResolvedValue(0);
  repository.disablePinPepper.mockResolvedValue(true);
  repository.mintPinPepper.mockImplementation(
    async (_exec: unknown, params: { deviceId: string }) => ({
      deviceId: params.deviceId,
      createdAt: new Date('2026-09-10T10:00:00.000Z'),
      lastUsedAt: null,
      attempts: 0,
    }),
  );
});

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://xecret.playxoft.com${path}`, {
    headers: { origin: 'https://xecret.playxoft.com', 'content-type': 'application/json' },
    ...init,
  });
}

function enrolRequest(body: unknown): Request {
  return request('/api/auth/vault/pin', { method: 'POST', body: JSON.stringify(body) });
}

function attemptRequest(body: unknown): Request {
  return request('/api/auth/vault/pin/attempt', { method: 'POST', body: JSON.stringify(body) });
}

async function settle(): Promise<void> {
  await Promise.allSettled(deferred);
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

const verifier = () => toBase64Url(randomBytes(32));

describe('POST /api/auth/vault/pin — enrolling this browser', () => {
  it('mints a pepper and hands it back exactly once', async () => {
    const response = await pins.POST(enrolRequest({ deviceId: DEVICE_ID, verifier: verifier() }));

    expect(response.status).toBe(201);
    const payload = (await body(response))['pin'] as { pepper: string };
    // 32 bytes, base64url. The browser needs it to build the wrap and never
    // stores it — the whole reason the attempt endpoint exists.
    expect(payload.pepper).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(repository.mintPinPepper).toHaveBeenCalledOnce();
  });

  it('stores the digest of the verifier, never the verifier', async () => {
    const presented = verifier();
    await pins.POST(enrolRequest({ deviceId: DEVICE_ID, verifier: presented }));

    const written = repository.mintPinPepper.mock.calls[0]?.[1] as { verifierHash: Uint8Array };
    const expected = await hashUnlockVerifier(
      Uint8Array.from(atob(presented.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
        c.charCodeAt(0),
      ),
    );
    expect([...written.verifierHash]).toEqual([...expected]);
  });

  it('refuses a locked session — there is no User Key to wrap', async () => {
    // A locked browser could only produce a wrap of nothing, and an enrolment
    // for a wrap that opens nothing is worse than none: it suppresses the offer
    // to set one up.
    actor.isUnlocked.mockReturnValue(false);

    const response = await pins.POST(enrolRequest({ deviceId: DEVICE_ID, verifier: verifier() }));

    expect(response.status).toBe(403);
    expect(repository.mintPinPepper).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller', async () => {
    actor.authenticate.mockRejectedValue(errors.unauthenticated());

    const response = await pins.POST(enrolRequest({ deviceId: DEVICE_ID, verifier: verifier() }));

    expect(response.status).toBe(401);
    expect(repository.mintPinPepper).not.toHaveBeenCalled();
  });

  it('refuses a token principal — a vault belongs to a browser session', async () => {
    actor.authenticate.mockResolvedValue({ principal: cliTokenPrincipal, source: 'bearer' });

    const response = await pins.POST(enrolRequest({ deviceId: DEVICE_ID, verifier: verifier() }));

    expect(response.status).toBe(403);
    expect(repository.mintPinPepper).not.toHaveBeenCalled();
  });

  it('refuses a device id that is not a uuid, and a verifier of the wrong length', async () => {
    for (const invalid of [
      { deviceId: 'not-a-uuid', verifier: verifier() },
      { deviceId: DEVICE_ID, verifier: toBase64Url(randomBytes(16)) },
      { deviceId: DEVICE_ID, verifier: verifier(), salt: toBase64Url(randomBytes(16)) },
    ]) {
      const response = await pins.POST(enrolRequest(invalid));
      expect(response.status, JSON.stringify(invalid)).toBe(422);
    }
    expect(repository.mintPinPepper).not.toHaveBeenCalled();
  });

  it('records the enrolment against the account', async () => {
    await pins.POST(enrolRequest({ deviceId: DEVICE_ID, verifier: verifier() }));
    await settle();

    const record = written.find((entry) => entry.action === 'vault.pin_enrolled');
    expect(record?.metadata.deviceName).toBe(DEVICE_ID);
    // The digest, the pepper and the PIN are absent by construction:
    // `AuditMetadata` has no field that could hold any of them.
    expect(JSON.stringify(record?.metadata)).not.toContain('pepper');
  });
});

describe('POST /api/auth/vault/pin/attempt — one guess', () => {
  function outcome(value: unknown): void {
    repository.attemptPinUnlock.mockResolvedValue(value);
  }

  it('spends the login allowance before touching the database', async () => {
    // The same edge bucket a passphrase unlock uses, keyed on IP and user. The
    // durable counter behind it is the real defence; this is what stops a flood
    // reaching a round trip.
    outcome({ status: 'wrong', attemptsRemaining: 4 });

    await attempt.POST(attemptRequest({ deviceId: DEVICE_ID, verifier: verifier() }));

    expect(rateLimit.enforce).toHaveBeenCalledWith(
      expect.anything(),
      'RL_LOGIN',
      expect.anything(),
    );
  });

  it('releases the pepper and unlocks the session on a match', async () => {
    const pepper = randomBytes(32);
    outcome({ status: 'ok', pepper });

    const response = await attempt.POST(
      attemptRequest({ deviceId: DEVICE_ID, verifier: verifier() }),
    );

    expect(response.status).toBe(200);
    const payload = (await body(response))['pin'] as { outcome: string; pepper: string };
    expect(payload.outcome).toBe('unlocked');
    expect(payload.pepper).toBe(toBase64Url(pepper));
    expect(repository.markSessionUnlocked).toHaveBeenCalledOnce();
  });

  it('is reachable from a locked session — every caller of it is at a lock screen', async () => {
    actor.isUnlocked.mockReturnValue(false);
    outcome({ status: 'ok', pepper: randomBytes(32) });

    const response = await attempt.POST(
      attemptRequest({ deviceId: DEVICE_ID, verifier: verifier() }),
    );

    expect(response.status).toBe(200);
  });

  it('answers a miss with the count, releases nothing, and unlocks nothing', async () => {
    outcome({ status: 'wrong', attemptsRemaining: 3 });

    const response = await attempt.POST(
      attemptRequest({ deviceId: DEVICE_ID, verifier: verifier() }),
    );

    // A 200, deliberately: the caller is authenticated, and a 401 would send
    // `lib/api.ts` to the sign-in page for a mistyped digit.
    expect(response.status).toBe(200);
    expect((await body(response))['pin']).toEqual({ outcome: 'wrong', attemptsRemaining: 3 });
    expect(repository.markSessionUnlocked).not.toHaveBeenCalled();
  });

  it('never lets a pepper reach a failed response', async () => {
    for (const failure of [
      { status: 'wrong', attemptsRemaining: 1 },
      { status: 'burned' },
      { status: 'unknown' },
    ]) {
      outcome(failure);
      const response = await attempt.POST(
        attemptRequest({ deviceId: DEVICE_ID, verifier: verifier() }),
      );
      expect(JSON.stringify(await body(response)), failure.status).not.toContain('pepper');
    }
  });

  it('records a burn as its own event, and an ordinary miss as a refused unlock', async () => {
    outcome({ status: 'burned' });
    await attempt.POST(attemptRequest({ deviceId: DEVICE_ID, verifier: verifier() }));
    await settle();

    const burn = written.find((entry) => entry.action === 'vault.pin_burned');
    expect(burn?.outcome).toBe('error');
    expect(burn?.metadata.deviceName).toBe(DEVICE_ID);

    written = [];
    deferred.length = 0;
    outcome({ status: 'wrong', attemptsRemaining: 2 });
    await attempt.POST(attemptRequest({ deviceId: DEVICE_ID, verifier: verifier() }));
    await settle();

    expect(written.map((entry) => entry.action)).toContain('vault.unlock_failed');
    expect(written.map((entry) => entry.action)).not.toContain('vault.pin_burned');
  });

  it('records a successful PIN unlock as an unlock, with the method that names it', async () => {
    outcome({ status: 'ok', pepper: randomBytes(32) });
    await attempt.POST(attemptRequest({ deviceId: DEVICE_ID, verifier: verifier() }));
    await settle();

    const record = written.find((entry) => entry.action === 'vault.unlocked');
    expect(record?.metadata.method).toBe('pin');
  });

  it('compares in constant time against the stored digest, inside the row lock', async () => {
    // The repository runs the comparison the service hands it, so a refactor
    // that moved the compare outside the transaction would fail here.
    const presented = randomBytes(32);
    const stored = await hashUnlockVerifier(presented);

    let matched: boolean | null = null;
    repository.attemptPinUnlock.mockImplementation(
      async (_exec: unknown, params: { matches: (hash: Uint8Array) => Promise<boolean> }) => {
        matched = await params.matches(stored);
        return matched
          ? { status: 'ok', pepper: randomBytes(32) }
          : { status: 'wrong', attemptsRemaining: 4 };
      },
    );

    await attempt.POST(attemptRequest({ deviceId: DEVICE_ID, verifier: toBase64Url(presented) }));
    expect(matched).toBe(true);

    await attempt.POST(attemptRequest({ deviceId: DEVICE_ID, verifier: verifier() }));
    expect(matched).toBe(false);
  });

  it('refuses an unauthenticated caller', async () => {
    actor.authenticate.mockRejectedValue(errors.unauthenticated());

    const response = await attempt.POST(
      attemptRequest({ deviceId: DEVICE_ID, verifier: verifier() }),
    );

    expect(response.status).toBe(401);
    expect(repository.attemptPinUnlock).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/auth/vault/pin/{deviceId} — turning one off', () => {
  const params = Promise.resolve({ deviceId: DEVICE_ID });

  it('answers 404 for a device that is not this account’s', async () => {
    // The repository scopes by user, so "somebody else's" and "nobody's" are
    // indistinguishable here by construction (threat T2).
    repository.disablePinPepper.mockResolvedValue(false);

    const response = await device.DELETE(
      request(`/api/auth/vault/pin/${DEVICE_ID}`, { method: 'DELETE' }),
      { params },
    );

    expect(response.status).toBe(404);
  });

  it('scopes the delete by the account as well as the device', async () => {
    await device.DELETE(request(`/api/auth/vault/pin/${DEVICE_ID}`, { method: 'DELETE' }), {
      params,
    });

    expect(repository.disablePinPepper).toHaveBeenCalledWith(expect.anything(), USER_ID, DEVICE_ID);
  });

  it('refuses a locked session, like every other management view', async () => {
    actor.isUnlocked.mockReturnValue(false);

    const response = await device.DELETE(
      request(`/api/auth/vault/pin/${DEVICE_ID}`, { method: 'DELETE' }),
      { params },
    );

    expect(response.status).toBe(403);
    expect(repository.disablePinPepper).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/auth/vault/pin — turning every one off', () => {
  it('reports how many browsers lost their PIN', async () => {
    repository.revokeAllPinPeppers.mockResolvedValue(3);

    const response = await pins.DELETE(request('/api/auth/vault/pin', { method: 'DELETE' }));

    expect(await body(response)).toEqual({ revoked: 3 });
    expect(repository.revokeAllPinPeppers).toHaveBeenCalledWith(expect.anything(), USER_ID);
  });
});

describe('GET /api/auth/vault/pin — the settings list', () => {
  it('never serves a pepper or a digest', async () => {
    repository.listPinPeppers.mockResolvedValue([
      {
        deviceId: DEVICE_ID,
        createdAt: new Date('2026-09-01T10:00:00.000Z'),
        lastUsedAt: null,
        attempts: 2,
      },
    ]);

    const response = await pins.GET(request('/api/auth/vault/pin'));
    const payload = await body(response);

    expect(payload).toEqual({
      devices: [
        {
          deviceId: DEVICE_ID,
          createdAt: '2026-09-01T10:00:00.000Z',
          lastUsedAt: null,
        },
      ],
    });
    // The serialiser lists its fields, so a column added later cannot reach a
    // client by accident — and `attempts` is not one a browser needs.
    expect(JSON.stringify(payload)).not.toContain('attempts');
  });
});

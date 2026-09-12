import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditRecord } from '@xecret/core/audit';
import { uuidv7 } from '@xecret/core/ids';
import { RepositoryError } from '@xecret/db/repositories';
import type { RequestLog } from '@/server/logging';
import { createLogger } from '@/server/logging';
import { DISPLAY_NAME_MAX_LENGTH } from '@/server/schemas/account';

/**
 * `PATCH /api/auth/account`, invoked for real.
 *
 * The one field an account may change about itself, and therefore the one route
 * where the gates are worth pinning rather than assumed:
 *
 *  - **a browser session only.** A display name is how every teammate in every
 *    shared organisation identifies this person, and a credential left on a
 *    build machine has no business changing who somebody appears to be.
 *  - **the vault lock applies.** Not because a name is key material, but because
 *    "a locked session changes nothing" stops being a rule the moment it has an
 *    exception for the changes that look harmless.
 *  - **the name is validated before anything is written**, including the
 *    difference between clearing it and leaving it alone.
 *  - **the act is audited**, against the account's primary organisation, the way
 *    every other account-level act is.
 *
 * Everything below the handler is stubbed, following `orgs-routes.test.ts`: the
 * Cloudflare context, authentication, the audit sink and the repository. The
 * database is not simulated — `updateUserProfile` is replaced outright, so
 * nothing here claims to prove what SQL runs. What it proves is which gate is
 * consulted, in what order, and what the caller is told.
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
  updateUserProfile: vi.fn(),
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

// Only the two functions this route reaches are replaced. Spreading the
// original keeps `RepositoryError` and the schema modules' import-time reads
// real — see the note in `orgs-routes.test.ts`.
vi.mock('@xecret/db/repositories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xecret/db/repositories')>()),
  ...repository,
}));

vi.mock('@/server/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/rate-limit')>()),
  ...rateLimit,
}));

const account = await import('./route');

const USER_ID = uuidv7();
const ORG_ID = uuidv7();

const userPrincipal = {
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
  tokenId: uuidv7(),
  userId: USER_ID,
  orgId: ORG_ID,
  vaultUnlockedAt: new Date(),
};

const serviceTokenPrincipal = {
  kind: 'serviceToken' as const,
  tokenId: uuidv7(),
  orgId: ORG_ID,
  projectId: uuidv7(),
  environmentId: uuidv7(),
  accessLevel: 'read' as const,
};

const deferred: Promise<unknown>[] = [];
let written: AuditRecord[] = [];

/** A silent logger: these tests assert on responses and audit rows, not lines. */
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

function savedUser(displayName: string | null) {
  const now = new Date('2026-01-01T10:00:00.000Z');
  return {
    id: USER_ID,
    firebaseUid: 'firebase-uid',
    email: 'nitheesh@playxoft.com',
    emailVerified: true,
    displayName,
    avatarUrl: null,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: now,
    deletedAt: null,
  };
}

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
        method: 'PATCH',
        path: '/api/auth/account',
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

  repository.listOrganizationsForUser.mockResolvedValue([
    { organization: { id: ORG_ID, name: 'Acme', slug: 'acme' }, role: 'owner' },
  ]);
  repository.updateUserProfile.mockImplementation(
    async (_exec: unknown, _userId: string, patch: { displayName?: string | null }) =>
      savedUser(patch.displayName ?? null),
  );
});

function patchRequest(body: unknown): Request {
  return new Request('https://xecret.playxoft.com/api/auth/account', {
    method: 'PATCH',
    headers: { origin: 'https://xecret.playxoft.com', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function settle(): Promise<void> {
  await Promise.allSettled(deferred);
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('PATCH /api/auth/account — who may rename an account', () => {
  it.each([
    ['a CLI token', cliTokenPrincipal],
    ['a service token', serviceTokenPrincipal],
  ])('refuses %s, which is not a browser session', async (_label, principal) => {
    actor.authenticate.mockResolvedValue({ principal, source: 'bearer' });

    const response = await account.PATCH(patchRequest({ displayName: 'Mallory' }));

    expect(response.status).toBe(403);
    expect(repository.updateUserProfile).not.toHaveBeenCalled();
  });

  it('refuses a locked session, like every other mutation', async () => {
    // The route takes no `allowLocked`. A session that has idled out reads
    // nothing and changes nothing, and a name is not an exception to that.
    actor.isUnlocked.mockReturnValue(false);

    const response = await account.PATCH(patchRequest({ displayName: 'Nitheesh' }));

    expect(response.status).toBe(403);
    expect(repository.updateUserProfile).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/auth/account — what may be saved', () => {
  it('saves a trimmed name and answers with the whole profile', async () => {
    const response = await account.PATCH(patchRequest({ displayName: '  Nitheesh  ' }));

    expect(response.status).toBe(200);
    expect(repository.updateUserProfile).toHaveBeenCalledWith({}, USER_ID, {
      displayName: 'Nitheesh',
    });
    // The whole profile rather than the field that changed, so the client
    // adopts it exactly as it adopts `GET /api/auth/me`.
    expect(await body(response)).toEqual({
      user: {
        id: USER_ID,
        email: 'nitheesh@playxoft.com',
        emailVerified: true,
        displayName: 'Nitheesh',
        avatarUrl: null,
      },
    });
  });

  it('clears the name when the client sends null', async () => {
    // Clearing and leaving alone have to be different requests. `null` is the
    // one that means "go back to being identified by my email address".
    const response = await account.PATCH(patchRequest({ displayName: null }));

    expect(response.status).toBe(200);
    expect(repository.updateUserProfile).toHaveBeenCalledWith({}, USER_ID, { displayName: null });
  });

  it('refuses a blank name rather than storing an empty one', async () => {
    // `''` is neither of the two meanings: it is a name of no characters, and a
    // member list rendering it would show a row with nothing in it.
    const response = await account.PATCH(patchRequest({ displayName: '   ' }));

    expect(response.status).toBe(422);
    expect(repository.updateUserProfile).not.toHaveBeenCalled();
  });

  it('refuses a name past the ceiling', async () => {
    const response = await account.PATCH(
      patchRequest({ displayName: 'n'.repeat(DISPLAY_NAME_MAX_LENGTH + 1) }),
    );

    expect(response.status).toBe(422);
    expect(repository.updateUserProfile).not.toHaveBeenCalled();
  });

  it('refuses a patch that asks for nothing', async () => {
    const response = await account.PATCH(patchRequest({}));

    expect(response.status).toBe(422);
    expect(repository.updateUserProfile).not.toHaveBeenCalled();
  });

  it('refuses a field this endpoint does not own', async () => {
    // The email address and the verified flag are the identity provider's and
    // are re-mirrored on every sign-in. Accepting either here would be accepting
    // a change this system cannot keep.
    const response = await account.PATCH(
      patchRequest({ displayName: 'Nitheesh', email: 'someone@else.example' }),
    );

    expect(response.status).toBe(422);
    expect(repository.updateUserProfile).not.toHaveBeenCalled();
  });

  it('reports a soft-deleted account as gone rather than as a server fault', async () => {
    repository.updateUserProfile.mockRejectedValue(
      new RepositoryError('notFound', 'No active account.'),
    );

    const response = await account.PATCH(patchRequest({ displayName: 'Nitheesh' }));

    expect(response.status).toBe(404);
  });
});

describe('PATCH /api/auth/account — what is written to the log', () => {
  it('records the rename against the primary organisation', async () => {
    await account.PATCH(patchRequest({ displayName: 'Nitheesh' }));
    await settle();

    const record = written.find((entry) => entry.action === 'auth.profile_updated');

    expect(record).toBeDefined();
    expect(record?.orgId).toBe(ORG_ID);
    expect(record?.outcome).toBe('success');
    expect(record?.resourceId).toBe(USER_ID);
    // The new name, never the old one: a log is not editable, and the previous
    // name is the one somebody has just chosen to stop using.
    expect(record?.metadata?.reason).toContain('Nitheesh');
  });

  it('still saves the name for an account that belongs to no organisation', async () => {
    // Reachable once every membership has been revoked. `audit_logs.org_id` is
    // NOT NULL, so the act goes unrecorded rather than failing — the same
    // honest limitation the auto-lock and logout records carry.
    repository.listOrganizationsForUser.mockResolvedValue([]);

    const response = await account.PATCH(patchRequest({ displayName: 'Nitheesh' }));
    await settle();

    expect(response.status).toBe(200);
    expect(written.some((entry) => entry.action === 'auth.profile_updated')).toBe(false);
  });
});

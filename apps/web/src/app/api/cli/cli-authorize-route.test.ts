import { beforeEach, describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '@xecret/core/ids';
import type { RequestLog } from '@/server/logging';
import { createLogger } from '@/server/logging';

/**
 * `POST /api/cli/authorize`, invoked for real.
 *
 * This route is the whole of `xecret login`'s server side, and it had no test
 * at all. What that cost was a failure nobody could diagnose from the browser:
 * the body schema validated `orgSlug` with the *claim* rules, reserved list
 * included, so approving the CLI for an organisation whose slug happened to be
 * on that list failed with `validation_failed` — a 400 whose message is the
 * deliberately contentless "The request could not be processed." The consent
 * screen showed exactly that, about an organisation the user had picked from
 * their own switcher, with nothing anywhere naming the field or the reason.
 *
 * Everything below the handler is stubbed, following `orgs-routes.test.ts`. The
 * database is not simulated; what these tests prove is which gate is consulted
 * and what the caller is told.
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
  actorLabel: vi.fn(() => 'someone@example.com'),
}));

const repository = vi.hoisted(() => ({
  findOrganizationBySlug: vi.fn(),
  loadAuthorizationContext: vi.fn(),
  createCliAuthCode: vi.fn(),
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
vi.mock('@/server/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/rate-limit')>()),
  ...rateLimit,
}));

/** A silent logger: these tests assert on responses, not on lines. */
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

const route = await import('./authorize/route');

const USER_ID = uuidv7();
const ORG_ID = uuidv7();
const MEMBER_ID = uuidv7();

/** A real S256 challenge — RFC 7636's — so the shape is not invented here. */
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

const userPrincipal = {
  kind: 'user' as const,
  vaultUnlockedAt: new Date(),
  lastSeenAt: new Date(),
  vaultAutoLockMinutes: null,
  sessionId: uuidv7(),
  user: {
    id: USER_ID,
    email: 'someone@example.com',
    emailVerified: true,
    displayName: null,
    avatarUrl: null,
  },
};

const deferred: Promise<unknown>[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  deferred.length = 0;

  auditSink.write.mockResolvedValue(undefined);

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
        path: '/api/cli/authorize',
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

  repository.loadAuthorizationContext.mockResolvedValue({
    orgId: ORG_ID,
    userId: USER_ID,
    memberId: MEMBER_ID,
    role: 'owner',
    status: 'active',
    grants: [],
  });
  repository.createCliAuthCode.mockResolvedValue({
    id: uuidv7(),
    code: 'authorization-code',
    expiresAt: new Date('2026-01-01T10:05:00.000Z'),
  });
});

function organization(slug: string) {
  const now = new Date('2026-01-01T10:00:00.000Z');
  return {
    id: ORG_ID,
    name: 'An organisation',
    slug,
    seatLimit: 5,
    createdBy: USER_ID,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

function approve(orgSlug: string): Request {
  return new Request('https://xecret.playxoft.com/api/cli/authorize', {
    method: 'POST',
    headers: { origin: 'https://xecret.playxoft.com', 'content-type': 'application/json' },
    body: JSON.stringify({ orgSlug, deviceName: 'DESKTOP-AIPE88H', codeChallenge: CHALLENGE }),
  });
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('POST /api/cli/authorize — which organisation may be named', () => {
  /**
   * The regression. `playxoft` is on the reserved list — it is this
   * installation's own name — and the organisation holding that slug could not
   * be authorised for the CLI at all.
   */
  it('approves for an organisation whose slug is on the reserved list', async () => {
    repository.findOrganizationBySlug.mockResolvedValue(organization('playxoft'));

    const response = await route.POST(approve('playxoft'));

    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ code: 'authorization-code' });
    expect(repository.createCliAuthCode).toHaveBeenCalledTimes(1);
  });

  it('approves for an ordinary slug too', async () => {
    repository.findOrganizationBySlug.mockResolvedValue(organization('acme-corp'));

    expect((await route.POST(approve('acme-corp'))).status).toBe(200);
  });

  /**
   * Loosening the schema by one rule is not loosening the route. A slug that is
   * merely *shaped* like one still has to resolve to an organisation the caller
   * is a member of, and `resolveOrg` — not the schema — is what settles that.
   */
  it('still refuses a slug that resolves to nothing, without minting a code', async () => {
    repository.findOrganizationBySlug.mockResolvedValue(null);

    const response = await route.POST(approve('no-such-org'));

    expect(response.status).toBe(404);
    expect(repository.createCliAuthCode).not.toHaveBeenCalled();
  });

  // The shape rules are untouched: a reference is still bounded before it
  // reaches a query.
  it.each(['Playxoft', 'not a slug', '-acme', ''])('refuses %o as malformed', async (slug) => {
    const response = await route.POST(approve(slug));

    expect(response.status).toBe(422);
    // The problem names the field, which is what the consent screen now reads
    // instead of the contentless top-level message. See `errorMessage`.
    expect(await body(response)).toMatchObject({
      error: { code: 'validation_failed', fields: [{ field: 'orgSlug' }] },
    });
    expect(repository.findOrganizationBySlug).not.toHaveBeenCalled();
  });
});

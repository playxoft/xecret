import { beforeEach, describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '@xecret/core/ids';
import { DEFAULT_ENVIRONMENTS } from '@xecret/core/validation';
import { RepositoryError } from '@xecret/db/repositories';
import { createLogger } from './logging';
import type { RequestLog } from './logging';

/**
 * `POST /api/orgs/{orgSlug}/projects`, invoked for real.
 *
 * ── Why this file exists ──
 * Every environment created from migration 0013 onward is end-to-end encrypted,
 * and this route creates three of them. For a while it did not know that: it
 * called `createEnvironment` with a server-mode envelope and no key material, the
 * repository refused, and the refusal — a `RepositoryError`, which `toApiError`
 * does not recognise — reached the caller as a 500 reading "Something went
 * wrong." Every project anyone tried to create failed that way, and nothing in
 * the suite noticed, because the only tests that touched this route tested the
 * schema rather than the handler.
 *
 * So what is asserted here is the wiring a schema test cannot see: that the keys
 * the client generated are the keys the environments are created with, that the
 * set of them is checked before anything is written, and that a caller who
 * cannot produce them is told what to do instead of being handed a 500.
 *
 * ── What is stubbed, and what deliberately is not ──
 * Only the database, at the repository boundary. `tenancy.ts` runs for real, so
 * the authorization decision is the real `can()` reading a real role table, and
 * `assertSelfGrant` and the schemas are the ones the deployment runs.
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

const repositories = vi.hoisted(() => ({
  findOrganizationBySlug: vi.fn(),
  loadAuthorizationContext: vi.fn(),
  hasVault: vi.fn(),
  createProject: vi.fn(),
  createEnvironment: vi.fn(),
}));

const rateLimit = vi.hoisted(() => ({ enforce: vi.fn() }));

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
  ...rateLimit,
}));
vi.mock('@xecret/db/repositories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xecret/db/repositories')>()),
  ...repositories,
}));

const { POST: createProjectRoute } = await import('@/app/api/orgs/[orgSlug]/projects/route');

const ORG_ID = uuidv7();
const OWNER_USER_ID = uuidv7();
const OWNER_MEMBER_ID = uuidv7();
const OTHER_USER_ID = uuidv7();

const EPOCH = new Date('2026-01-01T00:00:00.000Z');

/**
 * Shape-valid cryptographic values.
 *
 * The server validates shape and never meaning — it holds no key with which it
 * could do otherwise — so a blob of the right prefix and the right length is
 * indistinguishable to it from one a browser really sealed. That is the point:
 * these tests are about which environment a grant is filed against, not about
 * whether it opens.
 */
const PUBLIC_KEY = 'A'.repeat(43);
const SEALED = `xk2.x25519.${'A'.repeat(123)}`;
const SIGNATURE = `xk2.ed25519.${'A'.repeat(86)}`;

function grant(recipientId: string = OWNER_USER_ID) {
  return {
    recipientKind: 'member' as const,
    recipientId,
    recipientPublicKey: PUBLIC_KEY,
    edkSealed: SEALED,
    ehkSealed: SEALED,
    signature: SIGNATURE,
  };
}

interface EnvironmentInit {
  // `string`, not the literal union `DEFAULT_ENVIRONMENTS` infers: half of these
  // tests exist to send a slug that is *not* one of the defaults.
  slug: string;
  id: string;
  keys: { grant: ReturnType<typeof grant> };
}

/** The three entries a browser with an unlocked vault sends. */
function environmentInits(): EnvironmentInit[] {
  return DEFAULT_ENVIRONMENTS.map((environment) => ({
    slug: environment.slug,
    id: uuidv7(),
    keys: { grant: grant() },
  }));
}

function principalFor(userId: string) {
  return {
    kind: 'user' as const,
    vaultUnlockedAt: new Date(),
    lastSeenAt: new Date(),
    vaultAutoLockMinutes: null,
    sessionId: uuidv7(),
    user: {
      id: userId,
      email: 'owner@playxoft.com',
      emailVerified: true,
      displayName: null,
      avatarUrl: null,
    },
  };
}

/** A credential minted for a machine: no vault, so nothing to seal with. */
const cliTokenPrincipal = {
  kind: 'cliToken' as const,
  tokenId: uuidv7(),
  userId: OWNER_USER_ID,
  orgId: ORG_ID,
  vaultUnlockedAt: new Date(),
};

const deferred: Promise<unknown>[] = [];
const runtimeDeferred: Promise<unknown>[] = [];

function silentLog(base: Record<string, unknown> = {}): RequestLog {
  return createLogger({
    sink: { write: () => {}, flush: () => Promise.resolve() },
    minimum: 'error',
    base,
  });
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
      // `transaction` runs its callback against the same handle: the repository
      // functions are stubbed, so there is nothing for a real transaction to
      // wrap, and the sequencing this route depends on is in the callback.
      db: { transaction: (run: (tx: unknown) => unknown) => run({}) },
      envelope: {},
      meta: {
        requestId,
        rayId: null,
        ipAddress: '203.0.113.5',
        userAgent: 'vitest',
        method: 'POST',
        path: '/api/orgs/acme/projects',
        startedAt,
      },
      log: log.logger,
      bindLog: log.bind,
      waitUntil: (promise: Promise<unknown>) => void deferred.push(promise),
      settled: () => Promise.allSettled(deferred),
      dispose: () => {},
    }),
  );

  actor.authenticate.mockResolvedValue({
    principal: principalFor(OWNER_USER_ID),
    source: 'cookie',
  });
  actor.assertCsrf.mockReturnValue(undefined);
  actor.isUnlocked.mockReturnValue(true);
  actor.actorId.mockReturnValue(OWNER_USER_ID);

  rateLimit.enforce.mockResolvedValue({ allowed: true, enforced: true });

  repositories.findOrganizationBySlug.mockResolvedValue({
    id: ORG_ID,
    name: 'Acme',
    slug: 'acme',
    seatLimit: 5,
    createdBy: OWNER_USER_ID,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    deletedAt: null,
  });

  repositories.loadAuthorizationContext.mockResolvedValue({
    orgId: ORG_ID,
    userId: OWNER_USER_ID,
    memberId: OWNER_MEMBER_ID,
    role: 'owner',
    status: 'active',
    grants: [],
  });

  repositories.hasVault.mockResolvedValue(true);

  repositories.createProject.mockImplementation(
    async (_tx: unknown, params: { orgId: string; name: string; slug: string }) => ({
      id: uuidv7(),
      orgId: params.orgId,
      name: params.name,
      slug: params.slug,
      description: null,
      createdBy: OWNER_USER_ID,
      createdAt: EPOCH,
      updatedAt: EPOCH,
      deletedAt: null,
    }),
  );

  repositories.createEnvironment.mockImplementation(
    async (
      _tx: unknown,
      params: {
        id: string;
        projectId: string;
        name: string;
        slug: string;
        isProduction?: boolean;
        sortOrder?: number;
      },
    ) => ({
      id: params.id,
      projectId: params.projectId,
      name: params.name,
      slug: params.slug,
      isProduction: params.isProduction ?? false,
      encryptionMode: 'e2ee',
      sortOrder: params.sortOrder ?? 0,
      createdAt: EPOCH,
      updatedAt: EPOCH,
      deletedAt: null,
    }),
  );
});

function request(body: unknown): Request {
  return new Request('https://xecret.playxoft.com/api/orgs/acme/projects', {
    method: 'POST',
    headers: { origin: 'https://xecret.playxoft.com', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Next.js hands dynamic segments in as a promise; the wrapper awaits it. */
function params() {
  return { params: Promise.resolve({ orgSlug: 'acme' }) };
}

async function post(body: unknown): Promise<Response> {
  return createProjectRoute(request(body), params());
}

/** The `error` envelope every refusal is wrapped in — see `ApiError.toBody`. */
async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  const payload = (await response.json()) as { error: Record<string, unknown> };
  return payload.error;
}

describe('POST …/projects — the keys the environments are created with', () => {
  it('creates each default environment under the id its grant was sealed against', async () => {
    const environments = environmentInits();

    const response = await post({ name: 'Payments API', slug: 'payments', environments });

    expect(response.status).toBe(201);
    expect(repositories.createEnvironment).toHaveBeenCalledTimes(DEFAULT_ENVIRONMENTS.length);

    for (const [index, expected] of DEFAULT_ENVIRONMENTS.entries()) {
      const supplied = environments.find((entry) => entry.slug === expected.slug);
      const [, passed] = repositories.createEnvironment.mock.calls[index] as [
        unknown,
        Record<string, unknown>,
      ];

      expect(passed['slug']).toBe(expected.slug);
      // The id is the client's, never a fresh one. A row written under any other
      // id holds a grant nobody can ever open, and there is no repair.
      expect(passed['id']).toBe(supplied?.id);
      expect(passed['encryptionMode']).toBe('e2ee');
      expect(passed['keyInit']).toMatchObject({ createdBy: OWNER_USER_ID });
      // The name and the production flag come from `DEFAULT_ENVIRONMENTS`, not
      // from the request: the client names which default it is sending keys for
      // and nothing else.
      expect(passed['name']).toBe(expected.name);
      expect(passed['isProduction']).toBe(expected.isProduction);
    }
  });

  it('never falls back to a server-held envelope', async () => {
    await post({ name: 'Payments API', environments: environmentInits() });

    for (const [, passed] of repositories.createEnvironment.mock.calls as [
      unknown,
      Record<string, unknown>,
    ][]) {
      expect(passed['envelope']).toBeUndefined();
    }
  });
});

describe('POST …/projects — callers that cannot seal', () => {
  /**
   * The regression this whole change is about. Before it, a body with no keys
   * reached `createEnvironment`, which refused it as a `RepositoryError` —
   * unrecognised by `toApiError`, and therefore a 500 reading "Something went
   * wrong." for every project anybody tried to create.
   */
  it('answers 400 with an explanation, not 500, when no keys are supplied', async () => {
    const response = await post({ name: 'Payments API' });

    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toMatchObject({
      message: expect.stringContaining('unlocked browser session'),
    });
    // Refused before anything was written.
    expect(repositories.createProject).not.toHaveBeenCalled();
    expect(repositories.createEnvironment).not.toHaveBeenCalled();
  });

  it('refuses a CLI token, which has no vault to seal with', async () => {
    actor.authenticate.mockResolvedValue({ principal: cliTokenPrincipal, source: 'bearer' });

    const response = await post({ name: 'Payments API', environments: environmentInits() });

    expect(response.status).toBe(403);
    expect(repositories.createProject).not.toHaveBeenCalled();
  });

  it('refuses a caller who has not set up a vault', async () => {
    repositories.hasVault.mockResolvedValue(false);

    const response = await post({ name: 'Payments API', environments: environmentInits() });

    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toMatchObject({
      message: expect.stringContaining('Set up your vault'),
    });
    expect(repositories.createProject).not.toHaveBeenCalled();
  });
});

describe('POST …/projects — the set of environments is exactly the defaults', () => {
  it('names the environment whose keys are missing', async () => {
    const environments = environmentInits().filter((entry) => entry.slug !== 'production');

    const response = await post({ name: 'Payments API', environments });

    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toMatchObject({
      message: expect.stringContaining('production'),
    });
    expect(repositories.createProject).not.toHaveBeenCalled();
  });

  it('refuses an environment the route does not create', async () => {
    const environments = environmentInits();
    environments[0] = { ...environments[0]!, slug: 'canary' };

    const response = await post({ name: 'Payments API', environments });

    expect(response.status).toBe(400);
    expect(repositories.createProject).not.toHaveBeenCalled();
  });

  it('refuses two sets of keys for one environment', async () => {
    const environments = environmentInits();
    // Two entries for `production`, which would silently drop one grant — and
    // which one depends on iteration order.
    environments[0] = { ...environments[0]!, slug: 'production' };

    const response = await post({ name: 'Payments API', environments });

    expect(response.status).toBe(400);
    expect(repositories.createProject).not.toHaveBeenCalled();
  });

  /**
   * 422 rather than the 400 its siblings answer, and the difference is where the
   * refusal happens: this one is the schema's length bound, which stops an
   * unbounded number of sealings being ordered inside one transaction before the
   * body is ever a typed value. The exact-set check that produces the 400s above
   * runs afterwards, in the handler, where it can name which environment is
   * wrong.
   */
  it('refuses more entries than a project has environments', async () => {
    const environments = [
      ...environmentInits(),
      { slug: 'canary', id: uuidv7(), keys: { grant: grant() } },
    ];

    const response = await post({ name: 'Payments API', environments });

    expect(response.status).toBe(422);
    expect(repositories.createProject).not.toHaveBeenCalled();
  });
});

describe('POST …/projects — whose key the grant is sealed to', () => {
  /**
   * `grantSchema` takes a `recipientKind` and a uuid, and the foreign keys check
   * that the row exists, not that it belongs to this tenant. At creation there is
   * exactly one public key the caller could honestly have sealed to.
   */
  it('refuses a first grant addressed to somebody other than the creator', async () => {
    const environments = environmentInits();
    environments[1] = { ...environments[1]!, keys: { grant: grant(OTHER_USER_ID) } };

    const response = await post({ name: 'Payments API', environments });

    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toMatchObject({
      message: expect.stringContaining("creator's own"),
    });
    expect(repositories.createProject).not.toHaveBeenCalled();
  });
});

describe('POST …/projects — what the repository refuses', () => {
  it('reports a slug conflict as 409, naming the slug', async () => {
    repositories.createProject.mockRejectedValue(
      new RepositoryError('conflict', 'A project with slug "payments" already exists'),
    );

    const response = await post({
      name: 'Payments API',
      slug: 'payments',
      environments: environmentInits(),
    });

    expect(response.status).toBe(409);
    expect(await bodyOf(response)).toMatchObject({
      message: expect.stringContaining('payments'),
    });
  });

  /**
   * The mapping whose absence turned the original bug into a 500. An `invalid`
   * from the repository is a statement about the request, and it must reach the
   * caller as one.
   */
  it('reports invalid key material as 400, not 500', async () => {
    repositories.createEnvironment.mockRejectedValue(
      new RepositoryError(
        'invalid',
        'An end-to-end encrypted environment must be created with its client-generated keys.',
      ),
    );

    const response = await post({ name: 'Payments API', environments: environmentInits() });

    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toMatchObject({
      message: expect.stringContaining('client-generated keys'),
    });
  });
});

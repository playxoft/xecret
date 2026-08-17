import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditRecord } from '@xecret/core/audit';
import { uuidv7 } from '@xecret/core/ids';
import type { RequestLog } from '@/server/logging';
import { createLogger } from '@/server/logging';
import { ORGANIZATIONS_PER_ACCOUNT_LIMIT } from '@/server/schemas/resources';

/**
 * The organisation routes, invoked for real.
 *
 * `routes.test.ts` covers everything a request is judged by *before* it reaches
 * a handler — the schemas, the slug derivation, the response shapes. This file
 * covers the three gates that live in the handlers themselves and are therefore
 * invisible to a schema test:
 *
 *  - **who may create an organisation, and how many.** The cap is the only thing
 *    standing between one account and an unbounded number of Org Master Keys,
 *    and an unbounded number of slugs claimed out of a namespace every tenant
 *    shares — permanently, because `organizations_slug_unique` is total.
 *  - **who may ask whether a slug is free.** `/api/orgs/availability` is the one
 *    endpoint in the product that answers a question about a resource the caller
 *    has no membership in, and it used to answer it for a CLI token.
 *  - **that the refusals are written to the audit log**, not merely returned.
 *
 * Everything below the handler is stubbed, following `route.test.ts`: the
 * Cloudflare context, authentication, the audit sink and the repository. The
 * database is not simulated — the repository functions are replaced outright, so
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
  countOrganizationsCreatedBy: vi.fn(),
  provisionOrganization: vi.fn(),
  isOrgSlugAvailable: vi.fn(),
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

/**
 * Only the four functions these routes call are replaced.
 *
 * Spreading the original keeps `RepositoryError`, `DEFAULT_PAGE_SIZE` and the
 * rest real — `schemas/resources.ts` reads them at import time, and a wholesale
 * mock would hand it `undefined` and fail somewhere with nothing to do with
 * what is under test.
 */
vi.mock('@xecret/db/repositories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xecret/db/repositories')>()),
  ...repository,
}));

/**
 * The limiter is stubbed to allow, so a test that expects a 409 cannot pass by
 * accidentally being rate-limited instead. That it is consulted *first* is
 * asserted directly.
 */
vi.mock('@/server/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/rate-limit')>()),
  ...rateLimit,
}));

const orgs = await import('./route');
const availability = await import('./availability/route');

const USER_ID = uuidv7();
const ORG_ID = uuidv7();

const userPrincipal = {
  kind: 'user' as const,
  pinVerifiedAt: new Date(),
  sessionId: uuidv7(),
  user: {
    id: USER_ID,
    email: 'nitheesh@playxoft.com',
    emailVerified: true,
    displayName: null,
    avatarUrl: null,
  },
};

/** A credential minted for a machine: `xecret run` on a developer's laptop. */
const cliTokenPrincipal = {
  kind: 'cliToken' as const,
  tokenId: uuidv7(),
  userId: USER_ID,
  orgId: ORG_ID,
  pinVerifiedAt: new Date(),
};

/** A credential left on a build machine, scoped to one environment. */
const serviceTokenPrincipal = {
  kind: 'serviceToken' as const,
  tokenId: uuidv7(),
  orgId: ORG_ID,
  projectId: uuidv7(),
  environmentId: uuidv7(),
  accessLevel: 'read' as const,
};

const deferred: Promise<unknown>[] = [];

/** Everything the request queued for the audit sink, once the flush has run. */
let written: AuditRecord[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  deferred.length = 0;
  written = [];

  auditSink.write.mockImplementation((batch: AuditRecord[]) => {
    written.push(...batch);
    return Promise.resolve();
  });

  context.workerContext.mockResolvedValue({
    env: {},
    ctx: { waitUntil: () => {} },
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
        method: 'POST',
        path: '/api/orgs',
        startedAt,
      },
      log: log.logger,
      bindLog: log.bind,
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

  repository.countOrganizationsCreatedBy.mockResolvedValue({ total: 0, latestId: null });
  repository.isOrgSlugAvailable.mockResolvedValue(true);
  repository.listOrganizationsForUser.mockResolvedValue([]);
  repository.provisionOrganization.mockImplementation(async () => provisioned());
});

/** A silent logger: these tests assert on responses and audit rows, not on lines. */
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

function provisioned() {
  const now = new Date('2026-01-01T10:00:00.000Z');
  return {
    organization: {
      id: uuidv7(),
      name: 'Acme',
      slug: 'acme',
      seatLimit: 5,
      createdBy: USER_ID,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    membership: { role: 'owner' },
    project: {},
    environments: [],
  };
}

function createRequest(body: unknown = { name: 'Acme', slug: 'acme' }): Request {
  return new Request('https://xecret.playxoft.com/api/orgs', {
    method: 'POST',
    headers: { origin: 'https://xecret.playxoft.com', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function availabilityRequest(slug: string): Request {
  return new Request(
    `https://xecret.playxoft.com/api/orgs/availability?slug=${encodeURIComponent(slug)}`,
  );
}

/** Runs the audit flush the wrapper queued after the response. */
async function settle(): Promise<void> {
  await Promise.allSettled(deferred);
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('POST /api/orgs — who may create one', () => {
  /**
   * The same rule `DELETE /api/auth/account` and `DELETE /api/orgs/{slug}`
   * state: a CLI token acts as its user for secrets, not for existence. Minting
   * an Org Master Key from a credential on a build machine is not something the
   * product needs, and not something a leaked one should be able to do.
   */
  it.each([
    ['a CLI token', cliTokenPrincipal],
    ['a service token', serviceTokenPrincipal],
  ])('refuses %s, which is not a browser session', async (_label, principal) => {
    actor.authenticate.mockResolvedValue({ principal, source: 'bearer' });

    const response = await orgs.POST(createRequest());

    expect(response.status).toBe(403);
    // Refused before anything was counted, provisioned, or spent.
    expect(repository.countOrganizationsCreatedBy).not.toHaveBeenCalled();
    expect(repository.provisionOrganization).not.toHaveBeenCalled();
  });
});

describe('POST /api/orgs — how many an account may hold', () => {
  it('creates one while the account is below its limit', async () => {
    repository.countOrganizationsCreatedBy.mockResolvedValue({
      total: ORGANIZATIONS_PER_ACCOUNT_LIMIT - 1,
      latestId: ORG_ID,
    });

    const response = await orgs.POST(createRequest());

    expect(response.status).toBe(201);
    expect(repository.provisionOrganization).toHaveBeenCalledTimes(1);
  });

  /**
   * The refusal that bounds the standing cost. A rate limit bounds how fast this
   * endpoint can be called; only this bounds how many organisations — and how
   * many permanently claimed slugs — one account can accumulate by calling it
   * patiently.
   */
  it('refuses at the limit, before the transaction that would derive the keys', async () => {
    repository.countOrganizationsCreatedBy.mockResolvedValue({
      total: ORGANIZATIONS_PER_ACCOUNT_LIMIT,
      latestId: ORG_ID,
    });

    const response = await orgs.POST(createRequest());

    expect(response.status).toBe(409);
    expect(repository.provisionOrganization).not.toHaveBeenCalled();
  });

  // Counting past the limit costs a wider scan and answers a question nobody
  // asked. The route must ask only what it can act on.
  it('asks the repository for no more rows than the limit it is checking', async () => {
    await orgs.POST(createRequest());

    expect(repository.countOrganizationsCreatedBy).toHaveBeenCalledWith(
      expect.anything(),
      USER_ID,
      ORGANIZATIONS_PER_ACCOUNT_LIMIT,
    );
  });

  // The rate limiter is the cheaper gate and guards the count query itself, so
  // it has to run first — otherwise a caller who is being limited can still make
  // the database answer.
  it('spends the rate limit before it queries', async () => {
    const order: string[] = [];
    rateLimit.enforce.mockImplementation(async () => {
      order.push('rate-limit');
      return { allowed: true, enforced: true };
    });
    repository.countOrganizationsCreatedBy.mockImplementation(async () => {
      order.push('count');
      return { total: 0, latestId: null };
    });

    await orgs.POST(createRequest());

    expect(order).toEqual(['rate-limit', 'count']);
  });

  /**
   * A refusal nobody can see is a refusal nobody can alert on. One person
   * clicking Create twice looks nothing like a script working through a word
   * list, and only the audit log can tell them apart.
   */
  it('records the refusal, against an organisation the account actually created', async () => {
    repository.countOrganizationsCreatedBy.mockResolvedValue({
      total: ORGANIZATIONS_PER_ACCOUNT_LIMIT,
      latestId: ORG_ID,
    });

    await orgs.POST(createRequest());
    await settle();

    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      action: 'org.created',
      outcome: 'error',
      orgId: ORG_ID,
      // No id: the organisation this request was about was never created.
      resourceType: 'org',
      resourceId: null,
      metadata: { reason: 'quotaExceeded' },
    });
  });

  // The message is a rule, not an echo. Nothing the caller sent comes back.
  it('states the limit without repeating the request back', async () => {
    repository.countOrganizationsCreatedBy.mockResolvedValue({
      total: ORGANIZATIONS_PER_ACCOUNT_LIMIT,
      latestId: ORG_ID,
    });

    const payload = await body(await orgs.POST(createRequest({ name: 'Acme', slug: 'acme' })));
    const error = payload['error'] as { code: string; message: string };

    expect(error.code).toBe('conflict');
    expect(error.message).toContain(String(ORGANIZATIONS_PER_ACCOUNT_LIMIT));
    expect(JSON.stringify(payload)).not.toContain('acme');
  });
});

describe('GET /api/orgs/availability — who may ask', () => {
  /**
   * The regression this test exists for.
   *
   * The endpoint refused only service tokens, on the stated grounds that being
   * "authenticated and rate-limited" made it something other than a namespace
   * scraper. A CLI token from a CI runner is authenticated, so a leaked one
   * could walk the global organisation namespace one 400-millisecond debounce at
   * a time — which is the enumeration the endpoint's own header argues cannot
   * happen. Its sibling routes already required a browser session; this one now
   * does too.
   */
  it.each([
    ['a CLI token', cliTokenPrincipal],
    ['a service token', serviceTokenPrincipal],
  ])('refuses %s, so a leaked credential cannot enumerate the namespace', async (_l, principal) => {
    actor.authenticate.mockResolvedValue({ principal, source: 'bearer' });

    const response = await availability.GET(availabilityRequest('acme'));

    expect(response.status).toBe(403);
    // Refused before the lookup: no query, and no bucket spent on a caller that
    // was never going to get an answer.
    expect(repository.isOrgSlugAvailable).not.toHaveBeenCalled();
  });

  it('answers a browser session', async () => {
    const payload = await body(await availability.GET(availabilityRequest('acme')));

    expect(payload).toEqual({ slug: 'acme', available: true });
  });
});

describe('GET /api/orgs/availability — the rules it applies', () => {
  /**
   * The categories come from `checkSlug`, the same function
   * `organizationSlugSchema` is built from — so this endpoint cannot report a
   * slug as available that `POST /api/orgs` is about to reject with a 422. It
   * kept its own copy of the rules until a review pointed out that adding a rule
   * to the schema would silently split the two apart.
   */
  it.each([
    ['acme corp', 'invalid'],
    ['acme_corp', 'invalid'],
    ['acme-', 'invalid'],
    ['-acme', 'invalid'],
    ['acme--corp', 'invalid'],
    ['settings', 'reserved'],
    ['availability', 'reserved'],
  ])('reports %s as %s without asking the database', async (slug, reason) => {
    const payload = await body(await availability.GET(availabilityRequest(slug)));

    expect(payload).toMatchObject({ available: false, reason });
    expect(repository.isOrgSlugAvailable).not.toHaveBeenCalled();
  });

  // Case is normalised rather than refused, exactly as the create form does it:
  // somebody who types "ACME" is asking about `acme`, and telling them their
  // slug is invalid would be answering a question they did not ask.
  it('lowercases before deciding, and reports the slug it actually checked', async () => {
    const payload = await body(await availability.GET(availabilityRequest('ACME')));

    expect(payload).toEqual({ slug: 'acme', available: true });
  });

  // The ceiling is refused by the query schema rather than reported as a
  // category, because a slug longer than the field accepts is a malformed
  // request rather than a name somebody might still choose.
  it('rejects a slug past the organisation ceiling as a bad request', async () => {
    const response = await availability.GET(availabilityRequest('a'.repeat(26)));

    expect(response.status).toBe(422);
    expect(repository.isOrgSlugAvailable).not.toHaveBeenCalled();
  });

  it('reports a well-formed slug somebody already holds as taken', async () => {
    repository.isOrgSlugAvailable.mockResolvedValue(false);

    const payload = await body(await availability.GET(availabilityRequest('acme')));

    expect(payload).toMatchObject({ slug: 'acme', available: false, reason: 'taken' });
  });

  // The answer is one bit and a category. Never who holds it, or when.
  it('says nothing beyond the slug, the bit, and the reason', async () => {
    repository.isOrgSlugAvailable.mockResolvedValue(false);

    const payload = await body(await availability.GET(availabilityRequest('acme')));

    expect(Object.keys(payload).sort()).toEqual(['available', 'reason', 'slug']);
  });
});

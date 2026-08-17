import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditRecord } from '@xecret/core/audit';
import { uuidv7 } from '@xecret/core/ids';
import { RepositoryError } from '@xecret/db/repositories';
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
  countOrganizationsHeldBy: vi.fn(),
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

  repository.countOrganizationsHeldBy.mockResolvedValue({ total: 0, latestId: null });
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
    expect(repository.countOrganizationsHeldBy).not.toHaveBeenCalled();
    expect(repository.provisionOrganization).not.toHaveBeenCalled();
  });
});

/** The refusal `provisionOrganization` raises from inside its transaction. */
function atTheLimit(): void {
  repository.provisionOrganization.mockRejectedValue(
    new RepositoryError(
      'quotaExceeded',
      `An account can hold at most ${ORGANIZATIONS_PER_ACCOUNT_LIMIT} organisations.`,
    ),
  );
}

describe('POST /api/orgs — how many an account may hold', () => {
  it('creates one while the account is below its limit', async () => {
    const response = await orgs.POST(createRequest());

    expect(response.status).toBe(201);
    expect(repository.provisionOrganization).toHaveBeenCalledTimes(1);
  });

  /**
   * The ceiling is applied where it can actually hold.
   *
   * It used to be counted here, one statement before `provisionOrganization`,
   * with the whole transaction in between — check-then-act with no row lock and
   * no constraint underneath it, so every concurrent request that read nine
   * passed. The rate limiter does not bound the overshoot either: Cloudflare's
   * counters are per-colo, and `consume` fails open when the binding is absent,
   * which is the documented state of a local or self-hosted deployment. The
   * route now names the number and the transaction imposes it.
   */
  it('hands the ceiling to the transaction rather than checking it beforehand', async () => {
    await orgs.POST(createRequest());

    expect(repository.provisionOrganization).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: ORGANIZATIONS_PER_ACCOUNT_LIMIT }),
    );
    // Nothing counted outside the transaction on the way in: a second count out
    // here would be a second, weaker copy of the ceiling.
    expect(repository.countOrganizationsHeldBy).not.toHaveBeenCalled();
  });

  /**
   * The refusal that bounds the standing cost. A rate limit bounds how fast this
   * endpoint can be called; only this bounds how many organisations — and how
   * many permanently claimed slugs — one account can accumulate by calling it
   * patiently.
   *
   * 409 rather than the 422 a `conflict` from the same call would produce: the
   * two are told apart by the repository's code, because a slug somebody else
   * holds is fixed by renaming and this one is not.
   */
  it('answers the transaction refusal with a conflict', async () => {
    atTheLimit();

    const response = await orgs.POST(createRequest());

    expect(response.status).toBe(409);
  });

  // The rate limiter is the cheaper gate and guards the transaction itself, so
  // it has to run first — otherwise a caller who is being limited can still make
  // the database open one.
  it('spends the rate limit before it provisions', async () => {
    const order: string[] = [];
    rateLimit.enforce.mockImplementation(async () => {
      order.push('rate-limit');
      return { allowed: true, enforced: true };
    });
    repository.provisionOrganization.mockImplementation(async () => {
      order.push('provision');
      return provisioned();
    });

    await orgs.POST(createRequest());

    expect(order).toEqual(['rate-limit', 'provision']);
  });

  /**
   * A refusal nobody can see is a refusal nobody can alert on. One person
   * clicking Create twice looks nothing like a script working through a word
   * list, and only the audit log can tell them apart.
   */
  it('records the refusal, against an organisation the account is a member of', async () => {
    atTheLimit();
    repository.countOrganizationsHeldBy.mockResolvedValue({ total: 1, latestId: ORG_ID });

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

  /**
   * The record carries the actor's email address, IP and user agent, and an
   * organisation's audit log is readable by its members. So the anchor has to be
   * an organisation this account is *in*, which is what the membership join in
   * `countOrganizationsHeldBy` guarantees — filing it against the most recent
   * organisation the account had merely *created* put a stranger's current
   * contact details and network position in front of a tenant they had been
   * removed from.
   */
  it('reads the anchor from the membership-scoped count, and asks for one row', async () => {
    atTheLimit();
    repository.countOrganizationsHeldBy.mockResolvedValue({ total: 1, latestId: ORG_ID });

    await orgs.POST(createRequest());

    expect(repository.countOrganizationsHeldBy).toHaveBeenCalledWith(expect.anything(), USER_ID, 1);
  });

  /**
   * An account-scoped refusal and an organisation-scoped audit log do not fit,
   * and `audit_logs.org_id` is NOT NULL. With nowhere truthful to file it,
   * nothing is filed — the same answer `POST /api/auth/pin/reset` gives a user
   * who belongs to no organisation. The caller is still refused.
   */
  it('records nothing when the account is in no organisation at all', async () => {
    atTheLimit();
    repository.countOrganizationsHeldBy.mockResolvedValue({ total: 0, latestId: null });

    const response = await orgs.POST(createRequest());
    await settle();

    expect(response.status).toBe(409);
    expect(written).toHaveLength(0);
  });

  // The message is a rule, not an echo. Nothing the caller sent comes back.
  it('states the limit without repeating the request back', async () => {
    atTheLimit();
    repository.countOrganizationsHeldBy.mockResolvedValue({ total: 1, latestId: ORG_ID });

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

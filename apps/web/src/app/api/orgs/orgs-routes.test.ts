import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditRecord } from '@xecret/core/audit';
import { uuidv7 } from '@xecret/core/ids';
import { QuotaExceededError } from '@xecret/db/repositories';
import type { RequestLog } from '@/server/logging';
import { createLogger } from '@/server/logging';
import { ORGANIZATIONS_PER_ACCOUNT_LIMIT } from '@/server/schemas/resources';

/**
 * The organisation routes, invoked for real.
 *
 * `routes.test.ts` covers everything a request is judged by *before* it reaches
 * a handler — the schemas, the slug derivation, the response shapes. This file
 * covers the gates that live in the handlers themselves and are therefore
 * invisible to a schema test:
 *
 *  - **who may create an organisation, and how many.** The cap is the only thing
 *    standing between one account and an unbounded number of Org Master Keys.
 *  - **what creating one takes.** A name, and nothing else: the slug is the
 *    server's, derived from the new id, and one a client sends is ignored.
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

/** A credential minted for a machine: `xecret run` on a developer's laptop. */
const cliTokenPrincipal = {
  kind: 'cliToken' as const,
  tokenId: uuidv7(),
  userId: USER_ID,
  orgId: ORG_ID,
  vaultUnlockedAt: new Date(),
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
      seatLimit: 3,
      createdBy: USER_ID,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    membership: { role: 'owner' },
  };
}

function createRequest(body: unknown = { name: 'Acme' }): Request {
  return new Request('https://xecret.playxoft.com/api/orgs', {
    method: 'POST',
    headers: { origin: 'https://xecret.playxoft.com', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
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

/**
 * The refusal `provisionOrganization` raises from inside its transaction.
 *
 * It carries the ceiling, because the ceiling is no longer a constant: the
 * transaction computes `min(abuse cap, plan ceiling)` from the plans of the
 * organisations the account already holds, and on Free that is one. The route
 * has no way to know the number except from this error.
 */
function atTheLimit(ceiling: number = ORGANIZATIONS_PER_ACCOUNT_LIMIT): void {
  repository.provisionOrganization.mockRejectedValue(
    new QuotaExceededError(`An account can hold at most ${ceiling} organisations.`, ceiling),
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
   * nothing is filed — the same answer `POST /api/auth/vault/lock` gives a user
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

  /**
   * The regression: the route threw a message built from the abuse cap while the
   * transaction had refused at the plan ceiling. A Free account holding exactly
   * one organisation was told it could hold ten — a sentence that is false, and
   * that describes no rule the system is following.
   */
  it('states the ceiling the transaction applied, not the abuse cap', async () => {
    atTheLimit(1);
    repository.countOrganizationsHeldBy.mockResolvedValue({ total: 1, latestId: ORG_ID });

    const payload = await body(await orgs.POST(createRequest({ name: 'Acme', slug: 'acme' })));
    const error = payload['error'] as { code: string; message: string };

    expect(error.code).toBe('conflict');
    expect(error.message).not.toContain(String(ORGANIZATIONS_PER_ACCOUNT_LIMIT));
    expect(error.message).toContain('one organisation');
  });
});

describe('POST /api/orgs — a name, and nothing else', () => {
  it('provisions with the name alone, and leaves the slug to the server', async () => {
    await orgs.POST(createRequest({ name: 'Acme' }));

    const params = repository.provisionOrganization.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params['name']).toBe('Acme');
    expect(Object.keys(params)).not.toContain('slug');
    expect(Object.keys(params)).not.toContain('slugSeed');
  });

  /**
   * A tab still running the form from before sends the slug it showed. That is
   * somebody creating an organisation, so it succeeds, and what they sent is
   * never read: the slug is derived from the new id.
   */
  it('accepts a slug from an older form and never passes it on', async () => {
    const response = await orgs.POST(createRequest({ name: 'Acme', slug: 'acme' }));

    expect(response.status).toBe(201);
    const params = repository.provisionOrganization.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(JSON.stringify(params)).not.toContain('"acme"');
  });

  it('allows a name another organisation already has, or one no slug could be made from', async () => {
    for (const name of ['Acme', 'Acme', 'settings', '株式会社']) {
      const response = await orgs.POST(createRequest({ name }));
      expect(response.status, name).toBe(201);
    }
  });

  it('answers with the id the organisation is addressed by', async () => {
    const payload = await body(await orgs.POST(createRequest({ name: 'Acme' })));
    const organization = payload['organization'] as Record<string, unknown>;

    expect(typeof organization['id']).toBe('string');
    expect(organization['name']).toBe('Acme');
  });

  // A derived slug cannot collide in practice; if one ever does, there is no
  // field the person could change, so it is a conflict to retry, not a field
  // error pointing at an input that no longer exists.
  it('answers a slug collision with a plain conflict, never a slug field error', async () => {
    const { RepositoryError } = await import('@xecret/db/repositories');
    repository.provisionOrganization.mockRejectedValue(
      new RepositoryError('conflict', 'The organisation could not be created. Try again.'),
    );

    const response = await orgs.POST(createRequest({ name: 'Acme' }));
    const payload = await body(response);

    expect(response.status).toBe(409);
    expect(JSON.stringify(payload)).not.toContain('"slug"');
  });
});

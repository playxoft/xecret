import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthorizationError } from '@xecret/core/authz';
import { InMemoryAuditSink, createAuditBuilder } from '@xecret/core/audit';
import { uuidv7 } from '@xecret/core/ids';

/**
 * Tests for the route wrapper — the single error boundary between handler code
 * and the network.
 *
 * Everything below the wrapper is stubbed: the Cloudflare context, the database,
 * and authentication. That is the point. What is being verified is the wrapper's
 * own guarantees, and each one is a thing that would otherwise have to be
 * remembered in every handler:
 *
 *  - a thrown driver error becomes a fixed 500 with no detail on the wire
 *  - an authorization denial becomes 404 or 403 according to the decision
 *  - a missing binding becomes 503, not 500
 *  - audit records queued before a failure are still flushed
 *  - a failed audit flush never turns into a failed response
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

vi.mock('./context', () => context);
vi.mock('./actor', () => actor);
vi.mock('./audit-sink', () => ({
  DatabaseAuditSink: class {
    write = auditSink.write;
  },
}));

const { authenticatedRoute, publicRoute } = await import('./route');
const { MissingBindingError } = await import('./bindings');
const { errors } = await import('./errors');

const ORG_ID = uuidv7();

/** The wrapper prefers a Cloudflare ray id, so requests carry one. */
const RAY_ID = 'ray-abc123';

const deferred: Promise<unknown>[] = [];

const principal = {
  kind: 'user' as const,
  // Unlocked. The lock gate lives in `authenticatedRoute`, and these fixtures
  // exercise what happens *past* it.
  pinVerifiedAt: new Date(),
  sessionId: uuidv7(),
  user: {
    id: uuidv7(),
    email: 'nitheesh@playxoft.com',
    emailVerified: true,
    displayName: null,
    avatarUrl: null,
  },
};

function request(init: { method?: string; origin?: string } = {}): Request {
  return new Request('https://xecret.playxoft.com/api/test', {
    method: init.method ?? 'GET',
    headers: {
      'cf-ray': RAY_ID,
      ...(init.origin === undefined ? {} : { origin: init.origin }),
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  deferred.length = 0;
  auditSink.write.mockResolvedValue(undefined);

  context.workerContext.mockResolvedValue({ env: {}, ctx: { waitUntil: () => {} } });
  // Echoes the request id the wrapper threaded in, which is the property under
  // test: the id on the response header and the id in the audit records must be
  // the same value, or correlating a user's report with a log line fails.
  context.createServiceContext.mockImplementation(
    async (_request: Request, _worker: unknown, requestId: string) => ({
      env: { XECRET_PUBLIC_URL: 'https://xecret.playxoft.com', XECRET_ENV: 'production' },
      db: {},
      envelope: {},
      meta: {
        requestId,
        ipAddress: '203.0.113.5',
        userAgent: 'vitest',
        method: 'GET',
        path: '/api/test',
      },
      waitUntil: (promise: Promise<unknown>) => void deferred.push(promise),
      dispose: () => {},
    }),
  );
  actor.authenticate.mockResolvedValue({ principal, source: 'cookie' });
  actor.assertCsrf.mockReturnValue(undefined);
  actor.isUnlocked.mockReturnValue(true);
});

/** Runs whatever the handler deferred via `waitUntil`. */
async function settleDeferred(): Promise<void> {
  await Promise.allSettled(deferred);
}

describe('successful responses', () => {
  it('returns the handler’s response and stamps the request id', async () => {
    const handler = publicRoute(async () => new Response('ok', { status: 200 }));
    const response = await handler(request());

    expect(response.status).toBe(200);
    expect(response.headers.get('x-xecret-request-id')).toBe(RAY_ID);
  });

  it('passes awaited route params to the handler', async () => {
    const seen: unknown[] = [];
    const handler = publicRoute<{ orgSlug: string }>(async ({ params }) => {
      seen.push(params);
      return new Response(null, { status: 204 });
    });

    await handler(request(), { params: Promise.resolve({ orgSlug: 'playxoft' }) });
    expect(seen).toEqual([{ orgSlug: 'playxoft' }]);
  });

  it('supplies an empty params object when the route has no dynamic segment', async () => {
    const seen: unknown[] = [];
    const handler = publicRoute(async ({ params }) => {
      seen.push(params);
      return new Response(null, { status: 204 });
    });

    await handler(request());
    expect(seen).toEqual([{}]);
  });
});

describe('authentication and CSRF', () => {
  it('runs authentication before the handler body', async () => {
    const order: string[] = [];
    actor.authenticate.mockImplementation(async () => {
      order.push('authenticate');
      return { principal, source: 'cookie' };
    });

    const handler = authenticatedRoute(async () => {
      order.push('handler');
      return new Response(null, { status: 204 });
    });

    await handler(request());
    expect(order).toEqual(['authenticate', 'handler']);
  });

  it('never reaches the handler when authentication fails', async () => {
    actor.authenticate.mockRejectedValue(errors.unauthenticated('no credential'));
    const body = vi.fn();

    const handler = authenticatedRoute(async () => {
      body();
      return new Response(null, { status: 204 });
    });

    const response = await handler(request());

    expect(response.status).toBe(401);
    expect(body).not.toHaveBeenCalled();
  });

  // Rejected before the credential is even looked at, so the outcome cannot
  // depend on whether the presented token happened to be valid.
  it('rejects a foreign origin before authenticating', async () => {
    const handler = authenticatedRoute(async () => new Response(null, { status: 204 }));
    const response = await handler(request({ method: 'POST', origin: 'https://evil.example' }));

    expect(response.status).toBe(403);
    expect(actor.authenticate).not.toHaveBeenCalled();
  });

  it('enforces CSRF on every authenticated request', async () => {
    const handler = authenticatedRoute(async () => new Response(null, { status: 204 }));
    await handler(request({ method: 'POST', origin: 'https://xecret.playxoft.com' }));

    expect(actor.assertCsrf).toHaveBeenCalledOnce();
  });

  it('turns a CSRF failure into 403 with a fixed message', async () => {
    actor.assertCsrf.mockImplementation(() => {
      throw errors.csrf('missing-header');
    });

    const handler = authenticatedRoute(async () => new Response(null, { status: 204 }));
    const response = await handler(request({ method: 'POST' }));
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(403);
    expect(body.error.code).toBe('csrf_failed');
    expect(body.error.message).not.toContain('missing-header');
  });
});

describe('error conversion', () => {
  // The single most important assertion in this file. A postgres.js error
  // message can embed the connection string; a stack trace names internals.
  it('converts an arbitrary throw into a fixed 500 with no detail', async () => {
    const handler = publicRoute(async () => {
      throw new Error('connect ECONNREFUSED postgres://user:hunter2@db.internal:5432/xecret');
    });

    const response = await handler(request());
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('ECONNREFUSED');
    expect(text).not.toContain('postgres://');
    expect(JSON.parse(text)).toEqual({
      error: { code: 'internal_error', message: 'Something went wrong.', requestId: RAY_ID },
    });
  });

  it('maps a notFound authorization denial to 404', async () => {
    const handler = authenticatedRoute(async () => {
      throw new AuthorizationError({
        allowed: false,
        reason: 'notFound',
        message: 'The requested resource does not exist.',
      });
    });

    const response = await handler(request());
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(404);
    expect(body.error).toMatchObject({ code: 'not_found', message: 'Not found.' });
  });

  it('maps a forbidden authorization denial to 403', async () => {
    const handler = authenticatedRoute(async () => {
      throw new AuthorizationError({
        allowed: false,
        reason: 'forbidden',
        message: 'You do not have permission to perform this action.',
      });
    });

    expect((await handler(request())).status).toBe(403);
  });

  // 503 rather than 500 so monitoring can separate "this deployment is
  // misconfigured" from "this code is broken" — very different pages.
  it('maps a missing binding to 503 without naming the binding to the client', async () => {
    const handler = publicRoute(async () => {
      throw new MissingBindingError('HYPERDRIVE');
    });

    const response = await handler(request());
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(text).not.toContain('HYPERDRIVE');
  });

  // Regression: context construction used to happen outside the try block, so a
  // deployment missing its Hyperdrive binding produced an unformatted framework
  // 500 — the one failure mode the error boundary exists to prevent, occurring
  // in exactly the situation where a clear answer matters most.
  it('catches a failure raised while building the request context', async () => {
    context.createServiceContext.mockRejectedValue(new MissingBindingError('HYPERDRIVE'));
    const handler = publicRoute(async () => new Response(null, { status: 204 }));

    const response = await handler(request());
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(text).not.toContain('HYPERDRIVE');
    expect(response.headers.get('x-xecret-request-id')).toBeTruthy();
  });

  it('catches a failure raised while resolving the Cloudflare context', async () => {
    context.workerContext.mockRejectedValue(new Error('no execution context'));
    const handler = authenticatedRoute(async () => new Response(null, { status: 204 }));

    expect((await handler(request())).status).toBe(500);
  });

  it('stamps the request id on an error response too', async () => {
    const handler = publicRoute(async () => {
      throw new Error('boom');
    });

    expect((await handler(request())).headers.get('x-xecret-request-id')).toBe(RAY_ID);
  });
});

describe('audit flushing', () => {
  it('writes queued records after the response', async () => {
    const handler = authenticatedRoute(async ({ audit, record }) => {
      record(audit(ORG_ID).success('project.created', { type: 'project', id: uuidv7() }));
      return new Response(null, { status: 204 });
    });

    await handler(request());
    await settleDeferred();

    expect(auditSink.write).toHaveBeenCalledOnce();
    expect(auditSink.write.mock.calls[0]?.[0]).toHaveLength(1);
  });

  // The denial that caused the failure is exactly the record worth keeping, so
  // the flush must be in a `finally`, not on the success path.
  it('still writes records queued before a failure', async () => {
    const handler = authenticatedRoute(async ({ audit, record }) => {
      record(
        audit(ORG_ID).denied(
          'secret.read',
          { type: 'secret', id: uuidv7() },
          {
            allowed: false,
            reason: 'forbidden',
            message: 'nope',
          },
        ),
      );
      throw new Error('something later went wrong');
    });

    const response = await handler(request());
    await settleDeferred();

    expect(response.status).toBe(500);
    expect(auditSink.write).toHaveBeenCalledOnce();
  });

  it('does not touch the database when nothing was recorded', async () => {
    const handler = authenticatedRoute(async () => new Response(null, { status: 204 }));

    await handler(request());
    await settleDeferred();

    expect(auditSink.write).not.toHaveBeenCalled();
  });

  // The response is already sent by the time the flush runs; failing it would
  // change nothing for the caller and lose the record. It is logged instead, at
  // `error`, so it is alertable.
  it('does not fail a successful response when the audit write fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    auditSink.write.mockRejectedValue(new Error('audit table unreachable'));

    const handler = authenticatedRoute(async ({ audit, record }) => {
      record(audit(ORG_ID).success('project.created', { type: 'project', id: uuidv7() }));
      return new Response(null, { status: 204 });
    });

    const response = await handler(request());
    await settleDeferred();

    expect(response.status).toBe(204);
    expect(consoleError).toHaveBeenCalledWith('audit flush failed', expect.any(Object));

    // The failure message itself must not be logged verbatim: an audit write
    // failure is usually a database error, and those carry connection strings.
    const logged = JSON.stringify(consoleError.mock.calls[0]?.[1]);
    expect(logged).not.toContain('audit table unreachable');

    consoleError.mockRestore();
  });
});

describe('audit builder binding', () => {
  it('binds records to the organisation the handler resolved', async () => {
    const sink = new InMemoryAuditSink();
    const builder = createAuditBuilder({
      orgId: ORG_ID,
      actorType: 'user',
      actorId: principal.user.id,
      actorLabel: principal.user.email,
      ipAddress: '203.0.113.5',
      userAgent: 'vitest',
      requestId: RAY_ID,
    });

    await sink.write([builder.success('org.updated', { type: 'org', id: ORG_ID })]);

    expect(sink.events[0]).toMatchObject({ orgId: ORG_ID, outcome: 'success' });
  });
});

/**
 * The PIN gate.
 *
 * These are the tests that make the lock a security control rather than a screen
 * the dashboard chooses to draw. The client's belief about whether it is
 * unlocked is irrelevant — a stale tab, a replayed `fetch` from the console, and
 * a script holding a stolen cookie all arrive here and get the same answer.
 */
describe('the lock gate', () => {
  it('refuses a locked session before the handler body runs', async () => {
    actor.isUnlocked.mockReturnValue(false);
    const body = vi.fn();

    const handler = authenticatedRoute(async () => {
      body();
      return new Response(null, { status: 204 });
    });

    const response = await handler(request());

    expect(response.status).toBe(403);
    // Not merely refused — never reached. A handler that ran and then had its
    // response discarded would still have read the database.
    expect(body).not.toHaveBeenCalled();
  });

  it('answers with its own code, distinguishable from a permission failure', async () => {
    // The one 403 a client can resolve by itself. A generic `forbidden` would
    // send a user to ask an admin for access they already have.
    actor.isUnlocked.mockReturnValue(false);
    const handler = authenticatedRoute(async () => new Response(null, { status: 204 }));

    const response = await handler(request());
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(body.error.code).toBe('session_locked');
    expect(body.error.message).toBe('Enter your PIN to continue.');
  });

  it('lets an explicitly exempt route through', async () => {
    // `/api/auth/me`, the PIN routes, and nothing else. Without this the lock
    // screen cannot function and the account is bricked until the session
    // expires.
    actor.isUnlocked.mockReturnValue(false);
    const body = vi.fn();

    const handler = authenticatedRoute(
      async () => {
        body();
        return new Response(null, { status: 204 });
      },
      { allowLocked: true },
    );

    const response = await handler(request());

    expect(response.status).toBe(204);
    expect(body).toHaveBeenCalled();
  });

  it('checks CSRF before the lock, so a cross-site probe cannot learn the lock state', async () => {
    // Both fail with 403. Answering `session_locked` to an unverified
    // cross-origin request would confirm the cookie is live to a page that
    // cannot read the response body but can read the code.
    actor.isUnlocked.mockReturnValue(false);
    actor.assertCsrf.mockImplementation(() => {
      throw errors.csrf('missing token');
    });

    const handler = authenticatedRoute(async () => new Response(null, { status: 204 }));
    const body = (await (await handler(request({ method: 'POST' }))).json()) as {
      error: { code: string };
    };

    expect(body.error.code).toBe('csrf_failed');
  });

  it('does not gate a public route', async () => {
    // Sign-out has to work for somebody who cannot remember their PIN, and sign-in
    // establishes the session the gate is about in the first place.
    actor.isUnlocked.mockReturnValue(false);
    const handler = publicRoute(async () => new Response(null, { status: 204 }));

    expect((await handler(request())).status).toBe(204);
  });
});

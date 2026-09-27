import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, isApiError } from './api';

/**
 * The `plan_limit` refusal, from the wire to something the dashboard can render.
 *
 * Two independent failures made the whole `PlanProblem` shape unreachable from a
 * browser, and both were silent:
 *
 *  1. `plan_limit` was missing from this client's `ERROR_CODES` set, so the code
 *     failed validation and every such 403 arrived as `internal_error` — the
 *     only code that means "we have no idea what happened".
 *  2. There was no branch for the `plan` block at all, so `limit`, `current`,
 *     `plan` and `upgradeTo` were dropped on the floor. The upgrade button the
 *     server-side type, the wire field and the `upgradeTo` resolution all exist
 *     to render could not be rendered from what reached the client.
 *
 * Driven through the real `api.post` with a stubbed `fetch`, rather than by
 * exporting the parser: what matters is what a call site receives.
 */

const originalFetch = globalThis.fetch;

function respond(body: unknown, status = 403): void {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', 'x-xecret-request-id': 'req-1' },
      }),
  ) as typeof fetch;
}

/** The body `errors.planLimit` produces for a countable ceiling. */
function planLimitBody(plan: unknown) {
  return {
    error: {
      code: 'plan_limit',
      message: 'This organisation is at its project limit.',
      requestId: 'req-1',
      plan,
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('window', undefined);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a plan_limit refusal reaching the browser', () => {
  it('keeps its code instead of arriving as internal_error', async () => {
    respond(
      planLimitBody({
        resource: 'projects',
        limit: 5,
        current: 5,
        plan: 'free',
        upgradeTo: 'pro',
      }),
    );

    const error = await api.post('/orgs/acme/projects', {}).catch((cause: unknown) => cause);

    expect(isApiError(error)).toBe(true);
    if (!isApiError(error)) return;
    expect(error.code).toBe('plan_limit');
    expect(error.status).toBe(403);
  });

  it('carries the block the upgrade button is rendered from', async () => {
    respond(
      planLimitBody({
        resource: 'projects',
        limit: 5,
        current: 5,
        plan: 'free',
        upgradeTo: 'pro',
      }),
    );

    const error = await api.post('/orgs/acme/projects', {}).catch((cause: unknown) => cause);

    expect(isApiError(error)).toBe(true);
    if (!isApiError(error)) return;
    expect(error.plan).toEqual({
      resource: 'projects',
      limit: 5,
      current: 5,
      plan: 'free',
      upgradeTo: 'pro',
    });
  });

  /**
   * A capability refusal — SAML, an add-on — has no count and may have no plan
   * that would allow it. Nulls are the contract, not a parse failure.
   */
  it('accepts a refusal with no count and no upgrade path', async () => {
    respond(
      planLimitBody({
        resource: 'samlSso',
        limit: null,
        current: null,
        plan: 'team',
        upgradeTo: null,
      }),
    );

    const error = await api.post('/orgs/acme/sso', {}).catch((cause: unknown) => cause);

    expect(isApiError(error)).toBe(true);
    if (!isApiError(error)) return;
    expect(error.plan).toEqual({
      resource: 'samlSso',
      limit: null,
      current: null,
      plan: 'team',
      upgradeTo: null,
    });
  });

  /**
   * Half a block is worse than none: "You have reached your undefined limit" is
   * a sentence no user should ever be shown, so a block missing either field the
   * dashboard cannot do without is discarded whole.
   */
  it('discards a malformed block rather than rendering half of one', async () => {
    respond(planLimitBody({ limit: 5, current: 5, upgradeTo: 'pro' }));

    const error = await api.post('/orgs/acme/projects', {}).catch((cause: unknown) => cause);

    expect(isApiError(error)).toBe(true);
    if (!isApiError(error)) return;
    expect(error.code).toBe('plan_limit');
    expect(error.plan).toBeNull();
  });

  it('leaves `plan` null on every other error', async () => {
    respond({ error: { code: 'not_found', message: 'Not found.', requestId: 'req-1' } }, 404);

    const error = await api.get('/orgs/acme').catch((cause: unknown) => cause);

    expect(isApiError(error)).toBe(true);
    if (!isApiError(error)) return;
    expect(error.plan).toBeNull();
  });
});

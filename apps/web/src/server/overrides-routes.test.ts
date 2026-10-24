import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditRecord } from '@xecret/core/audit';
import {
  EnvelopeService,
  generateKeyBytes,
  InMemoryKeyProvider,
  parseRootKeyMaterial,
  toBase64Url,
} from '@xecret/core/crypto';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '@xecret/db/testing';
import type { TestDatabase } from '@xecret/db/testing';
import type { Principal } from './actor';
import { errors } from './errors';
import { createLogger } from './logging';
import type { RequestLog } from './logging';
import { blob, ORIGIN, routeFixtures } from './testing/route-fixtures';
import type { Org } from './testing/route-fixtures';

/**
 * Personal overrides (P19 §2), end to end against PGlite: who may hold one, the
 * plan gate in front of setting one, and the rules that keep them personal —
 * owner-scoped, refused to every service token, and absent from every pull.
 */

const context = vi.hoisted(() => ({ workerContext: vi.fn(), createServiceContext: vi.fn() }));
const actor = vi.hoisted(() => ({
  authenticate: vi.fn(),
  assertCsrf: vi.fn(),
  isUnlocked: vi.fn(() => true),
}));
const auditSink = vi.hoisted(() => ({ write: vi.fn() }));
const logging = vi.hoisted(() => ({ createRequestLog: vi.fn() }));

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
// The usage meter (P12) arms a fifteen-second flush in the request's own
// `waitUntil`, and every request here awaits what it deferred — so the meter
// only records. Counting itself is `billing/usage.test.ts`'s to prove.
const meter = vi.hoisted(() => ({ countSecretFetch: vi.fn() }));
vi.mock('./billing/usage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./billing/usage')>()),
  countSecretFetch: meter.countSecretFetch,
}));

const listRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/overrides/route');
const overrideRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/overrides/[name]/route');
const pullRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/pull/route');

let t: TestDatabase;
let envelope: EnvelopeService;
let audit: AuditRecord[] = [];
let deferred: Promise<unknown>[] = [];
let caller: Principal | null;

const f = routeFixtures({ t: () => t, envelope: () => envelope, deferred: () => deferred });

beforeAll(async () => {
  t = await createTestDatabase();
  const rootKeys = JSON.stringify({ '1': toBase64Url(generateKeyBytes()) });
  envelope = new EnvelopeService(new InMemoryKeyProvider(parseRootKeyMaterial(rootKeys, 1)));
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  audit = [];
  deferred = [];
  const env = { XECRET_PUBLIC_URL: ORIGIN, XECRET_ENV: 'test' };
  logging.createRequestLog.mockImplementation((_env: unknown, base: Record<string, unknown>) =>
    createLogger({
      sink: { write: () => {}, flush: () => Promise.resolve() },
      minimum: 'error',
      base,
    }),
  );
  context.workerContext.mockImplementation(async () => ({ env, ctx: { waitUntil: () => {} } }));
  context.createServiceContext.mockImplementation(
    async (
      request: Request,
      _w: unknown,
      requestId: string,
      log: RequestLog,
      startedAt: number,
    ) => ({
      env,
      db: t.db,
      envelope,
      meta: {
        requestId,
        rayId: null,
        ipAddress: '203.0.113.5',
        userAgent: 'vitest',
        method: request.method,
        path: new URL(request.url).pathname,
        startedAt,
      },
      log: log.logger,
      bindLog: log.bind,
      waitUntil: (promise: Promise<unknown>) => void deferred.push(promise),
      settled: () => Promise.allSettled(deferred),
      dispose: () => {},
    }),
  );
  actor.authenticate.mockImplementation(async () => {
    if (caller === null) throw errors.unauthenticated('no credential');
    return { principal: caller, source: caller.kind === 'user' ? 'cookie' : 'bearer' };
  });
  auditSink.write.mockImplementation(async (events: AuditRecord[]) => {
    audit.push(...events);
  });
});

interface Body {
  error?: { code?: string; message?: string; plan?: { upgradeTo?: string | null } };
  overrides?: { name: string; ciphertext: string; updatedAt: string }[];
  canSet?: boolean;
  upgradeTo?: string | null;
  override?: { name: string; created?: boolean; deleted?: boolean };
}

function list(org: Org, env = 'development') {
  const { path, params } = f.envPath(org, env, '/overrides');
  return f.call<Body>(listRoute.GET, 'GET', path, params);
}

function put(org: Org, name: string, ciphertext = blob(name), env = 'development') {
  const { path, params } = f.envPath(org, env, `/overrides/${name}`);
  return f.call<Body>(overrideRoute.PUT, 'PUT', path, { ...params, name }, { ciphertext });
}

function remove(org: Org, name: string, env = 'development') {
  const { path, params } = f.envPath(org, env, `/overrides/${name}`);
  return f.call<Body>(overrideRoute.DELETE, 'DELETE', path, { ...params, name });
}

const recorded = (action: string) => audit.filter((event) => event.action === action);

async function setup(plan: 'free' | 'pro' = 'pro', mode: 'e2ee' | 'server' = 'e2ee') {
  const org = await f.seedOrg(plan);
  const project = await f.seedProject(org);
  const env = await f.seedEnv(org, project, 'development', { mode });
  caller = f.sessionOf(org.owner);
  return { org, project, env };
}

describe('setting a personal override', () => {
  it('refuses a Free organisation, naming the plan, and files the refusal', async () => {
    const { org } = await setup('free');

    const answer = await put(org, 'DATABASE_URL');
    expect(answer.status).toBe(403);
    expect(answer.body.error?.code).toBe('plan_limit');
    expect(answer.body.error?.plan?.upgradeTo).toBe('pro');
    expect(recorded('override.set')).toEqual([
      expect.objectContaining({
        outcome: 'error',
        metadata: expect.objectContaining({
          reason: 'quotaExceeded',
          limitName: 'personalOverrides',
          secretName: 'DATABASE_URL',
        }),
      }),
    ]);
    expect((await list(org)).body).toMatchObject({
      overrides: [],
      canSet: false,
      upgradeTo: 'pro',
    });
  });

  it('sets and replaces one on Pro, auditing each — the name, never the value', async () => {
    const { org } = await setup();

    const first = await put(org, 'DATABASE_URL', blob('one'));
    expect(first.status).toBe(200);
    expect(first.body.override).toMatchObject({ name: 'DATABASE_URL', created: true });

    const second = await put(org, 'DATABASE_URL', blob('two'));
    expect(second.body.override).toMatchObject({ created: false });

    const listed = await list(org);
    expect(listed.body.canSet).toBe(true);
    expect(listed.body.overrides).toEqual([
      expect.objectContaining({ name: 'DATABASE_URL', ciphertext: blob('two') }),
    ]);

    const sets = recorded('override.set');
    expect(sets).toHaveLength(2);
    expect(sets[0]).toMatchObject({ outcome: 'success', metadata: { secretName: 'DATABASE_URL' } });
    expect(JSON.stringify(sets)).not.toContain(blob('two'));
  });

  it('works from a CLI login, which is the person', async () => {
    const { org } = await setup();
    caller = f.cliTokenOf(org.owner, org.orgId);
    expect((await put(org, 'API_URL')).status).toBe(200);
    expect((await list(org)).body.overrides).toHaveLength(1);
  });

  it('refuses a malformed value and a name that is not a variable name', async () => {
    const { org } = await setup();
    expect(
      (
        await put(
          org,
          'DATABASE_URL',
          'xk2.x25519.notagcmblobbutlongenoughtopasstheminimumlengthcheck0000000000000',
        )
      ).status,
    ).toBe(422);
    expect((await put(org, '1BAD')).status).toBeGreaterThanOrEqual(400);
  });

  it('needs an end-to-end encrypted environment', async () => {
    const { org } = await setup('pro', 'server');
    const answer = await put(org, 'DATABASE_URL');
    expect(answer.status).toBe(409);
    expect(answer.body.error?.message).toMatch(/^e2ee_required:/);
  });
});

describe('who sees an override', () => {
  it('only its owner — a teammate with the same access lists none', async () => {
    const { org } = await setup();
    expect((await put(org, 'DATABASE_URL')).status).toBe(200);

    caller = f.sessionOf(await f.seedMember(org, 'admin'));
    expect((await list(org)).body.overrides).toEqual([]);
    expect((await remove(org, 'DATABASE_URL')).status).toBe(404);
  });

  it('never a service token, on any route', async () => {
    const { org, project, env } = await setup();
    caller = await f.seedServiceToken(org, project, env);

    for (const answer of [await list(org), await put(org, 'X'), await remove(org, 'X')]) {
      expect(answer.status).toBe(403);
      expect(answer.body.error?.message).toContain('service token');
    }
  });

  it('never a pull — not the owner’s own, not a CI run’s', async () => {
    const { org, project, env } = await setup();
    await f.seedSecret(org, env, 'DATABASE_URL');
    expect((await put(org, 'DATABASE_URL', blob('mine'))).status).toBe(200);

    const { path, params } = f.envPath(org, 'development', '/pull?format=json&bundle=2');
    const own = await f.call<Body>(pullRoute.GET, 'GET', path, params);
    expect(own.status).toBe(200);
    expect(own.text).not.toContain(blob('mine'));

    caller = await f.seedServiceToken(org, project, env);
    const ci = await f.call<Body>(pullRoute.GET, 'GET', path, params);
    expect(ci.status).toBe(200);
    expect(ci.text).not.toContain(blob('mine'));
  });

  it('not a stranger, and not an unauthenticated caller', async () => {
    const { org } = await setup();
    caller = f.sessionOf(await f.seedUser());
    expect((await list(org)).status).toBe(404);
    caller = null;
    expect((await list(org)).status).toBe(401);
  });
});

describe('removing a personal override', () => {
  it('removes the owner’s own, audits it, and answers 404 when there is none', async () => {
    const { org } = await setup();
    expect((await put(org, 'DATABASE_URL')).status).toBe(200);

    const answer = await remove(org, 'DATABASE_URL');
    expect(answer.status).toBe(200);
    expect(answer.body.override).toEqual({ name: 'DATABASE_URL', deleted: true });
    expect(recorded('override.removed')).toEqual([expect.objectContaining({ outcome: 'success' })]);
    expect((await remove(org, 'DATABASE_URL')).status).toBe(404);
  });

  it('keeps working after a downgrade, which refuses only setting a new one', async () => {
    const { org } = await setup();
    expect((await put(org, 'DATABASE_URL')).status).toBe(200);
    await f.setPlan(org.orgId, 'free');

    expect((await list(org)).body.overrides).toHaveLength(1);
    expect((await put(org, 'OTHER')).body.error?.code).toBe('plan_limit');
    expect((await remove(org, 'DATABASE_URL')).status).toBe(200);
  });
});

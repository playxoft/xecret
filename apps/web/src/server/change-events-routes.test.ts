import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditRecord } from '@xecret/core/audit';
import {
  EnvelopeService,
  generateKeyBytes,
  InMemoryKeyProvider,
  parseRootKeyMaterial,
  toBase64Url,
} from '@xecret/core/crypto';
import { verifyWebhook } from '@xecret/core/webhooks';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '@xecret/db/testing';
import type { TestDatabase } from '@xecret/db/testing';
import type { Principal } from './actor';
import { errors } from './errors';
import { createLogger } from './logging';
import type { RequestLog } from './logging';
import { blob, ORIGIN, routeFixtures } from './testing/route-fixtures';
import type { Env, Org } from './testing/route-fixtures';

/**
 * The wiring between the secret routes and the P19 notifications: every write
 * that changes a secret announces it to the organisation's webhooks (§5), and
 * every read of an environment is noted for the new-address alerts (§7).
 *
 * The services themselves are tested in `webhooks.test.ts` and
 * `read-alerts.test.ts`; this asks only that each route calls them, with the
 * right event and nothing a value could hide in. `fetch` is the endpoint.
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

const webhooksRoute = await import('@/app/api/orgs/[orgSlug]/webhooks/route');
const secretsRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/secrets/route');
const secretRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/secrets/[name]/route');
const promoteRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/promote/route');
const pullRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/pull/route');

let t: TestDatabase;
let envelope: EnvelopeService;
let audit: AuditRecord[] = [];
let deferred: Promise<unknown>[] = [];
let caller: Principal | null;
let hits: { url: string; headers: Headers; body: string }[] = [];

const f = routeFixtures({ t: () => t, envelope: () => envelope, deferred: () => deferred });

beforeAll(async () => {
  t = await createTestDatabase();
  const rootKeys = JSON.stringify({ '1': toBase64Url(generateKeyBytes()) });
  envelope = new EnvelopeService(new InMemoryKeyProvider(parseRootKeyMaterial(rootKeys, 1)));
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.clearAllMocks();
  audit = [];
  deferred = [];
  hits = [];
  const env = { XECRET_PUBLIC_URL: ORIGIN, XECRET_ENV: 'test' };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      hits.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: String(init?.body),
      });
      return new Response(null, { status: 204 });
    }),
  );
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

/** Everything queued after the response, including what that queued in turn. */
async function settle(): Promise<void> {
  for (let seen = -1; seen !== deferred.length;) {
    seen = deferred.length;
    await Promise.allSettled(deferred);
  }
}

const tag = (label: string) =>
  toBase64Url(new TextEncoder().encode(label.padEnd(32, '.').slice(0, 32)));

interface Delivered {
  type: string;
  data: {
    secret?: { name: string; version?: number };
    environment?: { slug: string };
    counts?: unknown;
  };
}

const delivered = () => hits.map((hit) => JSON.parse(hit.body) as Delivered);

async function setup(plan: 'free' | 'pro' = 'pro') {
  const org = await f.seedOrg(plan === 'free' ? 'pro' : plan);
  const project = await f.seedProject(org);
  // A server-mode environment seeds the organisation's master key, which a
  // webhook's signing secret is sealed under.
  await f.seedEnv(org, project, 'legacy', { mode: 'server' });
  const development = await f.seedEnv(org, project, 'development');
  const production = await f.seedEnv(org, project, 'production', { production: true });
  caller = f.sessionOf(org.owner);

  const created = await f.call<{ secret?: string }>(
    webhooksRoute.POST,
    'POST',
    `/api/orgs/${org.slug}/webhooks`,
    { orgSlug: org.slug },
    {
      url: 'https://hooks.example.com/xecret',
      eventTypes: [
        'secret.created',
        'secret.updated',
        'secret.deleted',
        'secret.rotated',
        'environment.promoted',
        'environment.restored',
      ],
    },
  );
  expect(created.status).toBe(201);
  if (plan === 'free') await f.setPlan(org.orgId, 'free');
  return { org, project, development, production, secret: created.body.secret! };
}

function create(org: Org, env: Env, name: string, label = name) {
  const { path, params } = f.envPath(org, env.slug, '/secrets');
  return f.call(secretsRoute.POST, 'POST', path, params, {
    id: crypto.randomUUID(),
    name,
    valueType: 'string',
    value: {
      ciphertext: blob(label),
      clientAlgorithm: 'xk2.gcm',
      envDataKeyId: env.keyId,
      valueHmac: tag(label),
    },
  });
}

describe('secret writes announce themselves to the organisation’s webhooks', () => {
  it('a create: the name, the version, the environment — and nothing that could be a value', async () => {
    const { org, development, secret } = await setup();

    expect((await create(org, development, 'DATABASE_URL', 'the-ciphertext')).status).toBe(201);
    await settle();

    expect(delivered()).toEqual([
      expect.objectContaining({
        type: 'secret.created',
        data: expect.objectContaining({
          secret: { name: 'DATABASE_URL', version: 1 },
          environment: expect.objectContaining({ slug: 'development' }),
        }),
      }),
    ]);
    expect(hits[0]!.body).not.toContain(blob('the-ciphertext'));
    expect(hits[0]!.body).not.toContain(tag('the-ciphertext'));

    // Signed with the secret shown at creation.
    const hit = hits[0]!;
    expect(
      await verifyWebhook({
        secret,
        id: hit.headers.get('webhook-id')!,
        timestamp: Number(hit.headers.get('webhook-timestamp')),
        body: hit.body,
        signatureHeader: hit.headers.get('webhook-signature')!,
        now: Math.floor(Date.now() / 1000),
      }),
    ).toBe(true);
  });

  it('an update that changed the value, and not one that did not; a deletion', async () => {
    const { org, development } = await setup();
    expect((await create(org, development, 'API_KEY', 'v1')).status).toBe(201);
    await settle();
    hits = [];

    const { path, params } = f.envPath(org, 'development', '/secrets/API_KEY');
    const id = (
      await t.pg.query<{ id: string }>(
        `select id from secrets where environment_id = $1 and name = 'API_KEY'`,
        [development.id],
      )
    ).rows[0]!.id;
    const write = (label: string, expectedVersion: number) =>
      f.call(
        secretRoute.PATCH,
        'PATCH',
        path,
        { ...params, name: 'API_KEY' },
        {
          expectedVersion,
          value: {
            ciphertext: blob(label),
            clientAlgorithm: 'xk2.gcm',
            envDataKeyId: development.keyId,
            valueHmac: tag(label),
          },
        },
      );

    expect((await write('v1', 2)).status).toBe(200); // the same value: unchanged
    expect((await write('v2', 2)).status).toBe(200);
    expect(
      (await f.call(secretRoute.DELETE, 'DELETE', path, { ...params, name: 'API_KEY' })).status,
    ).toBe(200);
    await settle();

    expect(delivered().map((event) => [event.type, event.data.secret])).toEqual([
      ['secret.updated', { name: 'API_KEY', version: 2 }],
      ['secret.deleted', { name: 'API_KEY', version: 2 }],
    ]);
    expect(id).toBeTypeOf('string');
  });

  it('a promotion: the promotion once, and each secret it changed', async () => {
    const { org, development, production } = await setup();
    expect((await create(org, development, 'HOST', 'host')).status).toBe(201);
    await settle();
    hits = [];

    const { path, params } = f.envPath(org, 'production', '/promote');
    const answer = await f.call(promoteRoute.POST, 'POST', path, params, {
      source: 'development',
      dryRun: false,
      writes: [
        {
          id: crypto.randomUUID(),
          name: 'HOST',
          expectedVersion: 1,
          value: {
            ciphertext: blob('host'),
            clientAlgorithm: 'xk2.gcm',
            envDataKeyId: production.keyId,
            valueHmac: tag('host'),
          },
        },
      ],
    });
    expect(answer.status).toBe(200);
    await settle();

    expect(
      delivered()
        .map((event) => event.type)
        .sort(),
    ).toEqual(['environment.promoted', 'secret.created']);
    expect(delivered().find((event) => event.type === 'environment.promoted')!.data.counts).toEqual(
      {
        created: 1,
        updated: 0,
        deleted: 0,
        unchanged: 0,
      },
    );
  });

  it('nothing at all once the plan allows no webhooks', async () => {
    const { org, development } = await setup('free');
    expect((await create(org, development, 'QUIET')).status).toBe(201);
    await settle();
    expect(hits).toEqual([]);
    const queued = await t.pg.query(
      `select 1 from webhook_deliveries d join webhooks w on w.id = d.webhook_id where w.org_id = $1`,
      [org.orgId],
    );
    expect(queued.rows).toEqual([]);
  });
});

describe('reads are noted for the new-address alerts', () => {
  async function sightings(env: Env) {
    return (
      await t.pg.query<{ principal_kind: string; ip_address: string }>(
        `select principal_kind, host(ip_address) as ip_address from environment_read_sightings where environment_id = $1`,
        [env.id],
      )
    ).rows;
  }

  function pull(org: Org, env: Env) {
    const { path, params } = f.envPath(org, env.slug, '/pull?format=json&bundle=2');
    return f.call(pullRoute.GET, 'GET', path, params);
  }

  it('a pull of production, where alerts are on by default, records who and from where', async () => {
    const { org, production, development } = await setup();
    expect((await pull(org, production)).status).toBe(200);
    expect((await pull(org, development)).status).toBe(200);
    await settle();

    expect(await sightings(production)).toEqual([
      { principal_kind: 'user', ip_address: '203.0.113.5' },
    ]);
    // Off by default outside production.
    expect(await sightings(development)).toEqual([]);
  });

  it('a reveal is a read too', async () => {
    const { org, production } = await setup();
    expect((await create(org, production, 'TOKEN')).status).toBe(201);
    const { path, params } = f.envPath(org, 'production', '/secrets/TOKEN');
    expect((await f.call(secretRoute.GET, 'GET', path, { ...params, name: 'TOKEN' })).status).toBe(
      200,
    );
    await settle();
    expect(await sightings(production)).toHaveLength(1);
  });

  it('nothing on a plan without alerts', async () => {
    const org = await f.seedOrg('free');
    const project = await f.seedProject(org);
    const production = await f.seedEnv(org, project, 'production', { production: true });
    caller = f.sessionOf(org.owner);
    expect((await pull(org, production)).status).toBe(200);
    await settle();
    expect(await sightings(production)).toEqual([]);
  });
});

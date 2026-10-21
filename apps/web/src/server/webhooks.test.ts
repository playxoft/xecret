import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AuditRecord } from '@xecret/core/audit';
import {
  EnvelopeService,
  InMemoryKeyProvider,
  KEY_LENGTH,
  parseRootKeyMaterial,
  randomBytes,
  toBase64Url,
} from '@xecret/core/crypto';
import { verifyWebhook } from '@xecret/core/webhooks';
import type { WebhookEventData } from '@xecret/core/webhooks';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '@xecret/db/testing';
import type { TestDatabase } from '@xecret/db/testing';
import type { Principal } from './actor';
import type { ServiceContext } from './context';
import { errors } from './errors';
import { createLogger } from './logging';
import type { LogEntry, RequestLog } from './logging';
import type { EnvironmentScope } from './tenancy';

/**
 * Webhooks on secret change (P19 §5), end to end: the routes, emission,
 * delivery, retries, the automatic disable, and the scheduled runs — against a
 * real database with every migration applied.
 *
 * ── What is real, and what is stubbed ──
 * Real: every route and `authenticatedRoute`; tenancy, `can()` and the
 * entitlement engine reading memberships and the subscription row from PGlite;
 * every repository; the envelope service, with a real Root KEK and a real org
 * key per organisation, so a signing secret is sealed and opened exactly as in
 * production; the Standard Webhooks signer; the ZeptoMail client.
 *
 * Stubbed: who is asking, the audit sink of the request (captured — the
 * system's own `webhook.disabled` goes straight to the table, and is read back
 * from it), the logger (captured), and `fetch` — which plays both the
 * receiving endpoint and ZeptoMail.
 */

const ORIGIN = 'https://xecret.test';
const ZEPTO = 'https://api.zeptomail.com/v1.1/email';
const HOOK_URL = 'https://hooks.example.com/services/T000/B000/XXXXPATHCREDENTIAL';

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

const collectionRoute = await import('@/app/api/orgs/[orgSlug]/webhooks/route');
const webhookRoute = await import('@/app/api/orgs/[orgSlug]/webhooks/[webhookId]/route');
const rotateRoute =
  await import('@/app/api/orgs/[orgSlug]/webhooks/[webhookId]/rotate-secret/route');
const testRoute = await import('@/app/api/orgs/[orgSlug]/webhooks/[webhookId]/test/route');
const deliveriesRoute =
  await import('@/app/api/orgs/[orgSlug]/webhooks/[webhookId]/deliveries/route');
const notificationsRoute = await import('@/app/api/internal/scheduled/notifications/route');
const pruneRoute = await import('@/app/api/internal/scheduled/prune/route');
const service = await import('./webhooks-service');
const changeEvents = await import('./change-events');
const scheduled = await import('./scheduled');
const { enqueueDeliveries, loadEntitlements } = await import('@xecret/db/repositories');

let t: TestDatabase;
let audit: AuditRecord[] = [];
let lines: LogEntry[] = [];
let deferred: Promise<unknown>[] = [];
let env: Record<string, unknown>;
let caller: Principal;

/** What the receiving endpoint answers. Replaced per test. */
let receiver: (hit: Hit) => Response | Promise<Response>;
let hits: Hit[] = [];
let mail: { to: string; subject: string; text: string; html: string }[] = [];
let mailStatus = 201;

interface Hit {
  url: string;
  headers: Headers;
  body: string;
  redirect: RequestRedirect | undefined;
}

const envelope = new EnvelopeService(
  new InMemoryKeyProvider(
    parseRootKeyMaterial(JSON.stringify({ 1: toBase64Url(randomBytes(KEY_LENGTH)) }), 1),
  ),
);

function servicesFor(request?: Request, requestId: string = randomUUID(), log?: RequestLog) {
  const logger =
    log?.logger ??
    createLogger({
      sink: { write: (entry) => lines.push(entry), flush: () => Promise.resolve() },
      minimum: 'debug',
      base: {},
    }).logger;
  return {
    env,
    db: t.db,
    envelope,
    meta: {
      requestId,
      rayId: null,
      ipAddress: '203.0.113.5',
      userAgent: 'vitest',
      method: request?.method ?? 'POST',
      path: request === undefined ? '/' : new URL(request.url).pathname,
      startedAt: Date.now(),
    },
    log: logger,
    bindLog: log?.bind ?? (() => {}),
    waitUntil: (promise: Promise<unknown>) => void deferred.push(promise),
    settled: () => Promise.allSettled(deferred),
    dispose: () => {},
  } as unknown as ServiceContext;
}

beforeAll(async () => {
  t = await createTestDatabase();
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  t.reset();
  audit = [];
  lines = [];
  deferred = [];
  hits = [];
  mail = [];
  mailStatus = 201;
  receiver = () => new Response(null, { status: 204 });
  env = {
    XECRET_PUBLIC_URL: ORIGIN,
    XECRET_ENV: 'test',
    ZEPTOMAIL_TOKEN: 'zepto-test-token',
    ZEPTOMAIL_FROM_ADDRESS: 'no-reply@example.com',
  };
  // Every test starts with nothing owed, so a sweep claims only what that test
  // queued — the database is shared by the whole file.
  await t.pg.query(
    `update webhook_deliveries set status = 'abandoned', next_attempt_at = null, claimed_at = null
     where status in ('pending', 'delivering')`,
  );

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === ZEPTO) {
        const body = JSON.parse(String(init?.body)) as {
          to: { email_address: { address: string } }[];
          subject: string;
          textbody: string;
          htmlbody: string;
        };
        mail.push({
          to: body.to[0]!.email_address.address,
          subject: body.subject,
          text: body.textbody,
          html: body.htmlbody,
        });
        return new Response('{}', { status: mailStatus });
      }
      const hit: Hit = {
        url,
        headers: new Headers(init?.headers),
        body: String(init?.body),
        redirect: init?.redirect,
      };
      hits.push(hit);
      return receiver(hit);
    }),
  );

  logging.createRequestLog.mockImplementation((_env: unknown, base: Record<string, unknown>) =>
    createLogger({
      sink: { write: (entry) => lines.push(entry), flush: () => Promise.resolve() },
      minimum: 'debug',
      base,
    }),
  );
  context.workerContext.mockImplementation(async () => ({ env, ctx: { waitUntil: () => {} } }));
  context.createServiceContext.mockImplementation(
    async (request: Request, _w: unknown, requestId: string, log: RequestLog) =>
      servicesFor(request, requestId, log),
  );
  actor.authenticate.mockImplementation(async () => ({
    principal: caller,
    source: caller.kind === 'user' ? 'cookie' : 'bearer',
  }));
  auditSink.write.mockImplementation(async (events: AuditRecord[]) => {
    audit.push(...events);
  });
});

/* ── fixtures ─────────────────────────────────────────────────────────────── */

interface Person {
  id: string;
  email: string;
}

async function seedUser(): Promise<Person> {
  const id = randomUUID();
  const email = `hooks-${id.slice(0, 8)}@example.com`;
  await t.pg.query(
    `insert into users (id, workos_user_id, email, email_verified) values ($1, $2, $3, true)`,
    [id, `user_${id.slice(0, 8)}`, email],
  );
  return { id, email };
}

function sessionOf(user: Person): Principal {
  return {
    kind: 'user',
    sessionId: randomUUID(),
    user: {
      id: user.id,
      email: user.email,
      emailVerified: true,
      displayName: null,
      avatarUrl: null,
    },
    vaultUnlockedAt: new Date(),
    lastSeenAt: new Date(),
    vaultAutoLockMinutes: null,
    signIn: { method: 'password', ssoWorkosOrgId: null },
  };
}

interface Org {
  orgId: string;
  slug: string;
  owner: Person;
}

async function addMember(orgId: string, userId: string, role: string): Promise<void> {
  await t.pg.query(`insert into org_members (id, org_id, user_id, role) values ($1, $2, $3, $4)`, [
    randomUUID(),
    orgId,
    userId,
    role,
  ]);
}

/** An organisation with its owner, its plan and a real master key, as provisioning makes one. */
async function seedOrg(plan: 'free' | 'pro' | 'team'): Promise<Org> {
  const owner = await seedUser();
  const orgId = randomUUID();
  const slug = `hooks-${orgId.slice(0, 8)}`;
  await t.pg.query(
    `insert into organizations (id, name, slug, created_by) values ($1, 'Acme', $2, $3)`,
    [orgId, slug, owner.id],
  );
  if (plan !== 'free') {
    await t.pg.query(
      `insert into org_subscriptions (org_id, plan, billing_interval) values ($1, $2, 'monthly')`,
      [orgId, plan],
    );
  }
  await addMember(orgId, owner.id, 'owner');
  const orgKey = await envelope.createOrgKey(orgId);
  await t.pg.query(
    `insert into org_keys (id, org_id, version, wrapped_key, wrap_iv, root_key_version, algorithm)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      randomUUID(),
      orgId,
      orgKey.version,
      orgKey.ciphertext,
      orgKey.iv,
      orgKey.rootKeyVersion,
      orgKey.algorithm,
    ],
  );
  return { orgId, slug, owner };
}

async function downgradeToFree(org: Org): Promise<void> {
  await t.pg.query(`delete from org_subscriptions where org_id = $1`, [org.orgId]);
}

/* ── requests ─────────────────────────────────────────────────────────────── */

interface Body {
  error?: {
    code?: string;
    message?: string;
    plan?: { resource?: string; upgradeTo?: string | null; limit?: number | null };
    fields?: { field: string; message: string }[];
  };
  webhook?: Record<string, unknown> & { id: string; state: string };
  webhooks?: (Record<string, unknown> & { id: string; state: string })[];
  secret?: string;
  limit?: { max: number | null; used: number };
  paused?: boolean;
  upgradeTo?: string | null;
  delivery?: {
    id: string;
    status: string;
    lastStatusCode: number | null;
    lastError: string | null;
  };
  deliveries?: {
    id: string;
    eventType: string;
    status: string;
    body: string;
    bodyTruncated: boolean;
  }[];
}

interface Answer {
  status: number;
  body: Body;
  text: string;
}

type Handler = (request: Request, args?: { params?: Promise<never> }) => Promise<Response>;

async function call(
  handler: Handler,
  method: string,
  path: string,
  params: Record<string, string>,
  body?: unknown,
): Promise<Answer> {
  const response = await handler(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve(params) as Promise<never> },
  );
  await Promise.allSettled(deferred);
  const text = await response.text();
  return { status: response.status, body: text === '' ? {} : (JSON.parse(text) as Body), text };
}

const list = (org: Org) =>
  call(collectionRoute.GET, 'GET', `/api/orgs/${org.slug}/webhooks`, { orgSlug: org.slug });

const create = (org: Org, body: unknown = { url: HOOK_URL, eventTypes: ['secret.updated'] }) =>
  call(collectionRoute.POST, 'POST', `/api/orgs/${org.slug}/webhooks`, { orgSlug: org.slug }, body);

function one(org: Org, webhookId: string, rest = '') {
  return {
    path: `/api/orgs/${org.slug}/webhooks/${webhookId}${rest}`,
    params: { orgSlug: org.slug, webhookId },
  };
}

const read = (org: Org, id: string) => {
  const { path, params } = one(org, id);
  return call(webhookRoute.GET, 'GET', path, params);
};
const patch = (org: Org, id: string, body: unknown) => {
  const { path, params } = one(org, id);
  return call(webhookRoute.PATCH, 'PATCH', path, params, body);
};
const remove = (org: Org, id: string) => {
  const { path, params } = one(org, id);
  return call(webhookRoute.DELETE, 'DELETE', path, params);
};
const rotate = (org: Org, id: string) => {
  const { path, params } = one(org, id, '/rotate-secret');
  return call(rotateRoute.POST, 'POST', path, params);
};
const sendTest = (org: Org, id: string) => {
  const { path, params } = one(org, id, '/test');
  return call(testRoute.POST, 'POST', path, params);
};
const deliveryLog = (org: Org, id: string, query = '') => {
  const { path, params } = one(org, id, `/deliveries${query}`);
  return call(deliveriesRoute.GET, 'GET', path, params);
};

/** A Pro organisation, its owner calling, with one webhook made through the route. */
async function withWebhook(eventTypes: string[] = ['secret.updated']) {
  const org = await seedOrg('pro');
  caller = sessionOf(org.owner);
  const created = await create(org, { url: HOOK_URL, eventTypes });
  expect(created.status).toBe(201);
  return { org, id: created.body.webhook!.id, secret: created.body.secret! };
}

function eventData(org: Org, over: Partial<WebhookEventData> = {}): WebhookEventData {
  return {
    organization: { id: org.orgId, slug: org.slug },
    project: { id: '0190a000-0000-7000-8000-000000000001', slug: 'api' },
    environment: { id: '0190a000-0000-7000-8000-000000000002', slug: 'production' },
    secret: { name: 'DATABASE_URL', version: 3 },
    actor: { type: 'user', id: org.owner.id, label: org.owner.email },
    ...over,
  };
}

async function emit(org: Org, events: Parameters<typeof service.emitWebhookEvents>[2]) {
  const entitlements = await loadEntitlements(t.db, org.orgId);
  service.emitWebhookEvents(servicesFor(), entitlements, events);
  await Promise.allSettled(deferred);
}

async function deliveriesOf(webhookId: string) {
  const rows = await t.pg.query<{
    id: string;
    status: string;
    attempts: number;
    last_status_code: number | null;
    last_error: string | null;
    next_attempt_at: Date | null;
    completed_at: Date | null;
    event_type: string;
  }>(
    `select id, status, attempts, last_status_code, last_error, next_attempt_at, completed_at, event_type
     from webhook_deliveries where webhook_id = $1 order by created_at, id`,
    [webhookId],
  );
  return rows.rows;
}

function verifies(hit: Hit, secret: string) {
  return verifyWebhook({
    secret,
    id: hit.headers.get('webhook-id')!,
    timestamp: Number(hit.headers.get('webhook-timestamp')),
    body: hit.body,
    signatureHeader: hit.headers.get('webhook-signature')!,
    now: Math.floor(Date.now() / 1000),
  });
}

/* ── who may ──────────────────────────────────────────────────────────────── */

describe('who may manage webhooks', () => {
  const every = (org: Org, id: string) => [
    () => list(org),
    () => create(org),
    () => read(org, id),
    () => patch(org, id, { description: 'x' }),
    () => remove(org, id),
    () => rotate(org, id),
    () => sendTest(org, id),
    () => deliveryLog(org, id),
  ];

  it('answers 401 to a request with no credential, on every route', async () => {
    const { org, id } = await withWebhook();
    actor.authenticate.mockImplementation(async () => {
      throw errors.unauthenticated('no credential');
    });
    for (const request of every(org, id)) expect((await request()).status).toBe(401);
  });

  it('refuses a service token on every route, whatever it names', async () => {
    const { org, id } = await withWebhook();
    caller = {
      kind: 'serviceToken',
      tokenId: randomUUID(),
      tokenName: 'ci',
      orgId: org.orgId,
      projectId: randomUUID(),
      environmentId: randomUUID(),
      accessLevel: 'admin',
    };
    for (const request of every(org, id)) {
      const answer = await request();
      expect(answer.status).toBe(403);
      expect(answer.text).not.toContain(HOOK_URL);
    }
  });

  it('refuses a developer on every route, and files each refused change', async () => {
    const { org, id } = await withWebhook();
    const developer = await seedUser();
    await addMember(org.orgId, developer.id, 'developer');
    caller = sessionOf(developer);
    audit = [];

    for (const request of every(org, id)) {
      const answer = await request();
      expect(answer.status).toBe(403);
      expect(answer.text).not.toContain(HOOK_URL);
    }
    const denied = audit.filter((record) => record.outcome === 'denied').map((r) => r.action);
    expect(denied.sort()).toEqual(
      ['webhook.created', 'webhook.deleted', 'webhook.secret_rotated', 'webhook.updated'].sort(),
    );
    expect(hits).toEqual([]);
  });

  it('lets an admin manage them', async () => {
    const { org } = await withWebhook();
    const admin = await seedUser();
    await addMember(org.orgId, admin.id, 'admin');
    caller = sessionOf(admin);
    expect((await list(org)).status).toBe(200);
    expect((await create(org)).status).toBe(201);
  });
});

/* ── the plan ─────────────────────────────────────────────────────────────── */

describe('the plan', () => {
  it('refuses Free, naming Pro, and files the attempt as quotaExceeded', async () => {
    const org = await seedOrg('free');
    caller = sessionOf(org.owner);
    const answer = await create(org);
    expect(answer.status).toBe(403);
    expect(answer.body.error).toMatchObject({
      code: 'plan_limit',
      plan: { resource: 'webhooks', limit: 0, upgradeTo: 'pro' },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'webhook.created',
      outcome: 'error',
      metadata: {
        reason: 'quotaExceeded',
        limitName: 'webhooks',
        plan: 'free',
        endpointHost: 'hooks.example.com',
      },
    });
    const rows = await t.pg.query(`select 1 from webhooks where org_id = $1`, [org.orgId]);
    expect(rows.rows).toHaveLength(0);
  });

  it('allows three on Pro and refuses the fourth, naming Team', async () => {
    const org = await seedOrg('pro');
    caller = sessionOf(org.owner);
    for (let i = 0; i < 3; i += 1) expect((await create(org)).status).toBe(201);

    audit = [];
    const fourth = await create(org);
    expect(fourth.status).toBe(403);
    expect(fourth.body.error?.plan).toMatchObject({ resource: 'webhooks', upgradeTo: 'team' });
    expect(audit[0]).toMatchObject({ outcome: 'error', metadata: { reason: 'quotaExceeded' } });

    const listing = await list(org);
    expect(listing.body).toMatchObject({
      limit: { max: 3, used: 3 },
      paused: false,
      upgradeTo: 'team',
    });
  });

  it('pauses the endpoints of an organisation that downgraded, and keeps them', async () => {
    const { org, id } = await withWebhook();
    expect((await list(org)).body).toMatchObject({ paused: false, upgradeTo: null });

    await downgradeToFree(org);
    const listing = await list(org);
    expect(listing.status).toBe(200);
    expect(listing.body).toMatchObject({
      limit: { max: 0, used: 1 },
      paused: true,
      upgradeTo: 'pro',
    });
    expect(listing.body.webhooks![0]).toMatchObject({ id, state: 'paused', enabled: true });

    // Editing, switching back on and testing are refused as a plan limit…
    audit = [];
    const edit = await patch(org, id, { description: 'renamed' });
    expect(edit.status).toBe(403);
    expect(edit.body.error).toMatchObject({ code: 'plan_limit', plan: { upgradeTo: 'pro' } });
    expect(audit[0]).toMatchObject({
      action: 'webhook.updated',
      outcome: 'error',
      metadata: { reason: 'quotaExceeded', limitName: 'webhooks' },
    });
    expect((await sendTest(org, id)).body.error?.code).toBe('plan_limit');
    expect(hits).toEqual([]);

    // …switching off and deleting never are.
    expect((await patch(org, id, { enabled: false })).status).toBe(200);
    expect((await patch(org, id, { enabled: true })).status).toBe(403);
    expect((await remove(org, id)).status).toBe(204);
  });
});

/* ── creating, reading, editing, deleting ─────────────────────────────────── */

describe('an endpoint', () => {
  it('is created with a secret returned once, sealed at rest, and never shown again', async () => {
    const { org, id, secret } = await withWebhook();
    expect(secret).toMatch(/^whsec_/);

    const stored = await t.pg.query<{ secret_ciphertext: Uint8Array; secret_key_version: number }>(
      `select secret_ciphertext, secret_key_version from webhooks where id = $1`,
      [id],
    );
    expect(stored.rows[0]!.secret_key_version).toBe(1);
    expect(Buffer.from(stored.rows[0]!.secret_ciphertext).toString('latin1')).not.toContain(
      secret.slice(6),
    );

    for (const answer of [await list(org), await read(org, id), await deliveryLog(org, id)]) {
      expect(answer.status).toBe(200);
      expect(answer.text).not.toContain(secret);
      expect(answer.text).not.toContain('secret_ciphertext');
      expect(answer.text).not.toMatch(/"secret"/);
    }
    expect((await read(org, id)).body.webhook).toMatchObject({
      id,
      url: HOOK_URL,
      endpointHost: 'hooks.example.com',
      eventTypes: ['secret.updated'],
      state: 'active',
    });
  });

  it('is audited by host and events, never by URL, and never with the secret', async () => {
    const { secret } = await withWebhook(['secret.created', 'secret.deleted']);
    const created = audit.find((record) => record.action === 'webhook.created')!;
    expect(created).toMatchObject({
      outcome: 'success',
      resourceType: 'webhook',
      metadata: {
        endpointHost: 'hooks.example.com',
        eventTypes: ['secret.created', 'secret.deleted'],
      },
    });
    const text = JSON.stringify(audit);
    expect(text).not.toContain('XXXXPATHCREDENTIAL');
    expect(text).not.toContain(secret);
    expect(JSON.stringify(lines)).not.toContain(secret);
    expect(JSON.stringify(lines)).not.toContain('XXXXPATHCREDENTIAL');
  });

  it('refuses a URL this server must not fetch, as a field error', async () => {
    const org = await seedOrg('pro');
    caller = sessionOf(org.owner);
    for (const url of [
      'http://hooks.example.com/x',
      'https://127.0.0.1/x',
      'https://[::1]/x',
      'https://user:pass@hooks.example.com/x',
      'https://intranet/x',
      'https://10.0.0.8/x',
    ]) {
      const answer = await create(org, { url, eventTypes: ['secret.updated'] });
      expect(answer.status, url).toBe(422);
      expect(answer.body.error?.fields?.[0]?.field).toBe('url');
    }
    const unknownEvent = await create(org, { url: HOOK_URL, eventTypes: ['webhook.test'] });
    expect(unknownEvent.status).toBe(422);
    const none = await create(org, { url: HOOK_URL, eventTypes: [] });
    expect(none.status).toBe(422);
  });

  it('is edited, switched off and back on — which clears its failures — and deleted', async () => {
    const { org, id } = await withWebhook();
    const edited = await patch(org, id, {
      url: 'https://other.example.org/hook',
      eventTypes: ['environment.promoted'],
      description: 'deploys',
    });
    expect(edited.status).toBe(200);
    expect(edited.body.webhook).toMatchObject({
      endpointHost: 'other.example.org',
      eventTypes: ['environment.promoted'],
      description: 'deploys',
    });
    expect(audit.at(-1)).toMatchObject({
      action: 'webhook.updated',
      metadata: { endpointHost: 'other.example.org', eventTypes: ['environment.promoted'] },
    });

    expect((await patch(org, id, { url: 'https://192.168.1.1/x' })).status).toBe(422);

    await t.pg.query(
      `update webhooks set enabled = false, disabled_reason = 'failures', disabled_at = now(),
         consecutive_failures = 15, failing_since = now() - interval '2 days' where id = $1`,
      [id],
    );
    const back = await patch(org, id, { enabled: true });
    expect(back.body.webhook).toMatchObject({
      state: 'active',
      consecutiveFailures: 0,
      failingSince: null,
      disabledReason: null,
    });
    expect(audit.at(-1)).toMatchObject({ action: 'webhook.updated', metadata: { enabled: true } });

    const off = await patch(org, id, { enabled: false });
    expect(off.body.webhook).toMatchObject({ state: 'disabled', disabledReason: 'manual' });

    expect((await remove(org, id)).status).toBe(204);
    expect(audit.at(-1)).toMatchObject({
      action: 'webhook.deleted',
      metadata: { endpointHost: 'other.example.org' },
    });
    expect((await read(org, id)).status).toBe(404);
    expect((await remove(org, id)).status).toBe(404);
  });

  it('cannot be reached from another organisation', async () => {
    const { id } = await withWebhook();
    const stranger = await seedOrg('pro');
    caller = sessionOf(stranger.owner);
    expect((await read(stranger, id)).status).toBe(404);
    expect((await patch(stranger, id, { description: 'x' })).status).toBe(404);
    expect((await remove(stranger, id)).status).toBe(404);
    expect((await rotate(stranger, id)).status).toBe(404);
    expect((await sendTest(stranger, id)).status).toBe(404);
    expect((await read(stranger, 'not-a-uuid')).status).toBe(404);
  });
});

/* ── signing ──────────────────────────────────────────────────────────────── */

describe('a delivery', () => {
  it('is signed with the secret returned at creation, over the exact body, with no value in it', async () => {
    const { org, id, secret } = await withWebhook();
    const occurredAt = new Date('2026-10-20T10:00:00.000Z');
    await emit(org, [
      {
        orgId: org.orgId,
        type: 'secret.updated',
        occurredAt,
        data: eventData(org, {
          // A value smuggled past the type is dropped by the payload builder.
          secret: { name: 'DATABASE_URL', version: 3, value: 'hunter2' } as never,
        }),
      },
    ]);

    expect(hits).toHaveLength(1);
    const hit = hits[0]!;
    expect(hit.url).toBe(HOOK_URL);
    expect(hit.redirect).toBe('manual');
    expect(hit.headers.get('content-type')).toBe('application/json');
    expect(hit.headers.get('user-agent')).toBe('xecret-webhooks/1');
    expect(hit.body).toBe(
      JSON.stringify({
        type: 'secret.updated',
        timestamp: '2026-10-20T10:00:00.000Z',
        data: {
          organization: { id: org.orgId, slug: org.slug },
          actor: { type: 'user', id: org.owner.id, label: org.owner.email },
          project: { id: '0190a000-0000-7000-8000-000000000001', slug: 'api' },
          environment: { id: '0190a000-0000-7000-8000-000000000002', slug: 'production' },
          secret: { name: 'DATABASE_URL', version: 3 },
        },
      }),
    );
    expect(hit.body).not.toContain('hunter2');
    expect(await verifies(hit, secret)).toBe(true);

    const [delivery] = await deliveriesOf(id);
    expect(hit.headers.get('webhook-id')).toBe(delivery!.id);
    expect(delivery).toMatchObject({ status: 'succeeded', attempts: 1, last_status_code: 204 });
  });

  it('is signed with the new secret after a rotation, and not the old', async () => {
    const { org, id, secret } = await withWebhook();
    const rotated = await rotate(org, id);
    expect(rotated.status).toBe(200);
    expect(rotated.body.secret).toMatch(/^whsec_/);
    expect(rotated.body.secret).not.toBe(secret);
    expect(audit.at(-1)).toMatchObject({
      action: 'webhook.secret_rotated',
      metadata: { endpointHost: 'hooks.example.com' },
    });
    expect(JSON.stringify(audit)).not.toContain(rotated.body.secret!);

    const answer = await sendTest(org, id);
    expect(answer.body.delivery).toMatchObject({ status: 'succeeded', lastStatusCode: 204 });
    expect(await verifies(hits[0]!, rotated.body.secret!)).toBe(true);
    expect(await verifies(hits[0]!, secret)).toBe(false);
    expect(JSON.parse(hits[0]!.body)).toMatchObject({
      type: 'webhook.test',
      data: { organization: { id: org.orgId }, actor: { type: 'user', id: org.owner.id } },
    });
  });

  it('records a failure by a fixed category, never by what the receiver said', async () => {
    const { org, id } = await withWebhook();
    const cases: [() => Response, string, number | null][] = [
      [() => new Response('<b>stack trace with a token</b>', { status: 500 }), 'http_500', 500],
      [
        () => new Response(null, { status: 302, headers: { location: 'https://10.0.0.1/' } }),
        'redirect',
        302,
      ],
      [
        () => {
          throw new DOMException('The operation timed out.', 'TimeoutError');
        },
        'timeout',
        null,
      ],
      [
        () => {
          throw new TypeError('fetch failed: getaddrinfo ENOTFOUND');
        },
        'network',
        null,
      ],
    ];

    for (const [respond, category, statusCode] of cases) {
      receiver = respond;
      const answer = await sendTest(org, id);
      expect(answer.body.delivery).toMatchObject({
        status: 'abandoned',
        lastError: category,
        lastStatusCode: statusCode,
      });
    }
    const log = await deliveryLog(org, id);
    expect(log.text).not.toContain('stack trace');
    expect(log.text).not.toContain('ENOTFOUND');
    // The redirect was not followed.
    expect(hits.filter((hit) => hit.url.includes('10.0.0.1'))).toEqual([]);
  });

  it('re-checks the URL before every attempt', async () => {
    const { org, id } = await withWebhook();
    await t.pg.query(`update webhooks set url = 'https://localhost/x' where id = $1`, [id]);
    const answer = await sendTest(org, id);
    expect(answer.body.delivery).toMatchObject({ status: 'abandoned', lastError: 'invalid_url' });
    expect(hits).toEqual([]);
  });

  it('is rate-limited when tested', async () => {
    const { org, id } = await withWebhook();
    env['RL_MUTATION'] = { limit: vi.fn(async () => ({ success: false })) };
    const answer = await sendTest(org, id);
    expect(answer.status).toBe(429);
    expect(hits).toEqual([]);
  });

  it('is listed in the log, newest first, with its body capped', async () => {
    const { org, id } = await withWebhook();
    await sendTest(org, id);
    await sendTest(org, id);
    const [first, second] = await deliveriesOf(id);
    await t.pg.query(`update webhook_deliveries set body = $1 where id = $2`, [
      'x'.repeat(5000),
      second!.id,
    ]);

    const log = await deliveryLog(org, id, '?limit=10');
    expect(log.body.deliveries!.map((entry) => entry.id)).toEqual([second!.id, first!.id]);
    expect(log.body.deliveries![0]).toMatchObject({
      eventType: 'webhook.test',
      bodyTruncated: true,
    });
    expect(log.body.deliveries![0]!.body).toHaveLength(2048);
    expect(log.body.deliveries![1]!.bodyTruncated).toBe(false);
    expect((await deliveryLog(org, id, '?limit=0')).status).toBe(422);
  });
});

/* ── emission ─────────────────────────────────────────────────────────────── */

describe('emitting an event', () => {
  it('costs a Free organisation nothing at all', async () => {
    const { org } = await withWebhook();
    await downgradeToFree(org);
    const entitlements = await loadEntitlements(t.db, org.orgId);
    t.reset();
    deferred = [];
    service.emitWebhookEvent(servicesFor(), entitlements, {
      orgId: org.orgId,
      type: 'secret.updated',
      data: eventData(org),
    });
    await Promise.allSettled(deferred);
    expect(deferred).toEqual([]);
    expect(t.statements).toEqual([]);
    expect(hits).toEqual([]);
  });

  it('costs an organisation with no endpoints one query', async () => {
    const org = await seedOrg('pro');
    const entitlements = await loadEntitlements(t.db, org.orgId);
    t.reset();
    service.emitWebhookEvent(servicesFor(), entitlements, {
      orgId: org.orgId,
      type: 'secret.updated',
      data: eventData(org),
    });
    await Promise.allSettled(deferred);
    expect(t.statements).toHaveLength(1);
    expect(t.statements[0]!.sql).toMatch(/from "webhooks"/);
  });

  it('sends nothing to an endpoint not subscribed to the event', async () => {
    const { org, id } = await withWebhook(['secret.created']);
    await emit(org, [{ orgId: org.orgId, type: 'secret.deleted', data: eventData(org) }]);
    expect(hits).toEqual([]);
    expect(await deliveriesOf(id)).toEqual([]);
  });

  it('sends nothing to an endpoint that is switched off', async () => {
    const { org, id } = await withWebhook();
    await patch(org, id, { enabled: false });
    await emit(org, [{ orgId: org.orgId, type: 'secret.updated', data: eventData(org) }]);
    expect(hits).toEqual([]);
    expect(await deliveriesOf(id)).toEqual([]);
  });

  it('drops an event that names another organisation', async () => {
    const { org, id } = await withWebhook();
    const other = await seedOrg('pro');
    await emit(org, [
      { orgId: org.orgId, type: 'secret.updated', data: eventData(other) },
      { orgId: other.orgId, type: 'secret.updated', data: eventData(other) },
    ]);
    expect(hits).toEqual([]);
    expect(await deliveriesOf(id)).toEqual([]);
    expect(lines.some((line) => line.message.includes('another organisation'))).toBe(true);
  });

  it('queues a batch in one statement and makes at most ten first attempts inline', async () => {
    const { org, id } = await withWebhook(['secret.created', 'secret.updated']);
    const entitlements = await loadEntitlements(t.db, org.orgId);
    const events = Array.from({ length: 15 }, (_, index) => ({
      orgId: org.orgId,
      type: (index % 2 === 0 ? 'secret.created' : 'secret.updated') as 'secret.created',
      data: eventData(org, { secret: { name: `KEY_${index}`, version: 1 } }),
    }));

    t.reset();
    service.emitWebhookEvents(servicesFor(), entitlements, events);
    await Promise.allSettled(deferred);

    const statements = t.statements.map((statement) => statement.sql);
    expect(
      statements.filter((sql) => /^\s*select .* from "webhooks"/i.test(sql) && /&&/.test(sql)),
    ).toHaveLength(1);
    expect(
      statements.filter((sql) => /^\s*insert into "webhook_deliveries"/i.test(sql)),
    ).toHaveLength(1);
    expect(hits).toHaveLength(10);

    const rows = await deliveriesOf(id);
    expect(rows).toHaveLength(15);
    expect(rows.filter((row) => row.status === 'succeeded')).toHaveLength(10);
    const owed = rows.filter((row) => row.status === 'pending');
    expect(owed).toHaveLength(5);
    for (const row of owed) {
      expect(row.attempts).toBe(0);
      expect(row.next_attempt_at!.getTime()).toBeLessThanOrEqual(Date.now());
    }

    // The sweep sends the rest.
    hits = [];
    expect(await service.sweepWebhookDeliveries(servicesFor())).toBe(5);
    expect(hits).toHaveLength(5);
    expect((await deliveriesOf(id)).every((row) => row.status === 'succeeded')).toBe(true);
  });

  it('never throws, and never fails the caller, when the database does', async () => {
    const { org } = await withWebhook();
    const entitlements = await loadEntitlements(t.db, org.orgId);
    const broken = { ...servicesFor(), db: null } as unknown as ServiceContext;
    expect(() =>
      service.emitWebhookEvent(broken, entitlements, {
        orgId: org.orgId,
        type: 'secret.updated',
        data: eventData(org),
      }),
    ).not.toThrow();
    await Promise.allSettled(deferred);
    expect(lines.some((line) => line.level === 'error')).toBe(true);
  });
});

/* ── retries and giving up ────────────────────────────────────────────────── */

describe('a failing endpoint', () => {
  it('is retried at nextAttemptAt, and not before', async () => {
    const { org, id } = await withWebhook();
    receiver = () => new Response('nope', { status: 500 });
    const before = Date.now();
    await emit(org, [{ orgId: org.orgId, type: 'secret.updated', data: eventData(org) }]);

    const [delivery] = await deliveriesOf(id);
    expect(delivery).toMatchObject({
      status: 'pending',
      attempts: 1,
      last_status_code: 500,
      last_error: 'http_500',
    });
    const due = delivery!.next_attempt_at!.getTime();
    expect(due).toBeGreaterThanOrEqual(before + 59_000);
    expect(due).toBeLessThanOrEqual(Date.now() + 61_000);

    // Not yet due: the sweep leaves it.
    hits = [];
    expect(await service.sweepWebhookDeliveries(servicesFor())).toBe(0);
    expect(hits).toEqual([]);

    // Due: the sweep sends it, and the second failure waits five minutes.
    await t.pg.query(
      `update webhook_deliveries set next_attempt_at = now() - interval '1 second' where id = $1`,
      [delivery!.id],
    );
    const sweptAt = Date.now();
    expect(await service.sweepWebhookDeliveries(servicesFor())).toBe(1);
    const [again] = await deliveriesOf(id);
    expect(again).toMatchObject({ status: 'pending', attempts: 2 });
    expect(again!.next_attempt_at!.getTime()).toBeGreaterThanOrEqual(sweptAt + 299_000);
    expect(hits[0]!.headers.get('webhook-id')).toBe(delivery!.id);

    // And a success ends it.
    receiver = () => new Response(null, { status: 200 });
    await t.pg.query(
      `update webhook_deliveries set next_attempt_at = now() - interval '1 second' where id = $1`,
      [delivery!.id],
    );
    await service.sweepWebhookDeliveries(servicesFor());
    expect((await deliveriesOf(id))[0]).toMatchObject({ status: 'succeeded', attempts: 3 });
    const [hook] = (
      await t.pg.query<{ consecutive_failures: number; failing_since: Date | null }>(
        `select consecutive_failures, failing_since from webhooks where id = $1`,
        [id],
      )
    ).rows;
    expect(hook).toEqual({ consecutive_failures: 0, failing_since: null });
  });

  it('is abandoned after the last attempt', async () => {
    const { org, id } = await withWebhook();
    receiver = () => new Response(null, { status: 503 });
    await emit(org, [{ orgId: org.orgId, type: 'secret.updated', data: eventData(org) }]);
    const [delivery] = await deliveriesOf(id);
    await t.pg.query(
      `update webhook_deliveries set attempts = 7, next_attempt_at = now() - interval '1 second' where id = $1`,
      [delivery!.id],
    );

    await service.sweepWebhookDeliveries(servicesFor());
    expect((await deliveriesOf(id))[0]).toMatchObject({
      status: 'abandoned',
      attempts: 8,
      next_attempt_at: null,
      last_error: 'http_503',
    });
    expect((await deliveriesOf(id))[0]!.completed_at).not.toBeNull();
  });

  it('is switched off after sustained failure: audited by the system, and the admins emailed', async () => {
    const { org, id } = await withWebhook();
    const admin = await seedUser();
    await addMember(org.orgId, admin.id, 'admin');
    const developer = await seedUser();
    await addMember(org.orgId, developer.id, 'developer');
    await t.pg.query(
      `update webhooks set consecutive_failures = 14, failing_since = now() - interval '2 days' where id = $1`,
      [id],
    );
    receiver = () => new Response(null, { status: 410 });

    await emit(org, [{ orgId: org.orgId, type: 'secret.updated', data: eventData(org) }]);

    const [hook] = (
      await t.pg.query<{ enabled: boolean; disabled_reason: string; consecutive_failures: number }>(
        `select enabled, disabled_reason, consecutive_failures from webhooks where id = $1`,
        [id],
      )
    ).rows;
    expect(hook).toEqual({ enabled: false, disabled_reason: 'failures', consecutive_failures: 15 });

    const filed = await t.pg.query<{
      actor_type: string;
      actor_id: string | null;
      resource_id: string;
      metadata: Record<string, unknown>;
    }>(
      `select actor_type, actor_id, resource_id, metadata from audit_logs
       where org_id = $1 and action = 'webhook.disabled'`,
      [org.orgId],
    );
    expect(filed.rows).toHaveLength(1);
    expect(filed.rows[0]).toMatchObject({
      actor_type: 'system',
      actor_id: null,
      resource_id: id,
      metadata: { endpointHost: 'hooks.example.com' },
    });

    expect(mail.map((message) => message.to).sort()).toEqual([admin.email, org.owner.email].sort());
    for (const message of mail) {
      expect(message.subject).toMatch(/switched off/);
      expect(message.text).toContain('hooks.example.com');
      expect(message.text).toContain('15 deliveries in a row failed');
      expect(message.text).toContain(`${ORIGIN}/app/${org.slug}/settings`);
      expect(message.text + message.html).not.toContain('XXXXPATHCREDENTIAL');
    }

    // Once: a further failure files and mails nothing more.
    mail = [];
    await emit(org, [{ orgId: org.orgId, type: 'secret.updated', data: eventData(org) }]);
    expect(mail).toEqual([]);
  });

  it('is switched off and audited even when the mail cannot be sent', async () => {
    const { org, id } = await withWebhook();
    await t.pg.query(
      `update webhooks set consecutive_failures = 20, failing_since = now() - interval '3 days' where id = $1`,
      [id],
    );
    receiver = () => new Response(null, { status: 500 });
    mailStatus = 500;

    await emit(org, [{ orgId: org.orgId, type: 'secret.updated', data: eventData(org) }]);
    const filed = await t.pg.query(
      `select 1 from audit_logs where org_id = $1 and action = 'webhook.disabled'`,
      [org.orgId],
    );
    expect(filed.rows).toHaveLength(1);
    expect(lines.some((line) => line.level === 'error' && /email/.test(line.message))).toBe(true);
  });

  it('is not switched off by failures that have not lasted a day', async () => {
    const { org, id } = await withWebhook();
    await t.pg.query(
      `update webhooks set consecutive_failures = 40, failing_since = now() - interval '1 hour' where id = $1`,
      [id],
    );
    receiver = () => new Response(null, { status: 500 });
    await emit(org, [{ orgId: org.orgId, type: 'secret.updated', data: eventData(org) }]);
    const [hook] = (
      await t.pg.query<{ enabled: boolean }>(`select enabled from webhooks where id = $1`, [id])
    ).rows;
    expect(hook!.enabled).toBe(true);
    expect(mail).toEqual([]);
  });
});

/* ── the sweep's other rules ──────────────────────────────────────────────── */

describe('the sweep', () => {
  it('abandons, unsent, what is owed to an endpoint switched off since', async () => {
    const { org, id } = await withWebhook();
    const [owed] = await enqueueDeliveries(t.db, [
      { webhookId: id, orgId: org.orgId, eventType: 'secret.updated', body: '{}' },
    ]);
    await patch(org, id, { enabled: false });

    await service.sweepWebhookDeliveries(servicesFor());
    expect(hits).toEqual([]);
    const [row] = await deliveriesOf(id);
    expect(row).toMatchObject({ id: owed, status: 'abandoned', attempts: 0 });
    expect(row!.last_error).toMatch(/switched off/);
  });

  it('abandons, unsent, what is owed by an organisation whose plan allows none', async () => {
    const { org, id } = await withWebhook();
    await enqueueDeliveries(t.db, [
      { webhookId: id, orgId: org.orgId, eventType: 'secret.updated', body: '{}' },
    ]);
    await downgradeToFree(org);

    await service.sweepWebhookDeliveries(servicesFor());
    expect(hits).toEqual([]);
    expect((await deliveriesOf(id))[0]).toMatchObject({ status: 'abandoned', attempts: 0 });
  });

  it('keeps at most four deliveries in flight', async () => {
    const { org, id } = await withWebhook();
    await enqueueDeliveries(
      t.db,
      Array.from({ length: 12 }, () => ({
        webhookId: id,
        orgId: org.orgId,
        eventType: 'secret.updated',
        body: '{}',
      })),
    );
    let inFlight = 0;
    let peak = 0;
    receiver = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return new Response(null, { status: 204 });
    };
    expect(await service.sweepWebhookDeliveries(servicesFor())).toBe(12);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  // Review round 1, M4: one claim of twenty-five per run was the ceiling.
  it('keeps claiming while it has time, past one batch', async () => {
    const { org, id } = await withWebhook();
    const owed = service.WEBHOOK_SWEEP_BATCH * 2 + 10;
    await enqueueDeliveries(
      t.db,
      Array.from({ length: owed }, () => ({
        webhookId: id,
        orgId: org.orgId,
        eventType: 'secret.updated',
        body: '{}',
      })),
    );
    expect(await service.sweepWebhookDeliveries(servicesFor())).toBe(owed);
    expect(hits).toHaveLength(owed);
    expect((await deliveriesOf(id)).every((row) => row.status === 'succeeded')).toBe(true);
  });

  it('stops starting deliveries when its time is up, and hands the rest back due', async () => {
    const { org, id } = await withWebhook();
    await enqueueDeliveries(
      t.db,
      Array.from({ length: service.WEBHOOK_SWEEP_BATCH }, () => ({
        webhookId: id,
        orgId: org.orgId,
        eventType: 'secret.updated',
        body: '{}',
      })),
    );
    receiver = async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return new Response(null, { status: 204 });
    };

    const attempted = await service.sweepWebhookDeliveries(servicesFor(), { budgetMs: 60 });
    expect(attempted).toBeGreaterThan(0);
    expect(attempted).toBeLessThan(service.WEBHOOK_SWEEP_BATCH);

    const rows = await deliveriesOf(id);
    // Nothing is left claimed for the stale-claim rule to find in five minutes.
    expect(rows.filter((row) => row.status === 'delivering')).toEqual([]);
    const handedBack = rows.filter((row) => row.status === 'pending');
    expect(handedBack).toHaveLength(service.WEBHOOK_SWEEP_BATCH - attempted);
    for (const row of handedBack) {
      expect(row.attempts).toBe(0);
      expect(row.next_attempt_at!.getTime()).toBeLessThanOrEqual(Date.now());
    }
  });

  it('sends a quiet organisation’s one delivery in the same run as another’s backlog', async () => {
    const busy = await withWebhook();
    await enqueueDeliveries(
      t.db,
      Array.from({ length: 3000 }, () => ({
        webhookId: busy.id,
        orgId: busy.org.orgId,
        eventType: 'secret.updated',
        body: '{}',
      })),
    );
    await t.pg.query(
      `update webhook_deliveries set next_attempt_at = now() - interval '1 hour' where webhook_id = $1`,
      [busy.id],
    );
    const quiet = await withWebhook();
    const [single] = await enqueueDeliveries(t.db, [
      { webhookId: quiet.id, orgId: quiet.org.orgId, eventType: 'secret.updated', body: '{}' },
    ]);

    // A run that has time for no more than its first claim still sends it.
    receiver = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(null, { status: 204 });
    };
    await service.sweepWebhookDeliveries(servicesFor(), { budgetMs: 150 });
    expect(hits.map((hit) => hit.headers.get('webhook-id'))).toContain(single);
    expect((await deliveriesOf(quiet.id))[0]).toMatchObject({ status: 'succeeded' });
  });
});

/* ── one event per kind of change, for a batch ────────────────────────────── */

describe('a batch write', () => {
  async function scopeOf(org: Org) {
    return {
      organization: { id: org.orgId, slug: org.slug },
      project: { id: '0190a000-0000-7000-8000-000000000001', slug: 'api' },
      environment: { id: '0190a000-0000-7000-8000-000000000002', slug: 'production' },
      entitlements: await loadEntitlements(t.db, org.orgId),
    } as unknown as EnvironmentScope;
  }

  it('queues one event per kind of change, listing the secrets, whatever its size (review round 1, M4)', async () => {
    const { org, id } = await withWebhook(['secret.created', 'secret.updated', 'secret.deleted']);
    const results = [
      ...Array.from({ length: 400 }, (_, index) => ({
        status: 'created' as const,
        name: `NEW_${index}`,
        version: 1,
      })),
      { status: 'updated' as const, name: 'DATABASE_URL', version: 7 },
      { status: 'updated' as const, name: 'REDIS_URL', version: 3 },
      { status: 'unchanged' as const, name: 'PORT', version: 2 },
    ];

    // What the import route sends after it lands.
    changeEvents.emitSecretChanges(
      servicesFor(),
      await scopeOf(org),
      caller,
      changeEvents.batchChanges(results, [{ name: 'OLD_KEY' }]),
    );
    await Promise.allSettled(deferred);

    const rows = await deliveriesOf(id);
    expect(rows.map((row) => row.event_type).sort()).toEqual([
      'secret.created',
      'secret.deleted',
      'secret.updated',
    ]);
    const bodies = new Map(
      hits.map((hit) => {
        const payload = JSON.parse(hit.body) as { type: string; data: Record<string, unknown> };
        return [payload.type, payload.data] as const;
      }),
    );
    const created = bodies.get('secret.created')!;
    expect(created['secret']).toBeUndefined();
    expect(created['secrets']).toHaveLength(400);
    expect((created['secrets'] as unknown[])[0]).toEqual({ name: 'NEW_0', version: 1 });
    expect(created['counts']).toEqual({ created: 400 });
    expect(bodies.get('secret.updated')!['secrets']).toEqual([
      { name: 'DATABASE_URL', version: 7 },
      { name: 'REDIS_URL', version: 3 },
    ]);
    // A kind with one secret is the event a single write sends.
    expect(bodies.get('secret.deleted')!['secret']).toEqual({ name: 'OLD_KEY' });
    expect(bodies.get('secret.deleted')!['secrets']).toBeUndefined();
  });
});

/* ── the scheduled routes ─────────────────────────────────────────────────── */

describe('the scheduled routes', () => {
  const post = (handler: (request: Request) => Promise<Response>, path: string, header?: string) =>
    handler(
      new Request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: header === undefined ? {} : { [scheduled.SCHEDULED_HEADER]: header },
      }),
    );

  it('answer 404, with no body, to anything but the scheduler', async () => {
    for (const [handler, path] of [
      [notificationsRoute.POST, scheduled.NOTIFICATIONS_PATH],
      [pruneRoute.POST, scheduled.PRUNE_PATH],
    ] as const) {
      for (const header of [undefined, 'guess', '']) {
        const response = await post(handler, path, header);
        expect(response.status).toBe(404);
        expect(await response.text()).toBe('');
      }
    }
    expect(context.createServiceContext).not.toHaveBeenCalled();
  });

  it('run the sweeps, and the pruning, when the scheduler calls', async () => {
    const { org, id } = await withWebhook();
    const [due, old, stillOwed] = await enqueueDeliveries(t.db, [
      { webhookId: id, orgId: org.orgId, eventType: 'secret.updated', body: '{}' },
      { webhookId: id, orgId: org.orgId, eventType: 'secret.updated', body: '{}' },
      { webhookId: id, orgId: org.orgId, eventType: 'secret.updated', body: '{}' },
    ]);
    await t.pg.query(
      `update webhook_deliveries set status = 'succeeded', created_at = now() - interval '40 days' where id = $1`,
      [old],
    );
    await t.pg.query(
      `update webhook_deliveries set created_at = now() - interval '40 days', next_attempt_at = now() + interval '1 hour' where id = $1`,
      [stillOwed],
    );

    const app = async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === scheduled.NOTIFICATIONS_PATH) return notificationsRoute.POST(request);
      if (path === scheduled.PRUNE_PATH) return pruneRoute.POST(request);
      return new Response(null, { status: 404 });
    };

    await scheduled.runScheduledJobs(
      app,
      ORIGIN,
      scheduled.jobsForCron(scheduled.FIVE_MINUTE_CRON),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.headers.get('webhook-id')).toBe(due);

    await scheduled.runScheduledJob(app, ORIGIN, scheduled.PRUNE_PATH);
    const remaining = (await deliveriesOf(id)).map((row) => row.id);
    expect(remaining).toContain(due);
    expect(remaining).toContain(stillOwed);
    expect(remaining).not.toContain(old);
  });

  it('are dispatched by the expression that fired', () => {
    expect(scheduled.jobsForCron(scheduled.FIVE_MINUTE_CRON)).toEqual([
      scheduled.NOTIFICATIONS_PATH,
    ]);
    expect(scheduled.jobsForCron(scheduled.HOURLY_CRON)).toEqual([
      scheduled.VAULT_PURGE_PATH,
      scheduled.PRUNE_PATH,
    ]);
  });

  it('run every job even when one fails, and then report the failure', async () => {
    const seen: string[] = [];
    const app = async (request: Request) => {
      const path = new URL(request.url).pathname;
      seen.push(path);
      return new Response(null, { status: path === '/first' ? 500 : 200 });
    };
    await expect(scheduled.runScheduledJobs(app, ORIGIN, ['/first', '/second'])).rejects.toThrow(
      /\/first answered 500/,
    );
    expect(seen).toEqual(['/first', '/second']);
  });
});

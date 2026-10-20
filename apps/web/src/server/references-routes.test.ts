import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AuditRecord } from '@xecret/core/audit';
import type { DeclaredReference } from '@xecret/core/references';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '@xecret/db/testing';
import type { TestDatabase } from '@xecret/db/testing';
import type { Principal } from './actor';
import { createLogger } from './logging';
import type { RequestLog } from './logging';

/**
 * Secret references and environment inheritance (P19 §1), end to end: the pull,
 * the template writes, the parent route, and the deletions that must not strand
 * a template — against a real database with every migration applied.
 *
 * ── What is real, and what is stubbed ──
 * Real: the routes and `authenticatedRoute`; tenancy, `can()` and the
 * entitlement engine reading memberships and the subscription row from PGlite;
 * every repository; the reference graph and its checks. Stubbed: who is asking,
 * the audit sink (captured) and the logger. No value is ever decrypted here —
 * the server cannot — so ciphertexts are shape-valid placeholders and the
 * question every test asks is what the server stores, refuses and carries.
 */

const ORIGIN = 'https://xecret.test';

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

const pullRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/pull/route');
const secretsRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/secrets/route');
const secretRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/secrets/[name]/route');
const parentRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/parent/route');
const environmentRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/route');
const tokensRoute = await import('@/app/api/orgs/[orgSlug]/tokens/service/route');
const { createSecret } = await import('@xecret/db/repositories');

let t: TestDatabase;
let audit: AuditRecord[] = [];
let deferred: Promise<unknown>[] = [];
let caller: Principal;

beforeAll(async () => {
  t = await createTestDatabase();
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
      envelope: {},
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
  actor.authenticate.mockImplementation(async () => ({
    principal: caller,
    source: caller.kind === 'user' ? 'cookie' : 'bearer',
  }));
  auditSink.write.mockImplementation(async (events: AuditRecord[]) => {
    audit.push(...events);
  });
});

/* ── fixtures ─────────────────────────────────────────────────────────────── */

const blob = (label: string) =>
  `xk2.gcm.${Buffer.from(`${label}`.padEnd(48, '.')).toString('base64url')}`;
const HMAC = 'A'.repeat(43);
const OTHER_HMAC = 'B'.repeat(43);

async function seedUser(): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `p19-${id.slice(0, 8)}@example.com`;
  await t.pg.query(
    `insert into users (id, workos_user_id, email, email_verified) values ($1, $2, $3, true)`,
    [id, `user_${id.slice(0, 8)}`, email],
  );
  return { id, email };
}

function sessionOf(user: { id: string; email: string }): Principal {
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
  owner: { id: string; email: string };
}

async function seedOrg(plan: 'free' | 'pro' | 'team'): Promise<Org> {
  const owner = await seedUser();
  const orgId = randomUUID();
  const slug = `acme-${orgId.slice(0, 8)}`;
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
  return { orgId, slug, owner };
}

async function addMember(orgId: string, userId: string, role: string): Promise<void> {
  await t.pg.query(`insert into org_members (id, org_id, user_id, role) values ($1, $2, $3, $4)`, [
    randomUUID(),
    orgId,
    userId,
    role,
  ]);
}

async function seedProject(org: Org, slug = 'api'): Promise<string> {
  const id = randomUUID();
  await t.pg.query(
    `insert into projects (id, org_id, name, slug, created_by) values ($1, $2, $3, $4, $5)`,
    [id, org.orgId, slug, slug, org.owner.id],
  );
  return id;
}

interface Env {
  id: string;
  keyId: string;
  slug: string;
}

async function seedEnv(
  org: Org,
  projectId: string,
  slug: string,
  options: { parentId?: string; production?: boolean; mode?: 'e2ee' | 'server' } = {},
): Promise<Env> {
  const id = randomUUID();
  const keyId = randomUUID();
  await t.pg.query(
    `insert into environments (id, project_id, name, slug, encryption_mode, is_production, parent_environment_id)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      projectId,
      slug,
      slug,
      options.mode ?? 'e2ee',
      options.production ?? false,
      options.parentId ?? null,
    ],
  );
  await t.pg.query(
    `insert into env_data_keys (id, environment_id, version, status, created_by) values ($1, $2, 1, 'active', $3)`,
    [keyId, id, org.owner.id],
  );
  return { id, keyId, slug };
}

async function grantTo(
  env: Env,
  recipient: { memberUserId?: string; serviceTokenId?: string },
  signer: string,
) {
  await t.pg.query(
    `insert into env_key_grants (id, env_data_key_id, member_user_id, service_token_id, edk_sealed, ehk_sealed, recipient_public_key, signature, signed_by_user_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      randomUUID(),
      env.keyId,
      recipient.memberUserId ?? null,
      recipient.serviceTokenId ?? null,
      new TextEncoder().encode(`xk2.x25519.${'A'.repeat(80)}`),
      new TextEncoder().encode(`xk2.x25519.${'A'.repeat(80)}`),
      new Uint8Array(32),
      new TextEncoder().encode(`xk2.ed25519.${'A'.repeat(86)}`),
      signer,
    ],
  );
}

async function seedSecret(
  org: Org,
  env: Env,
  name: string,
  references: DeclaredReference[] | null = null,
): Promise<string> {
  const id = randomUUID();
  await createSecret(t.db, {
    id,
    orgId: org.orgId,
    environmentId: env.id,
    name,
    valueType: references === null ? 'string' : 'template',
    payload: {
      mode: 'e2ee',
      envDataKeyId: env.keyId,
      ciphertext: new TextEncoder().encode(blob(name)),
      clientAlgorithm: 'xk2.gcm',
    },
    valueHmac: new Uint8Array(32),
    declaredReferences: references,
    writer: { userId: org.owner.id },
  });
  return id;
}

async function seedServiceToken(org: Org, projectId: string, env: Env): Promise<Principal> {
  const tokenId = randomUUID();
  await t.pg.query(
    `insert into service_tokens (id, org_id, project_id, environment_id, name, token_hash, token_prefix, created_by, public_key, key_algorithm)
     values ($1, $2, $3, $4, 'ci', $5, 'xst_x', $6, $7, 'X25519')`,
    [
      tokenId,
      org.orgId,
      projectId,
      env.id,
      new TextEncoder().encode(tokenId),
      org.owner.id,
      new Uint8Array(32),
    ],
  );
  await grantTo(env, { serviceTokenId: tokenId }, org.owner.id);
  return {
    kind: 'serviceToken',
    tokenId,
    tokenName: 'ci',
    orgId: org.orgId,
    projectId,
    environmentId: env.id,
    accessLevel: 'read',
  };
}

/* ── requests ─────────────────────────────────────────────────────────────── */

/** The parts of a response body these tests read. */
interface SecretShape {
  name: string;
  template?: true;
  references?: unknown[];
}

interface LayerShape {
  environmentId: string;
  environmentSlug: string;
  parentEnvironmentId: string | null;
  keys: {
    encryptionMode: string;
    environmentId: string;
    activeEdk: { id: string };
    myGrant: { edkSealed: string };
  } | null;
  secrets: SecretShape[];
}

interface Body {
  error?: {
    code?: string;
    message?: string;
    plan?: { resource?: string; upgradeTo?: string | null };
    fields?: { field: string; message: string }[];
  };
  bundleVersion?: number;
  environment?: { slug?: string; parent?: string | null; parentEnvironmentId?: string | null };
  secrets?: SecretShape[];
  layers?: LayerShape[];
}

interface Answer {
  status: number;
  body: Body;
}

// `never`, because each route names its own params type and a test hands every
// one of them a plain record — the cast at the call site is the one place that
// is true.
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
  return { status: response.status, body: text === '' ? {} : (JSON.parse(text) as Body) };
}

function envPath(org: Org, env: string, rest = '') {
  return {
    path: `/api/orgs/${org.slug}/projects/api/environments/${env}${rest}`,
    params: { orgSlug: org.slug, projectSlug: 'api', envSlug: env },
  };
}

function pull(org: Org, env: string, resolved = true) {
  const { path, params } = envPath(org, env, `/pull?format=json${resolved ? '&bundle=2' : ''}`);
  return call(pullRoute.GET, 'GET', path, params);
}

/** The dashboard's read: this environment's own values, nothing resolved. */
function pullOwn(org: Org, env: string) {
  const { path, params } = envPath(org, env, '/pull?bundle=2&layers=none');
  return call(pullRoute.GET, 'GET', path, params);
}

function createTemplate(
  org: Org,
  env: Env,
  name: string,
  references: unknown[] | undefined,
  valueType = 'template',
) {
  const { path, params } = envPath(org, env.slug, '/secrets');
  return call(secretsRoute.POST, 'POST', path, params, {
    id: randomUUID(),
    name,
    valueType,
    value: {
      ciphertext: blob(name),
      clientAlgorithm: 'xk2.gcm',
      envDataKeyId: env.keyId,
      valueHmac: HMAC,
    },
    ...(references === undefined ? {} : { references }),
  });
}

function setParent(org: Org, env: string, parent: string | null) {
  const { path, params } = envPath(org, env, '/parent');
  return call(parentRoute.PUT, 'PUT', path, params, { parent });
}

const errorMessage = (answer: Answer) => String(answer.body.error?.message ?? '');

/* ── the pull ─────────────────────────────────────────────────────────────── */

describe('pulling an environment that uses neither feature', () => {
  it('is the version 1 bundle, unchanged, whatever the client asks for', async () => {
    const org = await seedOrg('pro');
    const project = await seedProject(org);
    const env = await seedEnv(org, project, 'development');
    await grantTo(env, { memberUserId: org.owner.id }, org.owner.id);
    await seedSecret(org, env, 'PLAIN');
    caller = sessionOf(org.owner);

    for (const resolved of [false, true]) {
      const answer = await pull(org, 'development', resolved);
      expect(answer.status).toBe(200);
      expect(answer.body.bundleVersion).toBe(1);
      expect(answer.body.layers).toBeUndefined();
    }
  });

  it('costs no statement the feature added', async () => {
    const org = await seedOrg('pro');
    const project = await seedProject(org);
    const env = await seedEnv(org, project, 'development');
    await grantTo(env, { memberUserId: org.owner.id }, org.owner.id);
    await seedSecret(org, env, 'PLAIN');
    caller = sessionOf(org.owner);

    t.reset();
    await pull(org, 'development');
    const statements = t.statements.map((statement) => statement.sql);
    // Nothing about the graph: no metadata read, no inbound-reference search,
    // no layered read, no batched grant lookup.
    expect(statements.some((sql) => sql.includes('declared_references" @>'))).toBe(false);
    expect(
      statements.filter((sql) => sql.includes('"environments"."parent_environment_id" in')),
    ).toEqual([]);
    expect(statements.some((sql) => /"secrets"\."environment_id" in \(/.test(sql))).toBe(false);
    // The bundle itself: the statements a version 1 pull already made, and no more.
    expect(
      statements.some((sql) => sql.includes('"env_key_grants"') && sql.includes(' in (')),
    ).toBe(false);
  });
});

describe('pulling an environment that inherits', () => {
  async function inheriting() {
    const org = await seedOrg('pro');
    const project = await seedProject(org);
    const base = await seedEnv(org, project, 'base');
    const staging = await seedEnv(org, project, 'staging', { parentId: base.id });
    for (const env of [base, staging])
      await grantTo(env, { memberUserId: org.owner.id }, org.owner.id);
    await seedSecret(org, base, 'HOST');
    await seedSecret(org, base, 'URL', [{ name: 'HOST', environmentId: null }]);
    await seedSecret(org, staging, 'HOST');
    caller = sessionOf(org.owner);
    return { org, project, base, staging };
  }

  it('refuses a client that cannot resolve, rather than serve it a partial view', async () => {
    const { org } = await inheriting();
    const answer = await pull(org, 'staging', false);
    expect(answer.status).toBe(409);
    expect(errorMessage(answer)).toMatch(/^resolution_unsupported/);
  });

  it('carries the parent whole, with the caller’s grant on it, and audits the read there', async () => {
    const { org, base, staging } = await inheriting();
    const answer = await pull(org, 'staging');
    expect(answer.status).toBe(200);
    expect(answer.body.bundleVersion).toBe(2);
    expect(answer.body.environment).toMatchObject({
      slug: 'staging',
      parentEnvironmentId: base.id,
    });
    expect(answer.body.secrets!.map((secret) => secret.name)).toEqual(['HOST']);

    const layer = answer.body.layers![0]!;
    expect(layer).toMatchObject({
      environmentId: base.id,
      environmentSlug: 'base',
      parentEnvironmentId: null,
    });
    expect(layer.keys).toMatchObject({
      encryptionMode: 'e2ee',
      environmentId: base.id,
      activeEdk: { id: base.keyId },
    });
    expect(layer.keys!.myGrant.edkSealed).toMatch(/^xk2\.x25519\./);
    expect(layer.secrets.map((secret) => secret.name)).toEqual(['HOST', 'URL']);
    expect(layer.secrets.find((secret) => secret.name === 'URL')).toMatchObject({
      template: true,
      references: [{ name: 'HOST', environmentId: null }],
    });

    const reads = audit.filter((record) => record.action === 'secret.read');
    expect(reads.map((record) => [record.environmentId, record.metadata.reason ?? null])).toEqual([
      [staging.id, null],
      [base.id, 'inherited'],
    ]);
    expect(reads[1]!.metadata).toMatchObject({ contextEnvironmentSlug: 'staging', secretCount: 2 });
  });

  it('still resolves after a downgrade — the pull never asks the plan', async () => {
    const { org } = await inheriting();
    await t.pg.query(`delete from org_subscriptions where org_id = $1`, [org.orgId]);
    expect((await pull(org, 'staging')).status).toBe(200);
  });

  it('refuses a reader who cannot read the parent', async () => {
    // Team, where production is deny-by-default for a developer: staging
    // inherits from production, and a developer may read staging only.
    const org = await seedOrg('team');
    const project = await seedProject(org);
    const production = await seedEnv(org, project, 'production', { production: true });
    const staging = await seedEnv(org, project, 'staging', { parentId: production.id });
    const developer = await seedUser();
    await addMember(org.orgId, developer.id, 'developer');
    await grantTo(staging, { memberUserId: developer.id }, org.owner.id);
    await seedSecret(org, production, 'DB_PASSWORD');
    caller = sessionOf(developer);

    const answer = await pull(org, 'staging');
    expect(answer.status).toBe(403);
    expect(errorMessage(answer)).toMatch(/cannot read/);
  });

  it('answers no_key_grant for a parent nobody has shared with the caller', async () => {
    const org = await seedOrg('pro');
    const project = await seedProject(org);
    const base = await seedEnv(org, project, 'base');
    const staging = await seedEnv(org, project, 'staging', { parentId: base.id });
    await grantTo(staging, { memberUserId: org.owner.id }, org.owner.id);
    await seedSecret(org, base, 'HOST');
    caller = sessionOf(org.owner);

    const answer = await pull(org, 'staging');
    expect(answer.status).toBe(409);
    expect(errorMessage(answer)).toMatch(/^no_key_grant: .*base/);
  });
});

describe('pulling an environment whose template reaches elsewhere', () => {
  it('carries only the referenced secret, and files the read where it happened', async () => {
    const org = await seedOrg('pro');
    const project = await seedProject(org);
    const shared = await seedEnv(org, project, 'shared');
    const app = await seedEnv(org, project, 'app');
    for (const env of [shared, app])
      await grantTo(env, { memberUserId: org.owner.id }, org.owner.id);
    const hostId = await seedSecret(org, shared, 'DB_HOST');
    await seedSecret(org, shared, 'UNRELATED');
    await seedSecret(org, app, 'URL', [
      { environment: 'shared', name: 'DB_HOST', environmentId: shared.id },
    ]);
    caller = sessionOf(org.owner);

    const answer = await pull(org, 'app');
    expect(answer.status).toBe(200);
    const layer = answer.body.layers![0]!;
    expect(layer.environmentSlug).toBe('shared');
    expect(layer.secrets.map((secret) => secret.name)).toEqual(['DB_HOST']);

    const referenced = audit.find(
      (record) => record.action === 'secret.read' && record.resourceType === 'secret',
    );
    expect(referenced).toMatchObject({
      resourceId: hostId,
      environmentId: shared.id,
      metadata: {
        secretName: 'DB_HOST',
        referringSecretName: 'URL',
        contextEnvironmentSlug: 'app',
        reason: 'referenced',
      },
    });
  });

  it('lets a service token resolve a template within its own environment', async () => {
    const org = await seedOrg('pro');
    const project = await seedProject(org);
    const env = await seedEnv(org, project, 'ci');
    await seedSecret(org, env, 'HOST');
    await seedSecret(org, env, 'URL', [{ name: 'HOST', environmentId: null }]);
    caller = await seedServiceToken(org, project, env);

    const answer = await pull(org, 'ci');
    expect(answer.status).toBe(200);
    expect(answer.body.bundleVersion).toBe(2);
    expect(answer.body.layers).toEqual([]);
  });
});

describe('pulling only an environment’s own values (layers=none)', () => {
  // Team, where production is deny-by-default for a developer: staging inherits
  // from production and holds a template reaching into it, and the developer may
  // read staging only. A resolved pull is refused them; their own view is not.
  async function walledOff() {
    const org = await seedOrg('team');
    const project = await seedProject(org);
    const production = await seedEnv(org, project, 'production', { production: true });
    const staging = await seedEnv(org, project, 'staging', { parentId: production.id });
    const developer = await seedUser();
    await addMember(org.orgId, developer.id, 'developer');
    await grantTo(staging, { memberUserId: developer.id }, org.owner.id);
    await seedSecret(org, production, 'DB_PASSWORD');
    await seedSecret(org, staging, 'HOST');
    await seedSecret(org, staging, 'URL', [
      { environment: 'production', name: 'DB_PASSWORD', environmentId: production.id },
    ]);
    caller = sessionOf(developer);
    return { org, production, staging };
  }

  it('serves the version 2 shape with no layers to a reader who cannot read beyond it', async () => {
    const { org, production, staging } = await walledOff();
    expect((await pull(org, 'staging')).status).toBe(403);
    audit.length = 0;

    const answer = await pullOwn(org, 'staging');
    expect(answer.status).toBe(200);
    expect(answer.body.bundleVersion).toBe(2);
    expect(answer.body.layers).toEqual([]);
    expect(answer.body.environment).toMatchObject({
      slug: 'staging',
      parentEnvironmentId: production.id,
    });
    expect(answer.body.secrets!.map((secret) => secret.name)).toEqual(['HOST', 'URL']);
    expect(answer.body.secrets!.find((secret) => secret.name === 'URL')).toMatchObject({
      template: true,
      references: [{ environment: 'production', name: 'DB_PASSWORD' }],
    });

    // One read, filed here: nothing beyond staging was delivered, so nothing
    // beyond it is recorded as read.
    const reads = audit.filter((record) => record.action === 'secret.read');
    expect(reads.map((record) => [record.environmentId, record.metadata.reason ?? null])).toEqual([
      [staging.id, null],
    ]);
  });

  it('walks none of the graph', async () => {
    const { org } = await walledOff();
    t.reset();
    await pullOwn(org, 'staging');
    const statements = t.statements.map((statement) => statement.sql);
    expect(statements.some((sql) => sql.includes('declared_references" @>'))).toBe(false);
    expect(
      statements.filter((sql) => sql.includes('"environments"."parent_environment_id" in')),
    ).toEqual([]);
    expect(statements.some((sql) => /"secrets"\."environment_id" in \(/.test(sql))).toBe(false);
    expect(
      statements.some((sql) => sql.includes('"env_key_grants"') && sql.includes(' in (')),
    ).toBe(false);
  });

  it('is still the version 1 bundle for an environment that needs no resolution', async () => {
    const org = await seedOrg('pro');
    const project = await seedProject(org);
    const env = await seedEnv(org, project, 'development');
    await grantTo(env, { memberUserId: org.owner.id }, org.owner.id);
    await seedSecret(org, env, 'PLAIN');
    caller = sessionOf(org.owner);

    const answer = await pullOwn(org, 'development');
    expect(answer.status).toBe(200);
    expect(answer.body.bundleVersion).toBe(1);
  });
});

/* ── template writes ─────────────────────────────────────────────────────── */

describe('writing a template', () => {
  async function writable(plan: 'free' | 'pro') {
    const org = await seedOrg(plan);
    const project = await seedProject(org);
    const env = await seedEnv(org, project, 'development');
    caller = sessionOf(org.owner);
    return { org, project, env };
  }

  it('is refused on Free, with the plan that allows it, and the attempt is recorded', async () => {
    const { org, env } = await writable('free');
    const answer = await createTemplate(org, env, 'URL', []);
    expect(answer.status).toBe(403);
    expect(answer.body.error).toMatchObject({
      code: 'plan_limit',
      plan: { resource: 'secretReferencing', upgradeTo: 'pro' },
    });
    expect(audit.find((record) => record.action === 'secret.created')).toMatchObject({
      outcome: 'error',
      metadata: { reason: 'quotaExceeded', limitName: 'secretReferencing', secretName: 'URL' },
    });
  });

  it('is stored on Pro, with its declaration resolved to environment ids', async () => {
    const { org, project, env } = await writable('pro');
    const shared = await seedEnv(org, project, 'shared');
    await seedSecret(org, shared, 'DB_HOST');
    await seedSecret(org, env, 'DB_USER');

    const answer = await createTemplate(org, env, 'URL', [
      { name: 'DB_USER' },
      { environment: 'shared', name: 'DB_HOST' },
    ]);
    expect(answer.status).toBe(201);

    const stored = await t.pg.query<{
      declared_references: DeclaredReference[];
      value_type: string;
    }>(
      `select sv.declared_references, s.value_type from secret_versions sv join secrets s on s.id = sv.secret_id where s.name = 'URL' and s.environment_id = $1`,
      [env.id],
    );
    expect(stored.rows[0]).toEqual({
      value_type: 'template',
      declared_references: [
        { name: 'DB_USER', environmentId: null },
        { environment: 'shared', name: 'DB_HOST', environmentId: shared.id },
      ],
    });
  });

  it('requires a declaration of a template, and refuses one on anything else', async () => {
    const { org, env } = await writable('pro');
    const missing = await createTemplate(org, env, 'URL', undefined);
    expect(missing.status).toBe(422);
    expect(JSON.stringify(missing.body)).toMatch(/must declare its references/);

    const stray = await createTemplate(org, env, 'PLAIN', [{ name: 'X' }], 'string');
    expect(stray.status).toBe(422);
  });

  it('refuses a reference nothing resolves', async () => {
    const { org, env } = await writable('pro');
    const answer = await createTemplate(org, env, 'URL', [{ name: 'NOWHERE' }]);
    expect(answer.status).toBe(422);
    expect(JSON.stringify(answer.body)).toMatch(/NOWHERE/);
  });

  it('refuses a loop before it is stored', async () => {
    const { org, env } = await writable('pro');
    await seedSecret(org, env, 'B', [{ name: 'A', environmentId: null }]);
    await seedSecret(org, env, 'C');
    // A → B → A.
    const answer = await createTemplate(org, env, 'A', [{ name: 'B' }]);
    expect(answer.status).toBe(422);
    expect(JSON.stringify(answer.body)).toMatch(/loop/);
    const stored = await t.pg.query(
      `select 1 from secrets where environment_id = $1 and name = 'A'`,
      [env.id],
    );
    expect(stored.rows).toHaveLength(0);
  });

  it('refuses a reference into an environment the writer cannot read, saying no more than "cannot"', async () => {
    const org = await seedOrg('team');
    const project = await seedProject(org);
    const production = await seedEnv(org, project, 'production', { production: true });
    const staging = await seedEnv(org, project, 'staging');
    await seedSecret(org, production, 'DB_PASSWORD');
    const developer = await seedUser();
    await addMember(org.orgId, developer.id, 'developer');
    caller = sessionOf(developer);

    const pointed = await createTemplate(org, staging, 'LEAK', [
      { environment: 'production', name: 'DB_PASSWORD' },
    ]);
    const invented = await createTemplate(org, staging, 'LEAK', [
      { environment: 'nonexistent', name: 'DB_PASSWORD' },
    ]);
    expect(pointed.status).toBe(422);
    expect(invented.status).toBe(422);
    // The same sentence for an environment that exists and one that does not.
    expect(JSON.stringify(pointed.body.error?.fields)).toBe(
      JSON.stringify(invented.body.error?.fields).replace('nonexistent', 'production'),
    );
  });

  it('refuses a reference out of an environment a service token reads', async () => {
    const { org, project, env } = await writable('pro');
    const shared = await seedEnv(org, project, 'shared');
    await seedSecret(org, shared, 'HOST');
    await seedServiceToken(org, project, env);
    caller = sessionOf(org.owner);

    const answer = await createTemplate(org, env, 'URL', [{ environment: 'shared', name: 'HOST' }]);
    expect(answer.status).toBe(409);
    expect(errorMessage(answer)).toMatch(/service token/);
  });

  it('is refused in a server-mode environment', async () => {
    const org = await seedOrg('pro');
    const project = await seedProject(org);
    const legacy = await seedEnv(org, project, 'legacy', { mode: 'server' });
    caller = sessionOf(org.owner);
    const { path, params } = envPath(org, legacy.slug, '/secrets');
    const answer = await call(secretsRoute.POST, 'POST', path, params, {
      name: 'URL',
      value: 'postgres://${HOST}',
      valueType: 'template',
    });
    expect(answer.status).toBe(409);
    expect(errorMessage(answer)).toMatch(/^e2ee_required/);
  });

  it('cannot become, or stop being, a template by a label', async () => {
    const { org, env } = await writable('pro');
    await seedSecret(org, env, 'PLAIN');
    await seedSecret(org, env, 'HOST');
    await seedSecret(org, env, 'URL', [{ name: 'HOST', environmentId: null }]);

    const { path, params } = envPath(org, env.slug, '/secrets/PLAIN');
    const toTemplate = await call(
      secretRoute.PUT,
      'PUT',
      path,
      { ...params, name: 'PLAIN' },
      { valueType: 'template' },
    );
    expect(toTemplate.status).toBe(409);

    const url = envPath(org, env.slug, '/secrets/URL');
    const fromTemplate = await call(
      secretRoute.PUT,
      'PUT',
      url.path,
      { ...url.params, name: 'URL' },
      { valueType: 'string' },
    );
    expect(fromTemplate.status).toBe(409);
    const renamed = await call(
      secretRoute.PUT,
      'PUT',
      url.path,
      { ...url.params, name: 'URL' },
      { name: 'URL2' },
    );
    expect(renamed.status).toBe(409);
  });

  it('keeps a template a template when a client writes it without naming the type', async () => {
    const { org, env } = await writable('pro');
    await seedSecret(org, env, 'HOST');
    await seedSecret(org, env, 'URL', [{ name: 'HOST', environmentId: null }]);

    const { path, params } = envPath(org, env.slug, '/secrets/URL');
    const answer = await call(
      secretRoute.PATCH,
      'PATCH',
      path,
      { ...params, name: 'URL' },
      {
        value: {
          ciphertext: blob('URL2'),
          clientAlgorithm: 'xk2.gcm',
          envDataKeyId: env.keyId,
          valueHmac: OTHER_HMAC,
        },
        expectedVersion: 2,
      },
    );
    expect(answer.status).toBe(422);
    expect(JSON.stringify(answer.body)).toMatch(/must declare its references/);
  });
});

/* ── removals ─────────────────────────────────────────────────────────────── */

describe('removing what a template depends on', () => {
  it('refuses deleting a referenced secret and allows deleting an unreferenced one', async () => {
    const org = await seedOrg('pro');
    const project = await seedProject(org);
    const env = await seedEnv(org, project, 'development');
    await seedSecret(org, env, 'HOST');
    await seedSecret(org, env, 'SPARE');
    await seedSecret(org, env, 'URL', [{ name: 'HOST', environmentId: null }]);
    caller = sessionOf(org.owner);

    const host = envPath(org, env.slug, '/secrets/HOST');
    const refused = await call(secretRoute.DELETE, 'DELETE', host.path, {
      ...host.params,
      name: 'HOST',
    });
    expect(refused.status).toBe(409);
    expect(errorMessage(refused)).toMatch(/HOST cannot be removed/);

    const spare = envPath(org, env.slug, '/secrets/SPARE');
    expect(
      (await call(secretRoute.DELETE, 'DELETE', spare.path, { ...spare.params, name: 'SPARE' }))
        .status,
    ).toBe(200);
  });

  it('refuses deleting an environment another inherits from', async () => {
    const org = await seedOrg('pro');
    const project = await seedProject(org);
    const base = await seedEnv(org, project, 'base');
    await seedEnv(org, project, 'child', { parentId: base.id });
    caller = sessionOf(org.owner);

    const { path, params } = envPath(org, 'base');
    const answer = await call(environmentRoute.DELETE, 'DELETE', path, params, {});
    expect(answer.status).toBe(409);
    expect(errorMessage(answer)).toMatch(/child inherits/);
  });
});

/* ── the parent route ─────────────────────────────────────────────────────── */

describe('setting a parent', () => {
  it('is refused on Free and allowed on Pro, with the change audited both ways', async () => {
    for (const plan of ['free', 'pro'] as const) {
      const org = await seedOrg(plan);
      const project = await seedProject(org);
      await seedEnv(org, project, 'base');
      await seedEnv(org, project, 'staging');
      caller = sessionOf(org.owner);
      audit = [];

      const answer = await setParent(org, 'staging', 'base');
      if (plan === 'free') {
        expect(answer.status).toBe(403);
        expect(answer.body.error?.plan?.resource).toBe('secretReferencing');
        expect(audit[0]).toMatchObject({ action: 'environment.parent_changed', outcome: 'error' });
      } else {
        expect(answer.status).toBe(200);
        expect(answer.body.environment?.parent).toBe('base');
        expect(audit[0]).toMatchObject({
          action: 'environment.parent_changed',
          outcome: 'success',
          metadata: { parentEnvironmentSlug: 'base', previousParentEnvironmentSlug: null },
        });
      }
    }
  });

  it('may always be cleared, even after a downgrade', async () => {
    const org = await seedOrg('free');
    const project = await seedProject(org);
    const base = await seedEnv(org, project, 'base');
    await seedEnv(org, project, 'staging', { parentId: base.id });
    caller = sessionOf(org.owner);

    const answer = await setParent(org, 'staging', null);
    expect(answer.status).toBe(200);
    expect(answer.body.environment?.parent).toBeNull();
  });

  it('refuses a loop, itself, and an environment of another project', async () => {
    const org = await seedOrg('pro');
    const project = await seedProject(org);
    const a = await seedEnv(org, project, 'a');
    await seedEnv(org, project, 'b', { parentId: a.id });
    caller = sessionOf(org.owner);

    const loop = await setParent(org, 'a', 'b');
    expect(loop.status).toBe(422);
    expect(JSON.stringify(loop.body)).toMatch(/inherits from itself/);

    expect((await setParent(org, 'a', 'a')).status).toBe(422);

    const other = await seedProject(org, 'other');
    await seedEnv(org, other, 'elsewhere');
    expect((await setParent(org, 'a', 'elsewhere')).status).toBe(422);
  });

  it('refuses a parent that would leave a template in a child unresolvable', async () => {
    const org = await seedOrg('pro');
    const project = await seedProject(org);
    const base = await seedEnv(org, project, 'base');
    const empty = await seedEnv(org, project, 'empty');
    const child = await seedEnv(org, project, 'child', { parentId: base.id });
    await seedSecret(org, base, 'HOST');
    await seedSecret(org, child, 'URL', [{ name: 'HOST', environmentId: null }]);
    void empty;
    caller = sessionOf(org.owner);

    const answer = await setParent(org, 'child', 'empty');
    expect(answer.status).toBe(422);
    expect(JSON.stringify(answer.body)).toMatch(/HOST/);
  });

  it('refuses an environment a service token reads, and a token on an environment that inherits', async () => {
    const org = await seedOrg('pro');
    const project = await seedProject(org);
    const base = await seedEnv(org, project, 'base');
    const ci = await seedEnv(org, project, 'ci');
    await seedServiceToken(org, project, ci);
    caller = sessionOf(org.owner);

    const answer = await setParent(org, 'ci', 'base');
    expect(answer.status).toBe(409);
    expect(errorMessage(answer)).toMatch(/service token/);

    await seedEnv(org, project, 'inherits', { parentId: base.id });
    const minted = await call(
      tokensRoute.POST,
      'POST',
      `/api/orgs/${org.slug}/tokens/service`,
      { orgSlug: org.slug },
      { name: 'ci', projectSlug: 'api', environmentSlug: 'inherits', publicKey: 'A'.repeat(43) },
    );
    expect(minted.status).toBe(409);
    expect(errorMessage(minted)).toMatch(/inherits from another/);
  });

  it('needs environment.update on the child', async () => {
    const org = await seedOrg('pro');
    const project = await seedProject(org);
    await seedEnv(org, project, 'base');
    await seedEnv(org, project, 'staging');
    const developer = await seedUser();
    await addMember(org.orgId, developer.id, 'developer');
    caller = sessionOf(developer);

    const answer = await setParent(org, 'staging', 'base');
    expect([403, 404]).toContain(answer.status);
    expect(audit[0]).toMatchObject({ action: 'environment.parent_changed', outcome: 'denied' });
  });
});

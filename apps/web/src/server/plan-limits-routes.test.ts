import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { AuditRecord } from '@xecret/core/audit';
import { PLANS } from '@xecret/core/entitlements';
import {
  EnvelopeService,
  generateKeyBytes,
  InMemoryKeyProvider,
  parseRootKeyMaterial,
  toBase64Url,
} from '@xecret/core/crypto';
import { DEFAULT_ENVIRONMENTS } from '@xecret/core/validation';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '@xecret/db/testing';
import type { TestDatabase } from '@xecret/db/testing';
import type { Principal } from './actor';
import { errors } from './errors';
import { createLogger } from './logging';
import type { RequestLog } from './logging';

/**
 * Plan limits, enforced from the day they are published — end to end, through
 * the routes, against a real database with every migration applied.
 *
 * For every countable ceiling the plans define and a route creates against,
 * three things are asserted, on the Free plan and as the organisation's owner
 * (owners are exempt from no limit):
 *
 *  1. **At the limit, creation is refused** — `403 plan_limit` naming the
 *     resource, the limit and the plan to upgrade to, nothing written, and the
 *     attempt filed as `quotaExceeded`.
 *  2. **Under it, creation succeeds**, and what holds no place — a deleted
 *     project, a revoked or expired token — does not count.
 *  3. **Past it, what already exists is untouched**: an organisation that held
 *     more before the limit applied, or that downgraded, can still read, edit
 *     and use every one of them; only the next creation is refused.
 *
 * `seats` is here too, through the invitation route, with the counting rule
 * itself in `packages/db/src/repositories/seats.test.ts`. `webhooks` has the
 * same three in `webhooks.test.ts`, and `organizations` in `orgs-routes.test.ts`.
 *
 * ── What is real, and what is stubbed ──
 * Real: the routes and `authenticatedRoute`; tenancy, `can()` and the
 * entitlement engine reading the subscription row from PGlite; every
 * repository, capacity locks and counts included. Stubbed: who is asking, the
 * audit sink (captured) and the logger. Ciphertext is shape-valid and opaque, as
 * it is to the server in production.
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
// The usage meter arms a deferred flush on a secret read; it only records here.
const meter = vi.hoisted(() => ({ countSecretFetch: vi.fn() }));
vi.mock('./billing/usage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./billing/usage')>()),
  countSecretFetch: meter.countSecretFetch,
}));

const projectsRoute = await import('@/app/api/orgs/[orgSlug]/projects/route');
const projectRoute = await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/route');
const environmentsRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/route');
const environmentRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/route');
const secretsRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/secrets/route');
const secretRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/secrets/[name]/route');
const importRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/import/route');
const serviceTokensRoute = await import('@/app/api/orgs/[orgSlug]/tokens/service/route');
const cliDevicesRoute = await import('@/app/api/orgs/[orgSlug]/tokens/cli/route');
const tokenRoute = await import('@/app/api/orgs/[orgSlug]/tokens/[kind]/[tokenId]/route');
const cliAuthorizeRoute = await import('@/app/api/cli/authorize/route');
const cliTokenRoute = await import('@/app/api/cli/token/route');
const membersRoute = await import('@/app/api/orgs/[orgSlug]/members/route');
const promoteRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/promote/route');
const restorePointRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/restore-point/route');
const { createCliAuthCode } = await import('@xecret/db/repositories');

let t: TestDatabase;
let audit: AuditRecord[] = [];
let deferred: Promise<unknown>[] = [];
let caller: Principal | null;
let envelope: EnvelopeService;

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

/* ── fixtures ─────────────────────────────────────────────────────────────── */

const blob = (label: string) =>
  `xk2.gcm.${Buffer.from(label.padEnd(48, '.')).toString('base64url')}`;
const HMAC = 'A'.repeat(43);
const PUBLIC_KEY = 'A'.repeat(43);
const SEALED = `xk2.x25519.${'A'.repeat(123)}`;
const SIGNATURE = `xk2.ed25519.${'A'.repeat(86)}`;
const bytes = (n: number) => new Uint8Array(n).map(() => Math.floor(Math.random() * 256));

interface User {
  id: string;
  email: string;
}

async function seedUser(): Promise<User> {
  const id = randomUUID();
  const email = `lim-${id.slice(0, 8)}@example.com`;
  await t.pg.query(
    `insert into users (id, workos_user_id, email, email_verified) values ($1, $2, $3, true)`,
    [id, `user_${id.slice(0, 8)}`, email],
  );
  return { id, email };
}

/** A vault, so the person may create what is sealed to their key. Shape only. */
async function seedVault(user: User): Promise<void> {
  await t.pg.query(
    `insert into user_keys
       (user_id, enc_public_key, enc_private_key_enc, sign_public_key, sign_private_key_enc,
        kdf_salt, kdf_params, unlock_verifier_hash, uk_unlock_verifier_hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      user.id,
      bytes(32),
      new TextEncoder().encode(blob('enc')),
      bytes(32),
      new TextEncoder().encode(blob('sign')),
      bytes(16),
      JSON.stringify({ alg: 'argon2id', v: 19, m: 19456, t: 1, p: 1, len: 32 }),
      bytes(32),
      bytes(32),
    ],
  );
}

function sessionOf(user: User): Principal {
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
  owner: User;
}

/** A Free organisation, its owner (with a vault) calling — as provisioning leaves one. */
async function seedOrg(): Promise<Org> {
  const owner = await seedUser();
  await seedVault(owner);
  const orgId = randomUUID();
  const slug = `lim-${orgId.slice(0, 8)}`;
  await t.pg.query(
    `insert into organizations (id, name, slug, created_by) values ($1, 'Acme', $2, $3)`,
    [orgId, slug, owner.id],
  );
  await t.pg.query(`insert into org_subscriptions (org_id) values ($1)`, [orgId]);
  await t.pg.query(
    `insert into org_members (id, org_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), orgId, owner.id],
  );
  caller = sessionOf(owner);
  return { orgId, slug, owner };
}

/** `count` live projects — or deleted ones — named `p1`, `p2`, …, after `prefix`. */
async function seedProjects(
  org: Org,
  count: number,
  options: { prefix?: string; deleted?: boolean } = {},
): Promise<void> {
  await t.pg.query(
    `insert into projects (id, org_id, name, slug, created_by, deleted_at)
     select gen_random_uuid(), $1, 'p' || g, $2 || g, $3, $4
       from generate_series(1, $5::int) g`,
    [org.orgId, options.prefix ?? 'p', org.owner.id, options.deleted ? new Date() : null, count],
  );
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

/** An end-to-end encrypted environment with its active data key and the owner's grant. */
async function seedEnv(org: Org, projectId: string, slug: string): Promise<Env> {
  const id = randomUUID();
  const keyId = randomUUID();
  await t.pg.query(
    `insert into environments (id, project_id, name, slug, encryption_mode) values ($1, $2, $3, $4, 'e2ee')`,
    [id, projectId, slug, slug],
  );
  await t.pg.query(
    `insert into env_data_keys (id, environment_id, version, status, created_by) values ($1, $2, 1, 'active', $3)`,
    [keyId, id, org.owner.id],
  );
  await t.pg.query(
    `insert into env_key_grants (id, env_data_key_id, member_user_id, edk_sealed, ehk_sealed, recipient_public_key, signature, signed_by_user_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      randomUUID(),
      keyId,
      org.owner.id,
      new TextEncoder().encode(SEALED),
      new TextEncoder().encode(SEALED),
      new Uint8Array(32),
      new TextEncoder().encode(SIGNATURE),
      org.owner.id,
    ],
  );
  return { id, keyId, slug };
}

/**
 * `count` live secrets, each with a first version, named `BULK_1`… after
 * `prefix` — written at `at` (now unless said), so a point-in-time restore has
 * a past to restore to.
 */
async function seedSecrets(
  org: Org,
  env: Env,
  count: number,
  prefix = 'BULK_',
  at: Date = new Date(),
): Promise<void> {
  await t.pg.query(
    `with created as (
       insert into secrets (id, environment_id, name, created_by, created_at, updated_at)
       select gen_random_uuid(), $1, $2 || g, $3, $8, $8 from generate_series(1, $4::int) g
       returning id
     )
     insert into secret_versions
       (id, secret_id, version, ciphertext, env_data_key_id, client_algorithm, value_hmac, created_by, created_at)
     select gen_random_uuid(), created.id, 1, $5, $6, 'xk2.gcm', $7, $3, $8 from created`,
    [
      env.id,
      prefix,
      org.owner.id,
      count,
      new TextEncoder().encode(blob('seeded')),
      env.keyId,
      new Uint8Array(32),
      at,
    ],
  );
}

async function setPlan(org: Org, plan: 'pro' | 'team' | 'enterprise'): Promise<void> {
  await t.pg.query(
    `update org_subscriptions set plan = $2, billing_interval = 'monthly' where org_id = $1`,
    [org.orgId, plan],
  );
}

async function seedServiceTokens(
  org: Org,
  projectId: string,
  env: Env,
  count: number,
  state: { revoked?: boolean; expired?: boolean } = {},
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = randomUUID();
    ids.push(id);
    await t.pg.query(
      `insert into service_tokens
         (id, org_id, project_id, environment_id, name, token_hash, token_prefix, created_by,
          public_key, key_algorithm, revoked_at, expires_at)
       values ($1, $2, $3, $4, 'ci', $5, 'xst_x', $6, $7, 'X25519', $8, $9)`,
      [
        id,
        org.orgId,
        projectId,
        env.id,
        bytes(32),
        org.owner.id,
        new Uint8Array(32),
        state.revoked ? new Date() : null,
        state.expired ? new Date(Date.now() - 60_000) : null,
      ],
    );
  }
  return ids;
}

async function seedCliTokens(
  org: Org,
  user: User,
  count: number,
  state: { revoked?: boolean; expired?: boolean } = {},
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = randomUUID();
    ids.push(id);
    await t.pg.query(
      `insert into cli_tokens (id, user_id, org_id, name, token_hash, token_prefix, revoked_at, expires_at)
       values ($1, $2, $3, $4, $5, 'xct_x', $6, $7)`,
      [
        id,
        user.id,
        org.orgId,
        `laptop-${i}`,
        bytes(32),
        state.revoked ? new Date() : null,
        state.expired ? new Date(Date.now() - 60_000) : null,
      ],
    );
  }
  return ids;
}

const countRows = async (sql: string, params: unknown[]) =>
  (await t.pg.query<{ n: number }>(`select count(*)::int as n from ${sql}`, params)).rows[0]!.n;

/* ── requests ─────────────────────────────────────────────────────────────── */

interface PlanBlock {
  resource?: string;
  limit?: number | null;
  current?: number | null;
  plan?: string;
  upgradeTo?: string | null;
}

interface Body {
  error?: { code?: string; message?: string; plan?: PlanBlock };
  projects?: { slug: string }[];
  project?: { slug: string; name: string };
  environments?: { slug: string }[];
  environment?: { slug: string; name: string };
  data?: { id: string; name?: string }[];
  secret?: { name: string; version: number };
  token?: string;
  code?: string;
  seats?: { used: number; pendingInvitations: number; limit: number };
  counts?: Record<string, number>;
}

interface Answer {
  status: number;
  body: Body;
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
  return { status: response.status, body: text === '' ? {} : (JSON.parse(text) as Body) };
}

const orgParams = (org: Org) => ({ orgSlug: org.slug });
const projectParams = (org: Org, projectSlug = 'api') => ({ orgSlug: org.slug, projectSlug });
const envParams = (org: Org, envSlug: string, projectSlug = 'api') => ({
  orgSlug: org.slug,
  projectSlug,
  envSlug,
});
const envPath = (org: Org, envSlug: string, rest = '', projectSlug = 'api') =>
  `/api/orgs/${org.slug}/projects/${projectSlug}/environments/${envSlug}${rest}`;

function grantFor(user: User) {
  return {
    recipientKind: 'member',
    recipientId: user.id,
    recipientPublicKey: PUBLIC_KEY,
    edkSealed: SEALED,
    ehkSealed: SEALED,
    signature: SIGNATURE,
  };
}

const createProject = (org: Org, slug: string) =>
  call(projectsRoute.POST, 'POST', `/api/orgs/${org.slug}/projects`, orgParams(org), {
    name: slug,
    slug,
    environments: DEFAULT_ENVIRONMENTS.map((environment) => ({
      slug: environment.slug,
      id: randomUUID(),
      keys: { grant: grantFor(org.owner) },
    })),
  });

const createEnvironment = (org: Org, slug: string, projectSlug = 'api') =>
  call(
    environmentsRoute.POST,
    'POST',
    `/api/orgs/${org.slug}/projects/${projectSlug}/environments`,
    projectParams(org, projectSlug),
    { id: randomUUID(), name: slug, slug, keys: { grant: grantFor(org.owner) } },
  );

const createSecret = (org: Org, env: Env, name: string) =>
  call(secretsRoute.POST, 'POST', envPath(org, env.slug, '/secrets'), envParams(org, env.slug), {
    id: randomUUID(),
    name,
    valueType: 'string',
    value: {
      ciphertext: blob(name),
      clientAlgorithm: 'xk2.gcm',
      envDataKeyId: env.keyId,
      valueHmac: HMAC,
    },
  });

const importSecrets = (org: Org, env: Env, names: string[], dryRun = false) =>
  call(importRoute.POST, 'POST', envPath(org, env.slug, '/import'), envParams(org, env.slug), {
    dryRun,
    entries: names.map((name) => ({
      id: randomUUID(),
      name,
      expectedVersion: 1,
      value: {
        ciphertext: blob(name),
        clientAlgorithm: 'xk2.gcm',
        envDataKeyId: env.keyId,
        valueHmac: HMAC,
      },
    })),
  });

const mintServiceToken = (org: Org, env: Env) =>
  call(serviceTokensRoute.POST, 'POST', `/api/orgs/${org.slug}/tokens/service`, orgParams(org), {
    name: 'deploy',
    projectSlug: 'api',
    environmentSlug: env.slug,
    publicKey: PUBLIC_KEY,
  });

const revoke = (org: Org, kind: 'service' | 'cli', tokenId: string) =>
  call(tokenRoute.DELETE, 'DELETE', `/api/orgs/${org.slug}/tokens/${kind}/${tokenId}`, {
    orgSlug: org.slug,
    kind,
    tokenId,
  });

const VERIFIER = 'v'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

const approveDevice = (org: Org) =>
  call(
    cliAuthorizeRoute.POST,
    'POST',
    '/api/cli/authorize',
    {},
    {
      orgSlug: org.slug,
      deviceName: 'new laptop',
      codeChallenge: CHALLENGE,
    },
  );

/** `xecret login`'s exchange, for an approval minted directly — the consent screen's checks bypassed. */
async function exchangeDevice(org: Org, user: User): Promise<Answer> {
  const issued = await createCliAuthCode(t.db, {
    userId: user.id,
    orgId: org.orgId,
    deviceName: 'new laptop',
    codeChallenge: CHALLENGE,
    ipAddress: '203.0.113.5',
  });
  const previous = caller;
  caller = null;
  try {
    return await call(
      cliTokenRoute.POST,
      'POST',
      '/api/cli/token',
      {},
      {
        code: issued.code,
        codeVerifier: VERIFIER,
      },
    );
  } finally {
    caller = previous;
  }
}

/** The refusal every ceiling answers with, naming what was refused and where to go. */
function expectPlanLimit(answer: Answer, resource: string, limit: number): void {
  expect(answer.status).toBe(403);
  expect(answer.body.error?.code).toBe('plan_limit');
  expect(answer.body.error?.plan).toMatchObject({
    resource,
    limit,
    plan: 'free',
    upgradeTo: 'pro',
  });
  expect(answer.body.error?.message).toMatch(
    /the Free plan, which allows .* The Pro plan allows more\./,
  );
}

/** The audit record of a refused creation: an `error`, `quotaExceeded`, naming the limit. */
function expectRefusalFiled(action: string, limitName: string): void {
  expectRefusalFiledFor(action, limitName, 'free');
}

function expectRefusalFiledFor(action: string, limitName: string, plan: string): void {
  expect(audit.filter((event) => event.action === action)).toEqual([
    expect.objectContaining({
      outcome: 'error',
      metadata: expect.objectContaining({ reason: 'quotaExceeded', limitName, plan }),
    }),
  ]);
}

const FREE = PLANS.free.limits;

/* ── projects ─────────────────────────────────────────────────────────────── */

describe('projects — Free allows five', () => {
  it('refuses the sixth, naming the limit and Pro, writing nothing, and files it', async () => {
    const org = await seedOrg();
    await seedProjects(org, FREE.projects!);

    const answer = await createProject(org, 'sixth');

    expectPlanLimit(answer, 'projects', 5);
    expect(answer.body.error?.message).toContain('allows 5 projects');
    expectRefusalFiled('project.created', 'projects');
    expect(await countRows(`projects where org_id = $1`, [org.orgId])).toBe(5);
    expect(
      await countRows(
        `environments e join projects p on p.id = e.project_id where p.slug = 'sixth'`,
        [],
      ),
    ).toBe(0);
  });

  it('creates the fifth, with its environments — and a deleted project holds no place', async () => {
    const org = await seedOrg();
    await seedProjects(org, 4);
    await seedProjects(org, 3, { prefix: 'gone', deleted: true });

    const answer = await createProject(org, 'fifth');

    expect(answer.status).toBe(201);
    expect(answer.body.project?.slug).toBe('fifth');
    expect(answer.body.environments).toHaveLength(DEFAULT_ENVIRONMENTS.length);
  });

  it('leaves an organisation already past the limit every project it has, readable and editable', async () => {
    const org = await seedOrg();
    await seedProjects(org, 7);

    const listing = await call(
      projectsRoute.GET,
      'GET',
      `/api/orgs/${org.slug}/projects`,
      orgParams(org),
    );
    expect(listing.status).toBe(200);
    expect(listing.body.projects).toHaveLength(7);

    const renamed = await call(
      projectRoute.PATCH,
      'PATCH',
      `/api/orgs/${org.slug}/projects/p7`,
      projectParams(org, 'p7'),
      { name: 'Still mine' },
    );
    expect(renamed.status).toBe(200);
    expect(renamed.body.project?.name).toBe('Still mine');

    expectPlanLimit(await createProject(org, 'eighth'), 'projects', 5);
    expect(await countRows(`projects where org_id = $1 and deleted_at is null`, [org.orgId])).toBe(
      7,
    );
  });
});

/* ── environments per project ─────────────────────────────────────────────── */

describe('environments per project — Free allows three', () => {
  it('refuses a fourth in a project, and files it', async () => {
    const org = await seedOrg();
    const project = await seedProject(org);
    for (const slug of ['development', 'staging', 'production']) await seedEnv(org, project, slug);

    const answer = await createEnvironment(org, 'canary');

    expectPlanLimit(answer, 'environmentsPerProject', 3);
    expect(answer.body.error?.message).toContain('allows 3 environments per project');
    expectRefusalFiled('environment.created', 'environmentsPerProject');
    expect(await countRows(`environments where project_id = $1`, [project])).toBe(3);
  });

  it('creates a third — counted per project, so another project’s environments take none', async () => {
    const org = await seedOrg();
    const project = await seedProject(org);
    const other = await seedProject(org, 'web');
    for (const slug of ['development', 'staging']) await seedEnv(org, project, slug);
    for (const slug of ['a', 'b', 'c']) await seedEnv(org, other, slug);

    const answer = await createEnvironment(org, 'production');

    expect(answer.status).toBe(201);
    expect(answer.body.environment?.slug).toBe('production');
  });

  it('leaves a project already past the limit every environment it has, readable and editable', async () => {
    const org = await seedOrg();
    const project = await seedProject(org);
    for (const slug of ['e1', 'e2', 'e3', 'e4', 'e5']) await seedEnv(org, project, slug);

    const listing = await call(
      environmentsRoute.GET,
      'GET',
      `/api/orgs/${org.slug}/projects/api/environments`,
      projectParams(org),
    );
    expect(listing.status).toBe(200);
    expect(listing.body.environments).toHaveLength(5);

    const renamed = await call(
      environmentRoute.PATCH,
      'PATCH',
      envPath(org, 'e5'),
      envParams(org, 'e5'),
      { name: 'Still mine' },
    );
    expect(renamed.status).toBe(200);

    expectPlanLimit(await createEnvironment(org, 'e6'), 'environmentsPerProject', 3);
  });
});

/* ── secrets per environment ──────────────────────────────────────────────── */

describe('secrets per environment — Free allows 250', () => {
  async function environmentHolding(count: number) {
    const org = await seedOrg();
    const project = await seedProject(org);
    const env = await seedEnv(org, project, 'development');
    await seedSecrets(org, env, count);
    return { org, project, env };
  }

  it('refuses the 251st, writing nothing, and files it', async () => {
    const { org, env } = await environmentHolding(FREE.secretsPerEnvironment!);

    const answer = await createSecret(org, env, 'ONE_TOO_MANY');

    expectPlanLimit(answer, 'secretsPerEnvironment', 250);
    expect(answer.body.error?.message).toContain('allows 250 secrets per environment');
    expectRefusalFiled('secret.created', 'secretsPerEnvironment');
    expect(await countRows(`secrets where environment_id = $1`, [env.id])).toBe(250);
  });

  it('creates the 250th — and a deleted secret holds no place', async () => {
    const { org, env } = await environmentHolding(249);
    await seedSecrets(org, env, 5, 'GONE_');
    await t.pg.query(`update secrets set deleted_at = now() where name like 'GONE_%'`);

    const answer = await createSecret(org, env, 'LAST_ONE');

    expect(answer.status).toBe(201);
    expect(answer.body.secret?.name).toBe('LAST_ONE');
  });

  it('answers a name that is already taken as the 409 it is, even at the limit', async () => {
    const { org, env } = await environmentHolding(FREE.secretsPerEnvironment!);

    const answer = await createSecret(org, env, 'BULK_1');

    // Refused for the name, not the plan: with room to spare it would still fail.
    expect(answer.status).toBe(409);
    expect(answer.body.error?.code).toBe('conflict');
    expect(answer.body.error?.message).toMatch(/already exists/);
    expect(
      audit.filter((event) => event.action === 'secret.created' && event.outcome === 'error'),
    ).toEqual([]);
  });

  it('weighs an import whole: refused when its new names would pass the limit, nothing written', async () => {
    const { org, env } = await environmentHolding(248);

    // The preview says what the import would refuse, and records nothing.
    const preview = await importSecrets(org, env, ['NEW_A', 'NEW_B', 'NEW_C'], true);
    expectPlanLimit(preview, 'secretsPerEnvironment', 250);
    expect(audit.filter((event) => event.action === 'secret.imported')).toEqual([]);

    const refused = await importSecrets(org, env, ['NEW_A', 'NEW_B', 'NEW_C']);
    expectPlanLimit(refused, 'secretsPerEnvironment', 250);
    expectRefusalFiled('secret.imported', 'secretsPerEnvironment');
    expect(await countRows(`secrets where environment_id = $1`, [env.id])).toBe(248);

    const fits = await importSecrets(org, env, ['NEW_A', 'NEW_B']);
    expect(fits.status).toBe(200);
    expect(await countRows(`secrets where environment_id = $1`, [env.id])).toBe(250);
  });

  it('leaves an environment already past the limit every secret it has, readable, rotatable and removable', async () => {
    const { org, env } = await environmentHolding(260);

    const listing = await call(
      secretsRoute.GET,
      'GET',
      envPath(org, env.slug, '/secrets?limit=200'),
      envParams(org, env.slug),
    );
    expect(listing.status).toBe(200);
    expect(listing.body.data).toHaveLength(200);

    const rotated = await call(
      secretRoute.PATCH,
      'PATCH',
      envPath(org, env.slug, '/secrets/BULK_1'),
      { ...envParams(org, env.slug), name: 'BULK_1' },
      {
        expectedVersion: 2,
        value: {
          ciphertext: blob('rotated'),
          clientAlgorithm: 'xk2.gcm',
          envDataKeyId: env.keyId,
          valueHmac: 'B'.repeat(43),
        },
      },
    );
    expect(rotated.status).toBe(200);

    // An import that only overwrites names the environment already has creates
    // nothing, so the ceiling does not refuse it.
    const existing = await t.pg.query<{ id: string }>(
      `select id from secrets where environment_id = $1 and name = 'BULK_2'`,
      [env.id],
    );
    const overwrite = await call(
      importRoute.POST,
      'POST',
      envPath(org, env.slug, '/import'),
      envParams(org, env.slug),
      {
        dryRun: false,
        entries: [
          {
            id: existing.rows[0]!.id,
            name: 'BULK_2',
            expectedVersion: 2,
            value: {
              ciphertext: blob('overwritten'),
              clientAlgorithm: 'xk2.gcm',
              envDataKeyId: env.keyId,
              valueHmac: 'C'.repeat(43),
            },
          },
        ],
      },
    );
    expect(overwrite.status).toBe(200);

    const removed = await call(
      secretRoute.DELETE,
      'DELETE',
      envPath(org, env.slug, '/secrets/BULK_3'),
      { ...envParams(org, env.slug), name: 'BULK_3' },
    );
    expect(removed.status).toBeLessThan(300);

    // 259 is still past 250: the next creation is refused until it is under.
    expectPlanLimit(await createSecret(org, env, 'NOT_YET'), 'secretsPerEnvironment', 250);
    expect(
      await countRows(`secrets where environment_id = $1 and deleted_at is null`, [env.id]),
    ).toBe(259);
  });
});

/* ── service tokens ───────────────────────────────────────────────────────── */

describe('service tokens — Free allows ten', () => {
  async function tokens(live: number) {
    const org = await seedOrg();
    const project = await seedProject(org);
    const env = await seedEnv(org, project, 'production');
    const ids = await seedServiceTokens(org, project, env, live);
    return { org, project, env, ids };
  }

  it('refuses the eleventh, minting nothing, and files it', async () => {
    const { org, env } = await tokens(FREE.serviceTokens!);

    const answer = await mintServiceToken(org, env);

    expectPlanLimit(answer, 'serviceTokens', 10);
    expect(answer.body.token).toBeUndefined();
    expectRefusalFiled('token.created', 'serviceTokens');
    expect(await countRows(`service_tokens where org_id = $1`, [org.orgId])).toBe(10);
  });

  it('mints the tenth — and a revoked or expired token holds no place', async () => {
    const { org, project, env } = await tokens(9);
    await seedServiceTokens(org, project, env, 2, { revoked: true });
    await seedServiceTokens(org, project, env, 2, { expired: true });

    const answer = await mintServiceToken(org, env);

    expect(answer.status).toBe(201);
    expect(answer.body.token).toBeTypeOf('string');
  });

  it('leaves an organisation already past the limit every token it has — listed, usable and revocable', async () => {
    const { org, project, env, ids } = await tokens(12);
    await seedSecrets(org, env, 2);

    const listing = await call(
      serviceTokensRoute.GET,
      'GET',
      `/api/orgs/${org.slug}/tokens/service`,
      orgParams(org),
    );
    expect(listing.status).toBe(200);
    expect(listing.body.data).toHaveLength(12);

    // A CI token minted before the limit still reads its environment.
    const owner = caller;
    caller = {
      kind: 'serviceToken',
      tokenId: ids[11]!,
      tokenName: 'ci',
      orgId: org.orgId,
      projectId: project,
      environmentId: env.id,
      accessLevel: 'read',
    };
    const read = await call(
      secretsRoute.GET,
      'GET',
      envPath(org, env.slug, '/secrets'),
      envParams(org, env.slug),
    );
    expect(read.status).toBe(200);
    expect(read.body.data).toHaveLength(2);
    caller = owner;

    expect((await revoke(org, 'service', ids[0]!)).status).toBeLessThan(300);
    // Eleven live, still past ten.
    expectPlanLimit(await mintServiceToken(org, env), 'serviceTokens', 10);
  });
});

/* ── CLI devices per person ───────────────────────────────────────────────── */

describe('CLI devices per person — Free allows two', () => {
  it('refuses a third at the consent screen, where an old device can be revoked, and files it', async () => {
    const org = await seedOrg();
    await seedCliTokens(org, org.owner, FREE.cliDevicesPerUser!);

    const answer = await approveDevice(org);

    expectPlanLimit(answer, 'cliDevicesPerUser', 2);
    expect(answer.body.error?.message).toContain('allows 2 CLI devices per person');
    // The way forward short of upgrading, where the person can take it.
    expect(answer.body.error?.message).toContain('Revoke a device you no longer use');
    expect(answer.body.code).toBeUndefined();
    expectRefusalFiled('token.authorized', 'cliDevicesPerUser');
  });

  it('refuses a third at the exchange too — the count that decides — minting nothing, and files it', async () => {
    const org = await seedOrg();
    await seedCliTokens(org, org.owner, 2);

    const answer = await exchangeDevice(org, org.owner);

    expectPlanLimit(answer, 'cliDevicesPerUser', 2);
    expect(answer.body.error?.message).toContain('`xecret logout`');
    expect(answer.body.token).toBeUndefined();
    expectRefusalFiled('token.created', 'cliDevicesPerUser');
    expect(await countRows(`cli_tokens where org_id = $1`, [org.orgId])).toBe(2);
  });

  it('approves and mints the second — counted per person, and a revoked or expired login holds no place', async () => {
    const org = await seedOrg();
    const colleague = await seedUser();
    await t.pg.query(
      `insert into org_members (id, org_id, user_id, role) values ($1, $2, $3, 'developer')`,
      [randomUUID(), org.orgId, colleague.id],
    );
    await seedCliTokens(org, org.owner, 1);
    await seedCliTokens(org, org.owner, 2, { revoked: true });
    await seedCliTokens(org, org.owner, 2, { expired: true });
    await seedCliTokens(org, colleague, 2);

    const approved = await approveDevice(org);
    expect(approved.status).toBe(200);
    expect(approved.body.code).toBeTypeOf('string');

    const minted = await exchangeDevice(org, org.owner);
    expect(minted.status).toBe(201);
    expect(minted.body.token).toBeTypeOf('string');
  });

  it('leaves a person already past the limit every device they have — listed, usable and revocable', async () => {
    const org = await seedOrg();
    const ids = await seedCliTokens(org, org.owner, 4);

    const devices = await call(
      cliDevicesRoute.GET,
      'GET',
      `/api/orgs/${org.slug}/tokens/cli`,
      orgParams(org),
    );
    expect(devices.status).toBe(200);
    expect(devices.body.data).toHaveLength(4);

    // A login made before the limit still works as its person.
    const project = await seedProject(org);
    const env = await seedEnv(org, project, 'development');
    const owner = caller;
    caller = {
      kind: 'cliToken',
      tokenId: ids[3]!,
      tokenName: 'laptop-3',
      userId: org.owner.id,
      orgId: org.orgId,
      signIn: { method: 'password', ssoWorkosOrgId: null },
    };
    const read = await call(
      secretsRoute.GET,
      'GET',
      envPath(org, env.slug, '/secrets'),
      envParams(org, env.slug),
    );
    expect(read.status).toBe(200);
    caller = owner;

    expect((await revoke(org, 'cli', ids[0]!)).status).toBeLessThan(300);
    // Three live, still past two.
    expectPlanLimit(await approveDevice(org), 'cliDevicesPerUser', 2);
  });
});

/* ── seats ────────────────────────────────────────────────────────────────── */

describe('seats — Free seats three', () => {
  const invite = (org: Org, email = `invitee-${randomUUID().slice(0, 8)}@example.com`) =>
    call(membersRoute.POST, 'POST', `/api/orgs/${org.slug}/members`, orgParams(org), {
      email,
      role: 'developer',
    });

  async function addMembers(org: Org, count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      const member = await seedUser();
      await t.pg.query(
        `insert into org_members (id, org_id, user_id, role) values ($1, $2, $3, 'developer')`,
        [randomUUID(), org.orgId, member.id],
      );
    }
  }

  it('invites into the two seats beside the owner, and refuses a third, naming the limit and Pro', async () => {
    const org = await seedOrg();

    expect((await invite(org)).status).toBe(201);
    expect((await invite(org)).status).toBe(201);

    const refused = await invite(org);
    expect(refused.status).toBe(409);
    expect(refused.body.error?.code).toBe('conflict');
    expect(refused.body.error?.message).toBe(
      'This organisation has no seats left: all 3 members it holds are taken or promised to open ' +
        'invitations. Remove a member or revoke an invitation first, or move to the Pro plan, ' +
        'which does not limit members.',
    );
    expect(await countRows(`invitations where org_id = $1`, [org.orgId])).toBe(2);
  });

  it('leaves an organisation already seating more than three every member it has', async () => {
    const org = await seedOrg();
    await addMembers(org, 4);

    const listing = await call(
      membersRoute.GET,
      'GET',
      `/api/orgs/${org.slug}/members`,
      orgParams(org),
    );
    expect(listing.status).toBe(200);
    expect(listing.body.data).toHaveLength(5);
    expect(listing.body.seats).toMatchObject({ used: 5, limit: 3 });

    expect((await invite(org)).status).toBe(409);
    expect(await countRows(`org_members where org_id = $1`, [org.orgId])).toBe(5);
  });
});

/* ── a paid ceiling, and none ─────────────────────────────────────────────── */

describe('secrets per environment on Pro — 1,000, through promotion and restore', () => {
  const PRO = PLANS.pro.limits;
  const entryFor = (env: Env, name: string, id: string = randomUUID()) => ({
    id,
    name,
    expectedVersion: 1,
    value: {
      ciphertext: blob(name),
      clientAlgorithm: 'xk2.gcm',
      envDataKeyId: env.keyId,
      valueHmac: HMAC,
    },
  });

  function expectProLimit(answer: Answer): void {
    expect(answer.status).toBe(403);
    expect(answer.body.error?.code).toBe('plan_limit');
    expect(answer.body.error?.plan).toMatchObject({
      resource: 'secretsPerEnvironment',
      limit: PRO.secretsPerEnvironment,
      plan: 'pro',
      upgradeTo: 'team',
    });
  }

  async function proProject() {
    const org = await seedOrg();
    await setPlan(org, 'pro');
    const project = await seedProject(org);
    const staging = await seedEnv(org, project, 'staging');
    const production = await seedEnv(org, project, 'production');
    return { org, staging, production };
  }

  const promote = (org: Org, target: Env, body: unknown) =>
    call(
      promoteRoute.POST,
      'POST',
      envPath(org, target.slug, '/promote'),
      envParams(org, target.slug),
      body,
    );

  it('refuses a promotion that would carry the target past its ceiling, writing nothing', async () => {
    const { org, staging, production } = await proProject();
    await seedSecrets(org, staging, 1, 'NEW_');
    await seedSecrets(org, production, PRO.secretsPerEnvironment!);

    const answer = await promote(org, production, {
      source: 'staging',
      writes: [entryFor(production, 'NEW_1')],
      dryRun: false,
    });

    expectProLimit(answer);
    expectRefusalFiledFor('environment.promoted', 'secretsPerEnvironment', 'pro');
    expect(await countRows(`secrets where environment_id = $1`, [production.id])).toBe(1000);
  });

  it('lets one that removes as many as it creates through — weighed after its own removals', async () => {
    const { org, staging, production } = await proProject();
    await seedSecrets(org, staging, 1, 'NEW_');
    await seedSecrets(org, production, PRO.secretsPerEnvironment!);

    const answer = await promote(org, production, {
      source: 'staging',
      writes: [entryFor(production, 'NEW_1')],
      removals: ['BULK_1'],
      dryRun: false,
    });

    expect(answer.status).toBe(200);
    expect(
      await countRows(`secrets where environment_id = $1 and deleted_at is null`, [production.id]),
    ).toBe(1000);
  });

  /**
   * A restore re-creates what was deleted since the instant: an environment
   * that held 1,001 then and holds 1,000 now cannot be put back on Pro.
   */
  it('refuses a restore that would re-create past the ceiling, and allows it beneath', async () => {
    const restoreTo = async (org: Org, env: Env) => {
      const at = new Date(Date.now() - 60 * 60_000);
      return call(
        restorePointRoute.POST,
        'POST',
        envPath(org, env.slug, '/restore-point'),
        envParams(org, env.slug),
        { at: at.toISOString(), writes: [entryFor(env, 'GONE_1')], dryRun: false },
      );
    };
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
    const seedHistory = async (org: Org, env: Env, live: number) => {
      await seedSecrets(org, env, live, 'BULK_', twoHoursAgo);
      // Live at the instant, deleted half an hour ago.
      await seedSecrets(org, env, 1, 'GONE_', twoHoursAgo);
      await t.pg.query(
        `update secrets set deleted_at = now() - interval '30 minutes'
          where environment_id = $1 and name = 'GONE_1'`,
        [env.id],
      );
    };

    const full = await proProject();
    await seedHistory(full.org, full.production, PRO.secretsPerEnvironment!);
    const refused = await restoreTo(full.org, full.production);
    expectProLimit(refused);
    expectRefusalFiledFor('environment.restored', 'secretsPerEnvironment', 'pro');

    audit = [];
    const roomy = await proProject();
    await seedHistory(roomy.org, roomy.production, PRO.secretsPerEnvironment! - 1);
    const restored = await restoreTo(roomy.org, roomy.production);
    expect(restored.status).toBe(200);
    expect(
      await countRows(`secrets where environment_id = $1 and deleted_at is null`, [
        roomy.production.id,
      ]),
    ).toBe(1000);
  });
});

describe('a plan with no ceiling', () => {
  it('creates past every number Free and Pro publish, on Enterprise', async () => {
    const org = await seedOrg();
    await setPlan(org, 'enterprise');
    await seedProjects(org, 120);

    const answer = await createProject(org, 'one-more');

    expect(answer.status).toBe(201);
  });
});

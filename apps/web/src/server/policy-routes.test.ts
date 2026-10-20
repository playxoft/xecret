import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
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

/**
 * The P19 policies, end to end (§6 token policy, §7 the read-alert switch, §8
 * secret naming and strength, §9 plaintext export): the routes that set them,
 * the plan gates in front of setting them, and every write and read path that
 * obeys them — against a real database with every migration applied.
 *
 * ── What is real, and what is stubbed ──
 * Real: the routes and `authenticatedRoute`; tenancy, `can()` and the
 * entitlement engine reading memberships and the subscription row from PGlite;
 * every repository; the server envelope, under an in-memory root key, for the
 * `server`-mode environments whose values the server encrypts. Stubbed: who is
 * asking, the audit sink (captured) and the logger.
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

const policiesRoute = await import('@/app/api/orgs/[orgSlug]/policies/route');
const environmentPolicyRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/policy/route');
const pullRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/pull/route');
const exportRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/export/route');
const secretsRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/secrets/route');
const secretRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/secrets/[name]/route');
const importRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/import/route');
const tokensRoute = await import('@/app/api/orgs/[orgSlug]/tokens/service/route');
const cliTokenRoute = await import('@/app/api/cli/token/route');
const { createCliAuthCode, createSecret } = await import('@xecret/db/repositories');

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
  `xk2.gcm.${Buffer.from(`${label}`.padEnd(48, '.')).toString('base64url')}`;
const HMAC = 'A'.repeat(43);
const PUBLIC_KEY = 'A'.repeat(43);

interface User {
  id: string;
  email: string;
}

async function seedUser(): Promise<User> {
  const id = randomUUID();
  const email = `p19p-${id.slice(0, 8)}@example.com`;
  await t.pg.query(
    `insert into users (id, workos_user_id, email, email_verified) values ($1, $2, $3, true)`,
    [id, `user_${id.slice(0, 8)}`, email],
  );
  return { id, email };
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

type Plan = 'free' | 'pro' | 'team';

interface Org {
  orgId: string;
  slug: string;
  owner: User;
  orgKeyId: string | null;
}

async function seedOrg(plan: Plan): Promise<Org> {
  const owner = await seedUser();
  const orgId = randomUUID();
  const slug = `pol-${orgId.slice(0, 8)}`;
  await t.pg.query(
    `insert into organizations (id, name, slug, created_by) values ($1, 'Acme', $2, $3)`,
    [orgId, slug, owner.id],
  );
  if (plan !== 'free') await setPlan(orgId, plan);
  await addMember(orgId, owner.id, 'owner');
  return { orgId, slug, owner, orgKeyId: null };
}

async function setPlan(orgId: string, plan: Plan): Promise<void> {
  await t.pg.query(
    `insert into org_subscriptions (org_id, plan, billing_interval) values ($1, $2, $3)
     on conflict (org_id) do update set plan = excluded.plan, billing_interval = excluded.billing_interval`,
    [orgId, plan, plan === 'free' ? null : 'monthly'],
  );
}

async function addMember(orgId: string, userId: string, role: string): Promise<void> {
  await t.pg.query(`insert into org_members (id, org_id, user_id, role) values ($1, $2, $3, $4)`, [
    randomUUID(),
    orgId,
    userId,
    role,
  ]);
}

async function seedMember(org: Org, role: string): Promise<User> {
  const user = await seedUser();
  await addMember(org.orgId, user.id, role);
  return user;
}

async function seedProject(org: Org): Promise<string> {
  const id = randomUUID();
  await t.pg.query(
    `insert into projects (id, org_id, name, slug, created_by) values ($1, $2, 'api', 'api', $3)`,
    [id, org.orgId, org.owner.id],
  );
  return id;
}

interface Env {
  id: string;
  keyId: string;
  slug: string;
}

/** Each organisation's wrapped master key, for the server-mode environments under it. */
const orgKeys = new Map<string, Awaited<ReturnType<EnvelopeService['createOrgKey']>>>();

async function seedEnv(
  org: Org,
  projectId: string,
  slug: string,
  options: { production?: boolean; mode?: 'e2ee' | 'server' } = {},
): Promise<Env> {
  const id = randomUUID();
  const keyId = randomUUID();
  const mode = options.mode ?? 'e2ee';
  await t.pg.query(
    `insert into environments (id, project_id, name, slug, encryption_mode, is_production)
     values ($1, $2, $3, $4, $5, $6)`,
    [id, projectId, slug, slug, mode, options.production ?? false],
  );

  if (mode === 'e2ee') {
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
        new TextEncoder().encode(`xk2.x25519.${'A'.repeat(80)}`),
        new TextEncoder().encode(`xk2.x25519.${'A'.repeat(80)}`),
        new Uint8Array(32),
        new TextEncoder().encode(`xk2.ed25519.${'A'.repeat(86)}`),
        org.owner.id,
      ],
    );
    return { id, keyId, slug };
  }

  // The server envelope: the organisation's master key once, then this
  // environment's data key under it — the rows `loadEnvironmentKeyChain` reads.
  if (org.orgKeyId === null) {
    const orgKey = await envelope.createOrgKey(org.orgId);
    org.orgKeyId = randomUUID();
    await t.pg.query(
      `insert into org_keys (id, org_id, version, wrapped_key, wrap_iv, root_key_version) values ($1, $2, 1, $3, $4, $5)`,
      [org.orgKeyId, org.orgId, orgKey.ciphertext, orgKey.iv, orgKey.rootKeyVersion],
    );
    orgKeys.set(org.orgId, orgKey);
  }
  const envKey = await envelope.createEnvKey({
    orgId: org.orgId,
    environmentId: id,
    orgKey: orgKeys.get(org.orgId)!,
  });
  await t.pg.query(
    `insert into env_keys (id, environment_id, org_key_id, version, wrapped_key, wrap_iv) values ($1, $2, $3, 1, $4, $5)`,
    [keyId, id, org.orgKeyId, envKey.ciphertext, envKey.iv],
  );
  return { id, keyId, slug };
}

async function seedE2eeSecret(org: Org, env: Env, name: string): Promise<void> {
  await createSecret(t.db, {
    id: randomUUID(),
    orgId: org.orgId,
    environmentId: env.id,
    name,
    valueType: 'string',
    payload: {
      mode: 'e2ee',
      envDataKeyId: env.keyId,
      ciphertext: new TextEncoder().encode(blob(name)),
      clientAlgorithm: 'xk2.gcm',
    },
    valueHmac: new Uint8Array(32),
    declaredReferences: null,
    writer: { userId: org.owner.id },
  });
}

async function seedServiceToken(
  org: Org,
  projectId: string,
  env: Env,
  options: { createdAt?: Date } = {},
): Promise<Principal> {
  const tokenId = randomUUID();
  await t.pg.query(
    `insert into service_tokens (id, org_id, project_id, environment_id, name, token_hash, token_prefix, created_by, public_key, key_algorithm, created_at)
     values ($1, $2, $3, $4, 'ci', $5, 'xst_x', $6, $7, 'X25519', $8)`,
    [
      tokenId,
      org.orgId,
      projectId,
      env.id,
      new TextEncoder().encode(tokenId),
      org.owner.id,
      new Uint8Array(32),
      options.createdAt ?? new Date(),
    ],
  );
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

interface Body {
  error?: {
    code?: string;
    message?: string;
    plan?: { resource?: string; upgradeTo?: string | null };
    fields?: { field: string; message: string }[];
  };
  tokens?: { requireIpAllowlist: boolean; maxLifetimeDays: number | null };
  secrets?: { enabled: boolean; namePattern: string | null };
  features?: Record<string, { enabled: boolean; upgradeTo: string | null }>;
  environment?: {
    plaintextExport?: string;
    readAlerts?: boolean | null;
    readAlertsActive?: boolean;
  };
  policy?: { plaintextExport?: string; requireIpAllowlist?: boolean };
  keys?: { isProduction?: boolean };
  data?: { id: string; meetsPolicy?: boolean }[];
  token?: string;
  expiresAt?: string | null;
}

interface Answer {
  status: number;
  body: Body;
  headers: Headers;
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
  let parsed: Body = {};
  try {
    parsed = text === '' ? {} : (JSON.parse(text) as Body);
  } catch {
    // A rendered document, not JSON.
  }
  return { status: response.status, body: parsed, headers: response.headers, text };
}

function envPath(org: Org, env: string, rest = '') {
  return {
    path: `/api/orgs/${org.slug}/projects/api/environments/${env}${rest}`,
    params: { orgSlug: org.slug, projectSlug: 'api', envSlug: env },
  };
}

const getPolicies = (org: Org) =>
  call(policiesRoute.GET, 'GET', `/api/orgs/${org.slug}/policies`, { orgSlug: org.slug });
const patchPolicies = (org: Org, body: unknown) =>
  call(policiesRoute.PATCH, 'PATCH', `/api/orgs/${org.slug}/policies`, { orgSlug: org.slug }, body);
function patchEnvPolicy(org: Org, env: string, body: unknown) {
  const { path, params } = envPath(org, env, '/policy');
  return call(environmentPolicyRoute.PATCH, 'PATCH', path, params, body);
}

const STRICT_TOKENS = { requireIpAllowlist: true, maxLifetimeDays: 30 };
const OPEN_TOKENS = { requireIpAllowlist: false, maxLifetimeDays: null };
const SECRET_POLICY = {
  enabled: true,
  scope: 'all',
  namePattern: '[A-Z][A-Z0-9_]*',
  minValueEntropyBits: 64,
  entropyAppliesTo: ['TOKEN'],
  forbiddenSubstrings: ['changeme'],
};

function createE2ee(org: Org, env: Env, name: string) {
  const { path, params } = envPath(org, env.slug, '/secrets');
  return call(secretsRoute.POST, 'POST', path, params, {
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
}

function createServer(org: Org, env: Env, name: string, value: string) {
  const { path, params } = envPath(org, env.slug, '/secrets');
  return call(secretsRoute.POST, 'POST', path, params, { name, value });
}

function mintToken(org: Org, env: string, extra: Record<string, unknown> = {}) {
  return call(
    tokensRoute.POST,
    'POST',
    `/api/orgs/${org.slug}/tokens/service`,
    { orgSlug: org.slug },
    { name: 'deploy', projectSlug: 'api', environmentSlug: env, publicKey: PUBLIC_KEY, ...extra },
  );
}

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const recorded = (action: string) => audit.filter((event) => event.action === action);
const fields = (answer: Answer) => answer.body.error?.fields?.map((field) => field.field) ?? [];

/* ── the organisation's policies: reading ─────────────────────────────────── */

describe('GET /api/orgs/{org}/policies', () => {
  it('answers every member with the defaults and what the plan includes', async () => {
    const org = await seedOrg('free');
    caller = sessionOf(await seedMember(org, 'developer'));

    const answer = await getPolicies(org);
    expect(answer.status).toBe(200);
    expect(answer.body.tokens).toEqual(OPEN_TOKENS);
    expect(answer.body.secrets?.enabled).toBe(false);
    expect(answer.body.features?.['tokenIpAllowlist']).toEqual({
      enabled: false,
      upgradeTo: 'pro',
    });
    expect(answer.body.features?.['secretPolicy']).toEqual({ enabled: false, upgradeTo: 'team' });
    expect(answer.body.features?.['disableEnvExport']).toEqual({
      enabled: false,
      upgradeTo: 'team',
    });
    expect(answer.body.features?.['newIpReadAlerts']).toEqual({ enabled: false, upgradeTo: 'pro' });
  });

  it('answers a service token, whose writes the value rules govern too', async () => {
    const org = await seedOrg('team');
    const project = await seedProject(org);
    const env = await seedEnv(org, project, 'ci');
    caller = await seedServiceToken(org, project, env);

    const answer = await getPolicies(org);
    expect(answer.status).toBe(200);
    expect(answer.body.features?.['secretPolicy']?.enabled).toBe(true);
  });

  it('refuses an unauthenticated caller, and a stranger sees no organisation', async () => {
    const org = await seedOrg('free');
    caller = null;
    expect((await getPolicies(org)).status).toBe(401);

    caller = sessionOf(await seedUser());
    expect((await getPolicies(org)).status).toBe(404);
  });
});

/* ── the organisation's policies: changing ────────────────────────────────── */

describe('PATCH /api/orgs/{org}/policies', () => {
  it('is for owners and admins: a developer is refused, and the refusal is filed', async () => {
    const org = await seedOrg('team');
    caller = sessionOf(await seedMember(org, 'developer'));

    const answer = await patchPolicies(org, { tokens: STRICT_TOKENS });
    expect(answer.status).toBe(403);
    expect(recorded('org.policy_changed')).toEqual([
      expect.objectContaining({ outcome: 'denied' }),
    ]);
  });

  it('refuses a service token', async () => {
    const org = await seedOrg('team');
    const project = await seedProject(org);
    caller = await seedServiceToken(org, project, await seedEnv(org, project, 'ci'));
    expect((await patchPolicies(org, { tokens: STRICT_TOKENS })).status).toBe(403);
  });

  it('refuses a Free organisation tightening the token policy, naming the plan that would allow it', async () => {
    const org = await seedOrg('free');
    caller = sessionOf(org.owner);

    const answer = await patchPolicies(org, { tokens: STRICT_TOKENS });
    expect(answer.status).toBe(403);
    expect(answer.body.error?.code).toBe('plan_limit');
    expect(answer.body.error?.plan?.upgradeTo).toBe('pro');
    expect(recorded('org.policy_changed')).toEqual([
      expect.objectContaining({
        outcome: 'error',
        metadata: expect.objectContaining({
          reason: 'quotaExceeded',
          limitName: 'tokenIpAllowlist',
          plan: 'free',
        }),
      }),
    ]);
    expect((await getPolicies(org)).body.tokens).toEqual(OPEN_TOKENS);
  });

  it('lets a Pro organisation set it, and files the change', async () => {
    const org = await seedOrg('pro');
    caller = sessionOf(org.owner);

    const answer = await patchPolicies(org, { tokens: STRICT_TOKENS });
    expect(answer.status).toBe(200);
    expect(answer.body.tokens).toEqual(STRICT_TOKENS);
    expect(recorded('org.policy_changed')).toEqual([
      expect.objectContaining({
        outcome: 'success',
        metadata: expect.objectContaining({ policyName: 'tokens' }),
      }),
    ]);
  });

  it('keeps a downgraded organisation’s policy, lets it loosen, and refuses tightening it again', async () => {
    const org = await seedOrg('pro');
    caller = sessionOf(org.owner);
    expect((await patchPolicies(org, { tokens: STRICT_TOKENS })).status).toBe(200);

    await setPlan(org.orgId, 'free');
    expect((await getPolicies(org)).body.tokens).toEqual(STRICT_TOKENS);

    const looser = { requireIpAllowlist: true, maxLifetimeDays: 90 };
    expect((await patchPolicies(org, { tokens: looser })).status).toBe(200);
    const tighter = { requireIpAllowlist: true, maxLifetimeDays: 7 };
    expect((await patchPolicies(org, { tokens: tighter })).body.error?.code).toBe('plan_limit');
    expect((await patchPolicies(org, { tokens: OPEN_TOKENS })).status).toBe(200);
  });

  it('gates switching the secret policy on behind Team, and never switching it off', async () => {
    const pro = await seedOrg('pro');
    caller = sessionOf(pro.owner);
    const refused = await patchPolicies(pro, { secrets: SECRET_POLICY });
    expect(refused.body.error?.code).toBe('plan_limit');
    expect(refused.body.error?.plan?.upgradeTo).toBe('team');

    const team = await seedOrg('team');
    caller = sessionOf(team.owner);
    expect((await patchPolicies(team, { secrets: SECRET_POLICY })).status).toBe(200);

    await setPlan(team.orgId, 'free');
    const edited = { ...SECRET_POLICY, forbiddenSubstrings: ['changeme', 'hunter2'] };
    expect((await patchPolicies(team, { secrets: edited })).body.error?.code).toBe('plan_limit');
    const off = { ...SECRET_POLICY, enabled: false };
    expect((await patchPolicies(team, { secrets: off })).status).toBe(200);
  });

  it('refuses a name pattern that cannot be stored, before the plan is asked', async () => {
    const org = await seedOrg('team');
    caller = sessionOf(org.owner);

    for (const namePattern of ['(A+)+', '[unclosed']) {
      const answer = await patchPolicies(org, { secrets: { ...SECRET_POLICY, namePattern } });
      expect(answer.status).toBe(422);
      expect(fields(answer)).toEqual(['secrets.namePattern']);
    }
  });

  it('refuses a body with neither policy, and a field it does not know', async () => {
    const org = await seedOrg('team');
    caller = sessionOf(org.owner);
    expect((await patchPolicies(org, {})).status).toBe(422);
    expect((await patchPolicies(org, { tokens: { ...OPEN_TOKENS, extra: 1 } })).status).toBe(422);
  });
});

/* ── §6: the token policy, obeyed ─────────────────────────────────────────── */

describe('the token policy at minting', () => {
  async function strictOrg(plan: Plan = 'pro') {
    const org = await seedOrg(plan);
    const project = await seedProject(org);
    await seedEnv(org, project, 'production', { production: true });
    caller = sessionOf(org.owner);
    expect((await patchPolicies(org, { tokens: STRICT_TOKENS })).status).toBe(200);
    audit = [];
    return { org, project };
  }

  it('refuses a token without an allowlist or an expiry, field by field, and files it', async () => {
    const { org } = await strictOrg();

    const answer = await mintToken(org, 'production');
    expect(answer.status).toBe(422);
    expect(fields(answer)).toEqual(['ipAllowlist', 'expiresAt']);
    expect(recorded('token.created')).toEqual([
      expect.objectContaining({
        outcome: 'error',
        metadata: expect.objectContaining({ reason: 'policyRefused', policyName: 'tokens' }),
      }),
    ]);
  });

  it('refuses an expiry past the cap, and mints one inside it', async () => {
    const { org } = await strictOrg();

    const late = await mintToken(org, 'production', {
      ipAllowlist: ['198.51.100.0/24'],
      expiresAt: inDays(31),
    });
    expect(fields(late)).toEqual(['expiresAt']);

    const minted = await mintToken(org, 'production', {
      ipAllowlist: ['198.51.100.0/24'],
      expiresAt: inDays(29),
    });
    expect(minted.status).toBe(201);
    expect(minted.body.token).toBeTypeOf('string');
  });

  it('still holds a downgraded organisation to the policy it set', async () => {
    const { org } = await strictOrg();
    await setPlan(org.orgId, 'free');
    expect((await mintToken(org, 'production')).status).toBe(422);
  });

  it('mints exactly as before for an organisation with no policy', async () => {
    const org = await seedOrg('free');
    const project = await seedProject(org);
    await seedEnv(org, project, 'production');
    caller = sessionOf(org.owner);
    expect((await mintToken(org, 'production')).status).toBe(201);
  });

  it('marks, rather than revokes, a token minted before the policy', async () => {
    const org = await seedOrg('pro');
    const project = await seedProject(org);
    const env = await seedEnv(org, project, 'production');
    const old = await seedServiceToken(org, project, env);
    caller = sessionOf(org.owner);
    expect((await patchPolicies(org, { tokens: STRICT_TOKENS })).status).toBe(200);

    const listing = await call(tokensRoute.GET, 'GET', `/api/orgs/${org.slug}/tokens/service`, {
      orgSlug: org.slug,
    });
    expect(listing.status).toBe(200);
    expect(listing.body.data).toEqual([
      expect.objectContaining({ id: (old as { tokenId: string }).tokenId, meetsPolicy: false }),
    ]);
    expect(listing.body.policy?.requireIpAllowlist).toBe(true);
  });
});

describe('the token policy at `xecret login`', () => {
  async function exchange(org: Org): Promise<Answer> {
    const verifier = 'v'.repeat(64);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const issued = await createCliAuthCode(t.db, {
      userId: org.owner.id,
      orgId: org.orgId,
      deviceName: 'laptop',
      codeChallenge: challenge,
      ipAddress: '203.0.113.5',
    });
    caller = null;
    return call(
      cliTokenRoute.POST,
      'POST',
      '/api/cli/token',
      {},
      {
        code: issued.code,
        codeVerifier: verifier,
      },
    );
  }

  it('issues a login with the cap as its expiry when the organisation caps lifetimes', async () => {
    const org = await seedOrg('pro');
    caller = sessionOf(org.owner);
    expect(
      (await patchPolicies(org, { tokens: { requireIpAllowlist: false, maxLifetimeDays: 14 } }))
        .status,
    ).toBe(200);

    const answer = await exchange(org);
    expect(answer.status).toBe(201);
    const expiresAt = new Date(String(answer.body.expiresAt)).getTime();
    expect(Math.abs(expiresAt - (Date.now() + 14 * 86_400_000))).toBeLessThan(60_000);
  });

  it('issues one that never expires otherwise', async () => {
    const org = await seedOrg('free');
    const answer = await exchange(org);
    expect(answer.status).toBe(201);
    expect(answer.body.expiresAt).toBeNull();
  });
});

/* ── §8: the secret policy, obeyed ────────────────────────────────────────── */

describe('the secret policy at write', () => {
  async function governed(
    options: { scope?: 'all' | 'production'; mode?: 'e2ee' | 'server' } = {},
  ) {
    const org = await seedOrg('team');
    const project = await seedProject(org);
    const env = await seedEnv(org, project, 'development', { mode: options.mode ?? 'e2ee' });
    caller = sessionOf(org.owner);
    expect(
      (await patchPolicies(org, { secrets: { ...SECRET_POLICY, scope: options.scope ?? 'all' } }))
        .status,
    ).toBe(200);
    audit = [];
    return { org, project, env };
  }

  it('refuses a name the pattern forbids, with the rule, and files the refusal', async () => {
    const { org, env } = await governed();

    const answer = await createE2ee(org, env, 'lower_case');
    expect(answer.status).toBe(422);
    expect(fields(answer)).toEqual(['name']);
    expect(answer.body.error?.fields?.[0]?.message).toContain('[A-Z][A-Z0-9_]*');
    expect(recorded('secret.created')).toEqual([
      expect.objectContaining({
        outcome: 'error',
        metadata: expect.objectContaining({
          reason: 'policyRefused',
          policyName: 'secrets',
          secretName: 'lower_case',
        }),
      }),
    ]);

    expect((await createE2ee(org, env, 'UPPER_CASE')).status).toBe(201);
  });

  it('leaves environments outside a production-only policy alone', async () => {
    const { org, env } = await governed({ scope: 'production' });
    expect((await createE2ee(org, env, 'lower_case')).status).toBe(201);
  });

  it('applies to a rename, which introduces a name', async () => {
    const { org, env } = await governed();
    await seedE2eeSecret(org, env, 'GOOD');
    const { path, params } = envPath(org, env.slug, '/secrets/GOOD');

    const answer = await call(
      secretRoute.PUT,
      'PUT',
      path,
      { ...params, name: 'GOOD' },
      {
        name: 'bad_name',
      },
    );
    expect(answer.status).toBe(422);
    expect(fields(answer)).toEqual(['name']);
  });

  it('never blocks a write to, or a read of, a secret that predates the policy', async () => {
    const { org, env } = await governed();
    await seedE2eeSecret(org, env, 'legacy_name');

    const { path, params } = envPath(org, env.slug, '/secrets/legacy_name');
    const update = await call(
      secretRoute.PATCH,
      'PATCH',
      path,
      { ...params, name: 'legacy_name' },
      {
        expectedVersion: 2,
        value: {
          ciphertext: blob('v2'),
          clientAlgorithm: 'xk2.gcm',
          envDataKeyId: env.keyId,
          valueHmac: 'C'.repeat(43),
        },
      },
    );
    expect(update.status).toBe(200);

    const pulled = envPath(org, env.slug, '/pull?format=json');
    expect((await call(pullRoute.GET, 'GET', pulled.path, pulled.params)).status).toBe(200);
  });

  it('refuses an import introducing a forbidden name — in the preview too, unaudited there', async () => {
    const { org, env } = await governed();
    const { path, params } = envPath(org, env.slug, '/import');
    const entry = (name: string) => ({
      id: randomUUID(),
      name,
      expectedVersion: 1,
      value: {
        ciphertext: blob(name),
        clientAlgorithm: 'xk2.gcm',
        envDataKeyId: env.keyId,
        valueHmac: HMAC,
      },
    });

    const preview = await call(importRoute.POST, 'POST', path, params, {
      dryRun: true,
      entries: [entry('FINE'), entry('not_fine')],
    });
    expect(preview.status).toBe(422);
    expect(fields(preview)).toEqual(['not_fine']);
    expect(audit).toEqual([]);

    const real = await call(importRoute.POST, 'POST', path, params, {
      dryRun: false,
      entries: [entry('FINE'), entry('not_fine')],
    });
    expect(real.status).toBe(422);
    expect(recorded('secret.imported')).toEqual([
      expect.objectContaining({
        outcome: 'error',
        metadata: expect.objectContaining({ policyName: 'secrets' }),
      }),
    ]);
  });

  it('holds a server-mode value to the value rules, without echoing it', async () => {
    const { org, env } = await governed({ mode: 'server' });

    const weak = await createServer(org, env, 'GITHUB_TOKEN', 'short');
    expect(weak.status).toBe(422);
    expect(fields(weak)).toEqual(['value']);
    expect(weak.text).not.toContain('short');

    const forbidden = await createServer(org, env, 'GREETING', 'please changeme');
    expect(fields(forbidden)).toEqual(['value']);
    expect(forbidden.text).not.toContain('please');

    expect(
      (await createServer(org, env, 'GITHUB_TOKEN', 'q8Z2xL0vR9sT4bW7nY1cK6mP3dF5gH0j')).status,
    ).toBe(201);
  });

  it('asks nothing of an organisation whose policy is off', async () => {
    const org = await seedOrg('team');
    const project = await seedProject(org);
    const env = await seedEnv(org, project, 'development');
    caller = sessionOf(org.owner);
    expect((await createE2ee(org, env, 'anything_goes')).status).toBe(201);
  });
});

/* ── §9 and §7: the environment's switches ────────────────────────────────── */

describe('PATCH …/environments/{env}/policy', () => {
  it('is for those who may update the environment', async () => {
    const org = await seedOrg('team');
    const project = await seedProject(org);
    await seedEnv(org, project, 'production', { production: true });
    caller = sessionOf(await seedMember(org, 'developer'));

    const answer = await patchEnvPolicy(org, 'production', { plaintextExport: 'disabled' });
    expect(answer.status).toBe(403);
    expect(recorded('environment.policy_changed')).toEqual([
      expect.objectContaining({ outcome: 'denied' }),
    ]);
  });

  it('refuses a service token', async () => {
    const org = await seedOrg('team');
    const project = await seedProject(org);
    const env = await seedEnv(org, project, 'production');
    caller = await seedServiceToken(org, project, env);
    expect((await patchEnvPolicy(org, 'production', { plaintextExport: 'disabled' })).status).toBe(
      403,
    );
  });

  it('gates disabling export behind Team, and files the refusal', async () => {
    const org = await seedOrg('pro');
    const project = await seedProject(org);
    await seedEnv(org, project, 'production');
    caller = sessionOf(org.owner);

    const answer = await patchEnvPolicy(org, 'production', { plaintextExport: 'disabled' });
    expect(answer.status).toBe(403);
    expect(answer.body.error?.plan?.upgradeTo).toBe('team');
    expect(recorded('environment.policy_changed')).toEqual([
      expect.objectContaining({
        outcome: 'error',
        metadata: expect.objectContaining({
          reason: 'quotaExceeded',
          limitName: 'disableEnvExport',
        }),
      }),
    ]);
  });

  it('lets a Team organisation disable it, and keeps it disabled after a downgrade', async () => {
    const org = await seedOrg('team');
    const project = await seedProject(org);
    await seedEnv(org, project, 'production');
    caller = sessionOf(org.owner);

    const answer = await patchEnvPolicy(org, 'production', { plaintextExport: 'disabled' });
    expect(answer.status).toBe(200);
    expect(answer.body.environment?.plaintextExport).toBe('disabled');
    expect(recorded('environment.policy_changed')).toEqual([
      expect.objectContaining({
        outcome: 'success',
        metadata: expect.objectContaining({ policyName: 'plaintextExport' }),
      }),
    ]);

    await setPlan(org.orgId, 'free');
    const pulled = envPath(org, 'production', '/pull?format=json');
    const bundle = await call(pullRoute.GET, 'GET', pulled.path, pulled.params);
    expect(bundle.body.policy?.plaintextExport).toBe('disabled');

    // Undoing it needs no plan; doing it again does.
    expect((await patchEnvPolicy(org, 'production', { plaintextExport: 'allowed' })).status).toBe(
      200,
    );
    expect(
      (await patchEnvPolicy(org, 'production', { plaintextExport: 'disabled' })).body.error?.code,
    ).toBe('plan_limit');
  });

  it('gates switching read alerts on where they default off, and never switching them off', async () => {
    const org = await seedOrg('free');
    const project = await seedProject(org);
    await seedEnv(org, project, 'staging');
    await seedEnv(org, project, 'production', { production: true });
    caller = sessionOf(org.owner);

    expect(
      (await patchEnvPolicy(org, 'staging', { readAlerts: true })).body.error?.plan?.upgradeTo,
    ).toBe('pro');
    const off = await patchEnvPolicy(org, 'production', { readAlerts: false });
    expect(off.status).toBe(200);
    expect(off.body.environment).toMatchObject({ readAlerts: false, readAlertsActive: false });

    // Back to the default — on, for production — is a re-enable, and gated.
    expect((await patchEnvPolicy(org, 'production', { readAlerts: null })).status).toBe(403);
    await setPlan(org.orgId, 'pro');
    const restored = await patchEnvPolicy(org, 'production', { readAlerts: null });
    expect(restored.body.environment).toMatchObject({ readAlerts: null, readAlertsActive: true });
  });

  it('refuses an empty body', async () => {
    const org = await seedOrg('team');
    const project = await seedProject(org);
    await seedEnv(org, project, 'production');
    caller = sessionOf(org.owner);
    expect((await patchEnvPolicy(org, 'production', {})).status).toBe(422);
  });
});

describe('plaintext export disabled', () => {
  async function disabled(mode: 'e2ee' | 'server') {
    const org = await seedOrg('team');
    const project = await seedProject(org);
    const env = await seedEnv(org, project, 'production', { mode, production: true });
    caller = sessionOf(org.owner);
    if (mode === 'server') {
      expect((await createServer(org, env, 'DATABASE_URL', 'postgres://example')).status).toBe(201);
    } else {
      await seedE2eeSecret(org, env, 'DATABASE_URL');
    }
    expect((await patchEnvPolicy(org, 'production', { plaintextExport: 'disabled' })).status).toBe(
      200,
    );
    audit = [];
    return { org, env };
  }

  it('refuses a server-mode document pull before decrypting, naming the policy and who can change it', async () => {
    const { org } = await disabled('server');
    const { path, params } = envPath(org, 'production', '/pull?format=env');

    const answer = await call(pullRoute.GET, 'GET', path, params);
    expect(answer.status).toBe(403);
    expect(answer.body.error?.message).toMatch(/^export_disabled: /);
    expect(answer.body.error?.message).toContain('owner or admin');
    expect(answer.text).not.toContain('postgres://');
    expect(recorded('secret.read')).toEqual([
      expect.objectContaining({
        outcome: 'error',
        metadata: expect.objectContaining({
          reason: 'policyRefused',
          policyName: 'plaintextExport',
        }),
      }),
    ]);
  });

  it('still serves the JSON pull `xecret run` reads, marked so the CLI refuses `pull`', async () => {
    const { org } = await disabled('server');
    const { path, params } = envPath(org, 'production', '/pull?format=json');

    const answer = await call(pullRoute.GET, 'GET', path, params);
    expect(answer.status).toBe(200);
    expect(answer.headers.get('x-xecret-plaintext-export')).toBe('disabled');
  });

  it('marks an allowed environment as allowed', async () => {
    const org = await seedOrg('team');
    const project = await seedProject(org);
    const env = await seedEnv(org, project, 'development', { mode: 'server' });
    caller = sessionOf(org.owner);
    expect((await createServer(org, env, 'PORT', '5432')).status).toBe(201);

    const { path, params } = envPath(org, 'development', '/pull?format=env');
    const answer = await call(pullRoute.GET, 'GET', path, params);
    expect(answer.status).toBe(200);
    expect(answer.headers.get('x-xecret-plaintext-export')).toBe('allowed');
  });

  it('refuses the export download in either mode', async () => {
    for (const mode of ['server', 'e2ee'] as const) {
      const { org } = await disabled(mode);
      const { path, params } = envPath(org, 'production', '/export?format=env');
      const answer = await call(exportRoute.GET, 'GET', path, params);
      expect(answer.status).toBe(403);
      expect(answer.body.error?.message).toMatch(/^export_disabled: /);
    }
  });

  it('carries the policy in the end-to-end encrypted bundle, and production on the keys', async () => {
    const { org } = await disabled('e2ee');
    const { path, params } = envPath(org, 'production', '/pull?format=json');

    const answer = await call(pullRoute.GET, 'GET', path, params);
    expect(answer.status).toBe(200);
    expect(answer.body.policy).toEqual({ plaintextExport: 'disabled' });
    expect(answer.body.keys?.isProduction).toBe(true);
  });

  it('never stops a service token reading the environment it is pinned to', async () => {
    const org = await seedOrg('team');
    const project = await seedProject(org);
    const env = await seedEnv(org, project, 'production', { mode: 'server' });
    caller = sessionOf(org.owner);
    expect((await createServer(org, env, 'API_URL', 'https://api.example')).status).toBe(201);
    expect((await patchEnvPolicy(org, 'production', { plaintextExport: 'disabled' })).status).toBe(
      200,
    );

    caller = await seedServiceToken(org, project, env);
    const { path, params } = envPath(org, 'production', '/pull?format=json');
    const answer = await call(pullRoute.GET, 'GET', path, params);
    expect(answer.status).toBe(200);
    expect(answer.text).toContain('https://api.example');
  });
});

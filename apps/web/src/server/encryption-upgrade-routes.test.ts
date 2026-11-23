import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditRecord } from '@xecret/core/audit';
import {
  EnvelopeService,
  generateKeyBytes,
  InMemoryKeyProvider,
  parseRootKeyMaterial,
  toBase64Url,
} from '@xecret/core/crypto';
import {
  computeValueHmac,
  decryptSecret,
  generateEncryptionKeyPair,
  generateEnvironmentDataKey,
  generateEnvironmentHmacKey,
  generateSigningKeyPair,
  openGrant,
} from '@xecret/core/crypto/client';
import type { Bytes } from '@xecret/core/crypto/client';
import { uuidv7 } from '@xecret/core/ids';
import { RepositoryError, updateSecretMetadata } from '@xecret/db/repositories';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '@xecret/db/testing';
import type { TestDatabase } from '@xecret/db/testing';
import { autoUpgradeEligible, buildUpgradeBody } from '@/components/envkeys/encryption-upgrade';
import type {
  UpgradeBody,
  UpgradeMaterial,
  UpgradePreview,
  UpgradeResult,
} from '@/components/envkeys/encryption-upgrade';
import type { VaultKeyMaterial } from '@/components/vault/key-store';
import type { Principal } from './actor';
import type { ServiceContext } from './context';
import { errors } from './errors';
import { createLogger } from './logging';
import type { RequestLog } from './logging';
import { ORIGIN, routeFixtures } from './testing/route-fixtures';
import type { Env, Org, User } from './testing/route-fixtures';

/**
 * The upgrade of a `server`-mode environment to end-to-end encryption, through
 * its routes, against PGlite and real cryptography on both sides.
 *
 * ── What "real" means here ──
 * The environment is seeded the way production's were: secrets written through
 * the server-mode routes, under a key the real envelope wrapped. The upgrade
 * request is built by the **dashboard's own** payload builder
 * (`buildUpgradeBody`), from what the material route actually returned, with a
 * freshly generated key — and afterwards every version is read back through the
 * end-to-end encrypted read routes and decrypted with that key, to the value it
 * held before. A builder that bound the wrong version into an AAD, or a server
 * that stored a blob under the wrong row, fails here as a decryption failure,
 * which is the only way such a bug can be seen at all.
 *
 * ── The refusals ──
 * Every refusal is followed by the same check: the environment is still
 * entirely `server`-mode — its key, its rows, its notes, its deleted secret, its
 * token — and still reads back through the server path. A refusal that left a
 * single row rewritten would be a value nobody could ever open again.
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
const meter = vi.hoisted(() => ({ countSecretFetch: vi.fn() }));
vi.mock('./billing/usage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./billing/usage')>()),
  countSecretFetch: meter.countSecretFetch,
}));
// The rate limiter, observed: the preview must spend nothing (review round 1, 7).
const limiter = vi.hoisted(() => ({ spent: [] as string[] }));
vi.mock('./rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./rate-limit')>();
  return {
    ...actual,
    enforce: (env: never, bucket: string, key: string) => {
      limiter.spent.push(bucket);
      return actual.enforce(env, bucket as never, key);
    },
  };
});
// A seam in the token-minting route, between its early mode check and its
// transaction, where a test lands an upgrade (review round 1, 9).
const hooks = vi.hoisted(() => ({ beforeTokenTransaction: null as null | (() => Promise<void>) }));
vi.mock('@xecret/db/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xecret/db/repositories')>();
  return {
    ...actual,
    loadOrgPolicies: async (...args: Parameters<typeof actual.loadOrgPolicies>) => {
      const hook = hooks.beforeTokenTransaction;
      hooks.beforeTokenTransaction = null;
      if (hook !== null) await hook();
      return actual.loadOrgPolicies(...args);
    },
  };
});

const upgradeRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/encryption-upgrade/route');
const materialRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/encryption-upgrade/material/route');
const secretsRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/secrets/route');
const secretRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/secrets/[name]/route');
const versionRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/secrets/[name]/versions/[version]/route');
const keysRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/keys/route');
const tokensRoute = await import('@/app/api/orgs/[orgSlug]/tokens/service/route');
const { decryptEnvironment, writeSecretValue } = await import('./secrets-service');
const { resolveEnvironmentPath } = await import('./tenancy');

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
  actor.isUnlocked.mockImplementation(() => true);
  audit = [];
  deferred = [];
  limiter.spent = [];
  hooks.beforeTokenTransaction = null;
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

// ── The world every test starts from ─────────────────────────────────────────

/** What production's `server`-mode environments look like, seeded through the server path. */
interface World {
  org: Org;
  projectId: string;
  env: Env;
  vault: VaultKeyMaterial;
  developer: User;
  tokenId: string;
  /** Every version of every live secret, oldest first — what must survive. */
  values: Record<string, string[]>;
  notes: Record<string, string | null>;
}

const DB_VALUES = ['postgres://one', 'postgres://two', 'postgres://three'];
const API_VALUE = 'k-live-café-1';
const DB_NOTE = 'primary database — rotate quarterly';

function bytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** A vault with real public keys, so the grant the upgrade writes really opens. */
async function seedVault(user: User): Promise<VaultKeyMaterial> {
  const enc = generateEncryptionKeyPair();
  const sign = generateSigningKeyPair();
  const wrapped = new TextEncoder().encode(`xk2.gcm.${'A'.repeat(80)}`);
  await t.pg.query(
    `insert into user_keys
       (user_id, enc_public_key, enc_private_key_enc, sign_public_key, sign_private_key_enc,
        kdf_salt, kdf_params, unlock_verifier_hash, uk_unlock_verifier_hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      user.id,
      enc.publicKey,
      wrapped,
      sign.publicKey,
      wrapped,
      bytes(16),
      JSON.stringify({ alg: 'argon2id', v: 19, m: 19456, t: 1, p: 1, len: 32 }),
      bytes(32),
      bytes(32),
    ],
  );
  return {
    userId: user.id,
    userKey: bytes(32) as Bytes,
    encPrivateKey: enc.privateKey,
    encPublicKey: enc.publicKey,
    signPrivateKey: sign.privateKey,
    signPublicKey: sign.publicKey,
  };
}

async function seedKeylessToken(org: Org, projectId: string, env: Env, name: string) {
  const id = crypto.randomUUID();
  await t.pg.query(
    `insert into service_tokens (id, org_id, project_id, environment_id, name, token_hash, token_prefix, created_by)
     values ($1, $2, $3, $4, $5, $6, 'xst_live_ab12', $7)`,
    [id, org.orgId, projectId, env.id, name, new TextEncoder().encode(id), org.owner.id],
  );
  return id;
}

async function seedMemberWithId(org: Org, role: string): Promise<{ user: User; memberId: string }> {
  const user = await f.seedUser();
  const memberId = crypto.randomUUID();
  await t.pg.query(`insert into org_members (id, org_id, user_id, role) values ($1, $2, $3, $4)`, [
    memberId,
    org.orgId,
    user.id,
    role,
  ]);
  return { user, memberId };
}

function at(org: Org, envSlug: string, rest: string, extra: Record<string, string> = {}) {
  const { path, params } = f.envPath(org, envSlug, rest);
  return { path, params: { ...params, ...extra } };
}

async function writeServerSecret(
  org: Org,
  envSlug: string,
  name: string,
  value: string,
  note?: string,
) {
  const { path, params } = at(org, envSlug, '/secrets');
  const answer = await f.call(secretsRoute.POST, 'POST', path, params, {
    name,
    value,
    valueType: 'string',
    ...(note === undefined ? {} : { note }),
  });
  expect(answer.status).toBe(201);
}

async function rotateServerSecret(org: Org, envSlug: string, name: string, value: string) {
  const { path, params } = at(org, envSlug, `/secrets/${name}`, { name });
  const answer = await f.call(secretRoute.PATCH, 'PATCH', path, params, { value });
  expect(answer.status).toBe(200);
}

async function deleteSecret(org: Org, envSlug: string, name: string) {
  const { path, params } = at(org, envSlug, `/secrets/${name}`, { name });
  const answer = await f.call(secretRoute.DELETE, 'DELETE', path, params);
  expect(answer.status).toBeLessThan(300);
}

async function setup(): Promise<World> {
  const org = await f.seedOrg('pro');
  const projectId = await f.seedProject(org);
  const env = await f.seedEnv(org, projectId, 'legacy', { mode: 'server' });
  const vault = await seedVault(org.owner);
  const developer = await f.seedMember(org, 'developer');
  caller = f.sessionOf(org.owner);

  await writeServerSecret(org, 'legacy', 'DATABASE_URL', DB_VALUES[0]!, DB_NOTE);
  await rotateServerSecret(org, 'legacy', 'DATABASE_URL', DB_VALUES[1]!);
  await rotateServerSecret(org, 'legacy', 'DATABASE_URL', DB_VALUES[2]!);
  await writeServerSecret(org, 'legacy', 'API_KEY', API_VALUE);
  await writeServerSecret(org, 'legacy', 'RETIRED', 'retired-value', 'gone');
  await deleteSecret(org, 'legacy', 'RETIRED');
  const tokenId = await seedKeylessToken(org, projectId, env, 'deploy');

  audit = [];
  return {
    org,
    projectId,
    env,
    vault,
    developer,
    tokenId,
    values: { DATABASE_URL: [...DB_VALUES], API_KEY: [API_VALUE] },
    notes: { DATABASE_URL: DB_NOTE, API_KEY: null },
  };
}

async function preview(world: World, envSlug = 'legacy') {
  const { path, params } = at(world.org, envSlug, '/encryption-upgrade');
  return f.call<{ upgrade: UpgradePreview }>(upgradeRoute.GET, 'GET', path, params);
}

async function readMaterial(world: World, envSlug = 'legacy') {
  const { path, params } = at(world.org, envSlug, '/encryption-upgrade/material');
  return f.call<{ material: UpgradeMaterial }>(materialRoute.GET, 'GET', path, params);
}

async function material(world: World, envSlug = 'legacy'): Promise<UpgradeMaterial> {
  const answer = await readMaterial(world, envSlug);
  expect(answer.status).toBe(200);
  return answer.body.material;
}

interface Built {
  body: UpgradeBody;
  edk: Bytes;
  ehk: Bytes;
}

/** The request, built by the dashboard's own builder from the material read. */
async function build(world: World, read: UpgradeMaterial): Promise<Built> {
  const edk = generateEnvironmentDataKey();
  const ehk = generateEnvironmentHmacKey();
  const body = await buildUpgradeBody({
    vault: world.vault,
    orgId: world.org.orgId,
    material: read,
    keys: { envDataKeyId: uuidv7(), edk, ehk },
  });
  return { body, edk, ehk };
}

async function post(world: World, body: unknown, envSlug = 'legacy') {
  const { path, params } = at(world.org, envSlug, '/encryption-upgrade');
  return f.call<{ upgraded: UpgradeResult; error?: { code: string; message: string } }>(
    upgradeRoute.POST,
    'POST',
    path,
    params,
    body,
  );
}

async function rows<T>(sql: string, params: unknown[]): Promise<T[]> {
  const result = (await t.pg.query(sql, params)) as { rows: T[] };
  return result.rows;
}

/** A deep copy, so one refusal test can mutate a body without touching another's. */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * The environment is exactly as it was: `server`-mode, every row under the
 * server's key, notes in the clear, the deleted secret and the token where they
 * were — and every value still reads back through the server path.
 */
async function expectUntouched(world: World): Promise<void> {
  const [environment] = await rows<{ encryption_mode: string }>(
    `select encryption_mode from environments where id = $1`,
    [world.env.id],
  );
  expect(environment?.encryption_mode).toBe('server');
  expect(
    await rows(`select id from env_keys where environment_id = $1`, [world.env.id]),
  ).toHaveLength(1);
  expect(
    await rows(`select id from env_data_keys where environment_id = $1`, [world.env.id]),
  ).toHaveLength(0);
  expect(
    await rows(`select id from env_hmac_keys where environment_id = $1`, [world.env.id]),
  ).toHaveLength(0);

  const versionRows = await rows<{
    env_key_id: string | null;
    iv: unknown;
    client_algorithm: string | null;
  }>(
    `select sv.env_key_id, sv.iv, sv.client_algorithm from secret_versions sv
       join secrets s on s.id = sv.secret_id where s.environment_id = $1`,
    [world.env.id],
  );
  // Four live versions and the deleted secret's one.
  expect(versionRows).toHaveLength(5);
  for (const row of versionRows) {
    expect(row.env_key_id).not.toBeNull();
    expect(row.iv).not.toBeNull();
    expect(row.client_algorithm).toBeNull();
  }

  const notes = await rows<{ name: string; note: string | null; enc_note: unknown }>(
    `select name, note, enc_note from secrets where environment_id = $1 and deleted_at is null`,
    [world.env.id],
  );
  expect(notes.find((row) => row.name === 'DATABASE_URL')?.note).toBe(DB_NOTE);
  for (const row of notes) expect(row.enc_note).toBeNull();

  expect(
    await rows(`select id from secrets where environment_id = $1 and deleted_at is not null`, [
      world.env.id,
    ]),
  ).toHaveLength(1);
  const [token] = await rows<{ revoked_at: Date | null }>(
    `select revoked_at from service_tokens where id = $1`,
    [world.tokenId],
  );
  expect(token?.revoked_at).toBeNull();

  for (const [name, versions] of Object.entries(world.values)) {
    for (const [index, value] of versions.entries()) {
      const { path, params } = at(world.org, 'legacy', `/secrets/${name}/versions/${index + 1}`, {
        name,
        version: String(index + 1),
      });
      const answer = await f.call<{ secret: { value: string | null } }>(
        versionRoute.GET,
        'GET',
        path,
        params,
      );
      expect(answer.status).toBe(200);
      expect(answer.body.secret.value).toBe(value);
    }
  }

  expect(
    audit.some(
      (record) =>
        record.action === 'environment.encryption_upgraded' &&
        record.outcome === 'success' &&
        record.resourceId === world.env.id,
    ),
  ).toBe(false);
}

// ── The upgrade ──────────────────────────────────────────────────────────────

describe('upgrading a server-mode environment to end-to-end encryption', () => {
  it('re-encrypts every version and note in place, and leaves the server no key that opens it', async () => {
    const world = await setup();

    const before = await preview(world);
    expect(before.status).toBe(200);
    expect(before.body.upgrade).toMatchObject({
      encryptionMode: 'server',
      environmentId: world.env.id,
      canUpgrade: true,
      reasons: [],
      details: {
        liveSecretCount: 2,
        versionCount: 4,
        noteCount: 1,
        deletedSecrets: [{ name: 'RETIRED' }],
        keylessTokens: [{ id: world.tokenId, name: 'deploy', tokenPrefix: 'xst_live_ab12' }],
        // The developer may read it, so the upgrade would leave them owed a key.
        otherEntitledCount: 1,
      },
    });
    expect(autoUpgradeEligible(before.body.upgrade, true)).toBe(false);

    const read = await material(world);
    expect(read.environmentId).toBe(world.env.id);
    // The first AAD component, for the browser to compare with its own.
    expect(read.orgId).toBe(world.org.orgId);
    const database = read.secrets.find((secret) => secret.name === 'DATABASE_URL');
    expect(database?.note).toBe(DB_NOTE);
    expect(database?.versions.map((version) => [version.version, version.value])).toEqual([
      [1, DB_VALUES[0]],
      [2, DB_VALUES[1]],
      [3, DB_VALUES[2]],
    ]);
    expect(read.secrets.find((secret) => secret.name === 'API_KEY')?.versions).toEqual([
      expect.objectContaining({ version: 1, value: API_VALUE }),
    ]);
    expect(read.deletedSecrets.map((secret) => secret.name)).toEqual(['RETIRED']);

    // The bulk read is audited as one, with a count and a reason — never a value.
    const readRecord = audit.find((record) => record.action === 'secret.read');
    expect(readRecord?.metadata).toMatchObject({
      reason: 'encryption-upgrade',
      secretCount: 2,
      versionCount: 4,
      environmentSlug: 'legacy',
    });

    const { body, edk, ehk } = await build(world, read);
    audit = [];
    const answer = await post(world, body);
    expect(answer.status).toBe(200);
    expect(answer.body.upgraded).toEqual({
      activeEdk: { id: body.envDataKeyId, version: 1 },
      secretCount: 2,
      versionCount: 4,
      noteCount: 1,
      erasedSecretCount: 1,
      revokedTokenCount: 1,
    });

    // ── The environment is end-to-end encrypted, and the server key is gone ──
    const [environment] = await rows<{ encryption_mode: string }>(
      `select encryption_mode from environments where id = $1`,
      [world.env.id],
    );
    expect(environment?.encryption_mode).toBe('e2ee');
    expect(
      await rows(`select id from env_keys where environment_id = $1`, [world.env.id]),
    ).toHaveLength(0);
    expect(
      await rows<{ id: string; version: number; status: string }>(
        `select id, version, status from env_data_keys where environment_id = $1`,
        [world.env.id],
      ),
    ).toEqual([{ id: body.envDataKeyId, version: 1, status: 'active' }]);
    expect(
      await rows(`select id from env_hmac_keys where environment_id = $1`, [world.env.id]),
    ).toHaveLength(1);

    const versionRows = await rows<{
      name: string;
      version: number;
      env_key_id: string | null;
      env_data_key_id: string | null;
      iv: unknown;
      client_algorithm: string | null;
      value_hmac: Uint8Array;
    }>(
      `select s.name, sv.version, sv.env_key_id, sv.env_data_key_id, sv.iv, sv.client_algorithm, sv.value_hmac
         from secret_versions sv join secrets s on s.id = sv.secret_id
        where s.environment_id = $1 order by s.name, sv.version`,
      [world.env.id],
    );
    expect(versionRows).toHaveLength(4);
    for (const row of versionRows) {
      expect(row.env_key_id).toBeNull();
      expect(row.iv).toBeNull();
      expect(row.env_data_key_id).toBe(body.envDataKeyId);
      expect(row.client_algorithm).toBe('xk2.gcm');
      // Keyed from the new EHK, exactly as an ordinary e2ee write computes it —
      // so the first write afterwards of an unchanged value is a no-op.
      const plaintext = world.values[row.name]![row.version - 1]!;
      expect(toBase64Url(new Uint8Array(row.value_hmac))).toBe(
        toBase64Url(await computeValueHmac({ ehk, plaintext })),
      );
    }

    // Notes moved: no plaintext note anywhere, the sealed one in its place.
    const noteRows = await rows<{ name: string; note: string | null; enc_note: unknown }>(
      `select name, note, enc_note from secrets where environment_id = $1`,
      [world.env.id],
    );
    expect(noteRows.map((row) => row.name).sort()).toEqual(['API_KEY', 'DATABASE_URL']);
    for (const row of noteRows) expect(row.note).toBeNull();

    // The deleted secret and its versions are erased; the token is revoked.
    expect(
      await rows(`select id from secrets where environment_id = $1 and name = 'RETIRED'`, [
        world.env.id,
      ]),
    ).toHaveLength(0);
    const [token] = await rows<{ revoked_at: Date | null }>(
      `select revoked_at from service_tokens where id = $1`,
      [world.tokenId],
    );
    expect(token?.revoked_at).not.toBeNull();

    // Everybody else entitled is owed the key; the upgrader holds it already.
    const pending = await rows<{ target_user_id: string }>(
      `select target_user_id from pending_key_grants where environment_id = $1`,
      [world.env.id],
    );
    expect(pending.map((row) => row.target_user_id)).toEqual([world.developer.id]);

    // ── Every version reads back through the e2ee read path, and opens ──
    for (const [name, versions] of Object.entries(world.values)) {
      for (const [index, value] of versions.entries()) {
        const version = index + 1;
        const { path, params } = at(world.org, 'legacy', `/secrets/${name}/versions/${version}`, {
          name,
          version: String(version),
        });
        const reveal = await f.call<{
          secret: {
            value: string | null;
            id: string;
            ciphertext: string;
            envDataKeyId: string;
            version: number;
          };
        }>(versionRoute.GET, 'GET', path, params);
        expect(reveal.status).toBe(200);
        expect(reveal.body.secret.value).toBeNull();
        expect(reveal.body.secret.envDataKeyId).toBe(body.envDataKeyId);
        expect(
          await decryptSecret({
            edk,
            context: {
              field: 'value',
              orgId: world.org.orgId,
              environmentId: world.env.id,
              secretId: reveal.body.secret.id,
              version: reveal.body.secret.version,
            },
            blob: reveal.body.secret.ciphertext,
          }),
        ).toBe(value);
      }
    }

    const listing = await f.call<{
      data: { id: string; name: string; note: string | null; encNote: string | null }[];
    }>(
      secretsRoute.GET,
      'GET',
      at(world.org, 'legacy', '/secrets').path,
      at(world.org, 'legacy', '/secrets').params,
    );
    expect(listing.status).toBe(200);
    const listed = listing.body.data.find((secret) => secret.name === 'DATABASE_URL');
    expect(listed?.note).toBeNull();
    expect(
      await decryptSecret({
        edk,
        context: {
          field: 'note',
          orgId: world.org.orgId,
          environmentId: world.env.id,
          secretId: listed!.id,
        },
        blob: listed!.encNote!,
      }),
    ).toBe(DB_NOTE);
    expect(listing.body.data.find((secret) => secret.name === 'API_KEY')?.encNote).toBeNull();

    // The upgrader's grant opens in their own browser to the key that sealed it all.
    const keys = await f.call<{
      keys: {
        encryptionMode: string;
        activeEdk: { id: string; version: number };
        myGrant: { edkSealed: string; ehkSealed: string };
      };
    }>(
      keysRoute.GET,
      'GET',
      at(world.org, 'legacy', '/keys').path,
      at(world.org, 'legacy', '/keys').params,
    );
    expect(keys.body.keys.encryptionMode).toBe('e2ee');
    expect(keys.body.keys.activeEdk).toEqual({ id: body.envDataKeyId, version: 1 });
    const opened = await openGrant({
      recipient: {
        environmentId: world.env.id,
        edkVersion: 1,
        recipientKind: 'member',
        recipientId: world.org.owner.id,
      },
      recipientPrivateKey: world.vault.encPrivateKey,
      grant: keys.body.keys.myGrant,
    });
    expect(toBase64Url(opened.edk)).toBe(toBase64Url(edk));
    expect(toBase64Url(opened.ehk)).toBe(toBase64Url(ehk));

    // ── Audited with counts, and per erased secret and revoked token ──
    const upgraded = audit.find((record) => record.action === 'environment.encryption_upgraded');
    expect(upgraded?.outcome).toBe('success');
    expect(upgraded?.metadata).toEqual({
      projectSlug: 'api',
      environmentSlug: 'legacy',
      source: 'dashboard',
      secretCount: 2,
      versionCount: 4,
      noteCount: 1,
      purgedSecretCount: 1,
      revokedTokenCount: 1,
      keyVersion: 1,
    });
    expect(audit.find((record) => record.action === 'envkey.created')?.metadata).toMatchObject({
      keyVersion: 1,
      grantCount: 1,
    });
    expect(audit.find((record) => record.action === 'secret.purged')?.metadata).toMatchObject({
      secretName: 'RETIRED',
      reason: 'encryption-upgrade',
    });
    const revoked = audit.find((record) => record.action === 'token.revoked');
    expect(revoked?.resourceId).toBe(world.tokenId);
    expect(revoked?.metadata).toMatchObject({ reason: 'encryption-upgrade' });
    const everything = JSON.stringify(audit);
    for (const value of [...DB_VALUES, API_VALUE, DB_NOTE]) expect(everything).not.toContain(value);

    // ── And it happens once ──
    const after = await preview(world);
    expect(after.status).toBe(200);
    expect(after.body.upgrade).toMatchObject({
      encryptionMode: 'e2ee',
      canUpgrade: false,
      reasons: ['already-e2ee'],
      details: null,
    });
    expect((await readMaterial(world)).status).toBe(409);
    expect((await post(world, body)).status).toBe(409);
  });

  it('upgrades an empty environment nobody else may read — the only kind upgraded without asking', async () => {
    // Somebody else may read this one: an upgrade nobody asked for would leave
    // them with names they could not read, so it is not eligible.
    const shared = await setup();
    await f.seedEnv(shared.org, shared.projectId, 'empty', { mode: 'server' });
    const sharedPreview = await preview(shared, 'empty');
    expect(sharedPreview.body.upgrade.details).toMatchObject({
      liveSecretCount: 0,
      otherEntitledCount: 1,
    });
    expect(autoUpgradeEligible(sharedPreview.body.upgrade, true)).toBe(false);

    // An organisation of one: nothing to decide, nobody to lose.
    const org = await f.seedOrg('pro');
    const projectId = await f.seedProject(org);
    await f.seedEnv(org, projectId, 'empty', { mode: 'server' });
    const vault = await seedVault(org.owner);
    caller = f.sessionOf(org.owner);
    const solo: World = { ...shared, org, projectId, vault };

    const before = await preview(solo, 'empty');
    expect(before.status).toBe(200);
    expect(before.body.upgrade).toMatchObject({
      canUpgrade: true,
      details: {
        liveSecretCount: 0,
        versionCount: 0,
        deletedSecrets: [],
        keylessTokens: [],
        otherEntitledCount: 0,
      },
    });
    expect(autoUpgradeEligible(before.body.upgrade, true)).toBe(true);
    expect(autoUpgradeEligible(before.body.upgrade, false)).toBe(false);

    const read = await material(solo, 'empty');
    expect(read.secrets).toEqual([]);
    const { body } = await build(solo, read);
    const answer = await post(solo, body, 'empty');
    expect(answer.status).toBe(200);
    expect(answer.body.upgraded).toMatchObject({ secretCount: 0, versionCount: 0 });

    const [environment] = await rows<{ id: string; encryption_mode: string }>(
      `select e.id, e.encryption_mode from environments e where e.slug = 'empty' and e.project_id = $1`,
      [projectId],
    );
    expect(environment?.encryption_mode).toBe('e2ee');
    expect(
      await rows(`select id from env_keys where environment_id = $1`, [environment!.id]),
    ).toHaveLength(0);
    // Nobody else, so nobody is owed a key.
    expect(
      await rows(`select id from pending_key_grants where environment_id = $1`, [environment!.id]),
    ).toHaveLength(0);
  });

  it('is not eligible to upgrade without asking while a deleted secret would be erased', async () => {
    const world = await setup();
    await f.seedEnv(world.org, world.projectId, 'tidy', { mode: 'server' });
    await writeServerSecret(world.org, 'tidy', 'ONCE', 'value');
    await deleteSecret(world.org, 'tidy', 'ONCE');

    const answer = await preview(world, 'tidy');
    expect(answer.body.upgrade).toMatchObject({
      canUpgrade: true,
      details: { liveSecretCount: 0 },
    });
    expect(answer.body.upgrade.details?.deletedSecrets).toHaveLength(1);
    expect(autoUpgradeEligible(answer.body.upgrade, true)).toBe(false);
  });
});

// ── Refusals ─────────────────────────────────────────────────────────────────

describe('what the upgrade refuses, leaving the environment untouched', () => {
  it('refuses an environment that is already end-to-end encrypted', async () => {
    const world = await setup();
    await f.seedEnv(world.org, world.projectId, 'modern');

    const answer0 = await preview(world, 'modern');
    expect(answer0.status).toBe(200);
    expect(answer0.body.upgrade).toMatchObject({ canUpgrade: false, reasons: ['already-e2ee'] });
    expect((await readMaterial(world, 'modern')).status).toBe(409);
    const answer = await post(world, {}, 'modern');
    expect(answer.status).toBe(409);
    expect(answer.body.error?.message).toMatch(/^already_e2ee/);
  });

  it('refuses a member who is not an admin of the environment, and records the denial', async () => {
    const world = await setup();
    caller = f.sessionOf(world.developer);

    // The preview answers — quietly: no refusal, no audit record, no rate limit
    // spent, and none of the names an upgrade would act on (review round 1, 7).
    audit = [];
    limiter.spent = [];
    const quiet = await preview(world);
    expect(quiet.status).toBe(200);
    expect(quiet.body.upgrade).toEqual({
      encryptionMode: 'server',
      environmentId: world.env.id,
      canUpgrade: false,
      reasons: ['not-permitted'],
      details: null,
    });
    expect(audit).toEqual([]);
    expect(limiter.spent).toEqual([]);

    expect((await readMaterial(world)).status).toBe(403);
    caller = f.sessionOf(world.org.owner);
    const { body } = await build(world, await material(world));
    caller = f.sessionOf(world.developer);
    audit = [];
    expect((await post(world, body)).status).toBe(403);

    expect(
      audit.some(
        (record) =>
          record.action === 'environment.encryption_upgraded' && record.outcome === 'denied',
      ),
    ).toBe(true);
    caller = f.sessionOf(world.org.owner);
    await expectUntouched(world);
  });

  it('never decrypts for a member who may not upgrade: the material read is refused and audited', async () => {
    const world = await setup();
    const viewer = await f.seedMember(world.org, 'viewer');
    caller = f.sessionOf(viewer);
    audit = [];

    const answer = await readMaterial(world);
    expect(answer.status).toBe(403);
    expect(answer.text).not.toContain('postgres://');
    expect(
      audit.some((record) => record.action === 'secret.read' && record.outcome === 'denied'),
    ).toBe(true);
    expect(
      audit.some((record) => record.action === 'secret.read' && record.outcome === 'success'),
    ).toBe(false);
  });

  it('refuses a CLI token and a service token: only an unlocked browser session can seal the new key', async () => {
    const world = await setup();
    const { body } = await build(world, await material(world));

    caller = f.cliTokenOf(world.org.owner, world.org.orgId);
    const cliRead = await readMaterial(world);
    expect(cliRead.status).toBe(403);
    expect(cliRead.text).not.toContain('postgres://');
    expect((await post(world, body)).status).toBe(403);

    caller = {
      kind: 'serviceToken',
      tokenId: world.tokenId,
      tokenName: 'deploy',
      orgId: world.org.orgId,
      projectId: world.projectId,
      environmentId: world.env.id,
      accessLevel: 'write',
    };
    expect((await readMaterial(world)).status).toBe(403);
    expect((await post(world, body)).status).toBe(403);

    caller = f.sessionOf(world.org.owner);
    await expectUntouched(world);
  });

  it('refuses a locked session before anything is read', async () => {
    const world = await setup();
    actor.isUnlocked.mockImplementation(() => false);

    const answer = await readMaterial(world);
    expect(answer.status).toBe(403);
    expect(answer.text).toContain('session_locked');
    expect(answer.text).not.toContain('postgres://');

    actor.isUnlocked.mockImplementation(() => true);
    await expectUntouched(world);
  });

  it('refuses a member with no vault, whose browser has nothing to seal the key to', async () => {
    const world = await setup();
    const admin = await f.seedMember(world.org, 'admin');
    caller = f.sessionOf(admin);

    const answer = await preview(world);
    expect(answer.body.upgrade).toMatchObject({ canUpgrade: false, reasons: ['no-vault'] });

    // Nothing is decrypted for somebody who could not finish the upgrade.
    audit = [];
    const refusedRead = await readMaterial(world);
    expect(refusedRead.status).toBe(400);
    expect(refusedRead.text).not.toContain('postgres://');
    expect(
      audit.some((record) => record.action === 'secret.read' && record.outcome === 'success'),
    ).toBe(false);

    caller = f.sessionOf(world.org.owner);
    const read = await material(world);
    const { body } = await build(world, read);
    // The grant is the owner's, so it is refused either way; the vault check
    // comes first and is the one this asserts.
    caller = f.sessionOf(admin);
    const refused = await post(world, body);
    expect(refused.status).toBe(400);
    expect(refused.body.error?.message).toMatch(/vault/);

    caller = f.sessionOf(world.org.owner);
    await expectUntouched(world);
  });

  it('refuses a set missing a version, missing a secret, or carrying one too many — 409', async () => {
    const world = await setup();
    const read = await material(world);
    const { body } = await build(world, read);

    const missingVersion = copy(body);
    const database = missingVersion.secrets.find((secret) => secret.versions.length === 3)!;
    database.versions.pop();

    const missingSecret = copy(body);
    missingSecret.secrets.pop();

    const extraVersion = copy(body);
    const target = extraVersion.secrets.find((secret) => secret.versions.length === 1)!;
    target.versions.push({ ...target.versions[0]!, id: crypto.randomUUID(), version: 2 });

    const extraSecret = copy(body);
    extraSecret.secrets.push({ ...copy(body.secrets[0]!), id: crypto.randomUUID() });

    for (const attempt of [missingVersion, missingSecret, extraVersion, extraSecret]) {
      const answer = await post(world, attempt);
      expect(answer.status).toBe(409);
      expect(answer.body.error?.message).toMatch(/^version_conflict/);
    }
    await expectUntouched(world);
  });

  it('refuses a value bound to a different version from the row it would replace', async () => {
    const world = await setup();
    const { body } = await build(world, await material(world));

    // The same three ciphertexts, filed under each other's version numbers: a
    // shape the server cannot see inside, and a binding it can check.
    const swapped = copy(body);
    const database = swapped.secrets.find((secret) => secret.versions.length === 3)!;
    const [first, second] = [database.versions[0]!, database.versions[1]!];
    [first.version, second.version] = [second.version, first.version];

    const answer = await post(world, swapped);
    expect(answer.status).toBe(409);
    await expectUntouched(world);
  });

  it('refuses a set that went stale under a concurrent write, so the write is never dropped', async () => {
    const world = await setup();
    const read = await material(world);
    const { body } = await build(world, read);

    // A fourth version lands between the read and the upgrade.
    await rotateServerSecret(world.org, 'legacy', 'DATABASE_URL', 'postgres://four');
    world.values['DATABASE_URL']!.push('postgres://four');

    const answer = await post(world, body);
    expect(answer.status).toBe(409);
    expect(answer.body.error?.message).toMatch(/^version_conflict/);
    // Five live versions now and the deleted one: `expectUntouched` counts five
    // rows for the original world, so check the new state directly.
    const [environment] = await rows<{ encryption_mode: string }>(
      `select encryption_mode from environments where id = $1`,
      [world.env.id],
    );
    expect(environment?.encryption_mode).toBe('server');

    // Read again and the upgrade carries the version it would have dropped.
    const fresh = await material(world);
    const again = await build(world, fresh);
    const answer2 = await post(world, again.body);
    expect(answer2.status).toBe(200);
    expect(answer2.body.upgraded.versionCount).toBe(5);
  });

  it('refuses a set whose note changed since it was read', async () => {
    const world = await setup();
    const { body } = await build(world, await material(world));

    const { path, params } = at(world.org, 'legacy', '/secrets/DATABASE_URL', {
      name: 'DATABASE_URL',
    });
    const edited = await f.call(secretRoute.PUT, 'PUT', path, params, { note: 'a newer note' });
    expect(edited.status).toBe(200);
    world.notes['DATABASE_URL'] = 'a newer note';

    const answer = await post(world, body);
    expect(answer.status).toBe(409);
    const [row] = await rows<{ note: string | null }>(
      `select note from secrets where environment_id = $1 and name = 'DATABASE_URL'`,
      [world.env.id],
    );
    expect(row?.note).toBe('a newer note');
  });

  it('refuses unless the tokens and deleted secrets named are exactly the ones it would revoke and erase', async () => {
    const world = await setup();
    const read = await material(world);
    const { body } = await build(world, read);

    // Naming none cannot dodge the revocation — or the `token.revoke` it needs.
    const noTokens = copy(body);
    noTokens.revokeTokenIds = [];
    const answer = await post(world, noTokens);
    expect(answer.status).toBe(409);
    expect(answer.body.error?.message).toMatch(/CI tokens/);

    const noErasure = copy(body);
    noErasure.eraseSecretIds = [];
    expect((await post(world, noErasure)).status).toBe(409);

    // A token minted after the dialog was read is not revoked unseen.
    const later = await seedKeylessToken(world.org, world.projectId, world.env, 'later');
    const minted = await post(world, body);
    expect(minted.status).toBe(409);
    expect(minted.body.error?.message).toMatch(/CI tokens/);
    await t.pg.query(`delete from service_tokens where id = $1`, [later]);

    await expectUntouched(world);
  });

  it('refuses malformed blobs and values sealed against a key the request does not create — 422', async () => {
    const world = await setup();
    const { body } = await build(world, await material(world));

    const badBlob = copy(body);
    badBlob.secrets[0]!.versions[0]!.value.ciphertext = 'xk2.gcm.!!!not-base64!!!';

    const shortBlob = copy(body);
    shortBlob.secrets[0]!.versions[0]!.value.ciphertext = 'xk2.gcm.AAAA';

    const badHmac = copy(body);
    badHmac.secrets[0]!.versions[0]!.value.valueHmac = 'A'.repeat(42);

    const badNote = copy(body);
    badNote.secrets[0]!.encNote = 'not a blob';

    const wrongKey = copy(body);
    wrongKey.secrets[0]!.versions[0]!.value.envDataKeyId = uuidv7();

    const duplicated = copy(body);
    duplicated.secrets.push(copy(body.secrets[0]!));

    const unexpected = { ...copy(body), extra: true };

    for (const attempt of [
      badBlob,
      shortBlob,
      badHmac,
      badNote,
      wrongKey,
      duplicated,
      unexpected,
    ]) {
      const answer = await post(world, attempt);
      expect(answer.status).toBe(422);
      expect(answer.text).not.toContain('postgres://');
    }
    await expectUntouched(world);
  });

  it('refuses a key initialisation that is not the upgrader’s own, validly shaped grant', async () => {
    const world = await setup();
    const { body } = await build(world, await material(world));

    const othersGrant = copy(body);
    othersGrant.keys.grant.recipientId = world.developer.id;
    const answer = await post(world, othersGrant);
    expect(answer.status).toBe(400);

    const badSignature = copy(body);
    badSignature.keys.grant.signature = 'xk2.ed25519.short';
    expect((await post(world, badSignature)).status).toBe(422);

    const badKind = copy(body) as unknown as { keys: { grant: { recipientKind: string } } };
    badKind.keys.grant.recipientKind = 'token';
    expect((await post(world, badKind)).status).toBe(400);

    await expectUntouched(world);
  });

  it('asks token.revoke only when there are tokens to revoke', async () => {
    const world = await setup();
    // A developer made admin of these environments: `environment.update`, and no
    // organisation-level `token.revoke`.
    const { user: lead, memberId } = await seedMemberWithId(world.org, 'developer');
    await t.pg.query(
      `insert into access_grants (id, org_member_id, project_id, environment_id, access_level, granted_by)
       values ($1, $2, $3, null, 'admin', $4)`,
      [crypto.randomUUID(), memberId, world.projectId, world.org.owner.id],
    );
    const leadVault = await seedVault(lead);
    const leadWorld: World = { ...world, vault: leadVault };
    caller = f.sessionOf(lead);

    const blocked = await preview(leadWorld);
    expect(blocked.body.upgrade).toMatchObject({ canUpgrade: false, reasons: ['token-revoke'] });
    const read = await material(leadWorld);
    const { body } = await build(leadWorld, read);
    audit = [];
    expect((await post(leadWorld, body)).status).toBe(403);
    expect(
      audit.some(
        (record) =>
          record.action === 'environment.encryption_upgraded' && record.outcome === 'denied',
      ),
    ).toBe(true);

    // The same person upgrades an environment with no tokens.
    caller = f.sessionOf(world.org.owner);
    await f.seedEnv(world.org, world.projectId, 'quiet', { mode: 'server' });
    await writeServerSecret(world.org, 'quiet', 'ONLY', 'value');
    caller = f.sessionOf(lead);
    const quiet = await build(leadWorld, await material(leadWorld, 'quiet'));
    expect((await post(leadWorld, quiet.body, 'quiet')).status).toBe(200);

    caller = f.sessionOf(world.org.owner);
    await expectUntouched(world);
  });

  it('is atomic: a failure at the very last statement leaves the environment entirely server-mode and readable', async () => {
    const world = await setup();
    const { body } = await build(world, await material(world));

    // Everything before it — the new key, every version rewritten, the notes
    // moved, the secret erased, the token revoked, the mode flipped — has run
    // by the time the server key is deleted. Fail exactly there.
    await t.pg.query(`
      create or replace function refuse_env_key_delete() returns trigger language plpgsql as $$
      begin raise exception 'injected failure'; end $$;
    `);
    await t.pg.query(`
      create trigger refuse_env_key_delete before delete on env_keys
      for each row execute function refuse_env_key_delete();
    `);

    try {
      const answer = await post(world, body);
      expect(answer.status).toBe(500);
      expect(answer.text).not.toContain('injected');
      await expectUntouched(world);
      expect(
        await rows(`select id from pending_key_grants where environment_id = $1`, [world.env.id]),
      ).toHaveLength(0);
    } finally {
      await t.pg.query(`drop trigger refuse_env_key_delete on env_keys`);
      await t.pg.query(`drop function refuse_env_key_delete()`);
    }

    // The same request, retried once the fault is gone, succeeds.
    expect((await post(world, body)).status).toBe(200);
  });

  it('keeps a plaintext note off an upgraded environment however late the write arrives', async () => {
    const world = await setup();
    const { body } = await build(world, await material(world));
    expect((await post(world, body)).status).toBe(200);

    // A server-mode note write that resolved the environment before the upgrade
    // committed reaches the repository afterwards.
    await expect(
      updateSecretMetadata(t.db, {
        orgId: world.org.orgId,
        environmentId: world.env.id,
        name: 'DATABASE_URL',
        note: 'written late, in the clear',
      }),
    ).rejects.toBeInstanceOf(RepositoryError);

    const [row] = await rows<{ note: string | null }>(
      `select note from secrets where environment_id = $1 and name = 'DATABASE_URL'`,
      [world.env.id],
    );
    expect(row?.note).toBeNull();
  });

  it('refuses a grant sealed to anything but the upgrader’s current vault key (review round 1, 2a)', async () => {
    const world = await setup();
    const { body } = await build(world, await material(world));

    // A vault reset in another tab: the account's public key is not the one the
    // grant was sealed to any more, and nobody holding the vault could open it.
    await t.pg.query(`update user_keys set enc_public_key = $1 where user_id = $2`, [
      bytes(32),
      world.org.owner.id,
    ]);

    const answer = await post(world, body);
    expect(answer.status).toBe(409);
    expect(answer.body.error?.message).toMatch(/^grant_key_mismatch/);
    await expectUntouched(world);
  });

  it('refuses a note dropped or invented on the way (review round 1, 2b)', async () => {
    const world = await setup();
    const { body } = await build(world, await material(world));
    const databaseNote = body.secrets.find((secret) => secret.encNote !== null)!.encNote;

    const dropped = copy(body);
    for (const secret of dropped.secrets) secret.encNote = null;

    const invented = copy(body);
    for (const secret of invented.secrets) secret.encNote = databaseNote;

    for (const attempt of [dropped, invented]) {
      const answer = await post(world, attempt);
      expect(answer.status).toBe(409);
      expect(answer.body.error?.message).toMatch(/^notes_mismatch/);
    }
    await expectUntouched(world);
  });

  it('answers a deadlock or serialisation failure as a retryable 409, never a 500 (review round 1, 3)', async () => {
    const world = await setup();
    const { body } = await build(world, await material(world));

    await t.pg.query(`
      create or replace function lose_a_race() returns trigger language plpgsql as $$
      begin raise exception 'deadlock detected' using errcode = '40P01'; end $$;
    `);
    await t.pg.query(`
      create trigger lose_a_race before update on secret_versions
      for each row execute function lose_a_race();
    `);
    try {
      const answer = await post(world, body);
      expect(answer.status).toBe(409);
      expect(answer.body.error?.message).toMatch(/^version_conflict/);
      await expectUntouched(world);
    } finally {
      await t.pg.query(`drop trigger lose_a_race on secret_versions`);
    }

    // The server-mode write path answers the same way.
    await t.pg.query(`
      create or replace function lose_a_race() returns trigger language plpgsql as $$
      begin raise exception 'could not serialize' using errcode = '40001'; end $$;
    `);
    await t.pg.query(`
      create trigger lose_a_race before insert on secret_versions
      for each row execute function lose_a_race();
    `);
    try {
      const { path, params } = at(world.org, 'legacy', '/secrets/API_KEY', { name: 'API_KEY' });
      const answer = await f.call(secretRoute.PATCH, 'PATCH', path, params, { value: 'changed' });
      expect(answer.status).toBe(409);
    } finally {
      await t.pg.query(`drop trigger lose_a_race on secret_versions`);
      await t.pg.query(`drop function lose_a_race()`);
    }
  });

  it('answers a server-mode request that arrives after the upgrade with a retryable 409, not a key-loss alarm (review round 1, 8)', async () => {
    const world = await setup();
    const lines: { level: string; message: string }[] = [];
    const log = createLogger({
      sink: { write: (entry) => void lines.push(entry), flush: () => Promise.resolve() },
      minimum: 'debug',
      base: {},
    });
    const services = {
      env: { XECRET_PUBLIC_URL: ORIGIN, XECRET_ENV: 'test' },
      db: t.db,
      envelope,
      meta: {
        requestId: 'in-flight',
        rayId: null,
        ipAddress: '203.0.113.5',
        userAgent: 'vitest',
        method: 'GET',
        path: '/',
        startedAt: Date.now(),
      },
      log: log.logger,
      bindLog: log.bind,
      waitUntil: (promise: Promise<unknown>) => void deferred.push(promise),
      settled: () => Promise.allSettled(deferred),
      dispose: () => {},
    } as unknown as ServiceContext;
    const params = { orgSlug: world.org.slug, projectSlug: 'api', envSlug: 'legacy' };

    // Resolved while the environment is still server-mode…
    const stale = await resolveEnvironmentPath(f.sessionOf(world.org.owner), params, services);
    expect(stale.environment.encryptionMode).toBe('server');

    // …and the upgrade commits before the request reads the key.
    const { body } = await build(world, await material(world));
    expect((await post(world, body)).status).toBe(200);

    await expect(decryptEnvironment(stale, services)).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringMatching(/^mode_changed/),
    });
    expect(lines.filter((line) => line.level === 'error')).toEqual([]);

    // A server-mode write whose key was unwrapped before the mode moved is
    // refused inside its own transaction, rather than landing in an
    // environment that is now end-to-end encrypted.
    await f.seedEnv(world.org, world.projectId, 'racing', { mode: 'server' });
    const racing = await resolveEnvironmentPath(
      f.sessionOf(world.org.owner),
      { ...params, envSlug: 'racing' },
      services,
    );
    await t.pg.query(`update environments set encryption_mode = 'e2ee' where id = $1`, [
      racing.environment.id,
    ]);
    await expect(
      writeSecretValue(racing, services, {
        name: 'LATE',
        value: 'in the clear',
        writer: { userId: world.org.owner.id },
        capacity: () => Promise.resolve(),
      }),
    ).rejects.toMatchObject({ code: 'conflict', message: expect.stringMatching(/^mode_changed/) });
    expect(
      await rows(`select id from secrets where environment_id = $1`, [racing.environment.id]),
    ).toHaveLength(0);
  });

  it('never mints a keyless token into an environment that became end-to-end encrypted mid-request (review round 1, 9)', async () => {
    const world = await setup();
    const mint = (name: string) =>
      f.call<{ error?: { message: string } }>(
        tokensRoute.POST,
        'POST',
        `/api/orgs/${world.org.slug}/tokens/service`,
        { orgSlug: world.org.slug },
        { name, projectSlug: 'api', environmentSlug: 'legacy' },
      );

    // An ordinary keyless token, for a server-mode environment, is minted.
    expect((await mint('ordinary')).status).toBe(201);

    // The upgrade lands after the route checked the mode and before it writes.
    hooks.beforeTokenTransaction = async () => {
      await t.pg.query(`update environments set encryption_mode = 'e2ee' where id = $1`, [
        world.env.id,
      ]);
    };
    const raced = await mint('raced');
    expect(raced.status).toBe(409);
    expect(raced.body.error?.message).toMatch(/^mode_changed/);
    expect(
      await rows(`select id from service_tokens where environment_id = $1 and name = 'raced'`, [
        world.env.id,
      ]),
    ).toHaveLength(0);
  });

  it('reserves the upgrade of an environment with plaintext export disabled for an organisation owner or admin (review round 1, 10)', async () => {
    const world = await setup();
    // An environment with values and no CI token, so `token.revoke` is not what refuses.
    await f.seedEnv(world.org, world.projectId, 'locked', { mode: 'server' });
    await writeServerSecret(world.org, 'locked', 'KEPT', 'kept-value');
    await t.pg.query(
      `update environments set plaintext_export_disabled = true where project_id = $1 and slug = 'locked'`,
      [world.projectId],
    );

    // A developer made admin of the project: may upgrade an ordinary
    // environment, may not read this one in bulk.
    const { user: lead, memberId } = await seedMemberWithId(world.org, 'developer');
    await t.pg.query(
      `insert into access_grants (id, org_member_id, project_id, environment_id, access_level, granted_by)
       values ($1, $2, $3, null, 'admin', $4)`,
      [crypto.randomUUID(), memberId, world.projectId, world.org.owner.id],
    );
    const leadWorld: World = { ...world, vault: await seedVault(lead) };
    caller = f.sessionOf(lead);

    const blocked = await preview(leadWorld, 'locked');
    expect(blocked.body.upgrade).toMatchObject({ canUpgrade: false, reasons: ['export-policy'] });

    audit = [];
    const refused = await readMaterial(leadWorld, 'locked');
    expect(refused.status).toBe(403);
    expect(refused.text).toContain('export_disabled');
    expect(refused.text).not.toContain('kept-value');
    const refusal = audit.find((record) => record.action === 'secret.read');
    expect(refusal?.outcome).toBe('error');
    expect(refusal?.metadata).toMatchObject({
      reason: 'policyRefused',
      policyName: 'plaintextExport',
    });

    // The owner may, and the records say the policy was in force.
    caller = f.sessionOf(world.org.owner);
    audit = [];
    const read = await material(world, 'locked');
    expect(read.secrets.map((secret) => secret.name)).toEqual(['KEPT']);
    expect(audit.find((record) => record.action === 'secret.read')?.metadata).toMatchObject({
      reason: 'encryption-upgrade',
      policyName: 'plaintextExport',
      enabled: false,
    });

    // The lead's POST is refused too, before its body is read.
    const { body } = await build(world, read);
    caller = f.sessionOf(lead);
    expect((await post(leadWorld, body, 'locked')).status).toBe(403);

    caller = f.sessionOf(world.org.owner);
    audit = [];
    expect((await post(world, body, 'locked')).status).toBe(200);
    expect(
      audit.find((record) => record.action === 'environment.encryption_upgraded')?.metadata,
    ).toMatchObject({ policyName: 'plaintextExport', enabled: false });
  });
});

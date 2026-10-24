import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditRecord } from '@xecret/core/audit';
import { toBase64Url } from '@xecret/core/crypto';
import { addSecretVersion } from '@xecret/db/repositories';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '@xecret/db/testing';
import type { TestDatabase } from '@xecret/db/testing';
import type { Principal } from './actor';
import { errors } from './errors';
import { createLogger } from './logging';
import type { RequestLog } from './logging';
import { blob, ORIGIN, routeFixtures } from './testing/route-fixtures';
import type { Env, Org } from './testing/route-fixtures';

/**
 * Environment promotion (P19 §3) and point-in-time restore (P19 §4), end to end
 * against PGlite. Both are many client-encrypted writes landing in one
 * environment at once; what is checked is who may, what the plan allows, what
 * the server holds the client's entries to, that each lands atomically, and
 * what is recorded.
 *
 * Ciphertexts are shape-valid placeholders — the server cannot open them — and
 * a value's identity is its tag (`valueHmac`), which is what the server compares.
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

const promoteRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/promote/route');
const restoreRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/restore-point/route');

let t: TestDatabase;
let audit: AuditRecord[] = [];
let deferred: Promise<unknown>[] = [];
let caller: Principal | null;

const f = routeFixtures({ t: () => t, deferred: () => deferred });

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
  actor.authenticate.mockImplementation(async () => {
    if (caller === null) throw errors.unauthenticated('no credential');
    return { principal: caller, source: caller.kind === 'user' ? 'cookie' : 'bearer' };
  });
  auditSink.write.mockImplementation(async (events: AuditRecord[]) => {
    audit.push(...events);
  });
});

/* ── fixtures ─────────────────────────────────────────────────────────────── */

/** A value's tag — what the server compares a value by. 32 bytes, as a real one is. */
const tag = (label: string) => new TextEncoder().encode(label.padEnd(32, '.').slice(0, 32));
const tagOf = (label: string) => toBase64Url(tag(label));

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

interface Body {
  error?: {
    code?: string;
    message?: string;
    plan?: { resource?: string; upgradeTo?: string | null; limit?: number | null };
    fields?: { field: string; message: string }[];
  };
  dryRun?: boolean;
  counts?: Record<string, number>;
  items?: { name: string; status?: string; action?: string; applied?: boolean }[];
  skipped?: string[];
  plan?: {
    at: string;
    window: { days: number; earliest: string };
    items: {
      name: string;
      action: string;
      secretId: string;
      expectedVersion: number | null;
      valueType: string;
      available: boolean;
      from: { ciphertext: string; envDataKeyId: string } | null;
    }[];
    keys: Record<string, { version: number }>;
    counts: Record<string, number>;
  };
}

const recorded = (action: string) => audit.filter((event) => event.action === action);

async function secretsOf(
  env: Env,
): Promise<Map<string, { id: string; version: number; hmac: string }>> {
  const rows = await t.pg.query<{
    id: string;
    name: string;
    version: number;
    value_hmac: Uint8Array;
  }>(
    `select distinct on (s.id) s.id, s.name, v.version, v.value_hmac
       from secrets s join secret_versions v on v.secret_id = s.id
      where s.environment_id = $1 and s.deleted_at is null
      order by s.id, v.version desc`,
    [env.id],
  );
  return new Map(
    rows.rows.map((row) => [
      row.name,
      { id: row.id, version: row.version, hmac: toBase64Url(new Uint8Array(row.value_hmac)) },
    ]),
  );
}

/** A client-encrypted entry for `env`: sealed, notionally, under its active key. */
function entry(
  env: Env,
  name: string,
  label: string,
  at: { id: string; expectedVersion: number },
  extra: Record<string, unknown> = {},
) {
  return {
    id: at.id,
    name,
    expectedVersion: at.expectedVersion,
    value: {
      ciphertext: blob(label),
      clientAlgorithm: 'xk2.gcm',
      envDataKeyId: env.keyId,
      valueHmac: tagOf(label),
    },
    ...extra,
  };
}

/* ── promotion ────────────────────────────────────────────────────────────── */

describe('POST …/environments/{target}/promote', () => {
  async function setup(plan: 'free' | 'pro' = 'pro') {
    const org = await f.seedOrg(plan);
    const project = await f.seedProject(org);
    const staging = await f.seedEnv(org, project, 'staging');
    const production = await f.seedEnv(org, project, 'production', { production: true });
    await f.seedSecret(org, staging, 'API_URL', { label: 'api-new', hmac: tag('api-new') });
    await f.seedSecret(org, staging, 'SHARED', { label: 'shared-new', hmac: tag('shared-new') });
    await f.seedSecret(org, staging, 'SAME', { label: 'same', hmac: tag('same') });
    await f.seedSecret(org, production, 'SHARED', { label: 'shared-old', hmac: tag('shared-old') });
    await f.seedSecret(org, production, 'SAME', { label: 'same', hmac: tag('same') });
    await f.seedSecret(org, production, 'LEGACY', { label: 'legacy', hmac: tag('legacy') });
    caller = f.sessionOf(org.owner);
    return { org, project, staging, production };
  }

  function promote(org: Org, target: string, body: unknown) {
    const { path, params } = f.envPath(org, target, '/promote');
    return f.call<Body>(promoteRoute.POST, 'POST', path, params, body);
  }

  async function fullBody(production: Env, dryRun: boolean) {
    const current = await secretsOf(production);
    return {
      source: 'staging',
      dryRun,
      writes: [
        entry(production, 'API_URL', 'api-new', { id: crypto.randomUUID(), expectedVersion: 1 }),
        entry(production, 'SHARED', 'shared-new', {
          id: current.get('SHARED')!.id,
          expectedVersion: current.get('SHARED')!.version + 1,
        }),
        entry(production, 'SAME', 'same', {
          id: current.get('SAME')!.id,
          expectedVersion: current.get('SAME')!.version + 1,
        }),
      ],
      removals: ['LEGACY'],
    };
  }

  it('applies the whole diff atomically, and records the promotion and each secret', async () => {
    const { org, production } = await setup();

    const answer = await promote(org, 'production', await fullBody(production, false));
    expect(answer.status).toBe(200);
    expect(answer.body.counts).toEqual({ created: 1, updated: 1, unchanged: 1, deleted: 1 });

    const after = await secretsOf(production);
    expect([...after.keys()].sort()).toEqual(['API_URL', 'SAME', 'SHARED']);
    expect(after.get('SHARED')!.hmac).toBe(tagOf('shared-new'));

    expect(recorded('environment.promoted')).toEqual([
      expect.objectContaining({
        outcome: 'success',
        metadata: expect.objectContaining({
          sourceEnvironmentSlug: 'staging',
          createdCount: 1,
          updatedCount: 1,
          deletedCount: 1,
        }),
      }),
    ]);
    for (const action of ['secret.created', 'secret.updated', 'secret.deleted']) {
      expect(recorded(action)).toEqual([
        expect.objectContaining({ metadata: expect.objectContaining({ reason: 'promoted' }) }),
      ]);
    }
  });

  it('previews with a dry run that writes and records nothing', async () => {
    const { org, production } = await setup();
    const before = await secretsOf(production);

    const answer = await promote(org, 'production', await fullBody(production, true));
    expect(answer.status).toBe(200);
    expect(answer.body.dryRun).toBe(true);
    expect(answer.body.items?.map((item) => [item.name, item.status]).sort()).toEqual([
      ['API_URL', 'created'],
      ['LEGACY', 'deleted'],
      ['SAME', 'unchanged'],
      ['SHARED', 'updated'],
    ]);
    expect(await secretsOf(production)).toEqual(before);
    expect(recorded('environment.promoted')).toEqual([]);
  });

  it('lands none of it when one entry is stale', async () => {
    const { org, production } = await setup();
    const before = await secretsOf(production);
    const body = await fullBody(production, false);
    body.writes[1]!.expectedVersion = 7;

    const answer = await promote(org, 'production', body);
    expect(answer.status).toBe(409);
    expect(await secretsOf(production)).toEqual(before);
  });

  it('refuses a Free organisation, naming the plan, and files the refusal', async () => {
    const { org, production } = await setup('free');

    const answer = await promote(org, 'production', await fullBody(production, false));
    expect(answer.status).toBe(403);
    expect(answer.body.error?.code).toBe('plan_limit');
    expect(answer.body.error?.plan?.upgradeTo).toBe('pro');
    expect(recorded('environment.promoted')).toEqual([
      expect.objectContaining({
        outcome: 'error',
        metadata: expect.objectContaining({
          reason: 'quotaExceeded',
          limitName: 'environmentPromotion',
        }),
      }),
    ]);
  });

  it('refuses a service token, and a viewer — the second filed as a denial', async () => {
    const { org, project, production } = await setup();
    caller = await f.seedServiceToken(org, project, production);
    expect((await promote(org, 'production', await fullBody(production, false))).status).toBe(403);

    caller = f.sessionOf(await f.seedMember(org, 'viewer'));
    expect((await promote(org, 'production', await fullBody(production, false))).status).toBe(403);
    expect(recorded('environment.promoted')).toEqual([
      expect.objectContaining({ outcome: 'denied' }),
    ]);
  });

  it('holds every entry to the source: its names, its types, and only its absences removed', async () => {
    const { org, production } = await setup();
    const fresh = { id: crypto.randomUUID(), expectedVersion: 1 };

    const notInSource = await promote(org, 'production', {
      source: 'staging',
      dryRun: true,
      writes: [entry(production, 'INVENTED', 'x', fresh)],
    });
    expect(notInSource.status).toBe(422);

    const retyped = await promote(org, 'production', {
      source: 'staging',
      dryRun: true,
      writes: [entry(production, 'API_URL', 'x', fresh, { valueType: 'int' })],
    });
    expect(retyped.status).toBe(422);

    for (const removal of ['SHARED', 'NOWHERE']) {
      const answer = await promote(org, 'production', {
        source: 'staging',
        dryRun: true,
        writes: [],
        removals: [removal],
      });
      expect(answer.status).toBe(422);
    }

    const twice = await promote(org, 'production', {
      source: 'staging',
      dryRun: true,
      writes: [entry(production, 'API_URL', 'x', fresh)],
      removals: ['API_URL'],
    });
    expect(twice.status).toBe(400);

    const itself = await promote(org, 'production', {
      source: 'production',
      dryRun: true,
      writes: [],
    });
    expect(itself.status).toBe(422);
  });

  it('checks the templates of a batch together, so a template can travel with what it refers to', async () => {
    const org = await f.seedOrg('pro');
    const project = await f.seedProject(org);
    const staging = await f.seedEnv(org, project, 'staging');
    const production = await f.seedEnv(org, project, 'production');
    await f.seedSecret(org, staging, 'HOST', { label: 'host', hmac: tag('host') });
    await f.seedSecret(org, staging, 'URL', {
      label: 'url',
      hmac: tag('url'),
      references: [{ name: 'HOST', environmentId: null }],
    });
    caller = f.sessionOf(org.owner);

    const answer = await promote(org, 'production', {
      source: 'staging',
      dryRun: false,
      writes: [
        entry(production, 'HOST', 'host', { id: crypto.randomUUID(), expectedVersion: 1 }),
        entry(
          production,
          'URL',
          'url',
          { id: crypto.randomUUID(), expectedVersion: 1 },
          { references: [{ name: 'HOST' }] },
        ),
      ],
    });
    expect(answer.status).toBe(200);
    expect(answer.body.counts?.['created']).toBe(2);

    // Alone, the template would refer to nothing in production, and is refused.
    const alone = await f.seedEnv(org, project, 'qa');
    const refused = await promote(org, 'qa', {
      source: 'staging',
      dryRun: true,
      writes: [
        entry(
          alone,
          'URL',
          'url',
          { id: crypto.randomUUID(), expectedVersion: 1 },
          { references: [{ name: 'HOST' }] },
        ),
      ],
    });
    expect(refused.status).toBe(409);
  });

  it('needs both environments end-to-end encrypted', async () => {
    const org = await f.seedOrg('pro');
    const project = await f.seedProject(org);
    await f.seedEnv(org, project, 'staging');
    caller = f.sessionOf(org.owner);
    await t.pg.query(
      `insert into environments (id, project_id, name, slug, encryption_mode) values ($1, $2, 'legacy', 'legacy', 'server')`,
      [crypto.randomUUID(), project],
    );

    const answer = await promote(org, 'legacy', { source: 'staging', dryRun: true, writes: [] });
    expect(answer.status).toBe(409);
    expect(answer.body.error?.message).toMatch(/^e2ee_required:/);
  });
});

/* ── point-in-time restore ────────────────────────────────────────────────── */

describe('…/environments/{env}/restore-point', () => {
  /**
   * An environment with a history:
   *  - DATABASE_URL: v1 ten days ago, v2 a day ago — restore writes v1 back;
   *  - PORT: unchanged since ten days ago;
   *  - REMOVED: created ten days ago, deleted two days ago — restore creates it again;
   *  - ADDED: created a day ago — restore removes it.
   */
  async function history(plan: 'free' | 'pro' | 'team' = 'pro') {
    const org = await f.seedOrg(plan);
    const project = await f.seedProject(org);
    const env = await f.seedEnv(org, project, 'development');
    const db = await f.seedSecret(org, env, 'DATABASE_URL', { label: 'db-v1', hmac: tag('db-v1') });
    await t.pg.query(`update secret_versions set created_at = $2 where secret_id = $1`, [
      db,
      ago(10),
    ]);
    await addSecretVersion(t.db, {
      orgId: org.orgId,
      secretId: db,
      payload: {
        mode: 'e2ee',
        envDataKeyId: env.keyId,
        ciphertext: new TextEncoder().encode(blob('db-v2')),
        clientAlgorithm: 'xk2.gcm',
      },
      valueHmac: tag('db-v2'),
      writer: { userId: org.owner.id },
    });
    await t.pg.query(
      `update secret_versions set created_at = $2 where secret_id = $1 and version = 2`,
      [db, ago(1)],
    );

    const port = await f.seedSecret(org, env, 'PORT', { label: 'port', hmac: tag('port') });
    const removed = await f.seedSecret(org, env, 'REMOVED', {
      label: 'removed',
      hmac: tag('removed'),
    });
    for (const id of [port, removed]) {
      await t.pg.query(`update secret_versions set created_at = $2 where secret_id = $1`, [
        id,
        ago(10),
      ]);
      await t.pg.query(`update secrets set created_at = $2 where id = $1`, [id, ago(10)]);
    }
    await t.pg.query(`update secrets set created_at = $2 where id = $1`, [db, ago(10)]);
    await t.pg.query(`update secrets set deleted_at = $2 where id = $1`, [removed, ago(2)]);
    await f.seedSecret(org, env, 'ADDED', { label: 'added', hmac: tag('added') });

    caller = f.sessionOf(org.owner);
    return { org, project, env, ids: { db, port, removed } };
  }

  function preview(org: Org, at: Date) {
    const { path, params } = f.envPath(
      org,
      'development',
      `/restore-point?at=${encodeURIComponent(at.toISOString())}`,
    );
    return f.call<Body>(restoreRoute.GET, 'GET', path, params);
  }

  function apply(org: Org, body: unknown) {
    const { path, params } = f.envPath(org, 'development', '/restore-point');
    return f.call<Body>(restoreRoute.POST, 'POST', path, params, body);
  }

  /** The writes a client would send for a plan: the instant's value, under today's key. */
  function writesFor(env: Env, plan: NonNullable<Body['plan']>, labels: Record<string, string>) {
    return plan.items
      .filter((item) => item.expectedVersion !== null && item.available)
      .map((item) =>
        entry(env, item.name, labels[item.name]!, {
          id: item.secretId ?? crypto.randomUUID(),
          expectedVersion: item.expectedVersion!,
        }),
      );
  }

  it('previews the instant — what changes, what comes back, what goes — and records the read', async () => {
    const { org } = await history();

    const answer = await preview(org, ago(5));
    expect(answer.status).toBe(200);
    const actions = Object.fromEntries(
      answer.body.plan!.items.map((item) => [item.name, item.action]),
    );
    expect(actions).toEqual({
      ADDED: 'delete',
      DATABASE_URL: 'update',
      PORT: 'unchanged',
      REMOVED: 'recreate',
    });
    expect(answer.body.plan!.window.days).toBe(30);
    expect(recorded('secret.read')).toEqual([
      expect.objectContaining({ metadata: expect.objectContaining({ reason: 'restore-preview' }) }),
    ]);
  });

  it('writes forward: the old value as a new version, the deleted one again, the new one removed', async () => {
    const { org, env, ids } = await history();
    const plan = (await preview(org, ago(5))).body.plan!;

    const answer = await apply(org, {
      at: plan.at,
      dryRun: false,
      writes: writesFor(env, plan, { DATABASE_URL: 'db-v1', REMOVED: 'removed' }),
    });
    expect(answer.status).toBe(200);
    expect(answer.body.counts).toMatchObject({
      updated: 1,
      recreated: 1,
      deleted: 1,
      unchanged: 1,
    });

    const after = await secretsOf(env);
    expect([...after.keys()].sort()).toEqual(['DATABASE_URL', 'PORT', 'REMOVED']);
    expect(after.get('DATABASE_URL')).toMatchObject({ version: 3, hmac: tagOf('db-v1') });
    // A new row, beside the deleted one — whose deletion stays on the record.
    expect(after.get('REMOVED')!.id).not.toBe(ids.removed);

    // History is intact: the versions it wrote over are all still there.
    const versions = await t.pg.query(`select version from secret_versions where secret_id = $1`, [
      ids.db,
    ]);
    expect(versions.rows).toHaveLength(3);

    expect(recorded('environment.restored')).toEqual([
      expect.objectContaining({
        outcome: 'success',
        metadata: expect.objectContaining({ createdCount: 1, updatedCount: 1, deletedCount: 1 }),
      }),
    ]);
  });

  it('is itself restorable: restoring to just before it puts everything back', async () => {
    const { org, env } = await history();
    const plan = (await preview(org, ago(5))).body.plan!;
    const before = new Date();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      (
        await apply(org, {
          at: plan.at,
          dryRun: false,
          writes: writesFor(env, plan, { DATABASE_URL: 'db-v1', REMOVED: 'removed' }),
        })
      ).status,
    ).toBe(200);

    const undo = (await preview(org, before)).body.plan!;
    const actions = Object.fromEntries(undo.items.map((item) => [item.name, item.action]));
    expect(actions).toEqual({
      ADDED: 'recreate',
      DATABASE_URL: 'update',
      PORT: 'unchanged',
      REMOVED: 'delete',
    });
  });

  it('refuses a value that is not the instant’s, and a plan that is missing one', async () => {
    const { org, env } = await history();
    const plan = (await preview(org, ago(5))).body.plan!;
    const before = await secretsOf(env);

    const wrong = await apply(org, {
      at: plan.at,
      dryRun: false,
      writes: writesFor(env, plan, { DATABASE_URL: 'db-v2', REMOVED: 'removed' }),
    });
    expect(wrong.status).toBe(422);

    const partial = await apply(org, {
      at: plan.at,
      dryRun: false,
      writes: writesFor(env, plan, { DATABASE_URL: 'db-v1', REMOVED: 'removed' }).slice(0, 1),
    });
    expect(partial.status).toBe(422);
    expect(await secretsOf(env)).toEqual(before);
  });

  it('refuses a preview gone stale', async () => {
    const { org, env } = await history();
    const plan = (await preview(org, ago(5))).body.plan!;
    const writes = writesFor(env, plan, { DATABASE_URL: 'db-v1', REMOVED: 'removed' });
    writes[0]!.expectedVersion += 1;
    expect((await apply(org, { at: plan.at, dryRun: false, writes })).status).toBe(409);
  });

  it('leaves a version it cannot open alone, and says so', async () => {
    const { org, env } = await history();
    // DATABASE_URL's old value was written under a key since rotated away, and
    // this caller holds no grant on it.
    const retired = crypto.randomUUID();
    await t.pg.query(
      `insert into env_data_keys (id, environment_id, version, status, created_by) values ($1, $2, 5, 'retired', $3)`,
      [retired, env.id, org.owner.id],
    );
    await t.pg.query(
      `update secret_versions set env_data_key_id = $2 where secret_id = (select id from secrets where name = 'DATABASE_URL' and environment_id = $1) and version = 1`,
      [env.id, retired],
    );

    const plan = (await preview(org, ago(5))).body.plan!;
    const item = plan.items.find((candidate) => candidate.name === 'DATABASE_URL')!;
    expect(item.available).toBe(false);

    const answer = await apply(org, {
      at: plan.at,
      dryRun: false,
      writes: writesFor(env, plan, { REMOVED: 'removed' }),
    });
    expect(answer.status).toBe(200);
    expect(answer.body.skipped).toEqual(['DATABASE_URL']);
    expect((await secretsOf(env)).get('DATABASE_URL')!.hmac).toBe(tagOf('db-v2'));
  });

  it('refuses a Free organisation, naming the plan', async () => {
    const { org } = await history('free');
    const answer = await preview(org, ago(5));
    expect(answer.status).toBe(403);
    expect(answer.body.error?.code).toBe('plan_limit');
    expect(answer.body.error?.plan?.upgradeTo).toBe('pro');
    expect(recorded('environment.restored')).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          reason: 'quotaExceeded',
          limitName: 'pointInTimeRestore',
        }),
      }),
    ]);
  });

  it('refuses a point past the plan’s window, with the plan whose window reaches it', async () => {
    const { org } = await history('pro');
    const answer = await preview(org, ago(45));
    expect(answer.status).toBe(403);
    expect(answer.body.error?.plan).toMatchObject({
      resource: 'pitrDays',
      limit: 30,
      upgradeTo: 'team',
    });
    expect(answer.body.error?.message).toContain('30 days');

    const future = await preview(org, new Date(Date.now() + DAY));
    expect(future.status).toBe(422);
  });

  it('refuses a service token, and a viewer applying one', async () => {
    const { org, project, env } = await history();
    caller = await f.seedServiceToken(org, project, env);
    expect((await preview(org, ago(5))).status).toBe(403);

    caller = f.sessionOf(await f.seedMember(org, 'viewer'));
    const answer = await apply(org, { at: ago(5).toISOString(), dryRun: true, writes: [] });
    expect(answer.status).toBe(403);
    expect(recorded('environment.restored')).toEqual([
      expect.objectContaining({ outcome: 'denied' }),
    ]);
  });
});

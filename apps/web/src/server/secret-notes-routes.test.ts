import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EnvelopeService,
  generateKeyBytes,
  InMemoryKeyProvider,
  parseRootKeyMaterial,
  toBase64Url,
} from '@xecret/core/crypto';
import { generateEnvironmentDataKey, generateEnvironmentHmacKey } from '@xecret/core/crypto/client';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '@xecret/db/testing';
import type { TestDatabase } from '@xecret/db/testing';
import { api } from '@/lib/api';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
import { clientSecretIo, serverSecretIo } from '@/components/envkeys/secret-io';
import type { SecretIo } from '@/components/envkeys/secret-io';
import { holdEnvKey, releaseEnvKeys } from '@/components/envkeys/env-key-store';
import type { EnvKeyMaterial } from '@/components/envkeys/env-key-store';
import { encryptNote } from '@/components/envkeys/secret-crypto';
import type { SecretListResponse, SecretSummary } from '@/components/secrets/types';
import type { Principal } from './actor';
import { errors } from './errors';
import { createLogger } from './logging';
import type { RequestLog } from './logging';
import { ORIGIN, routeFixtures } from './testing/route-fixtures';
import type { Env, Org } from './testing/route-fixtures';

/**
 * A secret's note — the description typed beside a key — from the box it is
 * typed into to the box it is shown in, against PGlite.
 *
 * ── What is real ──
 * Everything a note passes through: the dashboard's own `SecretIo` and its
 * cryptography, the dashboard's own `api` client, the route handlers, the
 * repositories and the database. `fetch` is the one seam, pointed at the route
 * handlers instead of a network, so a body the client builds is exactly the
 * body the route parses.
 *
 * ── The bug this pins ──
 * In an end-to-end encrypted environment — the default — a note was encrypted,
 * written and listed perfectly well, and the listing carries it only as
 * `encNote`, with `note: null`. The table renders `note`, and nothing ever
 * decrypted `encNote` into it, so every note on such an environment showed as
 * absent the moment the save landed: "the description is not saving". The
 * server half was never wrong. `SecretIo.openNotes` is the half that was
 * missing, and the end of each round trip below goes through it, because that
 * is the step the table now reads from.
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

const secretsRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/secrets/route');
const secretRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/secrets/[name]/route');

let t: TestDatabase;
let envelope: EnvelopeService;
let deferred: Promise<unknown>[] = [];
let caller: Principal | null = null;

const f = routeFixtures({ t: () => t, envelope: () => envelope, deferred: () => deferred });

beforeAll(async () => {
  t = await createTestDatabase();
  const rootKeys = JSON.stringify({ '1': toBase64Url(generateKeyBytes()) });
  envelope = new EnvelopeService(new InMemoryKeyProvider(parseRootKeyMaterial(rootKeys, 1)));
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

/* ── `fetch`, answered by the route handlers ─────────────────────────────── */

type RouteHandler = (
  request: Request,
  args: { params: Promise<Record<string, string>> },
) => Promise<Response>;
type RouteModule = Partial<Record<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', RouteHandler>>;

const ENVIRONMENT = '^/api/orgs/([^/]+)/projects/([^/]+)/environments/([^/]+)/secrets';

const ROUTES: readonly {
  pattern: RegExp;
  module: RouteModule;
  params: (match: RegExpExecArray) => Record<string, string>;
}[] = [
  {
    pattern: new RegExp(`${ENVIRONMENT}$`),
    module: secretsRoute as unknown as RouteModule,
    params: ([, orgSlug = '', projectSlug = '', envSlug = '']) => ({
      orgSlug,
      projectSlug,
      envSlug,
    }),
  },
  {
    pattern: new RegExp(`${ENVIRONMENT}/([^/]+)$`),
    module: secretRoute as unknown as RouteModule,
    params: ([, orgSlug = '', projectSlug = '', envSlug = '', name = '']) => ({
      orgSlug,
      projectSlug,
      envSlug,
      name,
    }),
  },
];

async function dispatch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input), ORIGIN);
  const method = (init.method ?? 'GET') as keyof RouteModule;

  for (const route of ROUTES) {
    const match = route.pattern.exec(url.pathname);
    if (match === null) continue;

    const handler = route.module[method];
    if (handler === undefined) throw new Error(`${method} ${url.pathname} has no handler`);

    const response = await handler(
      new Request(url, {
        method,
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        ...(typeof init.body === 'string' ? { body: init.body } : {}),
      }),
      { params: Promise.resolve(route.params(match)) },
    );
    await Promise.allSettled(deferred);
    return response;
  }

  throw new Error(`no route answers ${url.pathname}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  deferred = [];
  caller = null;
  releaseEnvKeys();
  vi.stubGlobal('fetch', vi.fn(dispatch));

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
  // The audit trail is other suites' to assert; here it only has to be written somewhere.
  auditSink.write.mockImplementation(async () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  releaseEnvKeys();
});

/* ── fixtures ─────────────────────────────────────────────────────────────── */

const PROJECT = 'api';
const ENVIRONMENT_SLUG = 'production';

/** An owner's session in a fresh organisation, with one environment in the given mode. */
async function setup(mode: 'e2ee' | 'server'): Promise<{ org: Org; env: Env }> {
  const org = await f.seedOrg('free');
  const projectId = await f.seedProject(org, PROJECT);
  const env = await f.seedEnv(org, projectId, ENVIRONMENT_SLUG, { mode });
  caller = f.sessionOf(org.owner);
  return { org, env };
}

/** The key a browser would have opened from its grant, held where `withEnvKey` looks. */
function openedKey(env: Env): EnvKeyMaterial {
  const material: EnvKeyMaterial = {
    environmentId: env.id,
    envDataKeyId: env.keyId,
    edkVersion: 1,
    edk: generateEnvironmentDataKey(),
    ehk: generateEnvironmentHmacKey(),
  };
  holdEnvKey(material);
  return material;
}

function ioContext(org: Org) {
  return { orgSlug: org.slug, orgId: org.orgId, projectSlug: PROJECT, envSlug: ENVIRONMENT_SLUG };
}

/** The listing exactly as the environment screen fetches it. */
async function listing(org: Org): Promise<readonly SecretSummary[]> {
  const response = await api.get<SecretListResponse>(
    apiPath.secrets(org.slug, PROJECT, ENVIRONMENT_SLUG),
  );
  return response.data;
}

/** What the table is handed: the listing, with its notes opened by the IO. */
async function shown(org: Org, io: SecretIo): Promise<Map<string, string | null>> {
  const opened = await io.openNotes(await listing(org));
  return new Map(opened.map((secret) => [secret.name, secret.note]));
}

function refOf(secret: SecretSummary) {
  return { id: secret.id, name: secret.name, version: secret.version };
}

/* ── the round trips ──────────────────────────────────────────────────────── */

describe('a note on a secret, in an end-to-end encrypted environment', () => {
  it('is written sealed, listed sealed, and shown in plaintext once opened', async () => {
    const { org, env } = await setup('e2ee');
    const io = clientSecretIo(ioContext(org), openedKey(env));

    await io.create({
      name: 'STRIPE_KEY',
      value: 'sk_live_one',
      note: 'Billing — rotates quarterly',
      valueType: 'string',
    });

    // What the server stores and lists: the note sealed, and nothing in
    // `note`. This is the shape the table used to render directly, which is
    // why every note on this environment looked unsaved.
    const [listed] = await listing(org);
    expect(listed).toMatchObject({ name: 'STRIPE_KEY', note: null });
    expect(listed?.encNote).toMatch(/^xk2\.gcm\./);
    const stored = await t.pg.query<{ note: string | null; enc_note: Uint8Array | null }>(
      `select note, enc_note from secrets where environment_id = $1`,
      [env.id],
    );
    expect(stored.rows[0]?.note).toBeNull();
    // The column holds the ASCII of the blob the listing serves, and the note
    // is nowhere in it.
    const sealedText = new TextDecoder().decode(stored.rows[0]!.enc_note!);
    expect(sealedText).toBe(listed?.encNote);
    expect(sealedText).not.toContain('rotates quarterly');
    expect(sealedText).not.toContain(toBase64Url(new TextEncoder().encode('rotates quarterly')));

    // …and what the table is now handed.
    expect((await shown(org, io)).get('STRIPE_KEY')).toBe('Billing — rotates quarterly');
  });

  it('is edited and cleared through the metadata route, and each change reads back', async () => {
    const { org, env } = await setup('e2ee');
    const io = clientSecretIo(ioContext(org), openedKey(env));

    await io.create({ name: 'DATABASE_URL', value: 'postgres://one', valueType: 'string' });
    expect((await shown(org, io)).get('DATABASE_URL')).toBeNull();

    // Added to a key that had none — the other way a description is typed.
    const [created] = await listing(org);
    const written = await io.patchMetadata(refOf(created!), { note: 'Primary, read-write' });
    expect((await shown(org, io)).get('DATABASE_URL')).toBe('Primary, read-write');
    // What the write says it stored is exactly what the next listing carries —
    // the premise of the table showing the new note before that listing lands.
    expect(written.encNote).toBe((await listing(org))[0]?.encNote);

    const [described] = await listing(org);
    await io.patchMetadata(refOf(described!), { note: 'Primary — failover in eu-west' });
    expect((await shown(org, io)).get('DATABASE_URL')).toBe('Primary — failover in eu-west');

    // `null` clears it, sealed column and all.
    const [edited] = await listing(org);
    await io.patchMetadata(refOf(edited!), { note: null });
    const [cleared] = await listing(org);
    expect(cleared).toMatchObject({ note: null, encNote: null });
    expect((await shown(org, io)).get('DATABASE_URL')).toBeNull();
  });

  it('opens a note sealed before a rotation, with the retired key this session still holds', async () => {
    const { org, env } = await setup('e2ee');
    const before = openedKey(env);
    await clientSecretIo(ioContext(org), before).create({
      name: 'WEBHOOK_SECRET',
      value: 'whsec_one',
      note: 'Signed by the payments team',
      valueType: 'string',
    });

    // The rotation, as the server records it — the old key retired, a new one
    // active — and the browser's side of it: the new key opened beside the old
    // one, and the IO the screen re-opens with built around the new one. Notes
    // carry no key id, so the old note has to be found by trying the keys
    // there are.
    const after: EnvKeyMaterial = {
      environmentId: env.id,
      envDataKeyId: crypto.randomUUID(),
      edkVersion: 2,
      edk: generateEnvironmentDataKey(),
      ehk: before.ehk,
    };
    await t.pg.query(`update env_data_keys set status = 'retired' where id = $1`, [env.keyId]);
    await t.pg.query(
      `insert into env_data_keys (id, environment_id, version, status, created_by) values ($1, $2, 2, 'active', $3)`,
      [after.envDataKeyId, env.id, org.owner.id],
    );
    holdEnvKey(after);
    const rotated = clientSecretIo(ioContext(org), after);

    // A note written after the rotation, under the key that is active now.
    await rotated.create({
      name: 'AFTER',
      value: 'two',
      note: 'written under the new key',
      valueType: 'string',
    });

    const notes = new Map(
      (await rotated.openNotes(await listing(org))).map((secret) => [secret.name, secret]),
    );
    expect(notes.get('WEBHOOK_SECRET')).toMatchObject({ note: 'Signed by the payments team' });
    expect(notes.get('WEBHOOK_SECRET')?.noteState).toBeUndefined();
    // …and says so: nothing in a note proves it was sealed before the key that
    // opened it was retired, so somebody that rotation shut out could have
    // written it since.
    expect(notes.get('WEBHOOK_SECRET')?.noteUnderRetiredKey).toBe(true);
    expect(notes.get('AFTER')).toMatchObject({
      note: 'written under the new key',
      noteUnderRetiredKey: false,
    });
  });

  it('says a note will not open, rather than showing it as absent', async () => {
    const { org, env } = await setup('e2ee');
    await clientSecretIo(ioContext(org), openedKey(env)).create({
      name: 'LEGACY_TOKEN',
      value: 'one',
      note: 'from before the rotation',
      valueType: 'string',
    });

    // A fresh load after the rotation: only the new key was ever opened here.
    releaseEnvKeys();
    const rotated = clientSecretIo(
      ioContext(org),
      openedKey({ ...env, keyId: crypto.randomUUID() }),
    );

    const [row] = await rotated.openNotes(await listing(org));
    expect(row).toMatchObject({ note: null, noteState: 'unreadable' });
  });

  it('shows a note it cannot open as unreadable, and still shows every other one', async () => {
    const { org, env } = await setup('e2ee');
    const io = clientSecretIo(ioContext(org), openedKey(env));

    await io.create({ name: 'OPENS', value: 'one', note: 'readable', valueType: 'string' });
    await io.create({ name: 'SEALED_ELSEWHERE', value: 'two', valueType: 'string' });

    // A note sealed under a key this browser does not hold — what a note
    // written before a rotation looks like to the key that replaced it.
    const rows = await listing(org);
    const foreign = rows.find((row) => row.name === 'SEALED_ELSEWHERE')!;
    const otherKey: EnvKeyMaterial = {
      environmentId: env.id,
      envDataKeyId: env.keyId,
      edkVersion: 1,
      edk: generateEnvironmentDataKey(),
      ehk: generateEnvironmentHmacKey(),
    };
    const encNote = await encryptNote({
      material: otherKey,
      target: { orgId: org.orgId, environmentId: env.id, secretId: foreign.id },
      note: 'not for this key',
    });
    const put = await dispatch(
      `${apiPath.secret(org.slug, PROJECT, ENVIRONMENT_SLUG, foreign.name)}`,
      { method: 'PUT', body: JSON.stringify({ encNote }) },
    );
    expect(put.status).toBe(200);

    const opened = await io.openNotes(await listing(org));
    const byName = new Map(opened.map((secret) => [secret.name, secret]));
    expect(byName.get('OPENS')).toMatchObject({ note: 'readable' });
    expect(byName.get('OPENS')?.noteState).toBeUndefined();
    expect(byName.get('SEALED_ELSEWHERE')).toMatchObject({ note: null, noteState: 'unreadable' });
  });
});

describe('a note on a secret, in a server-mode environment', () => {
  it('is created, read back, edited and cleared in plaintext', async () => {
    const { org } = await setup('server');
    const io = serverSecretIo(ioContext(org));

    await io.create({
      name: 'SENDGRID_KEY',
      value: 'SG.one',
      note: 'Transactional mail',
      valueType: 'string',
    });
    const [listed] = await listing(org);
    expect(listed).toMatchObject({ name: 'SENDGRID_KEY', note: 'Transactional mail' });
    // Opening a server-mode listing changes nothing: the note is already there.
    expect((await shown(org, io)).get('SENDGRID_KEY')).toBe('Transactional mail');

    await io.patchMetadata(refOf(listed!), { note: 'Transactional mail — EU region' });
    expect((await shown(org, io)).get('SENDGRID_KEY')).toBe('Transactional mail — EU region');

    const [edited] = await listing(org);
    await io.patchMetadata(refOf(edited!), { note: null });
    expect((await shown(org, io)).get('SENDGRID_KEY')).toBeNull();
  });
});

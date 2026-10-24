import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AuditRecord } from '@xecret/core/audit';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '@xecret/db/testing';
import type { TestDatabase } from '@xecret/db/testing';
import type { Principal } from './actor';
import type { ServiceContext } from './context';
import { errors } from './errors';
import { createLogger } from './logging';
import type { LogEntry, RequestLog } from './logging';

/**
 * New-location read alerts (P19 §7), end to end: noting a read, the hourly
 * throttle, the five-minute sweep, and the read-sightings route — against a
 * real database with every migration applied.
 *
 * Real: tenancy and the entitlement engine reading the subscription row; every
 * repository; the ZeptoMail client. Stubbed: who is asking, the audit sink, the
 * logger (captured), and `fetch`, which plays ZeptoMail.
 */

const ORIGIN = 'https://xecret.test';
const ZEPTO = 'https://api.zeptomail.com/v1.1/email';

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

const sightingsRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/read-sightings/route');
const alerts = await import('./read-alerts');
const { resolveEnvironmentPath } = await import('./tenancy');

let t: TestDatabase;
let audit: AuditRecord[] = [];
let lines: LogEntry[] = [];
let deferred: Promise<unknown>[] = [];
let env: Record<string, unknown>;
let caller: Principal;
let mail: { to: string; subject: string; text: string; html: string }[] = [];
let mailStatus = 201;

function servicesFor(
  ipAddress: string | null = '203.0.113.5',
  request?: Request,
  requestId: string = randomUUID(),
  log?: RequestLog,
) {
  return {
    env,
    db: t.db,
    envelope: {},
    meta: {
      requestId,
      rayId: null,
      ipAddress,
      userAgent: 'vitest',
      method: request?.method ?? 'GET',
      path: request === undefined ? '/' : new URL(request.url).pathname,
      startedAt: Date.now(),
    },
    log:
      log?.logger ??
      createLogger({
        sink: { write: (entry) => lines.push(entry), flush: () => Promise.resolve() },
        minimum: 'debug',
        base: {},
      }).logger,
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
  mail = [];
  mailStatus = 201;
  env = {
    XECRET_PUBLIC_URL: ORIGIN,
    XECRET_ENV: 'test',
    ZEPTOMAIL_TOKEN: 'zepto-test-token',
    ZEPTOMAIL_FROM_ADDRESS: 'no-reply@example.com',
  };
  // Nothing owed from an earlier test, so a sweep serves only this test's
  // organisations — the database is shared by the whole file.
  await t.pg.query(
    `update environment_read_sightings set notified_at = now() where notified_at is null`,
  );

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url !== ZEPTO) throw new Error(`unexpected fetch to ${url}`);
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
      servicesFor('203.0.113.5', request, requestId, log),
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
  const email = `reads-${id.slice(0, 8)}@example.com`;
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

async function addMember(orgId: string, userId: string, role: string): Promise<void> {
  await t.pg.query(`insert into org_members (id, org_id, user_id, role) values ($1, $2, $3, $4)`, [
    randomUUID(),
    orgId,
    userId,
    role,
  ]);
}

interface World {
  orgId: string;
  slug: string;
  owner: Person;
  admin: Person;
  projectId: string;
  production: string;
  development: string;
}

/** An organisation with an owner and an admin, a project, and a production and a development environment. */
async function seedWorld(plan: 'free' | 'pro' = 'pro'): Promise<World> {
  const owner = await seedUser();
  const admin = await seedUser();
  const orgId = randomUUID();
  const slug = `reads-${orgId.slice(0, 8)}`;
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
  await addMember(orgId, admin.id, 'admin');
  const projectId = randomUUID();
  await t.pg.query(
    `insert into projects (id, org_id, name, slug, created_by) values ($1, $2, 'API', 'api', $3)`,
    [projectId, orgId, owner.id],
  );
  const production = randomUUID();
  const development = randomUUID();
  await t.pg.query(
    `insert into environments (id, project_id, name, slug, encryption_mode, is_production)
     values ($1, $3, 'Production', 'production', 'e2ee', true),
            ($2, $3, 'Development', 'development', 'e2ee', false)`,
    [production, development, projectId],
  );
  return { orgId, slug, owner, admin, projectId, production, development };
}

const params = (world: World, envSlug = 'production') => ({
  orgSlug: world.slug,
  projectSlug: 'api',
  envSlug,
});

/** Resolves the scope as the pull would, then notes the read, then waits for the deferred work. */
async function readAs(
  world: World,
  principal: Principal,
  options: { ip?: string | null; envSlug?: string } = {},
) {
  const services = servicesFor(options.ip === undefined ? '203.0.113.5' : options.ip);
  const scope = await resolveEnvironmentPath(principal, params(world, options.envSlug), services);
  alerts.noteEnvironmentRead(scope, services, principal);
  await Promise.allSettled(deferred);
}

async function sightingsOf(environmentId: string) {
  const rows = await t.pg.query<{
    principal_kind: string;
    principal_id: string;
    principal_label: string | null;
    ip_address: string;
    notified_at: Date | null;
  }>(
    `select principal_kind, principal_id, principal_label, ip_address, notified_at
     from environment_read_sightings where environment_id = $1 order by first_seen_at, id`,
    [environmentId],
  );
  return rows.rows;
}

async function lastMailedLongAgo(world: World): Promise<void> {
  await t.pg.query(
    `update read_alert_digests set last_sent_at = now() - interval '2 hours' where org_id = $1`,
    [world.orgId],
  );
}

/* ── addresses ────────────────────────────────────────────────────────────── */

describe('normaliseReadAddress', () => {
  it('keeps IPv4 whole', () => {
    expect(alerts.normaliseReadAddress('203.0.113.5')).toBe('203.0.113.5');
    expect(alerts.normaliseReadAddress(' 198.51.100.7 ')).toBe('198.51.100.7');
  });

  it('reduces IPv6 to its /64, in canonical compressed form', () => {
    expect(alerts.normaliseReadAddress('2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd')).toBe(
      '2001:db8:1:2::/64',
    );
    expect(alerts.normaliseReadAddress('2001:db8:1:2::9')).toBe('2001:db8:1:2::/64');
    expect(alerts.normaliseReadAddress('2001:db8::1')).toBe('2001:db8::/64');
    // The longest run of zeros is compressed, not the first.
    expect(alerts.normaliseReadAddress('2001:0:0:1:2:3:4:5')).toBe('2001:0:0:1::/64');
    expect(alerts.normaliseReadAddress('fe80::1%eth0')).toBe('fe80::/64');
    expect(alerts.normaliseReadAddress('::1')).toBe('::/64');
  });

  it('reads a v4-mapped v6 address as the v4 address it carries', () => {
    expect(alerts.normaliseReadAddress('::ffff:203.0.113.5')).toBe('203.0.113.5');
    expect(alerts.normaliseReadAddress('::FFFF:cb00:7105')).toBe('203.0.113.5');
  });

  it('answers null for anything that is not an address', () => {
    for (const junk of [
      '',
      'not-an-ip',
      '1.2.3.256',
      '1.2.3',
      '1::2::3',
      '12345::',
      'g::1',
      ':::',
    ]) {
      expect(alerts.normaliseReadAddress(junk), junk).toBeNull();
    }
  });
});

/* ── noting a read ────────────────────────────────────────────────────────── */

describe('a read from somewhere new', () => {
  it('mails the owners and admins once, then not again for a repeat', async () => {
    const world = await seedWorld();
    await readAs(world, sessionOf(world.owner));

    expect(mail.map((message) => message.to).sort()).toEqual(
      [world.owner.email, world.admin.email].sort(),
    );
    const [message] = mail;
    expect(message!.subject).toBe('New read location in Acme');
    expect(message!.text).toContain('api/production (production)');
    expect(message!.text).toContain(world.owner.email);
    expect(message!.text).toContain('203.0.113.5');
    expect(message!.text).toContain(`${ORIGIN}/app/${world.slug}/api/production/settings`);
    expect(message!.html).toContain(`${ORIGIN}/app/${world.slug}/api/production/settings`);

    const [sighting] = await sightingsOf(world.production);
    expect(sighting).toMatchObject({
      principal_kind: 'user',
      principal_id: world.owner.id,
      principal_label: world.owner.email,
      ip_address: '203.0.113.5',
    });
    expect(sighting!.notified_at).not.toBeNull();

    // The same person from the same address: nothing new.
    mail = [];
    await readAs(world, sessionOf(world.owner));
    expect(mail).toEqual([]);
    expect(await sightingsOf(world.production)).toHaveLength(1);
  });

  it('holds a second new sighting within the hour for the sweep, which mails it later', async () => {
    const world = await seedWorld();
    await readAs(world, sessionOf(world.owner));
    mail = [];

    await readAs(world, sessionOf(world.owner), { ip: '198.51.100.7' });
    expect(mail).toEqual([]);
    const owed = (await sightingsOf(world.production)).find(
      (row) => row.ip_address === '198.51.100.7',
    );
    expect(owed!.notified_at).toBeNull();

    // Still inside the hour: the sweep leaves it.
    expect(await alerts.sweepReadAlertDigests(servicesFor())).toBe(0);
    expect(mail).toEqual([]);

    // The hour is up.
    await lastMailedLongAgo(world);
    expect(await alerts.sweepReadAlertDigests(servicesFor())).toBe(1);
    expect(mail).toHaveLength(2);
    expect(mail[0]!.text).toContain('198.51.100.7');
    expect(mail[0]!.text).not.toContain('203.0.113.5');
    expect((await sightingsOf(world.production)).every((row) => row.notified_at !== null)).toBe(
      true,
    );

    // And then the throttle holds again.
    mail = [];
    await readAs(world, sessionOf(world.owner), { ip: '192.0.2.44' });
    expect(mail).toEqual([]);
  });

  it('batches a burst of new addresses into one digest', async () => {
    const world = await seedWorld();
    await readAs(world, sessionOf(world.owner));
    mail = [];
    for (let i = 1; i <= 5; i += 1) {
      await readAs(world, sessionOf(world.owner), { ip: `198.51.100.${i}` });
    }
    expect(mail).toEqual([]);
    await lastMailedLongAgo(world);
    await alerts.sweepReadAlertDigests(servicesFor());
    expect(mail).toHaveLength(2);
    expect(mail[0]!.subject).toBe('5 new read locations in Acme');
  });

  it('records an IPv6 reader by its /64, so its rotating addresses are one sighting', async () => {
    const world = await seedWorld();
    await readAs(world, sessionOf(world.owner), { ip: '2001:db8:1:2:aaaa:bbbb:cccc:dddd' });
    await readAs(world, sessionOf(world.owner), { ip: '2001:db8:1:2::77' });
    const rows = await sightingsOf(world.production);
    expect(rows.map((row) => row.ip_address)).toEqual(['2001:db8:1:2::/64']);
    expect(mail).toHaveLength(2);
  });

  it('labels a service token by its name, and a CLI login by its person and device', async () => {
    const world = await seedWorld();
    const tokenId = randomUUID();
    await readAs(world, {
      kind: 'serviceToken',
      tokenId,
      tokenName: 'ci-deploy',
      orgId: world.orgId,
      projectId: world.projectId,
      environmentId: world.production,
      accessLevel: 'read',
    });
    const cliTokenId = randomUUID();
    await readAs(
      world,
      {
        kind: 'cliToken',
        tokenId: cliTokenId,
        tokenName: 'laptop',
        userId: world.owner.id,
        orgId: world.orgId,
        signIn: { method: 'password', ssoWorkosOrgId: null },
      },
      { ip: '198.51.100.9' },
    );

    const rows = await sightingsOf(world.production);
    expect(rows.map((row) => [row.principal_kind, row.principal_id, row.principal_label])).toEqual([
      ['service_token', tokenId, 'ci-deploy'],
      ['cli_token', cliTokenId, `${world.owner.email} (laptop)`],
    ]);
    expect(mail[0]!.text).toContain('ci-deploy');
  });

  it('is a new sighting for a new device of the same person', async () => {
    const world = await seedWorld();
    const cli = (tokenId: string): Principal => ({
      kind: 'cliToken',
      tokenId,
      tokenName: 'laptop',
      userId: world.owner.id,
      orgId: world.orgId,
      signIn: { method: 'password', ssoWorkosOrgId: null },
    });
    await readAs(world, cli(randomUUID()));
    await readAs(world, cli(randomUUID()));
    expect(await sightingsOf(world.production)).toHaveLength(2);
  });
});

describe('a read that is not noted', () => {
  it('in a non-production environment with the default setting: no work at all', async () => {
    const world = await seedWorld();
    const services = servicesFor();
    const scope = await resolveEnvironmentPath(
      sessionOf(world.owner),
      params(world, 'development'),
      services,
    );
    t.reset();
    alerts.noteEnvironmentRead(scope, services, sessionOf(world.owner));
    expect(deferred).toEqual([]);
    expect(t.statements).toEqual([]);
    expect(await sightingsOf(world.development)).toEqual([]);
  });

  it('in production with alerts switched off, and is noted in development switched on', async () => {
    const world = await seedWorld();
    await t.pg.query(`update environments set read_alerts = false where id = $1`, [
      world.production,
    ]);
    await t.pg.query(`update environments set read_alerts = true where id = $1`, [
      world.development,
    ]);
    await readAs(world, sessionOf(world.owner));
    expect(await sightingsOf(world.production)).toEqual([]);

    await readAs(world, sessionOf(world.owner), { envSlug: 'development' });
    expect(await sightingsOf(world.development)).toHaveLength(1);
    expect(mail[0]!.text).toContain('api/development —');
  });

  it('on a plan without the feature', async () => {
    const world = await seedWorld('free');
    await readAs(world, sessionOf(world.owner));
    expect(deferred).toEqual([]);
    expect(await sightingsOf(world.production)).toEqual([]);
    expect(mail).toEqual([]);
  });

  it('from an address nobody knows', async () => {
    const world = await seedWorld();
    await readAs(world, sessionOf(world.owner), { ip: null });
    await readAs(world, sessionOf(world.owner), { ip: 'garbage' });
    expect(await sightingsOf(world.production)).toEqual([]);
  });
});

describe('noting a read never costs the read', () => {
  it('does not throw when the database is gone', async () => {
    const world = await seedWorld();
    const services = servicesFor();
    const scope = await resolveEnvironmentPath(sessionOf(world.owner), params(world), services);
    const broken = { ...services, db: null } as unknown as ServiceContext;
    expect(() => alerts.noteEnvironmentRead(scope, broken, sessionOf(world.owner))).not.toThrow();
    await Promise.allSettled(deferred);
    expect(lines.some((line) => line.level === 'error')).toBe(true);
  });

  it('records the sighting even when the mail cannot be sent', async () => {
    const world = await seedWorld();
    mailStatus = 500;
    await readAs(world, sessionOf(world.owner));
    expect(await sightingsOf(world.production)).toHaveLength(1);
    expect(lines.some((line) => line.level === 'error' && /digest/.test(line.message))).toBe(true);
  });
});

describe('the sweep', () => {
  it('clears, unmailed, what an organisation that lost the feature was owed', async () => {
    const world = await seedWorld();
    await readAs(world, sessionOf(world.owner));
    await readAs(world, sessionOf(world.owner), { ip: '198.51.100.7' });
    mail = [];
    await t.pg.query(`delete from org_subscriptions where org_id = $1`, [world.orgId]);
    await lastMailedLongAgo(world);

    expect(await alerts.sweepReadAlertDigests(servicesFor())).toBe(0);
    expect(mail).toEqual([]);
    expect((await sightingsOf(world.production)).every((row) => row.notified_at !== null)).toBe(
      true,
    );
  });
});

/* ── the route ────────────────────────────────────────────────────────────── */

describe('GET …/read-sightings', () => {
  const get = (world: World, query = '') =>
    sightingsRoute.GET(
      new Request(
        `${ORIGIN}/api/orgs/${world.slug}/projects/api/environments/production/read-sightings${query}`,
        { headers: { origin: ORIGIN } },
      ),
      { params: Promise.resolve(params(world)) },
    );

  it('lists the sightings, newest first, with whether alerts are on and paid for', async () => {
    const world = await seedWorld();
    await readAs(world, sessionOf(world.owner));
    await readAs(world, sessionOf(world.admin), { ip: '198.51.100.7' });
    caller = sessionOf(world.admin);

    const response = await get(world, '?limit=10');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      sightings: { principalKind: string; principalLabel: string; address: string }[];
      alerts: unknown;
    };
    expect(body.sightings.map((row) => row.address)).toEqual(['198.51.100.7', '203.0.113.5']);
    expect(body.sightings[1]).toMatchObject({
      principalKind: 'user',
      principalLabel: world.owner.email,
    });
    expect(body.alerts).toEqual({ active: true, entitled: true, upgradeTo: null });
  });

  it('is not gated on the plan, and says what would turn the alerts on', async () => {
    const world = await seedWorld('free');
    caller = sessionOf(world.owner);
    const response = await get(world);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { alerts: unknown }).alerts).toEqual({
      active: true,
      entitled: false,
      upgradeTo: 'pro',
    });
  });

  it('answers 401 with no credential, and 403 to a developer and to a service token', async () => {
    const world = await seedWorld();
    actor.authenticate.mockImplementationOnce(async () => {
      throw errors.unauthenticated('no credential');
    });
    expect((await get(world)).status).toBe(401);

    const developer = await seedUser();
    await addMember(world.orgId, developer.id, 'developer');
    // Refused by capability, before any grant is consulted: a developer may
    // read production when granted it, and still not see who else does.
    caller = sessionOf(developer);
    expect((await get(world)).status).toBe(403);

    caller = {
      kind: 'serviceToken',
      tokenId: randomUUID(),
      tokenName: 'ci',
      orgId: world.orgId,
      projectId: world.projectId,
      environmentId: world.production,
      accessLevel: 'admin',
    };
    expect((await get(world)).status).toBe(403);
  });
});

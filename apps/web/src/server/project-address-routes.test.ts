import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditRecord } from '@xecret/core/audit';
import { uuidv7 } from '@xecret/core/ids';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '@xecret/db/testing';
import type { TestDatabase } from '@xecret/db/testing';
import type { Principal } from './actor';
import { errors } from './errors';
import { createLogger } from './logging';
import type { RequestLog } from './logging';
import { ORIGIN, routeFixtures } from './testing/route-fixtures';
import type { Org } from './testing/route-fixtures';

/**
 * A project's API routes take its id as well as its slug, end to end against
 * PGlite.
 *
 * The dashboard names a project by id — `/app/{org}/{projectId}/…` — and calls
 * the API with the segment its URL holds; the CLI and every `.xecret.yaml` name
 * it by slug. One segment serves both, and what has to be proved at the
 * database rather than against a stub is the tenancy: the id is looked up with
 * the organisation's id in the `WHERE` clause, so another tenant's project id
 * under your own organisation's path is the same 404 as a slug that does not
 * exist. Real queries, real routes; only the request context is supplied.
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

const listRoute = await import('@/app/api/orgs/[orgSlug]/projects/route');
const projectRoute = await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/route');
const environmentRoute =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/route');

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
  error?: { code?: string; message?: string };
  project?: { id: string; name: string; slug: string };
  projects?: { id: string; slug: string }[];
  environments?: { slug: string }[];
  environment?: { slug: string; secretCount: number };
}

function readProject(org: Org, segment: string) {
  return f.call<Body>(projectRoute.GET, 'GET', `/api/orgs/${org.slug}/projects/${segment}`, {
    orgSlug: org.slug,
    projectSlug: segment,
  });
}

function readEnvironment(org: Org, segment: string, env = 'development') {
  return f.call<Body>(
    environmentRoute.GET,
    'GET',
    `/api/orgs/${org.slug}/projects/${segment}/environments/${env}`,
    { orgSlug: org.slug, projectSlug: segment, envSlug: env },
  );
}

/** An organisation with one project, `api`, holding one environment. */
async function setup() {
  const org = await f.seedOrg('free');
  const projectId = await f.seedProject(org, 'api');
  const env = await f.seedEnv(org, projectId, 'development');
  caller = f.sessionOf(org.owner);
  return { org, projectId, env };
}

describe('a project addressed by id', () => {
  it('is the same project as the one its slug names, and says what its id is', async () => {
    const { org, projectId } = await setup();

    const byId = await readProject(org, projectId);
    const bySlug = await readProject(org, 'api');

    expect(byId.status).toBe(200);
    expect(bySlug.status).toBe(200);
    expect(byId.body.project).toMatchObject({ id: projectId, slug: 'api' });
    expect(bySlug.body.project).toEqual(byId.body.project);
    expect(byId.body.environments?.map((environment) => environment.slug)).toEqual(['development']);
  });

  it('reaches the routes below it, which the dashboard calls with the same segment', async () => {
    const { org, projectId } = await setup();

    const answer = await readEnvironment(org, projectId);
    expect(answer.status).toBe(200);
    expect(answer.body.environment).toMatchObject({ slug: 'development', secretCount: 0 });
  });

  it('is published on every project in the listing, the link each card is built from', async () => {
    const { org, projectId } = await setup();

    const answer = await f.call<Body>(listRoute.GET, 'GET', `/api/orgs/${org.slug}/projects`, {
      orgSlug: org.slug,
    });
    expect(answer.status).toBe(200);
    expect(answer.body.projects).toEqual([expect.objectContaining({ id: projectId, slug: 'api' })]);
  });

  it('is renamed by id, records the slug rather than the id, and keeps its address', async () => {
    const { org, projectId } = await setup();

    const answer = await f.call<Body>(
      projectRoute.PATCH,
      'PATCH',
      `/api/orgs/${org.slug}/projects/${projectId}`,
      { orgSlug: org.slug, projectSlug: projectId },
      { name: 'Payments API' },
    );
    expect(answer.status).toBe(200);
    expect(answer.body.project).toMatchObject({ id: projectId, name: 'Payments API', slug: 'api' });

    // The address the dashboard is on still names the same project.
    expect((await readProject(org, projectId)).body.project?.name).toBe('Payments API');

    const [updated] = audit.filter((event) => event.action === 'project.updated');
    expect(updated).toMatchObject({ outcome: 'success', metadata: { projectSlug: 'api' } });
  });
});

/**
 * The isolation the id must not weaken: one segment, looked up inside the
 * organisation in the path, so a foreign id is indistinguishable from nothing.
 */
describe('an id from another organisation', () => {
  it('is not found, with the body an unknown slug gets — even to an owner of both', async () => {
    const { org: acme } = await setup();
    const zebra = await f.seedOrg('free');
    const zebraProject = await f.seedProject(zebra, 'billing');
    await f.seedEnv(zebra, zebraProject, 'development');
    // Acme's owner is made an owner of Zebra too, so nothing but the path's
    // organisation decides the answer: the id is real, readable to this person,
    // and asked for under the wrong organisation.
    await f.addMember(zebra.orgId, acme.owner.id, 'owner');

    const foreign = await readProject(acme, zebraProject);
    const unknownSlug = await readProject(acme, 'billing');
    const unknownId = await readProject(acme, uuidv7());

    expect(foreign.status).toBe(404);
    expect(foreign.body.error?.code).toBe('not_found');
    expect(foreign.body.error?.message).toBe(unknownSlug.body.error?.message);
    expect(unknownSlug.status).toBe(404);
    expect(unknownId.status).toBe(404);
    expect(unknownId.body.error?.message).toBe(unknownSlug.body.error?.message);

    // Nor through a route beneath it.
    expect((await readEnvironment(acme, zebraProject)).status).toBe(404);

    // Under its own organisation, the same id is found.
    expect((await readProject(zebra, zebraProject)).status).toBe(200);
  });

  it('is not found to a member of only the other organisation', async () => {
    const { org: acme, projectId } = await setup();
    const zebra = await f.seedOrg('free');
    caller = f.sessionOf(zebra.owner);

    // Their own organisation's path, the other one's project id.
    const answer = await readProject(zebra, projectId);
    expect(answer.status).toBe(404);
    // And the other organisation's path, which they have no membership in.
    expect((await readProject(acme, projectId)).status).toBe(404);
  });
});

describe('a service token, which is pinned to one project', () => {
  it('reaches its own project by id or by slug, and no other by either', async () => {
    const { org, projectId, env } = await setup();
    const otherProject = await f.seedProject(org, 'web');
    await f.seedEnv(org, otherProject, 'development');
    caller = await f.seedServiceToken(org, projectId, env);

    // Its own project resolves under either spelling and only then meets the
    // policy, which keeps an environment's metadata from a token: a 403. The
    // other project never gets that far — refused at the pin, as nothing.
    expect((await readEnvironment(org, projectId)).status).toBe(403);
    expect((await readEnvironment(org, 'api')).status).toBe(403);
    expect((await readEnvironment(org, otherProject)).status).toBe(404);
    expect((await readEnvironment(org, 'web')).status).toBe(404);
  });
});

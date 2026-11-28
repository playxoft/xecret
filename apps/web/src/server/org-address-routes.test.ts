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
 * An organisation's API routes take its id as well as its legacy slug, end to
 * end against PGlite.
 *
 * The dashboard and a current CLI name an organisation by its id; a CLI
 * installed before that, an old bookmark's page and any integration written
 * against the API still name it by slug. One segment serves both, and what has
 * to be proved against a real database rather than a stub is that the two
 * spellings reach the same organisation through the same gates: the
 * membership, a service token's pin, and the routes beneath. Real queries,
 * real routes; only the request context is supplied.
 *
 * Alongside it, the two rules that make the id the identifier: the server
 * chooses the slug, and nothing changes a project's Project ID once it exists.
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

const orgRoute = await import('@/app/api/orgs/[orgSlug]/route');
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
  organization?: { id: string; name: string; slug: string };
  project?: { id: string; name: string; slug: string };
  projects?: { id: string; slug: string }[];
  environment?: { slug: string };
}

function readOrg(segment: string) {
  return f.call<Body>(orgRoute.GET, 'GET', `/api/orgs/${segment}`, { orgSlug: segment });
}

function listProjects(segment: string) {
  return f.call<Body>(listRoute.GET, 'GET', `/api/orgs/${segment}/projects`, {
    orgSlug: segment,
  });
}

function readEnvironment(segment: string, project: string, env = 'development') {
  return f.call<Body>(
    environmentRoute.GET,
    'GET',
    `/api/orgs/${segment}/projects/${project}/environments/${env}`,
    { orgSlug: segment, projectSlug: project, envSlug: env },
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

describe('an organisation addressed by id', () => {
  it('is the same organisation as the one its legacy slug names, and says what its id is', async () => {
    const { org } = await setup();

    const byId = await readOrg(org.orgId);
    const bySlug = await readOrg(org.slug);

    expect(byId.status).toBe(200);
    expect(bySlug.status).toBe(200);
    expect(byId.body.organization).toMatchObject({ id: org.orgId, slug: org.slug });
    expect(bySlug.body.organization).toEqual(byId.body.organization);
  });

  it('reaches every route beneath it, as the dashboard calls them', async () => {
    const { org, projectId } = await setup();

    const listing = await listProjects(org.orgId);
    expect(listing.status).toBe(200);
    expect(listing.body.projects).toEqual([
      expect.objectContaining({ id: projectId, slug: 'api' }),
    ]);

    // By the project's id, as the dashboard does, and by its Project ID, as the
    // CLI does: both under the organisation's id, and under its legacy slug.
    for (const segment of [org.orgId, org.slug]) {
      for (const project of [projectId, 'api']) {
        const answer = await readEnvironment(segment, project);
        expect(answer.status, `${segment}/${project}`).toBe(200);
        expect(answer.body.environment).toMatchObject({ slug: 'development' });
      }
    }
  });

  it('is not found to somebody who is not a member, by either spelling, with one body', async () => {
    const { org } = await setup();
    const stranger = await f.seedOrg('free');
    caller = f.sessionOf(stranger.owner);

    const byId = await readOrg(org.orgId);
    const bySlug = await readOrg(org.slug);
    const nothing = await readOrg(uuidv7());

    for (const answer of [byId, bySlug, nothing]) {
      expect(answer.status).toBe(404);
      expect(answer.body.error?.message).toBe(nothing.body.error?.message);
    }
  });

  it('reads an uppercase id as a slug, which names nothing', async () => {
    const { org } = await setup();
    expect((await readOrg(org.orgId.toUpperCase())).status).toBe(404);
  });
});

describe('a service token, which is pinned to one organisation', () => {
  it('reaches its own organisation by id or by slug, and no other by either', async () => {
    const { org, projectId, env } = await setup();
    const other = await f.seedOrg('free');
    const otherProject = await f.seedProject(other, 'api');
    await f.seedEnv(other, otherProject, 'development');
    // The owner is in both, so nothing but the token's pin decides the answer.
    await f.addMember(other.orgId, org.owner.id, 'owner');
    caller = await f.seedServiceToken(org, projectId, env);

    // Its own organisation resolves under either spelling and only then meets
    // the policy, which keeps an environment's metadata from a token: a 403.
    expect((await readEnvironment(org.orgId, projectId)).status).toBe(403);
    expect((await readEnvironment(org.slug, 'api')).status).toBe(403);
    // The other organisation is refused at the pin, as nothing, by either.
    const byId = await readEnvironment(other.orgId, otherProject);
    const bySlug = await readEnvironment(other.slug, 'api');
    expect(byId.status).toBe(404);
    expect(bySlug.status).toBe(404);
    expect(byId.body.error?.message).toBe(bySlug.body.error?.message);
  });
});

describe('deleting an organisation addressed by id', () => {
  function remove(org: Org, confirm: string | undefined) {
    return f.call<Body>(
      orgRoute.DELETE,
      'DELETE',
      `/api/orgs/${org.orgId}`,
      { orgSlug: org.orgId },
      confirm === undefined ? {} : { confirm },
    );
  }

  /** The name is what the settings page shows and asks to be typed back. */
  it('is confirmed by the organisation’s name, in any case', async () => {
    const { org } = await setup();

    expect((await remove(org, ' acme ')).status).toBe(204);
    expect((await readOrg(org.orgId)).status).toBe(404);
  });

  it('still takes the legacy slug, for a script written while it was the confirmation', async () => {
    const { org } = await setup();
    expect((await remove(org, org.slug)).status).toBe(204);
  });

  it('refuses anything else, and the organisation stays', async () => {
    const { org } = await setup();

    for (const confirm of [undefined, '', 'Acme Corp', org.orgId]) {
      expect((await remove(org, confirm)).status, String(confirm)).toBe(400);
    }
    expect((await readOrg(org.orgId)).status).toBe(200);
  });
});

/**
 * A project's slug is its Project ID: what `--project`, `.xecret.yaml` and CI
 * configuration name it by. Chosen once, when the project is created, and
 * never changed, which the server enforces whatever the dashboard shows.
 */
describe('a project’s Project ID', () => {
  function patchProject(org: Org, project: string, body: unknown) {
    return f.call<Body>(
      projectRoute.PATCH,
      'PATCH',
      `/api/orgs/${org.orgId}/projects/${project}`,
      { orgSlug: org.orgId, projectSlug: project },
      body,
    );
  }

  it('cannot be changed after the project is created, by either spelling of the project', async () => {
    const { org, projectId } = await setup();

    for (const project of [projectId, 'api']) {
      const refused = await patchProject(org, project, { slug: 'renamed' });
      expect(refused.status, project).toBe(400);
      expect(refused.body.error?.message).toContain('Project ID');
    }
    // Not even beside a change that is allowed: the whole request is refused.
    expect(
      (await patchProject(org, projectId, { name: 'Payments', slug: 'payments' })).status,
    ).toBe(400);

    const after = await listProjects(org.orgId);
    expect(after.body.projects).toEqual([expect.objectContaining({ id: projectId, slug: 'api' })]);
  });

  it('stays as it was through a rename', async () => {
    const { org, projectId } = await setup();

    const renamed = await patchProject(org, projectId, { name: 'Payments API' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.project).toMatchObject({
      id: projectId,
      name: 'Payments API',
      slug: 'api',
    });
  });
});

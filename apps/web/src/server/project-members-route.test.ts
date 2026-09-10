import { beforeEach, describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '@xecret/core/ids';
import { createLogger } from './logging';
import type { RequestLog } from './logging';

/**
 * The one route that answers "who can reach this project?".
 *
 * ── Why the handler is invoked for real ──
 * `routes.test.ts` says plainly that handlers are not invoked there, because
 * everything they decide is decided by a schema or a service that can be tested
 * directly. This endpoint is the exception for the same reason
 * `key-route-guards.test.ts` is: what it gets right or wrong is *wiring* — which
 * capability it gates on, and whether the levels it reports are the levels the
 * authorization engine would enforce. A test of `effectiveAccess` alone would
 * pass whether or not this route ever called it, and a route that gated on
 * `member.read` instead of `member.update` would hand the organisation's whole
 * grant topology to any developer who guessed the URL.
 *
 * ── What is stubbed, and what deliberately is not ──
 * Only the database is stubbed, at the repository boundary. `tenancy.ts` runs
 * for real, so the 404 comes from the same `findProjectBySlug` miss a real
 * unknown slug produces, and the 403 comes from the real `assertCan` reading a
 * real role table — not from a mock that agrees with the test author. The
 * levels in the 200 are computed by the real `resolveAccessLevel`.
 */

const context = vi.hoisted(() => ({
  workerContext: vi.fn(),
  createServiceContext: vi.fn(),
}));

const actor = vi.hoisted(() => ({
  authenticate: vi.fn(),
  assertCsrf: vi.fn(),
  isUnlocked: vi.fn(() => true),
  actorType: vi.fn(() => 'user' as const),
  actorId: vi.fn(() => 'actor-id'),
  actorLabel: vi.fn(() => 'nitheesh@playxoft.com'),
}));

const auditSink = vi.hoisted(() => ({ write: vi.fn() }));
const logging = vi.hoisted(() => ({ createRequestLog: vi.fn() }));

const repositories = vi.hoisted(() => ({
  findOrganizationBySlug: vi.fn(),
  loadAuthorizationContext: vi.fn(),
  findProjectBySlug: vi.fn(),
  listMembers: vi.fn(),
  listGrantsForOrganization: vi.fn(),
  listEnvironments: vi.fn(),
}));

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
vi.mock('@xecret/db/repositories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xecret/db/repositories')>()),
  ...repositories,
}));

const { GET: readProjectMembers } =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/members/route');

const ORG_ID = uuidv7();
const PROJECT_ID = uuidv7();
const OTHER_PROJECT_ID = uuidv7();
const STAGING_ID = uuidv7();
const PRODUCTION_ID = uuidv7();
const OWNER_USER_ID = uuidv7();
const OWNER_MEMBER_ID = uuidv7();
const DEVELOPER_USER_ID = uuidv7();
const DEVELOPER_MEMBER_ID = uuidv7();

const deferred: Promise<unknown>[] = [];
const runtimeDeferred: Promise<unknown>[] = [];

const EPOCH = new Date('2026-01-01T00:00:00.000Z');

function principalFor(userId: string) {
  return {
    kind: 'user' as const,
    vaultUnlockedAt: new Date(),
    sessionId: uuidv7(),
    user: {
      id: userId,
      email: userId === OWNER_USER_ID ? 'owner@playxoft.com' : 'dev@playxoft.com',
      emailVerified: true,
      displayName: null,
      avatarUrl: null,
    },
  };
}

/** A member row as `listMembers` returns one. */
function member(params: {
  id: string;
  userId: string;
  email: string;
  role: 'owner' | 'admin' | 'developer' | 'viewer';
  status?: 'active' | 'suspended';
}) {
  return {
    id: params.id,
    orgId: ORG_ID,
    userId: params.userId,
    role: params.role,
    status: params.status ?? ('active' as const),
    seatAssigned: true,
    createdAt: EPOCH,
    user: { id: params.userId, email: params.email, displayName: null, avatarUrl: null },
  };
}

/** An environment row as `listEnvironments` returns one. */
function environment(params: { id: string; name: string; slug: string; isProduction: boolean }) {
  return {
    id: params.id,
    projectId: PROJECT_ID,
    name: params.name,
    slug: params.slug,
    isProduction: params.isProduction,
    encryptionMode: 'e2ee',
    sortOrder: params.isProduction ? 1 : 0,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    deletedAt: null,
  };
}

function request(): Request {
  return new Request('https://xecret.playxoft.com/api/orgs/acme/projects/api/members', {
    method: 'GET',
  });
}

/** Next.js hands dynamic segments in as a promise; the wrapper awaits it. */
function params(overrides: Partial<{ orgSlug: string; projectSlug: string }> = {}) {
  return { params: Promise.resolve({ orgSlug: 'acme', projectSlug: 'api', ...overrides }) };
}

function silentLog(base: Record<string, unknown> = {}): RequestLog {
  return createLogger({
    sink: { write: () => {}, flush: () => Promise.resolve() },
    minimum: 'error',
    base,
  });
}

interface MemberRow {
  id: string;
  email: string;
  role: string;
  isYou: boolean;
  grants: { environmentSlug: string | null; accessLevel: string }[];
  environments: { slug: string; level: string; source: string }[];
}

interface Body {
  project: { name: string; slug: string };
  environments: { slug: string }[];
  members: MemberRow[];
  hasMore: boolean;
}

beforeEach(() => {
  vi.clearAllMocks();
  deferred.length = 0;
  runtimeDeferred.length = 0;

  auditSink.write.mockResolvedValue(undefined);
  logging.createRequestLog.mockImplementation((_env: unknown, base: Record<string, unknown>) =>
    silentLog(base),
  );

  context.workerContext.mockResolvedValue({
    env: {},
    ctx: { waitUntil: (promise: Promise<unknown>) => void runtimeDeferred.push(promise) },
  });
  context.createServiceContext.mockImplementation(
    async (
      _request: Request,
      _worker: unknown,
      requestId: string,
      log: RequestLog,
      startedAt: number,
    ) => ({
      env: { XECRET_PUBLIC_URL: 'https://xecret.playxoft.com', XECRET_ENV: 'production' },
      db: {},
      envelope: {},
      meta: {
        requestId,
        rayId: null,
        ipAddress: '203.0.113.5',
        userAgent: 'vitest',
        method: 'GET',
        path: '/api/test',
        startedAt,
      },
      log: log.logger,
      bindLog: log.bind,
      waitUntil: (promise: Promise<unknown>) => void deferred.push(promise),
      settled: () => Promise.allSettled(deferred),
      dispose: () => {},
    }),
  );

  actor.authenticate.mockResolvedValue({
    principal: principalFor(OWNER_USER_ID),
    source: 'cookie',
  });
  actor.assertCsrf.mockReturnValue(undefined);
  actor.isUnlocked.mockReturnValue(true);
  actor.actorId.mockReturnValue(OWNER_USER_ID);

  repositories.findOrganizationBySlug.mockResolvedValue({
    id: ORG_ID,
    name: 'Acme',
    slug: 'acme',
    seatLimit: 5,
    createdBy: OWNER_USER_ID,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    deletedAt: null,
  });

  // The *caller's* membership, which `authorize` reads. Owner by default.
  repositories.loadAuthorizationContext.mockResolvedValue({
    orgId: ORG_ID,
    userId: OWNER_USER_ID,
    memberId: OWNER_MEMBER_ID,
    role: 'owner',
    status: 'active',
    grants: [],
  });

  repositories.findProjectBySlug.mockResolvedValue({
    id: PROJECT_ID,
    orgId: ORG_ID,
    name: 'API',
    slug: 'api',
    description: null,
    createdBy: OWNER_USER_ID,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    deletedAt: null,
  });

  repositories.listMembers.mockResolvedValue({
    members: [
      member({
        id: OWNER_MEMBER_ID,
        userId: OWNER_USER_ID,
        email: 'owner@playxoft.com',
        role: 'owner',
      }),
      member({
        id: DEVELOPER_MEMBER_ID,
        userId: DEVELOPER_USER_ID,
        email: 'dev@playxoft.com',
        role: 'developer',
      }),
    ],
    page: 1,
    pageSize: 200,
    hasMore: false,
  });

  repositories.listGrantsForOrganization.mockResolvedValue([
    // The developer's written grant on production, which overrides the role
    // default their role would otherwise give them there.
    {
      id: uuidv7(),
      memberId: DEVELOPER_MEMBER_ID,
      projectId: PROJECT_ID,
      environmentId: PRODUCTION_ID,
      accessLevel: 'read',
    },
    // A grant on a different project entirely. It must not reach the response:
    // this endpoint answers for one project, and leaking the rest of the grant
    // topology through the project dialog is exactly what it must not do.
    {
      id: uuidv7(),
      memberId: DEVELOPER_MEMBER_ID,
      projectId: OTHER_PROJECT_ID,
      environmentId: null,
      accessLevel: 'admin',
    },
  ]);

  repositories.listEnvironments.mockResolvedValue([
    environment({ id: STAGING_ID, name: 'Staging', slug: 'staging', isProduction: false }),
    environment({ id: PRODUCTION_ID, name: 'Production', slug: 'production', isProduction: true }),
  ]);
});

describe('GET /api/orgs/{orgSlug}/projects/{projectSlug}/members', () => {
  it('answers with every member and the level each one holds in each environment', async () => {
    const response = await readProjectMembers(request(), params());
    const body = (await response.json()) as Body;

    expect(response.status).toBe(200);
    expect(body.project).toEqual({ name: 'API', slug: 'api' });
    expect(body.environments.map((environment) => environment.slug)).toEqual([
      'staging',
      'production',
    ]);
    expect(body.members.map((member) => member.email)).toEqual([
      'owner@playxoft.com',
      'dev@playxoft.com',
    ]);
  });

  it('resolves levels through the engine, so a written grant beats the role default', async () => {
    const response = await readProjectMembers(request(), params());
    const { members } = (await response.json()) as Body;

    const owner = members.find((member) => member.email === 'owner@playxoft.com');
    const developer = members.find((member) => member.email === 'dev@playxoft.com');

    // The owner reaches everything by role, with nothing written down.
    expect(owner?.environments).toEqual([
      {
        name: 'Staging',
        slug: 'staging',
        isProduction: false,
        level: 'admin',
        source: 'role-default',
      },
      {
        name: 'Production',
        slug: 'production',
        isProduction: true,
        level: 'admin',
        source: 'role-default',
      },
    ]);
    expect(owner?.grants).toEqual([]);
    // The viewer sees themselves flagged, which is what stops the dialog
    // offering them a control that would lock them out of their own project.
    expect(owner?.isYou).toBe(true);
    expect(developer?.isYou).toBe(false);

    // The developer's role gives them `write` on a non-production environment
    // and nothing on production; the written grant lifts production to `read`.
    expect(
      developer?.environments.map((environment) => [
        environment.slug,
        environment.level,
        environment.source,
      ]),
    ).toEqual([
      ['staging', 'write', 'role-default'],
      ['production', 'read', 'environment-grant'],
    ]);
  });

  it('returns only this project’s grant rows, not the whole organisation’s', async () => {
    const response = await readProjectMembers(request(), params());
    const { members } = (await response.json()) as Body;

    const developer = members.find((member) => member.email === 'dev@playxoft.com');

    // The `admin` grant on the other project is in the same query result and is
    // dropped here. A dialog that showed it would be describing access its own
    // controls cannot change.
    expect(developer?.grants).toEqual([{ environmentSlug: 'production', accessLevel: 'read' }]);
  });

  it('says when the single page it reads is not the whole organisation', async () => {
    // This endpoint does not paginate — one page at the repository's ceiling —
    // so dropping `hasMore` presented a truncated roster as the complete answer,
    // and the dialog would have shown "nobody else has access" to an
    // organisation whose 201st member is an admin on production.
    repositories.listMembers.mockResolvedValue({
      members: [
        member({
          id: OWNER_MEMBER_ID,
          userId: OWNER_USER_ID,
          email: 'owner@playxoft.com',
          role: 'owner',
        }),
      ],
      page: 1,
      pageSize: 200,
      hasMore: true,
    });

    const response = await readProjectMembers(request(), params());
    const body = (await response.json()) as Body;

    expect(body.hasMore).toBe(true);
  });

  it('reports a complete roster as complete', async () => {
    const response = await readProjectMembers(request(), params());
    const body = (await response.json()) as Body;

    expect(body.hasMore).toBe(false);
  });

  it('refuses a caller who may read members but not change their access', async () => {
    // `member.update`, not `member.read`. This response *is* the grant topology
    // of the organisation, sliced by project instead of by person — the same map
    // the per-member access endpoint refuses to anyone who cannot rewrite it.
    actor.authenticate.mockResolvedValue({
      principal: principalFor(DEVELOPER_USER_ID),
      source: 'cookie',
    });
    actor.actorId.mockReturnValue(DEVELOPER_USER_ID);
    repositories.loadAuthorizationContext.mockResolvedValue({
      orgId: ORG_ID,
      userId: DEVELOPER_USER_ID,
      memberId: DEVELOPER_MEMBER_ID,
      role: 'developer',
      status: 'active',
      grants: [],
    });

    const response = await readProjectMembers(request(), params());

    expect(response.status).toBe(403);
    // Refused before the roster is read, so a denial costs nothing and discloses
    // nothing — not even how many members the organisation has.
    expect(repositories.listMembers).not.toHaveBeenCalled();
    expect(repositories.listGrantsForOrganization).not.toHaveBeenCalled();
  });

  it('answers 404 for a project slug that is not in this organisation', async () => {
    repositories.findProjectBySlug.mockResolvedValue(undefined);

    const response = await readProjectMembers(request(), params({ projectSlug: 'ghost' }));
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(404);
    expect(body.error).toMatchObject({ code: 'not_found', message: 'Not found.' });
    // Nothing about the organisation leaks through the miss.
    expect(body.error.message).not.toContain('ghost');
    expect(repositories.listMembers).not.toHaveBeenCalled();
  });
});

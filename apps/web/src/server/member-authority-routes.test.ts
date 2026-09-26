import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditRecord } from '@xecret/core/audit';
import type { Action, CustomRole } from '@xecret/core/authz';
import { ROLE_CAPABILITIES } from '@xecret/core/authz';
import { uuidv7 } from '@xecret/core/ids';
import { createLogger } from './logging';
import type { RequestLog } from './logging';

/**
 * You can't hand out what you don't hold — at the four doors authority leaves
 * by: an invitation, a role change, an explicit grant, and a service token.
 *
 * ── Why the handlers are invoked for real ──
 * The predicates are tested where they are pure (`members.test.ts`, and
 * `custom-roles.test.ts` in core). What can only be tested here is that each
 * route *asks* them — with the caller's whole membership, against the right
 * environment, before anything is written. A route that measured the caller by
 * rank, or skipped the level check on a project-wide grant, would pass every
 * pure test and still let a narrowed admin mint a colleague with the authority
 * their own role withholds.
 *
 * ── What is stubbed, and what deliberately is not ──
 * Only the database, at the repository boundary, and the key reconciliation
 * that follows a grant or role change. `tenancy.ts` runs for real, so each
 * refusal comes from the real `can()` or the real `resolveAccessLevel` reading
 * the membership the stub returns.
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
const rateLimit = vi.hoisted(() => ({ enforce: vi.fn() }));
const memberKeys = vi.hoisted(() => ({
  reconcileMemberKeyAccess: vi.fn(),
  recordKeyReconciliation: vi.fn(),
}));

const repositories = vi.hoisted(() => ({
  findOrganizationBySlugWithEntitlements: vi.fn(),
  loadAuthorizationContext: vi.fn(),
  findMemberWithUser: vi.fn(),
  findProjectBySlug: vi.fn(),
  findEnvironmentBySlug: vi.fn(),
  listEnvironments: vi.fn(),
  listEnvironmentsForOrganization: vi.fn(),
  listGrantsForMember: vi.fn(),
  upsertAccessGrant: vi.fn(),
  updateMemberRole: vi.fn(),
  createInvitation: vi.fn(),
  setInvitationPublicKey: vi.fn(),
  createServiceToken: vi.fn(),
  removeAccessGrant: vi.fn(),
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
vi.mock('./rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rate-limit')>()),
  ...rateLimit,
}));
vi.mock('./member-keys', () => memberKeys);
vi.mock('@xecret/db/repositories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xecret/db/repositories')>()),
  ...repositories,
}));

const { POST: inviteRoute } = await import('@/app/api/orgs/[orgSlug]/members/route');
const { PATCH: patchMemberRoute } =
  await import('@/app/api/orgs/[orgSlug]/members/[memberId]/route');
const { PUT: putGrantRoute, DELETE: deleteGrantRoute } =
  await import('@/app/api/orgs/[orgSlug]/members/[memberId]/grants/route');
const { POST: mintServiceTokenRoute } =
  await import('@/app/api/orgs/[orgSlug]/tokens/service/route');

const ORG_ID = uuidv7();
const PROJECT_ID = uuidv7();
const STAGING_ID = uuidv7();
const PRODUCTION_ID = uuidv7();
const ACTOR_USER_ID = uuidv7();
const ACTOR_MEMBER_ID = uuidv7();
const TARGET_USER_ID = uuidv7();
const TARGET_MEMBER_ID = uuidv7();

const EPOCH = new Date('2026-01-01T00:00:00.000Z');
const ALL_ACTIONS = Object.keys(ROLE_CAPABILITIES.owner) as Action[];

const deferred: Promise<unknown>[] = [];
const runtimeDeferred: Promise<unknown>[] = [];

/* ── Callers ──────────────────────────────────────────────────────────────── */

type Role = 'owner' | 'admin' | 'developer' | 'viewer';
type Level = 'none' | 'read' | 'write' | 'admin';

interface Caller {
  role: Role;
  customRole?: CustomRole;
  grants?: { projectId: string; environmentId: string | null; accessLevel: Level }[];
}

function customRole(over: Partial<CustomRole>): CustomRole {
  return {
    id: uuidv7(),
    name: 'Narrowed',
    baseRole: 'admin',
    allowedActions: ALL_ACTIONS,
    ...over,
  };
}

/** An admin in every respect but one: `none` on production, whatever is written. */
const PRODUCTION_CAPPED: Caller = {
  role: 'admin',
  customRole: customRole({
    name: 'Admin, no production',
    accessCeiling: { nonProduction: 'admin', production: 'none' },
  }),
};

/** An admin-based role that may manage members and do nothing else. */
const MEMBER_MANAGER: Caller = {
  role: 'admin',
  customRole: customRole({
    name: 'Member manager',
    allowedActions: ['member.read', 'member.invite', 'member.update', 'member.remove'],
  }),
};

/**
 * A plain admin whom an owner has restricted to `read` on production with an
 * explicit grant. No custom role anywhere — the universal half of the rule.
 */
const RESTRICTED_ADMIN: Caller = {
  role: 'admin',
  grants: [{ projectId: PROJECT_ID, environmentId: PRODUCTION_ID, accessLevel: 'read' }],
};

function callerIs(caller: Caller): void {
  repositories.loadAuthorizationContext.mockResolvedValue({
    orgId: ORG_ID,
    userId: ACTOR_USER_ID,
    memberId: ACTOR_MEMBER_ID,
    role: caller.role,
    status: 'active',
    ...(caller.customRole === undefined ? {} : { customRole: caller.customRole }),
    grants: (caller.grants ?? []).map((grant) => ({ id: uuidv7(), ...grant })),
  });
}

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

const project = {
  id: PROJECT_ID,
  orgId: ORG_ID,
  name: 'API',
  slug: 'api',
  description: null,
  createdBy: ACTOR_USER_ID,
  createdAt: EPOCH,
  updatedAt: EPOCH,
  deletedAt: null,
};

function environmentRow(id: string, slug: string, isProduction: boolean) {
  return {
    id,
    projectId: PROJECT_ID,
    name: slug,
    slug,
    isProduction,
    // `server`, so a service token needs no keypair and the tests stay about
    // authority rather than key custody.
    encryptionMode: 'server',
    sortOrder: isProduction ? 1 : 0,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    deletedAt: null,
  };
}

const staging = environmentRow(STAGING_ID, 'staging', false);
const production = environmentRow(PRODUCTION_ID, 'production', true);

function target(role: Role, held?: CustomRole) {
  return {
    id: TARGET_MEMBER_ID,
    orgId: ORG_ID,
    userId: TARGET_USER_ID,
    role,
    status: 'active' as const,
    ...(held === undefined ? {} : { customRole: held }),
    seatAssigned: true,
    createdAt: EPOCH,
    user: {
      id: TARGET_USER_ID,
      email: 'dev@playxoft.com',
      displayName: null,
      avatarUrl: null,
    },
  };
}

/** The caller's own member record, for the routes that refuse self-service. */
function self(role: Role) {
  return {
    ...target(role),
    id: ACTOR_MEMBER_ID,
    userId: ACTOR_USER_ID,
    user: {
      id: ACTOR_USER_ID,
      email: 'admin@playxoft.com',
      displayName: null,
      avatarUrl: null,
    },
  };
}

/** A grant row as `listGrantsForMember` returns one. */
function grantRow(environmentId: string | null, accessLevel: Level) {
  return { id: uuidv7(), projectId: PROJECT_ID, environmentId, accessLevel };
}

function silentLog(base: Record<string, unknown> = {}): RequestLog {
  return createLogger({
    sink: { write: () => {}, flush: () => Promise.resolve() },
    minimum: 'error',
    base,
  });
}

/** Every audit record the request queued, once its deferred work has run. */
async function recorded(): Promise<AuditRecord[]> {
  await Promise.allSettled(deferred);
  await Promise.allSettled(runtimeDeferred);
  return auditSink.write.mock.calls.flatMap((call) => (call[0] ?? []) as AuditRecord[]);
}

function jsonRequest(method: string, path: string, body: unknown): Request {
  return new Request(`https://xecret.playxoft.com${path}`, {
    method,
    headers: { origin: 'https://xecret.playxoft.com', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function errorOf(response: Response): Promise<{ code: string; message: string }> {
  return ((await response.json()) as { error: { code: string; message: string } }).error;
}

beforeEach(() => {
  vi.clearAllMocks();
  deferred.length = 0;
  runtimeDeferred.length = 0;

  auditSink.write.mockResolvedValue(undefined);
  logging.createRequestLog.mockImplementation((_env: unknown, base: Record<string, unknown>) =>
    silentLog(base),
  );
  rateLimit.enforce.mockResolvedValue({ allowed: true, enforced: true });
  memberKeys.reconcileMemberKeyAccess.mockResolvedValue({ revoked: [], queued: [] });
  memberKeys.recordKeyReconciliation.mockReturnValue(undefined);

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
        method: 'POST',
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
    principal: {
      kind: 'user' as const,
      vaultUnlockedAt: new Date(),
      lastSeenAt: new Date(),
      vaultAutoLockMinutes: null,
      sessionId: uuidv7(),
      user: {
        id: ACTOR_USER_ID,
        email: 'admin@playxoft.com',
        emailVerified: true,
        displayName: null,
        avatarUrl: null,
      },
    },
    source: 'cookie',
  });
  actor.assertCsrf.mockReturnValue(undefined);
  actor.isUnlocked.mockReturnValue(true);
  actor.actorId.mockReturnValue(ACTOR_USER_ID);

  repositories.findOrganizationBySlugWithEntitlements.mockResolvedValue({
    entitlements: null,
    organization: {
      id: ORG_ID,
      name: 'Acme',
      slug: 'acme',
      seatLimit: 5,
      createdBy: ACTOR_USER_ID,
      createdAt: EPOCH,
      updatedAt: EPOCH,
      deletedAt: null,
    },
  });
  callerIs({ role: 'owner' });

  repositories.findMemberWithUser.mockResolvedValue(target('developer'));
  repositories.findProjectBySlug.mockResolvedValue(project);
  repositories.findEnvironmentBySlug.mockImplementation(
    async (_db: unknown, _orgId: string, _projectId: string, slug: string) =>
      slug === 'staging' ? staging : slug === 'production' ? production : undefined,
  );
  repositories.listEnvironments.mockResolvedValue([staging, production]);
  repositories.listEnvironmentsForOrganization.mockResolvedValue([
    { ...staging, project: { id: PROJECT_ID, name: 'API', slug: 'api' } },
    { ...production, project: { id: PROJECT_ID, name: 'API', slug: 'api' } },
  ]);
  repositories.listGrantsForMember.mockResolvedValue([]);
  repositories.removeAccessGrant.mockResolvedValue(true);
  repositories.upsertAccessGrant.mockImplementation(
    async (_db: unknown, params: { accessLevel: Level }) => ({
      id: uuidv7(),
      accessLevel: params.accessLevel,
    }),
  );
  repositories.updateMemberRole.mockImplementation(
    async (_db: unknown, params: { role: Role }) => ({
      id: TARGET_MEMBER_ID,
      orgId: ORG_ID,
      userId: TARGET_USER_ID,
      role: params.role,
      status: 'active',
    }),
  );
  repositories.createInvitation.mockImplementation(
    async (_db: unknown, params: { email: string; role: Role }) => ({
      token: 'invitation-token',
      invitation: {
        id: uuidv7(),
        orgId: ORG_ID,
        email: params.email,
        role: params.role,
        invitedBy: ACTOR_USER_ID,
        initialGrants: null,
        acceptedAt: null,
        acceptedBy: null,
        revokedAt: null,
        createdAt: EPOCH,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    }),
  );
  repositories.createServiceToken.mockImplementation(
    async (_db: unknown, params: { name: string; accessLevel: Level }) => ({
      token: 'xst_secret',
      record: {
        id: uuidv7(),
        name: params.name,
        tokenPrefix: 'xst_abcd',
        projectId: PROJECT_ID,
        environmentId: STAGING_ID,
        accessLevel: params.accessLevel,
        ipAllowlist: null,
        createdAt: EPOCH,
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
      },
    }),
  );
});

/* ── Invitations ──────────────────────────────────────────────────────────── */

describe('POST /members — an invitation confers no more than the inviter holds', () => {
  function invite(body: Record<string, unknown>): Promise<Response> {
    return inviteRoute(jsonRequest('POST', '/api/orgs/acme/members', body), {
      params: Promise.resolve({ orgSlug: 'acme' }),
    });
  }

  it('refuses a member manager inviting a plain admin — the alt-account escalation', async () => {
    callerIs(MEMBER_MANAGER);

    const response = await invite({ email: 'alt@example.com', role: 'admin' });

    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe('forbidden');
    expect(repositories.createInvitation).not.toHaveBeenCalled();
  });

  it('refuses a production-capped admin inviting an admin, who defaults to production', async () => {
    callerIs(PRODUCTION_CAPPED);

    const response = await invite({ email: 'alt@example.com', role: 'admin' });

    expect(response.status).toBe(403);
    expect(repositories.createInvitation).not.toHaveBeenCalled();
  });

  it('refuses initial grants above the inviter’s own level on production', async () => {
    callerIs(PRODUCTION_CAPPED);

    const response = await invite({
      email: 'alt@example.com',
      role: 'developer',
      grants: [{ projectSlug: 'api', environmentSlug: 'production', accessLevel: 'write' }],
    });

    expect(response.status).toBe(403);
    expect(await errorOf(response)).toMatchObject({
      code: 'forbidden',
      message: 'You cannot grant more access than you hold.',
    });
    expect(repositories.createInvitation).not.toHaveBeenCalled();
  });

  it('measures a seed that names no level at the level acceptance will write', async () => {
    // Acceptance writes the invited role's *non-production* default — `write`
    // for a developer — even on a production environment.
    callerIs(PRODUCTION_CAPPED);

    const response = await invite({
      email: 'alt@example.com',
      role: 'developer',
      grants: [{ projectSlug: 'api', environmentSlug: 'production' }],
    });

    expect(response.status).toBe(403);
    expect(repositories.createInvitation).not.toHaveBeenCalled();
  });

  it('refuses a project-wide seed that would land on the project’s production', async () => {
    callerIs(PRODUCTION_CAPPED);

    const response = await invite({
      email: 'alt@example.com',
      role: 'developer',
      grants: [{ projectSlug: 'api', environmentSlug: null, accessLevel: 'write' }],
    });

    expect(response.status).toBe(403);
    expect(repositories.createInvitation).not.toHaveBeenCalled();
  });

  it('lets the same inviter hand out what they do hold', async () => {
    callerIs(PRODUCTION_CAPPED);

    const response = await invite({
      email: 'alt@example.com',
      role: 'developer',
      grants: [
        { projectSlug: 'api', environmentSlug: 'staging', accessLevel: 'write' },
        { projectSlug: 'api', environmentSlug: 'production', accessLevel: 'none' },
      ],
    });

    expect(response.status).toBe(201);
    expect(repositories.createInvitation).toHaveBeenCalledOnce();
  });

  it('refuses a plain admin restricted by an explicit grant — the rule is universal', async () => {
    callerIs(RESTRICTED_ADMIN);

    const refused = await invite({
      email: 'alt@example.com',
      role: 'developer',
      grants: [{ projectSlug: 'api', environmentSlug: 'production', accessLevel: 'write' }],
    });
    const permitted = await invite({
      email: 'alt@example.com',
      role: 'developer',
      grants: [{ projectSlug: 'api', environmentSlug: 'production', accessLevel: 'read' }],
    });

    expect(refused.status).toBe(403);
    expect(permitted.status).toBe(201);
  });

  it('changes nothing for an owner', async () => {
    const response = await invite({
      email: 'alt@example.com',
      role: 'admin',
      grants: [{ projectSlug: 'api', environmentSlug: null, accessLevel: 'admin' }],
    });

    expect(response.status).toBe(201);
  });
});

/* ── Role changes ─────────────────────────────────────────────────────────── */

describe('PATCH /members/{id} — a role change confers no more than the caller holds', () => {
  function patch(body: Record<string, unknown>): Promise<Response> {
    return patchMemberRoute(
      jsonRequest('PATCH', `/api/orgs/acme/members/${TARGET_MEMBER_ID}`, body),
      { params: Promise.resolve({ orgSlug: 'acme', memberId: TARGET_MEMBER_ID }) },
    );
  }

  it('refuses a production-capped admin promoting a developer to admin', async () => {
    // The developer is within the caller's authority — the *new* role is not.
    callerIs(PRODUCTION_CAPPED);

    const response = await patch({ role: 'admin' });

    expect(response.status).toBe(403);
    expect(repositories.updateMemberRole).not.toHaveBeenCalled();
  });

  it('refuses a member manager touching a developer at all', async () => {
    // The *current* role's side: a developer reads and writes secrets this
    // caller cannot, so managing them is conferring or removing authority the
    // caller does not hold.
    callerIs(MEMBER_MANAGER);

    const response = await patch({ role: 'viewer' });

    expect(response.status).toBe(403);
    expect(repositories.updateMemberRole).not.toHaveBeenCalled();
  });

  it('lets the production-capped admin make the change they do hold', async () => {
    callerIs(PRODUCTION_CAPPED);

    const response = await patch({ role: 'viewer' });

    expect(response.status).toBe(200);
    expect(repositories.updateMemberRole).toHaveBeenCalledOnce();
  });

  it('changes nothing for a plain admin, explicit restrictions and all', async () => {
    // Roles are measured by role: an explicit grant on the caller limits the
    // grants they write, not whom they may appoint.
    callerIs(RESTRICTED_ADMIN);

    const response = await patch({ role: 'admin' });

    expect(response.status).toBe(200);
  });
});

describe('PATCH /members/{id} — the custom role a promotion to owner drops', () => {
  const deployer = customRole({ name: 'Deployer', baseRole: 'developer' });

  function patch(body: Record<string, unknown>): Promise<Response> {
    return patchMemberRoute(
      jsonRequest('PATCH', `/api/orgs/acme/members/${TARGET_MEMBER_ID}`, body),
      { params: Promise.resolve({ orgSlug: 'acme', memberId: TARGET_MEMBER_ID }) },
    );
  }

  async function roleChange(): Promise<AuditRecord | undefined> {
    return (await recorded()).find((record) => record.action === 'member.role_changed');
  }

  it('names it in the audit record, since the repository clears it in the same write', async () => {
    repositories.findMemberWithUser.mockResolvedValue(target('developer', deployer));

    const response = await patch({ role: 'owner' });

    expect(response.status).toBe(200);
    expect((await roleChange())?.metadata).toMatchObject({
      previousRole: 'developer',
      newRole: 'owner',
      previousCustomRoleId: deployer.id,
      previousCustomRoleName: 'Deployer',
    });
  });

  it('says nothing of a custom role a change below owner keeps', async () => {
    repositories.findMemberWithUser.mockResolvedValue(target('developer', deployer));

    await patch({ role: 'admin' });

    const metadata = (await roleChange())?.metadata;
    expect(metadata).toMatchObject({ previousRole: 'developer', newRole: 'admin' });
    expect(metadata).not.toHaveProperty('previousCustomRoleId');
    expect(metadata).not.toHaveProperty('previousCustomRoleName');
  });

  it('says nothing for a member who held none', async () => {
    await patch({ role: 'owner' });

    expect((await roleChange())?.metadata).not.toHaveProperty('previousCustomRoleId');
  });
});

/* ── Explicit grants ──────────────────────────────────────────────────────── */

describe('PUT /members/{id}/grants — a grant confers no more than the caller holds', () => {
  function put(body: Record<string, unknown>): Promise<Response> {
    return putGrantRoute(
      jsonRequest('PUT', `/api/orgs/acme/members/${TARGET_MEMBER_ID}/grants`, body),
      { params: Promise.resolve({ orgSlug: 'acme', memberId: TARGET_MEMBER_ID }) },
    );
  }

  it('refuses a production grant from a caller capped at none on production', async () => {
    callerIs(PRODUCTION_CAPPED);

    const response = await put({
      projectSlug: 'api',
      environmentSlug: 'production',
      accessLevel: 'write',
    });

    expect(response.status).toBe(403);
    expect(await errorOf(response)).toMatchObject({
      code: 'forbidden',
      message: 'You cannot grant more access than you hold.',
    });
    expect(repositories.upsertAccessGrant).not.toHaveBeenCalled();
  });

  it('refuses a project-wide grant, which lands on production too', async () => {
    callerIs(PRODUCTION_CAPPED);

    const response = await put({ projectSlug: 'api', environmentSlug: null, accessLevel: 'read' });

    expect(response.status).toBe(403);
    expect(repositories.upsertAccessGrant).not.toHaveBeenCalled();
  });

  it('permits the same caller a grant where they hold the level', async () => {
    callerIs(PRODUCTION_CAPPED);

    const response = await put({
      projectSlug: 'api',
      environmentSlug: 'staging',
      accessLevel: 'admin',
    });

    expect(response.status).toBe(200);
    expect(repositories.upsertAccessGrant).toHaveBeenCalledOnce();
  });

  it('always permits none — taking access away confers nothing', async () => {
    callerIs(PRODUCTION_CAPPED);

    const response = await put({
      projectSlug: 'api',
      environmentSlug: 'production',
      accessLevel: 'none',
    });

    expect(response.status).toBe(200);
  });

  it('holds a plain admin to the level an explicit grant left them', async () => {
    callerIs(RESTRICTED_ADMIN);

    const above = await put({
      projectSlug: 'api',
      environmentSlug: 'production',
      accessLevel: 'write',
    });
    const at = await put({
      projectSlug: 'api',
      environmentSlug: 'production',
      accessLevel: 'read',
    });
    // A project-wide row reaches production, where this admin holds `read`.
    const projectWide = await put({
      projectSlug: 'api',
      environmentSlug: null,
      accessLevel: 'write',
    });

    expect(above.status).toBe(403);
    expect(at.status).toBe(200);
    expect(projectWide.status).toBe(403);
  });

  it('changes nothing for an owner', async () => {
    const environmentGrant = await put({
      projectSlug: 'api',
      environmentSlug: 'production',
      accessLevel: 'admin',
    });
    const projectGrant = await put({
      projectSlug: 'api',
      environmentSlug: null,
      accessLevel: 'admin',
    });

    expect(environmentGrant.status).toBe(200);
    expect(projectGrant.status).toBe(200);
  });
});

/* ── Service tokens ───────────────────────────────────────────────────────── */

describe('DELETE /members/{id}/grants — a removal confers no more than the caller holds', () => {
  function remove(body: Record<string, unknown>): Promise<Response> {
    return deleteGrantRoute(
      jsonRequest('DELETE', `/api/orgs/acme/members/${TARGET_MEMBER_ID}/grants`, body),
      { params: Promise.resolve({ orgSlug: 'acme', memberId: TARGET_MEMBER_ID }) },
    );
  }

  it('refuses deleting a production none that a project-wide write would replace', async () => {
    // The hole: the row removed is a denial, so deleting it looks like a
    // narrowing — but the developer falls back to the project-wide `write`,
    // on production, which this caller cannot hold.
    callerIs(PRODUCTION_CAPPED);
    repositories.listGrantsForMember.mockResolvedValue([
      grantRow(null, 'write'),
      grantRow(PRODUCTION_ID, 'none'),
    ]);

    const response = await remove({ projectSlug: 'api', environmentSlug: 'production' });

    expect(response.status).toBe(403);
    expect(await errorOf(response)).toMatchObject({
      code: 'forbidden',
      message: 'You cannot grant more access than you hold.',
    });
    expect(repositories.removeAccessGrant).not.toHaveBeenCalled();
  });

  it('refuses the same removal to a plain admin an explicit grant holds to read', async () => {
    callerIs(RESTRICTED_ADMIN);
    repositories.listGrantsForMember.mockResolvedValue([
      grantRow(null, 'write'),
      grantRow(PRODUCTION_ID, 'none'),
    ]);

    const response = await remove({ projectSlug: 'api', environmentSlug: 'production' });

    expect(response.status).toBe(403);
    expect(repositories.removeAccessGrant).not.toHaveBeenCalled();
  });

  it('permits a removal that lowers the member everywhere', async () => {
    // A project-wide `admin`, removed: the developer falls back to their role's
    // `write` and production `none`. Lower on every environment, including the
    // production this caller cannot reach.
    callerIs(PRODUCTION_CAPPED);
    repositories.listGrantsForMember.mockResolvedValue([grantRow(null, 'admin')]);

    const response = await remove({ projectSlug: 'api', environmentSlug: null });

    expect(response.status).toBe(204);
    expect(repositories.removeAccessGrant).toHaveBeenCalledOnce();
  });

  it('permits a removal that keeps the member where they were', async () => {
    // A developer's production default is `none` too, so nothing moves.
    callerIs(PRODUCTION_CAPPED);
    repositories.listGrantsForMember.mockResolvedValue([grantRow(PRODUCTION_ID, 'none')]);

    const response = await remove({ projectSlug: 'api', environmentSlug: 'production' });

    expect(response.status).toBe(204);
  });

  it('measures each raise where it happens, not against the lowest level anywhere', async () => {
    // A project-wide `read`, removed: staging rises to the developer's `write`
    // — which this caller holds there — and production stays at `none`. The
    // caller holds nothing on production, but the removal gives nothing there.
    callerIs(PRODUCTION_CAPPED);
    repositories.listGrantsForMember.mockResolvedValue([grantRow(null, 'read')]);

    const response = await remove({ projectSlug: 'api', environmentSlug: null });

    expect(response.status).toBe(204);
  });

  it('changes nothing for a plain admin removing a grant within their reach', async () => {
    // Staging rises from `read` to the developer's `write`, within the admin's
    // own `admin` — exactly as before this check existed.
    callerIs({ role: 'admin' });
    repositories.listGrantsForMember.mockResolvedValue([grantRow(STAGING_ID, 'read')]);

    const response = await remove({ projectSlug: 'api', environmentSlug: 'staging' });

    expect(response.status).toBe(204);
    expect(repositories.removeAccessGrant).toHaveBeenCalledOnce();
  });
});

describe('/members/{id}/grants on yourself — owners only', () => {
  function removeOwn(body: Record<string, unknown>): Promise<Response> {
    return deleteGrantRoute(
      jsonRequest('DELETE', `/api/orgs/acme/members/${ACTOR_MEMBER_ID}/grants`, body),
      { params: Promise.resolve({ orgSlug: 'acme', memberId: ACTOR_MEMBER_ID }) },
    );
  }

  function putOwn(body: Record<string, unknown>): Promise<Response> {
    return putGrantRoute(
      jsonRequest('PUT', `/api/orgs/acme/members/${ACTOR_MEMBER_ID}/grants`, body),
      { params: Promise.resolve({ orgSlug: 'acme', memberId: ACTOR_MEMBER_ID }) },
    );
  }

  it('refuses a restricted admin deleting their own restriction', async () => {
    // Without this, the admin an owner held to `read` on production deletes
    // the grant that says so and is an unrestricted admin again.
    callerIs(RESTRICTED_ADMIN);
    repositories.findMemberWithUser.mockResolvedValue(self('admin'));
    repositories.listGrantsForMember.mockResolvedValue([grantRow(PRODUCTION_ID, 'read')]);

    const response = await removeOwn({ projectSlug: 'api', environmentSlug: 'production' });

    expect(response.status).toBe(403);
    expect(await errorOf(response)).toMatchObject({
      code: 'forbidden',
      message: 'You cannot change your own access grants.',
    });
    expect(repositories.removeAccessGrant).not.toHaveBeenCalled();
  });

  it('refuses a restricted admin writing a wider grant over their own restriction', async () => {
    callerIs(RESTRICTED_ADMIN);
    repositories.findMemberWithUser.mockResolvedValue(self('admin'));

    const response = await putOwn({
      projectSlug: 'api',
      environmentSlug: 'production',
      accessLevel: 'read',
    });

    expect(response.status).toBe(403);
    expect(repositories.upsertAccessGrant).not.toHaveBeenCalled();
  });

  it('lets an owner delete a restriction they placed on themselves', async () => {
    // The escape hatch: a sole owner who could not lift their own production
    // `none` would need an owner who does not exist.
    callerIs({
      role: 'owner',
      grants: [{ projectId: PROJECT_ID, environmentId: PRODUCTION_ID, accessLevel: 'none' }],
    });
    repositories.findMemberWithUser.mockResolvedValue(self('owner'));
    repositories.listGrantsForMember.mockResolvedValue([grantRow(PRODUCTION_ID, 'none')]);

    const response = await removeOwn({ projectSlug: 'api', environmentSlug: 'production' });

    expect(response.status).toBe(204);
    expect(repositories.removeAccessGrant).toHaveBeenCalledOnce();
  });

  it('lets an owner widen their own grant past the restriction it replaces', async () => {
    callerIs({
      role: 'owner',
      grants: [{ projectId: PROJECT_ID, environmentId: PRODUCTION_ID, accessLevel: 'none' }],
    });
    repositories.findMemberWithUser.mockResolvedValue(self('owner'));

    const response = await putOwn({
      projectSlug: 'api',
      environmentSlug: 'production',
      accessLevel: 'admin',
    });

    expect(response.status).toBe(200);
  });
});

describe('POST /tokens/service — a token can do no more than its minter', () => {
  function mint(body: Record<string, unknown>): Promise<Response> {
    return mintServiceTokenRoute(
      jsonRequest('POST', '/api/orgs/acme/tokens/service', { name: 'deploy', ...body }),
      { params: Promise.resolve({ orgSlug: 'acme' }) },
    );
  }

  it('refuses a production token to a minter capped at none on production', async () => {
    callerIs(PRODUCTION_CAPPED);

    const response = await mint({ projectSlug: 'api', environmentSlug: 'production' });

    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe('forbidden');
    expect(repositories.createServiceToken).not.toHaveBeenCalled();

    // Filed as a denied mint, like the capability refusal before it.
    const denials = (await recorded()).filter(
      (record) => record.action === 'token.created' && record.outcome === 'denied',
    );
    expect(denials).toHaveLength(1);
  });

  it('permits the same minter a write token where they hold write', async () => {
    callerIs(PRODUCTION_CAPPED);

    const response = await mint({
      projectSlug: 'api',
      environmentSlug: 'staging',
      accessLevel: 'write',
    });

    expect(response.status).toBe(201);
    expect(repositories.createServiceToken).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ environmentId: STAGING_ID, accessLevel: 'write' }),
    );
  });

  it('refuses a write token to a minter whose custom role cannot write', async () => {
    // The capability half: the level is there, the action is not.
    callerIs({
      role: 'admin',
      customRole: customRole({
        name: 'Token issuer, read-only',
        allowedActions: ALL_ACTIONS.filter(
          (action) => action !== 'secret.update' && action !== 'secret.create',
        ),
      }),
    });

    const write = await mint({
      projectSlug: 'api',
      environmentSlug: 'staging',
      accessLevel: 'write',
    });
    const read = await mint({
      projectSlug: 'api',
      environmentSlug: 'staging',
      accessLevel: 'read',
    });

    expect(write.status).toBe(403);
    expect(read.status).toBe(201);
  });

  it('holds a plain admin to the level an explicit grant left them', async () => {
    callerIs(RESTRICTED_ADMIN);

    const write = await mint({
      projectSlug: 'api',
      environmentSlug: 'production',
      accessLevel: 'write',
    });
    const read = await mint({ projectSlug: 'api', environmentSlug: 'production' });

    expect(write.status).toBe(403);
    expect(read.status).toBe(201);
  });

  it('changes nothing for an owner', async () => {
    const response = await mint({
      projectSlug: 'api',
      environmentSlug: 'production',
      accessLevel: 'write',
    });

    expect(response.status).toBe(201);
  });
});

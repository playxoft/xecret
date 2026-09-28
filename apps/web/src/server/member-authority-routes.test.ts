import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditRecord } from '@xecret/core/audit';
import type { Action, CustomRole } from '@xecret/core/authz';
import { ROLE_CAPABILITIES } from '@xecret/core/authz';
import { uuidv7 } from '@xecret/core/ids';
import { createLogger } from './logging';
import type { RequestLog } from './logging';

/**
 * You can't hand out what you don't hold — at every door authority leaves by:
 * an invitation, a role change, a reinstatement, an explicit grant written or
 * removed, a service token, an environment reclassified as production, and a
 * project deleted around environments the caller could not delete.
 *
 * Every refusal here is also filed as exactly one `denied` audit record of the
 * change attempted — a caller probing past their authority leaves the same
 * trail as one probing past their role.
 *
 * ── Why the handlers are invoked for real ──
 * The predicates are tested where they are pure (`authority.test.ts` and
 * `custom-roles.test.ts` in core, the wrappers in `members.test.ts`). What can only be tested here is that each
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
  reinstateMember: vi.fn(),
  suspendMember: vi.fn(),
  removeMember: vi.fn(),
  updateEnvironment: vi.fn(),
  softDeleteProject: vi.fn(),
  createInvitation: vi.fn(),
  setInvitationPublicKey: vi.fn(),
  createServiceToken: vi.fn(),
  listServiceTokens: vi.fn(),
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
const { PATCH: patchMemberRoute, DELETE: removeMemberRoute } =
  await import('@/app/api/orgs/[orgSlug]/members/[memberId]/route');
const { PUT: putGrantRoute, DELETE: deleteGrantRoute } =
  await import('@/app/api/orgs/[orgSlug]/members/[memberId]/grants/route');
const { POST: mintServiceTokenRoute, GET: listServiceTokensRoute } =
  await import('@/app/api/orgs/[orgSlug]/tokens/service/route');
const { PATCH: patchEnvironmentRoute } =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]/route');
const { DELETE: deleteProjectRoute } =
  await import('@/app/api/orgs/[orgSlug]/projects/[projectSlug]/route');

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
    customRole: caller.customRole,
    grants: (caller.grants ?? []).map((grant) => ({ id: uuidv7(), ...grant })),
  });
}

/* ── The member writes, as the repository runs them ───────────────────────── */

type MemberWriteParams = { orgId: string; memberId: string };
type Guard = ((change: { member: unknown; grants: readonly unknown[] }) => void) | null;

/**
 * What a member write's guard is shown, when a test says so: the member and
 * their grants as the repository reads them under the organisation lock.
 * Unset, it is whoever `findMemberWithUser` answers with and whatever
 * `listGrantsForMember` holds — the route's own read, as it would be when
 * nothing raced it.
 */
let lockedAs: { member?: unknown; grants?: readonly unknown[] } = {};

/** Called with a write's name once its guard has let it through — "something was written". */
const written = vi.fn();

async function runGuard(params: MemberWriteParams, guard: Guard): Promise<void> {
  if (guard === null) return;
  const member =
    lockedAs.member ?? (await repositories.findMemberWithUser({}, params.orgId, params.memberId));
  const grants =
    lockedAs.grants ?? (await repositories.listGrantsForMember({}, params.orgId, params.memberId));
  guard({ member, grants });
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

function target(role: Role, held?: CustomRole, status: 'active' | 'suspended' = 'active') {
  return {
    id: TARGET_MEMBER_ID,
    orgId: ORG_ID,
    userId: TARGET_USER_ID,
    role,
    status,
    customRole: held,
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

/** The `denied` audit records the request filed, once its deferred work has run. */
async function denials(): Promise<AuditRecord[]> {
  return (await recorded()).filter((record) => record.outcome === 'denied');
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
  lockedAs = {};
  repositories.removeAccessGrant.mockImplementation(
    async (_db: unknown, params: MemberWriteParams, guard: Guard) => {
      await runGuard(params, guard);
      written('removeAccessGrant');
      return true;
    },
  );
  repositories.upsertAccessGrant.mockImplementation(
    async (_db: unknown, params: MemberWriteParams & { accessLevel: Level }, guard: Guard) => {
      await runGuard(params, guard);
      written('upsertAccessGrant');
      return { id: uuidv7(), accessLevel: params.accessLevel };
    },
  );
  repositories.updateMemberRole.mockImplementation(
    async (_db: unknown, params: MemberWriteParams & { role: Role }, guard: Guard) => {
      await runGuard(params, guard);
      written('updateMemberRole');
      return {
        id: TARGET_MEMBER_ID,
        orgId: ORG_ID,
        userId: TARGET_USER_ID,
        role: params.role,
        status: 'active',
        clearedCustomRole: null,
      };
    },
  );
  for (const [write, name, status] of [
    [repositories.reinstateMember, 'reinstateMember', 'active'],
    [repositories.suspendMember, 'suspendMember', 'suspended'],
  ] as const) {
    write.mockImplementation(async (_db: unknown, params: MemberWriteParams, guard: Guard) => {
      await runGuard(params, guard);
      written(name);
      return {
        id: TARGET_MEMBER_ID,
        orgId: ORG_ID,
        userId: TARGET_USER_ID,
        role: 'developer',
        status,
      };
    });
  }
  repositories.removeMember.mockImplementation(
    async (_db: unknown, params: MemberWriteParams, guard: Guard) => {
      await runGuard(params, guard);
      written('removeMember');
    },
  );
  repositories.updateEnvironment.mockImplementation(
    async (
      _db: unknown,
      _orgId: string,
      id: string,
      patch: { name?: string; isProduction?: boolean },
    ) => ({
      ...(id === PRODUCTION_ID ? production : staging),
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.isProduction === undefined ? {} : { isProduction: patch.isProduction }),
    }),
  );
  repositories.softDeleteProject.mockResolvedValue(project);
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
    expect(written).not.toHaveBeenCalled();
  });

  it('refuses a member manager touching a developer at all', async () => {
    // The *current* role's side: a developer reads and writes secrets this
    // caller cannot, so managing them is conferring or removing authority the
    // caller does not hold.
    callerIs(MEMBER_MANAGER);

    const response = await patch({ role: 'viewer' });

    expect(response.status).toBe(403);
    expect(written).not.toHaveBeenCalled();
  });

  it('lets the production-capped admin make the change they do hold', async () => {
    callerIs(PRODUCTION_CAPPED);

    const response = await patch({ role: 'viewer' });

    expect(response.status).toBe(200);
    expect(written).toHaveBeenCalledExactlyOnceWith('updateMemberRole');
  });

  it('changes nothing for a plain admin, explicit restrictions and all', async () => {
    // Roles are measured by role: an explicit grant on the caller limits the
    // grants they write, mint or unblock, not whom they may appoint — it
    // restricts this admin's own access and does not contain their management
    // authority. A custom role's ceiling does (the production-capped admin
    // above is refused this same promotion).
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

  /** The repository's answer for a promotion that cleared `cleared`. */
  function clearing(cleared: CustomRole): void {
    repositories.updateMemberRole.mockImplementation(
      async (_db: unknown, params: MemberWriteParams & { role: Role }, guard: Guard) => {
        await runGuard(params, guard);
        return {
          id: TARGET_MEMBER_ID,
          orgId: ORG_ID,
          userId: TARGET_USER_ID,
          role: params.role,
          status: 'active',
          clearedCustomRole: { id: cleared.id, name: cleared.name },
        };
      },
    );
  }

  it('names it in the audit metadata, as the repository reports clearing it', async () => {
    repositories.findMemberWithUser.mockResolvedValue(target('developer', deployer));
    clearing(deployer);

    const response = await patch({ role: 'owner' });

    expect(response.status).toBe(200);
    expect((await roleChange())?.metadata).toMatchObject({
      previousRole: 'developer',
      newRole: 'owner',
      previousCustomRoleId: deployer.id,
      previousCustomRoleName: 'Deployer',
    });
  });

  it('names the role the write cleared, not the one an earlier read saw', async () => {
    // The route read `Deployer`; by the time the locked write ran, the member
    // held `Release manager`. The record must say what was actually dropped.
    const replacement = customRole({ name: 'Release manager', baseRole: 'developer' });
    repositories.findMemberWithUser.mockResolvedValue(target('developer', deployer));
    clearing(replacement);

    await patch({ role: 'owner' });

    expect((await roleChange())?.metadata).toMatchObject({
      previousCustomRoleId: replacement.id,
      previousCustomRoleName: 'Release manager',
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
    expect(written).not.toHaveBeenCalledWith('upsertAccessGrant');
  });

  it('refuses a project-wide grant, which lands on production too', async () => {
    callerIs(PRODUCTION_CAPPED);

    const response = await put({ projectSlug: 'api', environmentSlug: null, accessLevel: 'read' });

    expect(response.status).toBe(403);
    expect(written).not.toHaveBeenCalledWith('upsertAccessGrant');
  });

  it('permits the same caller a grant where they hold the level', async () => {
    callerIs(PRODUCTION_CAPPED);

    const response = await put({
      projectSlug: 'api',
      environmentSlug: 'staging',
      accessLevel: 'admin',
    });

    expect(response.status).toBe(200);
    expect(written).toHaveBeenCalledExactlyOnceWith('upsertAccessGrant');
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

/* ── Removing a grant ─────────────────────────────────────────────────────── */

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
    expect(written).not.toHaveBeenCalledWith('removeAccessGrant');
  });

  it('refuses the same removal to a plain admin an explicit grant holds to read', async () => {
    callerIs(RESTRICTED_ADMIN);
    repositories.listGrantsForMember.mockResolvedValue([
      grantRow(null, 'write'),
      grantRow(PRODUCTION_ID, 'none'),
    ]);

    const response = await remove({ projectSlug: 'api', environmentSlug: 'production' });

    expect(response.status).toBe(403);
    expect(written).not.toHaveBeenCalledWith('removeAccessGrant');
  });

  it('permits a removal that lowers the member everywhere', async () => {
    // A project-wide `admin`, removed: the developer falls back to their role's
    // `write` and production `none`. Lower on every environment, including the
    // production this caller cannot reach.
    callerIs(PRODUCTION_CAPPED);
    repositories.listGrantsForMember.mockResolvedValue([grantRow(null, 'admin')]);

    const response = await remove({ projectSlug: 'api', environmentSlug: null });

    expect(response.status).toBe(204);
    expect(written).toHaveBeenCalledExactlyOnceWith('removeAccessGrant');
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
    expect(written).toHaveBeenCalledExactlyOnceWith('removeAccessGrant');
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
    expect(written).not.toHaveBeenCalledWith('removeAccessGrant');
  });

  it('refuses a restricted admin writing a wider grant over their own restriction', async () => {
    // `write` over the `read` the owner left them.
    callerIs(RESTRICTED_ADMIN);
    repositories.findMemberWithUser.mockResolvedValue(self('admin'));

    const response = await putOwn({
      projectSlug: 'api',
      environmentSlug: 'production',
      accessLevel: 'write',
    });

    expect(response.status).toBe(403);
    expect(written).not.toHaveBeenCalledWith('upsertAccessGrant');
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
    expect(written).toHaveBeenCalledExactlyOnceWith('removeAccessGrant');
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

/* ── Service tokens ───────────────────────────────────────────────────────── */

describe('GET /tokens/service — listed for whoever may mint or revoke', () => {
  const actions = (...extra: Action[]): Caller => ({
    role: 'admin',
    customRole: customRole({ name: 'Tokens', allowedActions: ['member.read', ...extra] }),
  });

  function list(): Promise<Response> {
    return listServiceTokensRoute(
      new Request('https://xecret.playxoft.com/api/orgs/acme/tokens/service'),
      { params: Promise.resolve({ orgSlug: 'acme' }) },
    );
  }

  beforeEach(() => {
    repositories.listServiceTokens.mockResolvedValue([]);
  });

  it.each([
    ['may only revoke', actions('token.revoke')],
    ['may only mint', actions('token.create')],
    ['may do both', { role: 'admin' } as Caller],
  ])('lists them for a role that %s', async (_name, caller) => {
    callerIs(caller);

    const response = await list();

    expect(response.status).toBe(200);
    expect(repositories.listServiceTokens).toHaveBeenCalledOnce();
  });

  it('refuses a role that may do neither, and reads nothing', async () => {
    callerIs(actions('project.read'));

    const response = await list();

    expect(response.status).toBe(403);
    expect(repositories.listServiceTokens).not.toHaveBeenCalled();
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

/* ── Shared requests for the doors below ──────────────────────────────────── */

const memberParams = { params: Promise.resolve({ orgSlug: 'acme', memberId: TARGET_MEMBER_ID }) };

function inviteMember(body: Record<string, unknown>): Promise<Response> {
  return inviteRoute(jsonRequest('POST', '/api/orgs/acme/members', body), {
    params: Promise.resolve({ orgSlug: 'acme' }),
  });
}

function patchMember(body: Record<string, unknown>): Promise<Response> {
  return patchMemberRoute(
    jsonRequest('PATCH', `/api/orgs/acme/members/${TARGET_MEMBER_ID}`, body),
    memberParams,
  );
}

function removeMember(): Promise<Response> {
  return removeMemberRoute(
    new Request(`https://xecret.playxoft.com/api/orgs/acme/members/${TARGET_MEMBER_ID}`, {
      method: 'DELETE',
      headers: { origin: 'https://xecret.playxoft.com' },
    }),
    memberParams,
  );
}

function writeGrant(body: Record<string, unknown>): Promise<Response> {
  return putGrantRoute(
    jsonRequest('PUT', `/api/orgs/acme/members/${TARGET_MEMBER_ID}/grants`, body),
    memberParams,
  );
}

function removeGrant(body: Record<string, unknown>): Promise<Response> {
  return deleteGrantRoute(
    jsonRequest('DELETE', `/api/orgs/acme/members/${TARGET_MEMBER_ID}/grants`, body),
    memberParams,
  );
}

function mintToken(body: Record<string, unknown>): Promise<Response> {
  return mintServiceTokenRoute(
    jsonRequest('POST', '/api/orgs/acme/tokens/service', { name: 'deploy', ...body }),
    { params: Promise.resolve({ orgSlug: 'acme' }) },
  );
}

function patchEnvironment(envSlug: string, body: Record<string, unknown>): Promise<Response> {
  return patchEnvironmentRoute(
    jsonRequest('PATCH', `/api/orgs/acme/projects/api/environments/${envSlug}`, body),
    { params: Promise.resolve({ orgSlug: 'acme', projectSlug: 'api', envSlug }) },
  );
}

function deleteProject(): Promise<Response> {
  return deleteProjectRoute(
    jsonRequest('DELETE', '/api/orgs/acme/projects/api', { confirm: 'api' }),
    { params: Promise.resolve({ orgSlug: 'acme', projectSlug: 'api' }) },
  );
}

/** Owners and admins with nothing written against them — never refused any of this. */
const UNRESTRICTED: readonly Caller[] = [{ role: 'owner' }, { role: 'admin' }];

const HELD_GRANTS_ABOVE_AUTHORITY = 'This member holds access grants beyond your own.';

/* ── Suspension does not hide a removal ───────────────────────────────────── */

describe('DELETE /members/{id}/grants — a suspended member is measured as the active one they will be', () => {
  /** A developer whose production a project-wide `write` would reach, but for a `none`. */
  const heldOffProduction = [grantRow(null, 'write'), grantRow(PRODUCTION_ID, 'none')];

  it('refuses the removal it would refuse were the member active', async () => {
    // Suspended, the developer resolves to `none` everywhere, and measured as
    // they stand nothing looks raised — but the row is still gone when they
    // are reinstated.
    callerIs(PRODUCTION_CAPPED);
    repositories.findMemberWithUser.mockResolvedValue(target('developer', undefined, 'suspended'));
    repositories.listGrantsForMember.mockResolvedValue(heldOffProduction);

    const response = await removeGrant({ projectSlug: 'api', environmentSlug: 'production' });

    expect(response.status).toBe(403);
    expect(await errorOf(response)).toMatchObject({
      code: 'forbidden',
      message: 'You cannot grant more access than you hold.',
    });
    expect(written).not.toHaveBeenCalledWith('removeAccessGrant');
  });

  it('closes suspend, remove the restriction, reinstate — at the removal', async () => {
    callerIs(PRODUCTION_CAPPED);
    repositories.listGrantsForMember.mockResolvedValue(heldOffProduction);

    repositories.findMemberWithUser.mockResolvedValue(target('developer'));
    const suspended = await patchMember({ status: 'suspended' });
    repositories.findMemberWithUser.mockResolvedValue(target('developer', undefined, 'suspended'));
    const removed = await removeGrant({ projectSlug: 'api', environmentSlug: 'production' });

    expect(suspended.status).toBe(200);
    expect(removed.status).toBe(403);
    expect(written).not.toHaveBeenCalledWith('removeAccessGrant');
  });

  it('changes nothing for an owner or an unrestricted admin', async () => {
    for (const caller of UNRESTRICTED) {
      callerIs(caller);
      repositories.findMemberWithUser.mockResolvedValue(
        target('developer', undefined, 'suspended'),
      );
      repositories.listGrantsForMember.mockResolvedValue(heldOffProduction);

      const response = await removeGrant({ projectSlug: 'api', environmentSlug: 'production' });

      expect(response.status, caller.role).toBe(204);
    }
  });
});

/* ── Reinstatement ────────────────────────────────────────────────────────── */

describe('PATCH /members/{id} — a reinstatement turns on only what the caller holds', () => {
  function suspendedDeveloperHolding(...grants: ReturnType<typeof grantRow>[]): void {
    repositories.findMemberWithUser.mockResolvedValue(target('developer', undefined, 'suspended'));
    repositories.listGrantsForMember.mockResolvedValue(grants);
  }

  it('refuses a production-capped admin reinstating a developer an owner granted production', async () => {
    callerIs(PRODUCTION_CAPPED);
    suspendedDeveloperHolding(grantRow(PRODUCTION_ID, 'write'));

    const response = await patchMember({ status: 'active' });

    expect(response.status).toBe(403);
    expect(await errorOf(response)).toMatchObject({
      code: 'forbidden',
      message: HELD_GRANTS_ABOVE_AUTHORITY,
    });
    expect(written).not.toHaveBeenCalled();
  });

  it('refuses a project-wide grant, which lands on production too', async () => {
    callerIs(PRODUCTION_CAPPED);
    suspendedDeveloperHolding(grantRow(null, 'read'));

    const response = await patchMember({ status: 'active' });

    expect(response.status).toBe(403);
  });

  it('permits the same caller a member whose every grant they hold', async () => {
    callerIs(PRODUCTION_CAPPED);
    suspendedDeveloperHolding(grantRow(STAGING_ID, 'write'), grantRow(PRODUCTION_ID, 'none'));

    const response = await patchMember({ status: 'active' });

    expect(response.status).toBe(200);
    expect(written).toHaveBeenCalledExactlyOnceWith('reinstateMember');
  });

  it('holds a plain admin to the level an explicit grant left them', async () => {
    callerIs(RESTRICTED_ADMIN);

    suspendedDeveloperHolding(grantRow(PRODUCTION_ID, 'write'));
    const above = await patchMember({ status: 'active' });
    suspendedDeveloperHolding(grantRow(PRODUCTION_ID, 'read'));
    const at = await patchMember({ status: 'active' });

    expect(above.status).toBe(403);
    expect(at.status).toBe(200);
  });

  it('asks nothing of a suspension, which turns nothing on', async () => {
    callerIs(PRODUCTION_CAPPED);
    repositories.listGrantsForMember.mockResolvedValue([grantRow(PRODUCTION_ID, 'write')]);

    const response = await patchMember({ status: 'suspended' });

    expect(response.status).toBe(200);
  });

  it('changes nothing for an owner or an unrestricted admin', async () => {
    for (const caller of UNRESTRICTED) {
      callerIs(caller);
      suspendedDeveloperHolding(grantRow(null, 'admin'), grantRow(PRODUCTION_ID, 'write'));

      const response = await patchMember({ status: 'active' });

      expect(response.status, caller.role).toBe(200);
    }
  });
});

/* ── Role changes that gain capabilities ──────────────────────────────────── */

describe('PATCH /members/{id} — a role change turns on only what the caller holds', () => {
  it('refuses promoting a viewer whose production grant would start writing', async () => {
    // An owner wrote production `write` for a viewer — who can therefore read
    // production. As a developer the same row writes it.
    callerIs(PRODUCTION_CAPPED);
    repositories.findMemberWithUser.mockResolvedValue(target('viewer'));
    repositories.listGrantsForMember.mockResolvedValue([grantRow(PRODUCTION_ID, 'write')]);

    const response = await patchMember({ role: 'developer' });

    expect(response.status).toBe(403);
    expect(await errorOf(response)).toMatchObject({
      code: 'forbidden',
      message: HELD_GRANTS_ABOVE_AUTHORITY,
    });
    expect(written).not.toHaveBeenCalled();
  });

  it('permits the promotion when the caller holds every grant it turns on', async () => {
    callerIs(PRODUCTION_CAPPED);
    repositories.findMemberWithUser.mockResolvedValue(target('viewer'));
    repositories.listGrantsForMember.mockResolvedValue([grantRow(STAGING_ID, 'write')]);

    const response = await patchMember({ role: 'developer' });

    expect(response.status).toBe(200);
  });

  it('asks nothing of a change that gains nothing, whatever the grants', async () => {
    callerIs(PRODUCTION_CAPPED);
    repositories.findMemberWithUser.mockResolvedValue(target('developer'));
    repositories.listGrantsForMember.mockResolvedValue([grantRow(PRODUCTION_ID, 'write')]);

    const response = await patchMember({ role: 'viewer' });

    expect(response.status).toBe(200);
  });

  it('measures the gain through the member’s own custom role', async () => {
    // Developer-based and listing only `secret.read`: promoted from viewer to
    // developer, the member still only reads — so the row does no more.
    callerIs(PRODUCTION_CAPPED);
    repositories.findMemberWithUser.mockResolvedValue(
      target('viewer', customRole({ baseRole: 'developer', allowedActions: ['secret.read'] })),
    );
    repositories.listGrantsForMember.mockResolvedValue([grantRow(PRODUCTION_ID, 'write')]);

    const response = await patchMember({ role: 'developer' });

    expect(response.status).toBe(200);
  });

  it('changes nothing for an owner or an unrestricted admin', async () => {
    for (const caller of UNRESTRICTED) {
      callerIs(caller);
      repositories.findMemberWithUser.mockResolvedValue(target('viewer'));
      repositories.listGrantsForMember.mockResolvedValue([
        grantRow(null, 'admin'),
        grantRow(PRODUCTION_ID, 'write'),
      ]);

      const response = await patchMember({ role: 'developer' });

      expect(response.status, caller.role).toBe(200);
    }
  });
});

/* ── Reclassifying an environment ─────────────────────────────────────────── */

describe('PATCH /environments/{env} — making it production confers what was written there', () => {
  it('refuses a caller who wrote an admin grant on staging, then reclassifies it', async () => {
    callerIs(PRODUCTION_CAPPED);

    const granted = await writeGrant({
      projectSlug: 'api',
      environmentSlug: 'staging',
      accessLevel: 'admin',
    });
    const reclassified = await patchEnvironment('staging', { isProduction: true });

    expect(granted.status).toBe(200);
    expect(reclassified.status).toBe(403);
    expect(repositories.updateEnvironment).not.toHaveBeenCalled();
  });

  it('refuses a caller who minted a write token on staging, then reclassifies it', async () => {
    // A token's level never consults the flag: reclassified, it writes production.
    callerIs(PRODUCTION_CAPPED);

    const minted = await mintToken({
      projectSlug: 'api',
      environmentSlug: 'staging',
      accessLevel: 'write',
    });
    const reclassified = await patchEnvironment('staging', { isProduction: true });

    expect(minted.status).toBe(201);
    expect(reclassified.status).toBe(403);
    expect(repositories.updateEnvironment).not.toHaveBeenCalled();
  });

  it('lets the same caller edit staging in every other way', async () => {
    callerIs(PRODUCTION_CAPPED);

    const renamed = await patchEnvironment('staging', { name: 'Pre-production' });
    const stillStaging = await patchEnvironment('staging', { isProduction: false });

    expect(renamed.status).toBe(200);
    expect(stillStaging.status).toBe(200);
  });

  it('changes nothing for an owner or an unrestricted admin', async () => {
    for (const caller of UNRESTRICTED) {
      callerIs(caller);

      const response = await patchEnvironment('staging', { isProduction: true });

      expect(response.status, caller.role).toBe(200);
    }
    expect(repositories.updateEnvironment).toHaveBeenCalledTimes(UNRESTRICTED.length);
  });
});

/* ── Deleting a project ───────────────────────────────────────────────────── */

describe('DELETE /projects/{project} — no further than each environment could be deleted', () => {
  it('refuses a plain admin an explicit none keeps off production', async () => {
    // Refused `environment.delete` on production, so refused the project door too.
    callerIs({
      role: 'admin',
      grants: [{ projectId: PROJECT_ID, environmentId: PRODUCTION_ID, accessLevel: 'none' }],
    });

    const response = await deleteProject();

    expect(response.status).toBe(403);
    expect(repositories.softDeleteProject).not.toHaveBeenCalled();
  });

  it('refuses one kept off a non-production environment the same way', async () => {
    callerIs({
      role: 'admin',
      grants: [{ projectId: PROJECT_ID, environmentId: STAGING_ID, accessLevel: 'none' }],
    });

    const response = await deleteProject();

    expect(response.status).toBe(403);
    expect(repositories.softDeleteProject).not.toHaveBeenCalled();
  });

  it('refuses a production-capped admin a project with production in it', async () => {
    callerIs(PRODUCTION_CAPPED);

    const response = await deleteProject();

    expect(response.status).toBe(403);
    expect(repositories.softDeleteProject).not.toHaveBeenCalled();
  });

  it('permits the same caller a project with no production in it', async () => {
    // Nothing in it is beyond them, so nothing is taken past their authority.
    callerIs(PRODUCTION_CAPPED);
    repositories.listEnvironments.mockResolvedValue([staging]);

    const response = await deleteProject();

    expect(response.status).toBe(204);
    expect(repositories.softDeleteProject).toHaveBeenCalledOnce();
  });

  it('changes nothing for an owner or an unrestricted admin', async () => {
    for (const caller of UNRESTRICTED) {
      callerIs(caller);

      const response = await deleteProject();

      expect(response.status, caller.role).toBe(204);
    }
  });
});

/* ── The trail ────────────────────────────────────────────────────────────── */

describe('every refusal above the caller’s authority files exactly one denied record', () => {
  const cases: readonly [string, () => void, () => Promise<Response>, AuditRecord['action']][] = [
    [
      'an invitation at a role above theirs',
      () => callerIs(MEMBER_MANAGER),
      () => inviteMember({ email: 'alt@example.com', role: 'admin' }),
      'member.invited',
    ],
    [
      'an invitation with grants above their level',
      () => callerIs(PRODUCTION_CAPPED),
      () =>
        inviteMember({
          email: 'alt@example.com',
          role: 'developer',
          grants: [{ projectSlug: 'api', environmentSlug: 'production', accessLevel: 'write' }],
        }),
      'member.invited',
    ],
    [
      'a promotion to a role above theirs',
      () => callerIs(PRODUCTION_CAPPED),
      () => patchMember({ role: 'admin' }),
      'member.role_changed',
    ],
    [
      'a promotion onto grants above theirs',
      () => {
        callerIs(PRODUCTION_CAPPED);
        repositories.findMemberWithUser.mockResolvedValue(target('viewer'));
        repositories.listGrantsForMember.mockResolvedValue([grantRow(PRODUCTION_ID, 'write')]);
      },
      () => patchMember({ role: 'developer' }),
      'member.role_changed',
    ],
    [
      'a reinstatement onto grants above theirs',
      () => {
        callerIs(PRODUCTION_CAPPED);
        repositories.findMemberWithUser.mockResolvedValue(
          target('developer', undefined, 'suspended'),
        );
        repositories.listGrantsForMember.mockResolvedValue([grantRow(PRODUCTION_ID, 'write')]);
      },
      () => patchMember({ status: 'active' }),
      'member.reinstated',
    ],
    [
      'a suspension of a role above theirs',
      () => {
        callerIs({ role: 'admin' });
        repositories.findMemberWithUser.mockResolvedValue(target('owner'));
      },
      () => patchMember({ status: 'suspended' }),
      'member.suspended',
    ],
    [
      'a removal of a role above theirs',
      () => {
        callerIs({ role: 'admin' });
        repositories.findMemberWithUser.mockResolvedValue(target('owner'));
      },
      () => removeMember(),
      'member.removed',
    ],
    [
      'a grant on a member above them',
      () => {
        callerIs({ role: 'admin' });
        repositories.findMemberWithUser.mockResolvedValue(target('owner'));
      },
      () => writeGrant({ projectSlug: 'api', environmentSlug: 'staging', accessLevel: 'read' }),
      'access.granted',
    ],
    [
      'a grant above their level',
      () => callerIs(PRODUCTION_CAPPED),
      () => writeGrant({ projectSlug: 'api', environmentSlug: 'production', accessLevel: 'write' }),
      'access.granted',
    ],
    [
      'a change to their own grants',
      () => {
        callerIs(RESTRICTED_ADMIN);
        repositories.findMemberWithUser.mockResolvedValue(self('admin'));
      },
      () => writeGrant({ projectSlug: 'api', environmentSlug: 'production', accessLevel: 'write' }),
      'access.granted',
    ],
    [
      'a removal that raises past their level',
      () => {
        callerIs(PRODUCTION_CAPPED);
        repositories.listGrantsForMember.mockResolvedValue([
          grantRow(null, 'write'),
          grantRow(PRODUCTION_ID, 'none'),
        ]);
      },
      () => removeGrant({ projectSlug: 'api', environmentSlug: 'production' }),
      'access.revoked',
    ],
    [
      'a service token past their level',
      () => callerIs(PRODUCTION_CAPPED),
      () => mintToken({ projectSlug: 'api', environmentSlug: 'production' }),
      'token.created',
    ],
    [
      'reclassifying an environment as production',
      () => callerIs(PRODUCTION_CAPPED),
      () => patchEnvironment('staging', { isProduction: true }),
      'environment.updated',
    ],
    [
      'deleting a project around an environment they cannot delete',
      () => callerIs(PRODUCTION_CAPPED),
      () => deleteProject(),
      'project.deleted',
    ],
  ];

  it.each(cases)('%s', async (_label, arrange, act, action) => {
    arrange();

    const response = await act();

    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe('forbidden');
    const filed = await denials();
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({
      action,
      outcome: 'denied',
      metadata: { reason: 'forbidden' },
    });
  });
});

/* ── Decided on the member as locked, not as first read ─────────────────── */

describe('PATCH and DELETE /members/{id} — decided on the member the write finds', () => {
  /**
   * A read-only role with no ceiling, based on viewer. For a viewer it is a
   * no-op; what it does is keep a viewer's promotion from gaining anything,
   * so nothing measures the viewer's production `write` row.
   */
  const readOnly = customRole({
    name: 'Contractor (read-only)',
    baseRole: 'viewer',
    allowedActions: ALL_ACTIONS.filter((action) => ROLE_CAPABILITIES.viewer[action]),
  });

  it('refuses a promotion when a concurrent unassignment has made it one that gains', async () => {
    // Race: the route read the viewer holding `readOnly`, so the promotion
    // gains nothing; a concurrent request took the role off before this
    // write's lock. Under the lock the viewer holds none — the promotion
    // gains `secret.update`, and the owner-written production row starts
    // writing. The production-capped caller could not have written it.
    callerIs(PRODUCTION_CAPPED);
    repositories.findMemberWithUser.mockResolvedValue(target('viewer', readOnly));
    lockedAs = { member: target('viewer'), grants: [grantRow(PRODUCTION_ID, 'write')] };

    const response = await patchMember({ role: 'developer' });

    expect(response.status).toBe(403);
    expect(await errorOf(response)).toMatchObject({ message: HELD_GRANTS_ABOVE_AUTHORITY });
    expect(written).not.toHaveBeenCalled();
    expect(repositories.listGrantsForMember).not.toHaveBeenCalled();
    const denied = (await denials()).filter((record) => record.action === 'member.role_changed');
    expect(denied).toHaveLength(1);
    expect(denied[0]?.metadata).toMatchObject({ previousRole: 'viewer', newRole: 'developer' });
  });

  it('refuses a promotion when a concurrent edit has widened the role the member holds', async () => {
    // Race the other way round: the route read the narrow role, and an edit
    // widened it — adding `secret.update` — before this write's lock.
    callerIs(RESTRICTED_ADMIN);
    const narrow = customRole({
      id: uuidv7(),
      name: 'Narrow',
      baseRole: 'developer',
      allowedActions: ['member.read', 'project.read', 'environment.read', 'secret.read'],
    });
    const widened = { ...narrow, allowedActions: [...narrow.allowedActions, 'secret.update'] };
    repositories.findMemberWithUser.mockResolvedValue(target('viewer', narrow));
    lockedAs = {
      member: target('viewer', widened as CustomRole),
      grants: [grantRow(PRODUCTION_ID, 'write')],
    };

    const response = await patchMember({ role: 'developer' });

    expect(response.status).toBe(403);
    expect(written).not.toHaveBeenCalled();
  });

  it('allows the promotion the locked member really does permit', async () => {
    // The control: under the lock the viewer still holds `readOnly`, so the
    // promotion gains nothing and there is nothing to measure.
    callerIs(PRODUCTION_CAPPED);
    repositories.findMemberWithUser.mockResolvedValue(target('viewer', readOnly));
    lockedAs = { member: target('viewer', readOnly), grants: [grantRow(PRODUCTION_ID, 'write')] };

    const response = await patchMember({ role: 'developer' });

    expect(response.status).toBe(200);
    expect(written).toHaveBeenCalledExactlyOnceWith('updateMemberRole');
  });

  it('records the role the write replaced, and answers with the custom role it found', async () => {
    const released = customRole({ name: 'Release manager', baseRole: 'developer' });
    repositories.findMemberWithUser.mockResolvedValue(target('viewer'));
    lockedAs = { member: target('developer', released), grants: [] };

    const response = await patchMember({ role: 'admin' });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { member: { customRole: { name: string } | null } };
    expect(body.member.customRole?.name).toBe('Release manager');
    const change = (await recorded()).find((record) => record.action === 'member.role_changed');
    expect(change?.metadata).toMatchObject({ previousRole: 'developer', newRole: 'admin' });
  });

  it.each([
    ['a suspension', () => patchMember({ status: 'suspended' }), 'member.suspended'],
    ['a reinstatement', () => patchMember({ status: 'active' }), 'member.reinstated'],
    ['a removal', () => removeMember(), 'member.removed'],
  ] as const)(
    'refuses %s of a member promoted to owner since the route read them',
    async (_name, act, action) => {
      callerIs({ role: 'admin' });
      repositories.findMemberWithUser.mockResolvedValue(target('developer'));
      lockedAs = { member: target('owner'), grants: [] };

      const response = await act();

      expect(response.status).toBe(403);
      expect(written).not.toHaveBeenCalled();
      expect((await denials()).map((record) => record.action)).toEqual([action]);
    },
  );
});

describe('PUT and DELETE /members/{id}/grants — decided on the member the write finds', () => {
  it.each([
    [
      'a grant written',
      () => writeGrant({ projectSlug: 'api', environmentSlug: 'staging', accessLevel: 'read' }),
      'access.granted',
    ],
    [
      'a grant removed',
      () => removeGrant({ projectSlug: 'api', environmentSlug: 'staging' }),
      'access.revoked',
    ],
  ] as const)(
    'refuses %s for a member promoted to owner since the route read them',
    async (_name, act, action) => {
      callerIs({ role: 'admin' });
      repositories.findMemberWithUser.mockResolvedValue(target('developer'));
      lockedAs = { member: target('owner'), grants: [grantRow(STAGING_ID, 'read')] };

      const response = await act();

      expect(response.status).toBe(403);
      expect(await errorOf(response)).toMatchObject({
        message: 'You cannot manage a role above your own.',
      });
      expect(written).not.toHaveBeenCalled();
      expect((await denials()).map((record) => record.action)).toEqual([action]);
    },
  );

  it('measures a removal on the rows the member holds when it lands, not when the route looked', async () => {
    // The route saw a lone production `none`; by the lock a project-wide
    // `write` has been written beside it, so removing the `none` now lets
    // `write` through on production — which this caller cannot hold.
    callerIs(PRODUCTION_CAPPED);
    repositories.listGrantsForMember.mockResolvedValue([grantRow(PRODUCTION_ID, 'none')]);
    lockedAs = {
      member: target('developer'),
      grants: [grantRow(null, 'write'), grantRow(PRODUCTION_ID, 'none')],
    };

    const response = await removeGrant({ projectSlug: 'api', environmentSlug: 'production' });

    expect(response.status).toBe(403);
    expect(written).not.toHaveBeenCalled();
  });

  it('measures a removal through the custom role the member holds when it lands', async () => {
    // The route read a developer holding a role capped at `none` on
    // production, whose project-wide `write` therefore stops short of it.
    // By the lock the role has come off: removing the production `none` row
    // would put `write` there.
    callerIs(PRODUCTION_CAPPED);
    const capped = customRole({
      name: 'No production',
      baseRole: 'developer',
      allowedActions: ALL_ACTIONS.filter((action) => ROLE_CAPABILITIES.developer[action]),
      accessCeiling: { nonProduction: 'write', production: 'none' },
    });
    repositories.findMemberWithUser.mockResolvedValue(target('developer', capped));
    lockedAs = {
      member: target('developer'),
      grants: [grantRow(null, 'write'), grantRow(PRODUCTION_ID, 'none')],
    };

    const response = await removeGrant({ projectSlug: 'api', environmentSlug: 'production' });

    expect(response.status).toBe(403);
    expect(written).not.toHaveBeenCalled();
  });

  it('records the level the write replaced, as the lock found it', async () => {
    repositories.listGrantsForMember.mockResolvedValue([]);
    lockedAs = { member: target('developer'), grants: [grantRow(STAGING_ID, 'read')] };

    const response = await writeGrant({
      projectSlug: 'api',
      environmentSlug: 'staging',
      accessLevel: 'write',
    });

    expect(response.status).toBe(200);
    const granted = (await recorded()).find((record) => record.action === 'access.granted');
    expect(granted?.metadata).toMatchObject({
      previousAccessLevel: 'read',
      newAccessLevel: 'write',
    });
  });

  it('reads the member’s grants only inside the write', async () => {
    await removeGrant({ projectSlug: 'api', environmentSlug: 'staging' });
    await writeGrant({ projectSlug: 'api', environmentSlug: 'staging', accessLevel: 'read' });

    // Only the stubbed repository's own locked read asks for them.
    expect(repositories.listGrantsForMember).toHaveBeenCalledTimes(2);
    expect(written.mock.calls.map(([name]) => name)).toEqual([
      'removeAccessGrant',
      'upsertAccessGrant',
    ]);
  });
});

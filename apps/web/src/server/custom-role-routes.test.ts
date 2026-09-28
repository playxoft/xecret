import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditRecord } from '@xecret/core/audit';
import type { AccessLevel, Action, CustomRole, OrgRole } from '@xecret/core/authz';
import { ROLE_CAPABILITIES } from '@xecret/core/authz';
import { uuidv7 } from '@xecret/core/ids';
import type {
  CustomRoleAssignment,
  CustomRoleDefinition,
  CustomRoleEdit,
  CustomRoleHolder,
  CustomRoleRecord,
} from '@xecret/db/repositories';
import { createLogger } from './logging';
import type { RequestLog } from './logging';

/**
 * Custom roles part 2, at the routes: defining, editing, deleting and
 * assigning a custom role, the viewer's authority summary, and the plan gate.
 *
 * Every rule the part-1 contract hands this API is asked here of the real
 * handler — `canDefineCustomRole` on both bases of an edit, the holder and
 * held-grant checks when an edit or an assignment widens somebody, the owner
 * who can hold no role, the role in use that cannot be deleted, the plan — and
 * every refusal is checked for exactly one audit record of what was attempted.
 *
 * ── What is stubbed, and how faithfully ──
 * The repository, at its boundary. The three writes that take a guard —
 * `updateCustomRole`, `deleteCustomRole`, `setMemberCustomRole` — are stubbed
 * the way the real ones behave: they hand the route's callback the snapshot
 * they would have read under the organisation lock, write nothing if it
 * throws, and raise the `RepositoryError`s the real ones raise after it (an
 * owner handed a role, a role still held). The SQL and the lock themselves are
 * pinned in `custom-roles.test.ts` in the db package and were run against a
 * real Postgres. `tenancy.ts` and `members-service.ts` run for real, so every
 * refusal comes from the real engine reading the membership the stub returns.
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
  listEnvironmentsForOrganization: vi.fn(),
  listCustomRoles: vi.fn(),
  createCustomRole: vi.fn(),
  updateCustomRole: vi.fn(),
  deleteCustomRole: vi.fn(),
  setMemberCustomRole: vi.fn(),
  listOrganizationsForUser: vi.fn(),
  findVaultKeys: vi.fn(),
  updateMemberRole: vi.fn(),
  listGrantsForMember: vi.fn(),
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

const { FieldConflictError, RepositoryError, toEngineCustomRole } =
  await import('@xecret/db/repositories');
const { GET: listRolesRoute, POST: createRoleRoute } =
  await import('@/app/api/orgs/[orgSlug]/roles/route');
const { PATCH: editRoleRoute, DELETE: deleteRoleRoute } =
  await import('@/app/api/orgs/[orgSlug]/roles/[roleId]/route');
const { PATCH: patchMemberRoute } =
  await import('@/app/api/orgs/[orgSlug]/members/[memberId]/route');
const { GET: authorityRoute } = await import('@/app/api/orgs/[orgSlug]/authority/route');
const { GET: meRoute } = await import('@/app/api/auth/me/route');

const ORG_ID = uuidv7();
const PROJECT_ID = uuidv7();
const STAGING_ID = uuidv7();
const PRODUCTION_ID = uuidv7();
const ACTOR_USER_ID = uuidv7();
const ACTOR_MEMBER_ID = uuidv7();
const TARGET_USER_ID = uuidv7();
const TARGET_MEMBER_ID = uuidv7();
const ROLE_ID = uuidv7();
const OTHER_ROLE_ID = uuidv7();

const EPOCH = new Date('2026-01-01T00:00:00.000Z');
const ALL_ACTIONS = Object.keys(ROLE_CAPABILITIES.owner) as Action[];

const deferred: Promise<unknown>[] = [];

/** Called with a write's name once its guard or `decide` let it through. */
const written = vi.fn();
const runtimeDeferred: Promise<unknown>[] = [];

/* ── Callers ──────────────────────────────────────────────────────────────── */

interface Caller {
  role: OrgRole;
  customRole?: CustomRole;
  grants?: { projectId: string; environmentId: string | null; accessLevel: AccessLevel }[];
}

function engineRole(over: Partial<CustomRole>): CustomRole {
  return {
    id: uuidv7(),
    name: 'Narrowed',
    baseRole: 'admin',
    allowedActions: ALL_ACTIONS,
    ...over,
  };
}

/** An admin-based role that may manage members and do nothing else. */
const MEMBER_MANAGER: Caller = {
  role: 'admin',
  customRole: engineRole({
    name: 'Member manager',
    allowedActions: ['member.read', 'member.invite', 'member.update', 'member.remove'],
  }),
};

/** An admin in every respect but one: `none` on production. */
const PRODUCTION_CAPPED: Caller = {
  role: 'admin',
  customRole: engineRole({
    name: 'Admin, no production',
    accessCeiling: { nonProduction: 'admin', production: 'none' },
  }),
};

/**
 * A plain admin an owner held to `read` on production with an explicit grant.
 * Holds no custom role, so may define roles — and is measured, on anything
 * that switches grants on, against what that grant leaves them.
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

/* ── Organisation and plan ─────────────────────────────────────────────────── */

function planIs(plan: 'free' | 'team' | 'enterprise'): void {
  repositories.findOrganizationBySlugWithEntitlements.mockResolvedValue({
    entitlements: {
      plan,
      status: 'active',
      addonSaml: false,
      addonDirectorySync: false,
      limitOverrides: null,
      currentPeriodEnd: null,
    },
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
}

/* ── Roles ────────────────────────────────────────────────────────────────── */

function roleRecord(over: Partial<CustomRoleRecord> = {}): CustomRoleRecord {
  return {
    id: ROLE_ID,
    orgId: ORG_ID,
    name: 'Deployer',
    baseRole: 'developer',
    allowedActions: ['member.read', 'project.read', 'environment.read', 'secret.read'],
    accessCeiling: { nonProduction: 'write', production: 'none' },
    createdAt: EPOCH,
    updatedAt: EPOCH,
    ...over,
  };
}

function holder(over: Partial<CustomRoleHolder> = {}): CustomRoleHolder {
  return {
    memberId: TARGET_MEMBER_ID,
    userId: TARGET_USER_ID,
    email: 'dev@playxoft.com',
    role: 'developer',
    status: 'active',
    grants: [],
    ...over,
  };
}

/** What the repository hands an edit's `decide`: the role and its holders, as locked. */
let editSnapshot: CustomRoleEdit;
/** What the repository hands an assignment's guard. */
let assignment: CustomRoleAssignment;
/** The role `deleteCustomRole` finds, and whether anybody still holds it. */
let deletable: { role: CustomRoleRecord; held: boolean };

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

const grid = [
  {
    id: STAGING_ID,
    projectId: PROJECT_ID,
    name: 'staging',
    slug: 'staging',
    isProduction: false,
    encryptionMode: 'server',
    sortOrder: 0,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    deletedAt: null,
    project: { id: PROJECT_ID, name: 'API', slug: 'api' },
  },
  {
    id: PRODUCTION_ID,
    projectId: PROJECT_ID,
    name: 'production',
    slug: 'production',
    isProduction: true,
    encryptionMode: 'server',
    sortOrder: 1,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    deletedAt: null,
    project: { id: PROJECT_ID, name: 'API', slug: 'api' },
  },
];

function target(role: OrgRole, held?: CustomRole, userId = TARGET_USER_ID) {
  return {
    id: TARGET_MEMBER_ID,
    orgId: ORG_ID,
    userId,
    role,
    status: 'active' as const,
    customRole: held,
    seatAssigned: true,
    createdAt: EPOCH,
    user: { id: userId, email: 'dev@playxoft.com', displayName: null, avatarUrl: null },
  };
}

/** A grant row on production, which a production-capped role holds down. */
const PRODUCTION_WRITE = {
  id: uuidv7(),
  projectId: PROJECT_ID,
  environmentId: PRODUCTION_ID,
  accessLevel: 'write' as const,
};

function silentLog(base: Record<string, unknown> = {}): RequestLog {
  return createLogger({
    sink: { write: () => {}, flush: () => Promise.resolve() },
    minimum: 'error',
    base,
  });
}

async function recorded(): Promise<AuditRecord[]> {
  await Promise.allSettled(deferred);
  await Promise.allSettled(runtimeDeferred);
  return auditSink.write.mock.calls.flatMap((call) => (call[0] ?? []) as AuditRecord[]);
}

async function outcomes(outcome: AuditRecord['outcome']): Promise<AuditRecord[]> {
  return (await recorded()).filter((record) => record.outcome === outcome);
}

function request(method: string, path: string, body?: unknown): Request {
  return new Request(`https://xecret.playxoft.com${path}`, {
    method,
    headers: { origin: 'https://xecret.playxoft.com', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

  planIs('enterprise');
  callerIs({ role: 'owner' });

  repositories.listEnvironmentsForOrganization.mockResolvedValue(grid);
  repositories.findMemberWithUser.mockResolvedValue(target('developer'));
  repositories.listCustomRoles.mockResolvedValue([{ ...roleRecord(), holderCount: 2 }]);
  repositories.createCustomRole.mockImplementation(
    async (_db: unknown, params: { definition: CustomRoleDefinition }) =>
      roleRecord({
        id: uuidv7(),
        ...params.definition,
        allowedActions: [...params.definition.allowedActions],
      }),
  );

  editSnapshot = { current: roleRecord(), holders: [holder()] };
  repositories.updateCustomRole.mockImplementation(
    async (
      _db: unknown,
      _params: unknown,
      decide: (edit: CustomRoleEdit) => CustomRoleDefinition | null,
    ) => {
      const definition = decide(editSnapshot);
      if (definition === null) {
        return {
          role: editSnapshot.current,
          previous: editSnapshot.current,
          holders: editSnapshot.holders,
          changed: false,
        };
      }
      written('updateCustomRole');
      return {
        role: {
          ...editSnapshot.current,
          ...definition,
          allowedActions: [...definition.allowedActions],
        },
        previous: editSnapshot.current,
        holders: editSnapshot.holders,
        changed: true,
      };
    },
  );

  deletable = { role: roleRecord(), held: false };
  repositories.deleteCustomRole.mockImplementation(
    async (_db: unknown, _params: unknown, guard: (current: CustomRoleRecord) => void) => {
      guard(deletable.role);
      if (deletable.held) {
        throw new RepositoryError(
          'conflict',
          'This role is still held by members. Move them to another role, or to none, and delete it then.',
        );
      }
      return deletable.role;
    },
  );

  assignment = {
    member: { ...target('developer'), customRole: undefined },
    next: roleRecord(),
    grants: [],
  };
  repositories.setMemberCustomRole.mockImplementation(
    async (
      _db: unknown,
      params: { customRoleId: string | null },
      guard: (assignment: CustomRoleAssignment) => void,
    ) => {
      const next = params.customRoleId === null ? null : assignment.next;
      if (params.customRoleId !== null && next === null) {
        throw new RepositoryError('notFound', 'Custom role not found in this organisation.');
      }
      const held = assignment.member.customRole;
      const writtenMember = {
        id: assignment.member.id,
        orgId: ORG_ID,
        userId: assignment.member.userId,
        role: assignment.member.role,
        status: assignment.member.status,
      };
      if ((held?.id ?? null) === (next?.id ?? null)) {
        // As the repository does: nothing to change, no guard, no write.
        return {
          member: writtenMember,
          previous: held === undefined ? null : { id: held.id, name: held.name },
          next,
          changed: false,
        };
      }
      guard({ ...assignment, next });
      if (next !== null && assignment.member.role === 'owner') {
        throw new RepositoryError(
          'conflict',
          'An owner cannot hold a custom role. Change their built-in role first.',
        );
      }
      written('setMemberCustomRole');
      return {
        member: writtenMember,
        previous: held === undefined ? null : { id: held.id, name: held.name },
        next,
        changed: true,
      };
    },
  );
});

const roleParams = (roleId = ROLE_ID) => ({ params: Promise.resolve({ orgSlug: 'acme', roleId }) });
const orgParams = { params: Promise.resolve({ orgSlug: 'acme' }) };
const memberParams = {
  params: Promise.resolve({ orgSlug: 'acme', memberId: TARGET_MEMBER_ID }),
};

/* ── Listing ──────────────────────────────────────────────────────────────── */

describe('GET /roles', () => {
  it('lists the roles with their holders, and says the plan allows them', async () => {
    const response = await listRolesRoute(request('GET', '/api/orgs/acme/roles'), orgParams);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { name: string; holderCount: number }[];
      feature: { enabled: boolean; upgradeTo: string | null };
    };
    expect(body.data).toMatchObject([{ name: 'Deployer', holderCount: 2 }]);
    expect(body.feature).toEqual({ enabled: true, upgradeTo: null });
  });

  it('still lists them on a plan without the feature, naming the plan that has it', async () => {
    planIs('team');

    const response = await listRolesRoute(request('GET', '/api/orgs/acme/roles'), orgParams);

    expect(response.status).toBe(200);
    expect(((await response.json()) as { feature: unknown }).feature).toEqual({
      enabled: false,
      upgradeTo: 'enterprise',
    });
  });

  it('is refused to somebody who cannot change members', async () => {
    callerIs({ role: 'developer' });

    const response = await listRolesRoute(request('GET', '/api/orgs/acme/roles'), orgParams);

    expect(response.status).toBe(403);
    expect(repositories.listCustomRoles).not.toHaveBeenCalled();
  });
});

/* ── Defining ─────────────────────────────────────────────────────────────── */

describe('POST /roles — defining a role', () => {
  const body = {
    name: '  Deployer  ',
    baseRole: 'developer',
    allowedActions: ['secret.read', 'secret.update', 'member.read'],
    accessCeiling: { nonProduction: 'write', production: 'none' },
  };

  function create(payload: unknown = body): Promise<Response> {
    return createRoleRoute(request('POST', '/api/orgs/acme/roles', payload), orgParams);
  }

  it('defines it and records the whole definition', async () => {
    const response = await create();

    expect(response.status).toBe(201);
    expect(repositories.createCustomRole).toHaveBeenCalledWith(expect.anything(), {
      orgId: ORG_ID,
      createdBy: ACTOR_USER_ID,
      definition: {
        name: 'Deployer',
        baseRole: 'developer',
        allowedActions: ['secret.read', 'secret.update', 'member.read'],
        accessCeiling: { nonProduction: 'write', production: 'none' },
      },
    });
    const [success] = await outcomes('success');
    expect(success).toMatchObject({
      action: 'role.created',
      resourceType: 'custom_role',
      metadata: {
        customRoleName: 'Deployer',
        baseRole: 'developer',
        allowedActions: ['secret.read', 'secret.update', 'member.read'],
        accessCeiling: { nonProduction: 'write', production: 'none' },
      },
    });
  });

  it('is refused on a plan without custom roles, with plan_limit and an audited refusal', async () => {
    planIs('team');

    const response = await create();

    expect(response.status).toBe(403);
    const error = (await response.json()) as {
      error: { code: string; plan: { resource: string; upgradeTo: string } };
    };
    expect(error.error.code).toBe('plan_limit');
    expect(error.error.plan).toMatchObject({ resource: 'customRoles', upgradeTo: 'enterprise' });
    expect(repositories.createCustomRole).not.toHaveBeenCalled();
    const errors = await outcomes('error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      action: 'role.created',
      metadata: { reason: 'quotaExceeded', limitName: 'customRoles', plan: 'team' },
    });
  });

  it('is refused to a developer, who cannot change members, with one denied record', async () => {
    callerIs({ role: 'developer' });

    const response = await create();

    expect(response.status).toBe(403);
    expect(await outcomes('denied')).toMatchObject([{ action: 'role.created' }]);
    expect(repositories.createCustomRole).not.toHaveBeenCalled();
  });

  it('is refused to a narrowed member manager, who may change members but not define roles', async () => {
    callerIs(MEMBER_MANAGER);

    const response = await create();

    expect(response.status).toBe(403);
    expect((await errorOf(response)).message).toBe(
      'Only an owner or admin who holds no custom role can define roles.',
    );
    const denied = await outcomes('denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      action: 'role.created',
      metadata: { reason: 'forbidden', customRoleName: 'Deployer', baseRole: 'developer' },
    });
    expect(repositories.createCustomRole).not.toHaveBeenCalled();
  });

  it('lets a plain admin define one on any base but owner', async () => {
    callerIs({ role: 'admin' });

    expect((await create({ ...body, baseRole: 'admin', allowedActions: [] })).status).toBe(201);
  });

  it('refuses an owner base as a malformed request, before the database sees it', async () => {
    const response = await create({ ...body, baseRole: 'owner' });

    expect(response.status).toBe(422);
    expect(repositories.createCustomRole).not.toHaveBeenCalled();
  });

  it('refuses a list naming actions the base could never perform', async () => {
    const response = await create({
      ...body,
      baseRole: 'viewer',
      allowedActions: ['secret.read', 'secret.update'],
    });

    expect(response.status).toBe(422);
    const error = (await response.json()) as {
      error: { fields: { field: string; message: string }[] };
    };
    expect(error.error.fields).toEqual([
      { field: 'allowedActions', message: 'A viewer-based role cannot perform secret.update.' },
    ]);
    expect(repositories.createCustomRole).not.toHaveBeenCalled();
  });

  it('refuses names that are invisible, reversed, NUL-bearing or a built-in role, and audits none of them', async () => {
    const names = [
      String.fromCodePoint(0x200b),
      `${String.fromCodePoint(0x202e)}nwo${String.fromCodePoint(0x202c)}`,
      `a${String.fromCodePoint(0x0000)}b`,
      'Owner',
      ' admin ',
    ];
    for (const name of names) {
      const response = await create({ ...body, name });
      expect(response.status, JSON.stringify(name)).toBe(422);
    }
    expect(repositories.createCustomRole).not.toHaveBeenCalled();
    // A request nobody could have meant is not a record anybody needs.
    expect(await recorded()).toEqual([]);
  });

  it('stores the NFC spelling of a name', async () => {
    const decomposed = `Caf${String.fromCodePoint(0x0065, 0x0301)}`;

    await create({ ...body, name: decomposed });

    expect(repositories.createCustomRole.mock.calls[0]?.[1].definition.name).toBe(
      `Caf${String.fromCodePoint(0x00e9)}`,
    );
  });

  it('answers a name another role holds with a 409 on the name field', async () => {
    repositories.createCustomRole.mockRejectedValue(
      new FieldConflictError('name', 'A role with this name already exists in this organisation.'),
    );

    const response = await create();

    expect(response.status).toBe(409);
    const error = (await response.json()) as {
      error: { code: string; fields: { field: string; message: string }[] };
    };
    expect(error.error.code).toBe('conflict');
    expect(error.error.fields).toEqual([
      { field: 'name', message: 'A role with this name already exists in this organisation.' },
    ]);
  });

  it('audits a list naming actions beyond the base, which is a refusal the route understood', async () => {
    await create({ ...body, baseRole: 'viewer', allowedActions: ['secret.read', 'secret.update'] });

    expect(await outcomes('error')).toMatchObject([
      {
        action: 'role.created',
        metadata: {
          reason: 'invalidInput',
          customRoleName: 'Deployer',
          baseRole: 'viewer',
          allowedActions: ['secret.read', 'secret.update'],
        },
      },
    ]);
  });

  it('refuses half a ceiling', async () => {
    const response = await create({ ...body, accessCeiling: { production: 'none' } });

    expect(response.status).toBe(422);
  });

  it('answers a duplicate name 409, and records the attempt', async () => {
    repositories.createCustomRole.mockRejectedValue(
      new RepositoryError('conflict', 'A role with this name already exists in this organisation.'),
    );

    const response = await create();

    expect(response.status).toBe(409);
    expect(await outcomes('error')).toMatchObject([
      { action: 'role.created', metadata: { reason: 'conflict', customRoleName: 'Deployer' } },
    ]);
  });

  it('requires a browser session', async () => {
    actor.authenticate.mockResolvedValue({
      principal: {
        kind: 'cliToken',
        tokenId: uuidv7(),
        userId: ACTOR_USER_ID,
        tokenName: 'laptop',
      },
      source: 'bearer',
    });

    const response = await create();

    expect(response.status).toBe(403);
    expect(repositories.createCustomRole).not.toHaveBeenCalled();
  });
});

/* ── Editing ──────────────────────────────────────────────────────────────── */

describe('PATCH /roles/{id} — editing a role is measured against everyone holding it', () => {
  function edit(payload: unknown, roleId = ROLE_ID): Promise<Response> {
    return editRoleRoute(
      request('PATCH', `/api/orgs/acme/roles/${roleId}`, payload),
      roleParams(roleId),
    );
  }

  it('edits, recording before and after, and reconciles every holder’s keys', async () => {
    editSnapshot = {
      current: roleRecord(),
      holders: [holder(), holder({ memberId: uuidv7(), userId: uuidv7(), email: 'b@x.test' })],
    };

    const response = await edit({ accessCeiling: { nonProduction: 'read', production: 'none' } });

    expect(response.status).toBe(200);
    const [success] = await outcomes('success');
    expect(success).toMatchObject({
      action: 'role.updated',
      resourceId: ROLE_ID,
      metadata: {
        accessCeiling: { nonProduction: 'read', production: 'none' },
        previousAccessCeiling: { nonProduction: 'write', production: 'none' },
        holderCount: 2,
      },
    });
    expect(memberKeys.reconcileMemberKeyAccess).toHaveBeenCalledTimes(2);
  });

  it('does not reconcile keys for a rename, which moves nobody’s access', async () => {
    const response = await edit({ name: 'Release manager' });

    expect(response.status).toBe(200);
    expect(memberKeys.reconcileMemberKeyAccess).not.toHaveBeenCalled();
  });

  it('refuses a narrowed caller outright, whatever the edit', async () => {
    callerIs(MEMBER_MANAGER);

    const response = await edit({ name: 'Anything' });

    expect(response.status).toBe(403);
    expect(await outcomes('denied')).toMatchObject([
      { action: 'role.updated', metadata: { reason: 'forbidden', holderCount: 1 } },
    ]);
    expect(await outcomes('success')).toEqual([]);
  });

  it('refuses a widening edit when a holder has grants beyond the caller — the dormant production grant', async () => {
    // The holder's production `write` row is held at `none` by the role's
    // ceiling. Lifting the ceiling switches it on, and this admin may grant
    // only `read` on production.
    callerIs(RESTRICTED_ADMIN);
    editSnapshot = { current: roleRecord(), holders: [holder({ grants: [PRODUCTION_WRITE] })] };

    const response = await edit({ accessCeiling: { nonProduction: 'write', production: 'write' } });

    expect(response.status).toBe(403);
    expect((await errorOf(response)).message).toBe(
      'This change would widen a member who holds access grants beyond your own.',
    );
    const denied = await outcomes('denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      action: 'role.updated',
      metadata: {
        previousAccessCeiling: { nonProduction: 'write', production: 'none' },
        accessCeiling: { nonProduction: 'write', production: 'write' },
      },
    });
    expect(await outcomes('success')).toEqual([]);
  });

  it('lets the same caller narrow the role, which switches nothing on', async () => {
    callerIs(RESTRICTED_ADMIN);
    editSnapshot = { current: roleRecord(), holders: [holder({ grants: [PRODUCTION_WRITE] })] };

    const response = await edit({ accessCeiling: { nonProduction: 'read', production: 'none' } });

    expect(response.status).toBe(200);
  });

  it('counts a widened action list as widening, not only a ceiling', async () => {
    callerIs(RESTRICTED_ADMIN);
    // Uncapped on production, reading only: the production `write` row reads
    // today and would write once `secret.update` is listed.
    editSnapshot = {
      current: roleRecord({ accessCeiling: null }),
      holders: [holder({ grants: [PRODUCTION_WRITE] })],
    };

    const response = await edit({
      allowedActions: [
        'member.read',
        'project.read',
        'environment.read',
        'secret.read',
        'secret.update',
      ],
    });

    expect(response.status).toBe(403);
  });

  it('refuses a holder the caller could not otherwise manage', async () => {
    // Unreachable through the database — an owner cannot hold a custom role —
    // and checked anyway, as the contract asks: an admin editing a role some
    // owner holds would be changing an owner's authority.
    callerIs({ role: 'admin' });
    editSnapshot = { current: roleRecord(), holders: [holder({ role: 'owner' })] };

    const response = await edit({ name: 'Renamed' });

    expect(response.status).toBe(403);
    expect((await errorOf(response)).message).toBe(
      'This role is held by somebody whose role is above your own.',
    );
  });

  it('checks the merged definition: narrowing the base must drop the actions it cannot perform', async () => {
    editSnapshot = {
      current: roleRecord({ baseRole: 'developer', allowedActions: ['secret.update'] }),
      holders: [],
    };

    const response = await edit({ baseRole: 'viewer' });

    expect(response.status).toBe(422);
    expect(await outcomes('success')).toEqual([]);
  });

  it('is plan-gated, with an audited refusal', async () => {
    planIs('free');

    const response = await edit({ name: 'Renamed' });

    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe('plan_limit');
    expect(written).not.toHaveBeenCalled();
    expect(await outcomes('error')).toMatchObject([
      { action: 'role.updated', metadata: { reason: 'quotaExceeded' } },
    ]);
  });

  it('answers a role that is not this organisation’s 404, and records it', async () => {
    repositories.updateCustomRole.mockRejectedValue(
      new RepositoryError('notFound', 'Custom role not found in this organisation.'),
    );

    const response = await edit({ name: 'Renamed' });

    expect(response.status).toBe(404);
    expect(await outcomes('error')).toMatchObject([
      { action: 'role.updated', metadata: { reason: 'notFound', customRoleId: ROLE_ID } },
    ]);
  });

  it('answers a malformed id 404 without asking the database', async () => {
    const response = await edit({ name: 'Renamed' }, 'not-a-uuid');

    expect(response.status).toBe(404);
    expect(repositories.updateCustomRole).not.toHaveBeenCalled();
  });

  it('refuses an empty patch', async () => {
    expect((await edit({})).status).toBe(422);
  });

  it('writes, records and gates nothing for an edit that changes nothing — on any plan', async () => {
    planIs('free');
    const current = roleRecord();

    const response = await edit({
      name: current.name,
      baseRole: current.baseRole,
      allowedActions: current.allowedActions,
      accessCeiling: current.accessCeiling,
    });

    expect(response.status).toBe(200);
    expect(written).not.toHaveBeenCalled();
    expect(await recorded()).toEqual([]);
    expect(memberKeys.reconcileMemberKeyAccess).not.toHaveBeenCalled();
  });

  it('treats the member.read floor as listed whether or not it is', async () => {
    // The dialog always sends `member.read`; a role stored without it is the
    // same role, so saving it unchanged is still a no-op.
    editSnapshot = {
      current: roleRecord({ allowedActions: ['project.read', 'environment.read', 'secret.read'] }),
      holders: [holder()],
    };

    const response = await edit({
      allowedActions: ['member.read', 'project.read', 'environment.read', 'secret.read'],
    });

    expect(response.status).toBe(200);
    expect(written).not.toHaveBeenCalled();
    expect(await recorded()).toEqual([]);
  });

  it('audits a merge naming actions beyond the new base', async () => {
    editSnapshot = {
      current: roleRecord({ baseRole: 'developer', allowedActions: ['secret.update'] }),
      holders: [],
    };

    await edit({ baseRole: 'viewer' });

    expect(await outcomes('error')).toMatchObject([
      {
        action: 'role.updated',
        metadata: { reason: 'invalidInput', baseRole: 'viewer', previousBaseRole: 'developer' },
      },
    ]);
    expect(written).not.toHaveBeenCalled();
  });

  it('still answers 200 for a saved role when one holder’s key reconciliation fails', async () => {
    const second = holder({ memberId: uuidv7(), userId: uuidv7(), email: 'b@x.test' });
    editSnapshot = { current: roleRecord(), holders: [holder(), second] };
    memberKeys.reconcileMemberKeyAccess
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce({ revoked: [], queued: [] });

    const response = await edit({ accessCeiling: { nonProduction: 'read', production: 'none' } });

    expect(response.status).toBe(200);
    // The second holder is still reconciled, against the grid read once.
    expect(memberKeys.reconcileMemberKeyAccess).toHaveBeenCalledTimes(2);
    expect(memberKeys.reconcileMemberKeyAccess.mock.calls[1]?.[1]).toMatchObject({
      userId: second.userId,
      environments: grid,
    });
    expect(repositories.listEnvironmentsForOrganization).toHaveBeenCalledTimes(2);
    expect(await outcomes('success')).toMatchObject([{ action: 'role.updated' }]);
  });
});

/* ── Deleting ─────────────────────────────────────────────────────────────── */

describe('DELETE /roles/{id}', () => {
  function remove(): Promise<Response> {
    return deleteRoleRoute(request('DELETE', `/api/orgs/acme/roles/${ROLE_ID}`), roleParams());
  }

  it('deletes a role nobody holds, recording the definition that went', async () => {
    const response = await remove();

    expect(response.status).toBe(204);
    expect(await outcomes('success')).toMatchObject([
      {
        action: 'role.deleted',
        metadata: { customRoleName: 'Deployer', baseRole: 'developer' },
      },
    ]);
  });

  it('answers a role still in use 409, saying what to do, and records it', async () => {
    deletable.held = true;

    const response = await remove();

    expect(response.status).toBe(409);
    expect((await errorOf(response)).message).toMatch(/still held by members.*Move them/);
    expect(await outcomes('error')).toMatchObject([
      { action: 'role.deleted', metadata: { reason: 'conflict' } },
    ]);
    expect(await outcomes('success')).toEqual([]);
  });

  it('is refused to a narrowed caller, with one denied record', async () => {
    callerIs(MEMBER_MANAGER);

    const response = await remove();

    expect(response.status).toBe(403);
    expect(await outcomes('denied')).toMatchObject([{ action: 'role.deleted' }]);
  });

  it('is not plan-gated: an organisation that left Enterprise can tidy up', async () => {
    planIs('free');

    expect((await remove()).status).toBe(204);
  });
});

/* ── Assigning ────────────────────────────────────────────────────────────── */

describe('PATCH /members/{id} { customRoleId } — assigning, swapping, unassigning', () => {
  function assign(customRoleId: string | null): Promise<Response> {
    return patchMemberRoute(
      request('PATCH', `/api/orgs/acme/members/${TARGET_MEMBER_ID}`, { customRoleId }),
      memberParams,
    );
  }

  it('puts a member on a role, names it on the roster payload, and reconciles their keys', async () => {
    const response = await assign(ROLE_ID);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      member: { role: string; customRole: { id: string; name: string } | null };
    };
    expect(body.member.role).toBe('developer');
    expect(body.member.customRole).toEqual({
      id: ROLE_ID,
      name: 'Deployer',
      baseRole: 'developer',
    });
    expect(await outcomes('success')).toMatchObject([
      {
        action: 'member.custom_role_changed',
        resourceId: TARGET_MEMBER_ID,
        metadata: {
          targetEmail: 'dev@playxoft.com',
          customRoleId: ROLE_ID,
          customRoleName: 'Deployer',
        },
      },
    ]);
    expect(memberKeys.reconcileMemberKeyAccess).toHaveBeenCalledTimes(1);
  });

  it('refuses an owner, 409 rather than the CHECK’s 500, and records the attempt', async () => {
    repositories.findMemberWithUser.mockResolvedValue(target('owner'));
    assignment = { ...assignment, member: { ...target('owner'), customRole: undefined } };

    const response = await assign(ROLE_ID);

    expect(response.status).toBe(409);
    expect((await errorOf(response)).message).toMatch(/owner cannot hold a custom role/);
    expect(await outcomes('error')).toMatchObject([
      { action: 'member.custom_role_changed', metadata: { reason: 'conflict' } },
    ]);
  });

  it('refuses a caller changing their own custom role', async () => {
    repositories.findMemberWithUser.mockResolvedValue(target('admin', undefined, ACTOR_USER_ID));

    const response = await assign(null);

    expect(response.status).toBe(403);
    expect(repositories.setMemberCustomRole).not.toHaveBeenCalled();
  });

  it('answers another organisation’s role 404', async () => {
    assignment = { ...assignment, next: null };

    const response = await assign(OTHER_ROLE_ID);

    expect(response.status).toBe(404);
    expect(await outcomes('error')).toMatchObject([
      { action: 'member.custom_role_changed', metadata: { reason: 'notFound' } },
    ]);
  });

  it('refuses a member manager touching a developer, whose role holds what theirs withholds', async () => {
    callerIs(MEMBER_MANAGER);

    const response = await assign(ROLE_ID);

    expect(response.status).toBe(403);
    expect((await errorOf(response)).message).toBe('You cannot manage a role above your own.');
    expect(await outcomes('denied')).toMatchObject([
      {
        action: 'member.custom_role_changed',
        metadata: { targetEmail: 'dev@playxoft.com', customRoleId: ROLE_ID },
      },
    ]);
  });

  it('refuses unassigning when it would switch on grants beyond the caller', async () => {
    // Taking the role off returns the member to a plain developer, and their
    // production `write` row — held at `none` by the role — takes effect.
    callerIs(RESTRICTED_ADMIN);
    const held = toEngineCustomRole(roleRecord());
    repositories.findMemberWithUser.mockResolvedValue(target('developer', held));
    assignment = {
      member: { ...target('developer'), customRole: held },
      next: null,
      grants: [PRODUCTION_WRITE],
    };

    const response = await assign(null);

    expect(response.status).toBe(403);
    expect((await errorOf(response)).message).toBe(
      'This member holds access grants beyond your own.',
    );
    expect(await outcomes('denied')).toMatchObject([
      {
        action: 'member.custom_role_changed',
        metadata: { previousCustomRoleId: ROLE_ID, previousCustomRoleName: 'Deployer' },
      },
    ]);
  });

  it('refuses swapping to a role with a higher ceiling for the same reason', async () => {
    callerIs(RESTRICTED_ADMIN);
    const held = toEngineCustomRole(roleRecord());
    assignment = {
      member: { ...target('developer'), customRole: held },
      next: roleRecord({
        id: OTHER_ROLE_ID,
        name: 'Deployer+',
        accessCeiling: { nonProduction: 'write', production: 'write' },
      }),
      grants: [PRODUCTION_WRITE],
    };

    expect((await assign(OTHER_ROLE_ID)).status).toBe(403);
  });

  it('lets the same caller swap to a narrower role, which switches nothing on', async () => {
    callerIs(RESTRICTED_ADMIN);
    const held = toEngineCustomRole(roleRecord());
    assignment = {
      member: { ...target('developer'), customRole: held },
      next: roleRecord({
        id: OTHER_ROLE_ID,
        name: 'Read-only',
        accessCeiling: { nonProduction: 'read', production: 'none' },
      }),
      grants: [PRODUCTION_WRITE],
    };

    const response = await assign(OTHER_ROLE_ID);

    expect(response.status).toBe(200);
    expect(await outcomes('success')).toMatchObject([
      {
        metadata: {
          customRoleId: OTHER_ROLE_ID,
          previousCustomRoleId: ROLE_ID,
          previousCustomRoleName: 'Deployer',
        },
      },
    ]);
  });

  it('gates putting somebody on a role by plan, but never taking them off', async () => {
    planIs('free');

    const onto = await assign(ROLE_ID);
    expect(onto.status).toBe(403);
    expect((await errorOf(onto)).code).toBe('plan_limit');
    expect(written).not.toHaveBeenCalled();
    expect(await outcomes('error')).toMatchObject([
      {
        action: 'member.custom_role_changed',
        metadata: { reason: 'quotaExceeded', customRoleName: 'Deployer' },
      },
    ]);

    const held = toEngineCustomRole(roleRecord());
    assignment = { member: { ...target('developer'), customRole: held }, next: null, grants: [] };
    const off = await assign(null);
    expect(off.status).toBe(200);
  });

  it('writes, records and gates nothing for asking for the role already held — on any plan', async () => {
    planIs('free');
    const held = toEngineCustomRole(roleRecord());
    assignment = { ...assignment, member: { ...target('developer'), customRole: held } };

    const response = await assign(ROLE_ID);

    expect(response.status).toBe(200);
    expect(written).not.toHaveBeenCalled();
    expect(await recorded()).toEqual([]);
    expect(memberKeys.reconcileMemberKeyAccess).not.toHaveBeenCalled();
  });

  it('takes exactly one change per request', async () => {
    const response = await patchMemberRoute(
      request('PATCH', `/api/orgs/acme/members/${TARGET_MEMBER_ID}`, {
        role: 'viewer',
        customRoleId: ROLE_ID,
      }),
      memberParams,
    );

    expect(response.status).toBe(422);
  });

  it('keeps the custom role off the response after a promotion to owner clears it', async () => {
    const held = toEngineCustomRole(roleRecord());
    repositories.findMemberWithUser.mockResolvedValue(target('admin', held));
    repositories.listGrantsForMember.mockResolvedValue([]);
    repositories.updateMemberRole.mockImplementation(
      async (
        _db: unknown,
        _params: unknown,
        guard: (change: { member: unknown; grants: readonly unknown[] }) => void,
      ) => {
        // The guard sees the member as the lock finds them, custom role included.
        guard({ member: target('admin', held), grants: [] });
        return {
          id: TARGET_MEMBER_ID,
          orgId: ORG_ID,
          userId: TARGET_USER_ID,
          role: 'owner',
          status: 'active',
          clearedCustomRole: { id: ROLE_ID, name: 'Deployer' },
        };
      },
    );

    const response = await patchMemberRoute(
      request('PATCH', `/api/orgs/acme/members/${TARGET_MEMBER_ID}`, { role: 'owner' }),
      memberParams,
    );

    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { member: { customRole: unknown } }).member.customRole,
    ).toBeNull();
  });
});

/* ── The viewer's authority ───────────────────────────────────────────────── */

describe('GET /authority', () => {
  it('offers a production-capped admin nothing to grant on production', async () => {
    callerIs(PRODUCTION_CAPPED);

    const response = await authorityRoute(request('GET', '/api/orgs/acme/authority'), orgParams);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      grantable: { projectSlug: string; environmentSlug: string; accessLevel: string }[];
    };
    expect(body.grantable).toEqual([
      { projectSlug: 'api', environmentSlug: 'staging', accessLevel: 'admin' },
      { projectSlug: 'api', environmentSlug: 'production', accessLevel: 'none' },
    ]);
    // The rest of the caller's authority comes with the session, once.
    expect(Object.keys(body)).toEqual(['grantable']);
  });

  it('measures a plain admin’s explicit restriction too', async () => {
    callerIs(RESTRICTED_ADMIN);

    const response = await authorityRoute(request('GET', '/api/orgs/acme/authority'), orgParams);
    const body = (await response.json()) as { grantable: { accessLevel: string }[] };

    expect(body.grantable.map((entry) => entry.accessLevel)).toEqual(['admin', 'read']);
  });
});

describe('GET /api/auth/me — effective authority per organisation', () => {
  it('sends the stored role as the label, and what the custom role leaves as the authority', async () => {
    repositories.findVaultKeys.mockResolvedValue(null);
    repositories.listOrganizationsForUser.mockResolvedValue([
      {
        organization: { id: ORG_ID, name: 'Acme', slug: 'acme' },
        role: 'admin',
        customRole: MEMBER_MANAGER.customRole,
      },
      {
        organization: { id: uuidv7(), name: 'Beta', slug: 'beta' },
        role: 'developer',
        customRole: undefined,
      },
    ]);

    const response = await meRoute(request('GET', '/api/auth/me'), { params: Promise.resolve({}) });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      organizations: {
        role: string;
        authority: {
          effectiveRole: string;
          customRole: { name: string } | null;
          capabilities: string[];
          assignableRoles: string[];
          definableBaseRoles: string[];
        };
      }[];
    };
    const [narrowed, plain] = body.organizations;
    expect(narrowed!.role).toBe('admin');
    expect(narrowed!.authority).toMatchObject({
      effectiveRole: 'admin',
      customRole: { name: 'Member manager' },
      capabilities: ['member.read', 'member.invite', 'member.update', 'member.remove'],
      assignableRoles: [],
      definableBaseRoles: [],
    });
    expect(plain!.authority).toMatchObject({
      effectiveRole: 'developer',
      customRole: null,
      // A developer hands no role out through any route, so none is listed.
      assignableRoles: [],
      definableBaseRoles: [],
    });
  });
});

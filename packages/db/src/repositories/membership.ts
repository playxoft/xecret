import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';
import type { GetColumnData, InferColumnsDataTypes } from 'drizzle-orm';
import type { AccessLevel, CustomRole, OrgRole } from '@xecret/core/authz';
import { uuidv7 } from '@xecret/core/ids';
import { accessGrants } from '../schema/access';
import { customRoles } from '../schema/roles';
import { users } from '../schema/identity';
import { environments, projects } from '../schema/resources';
import { orgMembers, organizations } from '../schema/tenancy';
import { RepositoryError, clampPageSize } from './shared';
import type { Executor } from './shared';

/**
 * Membership and access grants — what the authorization engine reads, and the
 * writes that change it. See docs/architecture/database-schema.md §2 and §6.
 *
 * Two rules apply to everything in this file.
 *
 * **Cross-tenant (threat T2).** Every function that takes an `orgId` and a child
 * id filters on both, so a caller presenting a valid id from another tenant gets
 * `null` or `notFound` rather than a row. The route layer checks authorization
 * first; this layer never assumes it did. Defence in depth at the query is what
 * makes an authorization bug non-exploitable rather than merely unlikely.
 *
 * **The last-owner invariant.** An organisation always retains at least one
 * active owner. It is enforced here, inside the transaction that performs the
 * write, because getting it wrong locks an organisation out of its own account
 * with no self-service repair.
 */

export type MemberStatus = (typeof orgMembers.$inferSelect)['status'];

export interface MemberRecord {
  id: string;
  orgId: string;
  userId: string;
  role: OrgRole;
  status: MemberStatus;
  /**
   * The organisation's narrowing of `role`, resolved from the joined row.
   *
   * Carried here rather than left as six loose columns so that exactly one
   * place in the codebase knows how the join maps onto the shape `can()` reads,
   * and every caller gets the same answer.
   */
  customRole?: CustomRole | undefined;
}

/** A row of `access_grants`, as the authorization engine consumes it. */
export interface MemberGrant {
  id: string;
  projectId: string;
  /** `null` means the grant covers every environment in the project. */
  environmentId: string | null;
  accessLevel: AccessLevel;
}

/**
 * Everything a permission decision depends on, loaded in one go.
 *
 * The shape mirrors what `can()` needs rather than what the tables look like.
 * The route layer adapts this to the `GrantContext` / `ResolvedGrant` types in
 * `@xecret/core/authz`; this module deliberately declares its own types instead
 * of importing them, so the storage layer and the policy layer can be reviewed —
 * and changed — independently.
 */
export interface AuthorizationContext {
  orgId: string;
  userId: string;
  memberId: string;
  role: OrgRole;
  status: MemberStatus;
  /**
   * The organisation's own narrowing of `role`, when the member holds one.
   *
   * Absent for almost everybody. `role` stays authoritative either way — this
   * only ever subtracts from it.
   */
  customRole?: CustomRole | undefined;
  grants: MemberGrant[];
}

export interface AuthorizationContextParams {
  orgId: string;
  userId: string;
  /** Narrows the grants to one project. Omit when the decision is org-wide. */
  projectId?: string | undefined;
}

export interface MemberListEntry extends MemberRecord {
  seatAssigned: boolean;
  createdAt: Date;
  user: {
    id: string;
    email: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
}

export interface PageRequest {
  /** 1-based. */
  page?: number | undefined;
  pageSize?: number | undefined;
}

export interface MemberPage {
  members: MemberListEntry[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/**
 * The columns of `org_members` a member is written and returned as.
 *
 * `org_members` alone, on purpose. This is the set every `RETURNING` uses, and a
 * `RETURNING` list can name only the table being written — a `custom_roles`
 * column in it fails the statement, which is every membership write at once. It
 * is also what the lookups that decide nothing about access read: the last-owner
 * guard needs a role and a status, not the narrowing on top of them.
 */
const MEMBER_COLUMNS = {
  id: orgMembers.id,
  orgId: orgMembers.orgId,
  userId: orgMembers.userId,
  role: orgMembers.role,
  status: orgMembers.status,
} as const;

/**
 * The narrowing, carried on the same row that carries the role it narrows.
 *
 * Joined rather than fetched separately because it is read on every
 * authorization decision, and a second query per request to answer a question
 * that is NULL for almost everybody would be paid by everybody.
 *
 * Never selected without `customRoleJoin()` in the same statement: every column
 * but the first belongs to `custom_roles`, and PostgreSQL refuses a column whose
 * table is not in the `FROM` clause.
 */
const JOINED_MEMBER_COLUMNS = {
  ...MEMBER_COLUMNS,
  customRoleId: orgMembers.customRoleId,
  customRoleName: customRoles.name,
  customRoleBase: customRoles.baseRole,
  customRoleActions: customRoles.allowedActions,
  customRoleCeilingNonProduction: customRoles.ceilingNonProduction,
  customRoleCeilingProduction: customRoles.ceilingProduction,
} as const;

/** What the roster and the single-member page read: the joined member and the person. */
const MEMBER_LIST_COLUMNS = {
  ...JOINED_MEMBER_COLUMNS,
  seatAssigned: orgMembers.seatAssigned,
  createdAt: orgMembers.createdAt,
  user: {
    id: users.id,
    email: users.email,
    displayName: users.displayName,
    avatarUrl: users.avatarUrl,
  },
} as const;

type CustomRoleColumns = Omit<typeof JOINED_MEMBER_COLUMNS, keyof typeof MEMBER_COLUMNS>;

/**
 * One joined row, derived from the column sets so that adding a column is one
 * edit. The `custom_roles` half is nullable whatever the table says: the join is
 * LEFT, so it is all nulls for a member who holds no role.
 */
type JoinedMemberRow = InferColumnsDataTypes<typeof MEMBER_COLUMNS> & {
  [K in keyof CustomRoleColumns]: GetColumnData<CustomRoleColumns[K]> | null;
};

/**
 * The one join condition onto `custom_roles`, used by every query that selects
 * `JOINED_MEMBER_COLUMNS`.
 *
 * LEFT, because almost every member has no custom role and an inner join would
 * make them all disappear — which would read as "not a member" and deny them
 * everything.
 *
 * Both columns, not the id alone. The role must belong to the organisation the
 * membership does, so a row pointing at another tenant's role — a bug, or a
 * write by somebody who reached the database — can never be what shapes this
 * organisation's authorization. The composite foreign key says the same thing
 * at the schema; this is the read refusing to depend on it.
 */
function customRoleJoin() {
  return and(eq(customRoles.id, orgMembers.customRoleId), eq(customRoles.orgId, orgMembers.orgId));
}

/** What an unresolved reference is called wherever the role's name is shown. */
const UNRESOLVED_CUSTOM_ROLE_NAME = 'Unresolved custom role';

/**
 * Rebuilds the `CustomRole` the engine consumes from the joined columns.
 *
 * Returns `undefined` — not a permissive default — when the member holds no
 * custom role, so the common path hands `can()` exactly what it handed before
 * this column existed.
 *
 * ── A reference the join did not resolve ──
 * `custom_role_id` set with nothing joined should be impossible — the composite
 * foreign key admits neither a dangling reference nor one into another
 * organisation — so seeing it means that guarantee was lost somewhere. Reading
 * it as "no custom role" would hand the member their full built-in role: the
 * silent widening `ON DELETE RESTRICT` exists to prevent, arrived at by another
 * route. So it resolves to a role that permits nothing and reaches nothing, and
 * the member stays shut out until somebody repairs the row on purpose.
 *
 * A row whose ceiling columns are half-set cannot exist: `custom_roles_ceiling_check`
 * forbids it at the database. The check here is for the type, not the data.
 */
function toCustomRole(row: JoinedMemberRow): CustomRole | undefined {
  if (row.customRoleId === null) return undefined;

  if (
    row.customRoleName === null ||
    row.customRoleBase === null ||
    row.customRoleActions === null
  ) {
    return {
      id: row.customRoleId,
      name: UNRESOLVED_CUSTOM_ROLE_NAME,
      baseRole: row.role,
      allowedActions: [],
      accessCeiling: { nonProduction: 'none', production: 'none' },
    };
  }

  const ceiling =
    row.customRoleCeilingNonProduction !== null && row.customRoleCeilingProduction !== null
      ? {
          nonProduction: row.customRoleCeilingNonProduction,
          production: row.customRoleCeilingProduction,
        }
      : undefined;

  return {
    id: row.customRoleId,
    name: row.customRoleName,
    baseRole: row.customRoleBase,
    allowedActions: row.customRoleActions,
    ...(ceiling ? { accessCeiling: ceiling } : {}),
  };
}

/**
 * One joined row, as the rest of this module wants it.
 *
 * The only place the loose `customRole*` columns are read. Everything that
 * leaves this module carries `customRole` or nothing, so the columns cannot
 * reach a caller — or a response body built from one.
 */
function toMemberRecord(row: JoinedMemberRow): MemberRecord {
  const customRole = toCustomRole(row);
  return {
    id: row.id,
    orgId: row.orgId,
    userId: row.userId,
    role: row.role,
    status: row.status,
    ...(customRole ? { customRole } : {}),
  };
}

/** Likewise for the roster's rows, which add the person to the member. */
function toMemberListEntry(
  row: JoinedMemberRow & Omit<MemberListEntry, keyof MemberRecord>,
): MemberListEntry {
  return {
    ...toMemberRecord(row),
    seatAssigned: row.seatAssigned,
    createdAt: row.createdAt,
    user: row.user,
  };
}

/** The columns a grant is read and returned as, kept in one place. */
const GRANT_COLUMNS = {
  id: accessGrants.id,
  projectId: accessGrants.projectId,
  environmentId: accessGrants.environmentId,
  accessLevel: accessGrants.accessLevel,
} as const;

export async function findMembership(
  exec: Executor,
  orgId: string,
  userId: string,
): Promise<MemberRecord | null> {
  const [row] = await membershipQuery(exec, orgId, userId);
  return row ? toMemberRecord(row) : null;
}

/**
 * Loads the member and every grant a decision could depend on.
 *
 * Two queries, and the second is skipped entirely when there is no membership —
 * which is the path a cross-tenant probe takes, so the cheapest case is also the
 * hostile one. What this must never become is a query per project or per
 * environment: authorization runs on every request, and an N+1 there is a
 * latency floor the product cannot recover from later.
 */
export async function loadAuthorizationContext(
  exec: Executor,
  params: AuthorizationContextParams,
): Promise<AuthorizationContext | null> {
  const member = await findMembership(exec, params.orgId, params.userId);
  if (!member) return null;

  const grants = await memberGrantsQuery(exec, {
    orgId: params.orgId,
    memberId: member.id,
    projectId: params.projectId,
  });

  return toAuthorizationContext(member, grants);
}

/**
 * Every active member's authorization context, in **two statements** whatever
 * the size of the roster.
 *
 * ── Why this exists rather than a loop over `loadAuthorizationContext` ──
 * Some questions are about the whole organisation at once — "who may read this
 * environment?" is the one that matters, because it is what decides an
 * environment key's grant set. Asked member by member it costs two round trips
 * per person, and — far worse — it has to be *paginated*, which means the answer
 * silently stops being a set and becomes a page. A grant set computed from a page
 * is a silent revocation of everybody past it, which is precisely the failure the
 * completeness check exists to prevent.
 *
 * So the roster is read whole and the grants are read whole, and the pairing
 * happens in memory. There is no `LIMIT` anywhere here **on purpose**: an
 * organisation's membership is bounded by its seat count, both result sets are
 * narrow rows of ids, and a truncated answer would be worse than a slow one by a
 * margin that is not close.
 *
 * Narrow it with `projectId` when the question is about one project.
 * `resolveAccessLevel` only ever consults grants whose `projectId` matches the
 * resource, so dropping the rest changes no decision and is what keeps the second
 * statement proportional to the project rather than to the organisation.
 *
 * **Only active members are returned.** A suspended member resolves to `none`
 * everywhere through `resolveAccessLevel`, and a removed one has no row — so
 * absence here means the same thing `loadAuthorizationContext` returning `null`
 * means, and callers need no second rule.
 */
export async function loadOrganizationAuthorizationContexts(
  exec: Executor,
  params: { orgId: string; projectId?: string | undefined },
): Promise<AuthorizationContext[]> {
  const members = await exec
    .select(JOINED_MEMBER_COLUMNS)
    .from(orgMembers)
    .innerJoin(users, and(eq(users.id, orgMembers.userId), isNull(users.deletedAt)))
    .innerJoin(
      organizations,
      and(eq(organizations.id, orgMembers.orgId), isNull(organizations.deletedAt)),
    )
    .leftJoin(customRoles, customRoleJoin())
    .where(and(eq(orgMembers.orgId, params.orgId), eq(orgMembers.status, 'active')))
    .orderBy(asc(orgMembers.createdAt), asc(orgMembers.id));

  if (members.length === 0) return [];

  const grants = await exec
    .select({ ...GRANT_COLUMNS, memberId: accessGrants.orgMemberId })
    .from(accessGrants)
    .innerJoin(
      projects,
      and(
        eq(projects.id, accessGrants.projectId),
        eq(projects.orgId, params.orgId),
        isNull(projects.deletedAt),
      ),
    )
    .where(
      params.projectId === undefined ? undefined : eq(accessGrants.projectId, params.projectId),
    );

  const byMember = new Map<string, MemberGrant[]>();
  for (const { memberId, ...grant } of grants) {
    const bucket = byMember.get(memberId);
    if (bucket) bucket.push(grant);
    else byMember.set(memberId, [grant]);
  }

  // Through `toMemberRecord`, like every other joined read. Handing the raw row
  // on dropped the custom role on exactly this path — the one that decides who
  // an environment key is sealed to — so a production ceiling never applied and
  // a key went to somebody the role exists to keep out of production.
  return members.map((row) =>
    toAuthorizationContext(toMemberRecord(row), byMember.get(row.id) ?? []),
  );
}

/**
 * Takes the organisation's write lock, and confirms it exists.
 *
 * ── One lock, one ordering ──
 * The organisation row is the serialisation point for every write whose
 * correctness depends on a *set* rather than on a row: the last-owner invariant
 * counts members, and an environment key rotation's completeness check counts who
 * may read an environment. Both read a set, decide, and then write — and both are
 * wrong if the set changes in between.
 *
 * Every such transaction takes this lock **first**, so they queue behind each
 * other in one order and cannot deadlock against one another. It is the cheapest
 * serialisation that works: one row, on writes that are rare by nature, with no
 * advisory-lock bookkeeping and no `SERIALIZABLE` retry loop for callers to get
 * wrong.
 */
export async function lockOrganization(tx: Executor, orgId: string): Promise<void> {
  const [organization] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)))
    .limit(1)
    .for('update');

  if (!organization) throw new RepositoryError('notFound', 'Organisation not found.');
}

/** Pure row-to-context mapping, so the shape can be tested without a database. */
export function toAuthorizationContext(
  member: MemberRecord,
  grants: MemberGrant[],
): AuthorizationContext {
  return {
    orgId: member.orgId,
    userId: member.userId,
    memberId: member.id,
    role: member.role,
    status: member.status,
    ...(member.customRole ? { customRole: member.customRole } : {}),
    grants,
  };
}

/**
 * One member with the person behind them, or `null`.
 *
 * The route layer reaches for this whenever a member is the *target* of a
 * change: the audit record needs their address, and the member page needs
 * their identity. The soft-deleted-user join matches `membersPageQuery` — a
 * member whose account is gone is not a row anyone may act on.
 */
export async function findMemberWithUser(
  exec: Executor,
  orgId: string,
  memberId: string,
): Promise<MemberListEntry | null> {
  const [row] = await exec
    .select(MEMBER_LIST_COLUMNS)
    .from(orgMembers)
    .innerJoin(users, and(eq(users.id, orgMembers.userId), isNull(users.deletedAt)))
    .leftJoin(customRoles, customRoleJoin())
    .where(and(eq(orgMembers.id, memberId), eq(orgMembers.orgId, orgId)))
    .limit(1);

  return row ? toMemberListEntry(row) : null;
}

export async function listMembers(
  exec: Executor,
  orgId: string,
  page: PageRequest = {},
): Promise<MemberPage> {
  const pageSize = clampPageSize(page.pageSize);
  const pageNumber = clampPageNumber(page.page);
  const rows = await membersPageQuery(exec, orgId, pageNumber, pageSize);

  return {
    members: rows.slice(0, pageSize).map(toMemberListEntry),
    page: pageNumber,
    pageSize,
    hasMore: rows.length > pageSize,
  };
}

export interface AddMemberParams {
  orgId: string;
  userId: string;
  role: OrgRole;
  /** The user who issued the invitation; `null` when the member created the org. */
  invitedBy: string | null;
}

/**
 * Adds a member.
 *
 * `ON CONFLICT DO NOTHING` rather than an existence check: `org_members_org_user_unique`
 * is the arbiter either way, and an empty result is a complete answer. The case
 * this handles is ordinary — one invitation link opened in two tabs — and it must
 * read as a conflict, not as a 500 from an escaped driver error.
 *
 * The record carries no `customRole`, and here that is simply true: a member is
 * created without one.
 */
export async function addMember(exec: Executor, params: AddMemberParams): Promise<MemberRecord> {
  const now = new Date();
  const [row] = await exec
    .insert(orgMembers)
    .values({
      id: uuidv7(),
      orgId: params.orgId,
      userId: params.userId,
      role: params.role,
      status: 'active',
      invitedBy: params.invitedBy,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [orgMembers.orgId, orgMembers.userId] })
    .returning(MEMBER_COLUMNS);

  if (!row) {
    throw new RepositoryError('conflict', 'That user is already a member of this organisation.');
  }

  return row;
}

export interface UpdateMemberRoleParams {
  orgId: string;
  memberId: string;
  role: OrgRole;
}

/**
 * Changes a member's role, refusing to demote the last active owner.
 *
 * ── What the returned record leaves out ──
 * This and the other status writes below return the row as `RETURNING` sees it,
 * which is `org_members` alone, so the record has **no `customRole`** even when
 * the member holds one. Treat it as "the write landed, with this role and
 * status", not as an authorization answer; read `findMembership` or
 * `findMemberWithUser` when the narrowing matters.
 */
export async function updateMemberRole(
  exec: Executor,
  params: UpdateMemberRoleParams,
): Promise<MemberRecord> {
  return exec.transaction(async (tx) => {
    const member = await lockOrgAndLoadMember(tx, params.orgId, params.memberId);
    await assertOwnershipSurvives(tx, member, { role: params.role, status: member.status });

    const [row] = await tx
      .update(orgMembers)
      .set({ role: params.role, updatedAt: new Date() })
      .where(and(eq(orgMembers.id, params.memberId), eq(orgMembers.orgId, params.orgId)))
      .returning(MEMBER_COLUMNS);

    if (!row) throw new RepositoryError('notFound', 'Member not found in this organisation.');
    return row;
  });
}

export interface MemberRef {
  orgId: string;
  memberId: string;
}

/**
 * Removes a member, refusing to remove the last active owner.
 *
 * Their access grants go with them: `access_grants.org_member_id` is
 * `ON DELETE CASCADE`, so no grant can outlive the membership it qualified.
 */
export async function removeMember(exec: Executor, params: MemberRef): Promise<void> {
  await exec.transaction(async (tx) => {
    const member = await lockOrgAndLoadMember(tx, params.orgId, params.memberId);
    await assertOwnershipSurvives(tx, member, null);

    await tx
      .delete(orgMembers)
      .where(and(eq(orgMembers.id, params.memberId), eq(orgMembers.orgId, params.orgId)));
  });
}

/**
 * Suspends a member without deleting their history.
 *
 * Runs the same last-owner guard as removal: a suspended owner is not an active
 * owner, so suspending the only one strands the organisation just as thoroughly
 * as deleting them.
 *
 * Returns the record without `customRole`, as `updateMemberRole` explains.
 */
export async function suspendMember(exec: Executor, params: MemberRef): Promise<MemberRecord> {
  return exec.transaction(async (tx) => {
    const member = await lockOrgAndLoadMember(tx, params.orgId, params.memberId);
    await assertOwnershipSurvives(tx, member, { role: member.role, status: 'suspended' });

    const [row] = await tx
      .update(orgMembers)
      .set({ status: 'suspended', updatedAt: new Date() })
      .where(and(eq(orgMembers.id, params.memberId), eq(orgMembers.orgId, params.orgId)))
      .returning(MEMBER_COLUMNS);

    if (!row) throw new RepositoryError('notFound', 'Member not found in this organisation.');
    return row;
  });
}

/**
 * Reverses a suspension.
 *
 * No last-owner guard: adding an active member back can only strengthen the
 * ownership invariant, never violate it. The transaction and lock are still
 * taken so the write serialises with the guards that do count owners — a
 * reinstatement racing a demotion must not slip between its count and commit.
 *
 * Returns the record without `customRole`, as `updateMemberRole` explains.
 */
export async function reinstateMember(exec: Executor, params: MemberRef): Promise<MemberRecord> {
  return exec.transaction(async (tx) => {
    const member = await lockOrgAndLoadMember(tx, params.orgId, params.memberId);

    const [row] = await tx
      .update(orgMembers)
      .set({ status: 'active', updatedAt: new Date() })
      .where(and(eq(orgMembers.id, member.id), eq(orgMembers.orgId, params.orgId)))
      .returning(MEMBER_COLUMNS);

    if (!row) throw new RepositoryError('notFound', 'Member not found in this organisation.');
    return row;
  });
}

export interface AccessGrantParams {
  orgId: string;
  memberId: string;
  projectId: string;
  /** `null` or omitted grants the whole project. */
  environmentId?: string | null | undefined;
  accessLevel: AccessLevel;
  grantedBy: string;
}

/**
 * Creates or replaces one member's grant on a project or a single environment.
 *
 * Expressed as update-then-insert rather than `ON CONFLICT DO UPDATE` because
 * `access_grants_unique_idx` is an *expression* index — it keys on
 * `COALESCE(environment_id, …)` so that two project-wide grants collide, which a
 * plain unique constraint would not catch, since PostgreSQL treats NULLs as
 * distinct. Inferring that index requires a conflict target repeating the
 * expression verbatim, and Drizzle's `onConflictDoUpdate` can only name columns.
 *
 * The sequence is still safe under concurrency: `DO NOTHING` absorbs the insert
 * that loses a race, and the retry then updates the row the winner created. The
 * index remains the arbiter — nothing here assumes it won.
 */
export async function upsertAccessGrant(
  exec: Executor,
  params: AccessGrantParams,
): Promise<MemberGrant> {
  const environmentId = params.environmentId ?? null;

  return exec.transaction(async (tx) => {
    await requireMember(tx, params.orgId, params.memberId);
    await requireProjectScope(tx, params.orgId, params.projectId, environmentId);

    // The organisation's write lock, before anything is written. A grant change
    // moves who may read an environment, and an environment key rotation decides
    // its grant set from exactly that answer — so the two must not interleave, or
    // a rotation seals the brand-new key to somebody whose access was revoked a
    // millisecond after it looked. See `lockOrganization`.
    await lockOrganization(tx, params.orgId);

    const now = new Date();
    const scope = grantScope(params.projectId, environmentId);

    const applyUpdate = async (): Promise<MemberGrant | null> => {
      const [row] = await tx
        .update(accessGrants)
        .set({ accessLevel: params.accessLevel, grantedBy: params.grantedBy, updatedAt: now })
        .where(and(eq(accessGrants.orgMemberId, params.memberId), scope))
        .returning(GRANT_COLUMNS);
      return row ?? null;
    };

    const updated = await applyUpdate();
    if (updated) return updated;

    const [inserted] = await tx
      .insert(accessGrants)
      .values({
        id: uuidv7(),
        orgMemberId: params.memberId,
        projectId: params.projectId,
        environmentId,
        accessLevel: params.accessLevel,
        grantedBy: params.grantedBy,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning(GRANT_COLUMNS);
    if (inserted) return inserted;

    const retried = await applyUpdate();
    if (!retried) throw new RepositoryError('conflict', 'The grant changed while being written.');
    return retried;
  });
}

export interface RemoveAccessGrantParams {
  orgId: string;
  memberId: string;
  projectId: string;
  environmentId?: string | null | undefined;
}

/**
 * Removes a grant, falling back to the member's role default.
 *
 * Returns whether a row was actually removed, so the caller can tell "revoked"
 * from "there was nothing to revoke" in the audit record.
 */
export async function removeAccessGrant(
  exec: Executor,
  params: RemoveAccessGrantParams,
): Promise<boolean> {
  const environmentId = params.environmentId ?? null;

  return exec.transaction(async (tx) => {
    await requireMember(tx, params.orgId, params.memberId);

    // Same lock and same reason as `upsertAccessGrant`: narrowing access is the
    // half of the pair a rotation must not be able to miss.
    await lockOrganization(tx, params.orgId);

    const result = await tx
      .delete(accessGrants)
      .where(
        and(
          eq(accessGrants.orgMemberId, params.memberId),
          grantScope(params.projectId, environmentId),
        ),
      );

    return result.count > 0;
  });
}

export async function listGrantsForMember(
  exec: Executor,
  orgId: string,
  memberId: string,
): Promise<MemberGrant[]> {
  return memberGrantsQuery(exec, { orgId, memberId });
}

/**
 * Every grant in the organisation, each row naming its member.
 *
 * One query instead of one per member, for the callers that answer a question
 * across the whole roster — "which projects can each member reach" on the
 * member list. The `projects` join carries the same tenancy assertion as
 * `memberGrantsQuery`: a grant row pointing at another tenant's project, or at
 * a soft-deleted one, does not come back.
 */
export async function listGrantsForOrganization(
  exec: Executor,
  orgId: string,
): Promise<(MemberGrant & { memberId: string })[]> {
  return exec
    .select({ ...GRANT_COLUMNS, memberId: accessGrants.orgMemberId })
    .from(accessGrants)
    .innerJoin(
      projects,
      and(
        eq(projects.id, accessGrants.projectId),
        eq(projects.orgId, orgId),
        isNull(projects.deletedAt),
      ),
    );
}

export interface OwnershipChange {
  /** Active owners in the organisation, counted with the member being changed. */
  activeOwnerCount: number;
  memberIsActiveOwner: boolean;
  /** Whether the member is still an active owner once the change is applied. */
  remainsActiveOwner: boolean;
}

/**
 * The decision behind the `lastOwner` guard, as a pure predicate.
 *
 * Separated from the SQL so every case can be tested exhaustively without a
 * database — including the ones that never occur in practice today, which are
 * exactly the ones a later refactor would get wrong.
 */
export function wouldStrandOrganization(change: OwnershipChange): boolean {
  if (!change.memberIsActiveOwner) return false;
  if (change.remainsActiveOwner) return false;
  return change.activeOwnerCount <= 1;
}

/**
 * @internal Exported so `identity.test.ts` can assert that the tenancy predicate
 * is present in the generated SQL rather than trusting that it is.
 *
 * The join to `organizations` means a soft-deleted organisation stops resolving
 * for every member at once, instead of each caller remembering to check.
 */
export function membershipQuery(exec: Executor, orgId: string, userId: string) {
  return exec
    .select(JOINED_MEMBER_COLUMNS)
    .from(orgMembers)
    .innerJoin(
      organizations,
      and(eq(organizations.id, orgMembers.orgId), isNull(organizations.deletedAt)),
    )
    .leftJoin(customRoles, customRoleJoin())
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
    .limit(1);
}

/**
 * @internal Exported for SQL-shape assertions.
 *
 * The join to `projects` is not decoration. It re-asserts that every grant
 * belongs to the organisation being asked about, so a grant row pointing at
 * another tenant's project — a bug, or a write by an attacker who reached the
 * database — cannot influence a permission decision. It also drops grants on
 * soft-deleted projects, which would otherwise keep granting access to a project
 * nobody can see.
 */
export function memberGrantsQuery(
  exec: Executor,
  params: { orgId: string; memberId: string; projectId?: string | undefined },
) {
  return exec
    .select(GRANT_COLUMNS)
    .from(accessGrants)
    .innerJoin(
      projects,
      and(
        eq(projects.id, accessGrants.projectId),
        eq(projects.orgId, params.orgId),
        isNull(projects.deletedAt),
      ),
    )
    .where(
      and(
        eq(accessGrants.orgMemberId, params.memberId),
        params.projectId === undefined ? undefined : eq(accessGrants.projectId, params.projectId),
      ),
    );
}

/**
 * @internal Exported for SQL-shape assertions.
 *
 * Reads one row more than the page needs, which answers "is there a next page?"
 * without a second `COUNT(*)` over every member of the organisation. Ordering by
 * `created_at` then `id` is stable: `id` is a UUIDv7, so ties within a
 * millisecond still break in creation order rather than arbitrarily, and a row
 * cannot be skipped or repeated between pages.
 *
 * Soft-deleted users are joined out. Their access is already dead everywhere
 * else — their sessions stop resolving the moment they are deleted — and listing
 * them invites an operator to act on a row that no longer represents anyone.
 */
export function membersPageQuery(exec: Executor, orgId: string, page: number, pageSize: number) {
  return (
    exec
      .select(MEMBER_LIST_COLUMNS)
      .from(orgMembers)
      .innerJoin(users, and(eq(users.id, orgMembers.userId), isNull(users.deletedAt)))
      // The roster shows which role each member holds, and for a member on a
      // custom role the built-in name alone would be actively misleading —
      // "developer" beside somebody who cannot write anywhere.
      .leftJoin(customRoles, customRoleJoin())
      .where(eq(orgMembers.orgId, orgId))
      .orderBy(asc(orgMembers.createdAt), asc(orgMembers.id))
      .limit(pageSize + 1)
      .offset((page - 1) * pageSize)
  );
}

/**
 * Serialises membership changes for one organisation, and returns the member the
 * change targets.
 *
 * The lock is taken on the *organisation* row, not on the member being changed,
 * and that is the entire point. "At least one active owner" is a property of the
 * set of members, so locking individual member rows does not prevent the race:
 * two transactions demoting two different owners lock two different rows, each
 * counts two active owners, each concludes it is safe, and both commit. The
 * organisation is then left with no owner — permanently, with no self-service
 * repair, because changing a role requires an owner or an admin.
 *
 * Locking the parent row forces the second transaction to wait and then count
 * again under the first one's committed effect, so it sees one owner and is
 * rejected. `SELECT … FOR UPDATE` is the cheapest serialisation that achieves
 * this: one row, on writes that are rare by nature, with no advisory-lock
 * bookkeeping and no `SERIALIZABLE` retry loop for callers to get wrong.
 *
 * The member is read with `MEMBER_COLUMNS` and no custom-role join: the
 * last-owner guard is the only reader, and it asks about role and status alone.
 */
async function lockOrgAndLoadMember(
  tx: Executor,
  orgId: string,
  memberId: string,
): Promise<MemberRecord> {
  await lockOrganization(tx, orgId);

  const [member] = await tx
    .select(MEMBER_COLUMNS)
    .from(orgMembers)
    .where(and(eq(orgMembers.id, memberId), eq(orgMembers.orgId, orgId)))
    .limit(1);
  if (!member) throw new RepositoryError('notFound', 'Member not found in this organisation.');

  return member;
}

/**
 * Rejects a change that would leave the organisation with no active owner.
 *
 * `next` is the member's role and status after the change, or `null` when the
 * member is being removed. Must be called inside the transaction that performs
 * the write, after `lockOrgAndLoadMember` — the count is only meaningful while
 * the organisation row is locked.
 */
async function assertOwnershipSurvives(
  tx: Executor,
  member: MemberRecord,
  next: { role: OrgRole; status: MemberStatus } | null,
): Promise<void> {
  const memberIsActiveOwner = member.role === 'owner' && member.status === 'active';
  // Changing anyone else cannot strand the organisation, so do not spend a count.
  if (!memberIsActiveOwner) return;

  const change: OwnershipChange = {
    activeOwnerCount: await countActiveOwners(tx, member.orgId),
    memberIsActiveOwner,
    remainsActiveOwner: next !== null && next.role === 'owner' && next.status === 'active',
  };

  if (wouldStrandOrganization(change)) {
    throw new RepositoryError('lastOwner', 'An organisation must keep at least one active owner.');
  }
}

async function countActiveOwners(tx: Executor, orgId: string): Promise<number> {
  const [row] = await tx
    .select({ value: count() })
    .from(orgMembers)
    .where(
      and(
        eq(orgMembers.orgId, orgId),
        eq(orgMembers.role, 'owner'),
        eq(orgMembers.status, 'active'),
      ),
    );

  return row?.value ?? 0;
}

/** Matches exactly one grant row, with `NULL` meaning "the whole project". */
function grantScope(projectId: string, environmentId: string | null) {
  return and(
    eq(accessGrants.projectId, projectId),
    environmentId === null
      ? isNull(accessGrants.environmentId)
      : eq(accessGrants.environmentId, environmentId),
  );
}

/** Confirms the member is this organisation's, before anything is written for them. */
async function requireMember(exec: Executor, orgId: string, memberId: string): Promise<void> {
  const [row] = await exec
    .select({ id: orgMembers.id })
    .from(orgMembers)
    .where(and(eq(orgMembers.id, memberId), eq(orgMembers.orgId, orgId)))
    .limit(1);

  if (!row) throw new RepositoryError('notFound', 'Member not found in this organisation.');
}

/**
 * Confirms the project — and the environment, when one is named — belongs to the
 * organisation.
 *
 * `access_grants` has foreign keys to `projects` and `environments` but none to
 * `organizations`, so nothing in the schema stops a grant that points across
 * tenants. Without this check, an admin of one organisation could grant one of
 * their own members access to another organisation's project by passing its id.
 */
async function requireProjectScope(
  exec: Executor,
  orgId: string,
  projectId: string,
  environmentId: string | null,
): Promise<void> {
  if (environmentId === null) {
    const [row] = await exec
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId), isNull(projects.deletedAt)))
      .limit(1);

    if (!row) throw new RepositoryError('notFound', 'Project not found in this organisation.');
    return;
  }

  const [row] = await exec
    .select({ id: environments.id })
    .from(environments)
    .innerJoin(projects, and(eq(projects.id, environments.projectId), eq(projects.orgId, orgId)))
    .where(
      and(
        eq(environments.id, environmentId),
        eq(environments.projectId, projectId),
        isNull(environments.deletedAt),
        isNull(projects.deletedAt),
      ),
    )
    .limit(1);

  if (!row) throw new RepositoryError('notFound', 'Environment not found in this organisation.');
}

/** Mirrors `clampPageSize`: an out-of-range page number is a clamp, not an error. */
function clampPageNumber(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return 1;
  return Math.max(Math.trunc(requested), 1);
}

/** One organisation as account deletion sees it. */
export interface AccountMembership {
  orgId: string;
  orgName: string;
  /** The `org_members.id` of the leaver's row — what `removeMember` takes. */
  memberId: string;
  role: OrgRole;
  status: MemberStatus;
  /** Every membership row in the organisation, the leaver and any status included. */
  totalMembers: number;
  /** Active owners including the leaver, when they are one. */
  activeOwners: number;
}

/**
 * Every live organisation a user belongs to, with the counts that decide what
 * their departure means: alone → the organisation goes with them; the only
 * active owner among others → they cannot leave until ownership moves;
 * otherwise → plain removal.
 *
 * One statement, counts included, so the deletion transaction classifies from
 * a single consistent read rather than from N follow-up queries that can each
 * see a different moment. `totalMembers` counts every status on purpose: an
 * organisation whose only other members are suspended is still somebody
 * else's — suspension is reversible, so their presence keeps it alive, and
 * the leaver's departure must not erase it under them.
 *
 * Ordered with the same tiebreaker as `organizationsForUserQuery`, for the same
 * reason: `organizations.name` carries no unique constraint, and a deletion
 * preview that lists the same organisations in a different order each time it is
 * opened is a confirmation screen nobody can check.
 */
export async function accountMembershipSummary(
  exec: Executor,
  userId: string,
): Promise<AccountMembership[]> {
  return exec
    .select({
      orgId: organizations.id,
      orgName: organizations.name,
      memberId: orgMembers.id,
      role: orgMembers.role,
      status: orgMembers.status,
      totalMembers: sql<number>`(
        select count(*)::int from org_members counted
        where counted.org_id = ${organizations.id}
      )`,
      activeOwners: sql<number>`(
        select count(*)::int from org_members counted
        where counted.org_id = ${organizations.id}
          and counted.status = 'active' and counted.role = 'owner'
      )`,
    })
    .from(orgMembers)
    .innerJoin(
      organizations,
      and(eq(orgMembers.orgId, organizations.id), isNull(organizations.deletedAt)),
    )
    .where(eq(orgMembers.userId, userId))
    .orderBy(asc(organizations.name), asc(organizations.id));
}

import { and, asc, count, eq, isNull } from 'drizzle-orm';
import type { AccessLevel, OrgRole } from '@xecret/core/authz';
import { uuidv7 } from '@xecret/core/ids';
import { accessGrants } from '../schema/access';
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

/** The columns a member is read and returned as, kept in one place. */
const MEMBER_COLUMNS = {
  id: orgMembers.id,
  orgId: orgMembers.orgId,
  userId: orgMembers.userId,
  role: orgMembers.role,
  status: orgMembers.status,
} as const;

/** Likewise for a grant. */
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
  return row ?? null;
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
    grants,
  };
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
    members: rows.slice(0, pageSize),
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

/** Changes a member's role, refusing to demote the last active owner. */
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
  await requireMember(exec, params.orgId, params.memberId);

  const result = await exec
    .delete(accessGrants)
    .where(
      and(
        eq(accessGrants.orgMemberId, params.memberId),
        grantScope(params.projectId, environmentId),
      ),
    );

  return result.count > 0;
}

export async function listGrantsForMember(
  exec: Executor,
  orgId: string,
  memberId: string,
): Promise<MemberGrant[]> {
  return memberGrantsQuery(exec, { orgId, memberId });
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
    .select(MEMBER_COLUMNS)
    .from(orgMembers)
    .innerJoin(
      organizations,
      and(eq(organizations.id, orgMembers.orgId), isNull(organizations.deletedAt)),
    )
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
  return exec
    .select({
      ...MEMBER_COLUMNS,
      seatAssigned: orgMembers.seatAssigned,
      createdAt: orgMembers.createdAt,
      user: {
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
      },
    })
    .from(orgMembers)
    .innerJoin(users, and(eq(users.id, orgMembers.userId), isNull(users.deletedAt)))
    .where(eq(orgMembers.orgId, orgId))
    .orderBy(asc(orgMembers.createdAt), asc(orgMembers.id))
    .limit(pageSize + 1)
    .offset((page - 1) * pageSize);
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
 */
async function lockOrgAndLoadMember(
  tx: Executor,
  orgId: string,
  memberId: string,
): Promise<MemberRecord> {
  const [organization] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)))
    .limit(1)
    .for('update');
  if (!organization) throw new RepositoryError('notFound', 'Organisation not found.');

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

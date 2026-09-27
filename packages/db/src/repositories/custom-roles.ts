import { and, asc, count, eq, sql } from 'drizzle-orm';
import type { AccessLevel, Action, CustomRole, OrgRole } from '@xecret/core/authz';
import { uuidv7 } from '@xecret/core/ids';
import { users } from '../schema/identity';
import { customRoles } from '../schema/roles';
import { orgMembers } from '../schema/tenancy';
import {
  listGrantsForMembers,
  lockMemberRecord,
  lockOrganization,
  memberGrantsQuery,
} from './membership';
import type { MemberGrant, MemberRecord, MemberStatus, WrittenMemberRecord } from './membership';
import { RepositoryError } from './shared';
import type { Executor } from './shared';
import { isUniqueViolation } from './users';

/**
 * Custom roles: the definitions an organisation writes, and which member holds
 * which. See docs/architecture/database-schema.md §6, "Custom roles".
 *
 * ── What this module decides, and what it leaves to its caller ──
 * Nothing here decides whether the caller *may* make a change — that is a
 * comparison between the caller and what the change confers, and it lives in
 * `@xecret/core/authz` where the enforcement path can share it. What this
 * module owns is making that decision *true when the write lands*.
 *
 * Every write that changes whose authority a role shapes — editing a role,
 * moving a member onto or off one — takes the organisation's write lock
 * first, re-reads everything the decision depends on under it, and hands that
 * snapshot to a `guard` the caller supplies. The guard runs inside the
 * transaction, before anything is written, and a refusal from it rolls the
 * transaction back. So "every member holding this role is somebody the caller
 * may manage" is a statement about the members holding it *at the moment the
 * edit commits*: a concurrent assignment of the same role takes the same lock
 * and queues behind it, rather than slipping a holder in between a check and
 * a write. The alternative — the route reads, decides, then asks for a write —
 * is the time-of-check gap that would let an admin's colleague assign the role
 * to an owner-adjacent member in the half-second before the admin widens it.
 *
 * The lock is also the one an environment key rotation takes (see
 * `lockOrganization`): both kinds of write move who may read an environment,
 * and a rotation must not seal a key to a grant set that changed underneath it.
 *
 * ── Errors ──
 * The three constraints a caller can run into become `RepositoryError`s with
 * fixed messages, never a driver error: a duplicate name is `conflict`, a role
 * still held by somebody is `conflict` (the foreign key's `NO ACTION`), and an
 * owner being handed a role is `conflict` (the owner CHECK). None of them is
 * reachable through the routes, which validate first — these are what holds
 * when they are raced or bypassed.
 */

/** A ceiling as stored: both halves or neither (`custom_roles_ceiling_check`). */
export interface CustomRoleCeiling {
  nonProduction: AccessLevel;
  production: AccessLevel;
}

/** One `custom_roles` row, as the rest of the product reads it. */
export interface CustomRoleRecord {
  id: string;
  orgId: string;
  name: string;
  baseRole: OrgRole;
  allowedActions: Action[];
  /** `null` is "no ceiling": the effective role's own levels apply. */
  accessCeiling: CustomRoleCeiling | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CustomRoleListEntry extends CustomRoleRecord {
  /** Members holding the role, every status included — any of them blocks a delete. */
  holderCount: number;
}

/** What a caller writes: the definition, without the bookkeeping. */
export interface CustomRoleDefinition {
  name: string;
  baseRole: OrgRole;
  allowedActions: readonly Action[];
  accessCeiling: CustomRoleCeiling | null;
}

/**
 * How many roles one organisation may define.
 *
 * Not a plan limit — custom roles are an Enterprise feature and Enterprise has
 * no ceilings — but a bound on a table a single caller can grow, so that the
 * listing can be read whole (it has no pagination, because the settings page
 * and the assignment menu both need every role) without being a way to make
 * one request stream an unbounded set. A hundred job titles is far past what
 * an organisation's four built-in roles are ever narrowed into.
 */
export const CUSTOM_ROLES_PER_ORGANIZATION = 100;

const NAME_TAKEN = 'A role with this name already exists in this organisation.';
const ROLE_IN_USE =
  'This role is still held by members. Move them to another role, or to none, and delete it then.';
const OWNER_HOLDS_NONE = 'An owner cannot hold a custom role. Change their built-in role first.';
const ROLE_NOT_FOUND = 'Custom role not found in this organisation.';

/** The constraints this module maps, named once. */
const NAME_UNIQUE_CONSTRAINT = 'custom_roles_org_name_unique';
const MEMBER_ROLE_FK = 'org_members_org_id_custom_role_id_custom_roles_org_id_id_fk';
const OWNER_CHECK = 'org_members_owner_custom_role_check';

const ROLE_COLUMNS = {
  id: customRoles.id,
  orgId: customRoles.orgId,
  name: customRoles.name,
  baseRole: customRoles.baseRole,
  allowedActions: customRoles.allowedActions,
  ceilingNonProduction: customRoles.ceilingNonProduction,
  ceilingProduction: customRoles.ceilingProduction,
  createdAt: customRoles.createdAt,
  updatedAt: customRoles.updatedAt,
} as const;

type RoleRow = typeof customRoles.$inferSelect;

/**
 * A stored row as a record.
 *
 * A half-set ceiling cannot exist (`custom_roles_ceiling_check`); should one
 * arrive, the missing half reads as `none` — failing closed, the same reading
 * the membership join gives it (`toCustomRole` in `membership.ts`).
 */
function toRecord(row: Omit<RoleRow, 'createdBy'>): CustomRoleRecord {
  const accessCeiling =
    row.ceilingNonProduction === null && row.ceilingProduction === null
      ? null
      : {
          nonProduction: row.ceilingNonProduction ?? 'none',
          production: row.ceilingProduction ?? 'none',
        };
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    baseRole: row.baseRole,
    allowedActions: row.allowedActions,
    accessCeiling,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * A record as the authorization engine reads it — the same shape the
 * membership join produces, so a role measured before a write and the role a
 * member resolves through afterwards are one value.
 */
export function toEngineCustomRole(record: CustomRoleRecord): CustomRole {
  return {
    id: record.id,
    name: record.name,
    baseRole: record.baseRole,
    allowedActions: record.allowedActions,
    ...(record.accessCeiling === null ? {} : { accessCeiling: record.accessCeiling }),
  };
}

/** The stored columns for a definition. De-duplicated, so the row says each action once. */
function definitionColumns(definition: CustomRoleDefinition) {
  return {
    name: definition.name,
    baseRole: definition.baseRole,
    allowedActions: [...new Set(definition.allowedActions)],
    ceilingNonProduction: definition.accessCeiling?.nonProduction ?? null,
    ceilingProduction: definition.accessCeiling?.production ?? null,
  };
}

/**
 * Refuses what the schema would refuse, before the schema has to.
 *
 * `custom_roles_base_role_check` holds either way; saying so here turns a
 * CHECK violation — a 500 wherever it escapes — into an `invalid` the route
 * maps to a 400 with a sentence in it.
 */
function assertDefinable(definition: CustomRoleDefinition): void {
  if (definition.baseRole === 'owner') {
    throw new RepositoryError('invalid', 'A custom role cannot be based on owner.');
  }
}

/** The organisation's roles, with how many members hold each. Name order. */
export async function listCustomRoles(
  exec: Executor,
  orgId: string,
): Promise<CustomRoleListEntry[]> {
  const rows = await exec
    .select({
      ...ROLE_COLUMNS,
      // Correlated rather than grouped, so a role nobody holds still comes
      // back — with zero — without a LEFT JOIN and a GROUP BY over every
      // selected column. Served by `org_members_custom_role_idx`.
      //
      // The outer columns are written out qualified, not interpolated. In a
      // single-table select drizzle renders `${customRoles.id}` as a bare
      // `"id"`, and inside this subquery a bare `"id"` binds to the nearest
      // table that has one — `held`, the member row — so the count would
      // compare a member's id with its own role reference and count nothing.
      holderCount: sql<number>`(
        select count(*)::int from org_members held
        where held.org_id = "custom_roles"."org_id"
          and held.custom_role_id = "custom_roles"."id"
      )`,
    })
    .from(customRoles)
    .where(eq(customRoles.orgId, orgId))
    .orderBy(asc(customRoles.name), asc(customRoles.id))
    .limit(CUSTOM_ROLES_PER_ORGANIZATION);

  return rows.map((row) => ({ ...toRecord(row), holderCount: Number(row.holderCount) }));
}

/** One role of this organisation, or `null` — including for another tenant's id. */
export async function findCustomRole(
  exec: Executor,
  orgId: string,
  roleId: string,
): Promise<CustomRoleRecord | null> {
  const [row] = await exec
    .select(ROLE_COLUMNS)
    .from(customRoles)
    .where(and(eq(customRoles.orgId, orgId), eq(customRoles.id, roleId)))
    .limit(1);

  return row ? toRecord(row) : null;
}

export interface CreateCustomRoleParams {
  orgId: string;
  definition: CustomRoleDefinition;
  createdBy: string;
}

/**
 * Defines a role.
 *
 * A definition nobody holds confers nothing, so there is no guard: whether the
 * caller may define one on this base is the route's question, and nothing
 * about it can change under the write. The organisation lock is taken all the
 * same, for the count — two creations racing past the ceiling would otherwise
 * each see room for one more.
 */
export async function createCustomRole(
  exec: Executor,
  params: CreateCustomRoleParams,
): Promise<CustomRoleRecord> {
  assertDefinable(params.definition);

  return exec
    .transaction(async (tx) => {
      await lockOrganization(tx, params.orgId);

      const [existing] = await tx
        .select({ value: count() })
        .from(customRoles)
        .where(eq(customRoles.orgId, params.orgId));
      if ((existing?.value ?? 0) >= CUSTOM_ROLES_PER_ORGANIZATION) {
        throw new RepositoryError(
          'conflict',
          `An organisation can define at most ${CUSTOM_ROLES_PER_ORGANIZATION} roles. Delete one nobody holds first.`,
        );
      }

      const now = new Date();
      const [row] = await tx
        .insert(customRoles)
        .values({
          id: uuidv7(),
          orgId: params.orgId,
          ...definitionColumns(params.definition),
          createdBy: params.createdBy,
          createdAt: now,
          updatedAt: now,
        })
        .returning(ROLE_COLUMNS);

      if (!row) throw new RepositoryError('conflict', 'The role could not be created.');
      return toRecord(row);
    })
    .catch(roleWriteError('missing'));
}

/** One member holding a role, with everything a decision about them reads. */
export interface CustomRoleHolder {
  memberId: string;
  userId: string;
  email: string;
  role: OrgRole;
  status: MemberStatus;
  grants: MemberGrant[];
}

/** What an edit's `decide` is shown: the role as it stands, and who holds it. */
export interface CustomRoleEdit {
  current: CustomRoleRecord;
  holders: readonly CustomRoleHolder[];
}

export interface UpdateCustomRoleParams {
  orgId: string;
  roleId: string;
}

export interface UpdatedCustomRole {
  role: CustomRoleRecord;
  previous: CustomRoleRecord;
  holders: readonly CustomRoleHolder[];
}

/**
 * Replaces a role's definition with the one `decide` returns, after it has
 * seen the role as it stands and every member holding it — each with their
 * grant rows — under the organisation lock.
 *
 * `decide` both builds the new definition and refuses it: an edit is usually
 * partial, so what is written is the patch merged onto the role *as locked*,
 * and the checks on it have to run against that same merge — building it from
 * an earlier read would measure one definition and write another. Throwing
 * from it rolls the transaction back with nothing written.
 *
 * Holders are read whatever their status and whether or not their account
 * still resolves: a suspended holder is reinstated into the role as it is by
 * then, so an edit that widens it widens them too, and they are measured now
 * like everyone else.
 */
export async function updateCustomRole(
  exec: Executor,
  params: UpdateCustomRoleParams,
  decide: (edit: CustomRoleEdit) => CustomRoleDefinition,
): Promise<UpdatedCustomRole> {
  return exec
    .transaction(async (tx) => {
      await lockOrganization(tx, params.orgId);

      const [locked] = await tx
        .select(ROLE_COLUMNS)
        .from(customRoles)
        .where(and(eq(customRoles.orgId, params.orgId), eq(customRoles.id, params.roleId)))
        .limit(1)
        .for('update');
      if (!locked) throw new RepositoryError('notFound', ROLE_NOT_FOUND);
      const current = toRecord(locked);

      const holders = await holdersOf(tx, params.orgId, params.roleId);
      const definition = decide({ current, holders });
      assertDefinable(definition);

      const [row] = await tx
        .update(customRoles)
        .set({ ...definitionColumns(definition), updatedAt: new Date() })
        .where(and(eq(customRoles.orgId, params.orgId), eq(customRoles.id, params.roleId)))
        .returning(ROLE_COLUMNS);

      if (!row) throw new RepositoryError('notFound', ROLE_NOT_FOUND);
      return { role: toRecord(row), previous: current, holders };
    })
    .catch(roleWriteError('missing'));
}

export interface DeleteCustomRoleParams {
  orgId: string;
  roleId: string;
}

/**
 * Deletes a role nobody holds, after `guard` has seen it under the lock.
 *
 * Whether anybody holds it is the foreign key's answer, not a count taken
 * first: `ON DELETE NO ACTION` refuses the delete with 23503 if a single
 * member row still points at it, whatever raced, and that becomes the
 * `conflict` the route answers 409 with. Deleting a role in use would have to
 * mean either widening its holders silently or deleting them — see the
 * migration — and neither is something a delete should do.
 */
export async function deleteCustomRole(
  exec: Executor,
  params: DeleteCustomRoleParams,
  guard: (current: CustomRoleRecord) => void,
): Promise<CustomRoleRecord> {
  return exec
    .transaction(async (tx) => {
      await lockOrganization(tx, params.orgId);

      const [locked] = await tx
        .select(ROLE_COLUMNS)
        .from(customRoles)
        .where(and(eq(customRoles.orgId, params.orgId), eq(customRoles.id, params.roleId)))
        .limit(1)
        .for('update');
      if (!locked) throw new RepositoryError('notFound', ROLE_NOT_FOUND);
      const current = toRecord(locked);

      guard(current);

      await tx
        .delete(customRoles)
        .where(and(eq(customRoles.orgId, params.orgId), eq(customRoles.id, params.roleId)));

      return current;
    })
    .catch(roleWriteError('inUse'));
}

/** What an assignment's guard is shown, read under the organisation lock. */
export interface CustomRoleAssignment {
  /** The member as they stand, custom role included. */
  member: MemberRecord;
  /** The role they are being moved onto, or `null` to take theirs off. */
  next: CustomRoleRecord | null;
  /** Every grant row the member holds — what a widening change switches on. */
  grants: readonly MemberGrant[];
}

export interface SetMemberCustomRoleParams {
  orgId: string;
  memberId: string;
  /** `null` takes the member's custom role off, returning them to their built-in role. */
  customRoleId: string | null;
}

export interface MemberCustomRoleChange {
  member: WrittenMemberRecord;
  /** The role held before, or `null`. Read under the lock the write took. */
  previous: { id: string; name: string } | null;
  next: CustomRoleRecord | null;
}

/**
 * Moves a member onto a custom role, from one to another, or off theirs —
 * after `guard` has seen the member, the role and their grant rows under the
 * organisation lock.
 *
 * The member is read with the row lock the UPDATE takes anyway
 * (`lockMemberRecord`), so what the guard measures as "before" is what the
 * write replaces. The role is read in the organisation it must belong to; one
 * from another tenant is `notFound`, exactly as the composite foreign key
 * would refuse it.
 *
 * An owner is refused before the write, and the CHECK is mapped should it be
 * reached anyway: a promotion to owner clears a custom role
 * (`updateMemberRole`), and nothing may hand one back.
 */
export async function setMemberCustomRole(
  exec: Executor,
  params: SetMemberCustomRoleParams,
  guard: (assignment: CustomRoleAssignment) => void,
): Promise<MemberCustomRoleChange> {
  return exec
    .transaction(async (tx) => {
      await lockOrganization(tx, params.orgId);
      const member = await lockMemberRecord(tx, params.orgId, params.memberId);

      let next: CustomRoleRecord | null = null;
      if (params.customRoleId !== null) {
        const [row] = await tx
          .select(ROLE_COLUMNS)
          .from(customRoles)
          .where(and(eq(customRoles.orgId, params.orgId), eq(customRoles.id, params.customRoleId)))
          .limit(1);
        if (!row) throw new RepositoryError('notFound', ROLE_NOT_FOUND);
        next = toRecord(row);
      }

      const grants = await memberGrantsQuery(tx, {
        orgId: params.orgId,
        memberId: params.memberId,
      });

      guard({ member, next, grants });

      if (next !== null && member.role === 'owner') {
        throw new RepositoryError('conflict', OWNER_HOLDS_NONE);
      }

      const [row] = await tx
        .update(orgMembers)
        .set({ customRoleId: next?.id ?? null, updatedAt: new Date() })
        .where(and(eq(orgMembers.id, params.memberId), eq(orgMembers.orgId, params.orgId)))
        .returning({
          id: orgMembers.id,
          orgId: orgMembers.orgId,
          userId: orgMembers.userId,
          role: orgMembers.role,
          status: orgMembers.status,
        });

      if (!row) throw new RepositoryError('notFound', 'Member not found in this organisation.');
      return {
        member: row,
        previous:
          member.customRole === undefined
            ? null
            : { id: member.customRole.id, name: member.customRole.name },
        next,
      };
    })
    .catch(roleWriteError('missing'));
}

/**
 * Every member holding a role, each with their grant rows, in two statements.
 *
 * Joined to `users` for the address the audit trail and a refusal name, and
 * deliberately not filtered on `users.deleted_at`: a soft-deleted account's
 * membership row still holds the role, and still blocks its deletion.
 */
async function holdersOf(tx: Executor, orgId: string, roleId: string): Promise<CustomRoleHolder[]> {
  const members = await tx
    .select({
      memberId: orgMembers.id,
      userId: orgMembers.userId,
      email: users.email,
      role: orgMembers.role,
      status: orgMembers.status,
    })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.customRoleId, roleId)))
    .orderBy(asc(orgMembers.createdAt), asc(orgMembers.id));

  const grants = await listGrantsForMembers(
    tx,
    orgId,
    members.map((member) => member.memberId),
  );

  return members.map((member) => ({
    ...member,
    grants: grants
      .filter((grant) => grant.memberId === member.memberId)
      .map(({ memberId: _memberId, ...grant }) => grant),
  }));
}

/* ── Constraint violations ──────────────────────────────────────────────── */

const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';

/** Whether `error`, or anything in its cause chain, is `code` on `constraint`. */
function isViolation(error: unknown, code: string, constraint: string): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (
      'code' in current &&
      current.code === code &&
      'constraint_name' in current &&
      current.constraint_name === constraint
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Maps the constraints a custom-role write can meet onto `RepositoryError`s,
 * passing everything else — a `RepositoryError` already, a guard's refusal, a
 * lost connection — through untouched.
 *
 * The member foreign key means something different depending on which side of
 * it the write was on, so the caller says which. Raised by deleting a role, it
 * means somebody still holds it (`inUse`); raised by pointing a member at one,
 * it means the role is not this organisation's (`missing`) — which the read
 * before the write already refuses, so there it is only the backstop.
 */
function roleWriteError(foreignKey: 'inUse' | 'missing'): (cause: unknown) => never {
  return (cause) => {
    if (isUniqueViolation(cause, NAME_UNIQUE_CONSTRAINT)) {
      throw new RepositoryError('conflict', NAME_TAKEN);
    }
    if (isViolation(cause, FOREIGN_KEY_VIOLATION, MEMBER_ROLE_FK)) {
      throw foreignKey === 'inUse'
        ? new RepositoryError('conflict', ROLE_IN_USE)
        : new RepositoryError('notFound', ROLE_NOT_FOUND);
    }
    if (isViolation(cause, CHECK_VIOLATION, OWNER_CHECK)) {
      throw new RepositoryError('conflict', OWNER_HOLDS_NONE);
    }
    throw cause;
  };
}

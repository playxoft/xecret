import { and, asc, desc, eq, gt, ilike, inArray, isNull, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { OrgRole } from '@xecret/core/authz';
import type { SignInMethod } from '@xecret/core/audit';
import { orgSubscriptions } from '../schema/billing';
import { sessions, users } from '../schema/identity';
import { environments, projects } from '../schema/resources';
import { secrets } from '../schema/secrets';
import { invitations, orgMembers, organizations } from '../schema/tenancy';
import type { AdminOrganization } from './plan-grants';
import type { Executor } from './shared';

/**
 * What the admin page's monitoring tabs read: how many of everything there
 * are, every organisation and every account newest first, and one of either
 * in detail. Read-only, and only ever on an admin's request — nothing here
 * runs on a timer.
 *
 * ── What is never selected ──
 * The owner's rule for an open-source product whose staff page anyone can
 * read the code of: nothing that would break a customer's trust. xecret is the
 * *processor* for what a customer puts in — project and environment names,
 * secret names and notes, the structure, the audit trail — and the controller
 * only for the account itself. So the customer's side comes back as **counts
 * only**: no project, environment or secret is ever named here, and no
 * statement below selects a column that names one. The account side is the
 * address, the display name, when it signed up and last signed in, whether
 * the address is verified and how the last session signed in — never an IP
 * address, a user agent, a session id, a token, a key or an avatar. An
 * invitation is counted; the address it was sent to, of somebody who may never
 * have signed up, is not read at all.
 *
 * ── Soft-deleted rows are not there ──
 * An account, organisation, project, environment or secret with `deleted_at`
 * set is left out of every list and every count, and so is anything inside a
 * deleted parent: a secret counts only while its environment, its project and
 * its organisation are all live. A deleted account's memberships are not
 * counted either, nor its address shown as an owner's.
 *
 * Who may call these is the caller's question (`requireAdmin`, in the web app).
 */

/** How many owners' addresses an organisation's row carries — the longest-standing first. */
export const ADMIN_OWNER_EMAILS_SHOWN = 10;

/**
 * A position in a newest-first list: the last row's `created_at` and its id.
 *
 * `at` is the timestamp as the database holds it, to the microsecond, in UTC
 * (`2026-11-27T09:15:02.123456Z`) — never a `Date`, which keeps milliseconds.
 * A row created by `now()` carries microseconds, and a cursor rounded down to
 * the millisecond would skip every row that sorts between the two.
 */
export interface AdminCursor {
  at: string;
  id: string;
}

/** A page of a newest-first list. `nextCursor` is `null` on the last page. */
export interface AdminPage<T> {
  items: T[];
  nextCursor: AdminCursor | null;
}

/** `created_at` to the microsecond, in UTC, as ISO-8601 text — see {@link AdminCursor}. */
function cursorAt(column: typeof users.createdAt | typeof organizations.createdAt): SQL<string> {
  return sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/**
 * Rows strictly after the cursor, newest first. A row-value comparison, with
 * the bounds cast explicitly: inside a raw fragment there is no column for
 * the driver to infer a parameter's type from (`queryAuditLogs` says the same).
 */
function after(
  createdAt: typeof users.createdAt | typeof organizations.createdAt,
  id: typeof users.id | typeof organizations.id,
  cursor: AdminCursor | undefined,
): SQL | undefined {
  if (cursor === undefined) return undefined;
  return sql`(${createdAt}, ${id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`;
}

/**
 * Reads one row past the page, so the last page says it is the last — an
 * admin pressing "Load more" onto an empty page learns nothing.
 */
function paged<T extends { cursorAt: string; id: string }>(
  rows: T[],
  limit: number,
): AdminPage<Omit<T, 'cursorAt'>> {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items: items.map(({ cursorAt: _, ...rest }) => rest),
    nextCursor:
      rows.length > limit && last !== undefined ? { at: last.cursorAt, id: last.id } : null,
  };
}

/* ── the totals ───────────────────────────────────────────────────────────── */

export interface AdminTotals {
  users: number;
  organizations: number;
  projects: number;
  environments: number;
  secrets: number;
  /** Live accounts that signed up within the last seven and thirty days. */
  signups: { last7Days: number; last30Days: number };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** `count(*)` as a plain number, named for the subquery it is read out of. */
const counted = (name: string) => sql<number>`count(*)::int`.mapWith(Number).as(name);

/**
 * Everything counted, in one statement: the live accounts (and how many of
 * them are new), and the live organisations, projects, environments and
 * secrets — each counted only inside live parents. Five one-row subqueries,
 * cross-joined, so nothing is asked of the database twice.
 */
export async function countAdminTotals(exec: Executor, now: Date): Promise<AdminTotals> {
  const since = (days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();
  const signedUpSince = (days: number, name: string) =>
    sql<number>`(count(*) filter (where ${users.createdAt} >= ${since(days)}::timestamptz))::int`
      .mapWith(Number)
      .as(name);

  const accounts = exec
    .select({
      users: counted('user_total'),
      last7Days: signedUpSince(7, 'signups_7_days'),
      last30Days: signedUpSince(30, 'signups_30_days'),
    })
    .from(users)
    .where(isNull(users.deletedAt))
    .as('accounts');

  const liveOrganizations = exec
    .select({ value: counted('organization_total') })
    .from(organizations)
    .where(isNull(organizations.deletedAt))
    .as('organization_total');

  const liveProjects = exec
    .select({ value: counted('project_total') })
    .from(projects)
    .innerJoin(
      organizations,
      and(eq(organizations.id, projects.orgId), isNull(organizations.deletedAt)),
    )
    .where(isNull(projects.deletedAt))
    .as('project_total');

  const liveEnvironments = exec
    .select({ value: counted('environment_total') })
    .from(environments)
    .innerJoin(projects, and(eq(projects.id, environments.projectId), isNull(projects.deletedAt)))
    .innerJoin(
      organizations,
      and(eq(organizations.id, projects.orgId), isNull(organizations.deletedAt)),
    )
    .where(isNull(environments.deletedAt))
    .as('environment_total');

  const liveSecrets = exec
    .select({ value: counted('secret_total') })
    .from(secrets)
    .innerJoin(
      environments,
      and(eq(environments.id, secrets.environmentId), isNull(environments.deletedAt)),
    )
    .innerJoin(projects, and(eq(projects.id, environments.projectId), isNull(projects.deletedAt)))
    .innerJoin(
      organizations,
      and(eq(organizations.id, projects.orgId), isNull(organizations.deletedAt)),
    )
    .where(isNull(secrets.deletedAt))
    .as('secret_total');

  const [row] = await exec
    .select({
      users: accounts.users,
      last7Days: accounts.last7Days,
      last30Days: accounts.last30Days,
      organizations: liveOrganizations.value,
      projects: liveProjects.value,
      environments: liveEnvironments.value,
      secrets: liveSecrets.value,
    })
    .from(accounts)
    .crossJoin(liveOrganizations)
    .crossJoin(liveProjects)
    .crossJoin(liveEnvironments)
    .crossJoin(liveSecrets);

  return {
    users: row?.users ?? 0,
    organizations: row?.organizations ?? 0,
    projects: row?.projects ?? 0,
    environments: row?.environments ?? 0,
    secrets: row?.secrets ?? 0,
    signups: { last7Days: row?.last7Days ?? 0, last30Days: row?.last30Days ?? 0 },
  };
}

/* ── organisations ────────────────────────────────────────────────────────── */

/**
 * Every live organisation, newest first (`created_at desc, id desc`), a page
 * at a time — with what it is on, as the search answers it.
 */
export async function listOrganizationsForAdmin(
  exec: Executor,
  page: { cursor?: AdminCursor | undefined; limit: number },
): Promise<AdminPage<AdminOrganization>> {
  const rows = await exec
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      seatLimit: organizations.seatLimit,
      createdAt: organizations.createdAt,
      subscription: orgSubscriptions,
      cursorAt: cursorAt(organizations.createdAt),
    })
    .from(organizations)
    .innerJoin(orgSubscriptions, eq(orgSubscriptions.orgId, organizations.id))
    .where(
      and(
        isNull(organizations.deletedAt),
        after(organizations.createdAt, organizations.id, page.cursor),
      ),
    )
    .orderBy(desc(organizations.createdAt), desc(organizations.id))
    .limit(page.limit + 1);

  const { items, nextCursor } = paged(rows, page.limit);
  return { items: items.map((row) => ({ ...row, role: null })), nextCursor };
}

/** What an organisation's row says besides its plan: who owns it, and how much is in it. */
export interface AdminOrganizationFigures {
  /** Its owners' addresses, the longest-standing first; at most {@link ADMIN_OWNER_EMAILS_SHOWN}. */
  ownerEmails: string[];
  /** Members of any status, on live accounts. */
  members: number;
  /** Invitations still open: not accepted, not revoked, not expired. A count, never an address. */
  pendingInvitations: number;
  projects: number;
  environments: number;
  secrets: number;
}

const NO_FIGURES: Omit<AdminOrganizationFigures, 'ownerEmails'> = {
  members: 0,
  pendingInvitations: 0,
  projects: 0,
  environments: 0,
  secrets: 0,
};

/**
 * The figures for a page of organisations, in two statements whatever the
 * page's size — never one per row: every count in one (a grouped subquery per
 * count, each narrowed to the page's ids), and the owners' addresses in the
 * other, at most {@link ADMIN_OWNER_EMAILS_SHOWN} for each organisation.
 *
 * An organisation the map has no entry for is one that is not live; callers
 * read a missing entry as nothing counted.
 */
export async function organizationFiguresForAdmin(
  exec: Executor,
  orgIds: readonly string[],
  now: Date,
): Promise<Map<string, AdminOrganizationFigures>> {
  const ids = [...new Set(orgIds)];
  const figures = new Map<string, AdminOrganizationFigures>();
  if (ids.length === 0) return figures;

  const memberCounts = exec
    .select({ orgId: orgMembers.orgId, value: sql<number>`count(*)::int`.as('member_count') })
    .from(orgMembers)
    .innerJoin(users, and(eq(users.id, orgMembers.userId), isNull(users.deletedAt)))
    .where(inArray(orgMembers.orgId, ids))
    .groupBy(orgMembers.orgId)
    .as('member_counts');

  const invitationCounts = exec
    .select({ orgId: invitations.orgId, value: sql<number>`count(*)::int`.as('invitation_count') })
    .from(invitations)
    .where(
      and(
        inArray(invitations.orgId, ids),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
        gt(invitations.expiresAt, now),
      ),
    )
    .groupBy(invitations.orgId)
    .as('invitation_counts');

  const projectCounts = exec
    .select({ orgId: projects.orgId, value: sql<number>`count(*)::int`.as('project_count') })
    .from(projects)
    .where(and(inArray(projects.orgId, ids), isNull(projects.deletedAt)))
    .groupBy(projects.orgId)
    .as('project_counts');

  const environmentCounts = exec
    .select({ orgId: projects.orgId, value: sql<number>`count(*)::int`.as('environment_count') })
    .from(environments)
    .innerJoin(projects, and(eq(projects.id, environments.projectId), isNull(projects.deletedAt)))
    .where(and(inArray(projects.orgId, ids), isNull(environments.deletedAt)))
    .groupBy(projects.orgId)
    .as('environment_counts');

  const secretCounts = exec
    .select({ orgId: projects.orgId, value: sql<number>`count(*)::int`.as('secret_count') })
    .from(secrets)
    .innerJoin(
      environments,
      and(eq(environments.id, secrets.environmentId), isNull(environments.deletedAt)),
    )
    .innerJoin(projects, and(eq(projects.id, environments.projectId), isNull(projects.deletedAt)))
    .where(and(inArray(projects.orgId, ids), isNull(secrets.deletedAt)))
    .groupBy(projects.orgId)
    .as('secret_counts');

  const counted = await exec
    .select({
      id: organizations.id,
      members: sql<number>`coalesce(${memberCounts.value}, 0)`.mapWith(Number),
      pendingInvitations: sql<number>`coalesce(${invitationCounts.value}, 0)`.mapWith(Number),
      projects: sql<number>`coalesce(${projectCounts.value}, 0)`.mapWith(Number),
      environments: sql<number>`coalesce(${environmentCounts.value}, 0)`.mapWith(Number),
      secrets: sql<number>`coalesce(${secretCounts.value}, 0)`.mapWith(Number),
    })
    .from(organizations)
    .leftJoin(memberCounts, eq(memberCounts.orgId, organizations.id))
    .leftJoin(invitationCounts, eq(invitationCounts.orgId, organizations.id))
    .leftJoin(projectCounts, eq(projectCounts.orgId, organizations.id))
    .leftJoin(environmentCounts, eq(environmentCounts.orgId, organizations.id))
    .leftJoin(secretCounts, eq(secretCounts.orgId, organizations.id))
    .where(and(inArray(organizations.id, ids), isNull(organizations.deletedAt)));

  for (const { id, ...counts } of counted) figures.set(id, { ownerEmails: [], ...counts });

  // Each organisation's first few owners, by a lateral subquery bounded per
  // organisation — one owner-heavy organisation cannot crowd out the rest.
  const owners = exec
    .select({ email: users.email, joinedAt: orgMembers.createdAt, memberId: orgMembers.id })
    .from(orgMembers)
    .innerJoin(users, and(eq(users.id, orgMembers.userId), isNull(users.deletedAt)))
    .where(and(eq(orgMembers.orgId, organizations.id), eq(orgMembers.role, 'owner')))
    .orderBy(asc(orgMembers.createdAt), asc(orgMembers.id))
    .limit(ADMIN_OWNER_EMAILS_SHOWN)
    .as('owners');

  const ownerRows = await exec
    .select({ orgId: organizations.id, email: owners.email })
    .from(organizations)
    .innerJoinLateral(owners, sql`true`)
    .where(and(inArray(organizations.id, ids), isNull(organizations.deletedAt)))
    .orderBy(asc(organizations.id), asc(owners.joinedAt), asc(owners.memberId));

  for (const { orgId, email } of ownerRows) {
    const entry = figures.get(orgId);
    if (entry !== undefined) entry.ownerEmails.push(email);
  }
  return figures;
}

/** The figures for one organisation, with nothing counted for one the map left out. */
export function figuresOf(
  figures: ReadonlyMap<string, AdminOrganizationFigures>,
  orgId: string,
): AdminOrganizationFigures {
  return figures.get(orgId) ?? { ownerEmails: [], ...NO_FIGURES };
}

/** A member of an organisation, as its detail page lists them. */
export interface AdminOrganizationMember {
  userId: string;
  email: string;
  displayName: string | null;
  role: OrgRole;
  /** When the membership was made. */
  joinedAt: Date;
}

/**
 * An organisation's members on live accounts, the longest-standing first.
 * The base role only: a custom role's name is the customer's own wording.
 */
export async function listOrganizationMembersForAdmin(
  exec: Executor,
  orgId: string,
  limit: number,
): Promise<AdminOrganizationMember[]> {
  return exec
    .select({
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      role: orgMembers.role,
      joinedAt: orgMembers.createdAt,
    })
    .from(orgMembers)
    .innerJoin(users, and(eq(users.id, orgMembers.userId), isNull(users.deletedAt)))
    .innerJoin(
      organizations,
      and(eq(organizations.id, orgMembers.orgId), isNull(organizations.deletedAt)),
    )
    .where(eq(orgMembers.orgId, orgId))
    .orderBy(asc(orgMembers.createdAt), asc(orgMembers.id))
    .limit(limit);
}

/* ── accounts ─────────────────────────────────────────────────────────────── */

/** An account, as the Users tab lists it. */
export interface AdminUserListing {
  id: string;
  email: string;
  displayName: string | null;
  emailVerified: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
  /** How its most recent session signed in; `null` with no session, or one from before 0022. */
  lastSignInMethod: SignInMethod | null;
  /** Live organisations it is a member of, of any status. */
  organizationCount: number;
}

/**
 * `%term%`, with the term's own `%`, `_` and `\` escaped — an address is
 * matched as typed, never as a pattern somebody wrote into the search box.
 */
export function containsPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

function userColumns(exec: Executor) {
  // The most recent session's method only — `sessions_user_idx` answers it —
  // and never anything else about that session.
  const lastSession = exec
    .select({ method: sessions.signInMethod })
    .from(sessions)
    .where(eq(sessions.userId, users.id))
    .orderBy(desc(sessions.createdAt), desc(sessions.id))
    .limit(1)
    .as('last_session');
  const memberships = exec
    .select({ value: sql<number>`count(*)::int`.as('organization_count') })
    .from(orgMembers)
    .innerJoin(
      organizations,
      and(eq(organizations.id, orgMembers.orgId), isNull(organizations.deletedAt)),
    )
    .where(eq(orgMembers.userId, users.id))
    .as('memberships');

  return {
    lastSession,
    memberships,
    columns: {
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      emailVerified: users.emailVerified,
      createdAt: users.createdAt,
      lastLoginAt: users.lastLoginAt,
      lastSignInMethod: lastSession.method,
      organizationCount: sql<number>`coalesce(${memberships.value}, 0)`.mapWith(Number),
    },
  };
}

/**
 * Every live account, newest first (`created_at desc, id desc`), a page at a
 * time — or only those whose address contains `query`, in any case.
 */
export async function listUsersForAdmin(
  exec: Executor,
  page: { query?: string | undefined; cursor?: AdminCursor | undefined; limit: number },
): Promise<AdminPage<AdminUserListing>> {
  const { lastSession, memberships, columns } = userColumns(exec);
  const rows = await exec
    .select({ ...columns, cursorAt: cursorAt(users.createdAt) })
    .from(users)
    .leftJoinLateral(lastSession, sql`true`)
    .leftJoinLateral(memberships, sql`true`)
    .where(
      and(
        isNull(users.deletedAt),
        page.query === undefined ? undefined : ilike(users.email, containsPattern(page.query)),
        after(users.createdAt, users.id, page.cursor),
      ),
    )
    .orderBy(desc(users.createdAt), desc(users.id))
    .limit(page.limit + 1);

  return paged(rows, page.limit);
}

/** One live account, as the Users tab lists it; `null` for one that is missing or deleted. */
export async function findUserForAdmin(
  exec: Executor,
  userId: string,
): Promise<AdminUserListing | null> {
  const { lastSession, memberships, columns } = userColumns(exec);
  const [row] = await exec
    .select(columns)
    .from(users)
    .leftJoinLateral(lastSession, sql`true`)
    .leftJoinLateral(memberships, sql`true`)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  return row ?? null;
}

/** One of an account's organisations, as its detail page lists them. */
export interface AdminUserMembership {
  id: string;
  name: string;
  slug: string;
  role: OrgRole;
  joinedAt: Date;
}

/** The live organisations an account is in, the earliest joined first. */
export async function listUserOrganizationsForAdmin(
  exec: Executor,
  userId: string,
  limit: number,
): Promise<AdminUserMembership[]> {
  return exec
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      role: orgMembers.role,
      joinedAt: orgMembers.createdAt,
    })
    .from(orgMembers)
    .innerJoin(
      organizations,
      and(eq(organizations.id, orgMembers.orgId), isNull(organizations.deletedAt)),
    )
    .innerJoin(users, and(eq(users.id, orgMembers.userId), isNull(users.deletedAt)))
    .where(eq(orgMembers.userId, userId))
    .orderBy(asc(orgMembers.createdAt), asc(orgMembers.id))
    .limit(limit);
}

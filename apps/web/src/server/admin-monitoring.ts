import {
  countAdminTotals,
  findOrganizationsForAdmin,
  findUserForAdmin,
  listOrganizationMembersForAdmin,
  listOrganizationsForAdmin,
  listUserOrganizationsForAdmin,
  listUsersForAdmin,
} from '@xecret/db/repositories';
import type { AdminUserListing } from '@xecret/db/repositories';
import type { Principal } from './actor';
import { organizationPayloads, searchOrganizations } from './admin-service';
import type { ServiceContext } from './context';
import { errors } from './errors';
import {
  adminAccountDetailPayloadSchema,
  adminAccountListPayloadSchema,
  adminOrganizationDetailPayloadSchema,
  adminOrganizationListPayloadSchema,
  adminOverviewPayloadSchema,
  allowlisted,
  decodeAdminCursor,
  encodeAdminCursor,
} from './schemas/admin';
import type {
  AdminAccountDetailPayload,
  AdminAccountListPayload,
  AdminAccountPayload,
  AdminOrganizationDetailPayload,
  AdminOrganizationListPayload,
  AdminOverviewPayload,
} from './schemas/admin';
import { isUuid } from './schemas/ids';

/**
 * The admin page's monitoring side (`/api/admin/overview`, the organisations
 * and users lists, and one of either in detail): how many of everything there
 * are, and who and what they are — within the owner's rule for what staff may
 * see at all, which `schemas/admin.ts` states and every payload here is put
 * through.
 *
 * Every function assumes `requireAdmin` already ran — the routes open with it
 * — and takes the admin's principal to name them on the log line each read
 * leaves. A read is **not** written to the organisation's audit log: nothing
 * changed, and the log is the customer's record of what was done to their
 * organisation. The server's own line names the admin's user id and the id of
 * what they looked at, and never a search term, which may be somebody's
 * address.
 *
 * Read on demand only. Nothing here is polled or refreshed on a timer: the
 * database is on a plan that bills by the hour it is awake.
 */

type UserPrincipal = Extract<Principal, { kind: 'user' }>;

/** The most members an organisation's page lists, and organisations an account's does. */
export const ADMIN_MEMBERS_SHOWN = 500;
export const ADMIN_MEMBERSHIPS_SHOWN = 200;

export interface AdminPageQuery {
  q?: string | undefined;
  cursor?: string | undefined;
  limit: number;
}

/* ── the totals ───────────────────────────────────────────────────────────── */

export async function adminOverview(
  services: ServiceContext,
  admin: UserPrincipal,
): Promise<AdminOverviewPayload> {
  const totals = await countAdminTotals(services.db, new Date());
  services.log.at('adminOverview').info('An admin read the service’s totals', {
    adminUserId: admin.user.id,
  });
  return allowlisted(adminOverviewPayloadSchema, {
    totals: {
      users: totals.users,
      organizations: totals.organizations,
      projects: totals.projects,
      environments: totals.environments,
      secrets: totals.secrets,
    },
    signups: { last7Days: totals.signups.last7Days, last30Days: totals.signups.last30Days },
  });
}

/* ── organisations ────────────────────────────────────────────────────────── */

/**
 * Every live organisation, newest first, a page at a time — or, with `q`, the
 * search the Organisations tab has always had (`searchOrganizations`), in the
 * same row shape and never paged.
 */
export async function listOrganizations(
  services: ServiceContext,
  admin: UserPrincipal,
  query: AdminPageQuery,
): Promise<AdminOrganizationListPayload> {
  if (query.q !== undefined) {
    const organizations = await searchOrganizations(services, query.q);
    // Not the term itself: it is as often somebody's address as a slug.
    services.log.at('listOrganizations').info('An admin searched the organisations', {
      adminUserId: admin.user.id,
      found: organizations.length,
    });
    return allowlisted(adminOrganizationListPayloadSchema, { organizations, nextCursor: null });
  }

  const cursor = query.cursor === undefined ? undefined : decodeAdminCursor(query.cursor);
  const page = await listOrganizationsForAdmin(services.db, { cursor, limit: query.limit });
  services.log.at('listOrganizations').info('An admin listed the organisations', {
    adminUserId: admin.user.id,
    nextPage: cursor !== undefined,
    listed: page.items.length,
  });
  return allowlisted(adminOrganizationListPayloadSchema, {
    organizations: await organizationPayloads(services, page.items),
    nextCursor: page.nextCursor === null ? null : encodeAdminCursor(page.nextCursor),
  });
}

/**
 * One organisation: its row, and its members on live accounts. 404 for an id
 * that is malformed, unknown, or a deleted organisation's — the same answer
 * for all three.
 */
export async function organizationDetail(
  services: ServiceContext,
  admin: UserPrincipal,
  orgId: string,
): Promise<AdminOrganizationDetailPayload> {
  if (!isUuid(orgId)) throw errors.notFound('malformed organisation id');
  const [org] = await findOrganizationsForAdmin(services.db, { id: orgId }, 1);
  if (org === undefined) throw errors.notFound('no live organisation with that id');

  const [organization] = await organizationPayloads(services, [org]);
  const members = await listOrganizationMembersForAdmin(services.db, orgId, ADMIN_MEMBERS_SHOWN);
  services.log.at('organizationDetail').info('An admin looked at an organisation', {
    adminUserId: admin.user.id,
    orgId,
  });
  return allowlisted(adminOrganizationDetailPayloadSchema, {
    organization: organization!,
    members: members.map((member) => ({
      userId: member.userId,
      email: member.email,
      displayName: member.displayName,
      role: member.role,
      joinedAt: member.joinedAt.toISOString(),
    })),
  });
}

/* ── accounts ─────────────────────────────────────────────────────────────── */

function toAccountPayload(user: AdminUserListing): AdminAccountPayload {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    emailVerified: user.emailVerified,
    signedUpAt: user.createdAt.toISOString(),
    lastSignInAt: user.lastLoginAt?.toISOString() ?? null,
    lastSignInMethod: user.lastSignInMethod,
    organizationCount: user.organizationCount,
  };
}

/** Every live account, newest first, a page at a time — or those whose address contains `q`. */
export async function listAccounts(
  services: ServiceContext,
  admin: UserPrincipal,
  query: AdminPageQuery,
): Promise<AdminAccountListPayload> {
  const cursor = query.cursor === undefined ? undefined : decodeAdminCursor(query.cursor);
  const page = await listUsersForAdmin(services.db, {
    query: query.q,
    cursor,
    limit: query.limit,
  });
  // Whether it was a search, never what was searched for: that is somebody's address.
  services.log.at('listAccounts').info('An admin listed the accounts', {
    adminUserId: admin.user.id,
    searched: query.q !== undefined,
    nextPage: cursor !== undefined,
    listed: page.items.length,
  });
  return allowlisted(adminAccountListPayloadSchema, {
    users: page.items.map(toAccountPayload),
    nextCursor: page.nextCursor === null ? null : encodeAdminCursor(page.nextCursor),
  });
}

/**
 * One account: its row, and the live organisations it is in. 404 for an id
 * that is malformed, unknown, or a deleted account's.
 */
export async function accountDetail(
  services: ServiceContext,
  admin: UserPrincipal,
  userId: string,
): Promise<AdminAccountDetailPayload> {
  if (!isUuid(userId)) throw errors.notFound('malformed user id');
  const user = await findUserForAdmin(services.db, userId);
  if (user === null) throw errors.notFound('no live account with that id');
  const organizations = await listUserOrganizationsForAdmin(
    services.db,
    userId,
    ADMIN_MEMBERSHIPS_SHOWN,
  );

  services.log.at('accountDetail').info('An admin looked at an account', {
    adminUserId: admin.user.id,
    targetUserId: userId,
  });
  return allowlisted(adminAccountDetailPayloadSchema, {
    user: toAccountPayload(user),
    organizations: organizations.map((org) => ({
      id: org.id,
      name: org.name,
      slug: org.slug,
      role: org.role,
      joinedAt: org.joinedAt.toISOString(),
    })),
  });
}

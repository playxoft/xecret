import {
  accountMembershipSummary,
  deletePin,
  removeMember,
  revokeAllCliTokensForUser,
  revokeAllUserSessions,
  softDeleteOrganization,
  softDeleteUser,
} from '@xecret/db/repositories';
import type { AccountMembership } from '@xecret/db/repositories';
import { errors } from './errors';
import type { ServiceContext } from './context';

/**
 * Account deletion.
 *
 * The plan is computed by a pure function so the policy — what a departure
 * means for each organisation — is unit-testable without a database, exactly
 * like the authorization engine and the session rules. The transaction then
 * merely executes it.
 *
 * What deletion is, stated plainly:
 *
 *  - Organisations the leaver is **alone in** are soft-deleted with them.
 *    Nobody else can reach them, so keeping them would preserve nothing but
 *    an unreachable shell.
 *  - Organisations with other members lose the leaver's membership. Their
 *    grants go with the membership row (`ON DELETE CASCADE`).
 *  - An organisation where the leaver is the **only active owner among other
 *    members** blocks the whole deletion. Removing them would strand people
 *    inside an organisation nobody can administer; erasing it would destroy
 *    other people's secrets. Ownership must move first, and the error says so.
 *  - Every session and CLI token dies in the same transaction, and the user
 *    row is soft-deleted — which `upsertUserFromIdentity` treats as terminal:
 *    the same identity is refused at the next sign-in, not silently revived.
 *
 * Deletion is all-or-nothing: one blocked organisation rolls the whole thing
 * back, because "your account is half-deleted" is not a state anyone can be
 * expected to reason about.
 */

export interface AccountDeletionPlan {
  /** Sole membership — the organisation is erased with the account. */
  deleteOrgs: AccountMembership[];
  /** Others remain — only the membership is removed. */
  leaveOrgs: AccountMembership[];
  /** Sole active owner among others — blocks the deletion entirely. */
  blockedOrgs: AccountMembership[];
}

export function planAccountDeletion(
  memberships: readonly AccountMembership[],
): AccountDeletionPlan {
  const plan: AccountDeletionPlan = { deleteOrgs: [], leaveOrgs: [], blockedOrgs: [] };

  for (const membership of memberships) {
    if (membership.totalMembers <= 1) {
      plan.deleteOrgs.push(membership);
      continue;
    }

    // Only an *active* owner can be the owner an organisation depends on; a
    // suspended owner already is not administering it.
    const isActiveOwner = membership.role === 'owner' && membership.status === 'active';
    if (isActiveOwner && membership.activeOwners <= 1) {
      plan.blockedOrgs.push(membership);
      continue;
    }

    plan.leaveOrgs.push(membership);
  }

  return plan;
}

export interface AccountDeletionResult {
  /** Names of the organisations that were soft-deleted with the account. */
  deletedOrganizations: string[];
  /** Names of the organisations the account was removed from. */
  leftOrganizations: string[];
  revokedSessions: number;
  revokedCliTokens: number;
  /** The organisation the audit record should be filed against, if any existed. */
  primaryOrgId: string | null;
}

export async function deleteAccount(
  services: ServiceContext,
  userId: string,
): Promise<AccountDeletionResult> {
  return services.db.transaction(async (tx) => {
    const memberships = await accountMembershipSummary(tx, userId);
    const plan = planAccountDeletion(memberships);

    if (plan.blockedOrgs.length > 0) {
      const names = plan.blockedOrgs.map((membership) => `"${membership.orgName}"`).join(', ');
      throw errors.conflict(
        `You are the only owner of ${names}. Transfer ownership or delete ${
          plan.blockedOrgs.length === 1 ? 'that organisation' : 'those organisations'
        } first.`,
      );
    }

    for (const membership of plan.deleteOrgs) {
      await softDeleteOrganization(tx, membership.orgId);
    }
    for (const membership of plan.leaveOrgs) {
      // `removeMember` re-checks the last-owner rule under its own lock. The
      // plan already guarantees it survives; the repository not trusting a
      // caller's snapshot is the point of the check, not a redundancy to shave.
      await removeMember(tx, { orgId: membership.orgId, memberId: membership.memberId });
    }

    const revokedSessions = await revokeAllUserSessions(tx, userId);
    const revokedCliTokens = await revokeAllCliTokensForUser(tx, userId);
    await deletePin(tx, userId);
    await softDeleteUser(tx, userId);

    return {
      deletedOrganizations: plan.deleteOrgs.map((membership) => membership.orgName),
      leftOrganizations: plan.leaveOrgs.map((membership) => membership.orgName),
      revokedSessions,
      revokedCliTokens,
      primaryOrgId: memberships[0]?.orgId ?? null,
    };
  });
}

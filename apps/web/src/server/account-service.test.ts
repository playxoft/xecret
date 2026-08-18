import { describe, expect, it } from 'vitest';
import type { AccountMembership } from '@xecret/db/repositories';
import { planAccountDeletion } from './account-service';

/**
 * The policy half of account deletion: what leaving means for each
 * organisation. Pure, so every edge is exercised here without a database; the
 * transaction that executes the plan is wiring, and `removeMember` re-checks
 * the last-owner rule under its own lock regardless.
 */

let counter = 0;

function membership(overrides: Partial<AccountMembership>): AccountMembership {
  counter += 1;
  return {
    orgId: `org-${counter}`,
    orgName: `Org ${counter}`,
    memberId: `member-${counter}`,
    role: 'developer',
    status: 'active',
    totalMembers: 2,
    activeOwners: 1,
    ...overrides,
  };
}

describe('planAccountDeletion', () => {
  it('deletes an organisation the leaver is alone in', () => {
    const solo = membership({ role: 'owner', totalMembers: 1, activeOwners: 1 });
    const plan = planAccountDeletion([solo]);
    expect(plan.deleteOrgs).toEqual([solo]);
    expect(plan.leaveOrgs).toHaveLength(0);
    expect(plan.blockedOrgs).toHaveLength(0);
  });

  it('blocks when the leaver is the only active owner among others', () => {
    const blocked = membership({ role: 'owner', totalMembers: 3, activeOwners: 1 });
    const plan = planAccountDeletion([blocked]);
    expect(plan.blockedOrgs).toEqual([blocked]);
    expect(plan.deleteOrgs).toHaveLength(0);
  });

  it('leaves an organisation that keeps another active owner', () => {
    const shared = membership({ role: 'owner', totalMembers: 3, activeOwners: 2 });
    expect(planAccountDeletion([shared]).leaveOrgs).toEqual([shared]);
  });

  it('leaves as a non-owner regardless of the owner count', () => {
    const developer = membership({ role: 'developer', totalMembers: 2, activeOwners: 1 });
    expect(planAccountDeletion([developer]).leaveOrgs).toEqual([developer]);
  });

  it('a suspended owner is not the owner an organisation depends on', () => {
    // Suspension already removed them from administration; their departure
    // changes nothing, so it must not block the deletion.
    const suspended = membership({
      role: 'owner',
      status: 'suspended',
      totalMembers: 3,
      // The count excludes them: suspended is not active.
      activeOwners: 1,
    });
    expect(planAccountDeletion([suspended]).leaveOrgs).toEqual([suspended]);
  });

  it('an organisation whose only other members are suspended stays alive', () => {
    // Suspension is reversible — those people can be reinstated, and erasing
    // the organisation under them would make the suspension a deletion.
    const withSuspendedOthers = membership({ role: 'owner', totalMembers: 4, activeOwners: 1 });
    const plan = planAccountDeletion([withSuspendedOthers]);
    expect(plan.blockedOrgs).toEqual([withSuspendedOthers]);
  });

  it('classifies a mixed portfolio in one pass', () => {
    const solo = membership({ role: 'owner', totalMembers: 1, activeOwners: 1 });
    const developer = membership({ role: 'developer', totalMembers: 5, activeOwners: 2 });
    const blocked = membership({ role: 'owner', totalMembers: 2, activeOwners: 1 });

    const plan = planAccountDeletion([solo, developer, blocked]);
    expect(plan.deleteOrgs).toEqual([solo]);
    expect(plan.leaveOrgs).toEqual([developer]);
    expect(plan.blockedOrgs).toEqual([blocked]);
  });

  it('an account with no organisations deletes cleanly', () => {
    const plan = planAccountDeletion([]);
    expect(plan.deleteOrgs).toHaveLength(0);
    expect(plan.leaveOrgs).toHaveLength(0);
    expect(plan.blockedOrgs).toHaveLength(0);
  });
});

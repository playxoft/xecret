import { describe, expect, it } from 'vitest';
import { authoritySummary, canAssignRole } from '@xecret/core/authz';
import type { Action, CustomRole, OrgRole } from '@xecret/core/authz';
import { canAdminister, isOrgAdmin, mayManageRole } from './session';
import type { SessionOrganization } from './session';

/**
 * The dashboard's controls moved from the stored role to the authority the
 * server computes. For a member without a custom role that must change
 * nothing — every gate below gives, for every built-in role, exactly the
 * answer the stored-role gate it replaced gave. For a narrowed member it must
 * take away what the custom role withholds.
 */

const ROLES: readonly OrgRole[] = ['owner', 'admin', 'developer', 'viewer'];

/** A session organisation, as `/api/auth/me` builds one. */
function organization(role: OrgRole, customRole?: CustomRole): SessionOrganization {
  const summary = authoritySummary({ role, customRole });
  return {
    id: 'org-1',
    name: 'Acme',
    slug: 'acme',
    role,
    authority: {
      role,
      customRole:
        customRole === undefined
          ? null
          : { id: customRole.id, name: customRole.name, baseRole: customRole.baseRole },
      effectiveRole: summary.effectiveRole,
      capabilities: summary.capabilities,
      assignableRoles: summary.assignableRoles,
      definableBaseRoles: summary.definableBaseRoles,
    },
  };
}

/**
 * Every action a dashboard control is gated on, with the stored-role rule that
 * gated it before. `org.delete` was the owner alone; everything else was
 * "owner or admin".
 */
const GATES: readonly [Action, (role: OrgRole) => boolean][] = [
  ['project.create', isOrgAdmin],
  ['project.update', isOrgAdmin],
  ['project.delete', isOrgAdmin],
  ['environment.create', isOrgAdmin],
  ['environment.update', isOrgAdmin],
  ['environment.delete', isOrgAdmin],
  ['member.invite', isOrgAdmin],
  ['member.update', isOrgAdmin],
  ['member.remove', isOrgAdmin],
  ['token.create', isOrgAdmin],
  ['token.revoke', isOrgAdmin],
  ['audit.read', isOrgAdmin],
  ['org.update', isOrgAdmin],
  ['org.delete', (role) => role === 'owner'],
];

describe('gates for a member without a custom role', () => {
  it('draw every control exactly where the stored role did', () => {
    for (const role of ROLES) {
      const org = organization(role);
      for (const [action, before] of GATES) {
        expect(canAdminister(org, action), `${role} ${action}`).toBe(before(role));
      }
    }
  });

  it('let a viewer manage exactly the members canAssignRole let them', () => {
    for (const role of ROLES) {
      const org = organization(role);
      for (const subject of ROLES) {
        expect(mayManageRole(org, subject), `${role} → ${subject}`).toBe(
          isOrgAdmin(role) && canAssignRole(role, subject),
        );
      }
    }
  });

  it('draw nothing with no organisation', () => {
    expect(canAdminister(null, 'member.update')).toBe(false);
    expect(mayManageRole(null, 'viewer')).toBe(false);
  });
});

describe('gates for a narrowed admin', () => {
  const allActions = GATES.map(([action]) => action);

  it('take away each control the custom role withholds, and only those', () => {
    const accessManager: CustomRole = {
      id: 'role-1',
      name: 'Access manager',
      baseRole: 'admin',
      allowedActions: ['member.read', 'member.update', 'project.update'],
    };
    const org = organization('admin', accessManager);

    expect(allActions.filter((action) => canAdminister(org, action))).toEqual([
      'project.update',
      'member.update',
    ]);
  });

  it('manage nobody their own role could not hand out', () => {
    const memberManager: CustomRole = {
      id: 'role-2',
      name: 'Member manager',
      baseRole: 'admin',
      allowedActions: ['member.read', 'member.invite', 'member.update', 'member.remove'],
    };
    const org = organization('admin', memberManager);

    // Holds member.update, ranks as an admin, and still manages nobody: every
    // role carries something this one withholds.
    expect(canAdminister(org, 'member.update')).toBe(true);
    for (const subject of ROLES) expect(mayManageRole(org, subject), subject).toBe(false);
  });

  it('manage nobody without member.update, even with roles they could invite at', () => {
    // An inviter: every viewer capability, so a viewer is within their
    // authority and they may invite one — but no member.update, so there is
    // no member they may change.
    const inviter: CustomRole = {
      id: 'role-4',
      name: 'Inviter',
      baseRole: 'admin',
      allowedActions: [
        'member.read',
        'member.invite',
        'project.read',
        'environment.read',
        'secret.read',
      ],
    };
    const org = organization('admin', inviter);

    expect(org.authority.assignableRoles).toContain('viewer');
    expect(canAdminister(org, 'member.invite')).toBe(true);
    expect(mayManageRole(org, 'viewer')).toBe(false);
  });

  it('never draw an admin control for somebody whose custom role holds it but whose base is below admin', () => {
    const developerBase: CustomRole = {
      id: 'role-3',
      name: 'Developer base',
      baseRole: 'developer',
      allowedActions: ['member.read', 'project.create', 'environment.create'],
    };
    const org = organization('admin', developerBase);

    expect(canAdminister(org, 'project.create')).toBe(false);
  });
});

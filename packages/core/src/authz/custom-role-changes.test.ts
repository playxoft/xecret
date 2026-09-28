import { describe, expect, it } from 'vitest';

import { authoritySummary, capabilitiesGained, levelsRaised, widensHolder } from './authority';
import { resolveAccessLevel } from './grants';
import type { ResolvedGrant } from './grants';
import {
  actionsBeyondBase,
  actionsForBase,
  canAssignRole,
  CUSTOM_ROLE_BASE_ROLES,
  effectiveCapabilities,
  narrowAccessDefaults,
  ROLE_CAPABILITIES,
  roleWithinAuthority,
} from './roles';
import type { CustomRole, RoleHolder } from './roles';
import type { AccessLevel, Action, OrgRole } from './types';

/**
 * The pure half of custom roles part 2: what a change to a custom role — or to
 * which one a member holds — hands that member, and what a member's authority
 * looks like to the client that draws their controls.
 *
 * `widensHolder` is the question the assign, unassign and edit routes ask of
 * every member they touch, and a false "no" from it is a grant row switched on
 * without anybody asking whether the caller could have written it. So besides
 * the named cases, it is checked against the engine itself: over a spread of
 * holders, roles and grants, whenever it says a change does not widen, no
 * resolved level rises and no capability appears. That property is only as
 * strong as the spread, so the spread includes a pair that differs in nothing
 * but the production default.
 */

const ALL_ACTIONS = Object.keys(ROLE_CAPABILITIES.owner) as Action[];
const DEVELOPER_ACTIONS = ALL_ACTIONS.filter((action) => ROLE_CAPABILITIES.developer[action]);
const ROLES: readonly OrgRole[] = ['viewer', 'developer', 'admin', 'owner'];
const LEVELS: readonly AccessLevel[] = ['none', 'read', 'write', 'admin'];
const PROJECT = 'project-1';
const ENVIRONMENT = 'env-1';

function customRole(name: string, over: Partial<CustomRole> = {}): CustomRole {
  return { id: name, name, baseRole: 'admin', allowedActions: ALL_ACTIONS, ...over };
}

/**
 * The two roles that differ only in the production default: the same action
 * list (a developer's), the same ceiling, and a base of developer versus
 * admin. For an admin holding either, only production without a grant moves —
 * `none` under the developer base, `admin` under the admin one.
 */
const DEVELOPER_LEVEL_ON_DEVELOPER = customRole('Developer-level, developer base', {
  baseRole: 'developer',
  allowedActions: DEVELOPER_ACTIONS,
  accessCeiling: { nonProduction: 'write', production: 'admin' },
});
const DEVELOPER_LEVEL_ON_ADMIN = customRole('Developer-level, admin base', {
  baseRole: 'admin',
  allowedActions: DEVELOPER_ACTIONS,
  accessCeiling: { nonProduction: 'write', production: 'admin' },
});

/** A spread of custom roles: bases, lists and ceilings that disagree in every direction. */
const ROLE_SAMPLES: readonly (CustomRole | undefined)[] = [
  undefined,
  customRole('Everything'),
  customRole('Developer base', { baseRole: 'developer' }),
  customRole('Viewer base', { baseRole: 'viewer' }),
  customRole('Member management only', { allowedActions: ['member.read', 'member.update'] }),
  customRole('Reads secrets only', { baseRole: 'developer', allowedActions: ['secret.read'] }),
  customRole('No production', { accessCeiling: { nonProduction: 'admin', production: 'none' } }),
  customRole('Read everywhere', { accessCeiling: { nonProduction: 'read', production: 'read' } }),
  customRole('Production only', {
    accessCeiling: { nonProduction: 'none', production: 'admin' },
  }),
  customRole('Deployer', {
    baseRole: 'developer',
    allowedActions: ['secret.read', 'secret.update'],
    accessCeiling: { nonProduction: 'write', production: 'none' },
  }),
  DEVELOPER_LEVEL_ON_DEVELOPER,
  DEVELOPER_LEVEL_ON_ADMIN,
];

describe('the samples', () => {
  it('are told apart by name, so a failure names the pair', () => {
    const names = ROLE_SAMPLES.flatMap((sample) => (sample === undefined ? [] : [sample.name]));
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('levelsRaised', () => {
  it('is false for no change at all', () => {
    for (const role of ROLES) {
      for (const held of ROLE_SAMPLES) {
        expect(levelsRaised({ role, customRole: held }, { role, customRole: held })).toBe(false);
      }
    }
  });

  it('sees a ceiling lifted, even where the defaults stay put', () => {
    // A developer's production default is `none` either way; what changes is
    // how far a production grant row they already hold can reach.
    const capped = customRole('Capped', {
      baseRole: 'developer',
      accessCeiling: { nonProduction: 'write', production: 'none' },
    });
    const uncapped = customRole('Uncapped', { baseRole: 'developer' });

    expect(
      levelsRaised(
        { role: 'developer', customRole: capped },
        { role: 'developer', customRole: uncapped },
      ),
    ).toBe(true);
  });

  it('sees the production default raised when nothing else moves', () => {
    // Same list, same ceiling, and the non-production default is `write`
    // either way: the only thing that rises is production without a grant,
    // `none` → `admin`. No capability is gained, so nothing but this one
    // comparison says the change widens.
    const from: RoleHolder = { role: 'admin', customRole: DEVELOPER_LEVEL_ON_DEVELOPER };
    const to: RoleHolder = { role: 'admin', customRole: DEVELOPER_LEVEL_ON_ADMIN };

    expect(capabilitiesGained(from, to)).toEqual([]);
    expect(narrowAccessDefaults(from.role, from.customRole)).toEqual({
      nonProduction: 'write',
      production: 'none',
    });
    expect(narrowAccessDefaults(to.role, to.customRole)).toEqual({
      nonProduction: 'write',
      production: 'admin',
    });
    expect(levelsRaised(from, to)).toBe(true);
    expect(widensHolder(from, to)).toBe(true);
  });

  it('counts a raise in one kind even when the other falls', () => {
    const stagingOnly = customRole('Staging only', {
      accessCeiling: { nonProduction: 'admin', production: 'none' },
    });
    const productionOnly = customRole('Production only, again', {
      accessCeiling: { nonProduction: 'none', production: 'admin' },
    });

    expect(
      levelsRaised(
        { role: 'admin', customRole: stagingOnly },
        { role: 'admin', customRole: productionOnly },
      ),
    ).toBe(true);
  });

  it('sees unassigning a capped role as the raise it is', () => {
    const capped = customRole('Read-capped', {
      accessCeiling: { nonProduction: 'read', production: 'read' },
    });

    expect(levelsRaised({ role: 'admin', customRole: capped }, { role: 'admin' })).toBe(true);
    expect(levelsRaised({ role: 'admin' }, { role: 'admin', customRole: capped })).toBe(false);
  });
});

describe('widensHolder', () => {
  it('says which unassignments widen an admin, sample by sample', () => {
    // Written out by hand, not derived from the function under test. Only a
    // role that takes nothing away from an admin — every action on an admin
    // base, no ceiling — leaves nothing to give back when it comes off.
    const expected: Record<string, boolean> = {
      Everything: false,
      'Developer base': true,
      'Viewer base': true,
      'Member management only': true,
      'Reads secrets only': true,
      'No production': true,
      'Read everywhere': true,
      'Production only': true,
      Deployer: true,
      'Developer-level, developer base': true,
      'Developer-level, admin base': true,
    };

    for (const held of ROLE_SAMPLES) {
      if (held === undefined) continue;
      expect(widensHolder({ role: 'admin', customRole: held }, { role: 'admin' }), held.name).toBe(
        expected[held.name],
      );
    }
    expect(Object.keys(expected)).toHaveLength(ROLE_SAMPLES.length - 1);
  });

  it('is false for assigning any role to a member who held none — assignment only narrows', () => {
    for (const role of ROLES) {
      for (const held of ROLE_SAMPLES) {
        expect(widensHolder({ role }, { role, customRole: held })).toBe(false);
      }
    }
  });

  it('catches a swap that gains no capability but lifts a ceiling', () => {
    const tight = customRole('Tight', {
      accessCeiling: { nonProduction: 'admin', production: 'none' },
    });
    const loose = customRole('Loose', {
      accessCeiling: { nonProduction: 'admin', production: 'write' },
    });

    expect(
      capabilitiesGained(
        { role: 'admin', customRole: tight },
        { role: 'admin', customRole: loose },
      ),
    ).toEqual([]);
    expect(
      widensHolder({ role: 'admin', customRole: tight }, { role: 'admin', customRole: loose }),
    ).toBe(true);
  });

  it('never says "no" to a change that raises a resolved level or adds a capability', () => {
    // The soundness property. Every pairing of sample roles, on every member
    // role, against every single grant row a member could hold: if the change
    // is reported as not widening, the engine must agree — nothing resolves
    // higher and nothing new is permitted.
    const grantRows: (ResolvedGrant | null)[] = [
      null,
      ...LEVELS.map((accessLevel) => ({
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        accessLevel,
      })),
      ...LEVELS.map((accessLevel) => ({ projectId: PROJECT, environmentId: null, accessLevel })),
    ];

    for (const role of ROLES) {
      for (const before of ROLE_SAMPLES) {
        for (const after of ROLE_SAMPLES) {
          const from: RoleHolder = { role, customRole: before };
          const to: RoleHolder = { role, customRole: after };
          if (widensHolder(from, to)) continue;

          const fromCaps = effectiveCapabilities(role, before);
          const toCaps = effectiveCapabilities(role, after);
          for (const action of ALL_ACTIONS) {
            if (toCaps[action]) expect(fromCaps[action], `${role} ${action}`).toBe(true);
          }

          for (const row of grantRows) {
            for (const isProduction of [false, true]) {
              const grants = row === null ? [] : [row];
              const levelBefore = resolveAccessLevel(
                { role, memberStatus: 'active', grants, isProduction, customRole: before },
                PROJECT,
                ENVIRONMENT,
              );
              const levelAfter = resolveAccessLevel(
                { role, memberStatus: 'active', grants, isProduction, customRole: after },
                PROJECT,
                ENVIRONMENT,
              );
              expect(
                LEVELS.indexOf(levelAfter) <= LEVELS.indexOf(levelBefore),
                `${role} ${before?.name ?? 'none'} → ${after?.name ?? 'none'} ${JSON.stringify(row)} prod=${isProduction}`,
              ).toBe(true);
            }
          }
        }
      }
    }
  });
});

describe('actionsForBase and actionsBeyondBase', () => {
  it('offers exactly what the base role’s table grants', () => {
    for (const base of CUSTOM_ROLE_BASE_ROLES) {
      expect(actionsForBase(base)).toEqual(
        ALL_ACTIONS.filter((action) => ROLE_CAPABILITIES[base][action]),
      );
      expect(actionsBeyondBase(base, actionsForBase(base))).toEqual([]);
    }
  });

  it('names what a base cannot do, once each, in table order', () => {
    expect(
      actionsBeyondBase('viewer', ['secret.update', 'secret.read', 'org.delete', 'secret.update']),
    ).toEqual(['secret.update', 'org.delete']);
  });

  it('never offers owner as a base', () => {
    expect(CUSTOM_ROLE_BASE_ROLES).not.toContain('owner');
  });
});

describe('authoritySummary', () => {
  it('is the built-in role exactly, for a member without a custom role', () => {
    for (const role of ROLES) {
      const summary = authoritySummary({ role });
      const managesMembers = ROLE_CAPABILITIES[role]['member.update'];

      expect(summary.effectiveRole).toBe(role);
      expect(summary.capabilities).toEqual(
        ALL_ACTIONS.filter((action) => ROLE_CAPABILITIES[role][action]),
      );
      // Owners and admins hand out what `canAssignRole` always let them;
      // developers and viewers, who hold no act that hands a role out, get
      // nothing — the list is not a permission to manage anybody.
      expect(summary.assignableRoles).toEqual(
        managesMembers
          ? (['owner', 'admin', 'developer', 'viewer'] as const).filter((subject) =>
              canAssignRole(role, subject),
            )
          : [],
      );
      expect(summary.definableBaseRoles).toEqual(
        managesMembers ? CUSTOM_ROLE_BASE_ROLES.filter((base) => canAssignRole(role, base)) : [],
      );
    }
  });

  it('narrows everything for a member manager, and defines nothing', () => {
    const summary = authoritySummary({
      role: 'admin',
      customRole: customRole('Member manager', {
        allowedActions: ['member.read', 'member.invite', 'member.update', 'member.remove'],
      }),
    });

    expect(summary.effectiveRole).toBe('admin');
    expect(summary.capabilities).toEqual([
      'member.read',
      'member.invite',
      'member.update',
      'member.remove',
    ]);
    // A plain admin, developer or viewer each holds something this role
    // withholds — project and secret work — so none may be handed out.
    expect(summary.assignableRoles).toEqual([]);
    expect(summary.definableBaseRoles).toEqual([]);
  });

  it('hands out nothing, and defines nothing, without an act that does', () => {
    // A plain developer: `canAssignRole` would let them hand out developer and
    // viewer, and `canDefineCustomRole` would let them define on those bases,
    // but no route they can reach does either.
    const developer = authoritySummary({ role: 'developer' });

    expect(developer.assignableRoles).toEqual([]);
    expect(developer.definableBaseRoles).toEqual([]);
  });

  it('agrees with roleWithinAuthority wherever the member can hand a role out', () => {
    for (const role of ROLES) {
      for (const held of ROLE_SAMPLES) {
        const holder: RoleHolder = { role, customRole: held };
        const table = effectiveCapabilities(role, held);
        const handsOut = table['member.update'] || table['member.invite'];
        const summary = authoritySummary(holder);
        for (const subject of ROLES) {
          expect(
            summary.assignableRoles.includes(subject),
            `${role} ${held?.name ?? 'none'} ${subject}`,
          ).toBe(handsOut && roleWithinAuthority(holder, subject));
        }
      }
    }
  });

  it('keeps the member.read floor in the capability list', () => {
    const summary = authoritySummary({
      role: 'developer',
      customRole: customRole('Nothing at all', { baseRole: 'developer', allowedActions: [] }),
    });

    expect(summary.capabilities).toEqual(['member.read']);
  });
});

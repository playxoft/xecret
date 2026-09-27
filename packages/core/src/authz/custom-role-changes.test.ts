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
 * resolved level rises and no capability appears.
 */

const ALL_ACTIONS = Object.keys(ROLE_CAPABILITIES.owner) as Action[];
const ROLES: readonly OrgRole[] = ['viewer', 'developer', 'admin', 'owner'];
const LEVELS: readonly AccessLevel[] = ['none', 'read', 'write', 'admin'];
const PROJECT = 'project-1';
const ENVIRONMENT = 'env-1';

function customRole(over: Partial<CustomRole> = {}): CustomRole {
  return {
    id: 'role-1',
    name: 'Narrowed',
    baseRole: 'admin',
    allowedActions: ALL_ACTIONS,
    ...over,
  };
}

/** A spread of custom roles: bases, lists and ceilings that disagree in every direction. */
const ROLE_SAMPLES: readonly (CustomRole | undefined)[] = [
  undefined,
  customRole(),
  customRole({ baseRole: 'developer' }),
  customRole({ baseRole: 'viewer' }),
  customRole({ allowedActions: ['member.read', 'member.update'] }),
  customRole({ baseRole: 'developer', allowedActions: ['secret.read'] }),
  customRole({ accessCeiling: { nonProduction: 'admin', production: 'none' } }),
  customRole({ accessCeiling: { nonProduction: 'read', production: 'read' } }),
  customRole({ accessCeiling: { nonProduction: 'none', production: 'admin' } }),
  customRole({
    baseRole: 'developer',
    allowedActions: ['secret.read', 'secret.update'],
    accessCeiling: { nonProduction: 'write', production: 'none' },
  }),
];

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
    const capped = customRole({
      baseRole: 'developer',
      accessCeiling: { nonProduction: 'write', production: 'none' },
    });
    const uncapped = customRole({ baseRole: 'developer' });

    expect(
      levelsRaised(
        { role: 'developer', customRole: capped },
        { role: 'developer', customRole: uncapped },
      ),
    ).toBe(true);
  });

  it('sees a base raised, which lifts the defaults', () => {
    expect(
      levelsRaised(
        { role: 'admin', customRole: customRole({ baseRole: 'developer' }) },
        { role: 'admin', customRole: customRole({ baseRole: 'admin' }) },
      ),
    ).toBe(true);
  });

  it('counts a raise in one kind even when the other falls', () => {
    const stagingOnly = customRole({
      accessCeiling: { nonProduction: 'admin', production: 'none' },
    });
    const productionOnly = customRole({
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
    const capped = customRole({ accessCeiling: { nonProduction: 'read', production: 'read' } });

    expect(levelsRaised({ role: 'admin', customRole: capped }, { role: 'admin' })).toBe(true);
    expect(levelsRaised({ role: 'admin' }, { role: 'admin', customRole: capped })).toBe(false);
  });
});

describe('widensHolder', () => {
  it('is true for unassigning any role that took something away', () => {
    for (const held of ROLE_SAMPLES) {
      if (held === undefined) continue;
      const from: RoleHolder = { role: 'admin', customRole: held };
      const narrows =
        capabilitiesGained(from, { role: 'admin' }).length > 0 ||
        levelsRaised(from, { role: 'admin' });
      expect(widensHolder(from, { role: 'admin' }), held.name).toBe(narrows);
    }
  });

  it('is false for assigning any role to a member who held none — assignment only narrows', () => {
    for (const role of ROLES) {
      for (const held of ROLE_SAMPLES) {
        expect(widensHolder({ role }, { role, customRole: held })).toBe(false);
      }
    }
  });

  it('catches a swap that gains no capability but lifts a ceiling', () => {
    const tight = customRole({ accessCeiling: { nonProduction: 'admin', production: 'none' } });
    const loose = customRole({ accessCeiling: { nonProduction: 'admin', production: 'write' } });

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
                `${role} ${before?.name ?? '—'}→${after?.name ?? '—'} ${JSON.stringify(row)} prod=${isProduction}`,
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

      expect(summary.effectiveRole).toBe(role);
      expect(summary.capabilities).toEqual(
        ALL_ACTIONS.filter((action) => ROLE_CAPABILITIES[role][action]),
      );
      expect(summary.assignableRoles).toEqual(
        (['owner', 'admin', 'developer', 'viewer'] as const).filter((subject) =>
          canAssignRole(role, subject),
        ),
      );
      expect(summary.definableBaseRoles).toEqual(
        CUSTOM_ROLE_BASE_ROLES.filter((base) => canAssignRole(role, base)),
      );
    }
  });

  it('narrows everything for a member manager, and defines nothing', () => {
    const summary = authoritySummary({
      role: 'admin',
      customRole: customRole({
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

  it('agrees with roleWithinAuthority for every sample', () => {
    for (const role of ROLES) {
      for (const held of ROLE_SAMPLES) {
        const holder: RoleHolder = { role, customRole: held };
        const summary = authoritySummary(holder);
        for (const subject of ROLES) {
          expect(
            summary.assignableRoles.includes(subject),
            `${role} ${held?.name} ${subject}`,
          ).toBe(roleWithinAuthority(holder, subject));
        }
      }
    }
  });

  it('keeps the member.read floor in the capability list', () => {
    const summary = authoritySummary({
      role: 'developer',
      customRole: customRole({ baseRole: 'developer', allowedActions: [] }),
    });

    expect(summary.capabilities).toEqual(['member.read']);
  });
});

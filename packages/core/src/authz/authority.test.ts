import { describe, expect, it } from 'vitest';

import {
  afterRoleChange,
  capabilitiesGained,
  grantableAccessLevel,
  grantReach,
  grantWithinAuthority,
  heldGrantsWithinAuthority,
  reachPoints,
  removalWithinAuthority,
  serviceTokenActionsAt,
} from './authority';
import type { GrantReach, GridEnvironment } from './authority';
import type { Membership, ResolvedGrant } from './grants';
import { ROLE_CAPABILITIES } from './roles';
import type { CustomRole } from './roles';
import type { AccessLevel, Action, OrgRole } from './types';

/**
 * What a member may confer on somebody else, measured by what they hold.
 *
 * Each rule is asked of three actors that matter: an owner or admin with
 * nothing written against them, who must never be refused anything; an admin
 * whose custom role caps them at `none` on production (the "production-capped
 * admin"); and a plain admin an owner held to `read` on production with an
 * explicit grant.
 */

const PROJECT = 'project-1';
const OTHER_PROJECT = 'project-2';
const STAGING = 'env-staging';
const PRODUCTION = 'env-production';
const OTHER_PRODUCTION = 'env-other-production';

const ALL_ACTIONS = Object.keys(ROLE_CAPABILITIES.owner) as Action[];
const ROLES: readonly OrgRole[] = ['viewer', 'developer', 'admin', 'owner'];
const LEVELS: readonly AccessLevel[] = ['none', 'read', 'write', 'admin'];

const staging = { id: STAGING, isProduction: false };
const production = { id: PRODUCTION, isProduction: true };

const GRID: readonly GridEnvironment[] = [
  { ...staging, projectId: PROJECT },
  { ...production, projectId: PROJECT },
  { id: OTHER_PRODUCTION, projectId: OTHER_PROJECT, isProduction: true },
];

/** Every reach the tests below measure across: each environment, and the project. */
const REACHES: readonly GrantReach[] = [
  { projectId: PROJECT, environment: staging },
  { projectId: PROJECT, environment: production },
  { projectId: PROJECT, environment: null, projectEnvironments: [staging, production] },
];

function customRole(over: Partial<CustomRole> = {}): CustomRole {
  return {
    id: 'role-1',
    name: 'Narrowed',
    baseRole: 'admin',
    allowedActions: ALL_ACTIONS,
    ...over,
  };
}

function member(over: Partial<Membership> = {}): Membership {
  return { role: 'admin', memberStatus: 'active', grants: [], ...over };
}

function grant(environmentId: string | null, accessLevel: AccessLevel): ResolvedGrant {
  return { projectId: PROJECT, environmentId, accessLevel };
}

const productionCapped = member({
  customRole: customRole({ accessCeiling: { nonProduction: 'admin', production: 'none' } }),
});

const restrictedAdmin = member({ grants: [grant(PRODUCTION, 'read')] });

const unrestricted = (['owner', 'admin'] as const).map((role) => member({ role }));

/* ── Reach ─────────────────────────────────────────────────────────────── */

describe('reachPoints', () => {
  it('is the environment alone for an environment grant', () => {
    expect(reachPoints({ projectId: PROJECT, environment: production })).toEqual([
      { environmentId: PRODUCTION, isProduction: true },
    ]);
  });

  it('is the project at both production levels and each environment for a project grant', () => {
    expect(
      reachPoints({ projectId: PROJECT, environment: null, projectEnvironments: [staging] }),
    ).toEqual([
      { environmentId: null, isProduction: false },
      { environmentId: null, isProduction: true },
      { environmentId: STAGING, isProduction: false },
    ]);
  });
});

describe('grantReach', () => {
  it('reaches one environment with its own production flag', () => {
    expect(grantReach(PROJECT, PRODUCTION, GRID)).toEqual({
      projectId: PROJECT,
      environment: { id: PRODUCTION, isProduction: true },
    });
    expect(grantReach(PROJECT, STAGING, GRID)).toEqual({
      projectId: PROJECT,
      environment: { id: STAGING, isProduction: false },
    });
  });

  it('reaches every environment of its own project, and only those, when project-wide', () => {
    const reach = grantReach(PROJECT, null, GRID);

    expect(reach.environment).toBeNull();
    expect(
      reach.environment === null ? reach.projectEnvironments.map((env) => env.id) : [],
    ).toEqual([STAGING, PRODUCTION]);
  });

  it('measures an environment missing from the grid as production', () => {
    expect(grantReach(PROJECT, 'env-gone', GRID)).toEqual({
      projectId: PROJECT,
      environment: { id: 'env-gone', isProduction: true },
    });
  });
});

/* ── Writing a grant ───────────────────────────────────────────────────── */

describe('grantableAccessLevel', () => {
  it('is the actor’s own resolved level on one environment', () => {
    expect(grantableAccessLevel(productionCapped, REACHES[1]!)).toBe('none');
    expect(grantableAccessLevel(productionCapped, REACHES[0]!)).toBe('admin');
  });

  it('takes the lowest level anywhere a project-wide grant would land', () => {
    // An explicit `read` on production holds a project-wide grant to `read`:
    // the row falls back onto production.
    expect(grantableAccessLevel(restrictedAdmin, REACHES[2]!)).toBe('read');
  });

  it('holds a project-wide grant to the production level even with no production yet', () => {
    // A production environment added tomorrow falls back onto today's row.
    expect(
      grantableAccessLevel(productionCapped, {
        projectId: PROJECT,
        environment: null,
        projectEnvironments: [staging],
      }),
    ).toBe('none');
  });

  it('ignores the actor’s grants on another project', () => {
    const elsewhere = member({
      grants: [{ projectId: OTHER_PROJECT, environmentId: null, accessLevel: 'none' }],
    });

    expect(grantableAccessLevel(elsewhere, REACHES[1]!)).toBe('admin');
  });
});

describe('grantWithinAuthority', () => {
  it('refuses a level above the actor’s own and permits one at or below it', () => {
    expect(grantWithinAuthority(restrictedAdmin, 'write', REACHES[1]!)).toBe(false);
    expect(grantWithinAuthority(restrictedAdmin, 'read', REACHES[1]!)).toBe(true);
    expect(grantWithinAuthority(productionCapped, 'read', REACHES[1]!)).toBe(false);
    expect(grantWithinAuthority(productionCapped, 'admin', REACHES[0]!)).toBe(true);
  });

  it('always permits none — taking access away confers nothing', () => {
    const nothing = member({ role: 'viewer', memberStatus: 'suspended' });
    for (const reach of REACHES) expect(grantWithinAuthority(nothing, 'none', reach)).toBe(true);
  });

  it('never refuses an owner or admin with nothing written against them', () => {
    for (const actor of unrestricted) {
      for (const reach of REACHES) {
        for (const level of LEVELS) {
          expect(grantWithinAuthority(actor, level, reach), `${actor.role} ${level}`).toBe(true);
        }
      }
    }
  });
});

/* ── Removing a grant ──────────────────────────────────────────────────── */

describe('removalWithinAuthority', () => {
  /** A developer whose production is closed by an explicit none under a project-wide write. */
  const heldOffProduction = member({
    role: 'developer',
    grants: [grant(null, 'write'), grant(PRODUCTION, 'none')],
  });

  it('refuses removing a none that a project-wide row would replace above the actor', () => {
    expect(removalWithinAuthority(productionCapped, heldOffProduction, REACHES[1]!)).toBe(false);
    expect(removalWithinAuthority(restrictedAdmin, heldOffProduction, REACHES[1]!)).toBe(false);
  });

  it('measures a suspended member as active — the removed row outlives the suspension', () => {
    // Suspended, the developer resolves to `none` everywhere and nothing would
    // ever look raised; reinstated, the production `none` is still gone.
    const suspended = { ...heldOffProduction, memberStatus: 'suspended' as const };

    expect(removalWithinAuthority(productionCapped, suspended, REACHES[1]!)).toBe(false);
    expect(removalWithinAuthority(restrictedAdmin, suspended, REACHES[1]!)).toBe(false);
  });

  it('permits a removal that lowers the member everywhere', () => {
    // Project-wide `admin`, removed: the developer's `write` and production `none`.
    const target = member({ role: 'developer', grants: [grant(null, 'admin')] });

    expect(removalWithinAuthority(productionCapped, target, REACHES[2]!)).toBe(true);
  });

  it('permits a removal that keeps the member where they were', () => {
    const target = member({ role: 'developer', grants: [grant(PRODUCTION, 'none')] });

    expect(removalWithinAuthority(productionCapped, target, REACHES[1]!)).toBe(true);
  });

  it('measures each raise where it happens, not against the lowest level anywhere', () => {
    // Project-wide `read`, removed: staging rises to the developer's `write`,
    // which the actor holds; production stays at `none`.
    const target = member({ role: 'developer', grants: [grant(null, 'read')] });

    expect(removalWithinAuthority(productionCapped, target, REACHES[2]!)).toBe(true);
  });

  it('never refuses an owner or admin with nothing written against them', () => {
    for (const actor of unrestricted) {
      for (const role of ROLES) {
        for (const status of ['active', 'suspended'] as const) {
          for (const reach of REACHES) {
            const removedId = reach.environment?.id ?? null;
            const target = member({
              role,
              memberStatus: status,
              grants: [grant(null, 'admin'), grant(removedId, 'none')],
            });
            expect(removalWithinAuthority(actor, target, reach), `${actor.role} ${role}`).toBe(
              true,
            );
          }
        }
      }
    }
  });
});

/* ── Turning existing grants on ────────────────────────────────────────── */

describe('heldGrantsWithinAuthority', () => {
  it('refuses rows the actor could not have written', () => {
    expect(heldGrantsWithinAuthority(productionCapped, [grant(PRODUCTION, 'write')], GRID)).toBe(
      false,
    );
    expect(heldGrantsWithinAuthority(restrictedAdmin, [grant(PRODUCTION, 'write')], GRID)).toBe(
      false,
    );
  });

  it('permits rows the actor could have written, and ignores none', () => {
    const grants = [grant(STAGING, 'write'), grant(PRODUCTION, 'none')];

    expect(heldGrantsWithinAuthority(productionCapped, grants, GRID)).toBe(true);
    expect(heldGrantsWithinAuthority(restrictedAdmin, [grant(PRODUCTION, 'read')], GRID)).toBe(
      true,
    );
  });

  it('measures a project-wide row across the whole project, production included', () => {
    expect(heldGrantsWithinAuthority(productionCapped, [grant(null, 'read')], GRID)).toBe(false);
  });

  it('measures a row whose environment is gone as production', () => {
    expect(heldGrantsWithinAuthority(productionCapped, [grant('env-gone', 'read')], GRID)).toBe(
      false,
    );
  });

  it('refuses on one row among many', () => {
    const grants = [grant(STAGING, 'admin'), grant(PRODUCTION, 'read')];

    expect(heldGrantsWithinAuthority(productionCapped, grants, GRID)).toBe(false);
  });

  it('never refuses an owner or admin with nothing written against them', () => {
    const everything = [
      ...LEVELS.map((level) => grant(null, level)),
      ...LEVELS.map((level) => grant(STAGING, level)),
      ...LEVELS.map((level) => grant(PRODUCTION, level)),
      { projectId: OTHER_PROJECT, environmentId: OTHER_PRODUCTION, accessLevel: 'admin' as const },
    ];
    for (const actor of unrestricted) {
      expect(heldGrantsWithinAuthority(actor, everything, GRID), actor.role).toBe(true);
    }
  });
});

describe('capabilitiesGained', () => {
  it('names what a promotion adds', () => {
    expect(capabilitiesGained({ role: 'viewer' }, { role: 'developer' })).toEqual([
      'project.create',
      'project.update',
      'environment.create',
      'environment.update',
      'secret.create',
      'secret.update',
      'secret.delete',
      'secret.rotate',
    ]);
  });

  it('is empty for a demotion and for no change', () => {
    for (const from of ROLES) {
      for (const to of ROLES) {
        const gained = capabilitiesGained({ role: from }, { role: to });
        if (ROLES.indexOf(to) <= ROLES.indexOf(from)) expect(gained, `${from}→${to}`).toEqual([]);
        else expect(gained.length, `${from}→${to}`).toBeGreaterThan(0);
      }
    }
  });

  it('is computed through the member’s own custom role', () => {
    // Developer-based and listing only `secret.read`: as a viewer or as a
    // developer, the member reads and does nothing else — the promotion
    // changes what their role *is*, not what their grants let them do.
    const readOnly = customRole({ baseRole: 'developer', allowedActions: ['secret.read'] });

    expect(
      capabilitiesGained(
        { role: 'viewer', customRole: readOnly },
        afterRoleChange({ role: 'viewer', customRole: readOnly }, 'developer'),
      ),
    ).toEqual([]);
  });
});

describe('afterRoleChange', () => {
  it('keeps the custom role through any change below owner', () => {
    const held = customRole({ baseRole: 'developer' });

    expect(afterRoleChange({ role: 'viewer', customRole: held }, 'admin')).toEqual({
      role: 'admin',
      customRole: held,
    });
    expect(afterRoleChange({ role: 'viewer' }, 'admin')).toEqual({ role: 'admin' });
  });

  it('drops it on a promotion to owner, as the repository does', () => {
    expect(afterRoleChange({ role: 'admin', customRole: customRole() }, 'owner')).toEqual({
      role: 'owner',
    });
  });
});

/* ── Minting a service token ───────────────────────────────────────────── */

describe('serviceTokenActionsAt', () => {
  it('is every service-token action the level satisfies', () => {
    expect(serviceTokenActionsAt('none')).toEqual([]);
    expect(serviceTokenActionsAt('read')).toEqual(['secret.read']);
    expect(serviceTokenActionsAt('write')).toEqual([
      'secret.read',
      'secret.create',
      'secret.update',
    ]);
    expect(serviceTokenActionsAt('admin')).toEqual(serviceTokenActionsAt('write'));
  });
});

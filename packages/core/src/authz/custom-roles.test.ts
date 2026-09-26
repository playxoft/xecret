import { describe, expect, it } from 'vitest';

import { can } from './can';
import { resolveAccessLevel } from './grants';
import type { Membership } from './grants';
import {
  ACTION_REQUIREMENTS,
  canAssignRole,
  canDefineCustomRole,
  compareAccessLevel,
  compareOrgRole,
  CUSTOM_ROLE_FLOOR,
  effectiveCapabilities,
  effectiveRole,
  narrowAccessDefaults,
  ROLE_ACCESS_DEFAULTS,
  ROLE_CAPABILITIES,
  roleWithinAuthority,
} from './roles';
import type { CustomRole, RoleAccessDefaults } from './roles';
import type { AccessLevel, Action, Actor, OrgRole, Resource } from './types';

/**
 * Custom roles, and the single property they stand on.
 *
 * A custom role can only **subtract**. It names a built-in base role and is
 * resolved as `base AND custom`, never as `custom` alone — so there is no row
 * in the database, malformed or malicious, that grants a capability the base
 * role does not already hold.
 *
 * That is worth proving rather than asserting, because it is the difference
 * between a feature and an escalation path. Most of this file is the same
 * question asked from different directions: can a custom role be made to grant
 * something?
 */

const ORG_ID = 'org-1';
const PROJECT_ID = 'project-1';
const ENV_ID = 'env-1';

const ALL_ACTIONS = Object.keys(ROLE_CAPABILITIES.owner) as Action[];
const ROLES: readonly OrgRole[] = ['viewer', 'developer', 'admin', 'owner'];

/** The lesser of two roles, written out independently of `effectiveRole`. */
function lower(a: OrgRole, b: OrgRole): OrgRole {
  return compareOrgRole(a, b) <= 0 ? a : b;
}

function actor(): Actor {
  return { kind: 'user', userId: 'user-1', orgId: ORG_ID };
}

function environment(): Resource {
  return { kind: 'environment', orgId: ORG_ID, projectId: PROJECT_ID, environmentId: ENV_ID };
}

function org(): Resource {
  return { kind: 'org', orgId: ORG_ID };
}

function project(): Resource {
  return { kind: 'project', orgId: ORG_ID, projectId: PROJECT_ID };
}

const LEVELS: readonly AccessLevel[] = ['none', 'read', 'write', 'admin'];

function membership(over: Partial<Membership> = {}): Membership {
  return { role: 'developer', memberStatus: 'active', grants: [], ...over };
}

function customRole(over: Partial<CustomRole> = {}): CustomRole {
  return {
    id: 'role-1',
    name: 'Deployer',
    baseRole: 'developer',
    allowedActions: ['secret.read'],
    ...over,
  };
}

/* ───────────────────────────────────────────────────────────────────────────
 * The property everything else rests on.
 * ─────────────────────────────────────────────────────────────────────────── */
describe('a custom role can only subtract', () => {
  it('cannot grant an action its base role lacks — for any base, any action', () => {
    // The exhaustive form, because a single example proves only that one case
    // was considered. A custom role claiming every action in the product, on
    // every base role, still ends up with exactly what the base role had.
    for (const base of ['viewer', 'developer', 'admin', 'owner'] as const) {
      const greedy = customRole({ baseRole: base, allowedActions: ALL_ACTIONS });
      const effective = effectiveCapabilities(base, greedy);

      for (const action of ALL_ACTIONS) {
        expect(effective[action], `${base} + custom claiming everything gained "${action}"`).toBe(
          ROLE_CAPABILITIES[base][action],
        );
      }
    }
  });

  it('a viewer with a custom role claiming every action still cannot write', () => {
    // An `admin` grant on the environment, so the level gate passes and only
    // the capability gate — the base role's `false` — is left to refuse. Without
    // it the viewer's default `read` would deny the write on its own, and this
    // would pass whether or not the base were consulted at all.
    const context = {
      membership: membership({
        role: 'viewer',
        customRole: customRole({ baseRole: 'viewer', allowedActions: ALL_ACTIONS }),
        grants: [{ projectId: PROJECT_ID, environmentId: ENV_ID, accessLevel: 'admin' as const }],
      }),
      isProduction: false,
    };

    expect(can(actor(), 'secret.update', environment(), context).allowed).toBe(false);
    // The same member reads: the grant is live, and it is the capability alone
    // that stopped the write.
    expect(can(actor(), 'secret.read', environment(), context).allowed).toBe(true);
  });

  it('a developer with a custom role claiming member management still cannot manage members', () => {
    const decision = can(actor(), 'member.invite', org(), {
      membership: membership({
        customRole: customRole({ allowedActions: ['member.invite', 'member.remove'] }),
      }),
      isProduction: false,
    });

    expect(decision.allowed).toBe(false);
  });

  it('naming an action the base role lacks contributes nothing at all', () => {
    const effective = effectiveCapabilities(
      'developer',
      customRole({ allowedActions: ['org.delete', 'secret.read'] }),
    );

    expect(effective['org.delete']).toBe(false);
    expect(effective['secret.read']).toBe(true);
  });
});

/* ───────────────────────────────────────────────────────────────────────────
 * A member's `role` and their custom role's `baseRole` need not agree. The
 * lower of the two governs — for capabilities, defaults, and role authority.
 * ─────────────────────────────────────────────────────────────────────────── */
describe('effectiveRole', () => {
  it('is the member’s own role when there is no custom role', () => {
    for (const role of ROLES) {
      expect(effectiveRole(role, undefined)).toBe(role);
    }
  });

  it('is the base role when the base is below the member’s role', () => {
    expect(effectiveRole('admin', customRole({ baseRole: 'viewer' }))).toBe('viewer');
    expect(effectiveRole('owner', customRole({ baseRole: 'admin' }))).toBe('admin');
  });

  it('is the member’s role when the base is above it — a base never raises', () => {
    // A viewer assigned a custom role based on `owner` is still a viewer. The
    // row is nonsense, and nonsense must resolve in the safe direction.
    expect(effectiveRole('viewer', customRole({ baseRole: 'owner' }))).toBe('viewer');
    expect(effectiveRole('developer', customRole({ baseRole: 'admin' }))).toBe('developer');
  });

  it('is the lower of the two for every pair', () => {
    for (const role of ROLES) {
      for (const base of ROLES) {
        expect(effectiveRole(role, customRole({ baseRole: base })), `${role} + ${base}`).toBe(
          lower(role, base),
        );
      }
    }
  });
});

describe('a base role below the member’s own role', () => {
  it('caps capabilities at the lower role, whatever the pairing', () => {
    // The exhaustive form of the escalation this closes: a custom role that
    // claims every action, on any base, assigned to any member, is worth
    // exactly the capability row of the lower of the two roles.
    for (const role of ROLES) {
      for (const base of ROLES) {
        const greedy = customRole({ baseRole: base, allowedActions: ALL_ACTIONS });
        const effective = effectiveCapabilities(role, greedy);

        for (const action of ALL_ACTIONS) {
          expect(effective[action], `${role} + base ${base} gained "${action}"`).toBe(
            ROLE_CAPABILITIES[lower(role, base)][action],
          );
        }
      }
    }
  });

  it('an admin holding a viewer-based role that lists writes cannot write or invite', () => {
    // "Auditor": based on `viewer`, but with an allow list that names writes.
    // On an admin, reading the member's own role would have let the list
    // through, and the base role's ceiling would have been decorative.
    const auditor = customRole({
      name: 'Auditor',
      baseRole: 'viewer',
      allowedActions: ['secret.read', 'secret.update', 'member.invite'],
    });

    const write = can(actor(), 'secret.update', environment(), {
      membership: membership({
        role: 'admin',
        customRole: auditor,
        grants: [{ projectId: PROJECT_ID, environmentId: ENV_ID, accessLevel: 'admin' }],
      }),
      isProduction: false,
    });
    const invite = can(actor(), 'member.invite', org(), {
      membership: membership({ role: 'admin', customRole: auditor }),
      isProduction: false,
    });
    const read = can(actor(), 'secret.read', environment(), {
      membership: membership({ role: 'admin', customRole: auditor }),
      isProduction: false,
    });

    expect(write.allowed).toBe(false);
    expect(invite.allowed).toBe(false);
    // What the base permits and the list names still works.
    expect(read.allowed).toBe(true);
  });

  it('takes the access defaults from the lower role too', () => {
    // An admin's default is `admin` everywhere; a developer's is `none` on
    // production. On a developer-based custom role, the admin gets the latter.
    const defaults = narrowAccessDefaults('admin', customRole({ baseRole: 'developer' }));

    expect(defaults).toEqual(ROLE_ACCESS_DEFAULTS.developer);
  });

  it('resolves an ungranted environment to the lower role’s default', () => {
    const context = membership({
      role: 'admin',
      customRole: customRole({ baseRole: 'developer' }),
    });

    expect(resolveAccessLevel({ ...context, isProduction: true }, PROJECT_ID, ENV_ID)).toBe('none');
    expect(resolveAccessLevel({ ...context, isProduction: false }, PROJECT_ID, ENV_ID)).toBe(
      'write',
    );
  });

  it('refuses production end to end to an admin on a developer-based role with no grant', () => {
    const decision = can(actor(), 'secret.read', environment(), {
      membership: membership({
        role: 'admin',
        customRole: customRole({ baseRole: 'developer', allowedActions: ALL_ACTIONS }),
      }),
      isProduction: true,
    });

    expect(decision.allowed).toBe(false);
  });

  it('a base above the member’s role raises neither capabilities nor defaults', () => {
    const inflated = customRole({ baseRole: 'owner', allowedActions: ALL_ACTIONS });

    expect(effectiveCapabilities('viewer', inflated)).toEqual(ROLE_CAPABILITIES.viewer);
    expect(narrowAccessDefaults('viewer', inflated)).toEqual(ROLE_ACCESS_DEFAULTS.viewer);
  });
});

describe('the positive list is fail-closed', () => {
  it('an action the custom role does not name is denied, even where the base allows it', () => {
    // The deliberate cost of a positive list: a capability added to the product
    // later does not reach existing custom roles until somebody edits them.
    // That surfaces as a support conversation; a deny list would surface as an
    // unaudited capability nobody decided to grant.
    const effective = effectiveCapabilities('developer', customRole({ allowedActions: [] }));

    for (const action of ALL_ACTIONS) {
      if (CUSTOM_ROLE_FLOOR.includes(action)) continue;
      expect(effective[action], `"${action}" leaked through an empty allow list`).toBe(false);
    }
  });

  it('an empty custom role is a role that can do nothing, not a role that is ignored', () => {
    const decision = can(actor(), 'secret.read', environment(), {
      membership: membership({ customRole: customRole({ allowedActions: [] }) }),
      isProduction: false,
    });

    expect(decision.allowed).toBe(false);
  });
});

/* ───────────────────────────────────────────────────────────────────────────
 * The floor: `member.read` is how every route asks "is this an active member?",
 * so a custom role cannot take it away — and cannot use it to add anything.
 * ─────────────────────────────────────────────────────────────────────────── */
describe('the custom-role floor', () => {
  it('is member.read, which every built-in role holds', () => {
    // The floor is safe because it is inside every base: an entry some role
    // lacked would still be ANDed away for that role, but "the floor adds
    // nothing" is easier to trust when it is simply true.
    expect(CUSTOM_ROLE_FLOOR).toEqual(['member.read']);
    for (const role of ROLES) {
      for (const action of CUSTOM_ROLE_FLOOR) {
        expect(ROLE_CAPABILITIES[role][action], `${role} lacks floor action ${action}`).toBe(true);
      }
    }
  });

  it('gives an empty custom role exactly the floor, on every pairing', () => {
    for (const role of ROLES) {
      for (const base of ROLES) {
        const effective = effectiveCapabilities(
          role,
          customRole({ baseRole: base, allowedActions: [] }),
        );
        const held = ALL_ACTIONS.filter((action) => effective[action]);

        expect(held, `${role} + base ${base}`).toEqual([...CUSTOM_ROLE_FLOOR]);
      }
    }
  });

  it('keeps the holder of an empty custom role a member, end to end', () => {
    // The lockout this closes: `member.read` gates the organisation summary,
    // the project listing and CLI approval. Omitted from a positive list, it
    // left the member outside their own organisation.
    const decision = can(actor(), 'member.read', org(), {
      membership: membership({ customRole: customRole({ allowedActions: [] }) }),
      isProduction: false,
    });

    expect(decision.allowed).toBe(true);
  });

  it('never outlives suspension', () => {
    const decision = can(actor(), 'member.read', org(), {
      membership: membership({
        memberStatus: 'suspended',
        customRole: customRole({ allowedActions: [] }),
      }),
      isProduction: false,
    });

    expect(decision.allowed).toBe(false);
  });

  it('still only subtracts — with the floor, nothing held is outside the lower role', () => {
    for (const role of ROLES) {
      for (const base of ROLES) {
        for (const allowedActions of [[], ALL_ACTIONS] as const) {
          const effective = effectiveCapabilities(
            role,
            customRole({ baseRole: base, allowedActions }),
          );
          for (const action of ALL_ACTIONS) {
            if (!effective[action]) continue;
            expect(
              ROLE_CAPABILITIES[lower(role, base)][action],
              `${role} + base ${base} gained "${action}"`,
            ).toBe(true);
          }
        }
      }
    }
  });
});

describe('no custom role means nothing changes', () => {
  it('returns the built-in table by identity, so the two paths cannot diverge', () => {
    for (const role of ['viewer', 'developer', 'admin', 'owner'] as const) {
      expect(effectiveCapabilities(role, undefined)).toBe(ROLE_CAPABILITIES[role]);
    }
  });

  it('leaves every existing decision untouched', () => {
    const withoutCustom = can(actor(), 'secret.read', environment(), {
      membership: membership(),
      isProduction: false,
    });

    expect(withoutCustom.allowed).toBe(true);
  });
});

/* ───────────────────────────────────────────────────────────────────────────
 * The access ceiling.
 * ─────────────────────────────────────────────────────────────────────────── */
describe('the access ceiling', () => {
  it('lowers a role default', () => {
    const defaults = narrowAccessDefaults(
      'developer',
      customRole({ accessCeiling: { nonProduction: 'read', production: 'none' } }),
    );

    expect(defaults.nonProduction).toBe('read');
    expect(defaults.production).toBe('none');
  });

  it('cannot raise one', () => {
    const defaults = narrowAccessDefaults(
      'developer',
      customRole({ accessCeiling: { nonProduction: 'admin', production: 'admin' } }),
    );

    expect(defaults.nonProduction).toBe(ROLE_ACCESS_DEFAULTS.developer.nonProduction);
    expect(defaults.production).toBe(ROLE_ACCESS_DEFAULTS.developer.production);
  });

  it('caps an explicit grant, not only the default', () => {
    // A ceiling a grant can exceed is not a ceiling. "A developer who can never
    // reach production" has to stay true the first time an ordinary admin
    // writes an ordinary production grant for that member — which is the exact
    // mistake the role exists to make impossible.
    const level = resolveAccessLevel(
      {
        ...membership({
          customRole: customRole({
            accessCeiling: { nonProduction: 'write', production: 'none' },
          }),
          grants: [{ projectId: PROJECT_ID, environmentId: ENV_ID, accessLevel: 'admin' }],
        }),
        isProduction: true,
      },
      PROJECT_ID,
      ENV_ID,
    );

    expect(level).toBe('none');
  });

  it('leaves a grant alone when it is already under the ceiling', () => {
    const level = resolveAccessLevel(
      {
        ...membership({
          customRole: customRole({
            accessCeiling: { nonProduction: 'write', production: 'none' },
          }),
          grants: [{ projectId: PROJECT_ID, environmentId: ENV_ID, accessLevel: 'read' }],
        }),
        isProduction: false,
      },
      PROJECT_ID,
      ENV_ID,
    );

    expect(level).toBe('read');
  });

  it('is absent by default, so a custom role without one changes no level', () => {
    const level = resolveAccessLevel(
      {
        ...membership({
          customRole: customRole(),
          grants: [{ projectId: PROJECT_ID, environmentId: ENV_ID, accessLevel: 'admin' }],
        }),
        isProduction: true,
      },
      PROJECT_ID,
      ENV_ID,
    );

    expect(level).toBe('admin');
  });

  it('refuses production to a capped role end to end', () => {
    const decision = can(actor(), 'secret.update', environment(), {
      membership: membership({
        customRole: customRole({
          allowedActions: ['secret.read', 'secret.update'],
          accessCeiling: { nonProduction: 'write', production: 'none' },
        }),
        grants: [{ projectId: PROJECT_ID, environmentId: ENV_ID, accessLevel: 'admin' }],
      }),
      isProduction: true,
    });

    expect(decision.allowed).toBe(false);
  });

  it('permits the same member the same action outside production', () => {
    const decision = can(actor(), 'secret.update', environment(), {
      membership: membership({
        customRole: customRole({
          allowedActions: ['secret.read', 'secret.update'],
          accessCeiling: { nonProduction: 'write', production: 'none' },
        }),
      }),
      isProduction: false,
    });

    expect(decision.allowed).toBe(true);
  });
});

describe('the ceiling caps grants at the ceiling, not at the role default', () => {
  // A developer's production default is `none`. A production ceiling of `read`
  // says "never more than read" — it must not also mean "never more than
  // none", which is what capping at the narrowed default would make of it.
  const readOnlyProduction = customRole({
    allowedActions: ['secret.read', 'secret.update'],
    accessCeiling: { nonProduction: 'write', production: 'read' },
  });

  function productionLevel(grant: AccessLevel | undefined): AccessLevel {
    return resolveAccessLevel(
      {
        ...membership({
          customRole: readOnlyProduction,
          grants:
            grant === undefined
              ? []
              : [{ projectId: PROJECT_ID, environmentId: ENV_ID, accessLevel: grant }],
        }),
        isProduction: true,
      },
      PROJECT_ID,
      ENV_ID,
    );
  }

  it('lets an explicit grant at the ceiling through', () => {
    expect(productionLevel('read')).toBe('read');
  });

  it('caps an explicit grant above the ceiling to the ceiling', () => {
    expect(productionLevel('write')).toBe('read');
    expect(productionLevel('admin')).toBe('read');
  });

  it('still falls back to the role default where no grant speaks', () => {
    // The ceiling is a limit, not a grant: without an explicit row the member
    // gets the weaker of the role default (`none`) and the ceiling (`read`).
    expect(productionLevel(undefined)).toBe('none');
  });

  it('lets a capped production grant read, and still refuses the write it was written for', () => {
    const context = {
      membership: membership({
        customRole: readOnlyProduction,
        grants: [{ projectId: PROJECT_ID, environmentId: ENV_ID, accessLevel: 'write' as const }],
      }),
      isProduction: true,
    };

    expect(can(actor(), 'secret.read', environment(), context).allowed).toBe(true);
    expect(can(actor(), 'secret.update', environment(), context).allowed).toBe(false);
  });

  it('caps a role default above the ceiling to the ceiling', () => {
    // The other direction: an admin's default is `admin`, and a ceiling of
    // `read` brings it down whether or not anybody wrote a grant.
    const level = resolveAccessLevel(
      {
        ...membership({
          role: 'admin',
          customRole: customRole({
            baseRole: 'admin',
            accessCeiling: { nonProduction: 'read', production: 'read' },
          }),
        }),
        isProduction: true,
      },
      PROJECT_ID,
      ENV_ID,
    );

    expect(level).toBe('read');
  });
});

/* ───────────────────────────────────────────────────────────────────────────
 * Who may define one.
 * ─────────────────────────────────────────────────────────────────────────── */
describe('canDefineCustomRole', () => {
  it('refuses a base above the actor’s own role', () => {
    // Without this, an admin defines a role on a base above their own and
    // assigns it — routing around `canAssignRole` rather than breaking it.
    expect(canDefineCustomRole({ role: 'developer' }, 'admin')).toBe(false);
    expect(canDefineCustomRole({ role: 'viewer' }, 'developer')).toBe(false);
  });

  it('refuses an owner base to everybody, owners included', () => {
    // The database refuses the row as well; the predicate says so first, so a
    // route answers 403 rather than surfacing a constraint violation.
    for (const role of ROLES) {
      expect(canDefineCustomRole({ role }, 'owner'), role).toBe(false);
    }
  });

  it('permits a non-owner base at or below an unrestricted actor’s role', () => {
    expect(canDefineCustomRole({ role: 'owner' }, 'admin')).toBe(true);
    expect(canDefineCustomRole({ role: 'admin' }, 'admin')).toBe(true);
    expect(canDefineCustomRole({ role: 'admin' }, 'viewer')).toBe(true);
  });

  it('refuses every actor who holds a custom role, however wide it is', () => {
    // A narrowed actor defining roles is writing the rules they are narrowed
    // by — at the limit, editing the role they hold. Even a custom role that
    // narrows nothing does not qualify: the rule has no exceptions to reason
    // about.
    const noOp = customRole({ baseRole: 'admin', allowedActions: ALL_ACTIONS });
    for (const role of ROLES) {
      for (const base of ROLES) {
        expect(
          canDefineCustomRole({ role, customRole: noOp }, base),
          `${role} holding a custom role, defining on ${base}`,
        ).toBe(false);
      }
    }
  });

  it('is canAssignRole for an unrestricted actor on every non-owner base', () => {
    for (const actorRole of ROLES) {
      for (const base of ROLES) {
        if (base === 'owner') continue;
        expect(canDefineCustomRole({ role: actorRole }, base), `${actorRole} → ${base}`).toBe(
          canAssignRole(actorRole, base),
        );
      }
    }
  });
});

/* ───────────────────────────────────────────────────────────────────────────
 * You can't hand out what you don't hold.
 * ─────────────────────────────────────────────────────────────────────────── */
describe('roleWithinAuthority', () => {
  it('is exactly canAssignRole for every actor without a custom role', () => {
    // The pin that keeps plain admins and owners where they were. It holds
    // because the built-in tables nest; a table edit that broke the nesting
    // would change who a plain admin may appoint, and must fail here first.
    for (const actorRole of ROLES) {
      for (const subject of ROLES) {
        expect(roleWithinAuthority({ role: actorRole }, subject), `${actorRole} → ${subject}`).toBe(
          canAssignRole(actorRole, subject),
        );
      }
    }
  });

  it('is canAssignRole too for a custom role that narrows nothing', () => {
    // Base equal to the member's role, every action listed, no ceiling: the
    // custom role changes nothing, and so neither may this.
    for (const actorRole of ROLES) {
      const noOp = customRole({ baseRole: actorRole, allowedActions: ALL_ACTIONS });
      for (const subject of ROLES) {
        expect(
          roleWithinAuthority({ role: actorRole, customRole: noOp }, subject),
          `${actorRole} (no-op custom role) → ${subject}`,
        ).toBe(canAssignRole(actorRole, subject));
      }
    }
  });

  it('refuses a role carrying a capability the actor’s custom role withholds', () => {
    // "Member manager": admin-based, member management only. By rank it is an
    // admin and could invite one — who would hold on day one the secrets,
    // tokens and projects this role was defined to withhold.
    const memberManager = {
      role: 'admin' as const,
      customRole: customRole({
        baseRole: 'admin',
        allowedActions: ['member.read', 'member.invite', 'member.update', 'member.remove'],
      }),
    };

    expect(roleWithinAuthority(memberManager, 'admin')).toBe(false);
    expect(roleWithinAuthority(memberManager, 'developer')).toBe(false);
    // Even a viewer reads projects and secrets this role cannot.
    expect(roleWithinAuthority(memberManager, 'viewer')).toBe(false);
  });

  it('permits a role whose every capability the actor holds', () => {
    const viewerCapabilities = ALL_ACTIONS.filter((action) => ROLE_CAPABILITIES.viewer[action]);
    const manager = {
      role: 'admin' as const,
      customRole: customRole({
        baseRole: 'admin',
        allowedActions: [...viewerCapabilities, 'member.invite', 'member.update'],
      }),
    };

    expect(roleWithinAuthority(manager, 'viewer')).toBe(true);
    expect(roleWithinAuthority(manager, 'developer')).toBe(false);
  });

  it('refuses a role whose production default exceeds the actor’s ceiling', () => {
    // Every capability, but capped at `none` on production: an admin's default
    // there is `admin`, so appointing one hands out production.
    const noProduction = {
      role: 'admin' as const,
      customRole: customRole({
        baseRole: 'admin',
        allowedActions: ALL_ACTIONS,
        accessCeiling: { nonProduction: 'admin', production: 'none' },
      }),
    };

    expect(roleWithinAuthority(noProduction, 'admin')).toBe(false);
    // Developers and viewers default to `none` on production.
    expect(roleWithinAuthority(noProduction, 'developer')).toBe(true);
    expect(roleWithinAuthority(noProduction, 'viewer')).toBe(true);
  });

  it('measures non-production defaults against the ceiling too', () => {
    const readOnly = {
      role: 'admin' as const,
      customRole: customRole({
        baseRole: 'admin',
        allowedActions: ALL_ACTIONS,
        accessCeiling: { nonProduction: 'read', production: 'none' },
      }),
    };

    // A developer's non-production default is `write`.
    expect(roleWithinAuthority(readOnly, 'developer')).toBe(false);
    expect(roleWithinAuthority(readOnly, 'viewer')).toBe(true);
  });

  it('measures rank by the lower of the actor’s two roles', () => {
    const narrowedOwner = {
      role: 'owner' as const,
      customRole: customRole({ baseRole: 'admin', allowedActions: ALL_ACTIONS }),
    };
    expect(roleWithinAuthority(narrowedOwner, 'owner')).toBe(false);
    expect(roleWithinAuthority(narrowedOwner, 'admin')).toBe(true);

    const inflated = {
      role: 'developer' as const,
      customRole: customRole({ baseRole: 'owner', allowedActions: ALL_ACTIONS }),
    };
    expect(roleWithinAuthority(inflated, 'admin')).toBe(false);
    expect(roleWithinAuthority(inflated, 'owner')).toBe(false);
  });

  it('never permits more than canAssignRole, whatever the custom role', () => {
    const ceilings: (RoleAccessDefaults | undefined)[] = [
      undefined,
      { nonProduction: 'admin', production: 'none' },
      { nonProduction: 'read', production: 'read' },
    ];
    for (const actorRole of ROLES) {
      for (const base of ROLES) {
        for (const accessCeiling of ceilings) {
          const holder = {
            role: actorRole,
            customRole: customRole({ baseRole: base, allowedActions: ALL_ACTIONS, accessCeiling }),
          };
          for (const subject of ROLES) {
            if (!roleWithinAuthority(holder, subject)) continue;
            expect(canAssignRole(actorRole, subject), `${actorRole}/${base} → ${subject}`).toBe(
              true,
            );
          }
        }
      }
    }
  });
});

/* ───────────────────────────────────────────────────────────────────────────
 * Project scope: evaluated without production — except where the action
 * reaches production anyway.
 * ─────────────────────────────────────────────────────────────────────────── */
describe('the ceiling at project scope', () => {
  function projectContext(over: Partial<Membership> & { customRole?: CustomRole | undefined }): {
    membership: Membership;
    isProduction: boolean;
  } {
    // `isProduction: false`, as `authorize()` passes for every project-level
    // resource — the engine decides production-awareness itself.
    return { membership: membership({ role: 'admin', ...over }), isProduction: false };
  }

  it('applies the non-production ceiling to project-level actions', () => {
    const context = projectContext({
      customRole: customRole({
        baseRole: 'admin',
        allowedActions: ALL_ACTIONS,
        accessCeiling: { nonProduction: 'read', production: 'admin' },
      }),
    });

    // `project.update` needs `admin` at the project; the ceiling holds it to
    // `read`. Reading the project is untouched.
    expect(can(actor(), 'project.update', project(), context).allowed).toBe(false);
    expect(can(actor(), 'project.read', project(), context).allowed).toBe(true);
  });

  it('does not apply the production ceiling to ordinary project-level actions', () => {
    // Production is a property of an environment. A member capped at `none` on
    // production still renames the project and adds environments to it.
    const context = projectContext({
      customRole: customRole({
        baseRole: 'admin',
        allowedActions: ALL_ACTIONS,
        accessCeiling: { nonProduction: 'admin', production: 'none' },
      }),
    });

    expect(can(actor(), 'project.update', project(), context).allowed).toBe(true);
    expect(can(actor(), 'environment.create', project(), context).allowed).toBe(true);
  });

  it('caps a project grant at the non-production ceiling', () => {
    const context = projectContext({
      customRole: customRole({
        baseRole: 'admin',
        allowedActions: ALL_ACTIONS,
        accessCeiling: { nonProduction: 'write', production: 'admin' },
      }),
      grants: [{ projectId: PROJECT_ID, environmentId: null, accessLevel: 'admin' }],
    });

    expect(can(actor(), 'project.update', project(), context).allowed).toBe(false);
    expect(can(actor(), 'environment.create', project(), context).allowed).toBe(true);
  });
});

describe('project.delete answers for the production inside the project', () => {
  it('is the only action that includes production at project scope', () => {
    const including = ALL_ACTIONS.filter((action) => {
      const requirement = ACTION_REQUIREMENTS[action];
      return requirement.scope === 'project' && requirement.includesProduction === true;
    });

    expect(including).toEqual(['project.delete']);
  });

  it('is refused to a member capped at none on production', () => {
    // The finding: without this, deleting the project was the way round a
    // production ceiling of `none` — it deletes every environment in it.
    const decision = can(actor(), 'project.delete', project(), {
      membership: membership({
        role: 'admin',
        customRole: customRole({
          baseRole: 'admin',
          allowedActions: ALL_ACTIONS,
          accessCeiling: { nonProduction: 'admin', production: 'none' },
        }),
      }),
      isProduction: false,
    });

    expect(decision.allowed).toBe(false);
  });

  it('caps a project grant at the production ceiling for this action alone', () => {
    const context = {
      membership: membership({
        role: 'admin',
        customRole: customRole({
          baseRole: 'admin',
          allowedActions: ALL_ACTIONS,
          accessCeiling: { nonProduction: 'admin', production: 'write' },
        }),
        grants: [{ projectId: PROJECT_ID, environmentId: null, accessLevel: 'admin' as const }],
      }),
      isProduction: false,
    };

    expect(can(actor(), 'project.delete', project(), context).allowed).toBe(false);
    expect(can(actor(), 'project.update', project(), context).allowed).toBe(true);
  });

  it('is allowed where the production ceiling permits admin', () => {
    const decision = can(actor(), 'project.delete', project(), {
      membership: membership({
        role: 'admin',
        customRole: customRole({
          baseRole: 'admin',
          allowedActions: ALL_ACTIONS,
          accessCeiling: { nonProduction: 'admin', production: 'admin' },
        }),
      }),
      isProduction: false,
    });

    expect(decision.allowed).toBe(true);
  });

  it('changes no decision for a member without a custom role', () => {
    // Exhaustive over roles × {no grant, every project-grant level} × every
    // project-scoped action, against the rule as it stood before: capability,
    // then the project level with production left out.
    const projectActions = ALL_ACTIONS.filter(
      (action) => ACTION_REQUIREMENTS[action].scope === 'project',
    );
    const grantings: (AccessLevel | undefined)[] = [undefined, ...LEVELS];

    for (const role of ROLES) {
      for (const granted of grantings) {
        const plain = membership({
          role,
          grants:
            granted === undefined
              ? []
              : [{ projectId: PROJECT_ID, environmentId: null, accessLevel: granted }],
        });
        for (const action of projectActions) {
          const requirement = ACTION_REQUIREMENTS[action];
          if (requirement.scope !== 'project') continue;

          const before =
            ROLE_CAPABILITIES[role][action] &&
            compareAccessLevel(
              resolveAccessLevel({ ...plain, isProduction: false }, PROJECT_ID, null),
              requirement.minimum,
            ) >= 0;

          expect(
            can(actor(), action, project(), { membership: plain, isProduction: false }).allowed,
            `${role}, project grant ${granted ?? '(none written)'}, ${action}`,
          ).toBe(before);
        }
      }
    }
  });
});

/* ───────────────────────────────────────────────────────────────────────────
 * The fall-through and the derived defaults agree.
 * ─────────────────────────────────────────────────────────────────────────── */
describe('narrowAccessDefaults', () => {
  it('is what resolution gives wherever no grant speaks, for every pairing and ceiling', () => {
    // `resolveAccessLevel` falls through to the plain role default and lets
    // `capAtCeiling` narrow it once; `narrowAccessDefaults` computes the same
    // thing in one step, for questions asked about a role rather than a
    // resource. The two must not drift.
    for (const role of ROLES) {
      for (const base of ROLES) {
        for (const nonProduction of LEVELS) {
          for (const production of LEVELS) {
            const custom = customRole({
              baseRole: base,
              accessCeiling: { nonProduction, production },
            });
            const defaults = narrowAccessDefaults(role, custom);
            const context = membership({ role, customRole: custom });

            expect(
              resolveAccessLevel({ ...context, isProduction: false }, PROJECT_ID, ENV_ID),
              `${role}/${base} ceiling ${nonProduction}/${production}, non-production`,
            ).toBe(defaults.nonProduction);
            expect(
              resolveAccessLevel({ ...context, isProduction: true }, PROJECT_ID, ENV_ID),
              `${role}/${base} ceiling ${nonProduction}/${production}, production`,
            ).toBe(defaults.production);
          }
        }
      }
    }
  });
});

describe('the gates stay independent', () => {
  it('suspension still beats every custom role', () => {
    const decision = can(actor(), 'secret.read', environment(), {
      membership: membership({
        memberStatus: 'suspended',
        customRole: customRole({ baseRole: 'owner', allowedActions: ALL_ACTIONS }),
      }),
      isProduction: false,
    });

    expect(decision.allowed).toBe(false);
  });

  it('tenancy still beats every custom role', () => {
    const decision = can(
      actor(),
      'secret.read',
      { kind: 'environment', orgId: 'other-org', projectId: PROJECT_ID, environmentId: ENV_ID },
      {
        membership: membership({
          customRole: customRole({ baseRole: 'owner', allowedActions: ALL_ACTIONS }),
        }),
        isProduction: false,
      },
    );

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toBe('notFound');
  });

  it('a service token is unaffected — it has no membership and therefore no custom role', () => {
    const decision = can(
      {
        kind: 'serviceToken',
        tokenId: 'tok-1',
        orgId: ORG_ID,
        projectId: PROJECT_ID,
        environmentId: ENV_ID,
      },
      'secret.read',
      environment(),
      { serviceToken: { accessLevel: 'read' }, isProduction: false },
    );

    expect(decision.allowed).toBe(true);
  });
});

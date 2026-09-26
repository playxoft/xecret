import { describe, expect, it } from 'vitest';

import { can } from './can';
import { resolveAccessLevel } from './grants';
import type { Membership } from './grants';
import {
  canAssignRole,
  canDefineCustomRole,
  compareOrgRole,
  effectiveCapabilities,
  effectiveRole,
  narrowAccessDefaults,
  ROLE_ACCESS_DEFAULTS,
  ROLE_CAPABILITIES,
} from './roles';
import type { CustomRole } from './roles';
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
    const decision = can(actor(), 'secret.update', environment(), {
      membership: membership({
        role: 'viewer',
        customRole: customRole({ baseRole: 'viewer', allowedActions: ALL_ACTIONS }),
      }),
      isProduction: false,
    });

    expect(decision.allowed).toBe(false);
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
    // Without this, an admin defines a role based on `owner`, assigns it to
    // themselves, and holds owner authority under another name — routing
    // around `canAssignRole` rather than breaking it.
    expect(canDefineCustomRole('admin', 'owner')).toBe(false);
    expect(canDefineCustomRole('developer', 'admin')).toBe(false);
    expect(canDefineCustomRole('viewer', 'developer')).toBe(false);
  });

  it('permits a base at or below the actor’s own role', () => {
    expect(canDefineCustomRole('owner', 'owner')).toBe(true);
    expect(canDefineCustomRole('admin', 'admin')).toBe(true);
    expect(canDefineCustomRole('admin', 'viewer')).toBe(true);
  });

  it('measures an actor holding a custom role by their effective role', () => {
    // An owner narrowed to an admin-based custom role is an admin for every
    // other purpose. Measured by their stored `owner`, they could hand out —
    // or define — the owner authority their own custom role withholds.
    const narrowedOwner = effectiveRole('owner', customRole({ baseRole: 'admin' }));

    expect(canAssignRole(narrowedOwner, 'owner')).toBe(false);
    expect(canDefineCustomRole(narrowedOwner, 'owner')).toBe(false);
    expect(canAssignRole(narrowedOwner, 'admin')).toBe(true);
  });

  it('is the same predicate as canAssignRole, so the two cannot drift', () => {
    const roles: readonly OrgRole[] = ['viewer', 'developer', 'admin', 'owner'];
    for (const actorRole of roles) {
      for (const target of roles) {
        expect(canDefineCustomRole(actorRole, target)).toBe(canAssignRole(actorRole, target));
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

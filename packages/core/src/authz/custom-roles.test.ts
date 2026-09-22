import { describe, expect, it } from 'vitest';

import { can } from './can';
import { resolveAccessLevel } from './grants';
import type { Membership } from './grants';
import {
  canAssignRole,
  canDefineCustomRole,
  effectiveCapabilities,
  narrowAccessDefaults,
  ROLE_ACCESS_DEFAULTS,
  ROLE_CAPABILITIES,
} from './roles';
import type { CustomRole } from './roles';
import type { Action, Actor, OrgRole, Resource } from './types';

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

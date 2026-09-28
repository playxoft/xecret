import { describe, expect, it, vi } from 'vitest';
import { AuthorizationError, ROLE_CAPABILITIES } from '@xecret/core/authz';
import type { AccessLevel, Action, CustomRole, OrgRole } from '@xecret/core/authz';
import { resolveEntitlements } from '@xecret/core/entitlements';
import { uuidv7 } from '@xecret/core/ids';
import { FieldConflictError, RepositoryError } from '@xecret/db/repositories';
import type {
  AuthorizationContext as StoredAuthorizationContext,
  MemberGrant,
  OrganizationEnvironment,
} from '@xecret/db/repositories';
import { ApiError } from './errors';
import {
  assertCustomRoleChangeWithinAuthority,
  assertCustomRoleEditWithinAuthority,
  assertMayDefineCustomRole,
  mapAuditedMembershipError,
} from './members-service';
import { featureStatus, requireFeature } from './entitlements';
import { memberPatchSchema, toMember } from './schemas/members';
import {
  customRoleCreateSchema,
  customRolePatchSchema,
  sameAccess,
  sameDefinition,
  toAuthorityPayload,
  toCustomRolePayload,
} from './schemas/roles';

/**
 * The custom-role wrappers and schemas, tested where they are pure. That the
 * routes ask them — under the lock, with the right snapshot — is
 * `custom-role-routes.test.ts`; the predicates underneath are
 * `custom-role-changes.test.ts` in core.
 */

const ALL_ACTIONS = Object.keys(ROLE_CAPABILITIES.owner) as Action[];
const PROJECT = uuidv7();
const STAGING = uuidv7();
const PRODUCTION = uuidv7();

function role(over: Partial<CustomRole> = {}): CustomRole {
  return { id: uuidv7(), name: 'Deployer', baseRole: 'developer', allowedActions: [], ...over };
}

function caller(
  over: {
    role?: OrgRole;
    customRole?: CustomRole;
    grants?: { projectId: string; environmentId: string | null; accessLevel: AccessLevel }[];
  } = {},
): StoredAuthorizationContext {
  return {
    orgId: uuidv7(),
    userId: uuidv7(),
    memberId: uuidv7(),
    role: over.role ?? 'admin',
    status: 'active',
    customRole: over.customRole,
    grants: (over.grants ?? []).map((grant) => ({ id: uuidv7(), ...grant })),
  };
}

function gridRow(id: string, isProduction: boolean): OrganizationEnvironment {
  return {
    id,
    projectId: PROJECT,
    name: id,
    slug: id,
    isProduction,
    encryptionMode: 'server',
    sortOrder: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    deletedAt: null,
    project: { id: PROJECT, name: 'API', slug: 'api' },
  };
}

const grid = [gridRow(STAGING, false), gridRow(PRODUCTION, true)];
const productionWrite: MemberGrant = {
  id: uuidv7(),
  projectId: PROJECT,
  environmentId: PRODUCTION,
  accessLevel: 'write',
};
const restrictedAdmin = caller({
  grants: [{ projectId: PROJECT, environmentId: PRODUCTION, accessLevel: 'read' }],
});
const capped = role({ accessCeiling: { nonProduction: 'write', production: 'none' } });
const uncapped = role();

function refusal(check: () => void): AuthorizationError {
  try {
    check();
  } catch (cause) {
    expect(cause).toBeInstanceOf(AuthorizationError);
    expect((cause as AuthorizationError).decision.reason).toBe('forbidden');
    return cause as AuthorizationError;
  }
  return expect.unreachable('the check must refuse');
}

describe('assertMayDefineCustomRole', () => {
  it('lets an unnarrowed owner or admin define on their own base or below', () => {
    for (const base of ['admin', 'developer', 'viewer'] as const) {
      expect(() => assertMayDefineCustomRole(caller({ role: 'owner' }), base)).not.toThrow();
      expect(() => assertMayDefineCustomRole(caller({ role: 'admin' }), base)).not.toThrow();
    }
  });

  it('says which refusal it is: narrowed, or a base above the caller', () => {
    expect(
      refusal(() =>
        assertMayDefineCustomRole(caller({ customRole: role({ baseRole: 'admin' }) }), 'viewer'),
      ).message,
    ).toBe('Only an owner or admin who holds no custom role can define roles.');
    expect(
      refusal(() => assertMayDefineCustomRole(caller({ role: 'developer' }), 'admin')).message,
    ).toBe('You cannot define a role on a base above your own.');
    expect(
      refusal(() => assertMayDefineCustomRole(caller({ role: 'owner' }), 'owner')).message,
    ).toBe('You cannot define a role on a base above your own.');
  });
});

describe('assertCustomRoleEditWithinAuthority', () => {
  it('measures the base being replaced, not only the new one', () => {
    // A developer holding member.update is not reachable with the built-in
    // tables; the definer check is what refuses, on the old base first.
    expect(() =>
      assertCustomRoleEditWithinAuthority(
        caller({ role: 'developer' }),
        role({ baseRole: 'admin' }),
        role({ baseRole: 'viewer' }),
        [],
        grid,
      ),
    ).toThrow(AuthorizationError);
  });

  it('measures held grants only for holders the edit widens', () => {
    const holders = [{ role: 'developer' as const, grants: [productionWrite] }];

    // Narrowing: nothing is switched on, so the restricted admin may.
    expect(() =>
      assertCustomRoleEditWithinAuthority(restrictedAdmin, uncapped, capped, holders, grid),
    ).not.toThrow();
    // Widening: the production row wakes, and this admin grants only `read` there.
    expect(
      refusal(() =>
        assertCustomRoleEditWithinAuthority(restrictedAdmin, capped, uncapped, holders, grid),
      ).message,
    ).toBe('This change would widen a member who holds access grants beyond your own.');
    // A plain admin with nothing written against them holds it all.
    expect(() =>
      assertCustomRoleEditWithinAuthority(caller(), capped, uncapped, holders, grid),
    ).not.toThrow();
  });
});

describe('assertCustomRoleChangeWithinAuthority', () => {
  it('measures the member’s stored role, even for an assignment that only narrows', () => {
    const manager = caller({
      customRole: role({
        baseRole: 'admin',
        allowedActions: ['member.read', 'member.update'],
      }),
    });

    expect(
      refusal(() =>
        assertCustomRoleChangeWithinAuthority(
          manager,
          { role: 'viewer', status: 'active', customRole: undefined },
          capped,
          [],
          grid,
        ),
      ).message,
    ).toBe('You cannot manage a role above your own.');
  });

  it('measures held grants when unassigning lifts a cap', () => {
    const member = { role: 'developer' as const, status: 'active' as const, customRole: capped };

    expect(
      refusal(() =>
        assertCustomRoleChangeWithinAuthority(
          restrictedAdmin,
          member,
          undefined,
          [productionWrite],
          grid,
        ),
      ).message,
    ).toBe('This member holds access grants beyond your own.');
    // Assigning the capped role to somebody who held none narrows them.
    expect(() =>
      assertCustomRoleChangeWithinAuthority(
        restrictedAdmin,
        { ...member, customRole: undefined },
        capped,
        [productionWrite],
        grid,
      ),
    ).not.toThrow();
  });
});

describe('requireFeature and featureStatus for custom roles', () => {
  it('files the refusal before throwing plan_limit, and stays silent when the plan allows', () => {
    const refused = vi.fn();

    expect(() =>
      requireFeature(
        resolveEntitlements({
          plan: 'team',
          status: 'active',
          addonSaml: false,
          addonDirectorySync: false,
        }),
        'customRoles',
        refused,
      ),
    ).toThrow(ApiError);
    expect(refused).toHaveBeenCalledTimes(1);

    refused.mockClear();
    requireFeature(
      resolveEntitlements({
        plan: 'enterprise',
        status: 'active',
        addonSaml: false,
        addonDirectorySync: false,
      }),
      'customRoles',
      refused,
    );
    expect(refused).not.toHaveBeenCalled();
  });

  it('says whether the plan allows it, and which plan would, from the same two facts', () => {
    const team = resolveEntitlements({
      plan: 'team',
      status: 'active',
      addonSaml: false,
      addonDirectorySync: false,
    });
    const enterprise = resolveEntitlements({
      plan: 'enterprise',
      status: 'active',
      addonSaml: false,
      addonDirectorySync: false,
    });

    expect(featureStatus(team, 'customRoles')).toEqual({ enabled: false, upgradeTo: 'enterprise' });
    expect(featureStatus(enterprise, 'customRoles')).toEqual({ enabled: true, upgradeTo: null });
  });
});

describe('mapAuditedMembershipError', () => {
  it('files the category of a repository refusal, then maps it like mapMembershipError', () => {
    const cases = [
      ['conflict', 'conflict', 409],
      ['notFound', 'notFound', 404],
      ['invalid', 'invalidInput', 400],
    ] as const;
    for (const [code, reason, status] of cases) {
      const file = vi.fn();
      try {
        mapAuditedMembershipError(file)(new RepositoryError(code, 'message'));
      } catch (cause) {
        expect((cause as ApiError).status).toBe(status);
      }
      expect(file).toHaveBeenCalledWith(reason);
    }
  });

  it('answers a conflict about one field on that field, still a 409', () => {
    const file = vi.fn();
    try {
      mapAuditedMembershipError(file)(new FieldConflictError('name', 'That name is taken.'));
    } catch (cause) {
      expect((cause as ApiError).status).toBe(409);
      expect((cause as ApiError).toBody('r').error.fields).toEqual([
        { field: 'name', message: 'That name is taken.' },
      ]);
    }
    expect(file).toHaveBeenCalledWith('conflict');
  });

  it('files nothing for a refusal that is not the repository’s — a denial is filed by its own check', () => {
    const file = vi.fn();
    const denial = new AuthorizationError({ allowed: false, reason: 'forbidden', message: 'x' });

    expect(() => mapAuditedMembershipError(file)(denial)).toThrow(denial);
    expect(file).not.toHaveBeenCalled();
  });
});

describe('schemas', () => {
  it('takes a custom role change as its own kind of member patch', () => {
    expect(memberPatchSchema.safeParse({ customRoleId: uuidv7() }).success).toBe(true);
    expect(memberPatchSchema.safeParse({ customRoleId: null }).success).toBe(true);
    expect(memberPatchSchema.safeParse({ customRoleId: 'Deployer' }).success).toBe(false);
    expect(memberPatchSchema.safeParse({ customRoleId: uuidv7().toUpperCase() }).success).toBe(
      false,
    );
    expect(memberPatchSchema.safeParse({ customRoleId: null, status: 'active' }).success).toBe(
      false,
    );
  });

  it('defines a role with a trimmed name, a non-owner base and an optional ceiling', () => {
    expect(
      customRoleCreateSchema.parse({
        name: '  Deployer ',
        baseRole: 'developer',
        allowedActions: [],
      }),
    ).toEqual({ name: 'Deployer', baseRole: 'developer', allowedActions: [] });
    expect(
      customRoleCreateSchema.safeParse({ name: 'x', baseRole: 'owner', allowedActions: [] })
        .success,
    ).toBe(false);
    expect(
      customRoleCreateSchema.safeParse({ name: '', baseRole: 'viewer', allowedActions: [] })
        .success,
    ).toBe(false);
    expect(
      customRoleCreateSchema.safeParse({
        name: 'x'.repeat(41),
        baseRole: 'viewer',
        allowedActions: [],
      }).success,
    ).toBe(false);
    expect(
      customRoleCreateSchema.safeParse({
        name: 'x',
        baseRole: 'viewer',
        allowedActions: ['secret.teleport'],
      }).success,
    ).toBe(false);
    expect(
      customRoleCreateSchema.safeParse({
        name: 'x',
        baseRole: 'viewer',
        allowedActions: [],
        accessCeiling: { nonProduction: 'read' },
      }).success,
    ).toBe(false);
  });

  it('bounds the action list by the vocabulary, so a body cannot grow it', () => {
    expect(
      customRoleCreateSchema.safeParse({
        name: 'x',
        baseRole: 'admin',
        allowedActions: Array.from({ length: ALL_ACTIONS.length * 2 + 1 }, () => 'secret.read'),
      }).success,
    ).toBe(false);
  });

  it('wants something to change in a patch', () => {
    expect(customRolePatchSchema.safeParse({}).success).toBe(false);
    expect(customRolePatchSchema.safeParse({ accessCeiling: null }).success).toBe(true);
  });
});

describe('payloads', () => {
  it('names a member’s custom role on the roster, and nothing of its definition', () => {
    const held = role({
      allowedActions: ['secret.read'],
      accessCeiling: { nonProduction: 'read', production: 'none' },
    });
    const payload = toMember(
      {
        id: uuidv7(),
        orgId: uuidv7(),
        userId: uuidv7(),
        role: 'admin',
        status: 'active',
        customRole: held,
        seatAssigned: true,
        createdAt: new Date(0),
        user: { id: uuidv7(), email: 'a@example.com', displayName: null, avatarUrl: null },
      },
      null,
    );

    expect(payload.role).toBe('admin');
    expect(payload.customRole).toEqual({ id: held.id, name: 'Deployer', baseRole: 'developer' });
  });

  it('lists a role’s actions in table order however they were stored', () => {
    const payload = toCustomRolePayload({
      id: uuidv7(),
      orgId: uuidv7(),
      name: 'Deployer',
      baseRole: 'developer',
      allowedActions: ['secret.update', 'member.read', 'secret.read'],
      accessCeiling: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });

    expect(payload.allowedActions).toEqual(['secret.read', 'secret.update', 'member.read']);
  });

  it('keeps the stored role as the label beside the authority it leaves', () => {
    const payload = toAuthorityPayload('admin', role({ baseRole: 'viewer', name: 'Auditor' }));

    expect(payload.role).toBe('admin');
    expect(payload.effectiveRole).toBe('viewer');
    expect(payload.customRole).toMatchObject({ name: 'Auditor', baseRole: 'viewer' });
    expect(payload.capabilities).toEqual(['member.read']);
  });
});

describe('comparing definitions', () => {
  const base = {
    name: 'Deployer',
    baseRole: 'developer' as const,
    allowedActions: ['secret.read'] as Action[],
    accessCeiling: { nonProduction: 'write' as const, production: 'none' as const },
  };

  it('counts the member.read floor as listed whether or not it is', () => {
    const withFloor = { ...base, allowedActions: ['member.read', 'secret.read'] as Action[] };
    expect(sameAccess(base, withFloor)).toBe(true);
    expect(sameDefinition(base, withFloor)).toBe(true);
  });

  it('ignores order and repetition in the action list', () => {
    expect(
      sameAccess(
        { ...base, allowedActions: ['secret.update', 'secret.read'] },
        { ...base, allowedActions: ['secret.read', 'secret.update', 'secret.read'] },
      ),
    ).toBe(true);
  });

  it('tells a rename, which is no access change, from a change of base, list or ceiling', () => {
    expect(sameAccess(base, { ...base, name: 'Release' })).toBe(true);
    expect(sameDefinition(base, { ...base, name: 'Release' })).toBe(false);
    expect(sameAccess(base, { ...base, baseRole: 'viewer' })).toBe(false);
    expect(sameAccess(base, { ...base, allowedActions: ['secret.update'] })).toBe(false);
    expect(sameAccess(base, { ...base, accessCeiling: null })).toBe(false);
    expect(
      sameAccess(base, { ...base, accessCeiling: { nonProduction: 'write', production: 'read' } }),
    ).toBe(false);
  });
});

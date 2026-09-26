import { describe, expect, it } from 'vitest';
import { AuthorizationError, resolveAccessLevel, ROLE_CAPABILITIES } from '@xecret/core/authz';
import type { AccessLevel, Action, CustomRole, OrgRole } from '@xecret/core/authz';
import { uuidv7 } from '@xecret/core/ids';
import { RepositoryError } from '@xecret/db/repositories';
import type {
  AuthorizationContext as StoredAuthorizationContext,
  MemberGrant,
  OrganizationEnvironment,
} from '@xecret/db/repositories';
import { ApiError } from './errors';
import {
  assertGrantWithinAuthority,
  assertHeldGrantsWithinAuthority,
  assertInvitationGrantsWithinAuthority,
  assertMayChangeOwnGrants,
  assertRemovalWithinAuthority,
  assertRoleAuthority,
  effectiveAccess,
  mapMembershipError,
} from './members-service';
import {
  grantWriteSchema,
  memberInviteSchema,
  memberPatchSchema,
  toInvitation,
} from './schemas/members';

/**
 * The member-management layer, tested where it is pure: the wrappers over the
 * authority checks, the repository-to-API error mapping, the effective-access
 * computation, and the request schemas.
 *
 * The authority rules themselves — which roles, levels and removals are within
 * whose authority — are pinned in `@xecret/core/authz` (`authority.test.ts`,
 * `custom-roles.test.ts`). What is tested here is what the wrappers add: that
 * they read the caller's *stored* context whole, custom role and grants
 * included; that a refusal is a `forbidden` `AuthorizationError` with a fixed
 * message, so the routes can file it as a denial; and the invitation rule,
 * which only exists here. That each route asks them is
 * `member-authority-routes.test.ts`.
 */

const ALL_ACTIONS = Object.keys(ROLE_CAPABILITIES.owner) as Action[];

const PROJECT = uuidv7();
const STAGING = uuidv7();
const PRODUCTION = uuidv7();

const production = { id: PRODUCTION, isProduction: true };

function customRole(over: Partial<CustomRole> = {}): CustomRole {
  return {
    id: uuidv7(),
    name: 'Narrowed',
    baseRole: 'admin',
    allowedActions: ['member.read', 'member.invite', 'member.update', 'member.remove'],
    ...over,
  };
}

const productionCapped = customRole({
  allowedActions: ALL_ACTIONS,
  accessCeiling: { nonProduction: 'admin', production: 'none' },
});

/** The caller's stored context, as `requireMembership` returns it. */
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

function row(environmentId: string | null, accessLevel: AccessLevel): MemberGrant {
  return { id: uuidv7(), projectId: PROJECT, environmentId, accessLevel };
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

/** The refusal `check` raised, asserted to be the kind the routes file as a denial. */
function refusal(check: () => void): AuthorizationError {
  try {
    check();
  } catch (cause) {
    expect(cause).toBeInstanceOf(AuthorizationError);
    return cause as AuthorizationError;
  }
  return expect.unreachable('the check must refuse');
}

describe('refusals are forbidden, never not_found, and carry a fixed message', () => {
  // Membership is already established by the time any of these run, so
  // `forbidden` leaks nothing; the messages are constants, never the request.
  it.each([
    [
      'a role above the caller',
      () => assertRoleAuthority(caller(), 'owner'),
      'You cannot manage a role above your own.',
    ],
    [
      'a grant above the caller',
      () =>
        assertGrantWithinAuthority(caller({ customRole: productionCapped }), 'read', {
          projectId: PROJECT,
          environment: production,
        }),
      'You cannot grant more access than you hold.',
    ],
    [
      'a removal that raises past the caller',
      () =>
        assertRemovalWithinAuthority(
          caller({ customRole: productionCapped }),
          { role: 'developer', status: 'active', customRole: undefined },
          [row(null, 'write'), row(PRODUCTION, 'none')],
          { projectId: PROJECT, environment: production },
        ),
      'You cannot grant more access than you hold.',
    ],
    [
      'held grants beyond the caller',
      () =>
        assertHeldGrantsWithinAuthority(
          caller({ customRole: productionCapped }),
          [row(PRODUCTION, 'write')],
          grid,
        ),
      'This member holds access grants beyond your own.',
    ],
    [
      'the caller’s own grants',
      () => assertMayChangeOwnGrants(caller()),
      'You cannot change your own access grants.',
    ],
  ])('refuses %s', (_label, check, message) => {
    expect(refusal(check).decision).toEqual({ allowed: false, reason: 'forbidden', message });
  });
});

describe('the wrappers measure the caller’s whole stored context', () => {
  // A wrapper that read `role` alone would pass every core test and still let
  // a narrowed caller act as the role they rank as.
  it('reads the custom role when measuring roles', () => {
    expect(() => assertRoleAuthority(caller(), 'admin')).not.toThrow();
    expect(() => assertRoleAuthority(caller({ customRole: customRole() }), 'viewer')).toThrow(
      AuthorizationError,
    );
  });

  it('reads the custom role and the caller’s own grants when measuring levels', () => {
    const reach = { projectId: PROJECT, environment: production };
    const restricted = caller({
      grants: [{ projectId: PROJECT, environmentId: PRODUCTION, accessLevel: 'read' }],
    });

    expect(() => assertGrantWithinAuthority(caller(), 'admin', reach)).not.toThrow();
    expect(() => assertGrantWithinAuthority(restricted, 'write', reach)).toThrow(
      AuthorizationError,
    );
    expect(() => assertGrantWithinAuthority(restricted, 'read', reach)).not.toThrow();
    expect(() =>
      assertHeldGrantsWithinAuthority(restricted, [row(PRODUCTION, 'write')], grid),
    ).toThrow(AuthorizationError);
  });

  it('measures a suspended target as the active member a removal will apply to', () => {
    // The target record crosses `toMembership` with its status; the rule, not
    // the mapping, sets it aside.
    expect(() =>
      assertRemovalWithinAuthority(
        caller({ customRole: productionCapped }),
        { role: 'developer', status: 'suspended', customRole: undefined },
        [row(null, 'write'), row(PRODUCTION, 'none')],
        { projectId: PROJECT, environment: production },
      ),
    ).toThrow(AuthorizationError);
  });

  it('lets only an owner change their own grants', () => {
    expect(() => assertMayChangeOwnGrants(caller({ role: 'owner' }))).not.toThrow();
    for (const role of ['admin', 'developer', 'viewer'] as const) {
      expect(() => assertMayChangeOwnGrants(caller({ role })), role).toThrow(AuthorizationError);
    }
  });
});

describe('invitation seeds', () => {
  it('measures a seed without a level at the role’s non-production default', () => {
    // Acceptance writes a developer's `write` even onto production, so that is
    // what the inviter must hold there.
    const restricted = caller({
      grants: [{ projectId: PROJECT, environmentId: PRODUCTION, accessLevel: 'read' }],
    });
    const seeds = [{ projectId: PROJECT, environmentId: PRODUCTION }];

    expect(() =>
      assertInvitationGrantsWithinAuthority(restricted, 'developer', seeds, grid),
    ).toThrow(AuthorizationError);
    // A viewer's non-production default is `read`, which the caller holds.
    expect(() =>
      assertInvitationGrantsWithinAuthority(restricted, 'viewer', seeds, grid),
    ).not.toThrow();
  });

  it('refuses the whole invitation when any one seed exceeds the inviter', () => {
    expect(() =>
      assertInvitationGrantsWithinAuthority(
        caller({ customRole: productionCapped }),
        'developer',
        [
          { projectId: PROJECT, environmentId: STAGING, accessLevel: 'write' },
          { projectId: PROJECT, environmentId: PRODUCTION, accessLevel: 'read' },
        ],
        grid,
      ),
    ).toThrow(AuthorizationError);
  });

  it('reads each seed’s reach off the grid, a project-wide one landing on production too', () => {
    expect(() =>
      assertInvitationGrantsWithinAuthority(
        caller({ customRole: productionCapped }),
        'developer',
        [{ projectId: PROJECT, environmentId: null, accessLevel: 'read' }],
        [gridRow(STAGING, false)],
      ),
    ).toThrow(AuthorizationError);
    expect(() =>
      assertInvitationGrantsWithinAuthority(
        caller({ customRole: productionCapped }),
        'developer',
        [{ projectId: PROJECT, environmentId: STAGING, accessLevel: 'write' }],
        grid,
      ),
    ).not.toThrow();
  });
});

describe('repository errors crossing the API boundary', () => {
  const cases = [
    ['notFound', 'not_found', 404],
    ['conflict', 'conflict', 409],
    ['lastOwner', 'conflict', 409],
    ['seatLimit', 'conflict', 409],
    ['invalid', 'bad_request', 400],
  ] as const;

  it.each(cases)('maps %s to %s (%d)', (repoCode, apiCode, status) => {
    try {
      mapMembershipError(new RepositoryError(repoCode, 'fixed message'));
      expect.unreachable('must throw');
    } catch (cause) {
      expect(cause).toBeInstanceOf(ApiError);
      expect((cause as ApiError).code).toBe(apiCode);
      expect((cause as ApiError).status).toBe(status);
    }
  });

  it('rethrows anything that is not a repository error, untranslated', () => {
    const strange = new Error('driver detail that must not become a response');
    expect(() => mapMembershipError(strange)).toThrow(strange);
  });
});

describe('the effective-access preview', () => {
  const PROJECT = uuidv7();
  const STAGING = uuidv7();
  const PRODUCTION = uuidv7();

  const project = { id: PROJECT, name: 'API', slug: 'api' };

  function env(id: string, slug: string, isProduction: boolean): OrganizationEnvironment {
    return {
      id,
      projectId: PROJECT,
      name: slug,
      slug,
      isProduction,
      // The effective-access preview is about grants and roles, not about how
      // values are encrypted — so these fixtures stay `server`, which keeps them
      // asserting the same thing they always did.
      encryptionMode: 'server',
      sortOrder: 0,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      deletedAt: null,
      project,
    };
  }

  const grid = [env(STAGING, 'staging', false), env(PRODUCTION, 'production', true)];

  function grant(
    environmentId: string | null,
    accessLevel: MemberGrant['accessLevel'],
  ): MemberGrant {
    return { id: uuidv7(), projectId: PROJECT, environmentId, accessLevel };
  }

  it('agrees with resolveAccessLevel on every cell — the preview must not lie', () => {
    const grants = [grant(PRODUCTION, 'read'), grant(null, 'admin')];
    const member = { role: 'developer', status: 'active', customRole: undefined } as const;

    const [api] = effectiveAccess(member, grants, grid);

    for (const cell of api?.environments ?? []) {
      const engine = resolveAccessLevel(
        {
          role: member.role,
          memberStatus: member.status,
          grants,
          isProduction: cell.isProduction,
        },
        PROJECT,
        cell.slug === 'staging' ? STAGING : PRODUCTION,
      );
      expect(cell.level, cell.slug).toBe(engine);
    }
  });

  it('attributes each level to the rule that produced it', () => {
    const grants = [grant(PRODUCTION, 'read'), grant(null, 'admin')];
    const [api] = effectiveAccess(
      { role: 'developer', status: 'active', customRole: undefined },
      grants,
      grid,
    );

    const staging = api?.environments.find((cell) => cell.slug === 'staging');
    const production = api?.environments.find((cell) => cell.slug === 'production');

    expect(staging).toMatchObject({ level: 'admin', source: 'project-grant' });
    expect(production).toMatchObject({ level: 'read', source: 'environment-grant' });
  });

  it('shows an explicit none as the denial it is, not as the role default', () => {
    const grants = [grant(STAGING, 'none')];
    const [api] = effectiveAccess(
      { role: 'admin', status: 'active', customRole: undefined },
      grants,
      grid,
    );

    const staging = api?.environments.find((cell) => cell.slug === 'staging');
    expect(staging).toMatchObject({ level: 'none', source: 'environment-grant' });
  });

  it('flattens everything to none for a suspended member, whatever their grants', () => {
    const grants = [grant(null, 'admin')];
    const [api] = effectiveAccess(
      { role: 'owner', status: 'suspended', customRole: undefined },
      grants,
      grid,
    );

    for (const cell of api?.environments ?? []) {
      expect(cell.level, cell.slug).toBe('none');
      expect(cell.source, cell.slug).toBe('suspended');
    }
  });

  // The preview must apply the same narrowing enforcement does, or it shows a
  // level the member will be refused on their first request.
  it('agrees with resolveAccessLevel for a member holding a custom role', () => {
    const grants = [grant(PRODUCTION, 'write'), grant(null, 'admin')];
    const member = {
      role: 'admin',
      status: 'active',
      customRole: customRole({
        baseRole: 'developer',
        accessCeiling: { nonProduction: 'write', production: 'read' },
      }),
    } as const;

    const [api] = effectiveAccess(member, grants, grid);

    for (const cell of api?.environments ?? []) {
      const engine = resolveAccessLevel(
        {
          role: member.role,
          memberStatus: member.status,
          customRole: member.customRole,
          grants,
          isProduction: cell.isProduction,
        },
        PROJECT,
        cell.slug === 'staging' ? STAGING : PRODUCTION,
      );
      expect(cell.level, cell.slug).toBe(engine);
    }
  });

  it('caps every level at a custom role’s ceiling, grants included', () => {
    const grants = [grant(PRODUCTION, 'write'), grant(null, 'admin')];
    const [api] = effectiveAccess(
      {
        role: 'developer',
        status: 'active',
        customRole: customRole({
          baseRole: 'developer',
          accessCeiling: { nonProduction: 'read', production: 'read' },
        }),
      },
      grants,
      grid,
    );

    // Attributed to the grant that matched, at the level the ceiling allows.
    expect(api?.environments.find((cell) => cell.slug === 'staging')).toMatchObject({
      level: 'read',
      source: 'project-grant',
    });
    expect(api?.environments.find((cell) => cell.slug === 'production')).toMatchObject({
      level: 'read',
      source: 'environment-grant',
    });
    expect(api?.projectLevel).toBe('read');
  });

  it('takes role defaults from the lower of the member’s role and the custom role’s base', () => {
    const [api] = effectiveAccess(
      { role: 'admin', status: 'active', customRole: customRole({ baseRole: 'developer' }) },
      [],
      grid,
    );

    expect(api?.environments.find((cell) => cell.slug === 'staging')).toMatchObject({
      level: 'write',
      source: 'role-default',
    });
    expect(api?.environments.find((cell) => cell.slug === 'production')).toMatchObject({
      level: 'none',
      source: 'role-default',
    });
  });

  it('shows production deny-by-default for a developer with no grants', () => {
    const [api] = effectiveAccess(
      { role: 'developer', status: 'active', customRole: undefined },
      [],
      grid,
    );

    expect(api?.environments.find((cell) => cell.slug === 'staging')).toMatchObject({
      level: 'write',
      source: 'role-default',
    });
    expect(api?.environments.find((cell) => cell.slug === 'production')).toMatchObject({
      level: 'none',
      source: 'role-default',
    });
  });
});

describe('member request schemas', () => {
  it('accepts an invitation and normalises nothing silently', () => {
    const parsed = memberInviteSchema.parse({ email: 'a@example.com', role: 'developer' });
    expect(parsed).toEqual({ email: 'a@example.com', role: 'developer' });
  });

  it('rejects a malformed address and an unknown role', () => {
    expect(memberInviteSchema.safeParse({ email: 'nope', role: 'developer' }).success).toBe(false);
    expect(memberInviteSchema.safeParse({ email: 'a@example.com', role: 'root' }).success).toBe(
      false,
    );
  });

  it('requires exactly one change per member patch', () => {
    expect(memberPatchSchema.safeParse({ role: 'admin' }).success).toBe(true);
    expect(memberPatchSchema.safeParse({ status: 'suspended' }).success).toBe(true);
    expect(memberPatchSchema.safeParse({}).success).toBe(false);
    expect(memberPatchSchema.safeParse({ role: 'admin', status: 'suspended' }).success).toBe(false);
  });

  it('lets a grant name the whole project by omitting or nulling the environment', () => {
    expect(
      grantWriteSchema.safeParse({ projectSlug: 'backend', accessLevel: 'read' }).success,
    ).toBe(true);
    expect(
      grantWriteSchema.safeParse({
        projectSlug: 'backend',
        environmentSlug: null,
        accessLevel: 'none',
      }).success,
    ).toBe(true);
  });

  it('lets an invitation grant name its level, and lets it stay unstated', () => {
    // Stated: what the invite dialog sends, so acceptance writes that level.
    const withLevel = memberInviteSchema.safeParse({
      email: 'a@example.com',
      role: 'developer',
      grants: [{ projectSlug: 'backend', environmentSlug: 'staging', accessLevel: 'write' }],
    });
    expect(withLevel.success).toBe(true);

    // Unstated: the documented shape, and every invitation issued before
    // levels were selectable. Acceptance falls back to the role default, so
    // this must stay accepted rather than becoming a required field.
    expect(
      memberInviteSchema.safeParse({
        email: 'a@example.com',
        role: 'developer',
        grants: [{ projectSlug: 'backend', environmentSlug: null }],
      }).success,
    ).toBe(true);

    // Still strict about what a level may be.
    expect(
      memberInviteSchema.safeParse({
        email: 'a@example.com',
        role: 'developer',
        grants: [{ projectSlug: 'backend', environmentSlug: null, accessLevel: 'owner' }],
      }).success,
    ).toBe(false);
  });

  it('derives the invitation state at serialisation time', () => {
    const now = new Date('2026-08-14T12:00:00Z');
    const base = {
      id: uuidv7(),
      orgId: uuidv7(),
      email: 'a@example.com',
      role: 'viewer' as const,
      invitedBy: uuidv7(),
      initialGrants: null,
      acceptedAt: null,
      acceptedBy: null,
      revokedAt: null,
      createdAt: now,
    };

    expect(
      toInvitation({ ...base, expiresAt: new Date(now.getTime() + 1000) }, null, now).state,
    ).toBe('pending');
    expect(toInvitation({ ...base, expiresAt: now }, null, now).state).toBe('expired');
  });
});

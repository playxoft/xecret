import { describe, expect, it } from 'vitest';
import { resolveAccessLevel, ROLE_CAPABILITIES } from '@xecret/core/authz';
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
  assertInvitationGrantsWithinAuthority,
  assertRoleAuthority,
  effectiveAccess,
  grantableAccessLevel,
  invitationSeedReach,
  mapMembershipError,
} from './members-service';
import {
  grantWriteSchema,
  memberInviteSchema,
  memberPatchSchema,
  toInvitation,
} from './schemas/members';

/**
 * The member-management layer, tested where it is pure: the role hierarchy,
 * the repository-to-API error mapping, the effective-access computation, and
 * the request schemas. Route wiring is covered by `route.test.ts`'s wrapper
 * guarantees; the transactional invariants (last owner, seats, atomic accept)
 * are repository behaviour that needs a real database — see the standing
 * caveat in the plan.
 */

const ROLES: readonly OrgRole[] = ['owner', 'admin', 'developer', 'viewer'];
const RANK: Record<OrgRole, number> = { owner: 3, admin: 2, developer: 1, viewer: 0 };
const ALL_ACTIONS = Object.keys(ROLE_CAPABILITIES.owner) as Action[];

function customRole(over: Partial<CustomRole> = {}): CustomRole {
  return {
    id: uuidv7(),
    name: 'Narrowed',
    baseRole: 'admin',
    allowedActions: ['member.read', 'member.invite', 'member.update', 'member.remove'],
    ...over,
  };
}

describe('the role hierarchy at the API boundary', () => {
  it('refuses any role above the caller’s own, on either side of a change', () => {
    for (const actor of ROLES) {
      for (const subject of ROLES) {
        const permitted = RANK[actor] >= RANK[subject];

        if (permitted) {
          expect(() => assertRoleAuthority({ role: actor }, subject)).not.toThrow();
        } else {
          expect(
            () => assertRoleAuthority({ role: actor }, subject),
            `${actor} vs ${subject}`,
          ).toThrow(ApiError);
        }
      }
    }
  });

  // An owner narrowed to an admin-based custom role passes `can()` for member
  // management exactly as an admin does. Measured by the stored `owner`, they
  // could still mint owners — the authority their own role withholds.
  it('measures a caller holding a custom role by the lower of their two roles', () => {
    const narrowedOwner = {
      role: 'owner' as const,
      customRole: customRole({ baseRole: 'admin', allowedActions: ALL_ACTIONS }),
    };

    expect(() => assertRoleAuthority(narrowedOwner, 'owner')).toThrow(ApiError);
    expect(() => assertRoleAuthority(narrowedOwner, 'admin')).not.toThrow();

    const narrowedAdmin = {
      role: 'admin' as const,
      customRole: customRole({ baseRole: 'viewer', allowedActions: ALL_ACTIONS }),
    };
    expect(() => assertRoleAuthority(narrowedAdmin, 'developer')).toThrow(ApiError);
    expect(() => assertRoleAuthority(narrowedAdmin, 'viewer')).not.toThrow();
  });

  // You can't hand out what you don't hold. The default `customRole()` here is
  // admin-based and lists member management alone: an admin by rank, and by
  // rank alone it could appoint one — who would hold on day one everything this
  // role was defined to withhold.
  it('refuses a role carrying capabilities the caller’s custom role withholds', () => {
    const memberManager = { role: 'admin' as const, customRole: customRole() };

    for (const subject of ROLES) {
      expect(() => assertRoleAuthority(memberManager, subject), subject).toThrow(ApiError);
    }
  });

  it('refuses a role whose defaults exceed the caller’s ceiling', () => {
    const noProduction = {
      role: 'admin' as const,
      customRole: customRole({
        allowedActions: ALL_ACTIONS,
        accessCeiling: { nonProduction: 'admin', production: 'none' },
      }),
    };

    // An admin defaults to `admin` on production; a developer to `none`.
    expect(() => assertRoleAuthority(noProduction, 'admin')).toThrow(ApiError);
    expect(() => assertRoleAuthority(noProduction, 'developer')).not.toThrow();
  });

  it('does not let a custom role based above the caller’s role raise it', () => {
    const inflated = { role: 'developer' as const, customRole: customRole({ baseRole: 'owner' }) };

    expect(() => assertRoleAuthority(inflated, 'admin')).toThrow(ApiError);
    expect(() => assertRoleAuthority(inflated, 'owner')).toThrow(ApiError);
  });

  it('reports the refusal as forbidden, never as not_found — membership is already established', () => {
    try {
      assertRoleAuthority({ role: 'admin' }, 'owner');
      expect.unreachable('admin touching an owner must be refused');
    } catch (cause) {
      expect(cause).toBeInstanceOf(ApiError);
      expect((cause as ApiError).code).toBe('forbidden');
    }
  });
});

describe('the grant level at the API boundary', () => {
  const PROJECT = uuidv7();
  const STAGING = uuidv7();
  const PRODUCTION = uuidv7();
  const OTHER_PROJECT = uuidv7();

  const staging = { id: STAGING, isProduction: false };
  const production = { id: PRODUCTION, isProduction: true };

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
      ...(over.customRole === undefined ? {} : { customRole: over.customRole }),
      grants: (over.grants ?? []).map((grant) => ({ id: uuidv7(), ...grant })),
    };
  }

  function membershipOf(stored: StoredAuthorizationContext) {
    return {
      role: stored.role,
      memberStatus: stored.status,
      ...(stored.customRole === undefined ? {} : { customRole: stored.customRole }),
      grants: stored.grants,
    };
  }

  const noProduction = customRole({
    allowedActions: ALL_ACTIONS,
    accessCeiling: { nonProduction: 'admin', production: 'none' },
  });

  it('is the caller’s own resolved level on one environment', () => {
    const capped = membershipOf(caller({ customRole: noProduction }));

    expect(grantableAccessLevel(capped, { projectId: PROJECT, environment: production })).toBe(
      'none',
    );
    expect(grantableAccessLevel(capped, { projectId: PROJECT, environment: staging })).toBe(
      'admin',
    );
  });

  it('takes the lowest level anywhere a project-wide grant would land', () => {
    // An explicit `read` on production is enough to hold a project-wide grant
    // to `read`: the row falls back onto production.
    const restricted = membershipOf(
      caller({ grants: [{ projectId: PROJECT, environmentId: PRODUCTION, accessLevel: 'read' }] }),
    );

    expect(
      grantableAccessLevel(restricted, {
        projectId: PROJECT,
        environment: null,
        projectEnvironments: [staging, production],
      }),
    ).toBe('read');
  });

  it('holds a project-wide grant to the production level even with no production yet', () => {
    // A production environment added tomorrow falls back onto today's project
    // row — so a caller capped at `none` there holds nothing project-wide.
    const capped = membershipOf(caller({ customRole: noProduction }));

    expect(
      grantableAccessLevel(capped, {
        projectId: PROJECT,
        environment: null,
        projectEnvironments: [staging],
      }),
    ).toBe('none');
  });

  it('is admin everywhere for an owner or admin with nothing written against them', () => {
    for (const role of ['owner', 'admin'] as const) {
      const plain = membershipOf(caller({ role }));
      expect(
        grantableAccessLevel(plain, {
          projectId: PROJECT,
          environment: null,
          projectEnvironments: [staging, production],
        }),
        role,
      ).toBe('admin');
      expect(grantableAccessLevel(plain, { projectId: PROJECT, environment: production })).toBe(
        'admin',
      );
    }
  });

  it('ignores the caller’s grants on another project', () => {
    const elsewhere = membershipOf(
      caller({ grants: [{ projectId: OTHER_PROJECT, environmentId: null, accessLevel: 'none' }] }),
    );

    expect(grantableAccessLevel(elsewhere, { projectId: PROJECT, environment: production })).toBe(
      'admin',
    );
  });

  it('refuses a level above that, as forbidden, and permits one at or below it', () => {
    const capped = caller({ customRole: noProduction });
    const reach = { projectId: PROJECT, environment: production };

    try {
      assertGrantWithinAuthority(capped, 'read', reach);
      expect.unreachable('a read grant on production must be refused');
    } catch (cause) {
      expect(cause).toBeInstanceOf(ApiError);
      expect((cause as ApiError).code).toBe('forbidden');
    }
    expect(() => assertGrantWithinAuthority(capped, 'none', reach)).not.toThrow();
    expect(() =>
      assertGrantWithinAuthority(capped, 'admin', { projectId: PROJECT, environment: staging }),
    ).not.toThrow();
  });

  it('never refuses an owner or admin with nothing written against them', () => {
    const levels: readonly AccessLevel[] = ['none', 'read', 'write', 'admin'];
    for (const role of ['owner', 'admin'] as const) {
      for (const level of levels) {
        expect(() =>
          assertGrantWithinAuthority(caller({ role }), level, {
            projectId: PROJECT,
            environment: null,
            projectEnvironments: [staging, production],
          }),
        ).not.toThrow();
      }
    }
  });

  describe('invitation seeds', () => {
    function gridRow(id: string, projectId: string, isProduction: boolean) {
      return {
        id,
        projectId,
        name: id,
        slug: id,
        isProduction,
        encryptionMode: 'server' as const,
        sortOrder: 0,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        deletedAt: null,
        project: { id: projectId, name: 'API', slug: 'api' },
      };
    }

    const grid: OrganizationEnvironment[] = [
      gridRow(STAGING, PROJECT, false),
      gridRow(PRODUCTION, PROJECT, true),
      gridRow(uuidv7(), OTHER_PROJECT, true),
    ];

    it('reaches one environment with its own production flag', () => {
      expect(invitationSeedReach({ projectId: PROJECT, environmentId: PRODUCTION }, grid)).toEqual({
        projectId: PROJECT,
        environment: { id: PRODUCTION, isProduction: true },
      });
    });

    it('reaches every environment of its own project, and only those, when project-wide', () => {
      const reach = invitationSeedReach({ projectId: PROJECT, environmentId: null }, grid);

      expect(reach.environment).toBeNull();
      expect(
        reach.environment === null ? reach.projectEnvironments.map((env) => env.id) : [],
      ).toEqual([STAGING, PRODUCTION]);
    });

    it('measures an environment that has vanished as production', () => {
      const ghost = uuidv7();

      expect(invitationSeedReach({ projectId: PROJECT, environmentId: ghost }, grid)).toEqual({
        projectId: PROJECT,
        environment: { id: ghost, isProduction: true },
      });
    });

    it('measures a seed without a level at the role’s non-production default', () => {
      // Acceptance writes a developer's `write` even onto production, so that
      // is what the inviter must hold there.
      const restricted = caller({
        grants: [{ projectId: PROJECT, environmentId: PRODUCTION, accessLevel: 'read' }],
      });
      const seeds = [{ projectId: PROJECT, environmentId: PRODUCTION }];

      expect(() =>
        assertInvitationGrantsWithinAuthority(restricted, 'developer', seeds, grid),
      ).toThrow(ApiError);
      // A viewer's non-production default is `read`, which the caller holds.
      expect(() =>
        assertInvitationGrantsWithinAuthority(restricted, 'viewer', seeds, grid),
      ).not.toThrow();
    });

    it('refuses the whole invitation when any one seed exceeds the inviter', () => {
      const capped = caller({ customRole: noProduction });

      expect(() =>
        assertInvitationGrantsWithinAuthority(
          capped,
          'developer',
          [
            { projectId: PROJECT, environmentId: STAGING, accessLevel: 'write' },
            { projectId: PROJECT, environmentId: PRODUCTION, accessLevel: 'read' },
          ],
          grid,
        ),
      ).toThrow(ApiError);
    });
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
    const member = { role: 'developer', status: 'active' } as const;

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
    const [api] = effectiveAccess({ role: 'developer', status: 'active' }, grants, grid);

    const staging = api?.environments.find((cell) => cell.slug === 'staging');
    const production = api?.environments.find((cell) => cell.slug === 'production');

    expect(staging).toMatchObject({ level: 'admin', source: 'project-grant' });
    expect(production).toMatchObject({ level: 'read', source: 'environment-grant' });
  });

  it('shows an explicit none as the denial it is, not as the role default', () => {
    const grants = [grant(STAGING, 'none')];
    const [api] = effectiveAccess({ role: 'admin', status: 'active' }, grants, grid);

    const staging = api?.environments.find((cell) => cell.slug === 'staging');
    expect(staging).toMatchObject({ level: 'none', source: 'environment-grant' });
  });

  it('flattens everything to none for a suspended member, whatever their grants', () => {
    const grants = [grant(null, 'admin')];
    const [api] = effectiveAccess({ role: 'owner', status: 'suspended' }, grants, grid);

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
    const [api] = effectiveAccess({ role: 'developer', status: 'active' }, [], grid);

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

import { describe, expect, it } from 'vitest';
import { resolveAccessLevel } from '@xecret/core/authz';
import type { OrgRole } from '@xecret/core/authz';
import { uuidv7 } from '@xecret/core/ids';
import { RepositoryError } from '@xecret/db/repositories';
import type { MemberGrant, OrganizationEnvironment } from '@xecret/db/repositories';
import { ApiError } from './errors';
import { assertRoleAuthority, effectiveAccess, mapMembershipError } from './members-service';
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

describe('the role hierarchy at the API boundary', () => {
  it('refuses any role above the caller’s own, on either side of a change', () => {
    for (const actor of ROLES) {
      for (const subject of ROLES) {
        const permitted = RANK[actor] >= RANK[subject];

        if (permitted) {
          expect(() => assertRoleAuthority(actor, subject)).not.toThrow();
        } else {
          expect(() => assertRoleAuthority(actor, subject), `${actor} vs ${subject}`).toThrow(
            ApiError,
          );
        }
      }
    }
  });

  it('reports the refusal as forbidden, never as not_found — membership is already established', () => {
    try {
      assertRoleAuthority('admin', 'owner');
      expect.unreachable('admin touching an owner must be refused');
    } catch (cause) {
      expect(cause).toBeInstanceOf(ApiError);
      expect((cause as ApiError).code).toBe('forbidden');
    }
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

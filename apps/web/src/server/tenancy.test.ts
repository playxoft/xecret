import { beforeEach, describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '@xecret/core/ids';
import { AuthorizationError } from '@xecret/core/authz';
import type { ApiError } from './errors';

/**
 * Tests for tenancy resolution — the layer where cross-tenant isolation is
 * actually enforced (threat T2, the most likely real breach).
 *
 * The repository module is stubbed. That is deliberate and it is not a
 * shortcut: the SQL these functions generate is verified separately, by
 * `.toSQL()` assertions in `packages/db/src/repositories/*.test.ts`. What is
 * verified *here* is the decision logic layered on top — which slug resolves to
 * which scope, which mismatch produces `not_found` rather than `forbidden`, and
 * which action is checked against which resource. Those are pure decisions, and
 * stubbing the queries is what lets every one of them be exercised.
 *
 * What these do NOT prove: that the queries filter correctly at the database.
 * That needs the repository tests plus integration coverage against real
 * PostgreSQL before production.
 */

const repositories = vi.hoisted(() => ({
  findOrganizationBySlug: vi.fn(),
  findProjectBySlug: vi.fn(),
  findEnvironmentBySlug: vi.fn(),
  loadAuthorizationContext: vi.fn(),
}));

vi.mock('@xecret/db/repositories', () => repositories);

const {
  authorize,
  resolveEnvironment,
  resolveEnvironmentPath,
  resolveOrg,
  resolveProject,
  toGrantContext,
} = await import('./tenancy');

type Services = Parameters<typeof resolveOrg>[2];

const ORG_ID = uuidv7();
const OTHER_ORG_ID = uuidv7();
const PROJECT_ID = uuidv7();
const OTHER_PROJECT_ID = uuidv7();
const ENV_ID = uuidv7();
const OTHER_ENV_ID = uuidv7();
const USER_ID = uuidv7();
const MEMBER_ID = uuidv7();

const services = { db: {} } as unknown as Services;

const organization = { id: ORG_ID, name: 'Playxoft', slug: 'playxoft' };
const project = { id: PROJECT_ID, orgId: ORG_ID, slug: 'default', name: 'Default' };
const environment = {
  id: ENV_ID,
  projectId: PROJECT_ID,
  slug: 'production',
  name: 'Production',
  isProduction: true,
};

const userPrincipal = {
  kind: 'user' as const,
  // Unlocked. The lock gate lives in `authenticatedRoute`, and these fixtures
  // exercise what happens *past* it.
  pinVerifiedAt: new Date(),
  sessionId: uuidv7(),
  user: {
    id: USER_ID,
    email: 'nitheesh@playxoft.com',
    emailVerified: true,
    displayName: null,
    avatarUrl: null,
  },
};

function servicePrincipal(overrides: Partial<Record<string, string>> = {}) {
  return {
    kind: 'serviceToken' as const,
    tokenId: uuidv7(),
    tokenName: 'ci-deploy',
    orgId: overrides['orgId'] ?? ORG_ID,
    projectId: overrides['projectId'] ?? PROJECT_ID,
    environmentId: overrides['environmentId'] ?? ENV_ID,
    accessLevel: 'read' as const,
  };
}

function membership(role: 'owner' | 'admin' | 'developer' | 'viewer' = 'owner') {
  return {
    orgId: ORG_ID,
    userId: USER_ID,
    memberId: MEMBER_ID,
    role,
    status: 'active' as const,
    grants: [],
  };
}

/**
 * Every refusal in this module must be a 404 carrying the identical body.
 *
 * The message is asserted as well as the code: a `not_found` whose message
 * differed per cause would leak the same information the status code is
 * carefully not leaking.
 */
async function expectNotFound(promise: Promise<unknown>): Promise<void> {
  const error: ApiError = await promise.then(
    () => {
      throw new Error('expected the call to be refused');
    },
    (cause: unknown) => cause as ApiError,
  );

  expect(error.code).toBe('not_found');
  expect(error.message).toBe('Not found.');
}

beforeEach(() => {
  vi.resetAllMocks();
  repositories.findOrganizationBySlug.mockResolvedValue(organization);
  repositories.findProjectBySlug.mockResolvedValue(project);
  repositories.findEnvironmentBySlug.mockResolvedValue(environment);
  repositories.loadAuthorizationContext.mockResolvedValue(membership());
});

describe('organisation resolution', () => {
  it('resolves an organisation the user belongs to', async () => {
    const scope = await resolveOrg(userPrincipal, 'playxoft', services);

    expect(scope.organization.id).toBe(ORG_ID);
    expect(scope.actor).toEqual({ kind: 'user', userId: USER_ID, orgId: ORG_ID });
  });

  it('reports an unknown slug as not found', async () => {
    repositories.findOrganizationBySlug.mockResolvedValue(null);
    await expectNotFound(resolveOrg(userPrincipal, 'nope', services));
  });

  // The two must be indistinguishable. If "exists but you are not a member"
  // read differently from "does not exist", the endpoint becomes a directory of
  // every organisation slug in the system.
  it('reports an organisation the user is not a member of identically', async () => {
    repositories.loadAuthorizationContext.mockResolvedValue(null);
    await expectNotFound(resolveOrg(userPrincipal, 'playxoft', services));
  });

  it('gives a CLI token exactly its user’s identity', async () => {
    const tokenId = uuidv7();
    const scope = await resolveOrg(
      { kind: 'cliToken', tokenId, tokenName: 'laptop', userId: USER_ID, orgId: ORG_ID },
      'playxoft',
      services,
    );

    expect(scope.actor).toEqual({ kind: 'cliToken', tokenId, userId: USER_ID, orgId: ORG_ID });
    // The membership consulted is the user's, not the token's — a CLI token
    // carries no authority of its own.
    expect(repositories.loadAuthorizationContext).toHaveBeenCalledWith(services.db, {
      orgId: ORG_ID,
      userId: USER_ID,
    });
  });
});

describe('service-token pinning', () => {
  it('resolves the organisation its token names', async () => {
    const scope = await resolveOrg(servicePrincipal(), 'playxoft', services);
    expect(scope.actor.kind).toBe('serviceToken');
    expect(scope.membership).toBeUndefined();
  });

  it('never consults membership, because a service token has none', async () => {
    await resolveOrg(servicePrincipal(), 'playxoft', services);
    expect(repositories.loadAuthorizationContext).not.toHaveBeenCalled();
  });

  it('refuses an organisation other than the one it is pinned to', async () => {
    await expectNotFound(
      resolveOrg(servicePrincipal({ orgId: OTHER_ORG_ID }), 'playxoft', services),
    );
  });

  it('refuses a project other than the one it is pinned to', async () => {
    const scope = await resolveOrg(
      servicePrincipal({ projectId: OTHER_PROJECT_ID }),
      'playxoft',
      services,
    );
    await expectNotFound(resolveProject(scope, 'default', services));
  });

  it('refuses an environment other than the one it is pinned to', async () => {
    const principal = servicePrincipal({ environmentId: OTHER_ENV_ID });
    const scope = await resolveProject(
      await resolveOrg(principal, 'playxoft', services),
      'default',
      services,
    );

    await expectNotFound(resolveEnvironment(scope, 'production', services));
  });
});

describe('project and environment resolution', () => {
  it('resolves a project within its organisation', async () => {
    const scope = await resolveProject(
      await resolveOrg(userPrincipal, 'playxoft', services),
      'default',
      services,
    );
    expect(scope.project.id).toBe(PROJECT_ID);
  });

  it('reports an unknown project as not found', async () => {
    repositories.findProjectBySlug.mockResolvedValue(undefined);
    const scope = await resolveOrg(userPrincipal, 'playxoft', services);
    await expectNotFound(resolveProject(scope, 'ghost', services));
  });

  it('reports an unknown environment as not found', async () => {
    repositories.findEnvironmentBySlug.mockResolvedValue(undefined);
    const scope = await resolveProject(
      await resolveOrg(userPrincipal, 'playxoft', services),
      'default',
      services,
    );
    await expectNotFound(resolveEnvironment(scope, 'ghost', services));
  });

  // The org id passed down must be the one resolved from the slug, never one
  // taken from the request — otherwise the filter is under the caller's control.
  it('scopes the environment lookup by the resolved organisation and project', async () => {
    await resolveEnvironmentPath(
      userPrincipal,
      { orgSlug: 'playxoft', projectSlug: 'default', envSlug: 'production' },
      services,
    );

    expect(repositories.findEnvironmentBySlug).toHaveBeenCalledWith(
      services.db,
      ORG_ID,
      PROJECT_ID,
      'production',
    );
  });
});

describe('authorization', () => {
  it('permits an owner to read a project', async () => {
    const scope = await resolveProject(
      await resolveOrg(userPrincipal, 'playxoft', services),
      'default',
      services,
    );
    expect(() => authorize(scope, 'project.read')).not.toThrow();
  });

  // Production is read from the row's `is_production` flag, not inferred from
  // the slug — so an environment named `prod-eu-west` is protected identically.
  it('denies a developer writing to a production environment by default', async () => {
    repositories.loadAuthorizationContext.mockResolvedValue(membership('developer'));

    const scope = await resolveEnvironmentPath(
      userPrincipal,
      { orgSlug: 'playxoft', projectSlug: 'default', envSlug: 'production' },
      services,
    );

    expect(() => authorize(scope, 'secret.update')).toThrowError(AuthorizationError);
  });

  it('permits that same developer on a non-production environment', async () => {
    repositories.loadAuthorizationContext.mockResolvedValue(membership('developer'));
    repositories.findEnvironmentBySlug.mockResolvedValue({
      ...environment,
      id: OTHER_ENV_ID,
      slug: 'development',
      isProduction: false,
    });

    const scope = await resolveEnvironmentPath(
      userPrincipal,
      { orgSlug: 'playxoft', projectSlug: 'default', envSlug: 'development' },
      services,
    );

    expect(() => authorize(scope, 'secret.update')).not.toThrow();
  });

  it('denies a viewer any write', async () => {
    repositories.loadAuthorizationContext.mockResolvedValue(membership('viewer'));
    repositories.findEnvironmentBySlug.mockResolvedValue({ ...environment, isProduction: false });

    const scope = await resolveEnvironmentPath(
      userPrincipal,
      { orgSlug: 'playxoft', projectSlug: 'default', envSlug: 'development' },
      services,
    );

    expect(() => authorize(scope, 'secret.create')).toThrowError(AuthorizationError);
  });

  // A leaked CI credential must not be able to mint a second credential or
  // manage people, no matter what access level it carries (threat T5).
  it('denies a service token every management action', async () => {
    const scope = await resolveEnvironmentPath(
      servicePrincipal(),
      { orgSlug: 'playxoft', projectSlug: 'default', envSlug: 'production' },
      services,
    );

    for (const action of [
      'member.invite',
      'token.create',
      'audit.read',
      'project.delete',
    ] as const) {
      expect(() => authorize(scope, action, { serviceTokenAccessLevel: 'admin' })).toThrowError(
        AuthorizationError,
      );
    }
  });

  it('permits a service token to read secrets in its own environment', async () => {
    const scope = await resolveEnvironmentPath(
      servicePrincipal(),
      { orgSlug: 'playxoft', projectSlug: 'default', envSlug: 'production' },
      services,
    );

    expect(() =>
      authorize(scope, 'secret.read', { serviceTokenAccessLevel: 'read' }),
    ).not.toThrow();
  });

  it('denies a read-only service token a write', async () => {
    const scope = await resolveEnvironmentPath(
      servicePrincipal(),
      { orgSlug: 'playxoft', projectSlug: 'default', envSlug: 'production' },
      services,
    );

    expect(() =>
      authorize(scope, 'secret.update', { serviceTokenAccessLevel: 'read' }),
    ).toThrowError(AuthorizationError);
  });

  it('asks about the org when no project is in scope', async () => {
    const scope = await resolveOrg(userPrincipal, 'playxoft', services);
    expect(() => authorize(scope, 'org.update')).not.toThrow();
  });
});

describe('grant context adaptation', () => {
  it('carries grants across the storage/policy boundary unchanged', () => {
    const grant = {
      id: uuidv7(),
      projectId: PROJECT_ID,
      environmentId: ENV_ID,
      accessLevel: 'write' as const,
    };

    expect(toGrantContext({ ...membership('developer'), grants: [grant] })).toEqual({
      role: 'developer',
      memberStatus: 'active',
      grants: [{ projectId: PROJECT_ID, environmentId: ENV_ID, accessLevel: 'write' }],
    });
  });

  // The grant's own row id is storage detail; a policy decision must not be
  // able to depend on it.
  it('drops the grant row id, which the policy layer has no business seeing', () => {
    const context = toGrantContext({
      ...membership(),
      grants: [
        { id: uuidv7(), projectId: PROJECT_ID, environmentId: null, accessLevel: 'read' as const },
      ],
    });

    expect(Object.keys(context.grants[0] ?? {})).toEqual([
      'projectId',
      'environmentId',
      'accessLevel',
    ]);
  });

  it('preserves a suspended status, which denies everything downstream', () => {
    expect(toGrantContext({ ...membership(), status: 'suspended' }).memberStatus).toBe('suspended');
  });
});

import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../ids/uuid-v7';
import {
  assertCan,
  AuthorizationError,
  can,
  FORBIDDEN_MESSAGE,
  NOT_FOUND_MESSAGE,
  SERVICE_TOKEN_ACTIONS,
} from './can';
import type { AuthorizationContext } from './can';
import { resolveAccessLevel } from './grants';
import type { MemberStatus, ResolvedGrant } from './grants';
import {
  accessLevelAtLeast,
  ACTION_REQUIREMENTS,
  canAssignRole,
  compareAccessLevel,
  compareOrgRole,
  ROLE_ACCESS_DEFAULTS,
  ROLE_CAPABILITIES,
  roleDefaultAccessLevel,
} from './roles';
import type { RequiredAccessLevel } from './roles';
import type { AccessLevel, Action, Actor, OrgRole, Resource } from './types';

/**
 * The security matrix.
 *
 * Every assertion here states a property of the system rather than a property of
 * the implementation: what an attacker cannot do, what an operator's stated
 * intention means, and what a credential is worth if it leaks. If a refactor
 * breaks one of these, the refactor changed the security posture.
 */

const ORG = uuidv7();
const OTHER_ORG = uuidv7();
const PROJECT = uuidv7();
const OTHER_PROJECT = uuidv7();
const STAGING = uuidv7();
const SANDBOX = uuidv7();
const PRODUCTION = uuidv7();
const OTHER_ENVIRONMENT = uuidv7();
const USER = uuidv7();

const ROLES: readonly OrgRole[] = ['owner', 'admin', 'developer', 'viewer'];
const ACCESS_LEVELS: readonly AccessLevel[] = ['none', 'read', 'write', 'admin'];
const ALL_ACTIONS = Object.keys(ACTION_REQUIREMENTS) as Action[];
const MUTATING_ACTIONS = ALL_ACTIONS.filter((action) => !action.endsWith('.read'));

const userActor: Actor = { kind: 'user', userId: USER, orgId: ORG };
const cliActor: Actor = { kind: 'cliToken', tokenId: uuidv7(), userId: USER, orgId: ORG };

function serviceActor(projectId = PROJECT, environmentId = STAGING, orgId = ORG): Actor {
  return { kind: 'serviceToken', tokenId: uuidv7(), orgId, projectId, environmentId };
}

const ACTOR_KINDS: ReadonlyArray<[string, Actor]> = [
  ['user', userActor],
  ['cliToken', cliActor],
  ['serviceToken', serviceActor()],
];

function orgResource(orgId = ORG): Resource {
  return { kind: 'org', orgId };
}

function projectResource(projectId = PROJECT, orgId = ORG): Resource {
  return { kind: 'project', orgId, projectId };
}

function environmentResource(environmentId = STAGING, projectId = PROJECT, orgId = ORG): Resource {
  return { kind: 'environment', orgId, projectId, environmentId };
}

interface MemberOptions {
  grants?: readonly ResolvedGrant[];
  status?: MemberStatus;
  isProduction?: boolean;
}

function member(role: OrgRole, options: MemberOptions = {}): AuthorizationContext {
  return {
    membership: { role, memberStatus: options.status ?? 'active', grants: options.grants ?? [] },
    isProduction: options.isProduction ?? false,
  };
}

function tokenContext(accessLevel: AccessLevel): AuthorizationContext {
  return { serviceToken: { accessLevel }, isProduction: false };
}

/** The resource an action is naturally addressed at, so the matrix can be role × action. */
function resourceFor(action: Action): Resource {
  const requirement = ACTION_REQUIREMENTS[action];
  if (requirement.scope === 'org') return orgResource();
  if (requirement.scope === 'project') return projectResource();
  return environmentResource();
}

function permits(context: AuthorizationContext, action: Action, actor: Actor = userActor): boolean {
  return can(actor, action, resourceFor(action), context).allowed;
}

describe('cross-tenant isolation (T2)', () => {
  it.each(ACTOR_KINDS)(
    'reports another organisation as not found, never as forbidden, for a %s actor',
    (_kind, actor) => {
      const foreign: readonly Resource[] = [
        orgResource(OTHER_ORG),
        projectResource(OTHER_PROJECT, OTHER_ORG),
        environmentResource(OTHER_ENVIRONMENT, OTHER_PROJECT, OTHER_ORG),
      ];

      for (const resource of foreign) {
        // The most permissive context available, to prove the tenancy check runs
        // ahead of everything that could otherwise say yes.
        expect(can(actor, 'secret.read', resource, member('owner'))).toEqual({
          allowed: false,
          reason: 'notFound',
          message: NOT_FOUND_MESSAGE,
        });
      }
    },
  );

  it('answers every action on another tenant identically, leaking no existence signal', () => {
    const foreign = environmentResource(OTHER_ENVIRONMENT, OTHER_PROJECT, OTHER_ORG);

    for (const action of ALL_ACTIONS) {
      for (const [, actor] of ACTOR_KINDS) {
        expect(can(actor, action, foreign, member('owner')), action).toEqual({
          allowed: false,
          reason: 'notFound',
          message: NOT_FOUND_MESSAGE,
        });
      }
    }
  });

  // The IDOR shape: the ids are real, the organisation is not the actor's.
  it('does not let a service token reach its own project id under another organisation', () => {
    const decision = can(
      serviceActor(),
      'secret.read',
      environmentResource(STAGING, PROJECT, OTHER_ORG),
      tokenContext('admin'),
    );

    expect(decision).toEqual({
      allowed: false,
      reason: 'notFound',
      message: NOT_FOUND_MESSAGE,
    });
  });

  it('treats an actor with no membership in the organisation as if nothing existed', () => {
    for (const action of ALL_ACTIONS) {
      expect(can(userActor, action, resourceFor(action), { isProduction: false }), action).toEqual({
        allowed: false,
        reason: 'notFound',
        message: NOT_FOUND_MESSAGE,
      });
    }
  });
});

describe('the role matrix', () => {
  it('permits an owner every action', () => {
    for (const action of ALL_ACTIONS) {
      expect(permits(member('owner'), action), action).toBe(true);
    }
  });

  it('permits an admin every action except deleting the organisation', () => {
    for (const action of ALL_ACTIONS) {
      expect(permits(member('admin'), action), action).toBe(action !== 'org.delete');
    }
  });

  // Both tables below are exhaustive over `Action` on purpose: a new action
  // cannot be added without deciding, here, what these two roles may do with it.
  const DEVELOPER_ON_NON_PRODUCTION: Record<Action, boolean> = {
    'project.read': true,
    'project.create': true,
    // Renaming a project needs `admin` on it; a developer defaults to `write`.
    'project.update': false,
    'project.delete': false,
    'environment.read': true,
    'environment.create': true,
    'environment.update': false,
    'environment.delete': false,
    'secret.read': true,
    'secret.create': true,
    'secret.update': true,
    'secret.delete': true,
    'secret.rotate': true,
    'member.read': true,
    'member.invite': false,
    'member.update': false,
    'member.remove': false,
    'audit.read': false,
    'token.create': false,
    'token.revoke': false,
    'org.update': false,
    'org.delete': false,
  };

  const VIEWER_ON_NON_PRODUCTION: Record<Action, boolean> = {
    'project.read': true,
    'project.create': false,
    'project.update': false,
    'project.delete': false,
    'environment.read': true,
    'environment.create': false,
    'environment.update': false,
    'environment.delete': false,
    'secret.read': true,
    'secret.create': false,
    'secret.update': false,
    'secret.delete': false,
    'secret.rotate': false,
    'member.read': true,
    'member.invite': false,
    'member.update': false,
    'member.remove': false,
    'audit.read': false,
    'token.create': false,
    'token.revoke': false,
    'org.update': false,
    'org.delete': false,
  };

  it('gives a developer the secrets of a non-production environment and nothing administrative', () => {
    for (const action of ALL_ACTIONS) {
      expect(permits(member('developer'), action), action).toBe(
        DEVELOPER_ON_NON_PRODUCTION[action],
      );
    }
  });

  it('gives a viewer reads and only reads', () => {
    for (const action of ALL_ACTIONS) {
      expect(permits(member('viewer'), action), action).toBe(VIEWER_ON_NON_PRODUCTION[action]);
    }
  });

  it('denies a viewer every mutation, on every resource, even holding admin grants everywhere', () => {
    const context = member('viewer', {
      grants: [
        { projectId: PROJECT, environmentId: null, accessLevel: 'admin' },
        { projectId: PROJECT, environmentId: STAGING, accessLevel: 'admin' },
      ],
    });

    for (const action of MUTATING_ACTIONS) {
      for (const resource of [orgResource(), projectResource(), environmentResource()]) {
        expect(
          can(userActor, action, resource, context).allowed,
          `${action} on ${resource.kind}`,
        ).toBe(false);
      }
    }
  });
});

describe('production is deny-by-default', () => {
  const production = environmentResource(PRODUCTION);

  it('denies a developer production secrets until production is granted', () => {
    const context = member('developer', { isProduction: true });

    expect(can(userActor, 'secret.read', production, context).allowed).toBe(false);
    expect(can(userActor, 'secret.update', production, context).allowed).toBe(false);
  });

  it('allows a developer into production once a grant says so', () => {
    const context = member('developer', {
      isProduction: true,
      grants: [{ projectId: PROJECT, environmentId: PRODUCTION, accessLevel: 'write' }],
    });

    expect(can(userActor, 'secret.read', production, context).allowed).toBe(true);
    expect(can(userActor, 'secret.update', production, context).allowed).toBe(true);
  });

  it('leaves the same developer writing freely to non-production', () => {
    const context = member('developer');

    expect(can(userActor, 'secret.update', environmentResource(STAGING), context).allowed).toBe(
      true,
    );
  });

  it('denies a viewer production reads, so a viewer never outranks a developer there', () => {
    const context = member('viewer', { isProduction: true });

    expect(can(userActor, 'secret.read', production, context).allowed).toBe(false);
  });

  it('needs no grant for an owner or an admin', () => {
    for (const role of ['owner', 'admin'] as const) {
      const context = member(role, { isProduction: true });
      expect(can(userActor, 'secret.update', production, context).allowed, role).toBe(true);
    }
  });

  it('does not let the production flag of an environment restrict a project-level question', () => {
    // The request arrived through a production environment, but reading the
    // project it belongs to is not a production operation.
    const context = member('developer', { isProduction: true });

    expect(can(userActor, 'project.read', projectResource(), context).allowed).toBe(true);
  });
});

describe('grant resolution', () => {
  function context(role: OrgRole, grants: readonly ResolvedGrant[], isProduction = false) {
    return { role, memberStatus: 'active' as MemberStatus, grants, isProduction };
  }

  it('falls back to the role default when no grant mentions the resource', () => {
    expect(resolveAccessLevel(context('developer', []), PROJECT, STAGING)).toBe('write');
    expect(resolveAccessLevel(context('developer', [], true), PROJECT, PRODUCTION)).toBe('none');
  });

  it('prefers an environment grant over a project-wide one when it is more permissive', () => {
    const grants: ResolvedGrant[] = [
      { projectId: PROJECT, environmentId: null, accessLevel: 'read' },
      { projectId: PROJECT, environmentId: STAGING, accessLevel: 'admin' },
    ];

    expect(resolveAccessLevel(context('viewer', grants), PROJECT, STAGING)).toBe('admin');
  });

  // Specificity beats permissiveness. Without this, "the run of the project
  // except production" is not expressible.
  it('prefers an environment grant over a project-wide one when it is more restrictive', () => {
    const grants: ResolvedGrant[] = [
      { projectId: PROJECT, environmentId: null, accessLevel: 'admin' },
      { projectId: PROJECT, environmentId: PRODUCTION, accessLevel: 'read' },
    ];

    expect(resolveAccessLevel(context('developer', grants, true), PROJECT, PRODUCTION)).toBe(
      'read',
    );
  });

  it('uses the project-wide grant for environments the grants do not name', () => {
    const grants: ResolvedGrant[] = [
      { projectId: PROJECT, environmentId: null, accessLevel: 'read' },
      { projectId: PROJECT, environmentId: STAGING, accessLevel: 'admin' },
    ];

    expect(resolveAccessLevel(context('developer', grants), PROJECT, SANDBOX)).toBe('read');
  });

  it('ignores environment grants when asked about the project itself', () => {
    const grants: ResolvedGrant[] = [
      { projectId: PROJECT, environmentId: STAGING, accessLevel: 'admin' },
    ];

    expect(resolveAccessLevel(context('viewer', grants), PROJECT, null)).toBe('read');
  });

  it('ignores grants belonging to a different project', () => {
    const grants: ResolvedGrant[] = [
      { projectId: OTHER_PROJECT, environmentId: null, accessLevel: 'admin' },
      { projectId: OTHER_PROJECT, environmentId: OTHER_ENVIRONMENT, accessLevel: 'admin' },
    ];

    expect(resolveAccessLevel(context('viewer', grants), PROJECT, STAGING)).toBe('read');
  });

  it('treats an explicit none as a denial rather than as an absence of opinion', () => {
    const grants: ResolvedGrant[] = [
      { projectId: PROJECT, environmentId: PRODUCTION, accessLevel: 'none' },
    ];

    expect(resolveAccessLevel(context('owner', grants, true), PROJECT, PRODUCTION)).toBe('none');
    expect(resolveAccessLevel(context('admin', grants, true), PROJECT, PRODUCTION)).toBe('none');
  });

  it('gives a suspended member nothing, whatever their role and grants say', () => {
    const grants: ResolvedGrant[] = [
      { projectId: PROJECT, environmentId: null, accessLevel: 'admin' },
    ];

    expect(
      resolveAccessLevel(
        { role: 'owner', memberStatus: 'suspended', grants, isProduction: false },
        PROJECT,
        STAGING,
      ),
    ).toBe('none');
  });

  it('applies the production default only to production', () => {
    for (const role of ROLES) {
      expect(resolveAccessLevel(context(role, [], false), PROJECT, STAGING), role).toBe(
        ROLE_ACCESS_DEFAULTS[role].nonProduction,
      );
      expect(resolveAccessLevel(context(role, [], true), PROJECT, PRODUCTION), role).toBe(
        ROLE_ACCESS_DEFAULTS[role].production,
      );
    }
  });
});

describe('an explicit none grant', () => {
  const revoked = [{ projectId: PROJECT, environmentId: PRODUCTION, accessLevel: 'none' as const }];

  it('overrides the owner role on the environment it names', () => {
    const context = member('owner', { grants: revoked, isProduction: true });

    expect(can(userActor, 'secret.read', environmentResource(PRODUCTION), context)).toEqual({
      allowed: false,
      reason: 'forbidden',
      message: FORBIDDEN_MESSAGE,
    });
  });

  // An operator who revokes their own production access — a real practice —
  // must stay revoked until they undo it deliberately.
  it('keeps an admin who revoked their own production access revoked', () => {
    const context = member('admin', { grants: revoked, isProduction: true });

    for (const action of ['secret.read', 'secret.update', 'environment.delete'] as const) {
      expect(can(userActor, action, environmentResource(PRODUCTION), context).allowed, action).toBe(
        false,
      );
    }
  });

  it('takes away only what it names', () => {
    const context = member('owner', { grants: revoked });

    expect(can(userActor, 'secret.read', environmentResource(STAGING), context).allowed).toBe(true);
    expect(can(userActor, 'org.delete', orgResource(), context).allowed).toBe(true);
  });
});

describe('service tokens (T5)', () => {
  const actor = serviceActor();
  const ownEnvironment = environmentResource(STAGING);

  it('reads secrets in the one environment it is pinned to', () => {
    expect(can(actor, 'secret.read', ownEnvironment, tokenContext('read'))).toEqual({
      allowed: true,
    });
  });

  it('writes only when its own access level permits', () => {
    expect(can(actor, 'secret.create', ownEnvironment, tokenContext('read')).allowed).toBe(false);
    expect(can(actor, 'secret.update', ownEnvironment, tokenContext('read')).allowed).toBe(false);
    expect(can(actor, 'secret.create', ownEnvironment, tokenContext('write')).allowed).toBe(true);
    expect(can(actor, 'secret.update', ownEnvironment, tokenContext('write')).allowed).toBe(true);
  });

  it('is denied by an access level of none, the same as any other actor', () => {
    expect(can(actor, 'secret.read', ownEnvironment, tokenContext('none')).allowed).toBe(false);
  });

  it('reports another environment of its own project as not found', () => {
    expect(
      can(actor, 'secret.read', environmentResource(PRODUCTION), tokenContext('admin')),
    ).toEqual({ allowed: false, reason: 'notFound', message: NOT_FOUND_MESSAGE });
  });

  it('reports another project as not found', () => {
    const foreign = environmentResource(OTHER_ENVIRONMENT, OTHER_PROJECT);

    expect(can(actor, 'secret.read', foreign, tokenContext('admin'))).toEqual({
      allowed: false,
      reason: 'notFound',
      message: NOT_FOUND_MESSAGE,
    });
    expect(
      can(actor, 'project.read', projectResource(OTHER_PROJECT), tokenContext('admin')).allowed,
    ).toBe(false);
  });

  it('has no authority at the organisation level at all', () => {
    expect(can(actor, 'member.read', orgResource(), tokenContext('admin')).allowed).toBe(false);
  });

  it('cannot invite a member, mint a token, read the audit log, or delete a project', () => {
    const forbiddenActions: readonly Action[] = [
      'member.invite',
      'member.update',
      'member.remove',
      'token.create',
      'token.revoke',
      'audit.read',
      'project.delete',
      'org.update',
      'org.delete',
    ];

    for (const action of forbiddenActions) {
      // `admin` is the highest level a token can be issued with, so this is the
      // strongest form of the claim.
      expect(can(actor, action, resourceFor(action), tokenContext('admin')).allowed, action).toBe(
        false,
      );
    }
  });

  it('is denied every action outside its allowlist, even holding admin', () => {
    for (const action of ALL_ACTIONS) {
      const permitted = SERVICE_TOKEN_ACTIONS[action] !== undefined;
      const decision = can(actor, action, environmentResource(STAGING), tokenContext('admin'));

      expect(decision.allowed, action).toBe(permitted);
    }
  });

  it('cannot act on secrets addressed at the project rather than an environment', () => {
    expect(can(actor, 'secret.read', projectResource(), tokenContext('admin')).allowed).toBe(false);
  });

  it('cannot borrow a user membership a caller mistakenly supplies', () => {
    expect(can(actor, 'secret.read', ownEnvironment, member('owner')).allowed).toBe(false);
    expect(can(actor, 'member.invite', ownEnvironment, member('owner')).allowed).toBe(false);
  });

  it('is denied when its own row was never loaded', () => {
    expect(can(actor, 'secret.read', ownEnvironment, { isProduction: false }).allowed).toBe(false);
  });

  it('needs the same access level a user would for the actions it shares with one', () => {
    const entries = Object.entries(SERVICE_TOKEN_ACTIONS) as Array<[Action, RequiredAccessLevel]>;

    expect(entries.length).toBeGreaterThan(0);
    for (const [action, minimum] of entries) {
      expect(ACTION_REQUIREMENTS[action], action).toEqual({ scope: 'environment', minimum });
    }
  });
});

describe('CLI tokens', () => {
  it('carry exactly the authority of the user they belong to — no more, no less', () => {
    const grants: ResolvedGrant[] = [
      { projectId: PROJECT, environmentId: null, accessLevel: 'read' },
      { projectId: PROJECT, environmentId: PRODUCTION, accessLevel: 'write' },
    ];

    for (const role of ROLES) {
      for (const isProduction of [false, true]) {
        const context = member(role, { grants, isProduction });

        for (const action of ALL_ACTIONS) {
          const resource = resourceFor(action);

          expect(
            can(cliActor, action, resource, context),
            `${role}/${action}/${String(isProduction)}`,
          ).toEqual(can(userActor, action, resource, context));
        }
      }
    }
  });

  it('is denied everything once the user behind it is suspended', () => {
    const context = member('owner', { status: 'suspended' });

    for (const action of ALL_ACTIONS) {
      expect(can(cliActor, action, resourceFor(action), context).allowed, action).toBe(false);
    }
  });
});

describe('suspension', () => {
  it('denies a suspended owner every action, org-level ones included', () => {
    const context = member('owner', {
      status: 'suspended',
      grants: [{ projectId: PROJECT, environmentId: null, accessLevel: 'admin' }],
    });

    for (const action of ALL_ACTIONS) {
      expect(can(userActor, action, resourceFor(action), context), action).toEqual({
        allowed: false,
        reason: 'forbidden',
        message: FORBIDDEN_MESSAGE,
      });
    }
  });
});

describe('privilege escalation', () => {
  it('does not let a developer promote themselves to admin', () => {
    expect(can(userActor, 'member.update', orgResource(), member('developer')).allowed).toBe(false);
  });

  it('does not let grants buy organisation-level authority', () => {
    // Admin on every resource in the project, which is as far as a grant reaches.
    const context = member('developer', {
      grants: [
        { projectId: PROJECT, environmentId: null, accessLevel: 'admin' },
        { projectId: PROJECT, environmentId: STAGING, accessLevel: 'admin' },
      ],
    });

    for (const action of [
      'member.update',
      'member.invite',
      'token.create',
      'audit.read',
    ] as const) {
      expect(can(userActor, action, orgResource(), context).allowed, action).toBe(false);
    }
  });

  it('does not let an environment admin grant turn a developer into a destroyer', () => {
    const context = member('developer', {
      grants: [{ projectId: PROJECT, environmentId: STAGING, accessLevel: 'admin' }],
    });

    expect(
      can(userActor, 'environment.delete', environmentResource(STAGING), context).allowed,
    ).toBe(false);
    expect(can(userActor, 'project.delete', projectResource(), context).allowed).toBe(false);
  });

  it('lets an admin delegate environment administration to a developer where it is delegable', () => {
    const context = member('developer', {
      grants: [{ projectId: PROJECT, environmentId: STAGING, accessLevel: 'admin' }],
    });

    expect(
      can(userActor, 'environment.update', environmentResource(STAGING), context).allowed,
    ).toBe(true);
    // …and only on the environment named by the grant.
    expect(
      can(userActor, 'environment.update', environmentResource(SANDBOX), context).allowed,
    ).toBe(false);
  });
});

describe('scope mismatches', () => {
  it('denies rather than throws when a resource-scoped action names the organisation', () => {
    expect(can(userActor, 'secret.read', orgResource(), member('owner'))).toEqual({
      allowed: false,
      reason: 'forbidden',
      message: FORBIDDEN_MESSAGE,
    });
    expect(can(userActor, 'project.read', orgResource(), member('owner')).allowed).toBe(false);
  });

  it('denies an environment-scoped action addressed at a project', () => {
    expect(can(userActor, 'secret.read', projectResource(), member('owner')).allowed).toBe(false);
  });

  it('answers an org-scoped action addressed at a nested resource', () => {
    // Routes reach `member.read` from inside a project page; the organisation is
    // implied by the resource.
    expect(can(userActor, 'member.read', environmentResource(), member('viewer')).allowed).toBe(
      true,
    );
  });

  it('never throws, for any combination of action, resource, and context', () => {
    const contexts: readonly AuthorizationContext[] = [
      member('owner'),
      member('viewer', { status: 'suspended' }),
      tokenContext('admin'),
      { isProduction: true },
    ];

    for (const action of ALL_ACTIONS) {
      for (const resource of [orgResource(), projectResource(), environmentResource()]) {
        for (const context of contexts) {
          for (const [, actor] of ACTOR_KINDS) {
            expect(() => can(actor, action, resource, context)).not.toThrow();
          }
        }
      }
    }
  });
});

describe('denial messages', () => {
  it('say nothing about the resource, the action, or whether either exists', () => {
    const denials = [
      can(
        userActor,
        'secret.read',
        environmentResource(OTHER_ENVIRONMENT, OTHER_PROJECT, OTHER_ORG),
        member('owner'),
      ),
      can(userActor, 'org.delete', orgResource(), member('developer')),
      can(serviceActor(), 'audit.read', orgResource(), tokenContext('admin')),
      can(
        userActor,
        'secret.update',
        environmentResource(PRODUCTION),
        member('developer', { isProduction: true }),
      ),
    ];

    for (const denial of denials) {
      expect(denial.allowed).toBe(false);
      if (denial.allowed) continue;

      expect([NOT_FOUND_MESSAGE, FORBIDDEN_MESSAGE]).toContain(denial.message);
      for (const id of [ORG, OTHER_ORG, PROJECT, OTHER_PROJECT, STAGING, PRODUCTION, USER]) {
        expect(denial.message).not.toContain(id);
      }
    }
  });

  it('uses the not-found wording only where existence is the secret', () => {
    // Inside the organisation the actor already knows the resource exists, so
    // hiding it buys nothing and `forbidden` is the honest answer.
    const inside = can(userActor, 'org.delete', orgResource(), member('admin'));

    expect(inside).toEqual({
      allowed: false,
      reason: 'forbidden',
      message: FORBIDDEN_MESSAGE,
    });
  });
});

describe('assertCan', () => {
  it('returns quietly when the action is allowed', () => {
    expect(() =>
      assertCan(userActor, 'secret.read', environmentResource(), member('viewer')),
    ).not.toThrow();
  });

  it('throws an AuthorizationError carrying the whole decision', () => {
    try {
      assertCan(
        userActor,
        'secret.read',
        environmentResource(OTHER_ENVIRONMENT, OTHER_PROJECT, OTHER_ORG),
        member('owner'),
      );
      expect.unreachable('expected a denial to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthorizationError);
      const authorizationError = error as AuthorizationError;

      expect(authorizationError.name).toBe('AuthorizationError');
      expect(authorizationError.decision.reason).toBe('notFound');
      expect(authorizationError.message).toBe(NOT_FOUND_MESSAGE);
    }
  });

  it('reports a forbidden denial distinctly, so the handler can pick a status code', () => {
    try {
      assertCan(userActor, 'org.delete', orgResource(), member('admin'));
      expect.unreachable('expected a denial to throw');
    } catch (error) {
      expect((error as AuthorizationError).decision.reason).toBe('forbidden');
    }
  });
});

describe('access level ordering', () => {
  it('orders none < read < write < admin', () => {
    const shuffled: AccessLevel[] = ['admin', 'none', 'write', 'read'];

    expect([...shuffled].sort(compareAccessLevel)).toEqual(['none', 'read', 'write', 'admin']);
  });

  it('ranks every pair of levels consistently in both directions', () => {
    for (const a of ACCESS_LEVELS) {
      for (const b of ACCESS_LEVELS) {
        const forward = Math.sign(compareAccessLevel(a, b));
        const reverse = Math.sign(compareAccessLevel(b, a));

        expect(forward + reverse, `${a} vs ${b}`).toBe(0);
        // Two levels compare equal only when they are the same level, so no
        // ordering question is ever ambiguous.
        expect(forward === 0, `${a} vs ${b}`).toBe(a === b);
      }
    }
  });

  it('treats a level as satisfying every level at or below it', () => {
    for (const held of ACCESS_LEVELS) {
      for (const required of ACCESS_LEVELS) {
        expect(accessLevelAtLeast(held, required), `${held} >= ${required}`).toBe(
          ACCESS_LEVELS.indexOf(held) >= ACCESS_LEVELS.indexOf(required),
        );
      }
    }
  });

  it('never lets a role default be more permissive in production than outside it', () => {
    for (const role of ROLES) {
      const defaults = ROLE_ACCESS_DEFAULTS[role];
      expect(
        compareAccessLevel(defaults.production, defaults.nonProduction),
        role,
      ).toBeLessThanOrEqual(0);
      expect(roleDefaultAccessLevel(role, true), role).toBe(defaults.production);
      expect(roleDefaultAccessLevel(role, false), role).toBe(defaults.nonProduction);
    }
  });
});

describe('the tables themselves', () => {
  it('states a position for every role on every action', () => {
    for (const role of ROLES) {
      expect(Object.keys(ROLE_CAPABILITIES[role]).sort(), role).toEqual([...ALL_ACTIONS].sort());
    }
  });

  it('never lets a non-owner role delete the organisation', () => {
    for (const role of ROLES) {
      expect(ROLE_CAPABILITIES[role]['org.delete'], role).toBe(role === 'owner');
    }
  });

  it('requires a level of every action that names a project or an environment', () => {
    for (const action of ALL_ACTIONS) {
      const requirement = ACTION_REQUIREMENTS[action];
      if (requirement.scope === 'org') continue;

      // `none` is a denial, so it can never appear as a requirement.
      expect(requirement.minimum, action).not.toBe('none');
    }
  });

  it('lets a service token touch nothing but secrets', () => {
    for (const action of Object.keys(SERVICE_TOKEN_ACTIONS)) {
      expect(action.startsWith('secret.'), action).toBe(true);
    }
  });
});

describe('role assignment — who may hand out which role', () => {
  it('orders roles viewer < developer < admin < owner', () => {
    expect(compareOrgRole('viewer', 'developer')).toBeLessThan(0);
    expect(compareOrgRole('developer', 'admin')).toBeLessThan(0);
    expect(compareOrgRole('admin', 'owner')).toBeLessThan(0);
    expect(compareOrgRole('owner', 'owner')).toBe(0);
  });

  it('never lets anyone assign a role above their own', () => {
    for (const actor of ROLES) {
      for (const target of ROLES) {
        const permitted = compareOrgRole(actor, target) >= 0;
        expect(canAssignRole(actor, target), `${actor} assigning ${target}`).toBe(permitted);
      }
    }
  });

  it('reserves creating owners to owners — the escalation this predicate exists to stop', () => {
    expect(canAssignRole('admin', 'owner')).toBe(false);
    expect(canAssignRole('owner', 'owner')).toBe(true);
  });

  it('covers the touch side too: an admin may not manage a member who holds owner', () => {
    // The same predicate guards both the role being assigned and the role
    // currently held; a route that checks only one lets an admin "demote" an
    // owner, which is removing authority the admin does not hold.
    expect(canAssignRole('admin', 'owner')).toBe(false);
    expect(canAssignRole('admin', 'admin')).toBe(true);
  });
});

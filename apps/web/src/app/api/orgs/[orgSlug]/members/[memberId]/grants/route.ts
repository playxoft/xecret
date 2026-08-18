import { AuthorizationError } from '@xecret/core/authz';
import {
  findEnvironmentBySlug,
  findMemberWithUser,
  findProjectBySlug,
  listGrantsForMember,
  removeAccessGrant,
  upsertAccessGrant,
} from '@xecret/db/repositories';
import { errors } from '@/server/errors';
import { json, noContent, parseJsonBody } from '@/server/http';
import {
  assertRoleAuthority,
  mapMembershipError,
  requireMembership,
  requireSessionPrincipal,
} from '@/server/members-service';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { grantRemoveSchema, grantWriteSchema } from '@/server/schemas/members';
import { authorize, resolveOrg } from '@/server/tenancy';

/**
 * One member's access grants: create or replace one (PUT), remove one (DELETE).
 *
 * A grant names its scope by slug, and both slugs resolve through the same
 * tenant-filtered repository reads every other route uses — so a project or
 * environment id from another organisation is not representable in a request,
 * let alone acceptable (threat T2). The repository re-verifies the scope
 * anyway; defence in depth is the policy, not an accident.
 *
 * The role hierarchy applies to the *member being granted*: an admin may not
 * edit an owner's grants. It deliberately does not apply to the access level —
 * levels and roles are different axes, and `write` on production is not "above"
 * any role. What stops a viewer being over-granted is the capability gate:
 * grants raise what a member may *reach*, never what their role may *do*.
 *
 * Reads are absent on purpose. The member's grants — and what they resolve to —
 * are returned by `[memberId]/access`, which answers the whole question at
 * once; a separate grants listing would be the same data minus the answer.
 */

type Params = { orgSlug: string; memberId: string };

export const PUT = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    const scope = await resolveOrg(principal, params.orgSlug, services);
    const orgId = scope.organization.id;

    await enforce(services.env, 'RL_MUTATION', rateLimitKey([orgId, params.memberId]));

    try {
      authorize(scope, 'member.update');
    } catch (cause) {
      if (cause instanceof AuthorizationError) {
        record(
          audit(orgId).denied('access.granted', { type: 'access_grant', id: null }, cause.decision),
        );
      }
      throw cause;
    }

    const actor = requireSessionPrincipal(principal);
    const membership = requireMembership(scope);

    const target = await findMemberWithUser(services.db, orgId, params.memberId);
    if (!target) throw errors.notFound('no such member in organisation');
    assertRoleAuthority(membership.role, target.role);

    const body = await parseJsonBody(request, grantWriteSchema);

    const project = await findProjectBySlug(services.db, orgId, body.projectSlug);
    if (!project) throw errors.notFound('no project with slug in organisation');

    const environment =
      body.environmentSlug === null || body.environmentSlug === undefined
        ? null
        : ((await findEnvironmentBySlug(services.db, orgId, project.id, body.environmentSlug)) ??
          null);
    if (body.environmentSlug != null && environment === null) {
      throw errors.notFound('no environment with slug in project');
    }

    // Read before write so the audit record can say what the level *was* —
    // "raised from read to write" and "granted write" are different findings
    // in a review of how someone came to hold production access.
    const previous = (await listGrantsForMember(services.db, orgId, target.id)).find(
      (grant) =>
        grant.projectId === project.id && grant.environmentId === (environment?.id ?? null),
    );

    const grant = await upsertAccessGrant(services.db, {
      orgId,
      memberId: target.id,
      projectId: project.id,
      environmentId: environment?.id ?? null,
      accessLevel: body.accessLevel,
      grantedBy: actor.user.id,
    }).catch(mapMembershipError);

    record(
      audit(orgId).success(
        'access.granted',
        {
          type: 'access_grant',
          id: grant.id,
          projectId: project.id,
          environmentId: environment?.id ?? null,
        },
        {
          targetEmail: target.user.email,
          projectSlug: project.slug,
          ...(environment === null ? {} : { environmentSlug: environment.slug }),
          ...(previous === undefined ? {} : { previousAccessLevel: previous.accessLevel }),
          newAccessLevel: grant.accessLevel,
        },
      ),
    );

    return json({
      grant: {
        projectSlug: project.slug,
        environmentSlug: environment?.slug ?? null,
        accessLevel: grant.accessLevel,
      },
    });
  },
);

export const DELETE = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    const scope = await resolveOrg(principal, params.orgSlug, services);
    const orgId = scope.organization.id;

    await enforce(services.env, 'RL_MUTATION', rateLimitKey([orgId, params.memberId]));

    try {
      authorize(scope, 'member.update');
    } catch (cause) {
      if (cause instanceof AuthorizationError) {
        record(
          audit(orgId).denied('access.revoked', { type: 'access_grant', id: null }, cause.decision),
        );
      }
      throw cause;
    }

    requireSessionPrincipal(principal);
    const membership = requireMembership(scope);

    const target = await findMemberWithUser(services.db, orgId, params.memberId);
    if (!target) throw errors.notFound('no such member in organisation');
    assertRoleAuthority(membership.role, target.role);

    const body = await parseJsonBody(request, grantRemoveSchema);

    const project = await findProjectBySlug(services.db, orgId, body.projectSlug);
    if (!project) throw errors.notFound('no project with slug in organisation');

    const environment =
      body.environmentSlug === null || body.environmentSlug === undefined
        ? null
        : ((await findEnvironmentBySlug(services.db, orgId, project.id, body.environmentSlug)) ??
          null);
    if (body.environmentSlug != null && environment === null) {
      throw errors.notFound('no environment with slug in project');
    }

    const removed = await removeAccessGrant(services.db, {
      orgId,
      memberId: target.id,
      projectId: project.id,
      environmentId: environment?.id ?? null,
    }).catch(mapMembershipError);

    // "Revoked" and "there was nothing to revoke" are different facts; only
    // the first earns an audit record, and the second is still a success to
    // the caller — the state they asked for is the state that holds.
    if (removed) {
      record(
        audit(orgId).success(
          'access.revoked',
          {
            type: 'access_grant',
            id: null,
            projectId: project.id,
            environmentId: environment?.id ?? null,
          },
          {
            targetEmail: target.user.email,
            projectSlug: project.slug,
            ...(environment === null ? {} : { environmentSlug: environment.slug }),
          },
        ),
      );
    }

    return noContent();
  },
);

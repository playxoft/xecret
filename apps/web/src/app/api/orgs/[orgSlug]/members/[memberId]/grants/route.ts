import { AuthorizationError } from '@xecret/core/authz';
import {
  findEnvironmentBySlug,
  findMemberWithUser,
  findProjectBySlug,
  listEnvironments,
  listGrantsForMember,
  removeAccessGrant,
  upsertAccessGrant,
} from '@xecret/db/repositories';
import { errors } from '@/server/errors';
import { json, noContent, parseJsonBody } from '@/server/http';
import {
  assertGrantWithinAuthority,
  assertMayChangeOwnGrants,
  assertRemovalWithinAuthority,
  assertRoleAuthority,
  mapMembershipError,
  requireMembership,
  requireSessionPrincipal,
} from '@/server/members-service';
import { recordKeyReconciliation, reconcileMemberKeyAccess } from '@/server/member-keys';
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
 * You can't hand out what you don't hold, and a grant is handed out two ways:
 *
 *  - **The member** must be within the caller's authority
 *    (`assertRoleAuthority`): an admin may not edit an owner's grants.
 *  - **The level** must be one the caller holds where it lands. On PUT that is
 *    the level written (`assertGrantWithinAuthority`); on DELETE it is the
 *    level the member falls back to, which can be *higher* than the row removed
 *    — a developer's explicit production `none`, deleted, lets a project-wide
 *    `write` take over — so a removal that raises the member anywhere must
 *    stay within what the caller holds there (`assertRemovalWithinAuthority`).
 *    Nobody hands out production `write` without holding it, whether a custom
 *    role's ceiling or an explicit grant on themselves holds them below it.
 *  - **Nobody edits their own grants**, except an owner
 *    (`assertMayChangeOwnGrants`). A restriction its holder can delete is not
 *    one; an owner keeps the way back from a restriction they placed on
 *    themselves, and is measured by the owner role rather than by it.
 *
 * What stops a viewer being over-granted is still the capability gate: grants
 * raise what a member may *reach*, never what their role may *do*.
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

    const self = target.userId === actor.user.id;
    if (self) assertMayChangeOwnGrants(membership);
    assertRoleAuthority(membership, target.role);

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

    // You can't hand out what you don't hold. A project-wide row reaches every
    // environment in the project, so it is measured against all of them. An
    // owner setting their own grants is measured by the owner role instead,
    // which every level is within — see `assertMayChangeOwnGrants`.
    if (!self) {
      assertGrantWithinAuthority(
        membership,
        body.accessLevel,
        environment === null
          ? {
              projectId: project.id,
              environment: null,
              projectEnvironments: await listEnvironments(services.db, orgId, project.id),
            }
          : { projectId: project.id, environment },
      );
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

    // A grant change is the path the pending queue was built for. The person
    // making it holds `member.update`, which says nothing about whether they
    // hold the environment's key — an owner can grant production access having
    // never opened production — so what lands here is the access, and the key
    // share is queued for whoever can seal it.
    //
    // A *narrowing* travels the same path and comes out the other way: an
    // explicit `none` on an environment revokes the member's grants there and
    // leaves the environment owing a rotation.
    recordKeyReconciliation(
      await reconcileMemberKeyAccess(services, {
        orgId,
        userId: target.userId,
        actorUserId: actor.user.id,
      }),
      { orgId, audit, record, targetEmail: target.user.email },
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

    const actor = requireSessionPrincipal(principal);
    const membership = requireMembership(scope);

    const target = await findMemberWithUser(services.db, orgId, params.memberId);
    if (!target) throw errors.notFound('no such member in organisation');

    const self = target.userId === actor.user.id;
    if (self) assertMayChangeOwnGrants(membership);
    assertRoleAuthority(membership, target.role);

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

    // A removal can raise the member — they fall back to whatever the row was
    // overriding — so it is held to the same limit as a grant written. Not for
    // an owner lifting their own restriction: what they fall back to is the
    // owner role's own default.
    if (!self) {
      assertRemovalWithinAuthority(
        membership,
        target,
        await listGrantsForMember(services.db, orgId, target.id),
        environment === null
          ? {
              projectId: project.id,
              environment: null,
              projectEnvironments: await listEnvironments(services.db, orgId, project.id),
            }
          : { projectId: project.id, environment },
      );
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

    // Removing a grant falls back to the member's role default, which may be
    // *higher* or lower than the grant that was there — so this is a
    // reconciliation rather than a revocation, and it can just as easily queue a
    // key share as delete one.
    recordKeyReconciliation(
      await reconcileMemberKeyAccess(services, {
        orgId,
        userId: target.userId,
        actorUserId: actor.user.id,
      }),
      { orgId, audit, record, targetEmail: target.user.email },
    );

    return noContent();
  },
);

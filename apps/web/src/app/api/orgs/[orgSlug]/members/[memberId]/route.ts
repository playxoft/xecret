import { AuthorizationError } from '@xecret/core/authz';
import {
  findMemberWithUser,
  reinstateMember,
  removeMember,
  suspendMember,
  updateMemberRole,
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
import { memberPatchSchema, toMember } from '@/server/schemas/members';
import { authorize, resolveOrg } from '@/server/tenancy';

/**
 * One member: change their role, suspend or reinstate them, remove them.
 *
 * Three guards stack on top of `member.update` / `member.remove`, and each
 * stops a distinct failure:
 *
 *  - **The role hierarchy**, on both sides of the change. An admin may not
 *    touch an owner, and may not hand out `owner` — either would be exercising
 *    authority the admin does not hold (see `members-service.ts`).
 *  - **No self-service.** Changing your own role or removing yourself is
 *    refused outright. Demoting yourself mid-session is a mistake with no undo
 *    (the demoted you cannot re-promote you), and "leave organisation" as a
 *    deliberate feature deserves its own affordance rather than falling out of
 *    an admin endpoint. The UI renders no controls on your own row; this is
 *    the check that makes that a rule rather than a rendering choice.
 *  - **The last-owner invariant**, enforced inside the repository transaction
 *    under the organisation lock, where it cannot race (threat: an
 *    organisation stranded with no active owner and no self-service repair).
 */

type Params = { orgSlug: string; memberId: string };

export const PATCH = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    const scope = await resolveOrg(principal, params.orgSlug, services);
    const orgId = scope.organization.id;

    await enforce(services.env, 'RL_MUTATION', rateLimitKey([orgId, params.memberId]));

    try {
      authorize(scope, 'member.update');
    } catch (cause) {
      if (cause instanceof AuthorizationError) {
        record(
          audit(orgId).denied(
            'member.role_changed',
            { type: 'member', id: params.memberId },
            cause.decision,
          ),
        );
      }
      throw cause;
    }

    const actor = requireSessionPrincipal(principal);
    const membership = requireMembership(scope);

    const target = await findMemberWithUser(services.db, orgId, params.memberId);
    if (!target) throw errors.notFound('no such member in organisation');

    if (target.userId === actor.user.id) {
      throw errors.forbidden('You cannot change your own role or status.');
    }
    assertRoleAuthority(membership.role, target.role);

    const body = await parseJsonBody(request, memberPatchSchema);

    if (body.role !== undefined) {
      assertRoleAuthority(membership.role, body.role);

      const updated = await updateMemberRole(services.db, {
        orgId,
        memberId: target.id,
        role: body.role,
      }).catch(mapMembershipError);

      record(
        audit(orgId).success(
          'member.role_changed',
          { type: 'member', id: target.id },
          { targetEmail: target.user.email, previousRole: target.role, newRole: updated.role },
        ),
      );

      return json({
        member: toMember({ ...target, role: updated.role, status: updated.status }, actor.user.id),
      });
    }

    const suspending = body.status === 'suspended';
    const updated = suspending
      ? await suspendMember(services.db, { orgId, memberId: target.id }).catch(mapMembershipError)
      : await reinstateMember(services.db, { orgId, memberId: target.id }).catch(
          mapMembershipError,
        );

    record(
      audit(orgId).success(
        suspending ? 'member.suspended' : 'member.reinstated',
        { type: 'member', id: target.id },
        { targetEmail: target.user.email },
      ),
    );

    return json({
      member: toMember({ ...target, role: updated.role, status: updated.status }, actor.user.id),
    });
  },
);

export const DELETE = authenticatedRoute<Params>(
  async ({ params, principal, services, audit, record }) => {
    const scope = await resolveOrg(principal, params.orgSlug, services);
    const orgId = scope.organization.id;

    await enforce(services.env, 'RL_MUTATION', rateLimitKey([orgId, params.memberId]));

    try {
      authorize(scope, 'member.remove');
    } catch (cause) {
      if (cause instanceof AuthorizationError) {
        record(
          audit(orgId).denied(
            'member.removed',
            { type: 'member', id: params.memberId },
            cause.decision,
          ),
        );
      }
      throw cause;
    }

    const actor = requireSessionPrincipal(principal);
    const membership = requireMembership(scope);

    const target = await findMemberWithUser(services.db, orgId, params.memberId);
    if (!target) throw errors.notFound('no such member in organisation');

    if (target.userId === actor.user.id) {
      throw errors.forbidden('You cannot remove yourself from an organisation.');
    }
    assertRoleAuthority(membership.role, target.role);

    await removeMember(services.db, { orgId, memberId: target.id }).catch(mapMembershipError);

    record(
      audit(orgId).success(
        'member.removed',
        { type: 'member', id: target.id },
        { targetEmail: target.user.email, previousRole: target.role },
      ),
    );

    return noContent();
  },
);

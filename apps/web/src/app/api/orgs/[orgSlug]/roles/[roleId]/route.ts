import type { AuditResource } from '@xecret/core/audit';
import { actionsBeyondBase, auditingDenials } from '@xecret/core/authz';
import type { Denial } from '@xecret/core/authz';
import {
  deleteCustomRole,
  listEnvironmentsForOrganization,
  toEngineCustomRole,
  updateCustomRole,
} from '@xecret/db/repositories';
import type { CustomRoleDefinition, CustomRoleRecord } from '@xecret/db/repositories';
import { errors } from '@/server/errors';
import { json, noContent, parseJsonBody } from '@/server/http';
import { recordKeyReconciliation, reconcileMemberKeyAccess } from '@/server/member-keys';
import {
  assertCustomRoleEditWithinAuthority,
  assertMayDefineCustomRole,
  mapAuditedMembershipError,
  requireCustomRolesPlan,
  requireMembership,
  requireSessionPrincipal,
} from '@/server/members-service';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { isUuid } from '@/server/schemas/ids';
import {
  customRolePatchSchema,
  previousRoleDefinitionMetadata,
  roleDefinitionMetadata,
  toCustomRolePayload,
  toStoredCeiling,
} from '@/server/schemas/roles';
import { authorize, resolveOrg } from '@/server/tenancy';

/**
 * One custom role: edit its definition, or delete it.
 *
 * ── Editing (PATCH) ──
 * Editing a role changes the authority of everybody holding it, so it is
 * measured against them — under the organisation lock, on the role and the
 * holders as they stand when the edit commits (`updateCustomRole` hands both
 * to the checks inside its transaction):
 *
 *  - `canDefineCustomRole` for the base being replaced and the new one;
 *  - `roleWithinAuthority` for every holder's stored role — you do not change
 *    the authority of somebody you could not otherwise manage;
 *  - for every holder the edit *widens* — a capability gained, a ceiling or a
 *    default raised — `heldGrantsWithinAuthority` over the grant rows they
 *    hold, which the wider role switches on.
 *
 * Plan-gated like defining one. A partial body is merged onto the role as
 * locked, and every check runs on the merged result. The holders' environment
 * keys are reconciled afterwards, since the role decides what they may read.
 *
 * ── Deleting (DELETE) ──
 * Only a role nobody holds: the foreign key refuses the rest, and that becomes
 * a 409 telling the caller to move its members off first. The same definer
 * check as editing, on the role's base. Not plan-gated — deleting an unused
 * role takes nothing from anybody, and an organisation that left Enterprise
 * must be able to tidy up.
 *
 * Every refusal is filed: a denial as `denied`, a conflict or a missing role
 * as `error`, each naming the role attempted.
 */

type Params = { orgSlug: string; roleId: string };

export const PATCH = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    const scope = await resolveOrg(principal, params.orgSlug, services);
    const orgId = scope.organization.id;

    await enforce(services.env, 'RL_MUTATION', rateLimitKey([orgId, params.roleId]));

    // A segment outside the pattern names a role that cannot exist.
    if (!isUuid(params.roleId)) throw errors.notFound('role id outside the permitted pattern');
    const resource: AuditResource = { type: 'custom_role', id: params.roleId };

    auditingDenials(
      (decision) => record(audit(orgId).denied('role.updated', resource, decision)),
      () => authorize(scope, 'member.update'),
    );

    const actor = requireSessionPrincipal(principal);
    const membership = requireMembership(scope);

    requireCustomRolesPlan(scope.entitlements, () =>
      record(
        audit(orgId).error('role.updated', resource, 'quotaExceeded', {
          customRoleId: params.roleId,
          limitName: 'customRoles',
          plan: scope.entitlements.plan,
        }),
      ),
    );

    const patch = await parseJsonBody(request, customRolePatchSchema);
    const grid = await listEnvironmentsForOrganization(services.db, orgId);

    const updated = await updateCustomRole(
      services.db,
      { orgId, roleId: params.roleId },
      ({ current, holders }) => {
        const next: CustomRoleDefinition = {
          name: patch.name ?? current.name,
          baseRole: patch.baseRole ?? current.baseRole,
          allowedActions: patch.allowedActions ?? current.allowedActions,
          accessCeiling:
            patch.accessCeiling === undefined
              ? current.accessCeiling
              : toStoredCeiling(patch.accessCeiling),
        };

        // Checked on the merge: a base narrowed without the list following it
        // would otherwise keep actions the new base cannot perform.
        const beyond = actionsBeyondBase(next.baseRole, next.allowedActions);
        if (beyond.length > 0) {
          throw errors.validation([
            {
              field: 'allowedActions',
              message: `A ${next.baseRole}-based role cannot perform ${beyond.join(', ')}.`,
            },
          ]);
        }

        const merged = { ...current, ...next, allowedActions: [...next.allowedActions] };
        auditingDenials(
          (decision: Denial) =>
            record(
              audit(orgId).denied('role.updated', resource, decision, {
                ...roleDefinitionMetadata(merged),
                ...previousRoleDefinitionMetadata(current),
                holderCount: holders.length,
              }),
            ),
          () =>
            assertCustomRoleEditWithinAuthority(
              membership,
              toEngineCustomRole(current),
              toEngineCustomRole(merged),
              holders,
              grid,
            ),
        );

        return next;
      },
    ).catch(
      mapAuditedMembershipError((reason) =>
        record(
          audit(orgId).error('role.updated', resource, reason, { customRoleId: params.roleId }),
        ),
      ),
    );

    record(
      audit(orgId).success('role.updated', resource, {
        ...roleDefinitionMetadata(updated.role),
        ...previousRoleDefinitionMetadata(updated.previous),
        holderCount: updated.holders.length,
      }),
    );

    // What each holder may read follows the role, so their environment keys
    // are reconciled — unless only the name changed, which moves nothing.
    if (changesAccess(updated.previous, updated.role)) {
      for (const holder of updated.holders) {
        recordKeyReconciliation(
          await reconcileMemberKeyAccess(services, {
            orgId,
            userId: holder.userId,
            actorUserId: actor.user.id,
          }),
          { orgId, audit, record, targetEmail: holder.email },
        );
      }
    }

    return json({ role: toCustomRolePayload(updated.role, updated.holders.length) });
  },
);

export const DELETE = authenticatedRoute<Params>(
  async ({ params, principal, services, audit, record }) => {
    const scope = await resolveOrg(principal, params.orgSlug, services);
    const orgId = scope.organization.id;

    await enforce(services.env, 'RL_MUTATION', rateLimitKey([orgId, params.roleId]));

    if (!isUuid(params.roleId)) throw errors.notFound('role id outside the permitted pattern');
    const resource: AuditResource = { type: 'custom_role', id: params.roleId };

    auditingDenials(
      (decision) => record(audit(orgId).denied('role.deleted', resource, decision)),
      () => authorize(scope, 'member.update'),
    );

    requireSessionPrincipal(principal);
    const membership = requireMembership(scope);

    const deleted = await deleteCustomRole(
      services.db,
      { orgId, roleId: params.roleId },
      (current) =>
        auditingDenials(
          (decision: Denial) =>
            record(
              audit(orgId).denied(
                'role.deleted',
                resource,
                decision,
                roleDefinitionMetadata(current),
              ),
            ),
          () => assertMayDefineCustomRole(membership, current.baseRole),
        ),
    ).catch(
      mapAuditedMembershipError((reason) =>
        record(
          audit(orgId).error('role.deleted', resource, reason, { customRoleId: params.roleId }),
        ),
      ),
    );

    // The definition, whole: the row is gone, and this record is the only
    // place left that says what the role allowed.
    record(audit(orgId).success('role.deleted', resource, roleDefinitionMetadata(deleted)));

    return noContent();
  },
);

/** Whether an edit changed anything that decides access — anything but the name. */
function changesAccess(before: CustomRoleRecord, after: CustomRoleRecord): boolean {
  const actions = (role: CustomRoleRecord) => [...role.allowedActions].sort().join(',');
  return (
    before.baseRole !== after.baseRole ||
    actions(before) !== actions(after) ||
    before.accessCeiling?.nonProduction !== after.accessCeiling?.nonProduction ||
    before.accessCeiling?.production !== after.accessCeiling?.production
  );
}

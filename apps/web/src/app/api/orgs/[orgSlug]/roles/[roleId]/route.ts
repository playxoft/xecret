import type { AuditResource } from '@xecret/core/audit';
import { actionsBeyondBase, auditingDenials } from '@xecret/core/authz';
import type { Denial } from '@xecret/core/authz';
import {
  deleteCustomRole,
  listEnvironmentsForOrganization,
  toEngineCustomRole,
  updateCustomRole,
} from '@xecret/db/repositories';
import type { CustomRoleDefinition } from '@xecret/db/repositories';
import { requireFeature } from '@/server/entitlements';
import { errors } from '@/server/errors';
import { describeError } from '@/server/logging';
import { json, noContent, parseJsonBody } from '@/server/http';
import { recordKeyReconciliation, reconcileMemberKeyAccess } from '@/server/member-keys';
import {
  assertCustomRoleEditWithinAuthority,
  assertMayDefineCustomRole,
  mapAuditedMembershipError,
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
  sameAccess,
  sameDefinition,
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
 * locked, and every check runs on the merged result. A merge that changes
 * nothing — `member.read` counts as listed whether or not it is, since the
 * engine keeps it either way — is answered 200 with nothing written, audited
 * or plan-checked.
 *
 * The holders' environment keys are reconciled afterwards, when the edit
 * changed what they may do, since the role decides what they may read. The
 * edit has committed by then: a holder whose reconciliation fails is logged
 * and left for `GET …/keys` to report — as `missingGrants` or
 * `needsRotation` — and the answer is still the 200 the saved role is owed.
 *
 * ── Deleting (DELETE) ──
 * Only a role nobody holds: the foreign key refuses the rest, and that becomes
 * a 409 telling the caller to move its members off first. The same definer
 * check as editing, on the role's base. Not plan-gated — deleting an unused
 * role takes nothing from anybody, and an organisation that left Enterprise
 * must be able to tidy up.
 *
 * Every refusal the route understood is filed: a denial as `denied`; a plan
 * refusal, a list naming actions beyond the base, a conflict or a missing role
 * as `error`, each naming the role attempted. A body the schema refuses is
 * answered 422 and not audited — see `../route.ts`.
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

        // Nothing to change: no write, no record, and no plan to ask about.
        if (sameDefinition(current, next)) return null;

        requireFeature(scope.entitlements, 'customRoles', () =>
          record(
            audit(orgId).error('role.updated', resource, 'quotaExceeded', {
              customRoleId: params.roleId,
              customRoleName: current.name,
              limitName: 'customRoles',
              plan: scope.entitlements.plan,
            }),
          ),
        );

        const merged = { ...current, ...next, allowedActions: [...next.allowedActions] };
        const attempted = {
          ...roleDefinitionMetadata(merged),
          ...previousRoleDefinitionMetadata(current),
          holderCount: holders.length,
        };

        // Checked on the merge: a base narrowed without the list following it
        // would otherwise keep actions the new base cannot perform.
        const beyond = actionsBeyondBase(next.baseRole, next.allowedActions);
        if (beyond.length > 0) {
          record(audit(orgId).error('role.updated', resource, 'invalidInput', attempted));
          throw errors.validation([
            {
              field: 'allowedActions',
              message: `A ${next.baseRole}-based role cannot perform ${beyond.join(', ')}.`,
            },
          ]);
        }

        auditingDenials(
          (decision: Denial) =>
            record(audit(orgId).denied('role.updated', resource, decision, attempted)),
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

    const payload = { role: toCustomRolePayload(updated.role, updated.holders.length) };
    if (!updated.changed) return json(payload);

    record(
      audit(orgId).success('role.updated', resource, {
        ...roleDefinitionMetadata(updated.role),
        ...previousRoleDefinitionMetadata(updated.previous),
        holderCount: updated.holders.length,
      }),
    );

    // What each holder may read follows the role, so their environment keys
    // are reconciled — unless only the name changed, which moves nothing.
    if (!sameAccess(updated.previous, updated.role) && updated.holders.length > 0) {
      const environments = await listEnvironmentsForOrganization(services.db, orgId);
      for (const holder of updated.holders) {
        try {
          recordKeyReconciliation(
            await reconcileMemberKeyAccess(services, {
              orgId,
              userId: holder.userId,
              actorUserId: actor.user.id,
              environments,
            }),
            { orgId, audit, record, targetEmail: holder.email },
          );
        } catch (cause) {
          // The role is saved and every other holder still deserves their
          // reconciliation. What this one is owed stays visible where it can
          // be acted on — `GET …/keys` derives `missingGrants` and
          // `needsRotation` from the rows — and the next change to them runs
          // the same total, idempotent reconciliation again.
          services.log
            .at('PATCH')
            .error(
              'A custom role was saved, but reconciling one holder’s environment keys failed; ' +
                'the environment reports what they are owed, and the next change to them retries.',
              { error: describeError(cause) },
            );
        }
      }
    }

    return json(payload);
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

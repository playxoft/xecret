import type { AuditResource } from '@xecret/core/audit';
import { actionsBeyondBase, auditingDenials } from '@xecret/core/authz';
import type { Denial } from '@xecret/core/authz';
import { cheapestPlanWithFeature } from '@xecret/core/entitlements';
import { createCustomRole, listCustomRoles } from '@xecret/db/repositories';
import { errors } from '@/server/errors';
import { json, parseJsonBody } from '@/server/http';
import {
  assertMayDefineCustomRole,
  mapAuditedMembershipError,
  requireCustomRolesPlan,
  requireMembership,
  requireSessionPrincipal,
} from '@/server/members-service';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import {
  customRoleCreateSchema,
  roleDefinitionMetadata,
  toCustomRolePayload,
  toStoredCeiling,
} from '@/server/schemas/roles';
import { authorize, resolveOrg } from '@/server/tenancy';

/**
 * An organisation's custom roles — the job titles it narrows its built-in
 * roles into — and the door new ones come through.
 *
 * ── Reading (GET) ──
 * `member.update`: the list is what the role-assignment menu offers and what
 * the settings page manages, and both are for people who change members. A
 * role's name reaches everyone else on the member list, beside the person
 * holding it; its action list and ceiling are policy, and stay with the people
 * who apply it. Never plan-gated, so an organisation that has left Enterprise
 * can still see — and clear up — what it defined.
 *
 * ── Defining (POST) ──
 * Browser session only, like every member mutation. `member.update`, then the
 * plan (`customRoles`, Enterprise), then `canDefineCustomRole`: the caller
 * holds no custom role, and the base is neither `owner` nor above their own
 * role. A definition nobody holds confers nothing, so that is the whole of the
 * authority check here — the checks that measure a role against the people it
 * narrows run when it is edited or assigned.
 *
 * A definition whose list names an action its base could never perform is
 * refused rather than stored: it would confer nothing, and a permission list
 * that reads as granting what it cannot is the wrong thing to hand the next
 * person who reviews it.
 */

type Params = { orgSlug: string };

export const GET = authenticatedRoute<Params>(async ({ params, principal, services }) => {
  const scope = await resolveOrg(principal, params.orgSlug, services);
  authorize(scope, 'member.update');

  const roles = await listCustomRoles(services.db, scope.organization.id);
  const enabled = scope.entitlements.features.customRoles;

  return json({
    data: roles.map((role) => toCustomRolePayload(role, role.holderCount)),
    /**
     * Whether this organisation's plan lets it define and assign roles, and the
     * plan that would. Reading is never gated; this is what lets the dashboard
     * say why the controls are absent rather than let a request discover it.
     */
    feature: {
      enabled,
      upgradeTo: enabled ? null : cheapestPlanWithFeature('customRoles'),
    },
  });
});

export const POST = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    const scope = await resolveOrg(principal, params.orgSlug, services);
    const orgId = scope.organization.id;
    const resource: AuditResource = { type: 'custom_role', id: null };

    await enforce(services.env, 'RL_MUTATION', rateLimitKey([orgId]));

    auditingDenials(
      (decision) => record(audit(orgId).denied('role.created', resource, decision)),
      () => authorize(scope, 'member.update'),
    );

    const creator = requireSessionPrincipal(principal);
    const membership = requireMembership(scope);

    requireCustomRolesPlan(scope.entitlements, () =>
      record(
        audit(orgId).error('role.created', resource, 'quotaExceeded', {
          limitName: 'customRoles',
          plan: scope.entitlements.plan,
        }),
      ),
    );

    const body = await parseJsonBody(request, customRoleCreateSchema);

    const beyond = actionsBeyondBase(body.baseRole, body.allowedActions);
    if (beyond.length > 0) {
      throw errors.validation([
        {
          field: 'allowedActions',
          message: `A ${body.baseRole}-based role cannot perform ${beyond.join(', ')}.`,
        },
      ]);
    }

    const definition = {
      name: body.name,
      baseRole: body.baseRole,
      allowedActions: body.allowedActions,
      accessCeiling: toStoredCeiling(body.accessCeiling),
    };
    const attempted = {
      customRoleName: definition.name,
      baseRole: definition.baseRole,
      allowedActions: definition.allowedActions,
      accessCeiling: definition.accessCeiling,
    };

    auditingDenials(
      (decision: Denial) =>
        record(audit(orgId).denied('role.created', resource, decision, attempted)),
      () => assertMayDefineCustomRole(membership, body.baseRole),
    );

    const role = await createCustomRole(services.db, {
      orgId,
      definition,
      createdBy: creator.user.id,
    }).catch(
      mapAuditedMembershipError((reason) =>
        record(audit(orgId).error('role.created', resource, reason, attempted)),
      ),
    );

    record(
      audit(orgId).success(
        'role.created',
        { type: 'custom_role', id: role.id },
        roleDefinitionMetadata(role),
      ),
    );

    return json({ role: toCustomRolePayload(role, 0) }, { status: 201 });
  },
);

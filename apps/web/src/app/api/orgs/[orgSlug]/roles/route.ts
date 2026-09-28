import type { AuditResource } from '@xecret/core/audit';
import { actionsBeyondBase, auditingDenials } from '@xecret/core/authz';
import type { Denial } from '@xecret/core/authz';
import { createCustomRole, listCustomRoles } from '@xecret/db/repositories';
import { featureStatus, requireFeature } from '@/server/entitlements';
import { errors } from '@/server/errors';
import { json, parseJsonBody } from '@/server/http';
import {
  assertMayDefineCustomRole,
  mapAuditedMembershipError,
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
 *
 * ── What is audited ──
 * Every attempt the route understood: a denial as `denied`; a plan refusal, a
 * list naming actions beyond the base, a taken name or the role ceiling as an
 * `error` naming what was attempted. A body the schema refuses — malformed
 * JSON, a missing field, a name with control characters — is answered 422 and
 * not audited: it is a request nobody could have meant, and recording its
 * contents would put an attacker's string in the one table this product keeps
 * truthful.
 */

type Params = { orgSlug: string };

export const GET = authenticatedRoute<Params>(async ({ params, principal, services }) => {
  const scope = await resolveOrg(principal, params.orgSlug, services);
  authorize(scope, 'member.update');

  const roles = await listCustomRoles(services.db, scope.organization.id);

  return json({
    data: roles.map((role) => toCustomRolePayload(role, role.holderCount)),
    /**
     * Whether this organisation's plan lets it define and assign roles, and the
     * plan that would. Reading is never gated; this is what lets the dashboard
     * say why the controls are absent rather than let a request discover it.
     */
    feature: featureStatus(scope.entitlements, 'customRoles'),
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

    requireFeature(scope.entitlements, 'customRoles', () =>
      record(
        audit(orgId).error('role.created', resource, 'quotaExceeded', {
          limitName: 'customRoles',
          plan: scope.entitlements.plan,
        }),
      ),
    );

    const body = await parseJsonBody(request, customRoleCreateSchema);

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

    const beyond = actionsBeyondBase(body.baseRole, body.allowedActions);
    if (beyond.length > 0) {
      record(audit(orgId).error('role.created', resource, 'invalidInput', attempted));
      throw errors.validation([
        {
          field: 'allowedActions',
          message: `A ${body.baseRole}-based role cannot perform ${beyond.join(', ')}.`,
        },
      ]);
    }

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

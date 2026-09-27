import type { AuditAction, AuditBuilder, AuditRecord, AuditResource } from '@xecret/core/audit';
import { afterRoleChange, auditingDenials, capabilitiesGained } from '@xecret/core/authz';
import type { Denial } from '@xecret/core/authz';
import type { Database } from '@xecret/db';
import {
  findMemberWithUser,
  listEnvironmentsForOrganization,
  listGrantsForMember,
  reinstateMember,
  removeMember,
  setMemberCustomRole,
  suspendMember,
  toEngineCustomRole,
  updateMemberRole,
} from '@xecret/db/repositories';
import type { MemberListEntry } from '@xecret/db/repositories';
import { errors } from '@/server/errors';
import { json, noContent, parseJsonBody } from '@/server/http';
import {
  assertCustomRoleChangeWithinAuthority,
  assertHeldGrantsWithinAuthority,
  assertRoleAuthority,
  mapAuditedMembershipError,
  mapMembershipError,
  requireCustomRolesPlan,
  requireMembership,
  requireSessionPrincipal,
} from '@/server/members-service';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { recordKeyReconciliation, reconcileMemberKeyAccess } from '@/server/member-keys';
import { memberPatchSchema, toMember } from '@/server/schemas/members';
import { authorize, resolveOrg } from '@/server/tenancy';
import type { OrgScope } from '@/server/tenancy';
import type { ServiceContext } from '@/server/context';

/**
 * One member: change their role, suspend or reinstate them, move them onto or
 * off a custom role, remove them.
 *
 * Four guards stack on top of `member.update` / `member.remove`, and each
 * stops a distinct failure:
 *
 *  - **The role hierarchy**, on both sides of the change. An admin may not
 *    touch an owner, and may not hand out `owner` — either would be exercising
 *    authority the admin does not hold. A caller holding a custom role is
 *    measured by what it leaves them, not by its rank: one narrowed to member
 *    management cannot promote a developer to a full admin (see
 *    `assertRoleAuthority` in `members-service.ts`).
 *  - **The grants the change switches on.** A reinstatement turns every grant
 *    row the member holds back on, and a role change that gains capabilities
 *    lets the same rows do more — a viewer's production `write` row reads, a
 *    developer's writes. Either is refused unless every such row is one the
 *    caller could have written (`assertHeldGrantsWithinAuthority`), so an
 *    admin capped below production cannot hand production back, or on, to
 *    somebody an owner granted it.
 *  - **No self-service.** Changing your own role or removing yourself is
 *    refused outright. Demoting yourself mid-session is a mistake with no undo
 *    (the demoted you cannot re-promote you), and "leave organisation" as a
 *    deliberate feature deserves its own affordance rather than falling out of
 *    an admin endpoint. The UI renders no controls on your own row; this is
 *    the check that makes that a rule rather than a rendering choice.
 *  - **The last-owner invariant**, enforced inside the repository transaction
 *    under the organisation lock, where it cannot race (threat: an
 *    organisation stranded with no active owner and no self-service repair).
 *
 * A refusal by the first two is filed as a `denied` audit record of the change
 * attempted, as a capability denial is.
 *
 * ── A custom role (`{ customRoleId }`) ──
 * `null` takes the member's custom role off; an id puts them on one, or moves
 * them from one to another. The same guards, applied under the organisation
 * lock to the member as they stand when the write lands
 * (`setMemberCustomRole`): the member's stored role within the caller's
 * authority, and — for a change that widens them, which unassigning and a swap
 * to a wider role both can — every grant row they hold within it too. Putting
 * somebody on a role is plan-gated (`customRoles`); taking them off never is.
 * An owner cannot hold one: 409, before the database's CHECK has to say so.
 * Audited as `member.custom_role_changed`, naming the role before and after.
 */

type Params = { orgSlug: string; memberId: string };

export const PATCH = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    const scope = await resolveOrg(principal, params.orgSlug, services);
    const orgId = scope.organization.id;
    const resource: AuditResource = { type: 'member', id: params.memberId };

    await enforce(services.env, 'RL_MUTATION', rateLimitKey([orgId, params.memberId]));

    auditingDenials(
      (decision) => record(audit(orgId).denied('member.role_changed', resource, decision)),
      () => authorize(scope, 'member.update'),
    );

    const actor = requireSessionPrincipal(principal);
    const membership = requireMembership(scope);

    const target = await findMemberWithUser(services.db, orgId, params.memberId);
    if (!target) throw errors.notFound('no such member in organisation');

    if (target.userId === actor.user.id) {
      throw errors.forbidden('You cannot change your own role or status.');
    }

    const body = await parseJsonBody(request, memberPatchSchema);

    if (body.customRoleId !== undefined) {
      return changeCustomRole({
        scope,
        services,
        audit,
        record,
        target,
        customRoleId: body.customRoleId,
        actorUserId: actor.user.id,
      });
    }

    const attempted: AuditAction =
      body.role !== undefined
        ? 'member.role_changed'
        : body.status === 'suspended'
          ? 'member.suspended'
          : 'member.reinstated';

    // What the change switches on. A reinstatement always — the member's rows
    // are dormant until it lands, whether or not they read as suspended a
    // moment ago. A role change only when the new role, through the member's
    // own custom role, can do something the old one could not; one that gains
    // nothing lets no row do more than it did.
    const switchesOnGrants =
      body.role !== undefined
        ? capabilitiesGained(target, afterRoleChange(target, body.role)).length > 0
        : body.status === 'active';
    const held = switchesOnGrants ? await heldAccess(services.db, orgId, target.id) : null;

    auditingDenials(
      (decision) =>
        record(
          audit(orgId).denied(attempted, resource, decision, {
            targetEmail: target.user.email,
            ...(body.role === undefined ? {} : { previousRole: target.role, newRole: body.role }),
          }),
        ),
      () => {
        assertRoleAuthority(membership, target.role);
        if (body.role !== undefined) assertRoleAuthority(membership, body.role);
        if (held !== null) assertHeldGrantsWithinAuthority(membership, held.grants, held.grid);
      },
    );

    if (body.role !== undefined) {
      const updated = await updateMemberRole(services.db, {
        orgId,
        memberId: target.id,
        role: body.role,
      }).catch(mapMembershipError);

      record(
        audit(orgId).success(
          'member.role_changed',
          { type: 'member', id: target.id },
          {
            targetEmail: target.user.email,
            previousRole: target.role,
            newRole: updated.role,
            // An owner cannot hold a custom role, so the repository clears it
            // in the same write that makes somebody one, and reports what it
            // cleared — read under the lock, so it is the role the member
            // actually held. Recorded in the audit metadata, or nothing in the
            // log would say a narrowing went with the promotion.
            ...(updated.clearedCustomRole === null
              ? {}
              : {
                  previousCustomRoleId: updated.clearedCustomRole.id,
                  previousCustomRoleName: updated.clearedCustomRole.name,
                }),
          },
        ),
      );

      // A role change moves what this person may read, and often in both
      // directions at once: `developer` to `viewer` narrows every non-production
      // environment while leaving production exactly where it was. So the keys
      // are *reconciled* rather than adjusted — see `member-keys.ts` for why one
      // total function beats a branch per act.
      recordKeyReconciliation(
        await reconcileMemberKeyAccess(services, {
          orgId,
          userId: target.userId,
          actorUserId: actor.user.id,
        }),
        { orgId, audit, record, targetEmail: target.user.email },
      );

      return json({
        member: toMember(
          {
            ...target,
            role: updated.role,
            status: updated.status,
            // A promotion to owner clears the custom role in the same write;
            // the record read before it still carries the one that went.
            customRole: updated.clearedCustomRole === null ? target.customRole : undefined,
          },
          actor.user.id,
        ),
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

    // A suspension resolves to `none` everywhere, so this revokes every key the
    // member held; a reinstatement queues them all back. The asymmetry is the
    // honest one: taking a key away is a row deletion, and giving it back needs
    // somebody who holds it to seal a new one.
    recordKeyReconciliation(
      await reconcileMemberKeyAccess(services, {
        orgId,
        userId: target.userId,
        actorUserId: actor.user.id,
      }),
      { orgId, audit, record, targetEmail: target.user.email },
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
    const resource: AuditResource = { type: 'member', id: params.memberId };

    await enforce(services.env, 'RL_MUTATION', rateLimitKey([orgId, params.memberId]));

    auditingDenials(
      (decision) => record(audit(orgId).denied('member.removed', resource, decision)),
      () => authorize(scope, 'member.remove'),
    );

    const actor = requireSessionPrincipal(principal);
    const membership = requireMembership(scope);

    const target = await findMemberWithUser(services.db, orgId, params.memberId);
    if (!target) throw errors.notFound('no such member in organisation');

    if (target.userId === actor.user.id) {
      throw errors.forbidden('You cannot remove yourself from an organisation.');
    }
    auditingDenials(
      (decision) =>
        record(
          audit(orgId).denied('member.removed', resource, decision, {
            targetEmail: target.user.email,
          }),
        ),
      () => assertRoleAuthority(membership, target.role),
    );

    await removeMember(services.db, { orgId, memberId: target.id }).catch(mapMembershipError);

    // After the removal, not before: the reconciliation reads the membership to
    // decide, and a member who is gone resolves to no context — a denial
    // everywhere, which is exactly the answer removal needs.
    //
    // Their `access_grants` rows went with the membership by cascade; their
    // `env_key_grants` rows do **not**, because those hang off `users` rather
    // than off the membership row. This is what removes them, and without it a
    // removed member would keep a sealed key for every environment they had.
    const reconciliation = await reconcileMemberKeyAccess(services, {
      orgId,
      userId: target.userId,
      actorUserId: actor.user.id,
    });

    record(
      audit(orgId).success(
        'member.removed',
        { type: 'member', id: target.id },
        { targetEmail: target.user.email, previousRole: target.role },
      ),
    );

    recordKeyReconciliation(reconciliation, {
      orgId,
      audit,
      record,
      targetEmail: target.user.email,
    });

    return noContent();
  },
);

/**
 * Moves `target` onto the custom role `customRoleId`, from one to another, or
 * off theirs with `null`.
 *
 * The checks run inside `setMemberCustomRole`'s transaction, on the member,
 * the role and the member's grant rows as read under the organisation lock —
 * so the "before" the widening test compares with is the role the write
 * replaces, not whatever an earlier read saw.
 */
async function changeCustomRole(params: {
  scope: OrgScope;
  services: ServiceContext;
  audit: (orgId: string) => AuditBuilder;
  record: (...events: AuditRecord[]) => void;
  target: MemberListEntry;
  customRoleId: string | null;
  actorUserId: string;
}): Promise<Response> {
  const { scope, services, audit, record, target, customRoleId } = params;
  const orgId = scope.organization.id;
  const membership = requireMembership(scope);
  const resource: AuditResource = { type: 'member', id: target.id };
  const attempted = {
    targetEmail: target.user.email,
    ...(customRoleId === null ? {} : { customRoleId }),
  };

  // Taking a role off is never gated: an organisation that has left the plan
  // must still be able to undo what it did while it had it.
  if (customRoleId !== null) {
    requireCustomRolesPlan(scope.entitlements, () =>
      record(
        audit(orgId).error('member.custom_role_changed', resource, 'quotaExceeded', {
          ...attempted,
          limitName: 'customRoles',
          plan: scope.entitlements.plan,
        }),
      ),
    );
  }

  const grid = await listEnvironmentsForOrganization(services.db, orgId);

  const change = await setMemberCustomRole(
    services.db,
    { orgId, memberId: target.id, customRoleId },
    ({ member, next, grants }) =>
      auditingDenials(
        (decision: Denial) =>
          record(
            audit(orgId).denied('member.custom_role_changed', resource, decision, {
              ...attempted,
              ...(next === null ? {} : { customRoleName: next.name }),
              ...(member.customRole === undefined
                ? {}
                : {
                    previousCustomRoleId: member.customRole.id,
                    previousCustomRoleName: member.customRole.name,
                  }),
            }),
          ),
        () =>
          assertCustomRoleChangeWithinAuthority(
            membership,
            member,
            next === null ? undefined : toEngineCustomRole(next),
            grants,
            grid,
          ),
      ),
  ).catch(
    mapAuditedMembershipError((reason) =>
      record(audit(orgId).error('member.custom_role_changed', resource, reason, attempted)),
    ),
  );

  const nextRole = change.next === null ? undefined : toEngineCustomRole(change.next);
  const member = toMember(
    { ...target, role: change.member.role, status: change.member.status, customRole: nextRole },
    params.actorUserId,
  );

  // Asking for the role the member already holds changes nothing, and is
  // recorded as nothing.
  if ((change.previous?.id ?? null) === (change.next?.id ?? null)) return json({ member });

  record(
    audit(orgId).success('member.custom_role_changed', resource, {
      targetEmail: target.user.email,
      ...(change.next === null
        ? {}
        : { customRoleId: change.next.id, customRoleName: change.next.name }),
      ...(change.previous === null
        ? {}
        : {
            previousCustomRoleId: change.previous.id,
            previousCustomRoleName: change.previous.name,
          }),
    }),
  );

  // The role decides what the member may read — its ceiling above all — so
  // their environment keys follow it, exactly as after a built-in role change.
  recordKeyReconciliation(
    await reconcileMemberKeyAccess(services, {
      orgId,
      userId: target.userId,
      actorUserId: params.actorUserId,
    }),
    { orgId, audit, record, targetEmail: target.user.email },
  );

  return json({ member });
}

/** The member's grant rows and the environment grid they are measured against. */
async function heldAccess(db: Database, orgId: string, memberId: string) {
  const [grants, grid] = await Promise.all([
    listGrantsForMember(db, orgId, memberId),
    listEnvironmentsForOrganization(db, orgId),
  ]);
  return { grants, grid };
}

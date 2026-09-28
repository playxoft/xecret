import type { AuditAction, AuditBuilder, AuditRecord, AuditResource } from '@xecret/core/audit';
import { afterRoleChange, auditingDenials, capabilitiesGained } from '@xecret/core/authz';
import type { Denial } from '@xecret/core/authz';
import {
  findMemberWithUser,
  listEnvironmentsForOrganization,
  reinstateMember,
  removeMember,
  setMemberCustomRole,
  suspendMember,
  toEngineCustomRole,
  updateMemberRole,
} from '@xecret/db/repositories';
import type { MemberChangeGuard, MemberListEntry, MemberRecord } from '@xecret/db/repositories';
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
 * ── Decided on the member as the write finds them ──
 * The first two are measured inside the repository's transaction, on the
 * member and their grant rows as read under the organisation lock
 * (`MemberChange`), not on the read this route makes first. That read can be
 * stale by the time the write lands: a concurrent unassignment of the
 * member's custom role, or an edit widening it, changes what a role change
 * gains — and a role change measured against the custom role the member held
 * a moment ago switches on grant rows nobody measured. Every other write that
 * changes a member takes the same lock, so what the guard sees is what the
 * write changes. The route's own read decides only what cannot move under it:
 * that the member exists, and that it is not the caller.
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

    // The grid a role change or a reinstatement measures the member's grant
    // rows against. Read before the transaction; an environment created since
    // is missing from it, and `grantReach` measures a missing one as
    // production — the stricter kind.
    const grid =
      body.role !== undefined || body.status === 'active'
        ? await listEnvironmentsForOrganization(services.db, orgId)
        : [];

    // The member as the write found them, for the audit record and the answer.
    const lockedAs: { member: MemberRecord | null } = { member: null };

    const guard: MemberChangeGuard = ({ member, grants }) => {
      lockedAs.member = member;
      auditingDenials(
        (decision) =>
          record(
            audit(orgId).denied(attempted, resource, decision, {
              targetEmail: target.user.email,
              ...(body.role === undefined ? {} : { previousRole: member.role, newRole: body.role }),
            }),
          ),
        () => {
          assertRoleAuthority(membership, member.role);
          if (body.role !== undefined) assertRoleAuthority(membership, body.role);

          // What the change switches on. A reinstatement always — the member's
          // rows are dormant until it lands. A role change only when the new
          // role, through the custom role the member holds *now*, can do
          // something the old one could not; one that gains nothing lets no
          // row do more than it did.
          const switchesOnGrants =
            body.role !== undefined
              ? capabilitiesGained(member, afterRoleChange(member, body.role)).length > 0
              : body.status === 'active';
          if (switchesOnGrants) assertHeldGrantsWithinAuthority(membership, grants, grid);
        },
      );
    };

    if (body.role !== undefined) {
      const updated = await updateMemberRole(
        services.db,
        { orgId, memberId: target.id, role: body.role },
        guard,
      ).catch(mapMembershipError);
      const before = lockedAs.member ?? target;

      record(
        audit(orgId).success(
          'member.role_changed',
          { type: 'member', id: target.id },
          {
            targetEmail: target.user.email,
            previousRole: before.role,
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
            // The custom role as the write found it — or none, after a
            // promotion to owner cleared it in the same write.
            customRole: updated.clearedCustomRole === null ? before.customRole : undefined,
          },
          actor.user.id,
        ),
      });
    }

    const suspending = body.status === 'suspended';
    const updated = suspending
      ? await suspendMember(services.db, { orgId, memberId: target.id }, guard).catch(
          mapMembershipError,
        )
      : await reinstateMember(services.db, { orgId, memberId: target.id }, guard).catch(
          mapMembershipError,
        );
    const before = lockedAs.member ?? target;

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
      member: toMember(
        { ...target, role: updated.role, status: updated.status, customRole: before.customRole },
        actor.user.id,
      ),
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

    // Measured on the member as the removal finds them, as PATCH explains: a
    // member promoted to owner between this route's read and the write is an
    // owner the caller may not remove.
    const lockedAs: { member: MemberRecord | null } = { member: null };
    await removeMember(services.db, { orgId, memberId: target.id }, ({ member }) => {
      lockedAs.member = member;
      auditingDenials(
        (decision) =>
          record(
            audit(orgId).denied('member.removed', resource, decision, {
              targetEmail: target.user.email,
            }),
          ),
        () => assertRoleAuthority(membership, member.role),
      );
    }).catch(mapMembershipError);
    const removed = lockedAs.member ?? target;

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
        { targetEmail: target.user.email, previousRole: removed.role },
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

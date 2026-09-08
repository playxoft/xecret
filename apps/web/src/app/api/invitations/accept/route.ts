import { hashToken, isWellFormedToken } from '@xecret/core/auth';
import { acceptInvitation, takeInvitationGrants } from '@xecret/db/repositories';
import { errors } from '@/server/errors';
import { toInviteKeyGrant } from '@/server/schemas/env-keys';
import { attemptKey, enforce } from '@/server/rate-limit';
import { json, parseJsonBody } from '@/server/http';
import { recordKeyReconciliation, reconcileMemberKeyAccess } from '@/server/member-keys';
import { mapMembershipError, requireSessionPrincipal } from '@/server/members-service';
import { authenticatedRoute } from '@/server/route';
import { invitationTokenSchema } from '@/server/schemas/members';

/**
 * Accepting an invitation — where a token becomes a membership.
 *
 * Requires a signed-in session, and the session's address must match the
 * invited one: an invitation is addressed to a person, and a forwarded email
 * must not let whoever received it join as somebody else. The check — along
 * with the seat count and the invitation's own state — runs inside the
 * repository transaction under the organisation lock, so what the lookup
 * endpoint showed a moment earlier cannot be what gets committed a moment
 * stale.
 *
 * The audit record is written into the organisation being joined, as
 * `member.joined` — the counterpart of the `member.invited` the inviter left.
 */

export const POST = authenticatedRoute(async ({ request, principal, services, audit, record }) => {
  const actor = requireSessionPrincipal(principal);

  await enforce(services.env, 'RL_INVITE', attemptKey(services.meta.ipAddress, actor.user.id));

  const body = await parseJsonBody(request, invitationTokenSchema);
  if (!isWellFormedToken(body.token, 'invitation')) {
    throw errors.notFound('malformed invitation token');
  }

  const accepted = await acceptInvitation(services.db, {
    tokenHash: await hashToken(body.token),
    userId: actor.user.id,
    userEmail: actor.user.email,
  }).catch(mapMembershipError);

  record(
    audit(accepted.organization.id).success(
      'member.joined',
      { type: 'member', id: accepted.member.id },
      {
        targetEmail: actor.user.email,
        newRole: accepted.member.role,
        // What the invitation's access selection produced, so "what could they
        // reach from the moment they joined?" is answerable from this one row.
        // Legacy invitations carried no selection and say so.
        ...(accepted.grants === null
          ? { reason: 'role-default access (no selection on invitation)' }
          : {
              reason: `${accepted.grants.granted} access grant(s); ${accepted.grants.denied} project(s) denied by default`,
            }),
      },
    ),
  );

  // The membership now exists, so the key reconciliation can decide what this
  // person is owed.
  //
  // ── Why this queues even when the invitation carried sealed grants ──
  // An invitation's grants are sealed to a **one-off invite keypair** (spec §10),
  // not to the invitee's own public key — the invitee did not have one when the
  // invitation was written. Until they open those grants with the fragment and
  // re-seal them to themselves, they hold no member grant, and the queue says so
  // honestly. The pending row is deleted by the very request that adds the
  // re-sealed grant, so the banner lasts exactly as long as the gap it describes.
  //
  // `requestedBy` is the invitee themselves: nobody else acted here, and
  // attributing the debt to the inviter would date it to a request they did not
  // make.
  recordKeyReconciliation(
    await reconcileMemberKeyAccess(services, {
      orgId: accepted.organization.id,
      userId: actor.user.id,
      actorUserId: actor.user.id,
    }),
    {
      orgId: accepted.organization.id,
      audit,
      record,
      targetEmail: actor.user.email,
    },
  );

  // ── The invitation's sealed grants, read and consumed in one act ──
  // They are addressed to the invitation's one-off keypair, and its private half
  // exists only inside the fragment that travelled by a second channel. No
  // principal the server can authenticate is "the holder of that fragment", so
  // there is no endpoint that could serve these on demand — acceptance is the
  // one moment where the token, the session and the invited address have all
  // been checked together, and this is the one response they can ride out on.
  //
  // The rows are deleted as they leave. A fragment does not expire the way the
  // token does; leaving a row behind is a copy of the environment's keys
  // addressed to a credential now sitting in somebody's message history for
  // ever. If the client fails before re-sealing, the invitee holds no key — and
  // the reconciliation above has already recorded exactly that as a pending
  // share for a teammate to fulfil, which is the designed fallback rather than a
  // hole.
  const inviteKeyGrants = await takeInvitationGrants(services.db, {
    orgId: accepted.organization.id,
    invitationId: accepted.invitation.id,
  });

  return json({
    organization: {
      name: accepted.organization.name,
      slug: accepted.organization.slug,
    },
    role: accepted.member.role,
    /**
     * The invitation's id, which is the `recipientId` bound into each grant's
     * AAD (spec §4.2). Returned because the client needs it to open them and
     * cannot obtain it anywhere else — the lookup endpoint deliberately returns
     * no ids at all.
     */
    invitationId: accepted.invitation.id,
    inviteKeyGrants: inviteKeyGrants.map(toInviteKeyGrant),
  });
});

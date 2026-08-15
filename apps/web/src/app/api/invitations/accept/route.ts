import { hashToken, isWellFormedToken } from '@xecret/core/auth';
import { acceptInvitation } from '@xecret/db/repositories';
import { errors } from '@/server/errors';
import { attemptKey, enforce } from '@/server/rate-limit';
import { json, parseJsonBody } from '@/server/http';
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

  return json({
    organization: {
      name: accepted.organization.name,
      slug: accepted.organization.slug,
    },
    role: accepted.member.role,
  });
});

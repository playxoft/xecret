import { invitationState, isWellFormedToken } from '@xecret/core/auth';
import { findInvitationByToken } from '@xecret/db/repositories';
import { errors } from '@/server/errors';
import { json, parseJsonBody } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { publicRoute } from '@/server/route';
import { invitationTokenSchema } from '@/server/schemas/members';

/**
 * What an invitation link opens onto — before anyone signs in.
 *
 * Public by necessity: the person holding the link may have no account yet,
 * and the page they land on has to say *what they are joining* before asking
 * them to authenticate. The token itself is the credential here — 256 random
 * bits, single-use, expiring — so answering its holder reveals nothing a
 * stranger could reach by guessing.
 *
 * A POST with the token in the body, deliberately not a GET with it in the
 * query: query strings land in server logs and browser history, and this one
 * is a credential. (The token does appear in the emailed URL — unavoidable for
 * a link — but the API does not multiply the copies.)
 *
 * What is returned: the organisation's display name, the invited address and
 * role, who asked, and the state. What is not: slugs, ids, member lists, or
 * anything about the organisation beyond what the invitation email already
 * said. An unknown token is a 404 with nothing to distinguish "never existed"
 * from "long since deleted".
 */

export const POST = publicRoute(async ({ request, services }) => {
  await enforce(services.env, 'RL_INVITE', rateLimitKey([services.meta.ipAddress]));

  const body = await parseJsonBody(request, invitationTokenSchema);
  if (!isWellFormedToken(body.token, 'invitation')) {
    // Structurally not an invitation token: refused before it costs a query.
    throw errors.notFound('malformed invitation token');
  }

  const claim = await findInvitationByToken(services.db, body.token);
  if (!claim) throw errors.notFound('no invitation for token');

  const now = new Date();
  return json({
    invitation: {
      email: claim.invitation.email,
      role: claim.invitation.role,
      state: invitationState(claim.invitation, now),
      expiresAt: claim.invitation.expiresAt.toISOString(),
    },
    organization: { name: claim.organization.name },
    invitedBy:
      claim.inviter === null
        ? null
        : { email: claim.inviter.email, displayName: claim.inviter.displayName },
  });
});

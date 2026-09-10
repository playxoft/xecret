import { listClaimableInvitationGrants } from '@xecret/db/repositories';
import { toInviteKeyGrant } from '@/server/schemas/env-keys';
import { attemptKey, enforce } from '@/server/rate-limit';
import { json } from '@/server/http';
import { requireSessionPrincipal } from '@/server/members-service';
import { authenticatedRoute } from '@/server/route';

/**
 * The invitation keys this account accepted and has not claimed yet.
 *
 * ── Why an invite code has to be enterable after the fact ──
 * The two-channel flow assumes the second channel arrives second, and it
 * routinely does not. The link opens on a phone and the code is in an email on a
 * laptop. Somebody joins, sets up their vault, and only then finds the message.
 * Somebody closes the tab. Every one of those was a dead end while acceptance was
 * the single moment the grants were served — and a silent one, because what the
 * invitee saw afterwards was an environment they could list and not read, with
 * nothing on the screen connecting it to the code sitting in their inbox.
 *
 * This endpoint is what makes the fragment path resumable. It is read-only and it
 * consumes nothing: the rows are destroyed by the write that stores the invitee's
 * re-sealed grant (`claimInvitationId` on `POST …/keys/grants`), one environment
 * at a time, so this answer shrinks as they are claimed and empties itself.
 *
 * ── Why serving sealed grants to a session is not a disclosure ──
 * Every blob here is sealed to the invitation's one-off X25519 public key. The
 * session reading them cannot open one; only the fragment can, and the fragment
 * has never been near this server. What the session establishes is entitlement to
 * *attempt* — so the query is scoped to invitations this user id accepted, and
 * nobody can learn of, or claim, anybody else's. That is the same standard
 * `myGrant` is served under.
 *
 * Metered on `RL_INVITE`, the same bucket the lookup and the acceptance spend
 * from. The three are one flow from a person's point of view and there is no rate
 * at which somebody legitimately polls this one — a screen reads it when the
 * "enter your invite code" affordance is opened, and not otherwise.
 */

export const GET = authenticatedRoute(async ({ principal, services }) => {
  const actor = requireSessionPrincipal(principal);

  await enforce(services.env, 'RL_INVITE', attemptKey(services.meta.ipAddress, actor.user.id));

  const claimable = await listClaimableInvitationGrants(services.db, actor.user.id);

  return json({
    invitations: claimable.map((invitation) => ({
      invitationId: invitation.invitationId,
      organization: { slug: invitation.orgSlug, name: invitation.orgName },
      grants: invitation.grants.map(toInviteKeyGrant),
    })),
  });
});

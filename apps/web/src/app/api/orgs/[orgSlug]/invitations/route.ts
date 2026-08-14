import { listInvitations } from '@xecret/db/repositories';
import { json } from '@/server/http';
import { authenticatedRoute } from '@/server/route';
import { toInvitation } from '@/server/schemas/members';
import { authorize, resolveOrg } from '@/server/tenancy';

/**
 * The organisation's open invitations.
 *
 * Gated on `member.invite`, not `member.read`: the list of who has been asked
 * to join — including addresses that never accepted — is recruitment metadata
 * that belongs to the people doing the inviting, not to every member. A
 * developer can see who *is* here; who *might be* coming is not theirs to
 * enumerate.
 *
 * Expired invitations appear with `state: 'expired'` rather than vanishing:
 * they are the answer to "why hasn't Alice joined?", and re-inviting from this
 * list is the expected repair.
 */

type Params = { orgSlug: string };

export const GET = authenticatedRoute<Params>(async ({ params, principal, services }) => {
  const scope = await resolveOrg(principal, params.orgSlug, services);
  authorize(scope, 'member.invite');

  const now = new Date();
  const invitations = await listInvitations(services.db, scope.organization.id);

  return json({
    data: invitations.map((invitation) => toInvitation(invitation, invitation.inviter, now)),
  });
});

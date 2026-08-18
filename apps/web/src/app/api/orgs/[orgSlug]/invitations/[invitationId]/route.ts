import { AuthorizationError } from '@xecret/core/authz';
import { revokeInvitation } from '@xecret/db/repositories';
import { errors } from '@/server/errors';
import { noContent } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { authorize, resolveOrg } from '@/server/tenancy';

/**
 * Withdraws an invitation.
 *
 * The one member-management mutation that does not consult the role hierarchy:
 * an invitation is an offer, not a member, and anyone who may extend offers
 * (`member.invite`) may also withdraw one — including an offer of a role above
 * their own that an owner extended, because withdrawing it hands nobody any
 * authority. The link in the invitee's inbox stops working at commit.
 *
 * Revoking an invitation that was already accepted, already revoked, or never
 * existed is a 404: there is no open invitation by that id, and distinguishing
 * "never existed" from "already closed" would date-stamp other people's
 * membership history for anyone holding `member.invite`.
 */

type Params = { orgSlug: string; invitationId: string };

export const DELETE = authenticatedRoute<Params>(
  async ({ params, principal, services, audit, record }) => {
    const scope = await resolveOrg(principal, params.orgSlug, services);
    const orgId = scope.organization.id;

    await enforce(services.env, 'RL_MUTATION', rateLimitKey([orgId, params.invitationId]));

    try {
      authorize(scope, 'member.invite');
    } catch (cause) {
      if (cause instanceof AuthorizationError) {
        record(
          audit(orgId).denied(
            'invitation.revoked',
            { type: 'invitation', id: params.invitationId },
            cause.decision,
          ),
        );
      }
      throw cause;
    }

    const revoked = await revokeInvitation(services.db, orgId, params.invitationId);
    if (!revoked) throw errors.notFound('no open invitation with id in organisation');

    record(
      audit(orgId).success(
        'invitation.revoked',
        { type: 'invitation', id: revoked.id },
        { targetEmail: revoked.email },
      ),
    );

    return noContent();
  },
);

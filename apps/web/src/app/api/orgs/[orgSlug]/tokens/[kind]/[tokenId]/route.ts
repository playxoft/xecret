import { AuthorizationError } from '@xecret/core/authz';
import { findCliTokenById, revokeCliToken, revokeServiceToken } from '@xecret/db/repositories';
import { actingUserId } from '@/server/actor';
import { errors } from '@/server/errors';
import { noContent } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { authorize, resolveOrg } from '@/server/tenancy';

/**
 * Revoking a token — the kill switch for both credential kinds.
 *
 * Who may pull it differs by kind, and the difference is the design:
 *
 *  - **A CLI token** acts as its user, so its user may always revoke it — "sign
 *    out that laptop" must never require an admin. Revoking *someone else's*
 *    requires `token.revoke`, because that is removing a person's working
 *    credential.
 *  - **A service token** belongs to nobody, so there is no "own" case: it takes
 *    `token.revoke`, the same authority that could have minted it.
 *
 * Both revocations are immediate — the next request with the credential fails
 * authentication, because `findXByHash` filters `revoked_at IS NULL` in SQL.
 * Idempotent: revoking a dead token succeeds without a second audit record,
 * so retries do not fabricate history.
 */

type Params = { orgSlug: string; kind: string; tokenId: string };

export const DELETE = authenticatedRoute<Params>(
  async ({ params, principal, services, audit, record }) => {
    const scope = await resolveOrg(principal, params.orgSlug, services);
    const orgId = scope.organization.id;

    await enforce(services.env, 'RL_MUTATION', rateLimitKey([orgId, params.tokenId]));

    if (params.kind !== 'cli' && params.kind !== 'service') {
      throw errors.notFound('unknown token kind');
    }

    if (params.kind === 'service') {
      try {
        authorize(scope, 'token.revoke');
      } catch (cause) {
        if (cause instanceof AuthorizationError) {
          record(
            audit(orgId).denied(
              'token.revoked',
              { type: 'token', id: params.tokenId },
              cause.decision,
            ),
          );
        }
        throw cause;
      }

      const revoked = await revokeServiceToken(services.db, orgId, params.tokenId);
      if (revoked) {
        record(audit(orgId).success('token.revoked', { type: 'token', id: params.tokenId }));
      }
      return noContent();
    }

    const token = await findCliTokenById(services.db, orgId, params.tokenId);
    if (!token) throw errors.notFound('no CLI token with id in organisation');

    const callerUserId = actingUserId(principal);
    if (callerUserId === null || token.userId !== callerUserId) {
      // Not the owner (or a service token, which owns nothing): this becomes
      // an administrative act and takes the administrative capability.
      try {
        authorize(scope, 'token.revoke');
      } catch (cause) {
        if (cause instanceof AuthorizationError) {
          record(
            audit(orgId).denied('token.revoked', { type: 'token', id: token.id }, cause.decision),
          );
        }
        throw cause;
      }
    }

    const revoked = await revokeCliToken(services.db, orgId, token.id);
    if (revoked) {
      record(
        audit(orgId).success(
          'token.revoked',
          { type: 'token', id: token.id },
          { deviceName: token.name },
        ),
      );
    }

    return noContent();
  },
);

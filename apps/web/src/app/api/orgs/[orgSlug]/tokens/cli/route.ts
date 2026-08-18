import { listCliTokens } from '@xecret/db/repositories';
import { errors } from '@/server/errors';
import { json } from '@/server/http';
import { authenticatedRoute } from '@/server/route';
import { toCliToken } from '@/server/schemas/tokens';
import { authorize, resolveOrg } from '@/server/tenancy';

/**
 * "Your devices" — the caller's own CLI tokens in this organisation.
 *
 * Deliberately scoped to the caller: a CLI token acts as its user and confers
 * no authority of its own, so your device list is yours in the same way your
 * session list is. An admin who needs to kill someone else's CLI credential
 * does it through the revocation route with `token.revoke`; browsing another
 * member's device names first is surveillance the revocation does not need.
 *
 * Revoked tokens are included so a recent revocation is visible rather than
 * silently gone — "did signing out that laptop work?" deserves an answer.
 */

type Params = { orgSlug: string };

export const GET = authenticatedRoute<Params>(async ({ params, principal, services }) => {
  const scope = await resolveOrg(principal, params.orgSlug, services);
  // Settles suspended membership; every active role holds it.
  authorize(scope, 'member.read');

  if (principal.kind === 'serviceToken') {
    throw errors.forbidden('A service token has no devices.');
  }

  const userId = principal.kind === 'user' ? principal.user.id : principal.userId;
  const tokens = await listCliTokens(services.db, scope.organization.id, userId);

  const currentTokenId = principal.kind === 'cliToken' ? principal.tokenId : null;

  return json({
    data: tokens.map((token) => toCliToken(token, currentTokenId)),
  });
});

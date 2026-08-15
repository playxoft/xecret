import { z } from 'zod';
import { clearedSessionCookie, csrfCookie, serializeCookie } from '@xecret/core/auth';
import { errors } from '@/server/errors';
import { json, parseJsonBody } from '@/server/http';
import { deleteAccount } from '@/server/account-service';
import { confirmationMatches } from '@/server/schemas/resources';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';

/**
 * `DELETE /api/auth/account` — the account deletes itself.
 *
 * The gates, in order, and why each exists:
 *
 *  - **A browser session only.** A CLI token acts as its user for secrets, not
 *    for existence: a stolen laptop credential must not be able to erase the
 *    account it was stolen from.
 *  - **The PIN lock applies** (no `allowLocked`): destroying the account
 *    demands the same proof of presence as reading a secret. A locked session
 *    left on a bench cannot do this.
 *  - **CSRF** via the standard wrapper, as for every cookie mutation.
 *  - **The account's email, typed.** The same type-the-name contract as every
 *    destructive action in the product, scaled to the blast radius.
 *
 * What actually happens is `deleteAccount` in `account-service.ts` — one
 * transaction, all or nothing, refused entirely while the caller is the only
 * active owner of an organisation other people are in.
 *
 * The response clears both cookies: the session it rode in on was revoked
 * inside the transaction, and leaving the dead cookie in the browser would
 * make every subsequent render a confusing 401 instead of a clean goodbye.
 */

const deleteAccountRequest = z.strictObject({
  confirm: z.string().max(320),
});

export const DELETE = authenticatedRoute(
  async ({ request, principal, services, audit, record }) => {
    if (principal.kind !== 'user') {
      throw errors.forbidden('Deleting an account requires a signed-in browser session.');
    }

    await enforce(services.env, 'RL_MUTATION', rateLimitKey([principal.user.id]));

    const body = await parseJsonBody(request, deleteAccountRequest);
    if (!confirmationMatches(principal.user.email, body.confirm)) {
      throw errors.badRequest('Type your account email exactly to confirm deletion.');
    }

    const result = await deleteAccount(services, principal.user.id);

    // Recorded after the transaction committed, against the (now soft-deleted)
    // primary organisation — the row survives precisely so records like this one
    // stay reachable. `actorLabel` was denormalised at build time, so the record
    // reads correctly even though the account is gone.
    if (result.primaryOrgId !== null) {
      record(
        audit(result.primaryOrgId).success(
          'auth.account_deleted',
          { type: 'user', id: principal.user.id },
          {
            sessionCount: result.revokedSessions,
            reason: `${result.deletedOrganizations.length} organisation(s) deleted, ${result.leftOrganizations.length} left`,
            source: 'dashboard',
          },
        ),
      );
    }

    return json(
      {
        deleted: true,
        organizationsDeleted: result.deletedOrganizations,
        organizationsLeft: result.leftOrganizations,
      },
      {
        cookies: [serializeCookie(clearedSessionCookie()), csrfCookie('', 0)],
      },
    );
  },
);

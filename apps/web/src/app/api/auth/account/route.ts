import * as z from 'zod/mini';
import { clearedSessionCookie, csrfCookie, serializeCookie } from '@xecret/core/auth';
import { errors } from '@/server/errors';
import { json, parseJsonBody } from '@/server/http';
import { deleteAccount, updateDisplayName } from '@/server/account-service';
import { accountPatchSchema, toAccountProfile } from '@/server/schemas/account';
import { confirmationMatches } from '@/server/schemas/resources';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { primaryOrgId } from '@/server/vault-service';

/**
 * `PATCH /api/auth/account` — the account edits its own profile.
 *
 * One field, and the gates are the ordinary ones rather than the deletion
 * route's:
 *
 *  - **A browser session only**, like the DELETE below. A CLI token acts for its
 *    user over secrets, not over who that user *is* — and a display name is what
 *    every teammate in every shared organisation sees this account as.
 *  - **The vault lock applies** (no `allowLocked`). Not because a name is key
 *    material, but because a locked session is a session whose presence has
 *    expired, and the whole product's rule is that such a session reads nothing
 *    and changes nothing. A carve-out for "harmless" mutations is how that rule
 *    stops being a rule.
 *  - **The mutation allowance**, not the login bucket: this is not a guessing
 *    surface.
 *
 * Audited against the primary organisation, the same way every other
 * account-level act is — see `primaryOrgId`. The record carries the new name and
 * never the old one: a log is not editable, and somebody changing the name they
 * are known by should not have the previous one preserved in it forever. Nothing
 * in the log depends on the name anyway; the actor is denormalised by email.
 *
 * The response is the whole profile rather than the field that changed, so the
 * client can adopt it exactly as it adopts `GET /api/auth/me`.
 */

export const PATCH = authenticatedRoute(async ({ request, principal, services, audit, record }) => {
  if (principal.kind !== 'user') {
    throw errors.forbidden('Editing a profile requires a signed-in browser session.');
  }

  await enforce(services.env, 'RL_MUTATION', rateLimitKey([principal.user.id]));

  const body = await parseJsonBody(request, accountPatchSchema);
  // `undefined` cannot reach here — the schema refuses an empty patch, and
  // `displayName` is the only field in it.
  const displayName = body.displayName ?? null;
  const user = await updateDisplayName(services, principal.user.id, displayName);

  const orgId = await primaryOrgId(services, principal.user.id);
  if (orgId !== null) {
    record(
      audit(orgId).success(
        'auth.profile_updated',
        { type: 'user', id: principal.user.id },
        {
          source: 'dashboard',
          reason:
            displayName === null ? 'display name cleared' : `display name set to “${displayName}”`,
        },
      ),
    );
  }

  return json({ user: toAccountProfile(user) });
});

/**
 * `DELETE /api/auth/account` — the account deletes itself.
 *
 * The gates, in order, and why each exists:
 *
 *  - **A browser session only.** A CLI token acts as its user for secrets, not
 *    for existence: a stolen laptop credential must not be able to erase the
 *    account it was stolen from.
 *  - **The vault lock applies** (no `allowLocked`): destroying the account
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
  confirm: z.string().check(z.maxLength(320)),
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

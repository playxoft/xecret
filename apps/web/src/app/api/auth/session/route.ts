import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  clearedSessionCookie,
  csrfCookie,
  hashToken,
  isWellFormedToken,
  serializeCookie,
  verifyCsrf,
} from '@xecret/core/auth';
import {
  findSessionByTokenHash,
  listOrganizationsForUser,
  revokeSession,
} from '@xecret/db/repositories';
import { errors } from '@/server/errors';
import { noContent, parseCookies } from '@/server/http';
import { publicRoute } from '@/server/route';
import { auditFor, writeEvents } from '@/server/sign-in';

/**
 * The browser session's one remaining verb here: ending it.
 *
 * Signing *in* moved to `GET /api/auth/login` and `GET /api/auth/callback` with
 * the switch to WorkOS (ADR 0010). The `POST` that used to sit here took a
 * Firebase ID token from the browser and exchanged it for a session; there is no
 * browser-held token in the new flow — AuthKit hands this server an
 * authorization code, which the callback exchanges itself — so the endpoint
 * that accepted one is gone rather than ported. A `POST` now answers 405.
 *
 * Logout is unchanged, byte for byte: same CSRF rule, same revocation, same
 * cookies cleared, same audit record.
 */

/**
 * Logout.
 *
 * `publicRoute` rather than `authenticatedRoute` so that a user holding an
 * already-expired or already-revoked session can still clear their cookies: a
 * 401 here would leave a stale cookie in the browser and a confusing loop for
 * the person trying to sign out.
 *
 * CSRF is still enforced when a session cookie is present, because a forced
 * logout is a real — if minor — cross-site nuisance. Absent a cookie there is
 * nothing to protect and nothing to revoke, so the request simply succeeds.
 */
export const DELETE = publicRoute(async ({ request, services }) => {
  const cookies = parseCookies(request.headers.get('cookie'));
  const token = cookies.get(SESSION_COOKIE_NAME) ?? null;

  if (token !== null) {
    const csrf = verifyCsrf(
      cookies.get(CSRF_COOKIE_NAME) ?? null,
      request.headers.get('x-xecret-csrf'),
    );
    if (!csrf.ok) throw errors.csrf(csrf.reason);

    if (isWellFormedToken(token, 'session')) {
      const session = await findSessionByTokenHash(services.db, await hashToken(token));
      if (session) {
        await revokeSession(services.db, session.id);

        // A session is not org-scoped — one session spans every organisation a
        // user belongs to — but `audit_logs.org_id` is NOT NULL, because a
        // record nobody's audit view can reach is a record nobody will read.
        // The event is therefore attributed to the user's primary organisation.
        // The honest limitation: a member of several organisations produces one
        // logout record rather than one per organisation. Recording it N times
        // would be worse — it would read as N separate acts.
        const memberships = await listOrganizationsForUser(services.db, session.user.id);
        const primary = memberships[0];

        if (primary) {
          const audit = auditFor(primary.organization.id, session.user, services);
          services.waitUntil(
            writeEvents(services, [
              audit.success('auth.logout', { type: 'session', id: session.id }),
            ]),
          );
        }
      }
    }
  }

  // Cleared unconditionally. Whether or not a row was found, the browser must
  // stop presenting these cookies.
  return noContent([serializeCookie(clearedSessionCookie()), csrfCookie('', 0)]);
});

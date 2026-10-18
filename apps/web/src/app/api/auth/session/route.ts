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
  revokeSessionForSignOut,
} from '@xecret/db/repositories';
import { SIGN_IN_PATH } from '@/lib/session-hint';
import { publicOrigin } from '@/server/bindings';
import type { ServiceContext } from '@/server/context';
import { errors } from '@/server/errors';
import { json, parseCookies } from '@/server/http';
import { describeError } from '@/server/logging';
import { publicRoute } from '@/server/route';
import { auditFor, writeEvents } from '@/server/sign-in';
import { workosProvider } from '@/server/workos';

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
 * Logout keeps its CSRF rule, its revocation, the cookies it clears and its
 * audit record — and now also ends the AuthKit session (review round 2).
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
 *
 * ── And the AuthKit session behind it ──
 * Revoking the xecret session used to be all of it, which left AuthKit's own
 * session alive on its hosted domain: the person's next "Sign in" was answered
 * without asking anything, and the callback — seeing a session reused without
 * asking — held it back for them to confirm. Nearly every returning person was
 * asked "Is this you?", which is how people learn to click "Continue" without
 * reading (review round 2). So the session records the AuthKit session it came
 * from (`workos_session_id`, the access token's `sid`), and this answers `200`
 * with `{ logoutUrl }`: WorkOS's logout URL for that session, returning to
 * `/sign-in`, which the dashboard then navigates to. `logoutUrl` is `null` for
 * a session that recorded none — every session issued before migration 0023 —
 * and when WorkOS is not configured; those sign out exactly as before.
 */
export const DELETE = publicRoute(async ({ request, services }) => {
  const cookies = parseCookies(request.headers.get('cookie'));
  const token = cookies.get(SESSION_COOKIE_NAME) ?? null;
  let workosSessionId: string | null = null;

  if (token !== null) {
    const csrf = verifyCsrf(
      cookies.get(CSRF_COOKIE_NAME) ?? null,
      request.headers.get('x-xecret-csrf'),
    );
    if (!csrf.ok) throw errors.csrf(csrf.reason);

    if (isWellFormedToken(token, 'session')) {
      const session = await findSessionByTokenHash(services.db, await hashToken(token));
      if (session) {
        // The AuthKit session comes from the row this call revoked, so a
        // second sign-out of an already-ended session hands out nothing.
        ({ workosSessionId } = await revokeSessionForSignOut(services.db, session.id));

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
  return json(
    { logoutUrl: workosSessionId === null ? null : authKitLogoutUrl(services, workosSessionId) },
    { cookies: [serializeCookie(clearedSessionCookie()), csrfCookie('', 0)] },
  );
});

/**
 * WorkOS's logout URL for one AuthKit session, returning to the sign-in page —
 * or `null` when it cannot be built, which is logged and never fails the
 * sign-out: the xecret session is already gone, and that is the half that
 * guards anything.
 */
function authKitLogoutUrl(services: ServiceContext, sessionId: string): string | null {
  try {
    return workosProvider(services.env).logoutUrl({
      sessionId,
      returnTo: `${publicOrigin(services.env)}${SIGN_IN_PATH}`,
    });
  } catch (cause) {
    services.log
      .at('signOut')
      .error('Signed out of xecret, but could not build the WorkOS logout URL; AuthKit stays', {
        error: describeError(cause),
      });
    return null;
  }
}

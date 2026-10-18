import {
  computePkceChallenge,
  generateOAuthSecrets,
  oauthStateCookie,
  sealOAuthState,
} from '@xecret/core/auth';
import type { OAuthPurpose } from '@xecret/core/auth';
import { SLUG_MAX_LENGTH, SLUG_PATTERN } from '@xecret/core/validation';
import { findOrganizationBySlugWithEntitlements } from '@xecret/db/repositories';
import { safeRedirectPath } from '@/lib/redirect-path';
import { POST_SIGN_IN_PATH, SIGN_IN_PATH } from '@/lib/session-hint';
import { MissingBindingError, publicOrigin } from '@/server/bindings';
import type { ServiceContext } from '@/server/context';
import { isSameOriginNavigation } from '@/server/http';
import { consume, rateLimitKey } from '@/server/rate-limit';
import { publicRoute } from '@/server/route';
import { oauthStateKey } from '@/server/sign-in';
import { workosProvider } from '@/server/workos';

/**
 * Starts a sign-in: sends the browser to AuthKit.
 *
 * `GET`, and reached by a plain link from the sign-in page, because the whole
 * flow is navigations — nothing about it needs script, and nothing about it is
 * a mutation of anything on this side. What it does write is a cookie, and the
 * cookie is the point:
 *
 *  - a fresh `state` and PKCE verifier, sealed into `__Host-xecret_oauth_state`
 *    (`@xecret/core/auth`, `oauth-state.ts`), so the callback accepts a code
 *    only in the browser that asked for it;
 *  - `next`, validated *here*, before it is written — the callback redirects to
 *    whatever the signed cookie says, so this is the one place it is checked;
 *  - the purpose: an ordinary sign-in, or a forced re-authentication.
 *
 * ── Query parameters, every one optional and every one untrusted ──
 *  - `next` — a same-origin path. Anything else falls back to `/app`.
 *  - `hint=sign-up` — open AuthKit on its sign-up screen.
 *  - `org=<slug>` — an SSO deep link: start that organisation's single sign-on
 *    directly. An organisation without SSO, or one that does not exist, falls
 *    through to the ordinary screen. The redirect does reveal the WorkOS
 *    organisation id of a slug that has SSO — it has to, to deep-link — so the
 *    lookups are rate limited per address, and over the limit the parameter is
 *    silently ignored rather than refused (a refusal would be its own oracle).
 *    Ignored on a re-authentication, which is about this account, not an
 *    organisation.
 *
 *    **Honoured only from a same-origin navigation** — the sign-in page's own
 *    button. Anything else (a link on another site, an email, a bookmark) is
 *    sent to `/sign-in?org=<slug>` instead, which names the organisation and
 *    asks the person to confirm. That is PR #114's constraint for WS-5, and the
 *    attack is login CSRF: now that an organisation can be linked to WorkOS,
 *    somebody could link their own, point it at an identity provider they
 *    control that signs anybody in as *them*, and send a victim to
 *    `?org=<theirs>`. Followed blind, the victim would land signed in to the
 *    attacker's account — and whatever they stored next would be the
 *    attacker's. The confirmation is the moment they can notice the name is not
 *    their company's. Same-origin is read from `Sec-Fetch-Site`, or, from a
 *    browser that does not send it, from a `Referer` on this origin (the site's
 *    referrer policy sends one on every same-origin navigation) — and it must
 *    be a navigation to a document (`Sec-Fetch-Mode`/`-Dest`, where sent).
 *
 *    That stops a link from *starting* somebody else's SSO; it cannot stop an
 *    attacker planting their own AuthKit session by sending the browser to
 *    AuthKit directly, so the organisation this flow asked for is sealed into
 *    the state, and the callback holds back any sign-in that comes back
 *    through another for the person to confirm.
 *  - `reauth=1` — sign in again for the vault reset's first lock. Sends AuthKit
 *    `max_age=0`, which makes AuthKit ask for a password or passkey even when it
 *    holds a session; it does not make Google or a company's identity provider
 *    re-prompt (ADR 0010). The parameter is only a request — whoever holds the
 *    browser can strip it — so the callback checks the outcome, the access
 *    token's `auth_time`, before it counts the sign-in (`armsLockOne`).
 *
 * ── A deployment that cannot sign anybody in ──
 * Missing WorkOS configuration is answered with a redirect to the sign-in
 * page's `unavailable` error rather than a JSON 503: this is a top-level
 * navigation, and a JSON body on a blank tab is a dead end. (A deployment
 * missing its database or root key fails earlier, in the route wrapper, like
 * every other route.)
 */
export const GET = publicRoute(async ({ request, services }) => {
  const url = new URL(request.url);
  const next = safeRedirectPath(url.searchParams.get('next'), POST_SIGN_IN_PATH);
  const purpose: OAuthPurpose = url.searchParams.get('reauth') === '1' ? 'reauth' : 'sign-in';
  const screenHint = url.searchParams.get('hint') === 'sign-up' ? 'sign-up' : undefined;
  const orgSlug = purpose === 'reauth' ? null : wellFormedSlug(url.searchParams.get('org'));

  // An SSO deep link that did not come from this site's own sign-in page goes
  // there first, to be confirmed — see `org=` above. Before anything else, so
  // a cross-site link costs no lookup, no rate-limit token and no cookie.
  if (orgSlug !== null && !isSameOriginNavigation(request, publicOrigin(services.env))) {
    const target = new URLSearchParams({ org: orgSlug });
    if (next !== POST_SIGN_IN_PATH) target.set('next', next);
    return new Response(null, {
      status: 303,
      headers: { location: `${SIGN_IN_PATH}?${target.toString()}`, 'cache-control': 'no-store' },
    });
  }

  // Resolved before anything else is built, so a misconfigured deployment
  // says so without having touched the database.
  let provider: ReturnType<typeof workosProvider>;
  let key: CryptoKey;
  try {
    provider = workosProvider(services.env);
    key = await oauthStateKey(services.env);
  } catch (cause) {
    if (!(cause instanceof MissingBindingError)) throw cause;
    services.log
      .at('login')
      .error(
        `This deployment is missing ${cause.binding}, so nobody can sign in until it is configured`,
        { binding: cause.binding },
      );
    const target = new URLSearchParams({ error: 'unavailable' });
    if (next !== POST_SIGN_IN_PATH) target.set('next', next);
    return new Response(null, {
      status: 303,
      headers: { location: `${SIGN_IN_PATH}?${target.toString()}`, 'cache-control': 'no-store' },
    });
  }

  const organizationId =
    orgSlug === null ? undefined : await ssoOrganization(services, orgSlug, provider.clientId);

  const { state, verifier } = generateOAuthSecrets();
  const cookie = await sealOAuthState(key, {
    state,
    verifier,
    next,
    purpose,
    issuedAt: Math.floor(Date.now() / 1000),
    // What this flow asked for, sealed beside its `state`: the callback holds
    // back any sign-in that comes back through a different organisation — or
    // through one when none was asked for — for the person to confirm (the
    // planted-session login CSRF; see the callback, step 6).
    organizationId: organizationId ?? null,
  });

  const location = provider.authorizationUrl({
    state,
    codeChallenge: await computePkceChallenge(verifier),
    organizationId,
    // A re-authentication is a sign-in, never a sign-up.
    screenHint: purpose === 'reauth' ? undefined : screenHint,
    maxAge: purpose === 'reauth' ? 0 : undefined,
  });

  const headers = new Headers({
    location,
    // No referrer header of its own: the site-wide `strict-origin-when-cross-
    // origin` (next.config.ts) already sends a cross-site hop only the origin,
    // never the query, and Next applies it over anything a route sets.
    'cache-control': 'no-store',
  });
  headers.append('set-cookie', oauthStateCookie(cookie));
  return new Response(null, { status: 307, headers });
});

/**
 * The WorkOS organisation an `?org=` slug deep-links to, or `undefined` — also
 * when this address has looked up too many slugs, so that the deep link cannot
 * be walked to list which organisations have SSO, and when the link was made in
 * a different WorkOS environment from this deployment's (review S9), whose
 * organisation id AuthKit here would not know.
 */
async function ssoOrganization(
  services: ServiceContext,
  slug: string,
  clientId: string,
): Promise<string | undefined> {
  const allowed = await consume(
    services.env,
    'RL_LOGIN',
    rateLimitKey(['login_org', services.meta.ipAddress]),
  );
  if (!allowed.allowed) return undefined;
  const found = await findOrganizationBySlugWithEntitlements(services.db, slug);
  if (!found || found.organization.workosClientId !== clientId) return undefined;
  return found.organization.workosOrgId ?? undefined;
}

/** `org=` as a slug, or `null` for anything that is not one — which is then ignored. */
function wellFormedSlug(value: string | null): string | null {
  if (value === null || value.length > SLUG_MAX_LENGTH || !SLUG_PATTERN.test(value)) return null;
  return value;
}

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
import { MissingBindingError } from '@/server/bindings';
import type { ServiceContext } from '@/server/context';
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
 *  - `reauth=1` — sign in again for the vault reset's first lock. Sends AuthKit
 *    `max_age=0`, which makes AuthKit ask for a password or passkey even when it
 *    holds a session; it does not make Google or a company's identity provider
 *    re-prompt (ADR 0010).
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
    purpose === 'reauth' ? undefined : await ssoOrganization(services, url.searchParams.get('org'));

  const { state, verifier } = generateOAuthSecrets();
  const cookie = await sealOAuthState(key, {
    state,
    verifier,
    next,
    purpose,
    issuedAt: Math.floor(Date.now() / 1000),
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
 * be walked to list which organisations have SSO.
 */
async function ssoOrganization(
  services: ServiceContext,
  slug: string | null,
): Promise<string | undefined> {
  if (slug === null || slug.length > SLUG_MAX_LENGTH || !SLUG_PATTERN.test(slug)) return undefined;
  const allowed = await consume(
    services.env,
    'RL_LOGIN',
    rateLimitKey(['login_org', services.meta.ipAddress]),
  );
  if (!allowed.allowed) return undefined;
  const found = await findOrganizationBySlugWithEntitlements(services.db, slug);
  return found?.organization.workosOrgId ?? undefined;
}

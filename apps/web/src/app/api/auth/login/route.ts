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
import { POST_SIGN_IN_PATH } from '@/lib/session-hint';
import type { ServiceContext } from '@/server/context';
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
 *    through to the ordinary screen, so the parameter answers no question about
 *    either.
 *  - `reauth=1` — make AuthKit ask for the credential again even if it holds a
 *    session (`max_age=0`). The vault reset's first lock.
 *
 * No rate limit of its own: it does no work worth limiting — one indexed lookup
 * at most — and the callback, which does, is limited.
 */
export const GET = publicRoute(async ({ request, services }) => {
  const url = new URL(request.url);
  const next = safeRedirectPath(url.searchParams.get('next'), POST_SIGN_IN_PATH);
  const purpose: OAuthPurpose = url.searchParams.get('reauth') === '1' ? 'reauth' : 'sign-in';
  const screenHint = url.searchParams.get('hint') === 'sign-up' ? 'sign-up' : undefined;

  // Resolved before anything else is built, so a misconfigured deployment
  // answers 503 without having touched the database.
  const provider = workosProvider(services.env);
  const key = await oauthStateKey(services.env);

  const organizationId = await ssoOrganization(services, url.searchParams.get('org'));

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
    'cache-control': 'no-store',
    // The authorization URL carries the state and the PKCE challenge; neither
    // is a secret, but neither is anybody else's business either.
    'referrer-policy': 'no-referrer',
  });
  headers.append('set-cookie', oauthStateCookie(cookie));
  return new Response(null, { status: 307, headers });
});

/** The WorkOS organisation an `?org=` slug deep-links to, or `undefined`. */
async function ssoOrganization(
  services: ServiceContext,
  slug: string | null,
): Promise<string | undefined> {
  if (slug === null || slug.length > SLUG_MAX_LENGTH || !SLUG_PATTERN.test(slug)) return undefined;
  const found = await findOrganizationBySlugWithEntitlements(services.db, slug);
  return found?.organization.workosOrgId ?? undefined;
}

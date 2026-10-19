import { isApiError } from '@/lib/api';
import { safeRedirectPath } from '@/lib/redirect-path';
import { POST_SIGN_IN_PATH } from '@/lib/session-hint';
import { loginHref } from '../../(auth)/_components/login-href';

/**
 * What a screen says when the organisation it is showing answered
 * `sso_required` — this session signed in some way other than the
 * organisation's own single sign-on, and the organisation requires it (review
 * round 2, L9).
 *
 * Not a failure to load, and not "you do not have access": the person is a
 * member, may do what they were doing, and can fix it themselves in one step —
 * by signing in through the organisation's identity provider. So the screen
 * says exactly that, and offers the step: the organisation's SSO deep link,
 * back to the page they were on. Through `GET /api/auth/login?org=…`, which
 * sends them to the sign-in page's warning first (the deep link is only ever
 * followed from there); the organisation is theirs, so they continue.
 */

export interface SsoRequiredRemedy {
  title: string;
  body: string;
  /** The deep link to sign in through, or `null` when the organisation is not known here. */
  href: string | null;
}

/** The remedy for an `sso_required` answer, or `null` for any other error. */
export function ssoRequiredRemedy(
  error: unknown,
  orgSlug: string | null | undefined,
  pathname: string | null | undefined,
): SsoRequiredRemedy | null {
  if (!isApiError(error) || error.code !== 'sso_required') return null;
  const href =
    typeof orgSlug === 'string' && orgSlug !== ''
      ? loginHref({ org: orgSlug, next: safeRedirectPath(pathname, POST_SIGN_IN_PATH) })
      : null;
  return {
    title: 'This organisation requires single sign-on',
    body:
      'You signed in some other way, so this organisation is out of reach until you sign in ' +
      'through its single sign-on — your company’s identity provider. Your other organisations ' +
      'are not affected.',
    href,
  };
}

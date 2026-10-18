import {
  clearedSignInConfirmationCookie,
  hashToken,
  openSignInConfirmation,
  SESSION_COOKIE_NAME,
  SIGN_IN_CONFIRMATION_COOKIE_NAME,
  SIGN_IN_CONFIRMATION_TTL_SECONDS,
} from '@xecret/core/auth';
import { timingSafeEqual, utf8Encode } from '@xecret/core/crypto';
import { findUserById, spendSignInConfirmation } from '@xecret/db/repositories';
import { safeRedirectPath } from '@/lib/redirect-path';
import { POST_SIGN_IN_PATH, SIGN_IN_PATH } from '@/lib/session-hint';
import { publicOrigin } from '@/server/bindings';
import { parseCookies } from '@/server/http';
import { attemptKey, consume } from '@/server/rate-limit';
import { publicRoute } from '@/server/route';
import { issueSignIn, signInConfirmationKey, SignInRefusal } from '@/server/sign-in';
import { refusedSignIn, seeOther } from '@/server/sign-in-responses';

/**
 * The answer to "Continue as …?" — the only way a held-back sign-in becomes a
 * session (review S1; the callback's header, step 6, says when a sign-in is
 * held back and why).
 *
 * A form POST from `/sign-in/confirm`, never a link: the session it issues is
 * the whole point of the attack it defends against, so it must be something
 * only that page, in this browser, can send.
 *
 * ── What it checks, in this order ──
 *  1. The address bucket, as the callback spends it.
 *  2. **Same origin, failing closed.** `Origin` must be present and this
 *     deployment's — a browser sends it on every form POST, so its absence is a
 *     client that is not a browser on our page. `Sec-Fetch-Site`, where sent,
 *     must say `same-origin`. (The cookie is `SameSite=Lax`, which a cross-site
 *     POST does not carry either.)
 *  3. The sealed cookie: its MAC, its five minutes.
 *  4. **The form's token** against the cookie's nonce, in constant time — the
 *     CSRF check proper. The page printed the nonce into the form it served;
 *     nothing on another origin can read the page or the `HttpOnly` cookie.
 *  5. **Spend the nonce** (`sign_in_confirmations`): a second presentation of
 *     the same cookie — a double click, a replay — finds it spent and is
 *     refused, before anything is issued. Spent for "cancel" too.
 *  6. "Continue": the account still exists, then `issueSignIn` — the same step
 *     8 the callback runs for a sign-in that needed no confirmation, with the
 *     facts the callback sealed. "This isn't me": nothing is issued.
 *
 * Every answer clears the cookie and is a 303: to `next`, to `/sign-in`, or to
 * `/sign-in?error=expired` for anything that did not check out — which says
 * only that the attempt is over, never which check failed.
 */

/** A form with two short fields is well under this; anything bigger is not ours. */
const MAX_BODY_BYTES = 1024;

export const POST = publicRoute(async ({ request, services }) => {
  const cleared = [clearedSignInConfirmationCookie()];
  let next: string | null = null;

  try {
    const byAddress = await consume(
      services.env,
      'RL_LOGIN',
      attemptKey(services.meta.ipAddress, null),
    );
    if (!byAddress.allowed) throw new SignInRefusal('rate-limited', 429, 'per-address limit');

    if (!isSameOriginPost(request, publicOrigin(services.env))) {
      throw new SignInRefusal('expired', 403, 'confirmation not posted from this origin');
    }

    const cookies = parseCookies(request.headers.get('cookie'));
    const opened = await openSignInConfirmation(
      await signInConfirmationKey(services.env),
      cookies.get(SIGN_IN_CONFIRMATION_COOKIE_NAME),
      new Date(),
    );
    if (!opened.ok) throw new SignInRefusal('expired', 400, `confirmation ${opened.reason}`);
    const parked = opened.value;
    next = safeRedirectPath(parked.next, POST_SIGN_IN_PATH);

    const form = await readForm(request);
    const token = form?.get('confirmation') ?? null;
    // The length is no secret — every nonce is 43 characters — and
    // `timingSafeEqual` refuses unequal lengths before comparing anything.
    if (token === null || !timingSafeEqual(utf8Encode(token), utf8Encode(parked.nonce))) {
      throw new SignInRefusal('expired', 403, 'confirmation token did not match its cookie');
    }

    const spent = await spendSignInConfirmation(services.db, {
      nonceHash: await hashToken(parked.nonce),
      userId: parked.userId,
      expiresAt: new Date((parked.issuedAt + SIGN_IN_CONFIRMATION_TTL_SECONDS) * 1000),
    });
    if (!spent) throw new SignInRefusal('expired', 409, 'confirmation already spent');

    if (form?.get('decision') !== 'continue') {
      // Declined — or anything that did not say "continue", which is the same
      // answer. Worth a line: one is somebody signing in to the wrong account;
      // a run of them for one address is somebody being worked on.
      services.log.at('confirm').warn('A held-back sign-in was declined; nothing was issued', {
        reason: parked.reason,
        signInMethod: parked.signInMethod,
      });
      services.bindLog({ signInOutcome: 'declined', signInPurpose: parked.purpose });
      const target = new URLSearchParams();
      if (next !== POST_SIGN_IN_PATH) target.set('next', next);
      const query = target.toString();
      return seeOther(query === '' ? SIGN_IN_PATH : `${SIGN_IN_PATH}?${query}`, cleared);
    }

    const user = await findUserById(services.db, parked.userId);
    if (user === null) {
      throw new SignInRefusal('account-deleted', 403, 'confirmed account no longer exists');
    }

    const result = await issueSignIn(services, {
      user,
      outcome: parked.outcome,
      facts: { signInMethod: parked.signInMethod, ssoWorkosOrgId: parked.ssoWorkosOrgId },
      purpose: parked.purpose,
      lockOne: parked.lockOne,
      presentedSessionToken: cookies.get(SESSION_COOKIE_NAME) ?? null,
    });

    services.bindLog({ signInOutcome: result.outcome, signInPurpose: parked.purpose });
    return seeOther(next, [...result.cookies, ...cleared]);
  } catch (cause) {
    return refusedSignIn(services, cause, next, cleared);
  }
});

/**
 * Same origin for a POST, failing closed — the opposite of `isSameOrigin`,
 * which lets a missing `Origin` through for the CLI. Nothing but our own page
 * ever posts here.
 */
function isSameOriginPost(request: Request, expectedOrigin: string): boolean {
  if (request.headers.get('origin') !== expectedOrigin) return false;
  const site = request.headers.get('sec-fetch-site');
  return site === null || site === 'same-origin';
}

/** The urlencoded form, bounded, or `null` for anything that is not one. */
async function readForm(request: Request): Promise<URLSearchParams | null> {
  const type = request.headers.get('content-type') ?? '';
  if (!type.toLowerCase().startsWith('application/x-www-form-urlencoded')) return null;
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return null;
  return new URLSearchParams(body);
}

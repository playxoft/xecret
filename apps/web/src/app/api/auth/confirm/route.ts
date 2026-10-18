import {
  clearedSignInConfirmationCookie,
  hashToken,
  openSignInConfirmation,
  SESSION_COOKIE_NAME,
  SIGN_IN_CONFIRMATION_COOKIE_NAME,
  SIGN_IN_CONFIRMATION_TTL_SECONDS,
} from '@xecret/core/auth';
import type { SignInConfirmation } from '@xecret/core/auth';
import { timingSafeEqual, utf8Encode } from '@xecret/core/crypto';
import {
  findOrgByWorkosOrgId,
  findUserById,
  listOrganizationsForUser,
  spendSignInConfirmation,
} from '@xecret/db/repositories';
import { safeRedirectPath } from '@/lib/redirect-path';
import { POST_SIGN_IN_PATH, SIGN_IN_PATH } from '@/lib/session-hint';
import { publicOrigin } from '@/server/bindings';
import type { ServiceContext } from '@/server/context';
import { parseCookies } from '@/server/http';
import { describeError } from '@/server/logging';
import { attemptKey, consume } from '@/server/rate-limit';
import { publicRoute } from '@/server/route';
import {
  auditFor,
  issueSignIn,
  signInConfirmationKey,
  SignInRefusal,
  writeEvents,
} from '@/server/sign-in';
import { refusedSignIn, seeOther } from '@/server/sign-in-responses';
import { workosProvider } from '@/server/workos';
import type { WorkosIdentityProvider } from '@/server/workos';

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
 *  6. "Continue": the account still exists, then `issueSignIn` — the same
 *     just-in-time join and session the callback runs for a sign-in that
 *     needed no confirmation, with the facts the callback sealed, audited as a
 *     confirmed sign-in. "This isn't me": see {@link declined}.
 *
 * Every answer clears the cookie and is a 303: to `next` (never an API route —
 * `safeRedirectPath` again, at the moment of use), to WorkOS's logout and on to
 * `/sign-in?error=declined`, or to `/sign-in?error=expired` for anything that
 * did not check out — which says only that the attempt is over, never which
 * check failed.
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

    const provider = workosProvider(services.env);

    if (form?.get('decision') !== 'continue') {
      return declined(services, parked, provider, cleared);
    }

    const user = await findUserById(services.db, parked.userId);
    if (user === null) {
      throw new SignInRefusal('account-deleted', 403, 'confirmed account no longer exists');
    }

    // Everything that changes an organisation — the just-in-time join — runs
    // here, after "Continue", never at the callback (review round 2, L6).
    const result = await issueSignIn(services, {
      user,
      outcome: parked.outcome,
      facts: { signInMethod: parked.signInMethod, ssoWorkosOrgId: parked.ssoWorkosOrgId },
      purpose: parked.purpose,
      lockOne: parked.lockOne,
      freshAuthAt: parked.freshAuthAt,
      providerSessionId: parked.providerSessionId,
      workosClientId: provider.clientId,
      // Filed on the `auth.login` it produces, so a confirmed sign-in is
      // auditable as one.
      confirmation: parked.reason,
      presentedSessionToken: cookies.get(SESSION_COOKIE_NAME) ?? null,
    });

    services.bindLog({ signInOutcome: result.outcome, signInPurpose: parked.purpose });
    return seeOther(next, [...result.cookies, ...cleared]);
  } catch (cause) {
    return refusedSignIn(services, cause, next, cleared);
  }
});

/**
 * "This isn't me" — or anything that did not say "continue", which is the
 * same answer (review round 2, on what a decline leaves behind):
 *
 *  - **Nothing is issued**, and the session this browser already held, if
 *    any, is untouched: it is the person's own.
 *  - **Nothing was done to any organisation**: the just-in-time join waits for
 *    "Continue". What did happen before the question stays — the account and
 *    its personal organisation, if the sign-in created them (they belong to
 *    the identity that signed in), and an identity link, audited when it was
 *    made.
 *  - **The AuthKit session it came from is ended.** A planted session would
 *    otherwise answer this person's every next "Sign in" the same way, and the
 *    only way out would be to wait for it to expire. The browser goes through
 *    WorkOS's logout URL for it, and on to the sign-in page.
 *  - **It lands on `/sign-in?error=declined`, without `next`.** The flow was
 *    not the person's, so neither is its destination.
 *  - **It is audited**, `auth.sign_in_declined`, with why it was held back: in
 *    the organisation whose single sign-on it came through when that one is
 *    here — its administrators are the ones who should see their identity
 *    provider used for a sign-in somebody refused — and otherwise in the
 *    account's own. A run of them for one account is somebody being worked
 *    on.
 */
async function declined(
  services: ServiceContext,
  parked: SignInConfirmation,
  provider: WorkosIdentityProvider,
  cleared: readonly string[],
): Promise<Response> {
  services.log.at('confirm').warn('A held-back sign-in was declined; nothing was issued', {
    reason: parked.reason,
    signInMethod: parked.signInMethod,
  });
  services.bindLog({ signInOutcome: 'declined', signInPurpose: parked.purpose });

  const orgId =
    (parked.ssoWorkosOrgId === null
      ? null
      : (await findOrgByWorkosOrgId(services.db, parked.ssoWorkosOrgId, provider.clientId))?.id) ??
    (await listOrganizationsForUser(services.db, parked.userId))[0]?.organization.id ??
    null;
  if (orgId !== null) {
    services.waitUntil(
      writeEvents(services, [
        auditFor(orgId, { id: parked.userId, email: parked.email }, services).success(
          'auth.sign_in_declined',
          { type: 'user', id: parked.userId },
          { source: 'dashboard', signInMethod: parked.signInMethod, confirmation: parked.reason },
        ),
      ]),
    );
  }

  const landing = `${SIGN_IN_PATH}?${new URLSearchParams({ error: 'declined' }).toString()}`;
  if (parked.providerSessionId === null) return seeOther(landing, cleared);
  let logout: string;
  try {
    logout = provider.logoutUrl({
      sessionId: parked.providerSessionId,
      returnTo: `${publicOrigin(services.env)}${landing}`,
    });
  } catch (cause) {
    services.log
      .at('confirm')
      .error('Could not build the WorkOS logout URL for a declined sign-in; its session stays', {
        error: describeError(cause),
      });
    return seeOther(landing, cleared);
  }
  return seeOther(logout, cleared);
}

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

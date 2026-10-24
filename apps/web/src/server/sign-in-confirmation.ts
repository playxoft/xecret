import {
  generateConfirmationNonce,
  openSignInConfirmation,
  sealSignInConfirmation,
  signInConfirmationCookie,
} from '@xecret/core/auth';
import type { OAuthPurpose, SignInConfirmation, SignInConfirmationReason } from '@xecret/core/auth';
import { hasNonAsciiCharacters, inertText } from '@/lib/inert-text';
import { POST_SIGN_IN_PATH } from '@/lib/session-hint';
import type { Bindings } from './bindings';
import type { ServiceContext } from './context';
import { signInConfirmationKey } from './sign-in';
import type { PreparedSignIn } from './sign-in';

/**
 * Holding a sign-in back until the person confirms it — the server half of
 * `@xecret/core/auth`'s `sign-in-confirmation.ts`, whose header has the attack
 * (review S1, the planted AuthKit session) and the design.
 *
 * The callback calls {@link parkSignIn} instead of issuing a session when
 * `confirmationReason` says so, and redirects to {@link SIGN_IN_CONFIRM_PATH}.
 * That page reads the cookie back through {@link confirmationView} — which is
 * also what decides what it may say — and its form posts to
 * `POST /api/auth/confirm`, which spends the cookie's nonce and only then
 * issues the session.
 */

/** Where a held-back sign-in is confirmed. */
export const SIGN_IN_CONFIRM_PATH = '/sign-in/confirm';

/**
 * The longest an address or an organisation name is shown on the page, in
 * characters. An organisation name is at most 25 when it is typed, and an
 * address 320 by the standard; these bounds are for what got past either.
 */
const SHOWN_EMAIL_MAX = 120;
const SHOWN_NAME_MAX = 40;

/** Parks a prepared sign-in, answering the `Set-Cookie` value that holds it. */
export async function parkSignIn(
  services: ServiceContext,
  params: {
    prepared: PreparedSignIn;
    purpose: OAuthPurpose;
    next: string;
    flowIssuedAt: number;
    reason: SignInConfirmationReason;
  },
): Promise<string> {
  const { prepared } = params;
  // Named only for a single sign-on: that is the sign-in whose organisation is
  // the claim the person has to judge. The callback already looked it up, in
  // this deployment's WorkOS environment only, so the page needs nothing but
  // the cookie.
  const linked = prepared.ssoOrganization;

  const value: SignInConfirmation = {
    nonce: generateConfirmationNonce(),
    userId: prepared.user.id,
    email: prepared.user.email,
    signInMethod: prepared.facts.signInMethod,
    ssoWorkosOrgId: prepared.facts.ssoWorkosOrgId,
    organization: linked === null ? null : { name: linked.name, slug: linked.slug },
    purpose: params.purpose,
    next: params.next,
    flowIssuedAt: params.flowIssuedAt,
    freshAuthAt: prepared.freshAuthAt,
    lockOne: prepared.lockOne,
    outcome: prepared.outcome,
    reason: params.reason,
    providerSessionId: prepared.providerSessionId,
    joins: prepared.joins,
    issuedAt: Math.floor(Date.now() / 1000),
  };
  const key = await signInConfirmationKey(services.env);
  let sealed: string;
  try {
    sealed = await sealSignInConfirmation(key, value);
  } catch (cause) {
    if (!(cause instanceof RangeError)) throw cause;
    // Longer than a browser keeps a cookie (review round 2): only `next` can
    // make it so — the longest one, beside a long name in wide characters —
    // and a sign-in that lands on the dashboard is better than one nobody can
    // confirm.
    services.log
      .at('parkSignIn')
      .warn('A held-back sign-in was too long for its cookie; its destination was dropped', {
        nextLength: params.next.length,
      });
    sealed = await sealSignInConfirmation(key, { ...value, next: POST_SIGN_IN_PATH });
  }
  return signInConfirmationCookie(sealed);
}

/** What the confirmation page may show, read from the cookie and nothing else. */
export interface ConfirmationView {
  /**
   * The account's address, made inert for display ({@link inertText}): no
   * direction override, invisible character or tower of accents survives, and
   * it is cut to a length the page can hold.
   */
  email: string;
  /** Whether the address has characters outside printable ASCII — the page says so. */
  emailHasNonAscii: boolean;
  /** Whether an organisation's identity provider vouched for this sign-in. */
  sso: boolean;
  /**
   * How that organisation names itself here — an owner's choice, so the page
   * presents it as a claim, made inert like the address. `null` for a single
   * sign-on through an organisation not linked to any here.
   */
  organization: { name: string; slug: string } | null;
  reason: SignInConfirmationReason;
  purpose: OAuthPurpose;
  /** Whether continuing makes the account a member of that organisation. */
  joins: boolean;
  /** The form's CSRF token: the nonce, printed into the page that the cookie came to. */
  confirmation: string;
}

/**
 * Reads a confirmation cookie for the page, or `null` when there is none worth
 * showing — absent, altered, or older than five minutes. Whether it has been
 * spent is not asked here: the page only describes, and the POST is what
 * refuses a second use.
 */
export async function confirmationView(
  key: CryptoKey,
  cookie: string | undefined,
  now: Date = new Date(),
): Promise<ConfirmationView | null> {
  const opened = await openSignInConfirmation(key, cookie, now);
  if (!opened.ok) return null;
  const value = opened.value;
  return {
    email: inertText(value.email, SHOWN_EMAIL_MAX),
    emailHasNonAscii: hasNonAsciiCharacters(value.email),
    sso: value.ssoWorkosOrgId !== null,
    organization:
      value.organization === null
        ? null
        : {
            name: inertText(value.organization.name, SHOWN_NAME_MAX),
            // A slug is lower-case ASCII by the parser's own check.
            slug: value.organization.slug,
          },
    reason: value.reason,
    purpose: value.purpose,
    joins: value.joins,
    confirmation: value.nonce,
  };
}

/** {@link confirmationView}, keyed from this deployment's bindings. */
export async function readConfirmationView(
  env: Bindings,
  cookie: string | undefined,
): Promise<ConfirmationView | null> {
  try {
    return await confirmationView(await signInConfirmationKey(env), cookie);
  } catch {
    // A deployment without its cookie secret cannot have parked anything, so
    // there is nothing to confirm.
    return null;
  }
}

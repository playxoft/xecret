import {
  generateConfirmationNonce,
  openSignInConfirmation,
  sealSignInConfirmation,
  signInConfirmationCookie,
} from '@xecret/core/auth';
import type { OAuthPurpose, SignInConfirmation, SignInConfirmationReason } from '@xecret/core/auth';
import { findOrgByWorkosOrgId } from '@xecret/db/repositories';
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
  // the claim the person has to judge. Looked up here, where the database is,
  // so the page needs nothing but the cookie.
  const linked =
    prepared.facts.ssoWorkosOrgId === null
      ? null
      : await findOrgByWorkosOrgId(services.db, prepared.facts.ssoWorkosOrgId);

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
    lockOne: prepared.lockOne,
    outcome: prepared.outcome,
    reason: params.reason,
    issuedAt: Math.floor(Date.now() / 1000),
  };
  return signInConfirmationCookie(
    await sealSignInConfirmation(await signInConfirmationKey(services.env), value),
  );
}

/** What the confirmation page may show, read from the cookie and nothing else. */
export interface ConfirmationView {
  email: string;
  /** Whether an organisation's identity provider vouched for this sign-in. */
  sso: boolean;
  /**
   * How that organisation names itself here — an owner's choice, so the page
   * presents it as a claim. `null` for a single sign-on through an
   * organisation not linked to any here.
   */
  organization: { name: string; slug: string } | null;
  reason: SignInConfirmationReason;
  purpose: OAuthPurpose;
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
    email: value.email,
    sso: value.ssoWorkosOrgId !== null,
    organization: value.organization,
    reason: value.reason,
    purpose: value.purpose,
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

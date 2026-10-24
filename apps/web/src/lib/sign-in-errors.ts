/**
 * Why a sign-in failed, in the words a person reads on `/sign-in?error=…`.
 *
 * The callback cannot answer in its own body: it is a top-level navigation back
 * from the identity provider, and a JSON error on a blank page is a dead end. So
 * it redirects here with one of these codes, and the sign-in page renders the
 * sentence.
 *
 * ── The discipline these sentences keep ──
 * The same one the old sign-in forms kept: say what the person can do next, and
 * nothing an attacker could use. No message names another account, says how
 * that account signs in, or distinguishes "no such user" from "wrong
 * credential". The conflict message is the clearest case — it is shown to
 * somebody who has just proven control of a mailbox, not of the account that
 * mailbox's address already belongs to, so it says only that the address is
 * taken and where to get help.
 *
 * A code that is not in this table renders nothing at all. The parameter is in
 * the URL, so anybody can link to `/sign-in?error=whatever`; an unknown value
 * must not become text on our page.
 */

export const SIGN_IN_ERROR_MESSAGES = {
  /** The person backed out at the provider. */
  cancelled: 'Sign-in was cancelled. You can try again whenever you are ready.',
  /** The state cookie or the code was missing, expired, mismatched or already used. */
  expired: 'That sign-in attempt expired or was already used. Please sign in again.',
  'verify-email': 'Verify your email address, then sign in again.',
  'account-deleted': 'This account was deleted and cannot be signed in to again.',
  'account-conflict':
    'This email address already belongs to another xecret account. Contact support if you need help.',
  'sso-required':
    'Your organisation requires you to sign in with its single sign-on. Use your company sign-in to continue.',
  'sso-domain':
    'Your organisation’s single sign-on cannot be used for this email address. Contact your administrator.',
  'no-seat':
    'Your organisation has no free seats. Ask an administrator to make room, then sign in again.',
  /** A provider administrator tried to sign in as somebody. */
  impersonation: 'This kind of sign-in is not accepted here.',
  /**
   * "This isn't me", on a held-back sign-in. Not the person's mistake, so it
   * says what happened and what to look out for, without naming the account.
   */
  declined:
    'Nothing was signed in, and the sign-in you declined was ended. If you did not start it, ' +
    'somebody may have tried to sign you in to an account of theirs. Sign in again below, and ' +
    'check the account it shows before you store anything.',
  'rate-limited': 'Too many sign-in attempts. Wait a minute, then try again.',
  unavailable: 'Sign-in is temporarily unavailable. Please try again shortly.',
  failed: 'Sign-in failed. Please try again.',
} as const;

export type SignInErrorCode = keyof typeof SIGN_IN_ERROR_MESSAGES;

/** The sentence for a code taken from a URL, or `null` for anything not in the table. */
export function signInErrorMessage(code: string | null | undefined): string | null {
  if (typeof code !== 'string') return null;
  return Object.hasOwn(SIGN_IN_ERROR_MESSAGES, code)
    ? SIGN_IN_ERROR_MESSAGES[code as SignInErrorCode]
    : null;
}

/**
 * Why a sign-in failed, in the words a person reads on `/sign-in?error=…` —
 * and, for a sign-in made on the page itself, in the answer its form shows.
 *
 * The callback cannot answer in its own body: it is a top-level navigation back
 * from the identity provider, and a JSON error on a blank page is a dead end. So
 * it redirects here with one of these codes, and the sign-in page renders the
 * sentence. The in-app sign-in routes (`server/in-app-sign-in.ts`) answer JSON
 * to the page's own form, and put the same sentence in it, so a refusal reads
 * the same whichever way the person came in.
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
  /**
   * "Sign in with single sign-on" was given an organisation address that does
   * not sign in that way here — or one that is not an address at all, or the
   * address has looked up too many. One sentence for all of them: telling them
   * apart would say which organisations exist.
   */
  'sso-not-found':
    'That organisation doesn’t sign in with single sign-on here, or its address is mistyped. Check it with your administrator, or sign in another way.',
  /**
   * WorkOS wants the account's authenticator app, which this sign-in page does
   * not ask for yet (multi-factor is off for every account today).
   */
  'authenticator-required':
    'This account signs in with an authenticator app, which this page can’t ask for yet. Contact support and we’ll help you sign in.',
  /** A bot-protection check WorkOS asked for, which this page cannot show. */
  'extra-check':
    'The sign-in service asked for an extra check this page can’t show yet. Wait a few minutes and try again, or continue with Google.',
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

/**
 * What the sign-in, sign-up and password-reset forms say beside the field a
 * person got wrong, or above a form whose link has run out. Not in the table
 * above, because no redirect ever carries them: they answer something typed on
 * the page, and are shown on the page.
 *
 * None says whether the address has an account. "Wrong password" and "no
 * such account" are one answer from WorkOS, and one sentence here; a weak
 * password is only ever reported to somebody who has just proven the inbox
 * (the sign-up's code, the reset's link), and a reset link that will not work
 * is one sentence whether WorkOS never issued it or it expired.
 */
export const SIGN_IN_FORM_MESSAGES = {
  'wrong-password':
    'That email and password don’t match. Try again, or reset your password if you’ve forgotten it.',
  'wrong-code': 'That code isn’t right, or it has expired. Check the email, or send a new code.',
  'weak-password':
    'That password is too easy to guess. Choose a longer one — a few unrelated words work well.',
  'reset-link-invalid':
    'That reset link has expired or has already been used. Ask for a new one below.',
} as const;

/** The sentence for a code taken from a URL, or `null` for anything not in the table. */
export function signInErrorMessage(code: string | null | undefined): string | null {
  if (typeof code !== 'string') return null;
  return Object.hasOwn(SIGN_IN_ERROR_MESSAGES, code)
    ? SIGN_IN_ERROR_MESSAGES[code as SignInErrorCode]
    : null;
}

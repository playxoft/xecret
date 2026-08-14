import { fromBase64Url, randomBytes, timingSafeEqual, toBase64Url } from '../crypto/encoding';
import type { Bytes } from '../crypto/types';

/**
 * Opaque bearer tokens: session cookies, CLI tokens, service tokens, and
 * invitation tokens.
 *
 * Every token in xecret follows the same three rules:
 *
 *  1. **256 bits of entropy.** Enough that guessing is not a threat model.
 *  2. **Only the SHA-256 hash is stored.** A database dump yields hashes, not
 *     usable credentials (threat T6). This is the same reasoning as password
 *     hashing, minus the need for a slow KDF — a 256-bit random value has no
 *     structure to attack, so a fast digest is sufficient and lets the hot
 *     lookup path stay a single indexed query.
 *  3. **A human-readable prefix.** `xct_live_a1b2…` lets a leaked token be
 *     recognised in a log or a GitHub secret scan, and lets the UI identify a
 *     token without storing anything usable.
 */

/** 256 bits. */
const TOKEN_BYTES = 32;

/**
 * Distinguishes token classes so one can never be presented as another, and so
 * secret scanners can pattern-match them.
 */
export const TOKEN_PREFIXES = {
  session: 'xes',
  cli: 'xct',
  service: 'xst',
  invitation: 'xin',
  /**
   * A PIN reset link, emailed to the account's own address.
   *
   * Deliberately the same 256-bit shape as every other token rather than the
   * six-digit code an "enter the code we sent you" flow would use. A code has to
   * be short enough to retype, which puts its entire security in an attempt
   * counter; this arrives as a link nobody types, so it can simply be
   * unguessable and the counter becomes a formality.
   */
  pinReset: 'xpr',
  /**
   * A CLI authorization code — the one-time value the consent screen hands to
   * the loopback listener during `xecret login`.
   *
   * Not a credential: exchanging it additionally requires the PKCE verifier
   * that never left the CLI process, and the exchange consumes it. It shares
   * the 256-bit token shape so the same hashing, storage and well-formedness
   * machinery applies, and so a code pasted somewhere it should not be is
   * recognisable to a secret scanner like every other xecret token.
   */
  cliAuthCode: 'xac',
} as const;

export type TokenKind = keyof typeof TOKEN_PREFIXES;

export interface GeneratedToken {
  /** The full token. Shown to the user exactly once, then never recoverable. */
  token: string;
  /** SHA-256 of the token. This is what gets stored. */
  hash: Bytes;
  /** Non-sensitive fragment for display, e.g. `xct_live_a1b2`. */
  prefix: string;
}

/**
 * Generates a token of the given kind.
 *
 * `environment` appears in the token so a staging credential pasted into
 * production is recognisable at a glance rather than merely failing.
 */
export async function generateToken(
  kind: TokenKind,
  environment: 'live' | 'test' = 'live',
): Promise<GeneratedToken> {
  const secret = toBase64Url(randomBytes(TOKEN_BYTES));
  const token = `${TOKEN_PREFIXES[kind]}_${environment}_${secret}`;

  return { token, hash: await hashToken(token), prefix: token.slice(0, 12) };
}

/** SHA-256 of a token, as stored in a `token_hash` column. */
export async function hashToken(token: string): Promise<Bytes> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return new Uint8Array(digest);
}

/**
 * Constant-time comparison of a presented token against a stored hash.
 *
 * The database lookup is by hash and therefore already constant-ish, but any
 * secondary comparison must not short-circuit. Using `===` on hashes leaks, via
 * timing, how many leading bytes matched.
 */
export async function verifyToken(presented: string, storedHash: Bytes): Promise<boolean> {
  return timingSafeEqual(await hashToken(presented), storedHash);
}

/**
 * Cheap structural check before touching the database.
 *
 * Rejects obvious junk — a truncated paste, a URL, an unrelated string — without
 * spending a query or a digest on it. This is a performance and abuse guard, not
 * a security control: a well-formed token still proves nothing until its hash
 * matches a stored row.
 */
export function isWellFormedToken(token: string, kind?: TokenKind): boolean {
  // Split on the FIRST TWO underscores only. The base64url alphabet includes
  // `_`, so `token.split('_')` would break roughly half of all valid tokens —
  // whichever ones happen to contain an underscore in their random segment.
  const firstSeparator = token.indexOf('_');
  if (firstSeparator === -1) return false;

  const secondSeparator = token.indexOf('_', firstSeparator + 1);
  if (secondSeparator === -1) return false;

  const prefix = token.slice(0, firstSeparator);
  const environment = token.slice(firstSeparator + 1, secondSeparator);
  const secret = token.slice(secondSeparator + 1);

  const expectedPrefixes: string[] = kind ? [TOKEN_PREFIXES[kind]] : Object.values(TOKEN_PREFIXES);

  if (!expectedPrefixes.includes(prefix)) return false;
  if (environment !== 'live' && environment !== 'test') return false;

  try {
    return fromBase64Url(secret).length === TOKEN_BYTES;
  } catch {
    return false;
  }
}

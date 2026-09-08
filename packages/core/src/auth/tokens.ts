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

/** Unpadded base64url of 32 bytes. Every token secret is exactly this long. */
const TOKEN_SECRET_CHARS = 43;

/**
 * The separator between a service token's two halves (spec §13.1).
 *
 * `k` is a member of the base64url alphabet, so both halves routinely contain
 * one and `indexOf('k')` finds the wrong separator roughly half the time. It is
 * safe only because it is read at a **fixed offset**, never searched for — see
 * {@link splitServiceToken}, which is the only thing in this codebase that may
 * take a service token apart.
 *
 * A third `_` would have been ambiguous for the same reason and would also have
 * changed how {@link isWellFormedToken} parses every other token kind, which
 * splits on the first two underscores.
 */
const SERVICE_KEY_SEPARATOR = 'k';

/** Auth half, separator, key half. */
const SERVICE_TOKEN_SECRET_CHARS = TOKEN_SECRET_CHARS + 1 + TOKEN_SECRET_CHARS;

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
  const parts = splitTokenString(token);
  if (parts === null) return false;

  const expectedPrefixes: string[] = kind ? [TOKEN_PREFIXES[kind]] : Object.values(TOKEN_PREFIXES);
  if (!expectedPrefixes.includes(parts.prefix)) return false;

  // A service token may carry a second half — its X25519 private scalar (spec
  // §13.1). Both shapes are well-formed: the two-half form is what the browser
  // hands a CI runner for an `e2ee` environment, and the single-half form is
  // every token minted before Phase 4 and every token for a `server`-mode
  // environment. Accepting only one of them would either refuse the new tokens
  // or revoke every old one.
  //
  // Well-formed is not the same as presentable. Only the auth half is ever sent
  // to a server, and `resolveServiceToken` refuses a two-half token in an
  // `Authorization` header for that reason.
  if (parts.prefix === TOKEN_PREFIXES.service) return splitServiceToken(token) !== null;

  return isThirtyTwoBytes(parts.secret);
}

/** The prefix, environment, and secret segments, or null for anything else. */
function splitTokenString(
  token: string,
): { prefix: string; environment: string; secret: string } | null {
  // Split on the FIRST TWO underscores only. The base64url alphabet includes
  // `_`, so `token.split('_')` would break roughly half of all valid tokens —
  // whichever ones happen to contain an underscore in their random segment.
  const firstSeparator = token.indexOf('_');
  if (firstSeparator === -1) return null;

  const secondSeparator = token.indexOf('_', firstSeparator + 1);
  if (secondSeparator === -1) return null;

  const environment = token.slice(firstSeparator + 1, secondSeparator);
  if (environment !== 'live' && environment !== 'test') return null;

  return {
    prefix: token.slice(0, firstSeparator),
    environment,
    secret: token.slice(secondSeparator + 1),
  };
}

/** Whether a secret segment decodes to exactly 32 bytes of base64url. */
function isThirtyTwoBytes(segment: string): boolean {
  if (segment.length !== TOKEN_SECRET_CHARS) return false;
  try {
    return fromBase64Url(segment).length === TOKEN_BYTES;
  } catch {
    return false;
  }
}

/**
 * A service token taken apart (spec §13.1).
 *
 * The two halves are independent 32-byte CSPRNG values, and which one goes where
 * is the whole design:
 *
 *  - `authToken` is the complete transmittable credential, prefix and all. It is
 *    what goes in an `Authorization: Bearer` header and what the server hashes.
 *  - `keyHalf` is the token's X25519 private scalar. It **never leaves the
 *    client**: never transmitted, never logged, never written down by the
 *    server. A caller that puts the full token in a header has handed the server
 *    every secret in the environment.
 */
export interface ServiceTokenParts {
  /** `xst_<env>_<43 chars>` — the half that authenticates, and only that half. */
  authToken: string;
  /** The 43-character base64url key half, or null for a legacy single-half token. */
  keyHalf: string | null;
}

/**
 * Splits a service token into the half that travels and the half that must not.
 *
 * Reads the separator at a fixed offset rather than searching for it, because
 * `k` is in the base64url alphabet and appears inside both halves about half the
 * time. Returns null for anything that is not a service token of either shape;
 * a caller that gets null must not fall back to treating the input as an
 * `authToken`, or a mangled two-half token would be sent whole.
 */
export function splitServiceToken(token: string): ServiceTokenParts | null {
  const parts = splitTokenString(token);
  if (parts === null || parts.prefix !== TOKEN_PREFIXES.service) return null;

  const head = `${parts.prefix}_${parts.environment}_`;

  if (isThirtyTwoBytes(parts.secret)) {
    return { authToken: token, keyHalf: null };
  }

  if (parts.secret.length !== SERVICE_TOKEN_SECRET_CHARS) return null;
  if (parts.secret[TOKEN_SECRET_CHARS] !== SERVICE_KEY_SEPARATOR) return null;

  const authHalf = parts.secret.slice(0, TOKEN_SECRET_CHARS);
  const keyHalf = parts.secret.slice(TOKEN_SECRET_CHARS + 1);

  if (!isThirtyTwoBytes(authHalf) || !isThirtyTwoBytes(keyHalf)) return null;

  return { authToken: head + authHalf, keyHalf };
}

/**
 * Assembles the string a service token's owner is shown exactly once.
 *
 * The two halves are minted by different parties on purpose. The **server**
 * mints `authToken`, because a client-chosen credential is a credential with
 * client-chosen entropy, and it stores only that half's digest. The **browser**
 * mints `keyHalf` and derives the public key it uploads, because a server that
 * generated the key half would hold every environment key sealed to it — which
 * is the whole of ADR 0009. This function is where the two meet, and it runs in
 * the browser.
 */
export function joinServiceToken(authToken: string, keyHalf: string): string {
  const parts = splitTokenString(authToken);
  if (
    parts === null ||
    parts.prefix !== TOKEN_PREFIXES.service ||
    !isThirtyTwoBytes(parts.secret)
  ) {
    throw new TypeError('Not a single-half service token');
  }
  if (!isThirtyTwoBytes(keyHalf)) {
    throw new TypeError('A service token key half is 32 bytes, base64url encoded');
  }
  return authToken + SERVICE_KEY_SEPARATOR + keyHalf;
}

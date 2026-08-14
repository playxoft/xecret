import { timingSafeEqual, toBase64Url } from '../crypto/encoding';

/**
 * PKCE (RFC 7636) for the CLI login flow.
 *
 * `xecret login` is an OAuth-style loopback flow: the CLI opens a browser to
 * the consent screen, the screen mints a one-time authorization code, and the
 * browser hands it back to a listener on `127.0.0.1`. The code travels through
 * the browser — through its history, possibly through an extension — so the
 * code alone must not be enough to mint a credential. PKCE is what binds it to
 * the process that started the flow: the CLI keeps a random `code_verifier` in
 * memory and sends only its SHA-256 (`code_challenge`) with the authorization
 * request. At exchange time it presents the verifier, and only the process
 * that generated it can.
 *
 * Only the `S256` method exists here. RFC 7636 permits `plain` for clients
 * that cannot compute a digest; a Go binary is not such a client, and offering
 * the downgrade would be a knob whose only setting is "weaker".
 */

/**
 * What a `code_verifier` must look like: RFC 7636 §4.1's unreserved characters,
 * 43 to 128 of them. Checked before any digest is computed so junk is refused
 * on shape rather than on a failed comparison.
 */
export const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

/**
 * What an `S256` challenge must look like: base64url of a SHA-256 digest —
 * exactly 43 characters, no padding. Anything else was not produced by the
 * method this flow supports.
 */
export const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** How long an authorization code may sit unexchanged. */
export const CLI_AUTH_CODE_TTL_MS = 10 * 60 * 1000;

export function cliAuthCodeExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + CLI_AUTH_CODE_TTL_MS);
}

/** `BASE64URL(SHA256(verifier))` — RFC 7636 §4.2. */
export async function computePkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

/**
 * Whether a presented verifier matches a stored challenge.
 *
 * A malformed verifier or challenge is `false`, not an exception: both arrive
 * from outside — the verifier from the exchange request, the challenge from a
 * row the consent screen wrote — and a security predicate fails closed on bad
 * input rather than asking its caller to remember a try/catch.
 *
 * The comparison is constant-time. The challenge is not a secret in the way a
 * token hash is, but the comparison is on the critical path of an exchange an
 * attacker can drive, and `===` leaking match length costs more to reason
 * about than `timingSafeEqual` costs to run.
 */
export async function verifyPkce(challenge: string, verifier: string): Promise<boolean> {
  if (!PKCE_VERIFIER_PATTERN.test(verifier)) return false;
  if (!PKCE_CHALLENGE_PATTERN.test(challenge)) return false;

  const expected = await computePkceChallenge(verifier);
  return timingSafeEqual(new TextEncoder().encode(expected), new TextEncoder().encode(challenge));
}

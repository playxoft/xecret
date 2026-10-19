import {
  fromBase64Url,
  randomBytes,
  timingSafeEqual,
  toBase64Url,
  utf8Decode,
  utf8Encode,
} from '../crypto/encoding';
import { PKCE_VERIFIER_PATTERN } from './pkce';

/**
 * The signed cookie that carries a sign-in across the trip to the identity
 * provider and back.
 *
 * ── What it defends ──
 * `GET /api/auth/callback` is a top-level navigation from the provider's domain,
 * so the double-submit CSRF token cannot apply to it — there is no page of ours
 * to have read it. What stops an attacker from completing *their* sign-in in
 * *your* browser (login CSRF: you end up working in the attacker's account, and
 * whatever you store there is theirs) is the OAuth `state` parameter, bound to
 * the browser that started the flow. The binding is this cookie: the login route
 * sets it beside the redirect, and the callback refuses any `state` that does not
 * match the one the cookie carries.
 *
 * It also carries what the callback must not take from the query string: where
 * to go afterwards (`next`, validated before it was ever written here), the PKCE
 * verifier for the code exchange, whether this sign-in was a forced
 * re-authentication, and **which WorkOS organisation the flow asked for**, if
 * any.
 *
 * ── What `state` does not cover ──
 * `state` proves the callback is completing a flow *this browser started*. It
 * says nothing about *whose* authentication comes back. AuthKit reuses a
 * session it already holds without asking, so an attacker who first plants
 * their own AuthKit session in the victim's browser — by sending it to
 * AuthKit's authorize URL for an organisation whose identity provider they
 * control, or through that provider's IdP-initiated sign-in — gets the victim's
 * next ordinary "Sign in" answered with the attacker's identity, against the
 * victim's own valid state and PKCE. `organizationId` is what lets the callback
 * notice: a flow that asked for no organisation (or a different one) coming back
 * through an organisation's single sign-on is parked behind a confirmation the
 * person must answer (`server/sign-in.ts`, `sign-in-confirmation.ts`).
 *
 * ── Why signed, and why not encrypted ──
 * Signed so that nothing in it can be changed in transit — a `next` rewritten to
 * another path, a `purpose` promoted to `reauth` — and so that the server needs
 * no table of pending sign-ins. Not encrypted, because nothing in it is secret
 * from the browser holding it: the state value and the PKCE verifier exist to
 * bind the flow to *this* browser, and this browser is who sees them. The cookie
 * is `HttpOnly` regardless, so page script cannot read it either.
 *
 * ── The key ──
 * Derived with HKDF from `WORKOS_COOKIE_PASSWORD`, under a label naming this one
 * use. The derivation is what lets the same operator secret back a second cookie
 * later without the two being able to vouch for each other: a MAC minted for one
 * label verifies under no other.
 */

/**
 * `__Host-`, so a subdomain cannot plant or overwrite it — see
 * `SESSION_COOKIE_NAME` for what the prefix guarantees.
 */
export const OAUTH_STATE_COOKIE_NAME = '__Host-xecret_oauth_state';

/**
 * How long a sign-in may take, from leaving for the provider to coming back.
 *
 * Ten minutes, matching the lifetime of the authorization code the provider
 * hands back: a state that outlived its code could only ever be presented with a
 * code that will be refused, and a shorter one would cut off somebody who
 * stopped to find their password manager.
 */
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

/** Tolerated clock difference on `issuedAt`, mirroring the session verifier's. */
const CLOCK_SKEW_SECONDS = 10;

/**
 * The shortest operator secret accepted as key material.
 *
 * 32 characters is the floor AuthKit's own tooling sets for this same variable,
 * and a randomly generated one (which is what Phase.dev produced) clears it with
 * room to spare. A shorter value is refused at startup of the flow rather than
 * used, because a guessable MAC key turns this cookie into one an attacker can
 * mint.
 */
export const MIN_STATE_SECRET_LENGTH = 32;

/** The longest `next` a state cookie will carry; browsers cap a cookie at 4 KB. */
export const MAX_NEXT_LENGTH = 2048;

const VERSION = 'v1';

/** What HKDF is told this key is for. Changing it invalidates every cookie in flight. */
const KEY_LABEL = 'xecret/oauth-state/v1';

/** Why this sign-in was started. */
export type OAuthPurpose =
  /** An ordinary sign-in or sign-up. */
  | 'sign-in'
  /**
   * A forced re-authentication: the provider was asked to make the person prove
   * themselves again even if it still holds a session for them. The vault reset
   * is the one consumer.
   */
  | 'reauth';

export interface OAuthState {
  /** The random value sent to the provider as `state` and checked on return. */
  state: string;
  /** The PKCE `code_verifier` for this flow's authorization code. */
  verifier: string;
  /** A same-origin path, validated before it was written here. */
  next: string;
  purpose: OAuthPurpose;
  /** Seconds since the epoch. */
  issuedAt: number;
  /**
   * The WorkOS organisation this flow asked AuthKit for — an SSO deep link —
   * or `null` for an ordinary sign-in. Compared by the callback with the
   * organisation the authentication actually came back through; see the
   * module header for why that comparison exists. A cookie written before this
   * field existed reads as `null`, which is the strict answer: any organisation
   * coming back is then one the flow did not ask for.
   */
  organizationId: string | null;
}

/** The shape of a WorkOS organisation id: `org_` and an alphanumeric (ULID) tail. */
export const WORKOS_ORGANIZATION_ID_PATTERN = /^org_[0-9A-Za-z]+$/;

export type OAuthStateRejection =
  /** No cookie at all — a callback this browser never started, or one already used. */
  | 'missing'
  /** Not something this module wrote. */
  | 'malformed'
  /** Written by something without the key, or altered since. */
  | 'signature'
  | 'expired'
  /** Issued in the future: a clock nobody should be signing anybody in on the word of. */
  | 'future'
  /** A real cookie, presented with somebody else's `state`. */
  | 'mismatch';

export type OAuthStateResult =
  { ok: true; value: OAuthState } | { ok: false; reason: OAuthStateRejection };

/** A fresh `state` and PKCE verifier: 256 bits each, base64url. */
export function generateOAuthSecrets(): { state: string; verifier: string } {
  return { state: toBase64Url(randomBytes(32)), verifier: toBase64Url(randomBytes(32)) };
}

/**
 * Derives the MAC key from the operator secret.
 *
 * Throws on a secret too short to be key material. The caller maps that to a
 * configuration failure — a 503, not a sign-in that quietly works with a weak
 * key.
 */
export async function deriveOAuthStateKey(secret: string): Promise<CryptoKey> {
  return deriveCookieKey(secret, KEY_LABEL);
}

/**
 * An HMAC key for one signed cookie, derived from the operator secret under a
 * label naming that cookie. Two labels give two keys that cannot vouch for
 * each other's cookies — the property the header above promised for "a second
 * cookie later", which the sign-in confirmation (`sign-in-confirmation.ts`) is.
 *
 * @internal Exported for that module; anything else wanting a key derives it
 * through a function that fixes its own label.
 */
export async function deriveCookieKey(secret: string, label: string): Promise<CryptoKey> {
  if (typeof secret !== 'string' || secret.length < MIN_STATE_SECRET_LENGTH) {
    throw new RangeError(
      `The state-cookie secret must be at least ${MIN_STATE_SECRET_LENGTH} characters.`,
    );
  }

  const material = await crypto.subtle.importKey('raw', utf8Encode(secret), 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: utf8Encode(label) },
    material,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
}

/** `v1.<payload>.<mac>`, every part base64url. */
export async function sealOAuthState(key: CryptoKey, value: OAuthState): Promise<string> {
  const payload = toBase64Url(
    utf8Encode(
      JSON.stringify({
        s: value.state,
        v: value.verifier,
        n: value.next,
        p: value.purpose,
        t: value.issuedAt,
        o: value.organizationId,
      }),
    ),
  );
  const mac = await crypto.subtle.sign('HMAC', key, utf8Encode(`${VERSION}.${payload}`));
  return `${VERSION}.${payload}.${toBase64Url(new Uint8Array(mac))}`;
}

/**
 * Verifies a state cookie against the `state` the provider sent back.
 *
 * The order is the point: the MAC is checked before anything inside the cookie
 * is parsed, so nothing an attacker wrote is ever interpreted; then freshness;
 * then the match against the query string, in constant time. Each refusal has
 * its own reason for the log, and the caller tells the person only that the
 * attempt expired.
 */
export async function openOAuthState(
  key: CryptoKey,
  cookie: string | null | undefined,
  presentedState: string | null | undefined,
  now: Date,
): Promise<OAuthStateResult> {
  if (cookie === null || cookie === undefined || cookie === '') {
    return { ok: false, reason: 'missing' };
  }

  // Bounded before any decoding: a cookie is attacker-supplied input.
  if (cookie.length > 4096) return { ok: false, reason: 'malformed' };

  const parts = cookie.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return { ok: false, reason: 'malformed' };
  const [, payload = '', mac = ''] = parts;

  let macBytes: Uint8Array<ArrayBuffer>;
  try {
    // Copied into a fresh buffer: Web Crypto's `BufferSource` will not take a
    // view that might sit on a shared one.
    macBytes = new Uint8Array(fromBase64Url(mac));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (macBytes.length !== 32) return { ok: false, reason: 'malformed' };

  // `verify` rather than sign-and-compare: Web Crypto's comparison is the
  // constant-time one, and there is no second code path to get wrong.
  const authentic = await crypto.subtle.verify(
    'HMAC',
    key,
    macBytes,
    utf8Encode(`${VERSION}.${payload}`),
  );
  if (!authentic) return { ok: false, reason: 'signature' };

  const value = parsePayload(payload);
  if (value === null) return { ok: false, reason: 'malformed' };

  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (value.issuedAt > nowSeconds + CLOCK_SKEW_SECONDS) return { ok: false, reason: 'future' };
  if (nowSeconds - value.issuedAt > OAUTH_STATE_TTL_SECONDS) {
    return { ok: false, reason: 'expired' };
  }

  if (
    typeof presentedState !== 'string' ||
    presentedState.length === 0 ||
    !timingSafeEqual(utf8Encode(presentedState), utf8Encode(value.state))
  ) {
    return { ok: false, reason: 'mismatch' };
  }

  return { ok: true, value };
}

/**
 * The `Set-Cookie` value. `SameSite=Lax`, not `Strict`: the callback is a
 * cross-site top-level navigation from the provider's domain, which `Strict`
 * would strip the cookie from — and `Lax` still keeps it off every cross-site
 * subrequest and POST.
 */
export function oauthStateCookie(value: string): string {
  return [
    `${OAUTH_STATE_COOKIE_NAME}=${value}`,
    'Path=/',
    `Max-Age=${OAUTH_STATE_TTL_SECONDS}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

/** Clears it. Sent on every callback response, so a state is used at most once per browser. */
export function clearedOAuthStateCookie(): string {
  return [
    `${OAUTH_STATE_COOKIE_NAME}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * The shape the login route validated `next` to before sealing it: one leading
 * slash and never two (`//host` is protocol-relative), no backslash, no control
 * character. A key holder could mint anything, so a sealed cookie is not taken
 * at its word even here; the callback checks `next` once more before using it.
 *
 * @internal Shared with the sign-in confirmation cookie, which carries the same
 * `next` on to the moment the session is issued.
 */
export function isSealableNext(n: unknown): n is string {
  return (
    typeof n === 'string' &&
    n.length > 0 &&
    n.length <= MAX_NEXT_LENGTH &&
    n.startsWith('/') &&
    !n.startsWith('//') &&
    // eslint-disable-next-line no-control-regex -- control characters are the subject of the check.
    !/[\u0000-\u001f\u007f\\]/.test(n)
  );
}

/**
 * Reads the payload back into an `OAuthState`, or `null`.
 *
 * Runs only on a payload whose MAC verified, so this is not a defence against an
 * attacker — it is a defence against this module's own past, a cookie written by
 * a version whose shape this one no longer reads. Every field is checked anyway,
 * because "the MAC was fine" is not the same statement as "this is a value the
 * callback can act on".
 */
function parsePayload(payload: string): OAuthState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decode(fromBase64Url(payload)));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const { s, v, n, p, t, o } = record;

  if (typeof s !== 'string' || !STATE_PATTERN.test(s)) return null;
  if (typeof v !== 'string' || !PKCE_VERIFIER_PATTERN.test(v)) return null;
  if (!isSealableNext(n)) return null;
  if (p !== 'sign-in' && p !== 'reauth') return null;
  if (typeof t !== 'number' || !Number.isSafeInteger(t)) return null;
  // Absent on a cookie sealed before the field existed, and read as `null` —
  // the strict reading. Present, it is `null` or an organisation id, nothing
  // else.
  let organizationId: string | null = null;
  if (o !== undefined && o !== null) {
    if (typeof o !== 'string' || o.length > 64 || !WORKOS_ORGANIZATION_ID_PATTERN.test(o)) {
      return null;
    }
    organizationId = o;
  }

  return { state: s, verifier: v, next: n, purpose: p, issuedAt: t, organizationId };
}

import type { SignInMethod } from '../audit/types';
import {
  fromBase64Url,
  randomBytes,
  toBase64Url,
  utf8Decode,
  utf8Encode,
} from '../crypto/encoding';
import { SLUG_MAX_LENGTH, SLUG_PATTERN } from '../validation/slug';
import { deriveCookieKey, isSealableNext, WORKOS_ORGANIZATION_ID_PATTERN } from './oauth-state';
import type { OAuthPurpose } from './oauth-state';

/**
 * The sealed cookie that holds a sign-in back until the person confirms it.
 *
 * ── Why a sign-in is ever held back ──
 * The OAuth `state` and PKCE prove the callback is completing a flow this
 * browser started. They do not prove whose authentication came back: AuthKit
 * reuses a session it already holds without asking anything, and an attacker
 * can plant one — their own — by sending the victim's browser to AuthKit for an
 * organisation whose identity provider they control (or through that
 * provider's IdP-initiated sign-in). The victim's next ordinary "Sign in" is
 * then answered, silently, with the attacker's identity, against the victim's
 * own valid state; and whatever the victim stores next is the attacker's.
 *
 * So when a sign-in comes back through an organisation the flow did not ask for
 * (`reason: 'organization'`), through the single sign-on of an organisation the
 * account is not a member of even when the flow asked for it (`'not-member'`,
 * review round 2), or from an authentication that predates the flow — a
 * session reused without asking, for an account other than the browser's last
 * (`'reused-session'`) — the callback issues no session. It parks the outcome
 * here and sends the browser to `/sign-in/confirm`, which names the account
 * and the organisation as what it is: a name its owner chose. Only a
 * same-origin, CSRF-checked POST from that page issues the session.
 *
 * ── Lengths and encoding ──
 * Every field is bounded when it is read back, and the whole is bounded when it
 * is sealed: {@link sealSignInConfirmation} refuses to hand out a value longer
 * than a browser keeps a cookie, because a dropped cookie is a sign-in nobody
 * can confirm with nothing on the page to say why. The address and the
 * organisation's name are somebody else's strings — refused here only for C0
 * controls, and made inert for display by the page (`lib/inert-text.ts` in the
 * web app), which is where a direction override or an invisible character
 * would do its harm.
 *
 * ── What is parked, and what is not ──
 * Not the WorkOS identity: `workosIdentity()` mints only from WorkOS's own
 * response, and a cookie a browser sent back is not that. The callback has
 * already linked the account by then; what is parked is the *result* — the
 * account id, how the person signed in, where to go — which is all issuing a
 * session needs.
 *
 * ── Sealed, short-lived, single-use ──
 * HMAC-signed under its own HKDF label (so neither cookie can stand in for the
 * other), `HttpOnly`, five minutes. Not encrypted: nothing in it is secret from
 * the browser it was handed to — the address is shown on the very page that
 * reads it. Single-use is the server's job, not the cookie's: the random
 * `nonce` is spent in `sign_in_confirmations` (migration 0022) before anything
 * is issued, so the same cookie presented twice issues at most once. The nonce
 * doubles as the confirmation form's CSRF token: the page prints it into the
 * form it serves, and a page on another site can read neither.
 */

/** `__Host-`, so a subdomain cannot plant or overwrite it. */
export const SIGN_IN_CONFIRMATION_COOKIE_NAME = '__Host-xecret_sign_in_confirm';

/** How long a person has to answer "Continue as …?". Five minutes, at most. */
export const SIGN_IN_CONFIRMATION_TTL_SECONDS = 5 * 60;

const VERSION = 'c1';
const KEY_LABEL = 'xecret/sign-in-confirmation/v1';
const CLOCK_SKEW_SECONDS = 10;
const MAX_COOKIE_LENGTH = 4096;

/**
 * The longest sealed value {@link sealSignInConfirmation} hands out. A browser
 * keeps a cookie's name and value within 4,096 bytes and silently drops one
 * that is longer — which here would be a sign-in nobody can confirm, with
 * nothing on the page to say why. The cookie's name and `=` take 30 of those,
 * and every character of a sealed value is base64url, one byte each.
 */
export const MAX_SEALED_CONFIRMATION_LENGTH = 4096 - `${SIGN_IN_CONFIRMATION_COOKIE_NAME}=`.length;

/** Why a sign-in was held back for confirmation. */
export type SignInConfirmationReason =
  /** It came back through an organisation the flow did not ask for. */
  | 'organization'
  /**
   * It came back through the organisation the flow asked for, but by that
   * organisation's single sign-on, and the account is not a member of it yet
   * (review round 2): the deep link may have been somebody else's, and
   * continuing is what would make the account a member.
   */
  | 'not-member'
  /** WorkOS answered from an authentication that predates the flow — a reused session. */
  | 'reused-session';

const REASONS: ReadonlySet<string> = new Set<SignInConfirmationReason>([
  'organization',
  'not-member',
  'reused-session',
]);

/** How the vault reset's first lock judged a `reauth` sign-in, decided at the callback. */
export type ParkedLockOne = 'armed' | 'method' | 'no-auth-time' | 'stale';

export interface SignInConfirmation {
  /** 256 random bits, base64url — the single-use key and the form's CSRF token. */
  nonce: string;
  /** The xecret account the sign-in resolved to. */
  userId: string;
  /** Its address, shown on the confirmation page. */
  email: string;
  signInMethod: SignInMethod;
  /** The WorkOS organisation whose single sign-on this was, or `null`. */
  ssoWorkosOrgId: string | null;
  /**
   * How the organisation the sign-in came back through names itself here —
   * chosen by whoever owns it, so the page shows it as a claim, never as fact.
   * `null` when it named no organisation, or one not linked to any here.
   */
  organization: { name: string; slug: string } | null;
  purpose: OAuthPurpose;
  /** A same-origin path, validated before it was first sealed. */
  next: string;
  /** When the flow began (the state cookie's `issuedAt`), seconds since the epoch. */
  flowIssuedAt: number;
  /**
   * For a re-authentication in which the person actively authenticated during
   * the flow, by a method that re-proves who they are, when they did (WorkOS's
   * `auth_time`, seconds since the epoch); `null` otherwise. What the records a
   * re-authentication leaves — the setup portal's step-up, the vault reset's
   * first lock — are dated by: the authentication, not the moment it was
   * confirmed, up to five minutes later.
   */
  freshAuthAt: number | null;
  /** For a `reauth`, what the callback decided about lock one; `null` otherwise. */
  lockOne: ParkedLockOne | null;
  outcome: 'matched' | 'linked' | 'created';
  reason: SignInConfirmationReason;
  /**
   * The AuthKit session the sign-in came from (WorkOS's `sid`), or `null` —
   * so the session issued on "Continue" can end it at sign-out, and "This
   * isn't me" can end it at once: a planted AuthKit session would otherwise
   * answer the person's every next sign-in the same way.
   */
  providerSessionId: string | null;
  /**
   * Whether continuing would make the account a member of the organisation
   * whose single sign-on this was (its just-in-time opt-in) — said on the page,
   * because it is a consequence the person should weigh. The join itself is
   * decided again, under the organisation's lock, only once they continue.
   */
  joins: boolean;
  /** Seconds since the epoch. */
  issuedAt: number;
}

export type SignInConfirmationRejection =
  'missing' | 'malformed' | 'signature' | 'expired' | 'future';

export type SignInConfirmationResult =
  { ok: true; value: SignInConfirmation } | { ok: false; reason: SignInConfirmationRejection };

/** The MAC key, from the same operator secret as the state cookie's, under its own label. */
export function deriveSignInConfirmationKey(secret: string): Promise<CryptoKey> {
  return deriveCookieKey(secret, KEY_LABEL);
}

/** A fresh nonce: 256 bits, base64url. */
export function generateConfirmationNonce(): string {
  return toBase64Url(randomBytes(32));
}

/**
 * `c1.<payload>.<mac>`, every part base64url.
 *
 * Throws `RangeError` when the result would be longer than
 * {@link MAX_SEALED_CONFIRMATION_LENGTH} — a cookie the browser would drop
 * without a word. The caller re-seals with a shorter `next`, the one field
 * whose length the person's own flow decides.
 */
export async function sealSignInConfirmation(
  key: CryptoKey,
  value: SignInConfirmation,
): Promise<string> {
  const payload = toBase64Url(
    utf8Encode(
      JSON.stringify({
        n: value.nonce,
        u: value.userId,
        e: value.email,
        m: value.signInMethod,
        s: value.ssoWorkosOrgId,
        o: value.organization === null ? null : [value.organization.name, value.organization.slug],
        p: value.purpose,
        x: value.next,
        f: value.flowIssuedAt,
        a: value.freshAuthAt,
        l: value.lockOne,
        k: value.outcome,
        r: value.reason,
        w: value.providerSessionId,
        j: value.joins,
        t: value.issuedAt,
      }),
    ),
  );
  const mac = await crypto.subtle.sign('HMAC', key, utf8Encode(`${VERSION}.${payload}`));
  const sealed = `${VERSION}.${payload}.${toBase64Url(new Uint8Array(mac))}`;
  if (sealed.length > MAX_SEALED_CONFIRMATION_LENGTH) {
    throw new RangeError('The sign-in confirmation would be longer than a browser keeps a cookie.');
  }
  return sealed;
}

/**
 * Verifies and reads a confirmation cookie: the MAC before anything inside is
 * parsed, then its age. Single-use is not decided here — see the header.
 */
export async function openSignInConfirmation(
  key: CryptoKey,
  cookie: string | null | undefined,
  now: Date,
): Promise<SignInConfirmationResult> {
  if (cookie === null || cookie === undefined || cookie === '') {
    return { ok: false, reason: 'missing' };
  }
  if (cookie.length > MAX_COOKIE_LENGTH) return { ok: false, reason: 'malformed' };

  const parts = cookie.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return { ok: false, reason: 'malformed' };
  const [, payload = '', mac = ''] = parts;

  let macBytes: Uint8Array<ArrayBuffer>;
  try {
    macBytes = new Uint8Array(fromBase64Url(mac));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (macBytes.length !== 32) return { ok: false, reason: 'malformed' };

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
  if (nowSeconds - value.issuedAt > SIGN_IN_CONFIRMATION_TTL_SECONDS) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, value };
}

/**
 * The `Set-Cookie` value. `SameSite=Lax`: the callback that sets it is the end
 * of a redirect chain that began on WorkOS's site, and the confirmation page
 * that must read it is the next top-level navigation — `Strict` would withhold
 * it there. `Lax` still keeps it off every cross-site POST, which is the
 * request that would matter.
 */
export function signInConfirmationCookie(value: string): string {
  return [
    `${SIGN_IN_CONFIRMATION_COOKIE_NAME}=${value}`,
    'Path=/',
    `Max-Age=${SIGN_IN_CONFIRMATION_TTL_SECONDS}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

/** Clears it — on every answer to the confirmation, so a browser holds one at most once. */
export function clearedSignInConfirmationCookie(): string {
  return [
    `${SIGN_IN_CONFIRMATION_COOKIE_NAME}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SIGN_IN_METHODS: ReadonlySet<string> = new Set<SignInMethod>([
  'password',
  'oauth',
  'sso',
  'magic_auth',
  'passkey',
  'other',
]);
const LOCK_ONE: ReadonlySet<string> = new Set<ParkedLockOne>([
  'armed',
  'method',
  'no-auth-time',
  'stale',
]);

/** A short string with no control characters, or `false`. */
function isPrintable(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    // eslint-disable-next-line no-control-regex -- control characters are the subject of the check.
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isOrganizationId(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' && value.length <= 64 && WORKOS_ORGANIZATION_ID_PATTERN.test(value))
  );
}

/** The shape of a WorkOS session id (`sid`) — what the sessions table holds it to as well. */
export const WORKOS_SESSION_ID_PATTERN = /^session_[0-9A-Za-z]{1,64}$/;

/**
 * Reads a payload whose MAC verified. Every field is checked anyway, for the
 * reason `oauth-state.ts` gives: "the MAC was fine" is not "this is a value the
 * confirmation can act on".
 */
function parsePayload(payload: string): SignInConfirmation | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decode(fromBase64Url(payload)));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { n, u, e, m, s, o, p, x, f, a, l, k, r, w, j, t } = parsed as Record<string, unknown>;

  if (typeof n !== 'string' || !NONCE_PATTERN.test(n)) return null;
  if (typeof u !== 'string' || !UUID_PATTERN.test(u)) return null;
  if (!isPrintable(e, 320)) return null;
  if (typeof m !== 'string' || !SIGN_IN_METHODS.has(m)) return null;
  if (!isOrganizationId(s)) return null;
  // An SSO organisation only ever beside the SSO method — the rule the
  // `sessions` table holds too.
  if (s !== null && m !== 'sso') return null;

  let organization: SignInConfirmation['organization'] = null;
  if (o !== null) {
    if (!Array.isArray(o) || o.length !== 2) return null;
    const [name, slug] = o as unknown[];
    if (!isPrintable(name, 200)) return null;
    if (typeof slug !== 'string' || slug.length > SLUG_MAX_LENGTH || !SLUG_PATTERN.test(slug)) {
      return null;
    }
    organization = { name, slug };
  }

  if (p !== 'sign-in' && p !== 'reauth') return null;
  if (!isSealableNext(x)) return null;
  if (typeof f !== 'number' || !Number.isSafeInteger(f)) return null;
  // The three fields below were added in review round 2; a cookie sealed by
  // the build before (five minutes at most) reads them as absent.
  if (a !== undefined && a !== null && (typeof a !== 'number' || !Number.isSafeInteger(a))) {
    return null;
  }
  // A fresh authentication is a fact about a re-authentication only.
  if (typeof a === 'number' && p !== 'reauth') return null;
  if (l !== null && (typeof l !== 'string' || !LOCK_ONE.has(l))) return null;
  // Lock one is a question about a re-authentication only.
  if ((l === null) !== (p === 'sign-in')) return null;
  if (k !== 'matched' && k !== 'linked' && k !== 'created') return null;
  if (typeof r !== 'string' || !REASONS.has(r)) return null;
  if (
    w !== undefined &&
    w !== null &&
    (typeof w !== 'string' || !WORKOS_SESSION_ID_PATTERN.test(w))
  ) {
    return null;
  }
  if (j !== undefined && typeof j !== 'boolean') return null;
  if (typeof t !== 'number' || !Number.isSafeInteger(t)) return null;

  return {
    nonce: n,
    userId: u,
    email: e,
    signInMethod: m as SignInMethod,
    ssoWorkosOrgId: s,
    organization,
    purpose: p,
    next: x,
    flowIssuedAt: f,
    freshAuthAt: typeof a === 'number' ? a : null,
    lockOne: l as ParkedLockOne | null,
    outcome: k,
    reason: r as SignInConfirmationReason,
    providerSessionId: typeof w === 'string' ? w : null,
    joins: j === true,
    issuedAt: t,
  };
}

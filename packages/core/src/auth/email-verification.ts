import { fromBase64Url, toBase64Url, utf8Decode, utf8Encode } from '../crypto/encoding';
import { deriveCookieKey } from './oauth-state';

/**
 * The sealed cookie that carries a paused password sign-in to its emailed
 * code — WorkOS's `email_verification_required`, finished by the code WorkOS
 * emails to the address (web app: `POST /api/auth/sign-in/verify-email`).
 *
 * ── Why a cookie, and not the page ──
 * WorkOS answers the paused sign-in with a *pending authentication token*: that
 * token and the emailed code together finish the authentication. Handing the
 * token to the page would put half a credential in JavaScript's reach and let
 * it travel wherever a script or a crafted request carries it — a token minted
 * against one address presented beside another. So the token never reaches the
 * page. It goes into this cookie, `HttpOnly` and `SameSite=Strict`, sealed
 * together with the address it was minted for and when; the page sends only
 * the address and the code, and the server finishes only when the address the
 * page names is the one sealed beside the token, in the browser it was handed
 * to, within {@link EMAIL_VERIFICATION_TTL_SECONDS}.
 *
 * `issuedAt` is also when the flow began, which the sign-in that finishes it
 * hands on as such: WorkOS may date the authentication by the password step,
 * and the confirmation's reused-session check must not mistake the minutes a
 * person spent finding the email for a session WorkOS reused.
 *
 * ── Sealed, not encrypted ──
 * HMAC-signed under its own HKDF label, like every cookie in this module set,
 * so no other cookie can stand in for it. Not encrypted: it is `HttpOnly`, and
 * nothing in it is secret from the browser it was handed to — which is the one
 * place it is ever sent.
 */

/** `__Host-`, so a subdomain cannot plant or overwrite it. */
export const EMAIL_VERIFICATION_COOKIE_NAME = '__Host-xecret_email_verification';

/** How long a person has to fetch the code: ten minutes, as long as WorkOS gives it. */
export const EMAIL_VERIFICATION_TTL_SECONDS = 10 * 60;

/** The longest address sealed — the standard's own ceiling. */
export const MAX_SEALED_EMAIL_LENGTH = 320;

/** The longest pending token sealed. WorkOS's are short and opaque. */
export const MAX_SEALED_PENDING_TOKEN_LENGTH = 2048;

const VERSION = 'v1';
const KEY_LABEL = 'xecret/email-verification/v1';
const CLOCK_SKEW_SECONDS = 10;
const MAX_COOKIE_LENGTH = 4096;
/** Printable ASCII without spaces: what an opaque WorkOS token can be made of. */
const TOKEN_PATTERN = /^[\x21-\x7e]+$/;

export interface EmailVerification {
  /** The address the paused sign-in was for, as WorkOS was asked about it. */
  email: string;
  /** WorkOS's pending-authentication token. Never shown to the page. */
  pendingToken: string;
  /** Seconds since the epoch: when the password step answered. */
  issuedAt: number;
}

export type EmailVerificationRejection =
  'missing' | 'malformed' | 'signature' | 'expired' | 'future';

export type EmailVerificationResult =
  { ok: true; value: EmailVerification } | { ok: false; reason: EmailVerificationRejection };

/** The MAC key, from the same operator secret as the other sign-in cookies, under its own label. */
export function deriveEmailVerificationKey(secret: string): Promise<CryptoKey> {
  return deriveCookieKey(secret, KEY_LABEL);
}

/**
 * `v1.<payload>.<mac>`, every part base64url. Throws `RangeError` for a value
 * this module would refuse to read back — an over-long or control-character
 * address, a token that is not one — rather than hand out a cookie that can
 * never finish anything.
 */
export async function sealEmailVerification(
  key: CryptoKey,
  value: EmailVerification,
): Promise<string> {
  if (!isAddress(value.email) || !isPendingToken(value.pendingToken)) {
    throw new RangeError('An email verification needs an address and a pending token.');
  }
  if (!Number.isSafeInteger(value.issuedAt) || value.issuedAt <= 0) {
    throw new RangeError('An email verification needs the moment it was issued.');
  }
  const payload = toBase64Url(
    utf8Encode(JSON.stringify({ e: value.email, p: value.pendingToken, t: value.issuedAt })),
  );
  const mac = await crypto.subtle.sign('HMAC', key, utf8Encode(`${VERSION}.${payload}`));
  return `${VERSION}.${payload}.${toBase64Url(new Uint8Array(mac))}`;
}

/** Verifies and reads the cookie: the MAC before anything inside is parsed, then its age. */
export async function openEmailVerification(
  key: CryptoKey,
  cookie: string | null | undefined,
  now: Date,
): Promise<EmailVerificationResult> {
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
  if (nowSeconds - value.issuedAt > EMAIL_VERIFICATION_TTL_SECONDS) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, value };
}

/**
 * The `Set-Cookie` value. `SameSite=Strict`: it is set by a same-origin `fetch`
 * and read by the next one, from the same page, so no top-level navigation from
 * another site ever needs it — and `Strict` keeps it off every request another
 * site could start.
 */
export function emailVerificationCookie(value: string): string {
  return [
    `${EMAIL_VERIFICATION_COOKIE_NAME}=${value}`,
    'Path=/',
    `Max-Age=${EMAIL_VERIFICATION_TTL_SECONDS}`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
  ].join('; ');
}

/** Clears it — once the sign-in it carried has finished. */
export function clearedEmailVerificationCookie(): string {
  return [
    `${EMAIL_VERIFICATION_COOKIE_NAME}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
  ].join('; ');
}

/**
 * Whether two addresses are the same address for this cookie's purpose: equal
 * once ASCII capitals are folded, which is how the address was typed twice into
 * the same form. Nothing else is folded — two spellings of an internationalised
 * address are not guessed to be one.
 */
export function isSameVerificationAddress(sealed: string, presented: string): boolean {
  const fold = (value: string) => value.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
  return fold(sealed) === fold(presented);
}

function isAddress(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_SEALED_EMAIL_LENGTH &&
    value.includes('@') &&
    // eslint-disable-next-line no-control-regex -- control characters are the subject of the check.
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isPendingToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_SEALED_PENDING_TOKEN_LENGTH &&
    TOKEN_PATTERN.test(value)
  );
}

function parsePayload(payload: string): EmailVerification | null {
  let raw: unknown;
  try {
    raw = JSON.parse(utf8Decode(fromBase64Url(payload)));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const { e: email, p: pendingToken, t: issuedAt } = record;
  if (!isAddress(email) || !isPendingToken(pendingToken)) return null;
  if (typeof issuedAt !== 'number' || !Number.isSafeInteger(issuedAt) || issuedAt <= 0) return null;
  return { email, pendingToken, issuedAt };
}

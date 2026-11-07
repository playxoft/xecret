import {
  fromBase64Url,
  randomBytes,
  toBase64Url,
  utf8Decode,
  utf8Encode,
} from '../crypto/encoding';
import { deriveCookieKey } from './oauth-state';

/**
 * The browser a person has signed in on before — OWASP's "device cookie" — and
 * the key the sign-in throttle hashes its subjects under.
 *
 * ── Why ──
 * The in-app sign-in page locks an address after repeated failures. Keyed on
 * the address alone, that lock is a lever: anybody can hold any address locked
 * with a handful of wrong guesses an hour, and the real owner pays. So every
 * successful sign-in hands its browser this cookie, naming a random device id
 * and the account's address, and the throttle (web app,
 * `server/sign-in-throttle.ts`) budgets a request that carries a valid one for
 * the address it names **per device**, apart from everybody else. Somebody
 * without the owner's cookie can only exhaust the shared pool; the owner's own
 * browser keeps its own five free tries and its own backoff.
 *
 * ── What it is, and is not ──
 * `d1.<payload>.<mac>` — an HMAC, under its own HKDF label of the operator
 * secret, over `{ device id, address, issued at }`. `HttpOnly`, `Secure`,
 * `SameSite=Strict`, ninety days. It authenticates nobody and opens nothing:
 * the most a stolen one buys is a separate guessing budget for the one address
 * it names — the same budget a fresh browser gets, no more. It is only ever
 * minted for an address that just signed in, so nobody can earn one for an
 * address they cannot sign in to. One per browser: signing in as somebody else
 * replaces it.
 */

/** `__Host-`, so a subdomain cannot plant or overwrite it. */
export const KNOWN_DEVICE_COOKIE_NAME = '__Host-xecret_known_device';

/** Ninety days. Long enough that a returning person is known; short enough to rotate. */
export const KNOWN_DEVICE_TTL_SECONDS = 90 * 24 * 60 * 60;

const VERSION = 'd1';
const KEY_LABEL = 'xecret/known-device/v1';
const THROTTLE_KEY_LABEL = 'xecret/sign-in-throttle/v1';
const CLOCK_SKEW_SECONDS = 10;
const MAX_COOKIE_LENGTH = 1024;
const MAX_ADDRESS_LENGTH = 320;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface KnownDevice {
  /** 256 random bits, base64url. */
  deviceId: string;
  /** The address of the account that signed in on this browser. */
  email: string;
  /** Seconds since the epoch. */
  issuedAt: number;
}

/** The cookie's MAC key, from the operator secret, under its own label. */
export function deriveKnownDeviceKey(secret: string): Promise<CryptoKey> {
  return deriveCookieKey(secret, KEY_LABEL);
}

/**
 * The HMAC key the sign-in throttle derives its row keys under — so a stored
 * key, or a logged prefix of one, cannot be checked against a list of
 * candidate addresses without the operator secret. Its own label: it vouches
 * for no cookie, and no cookie key can stand in for it.
 */
export function deriveSignInThrottleKey(secret: string): Promise<CryptoKey> {
  return deriveCookieKey(secret, THROTTLE_KEY_LABEL);
}

/** A fresh device id: 256 bits, base64url. */
export function generateDeviceId(): string {
  return toBase64Url(randomBytes(32));
}

/** `d1.<payload>.<mac>`. Throws `RangeError` for a value it would refuse to read back. */
export async function sealKnownDevice(key: CryptoKey, value: KnownDevice): Promise<string> {
  if (!DEVICE_ID_PATTERN.test(value.deviceId) || !isAddress(value.email)) {
    throw new RangeError('A known device needs a device id and an address.');
  }
  if (!Number.isSafeInteger(value.issuedAt) || value.issuedAt <= 0) {
    throw new RangeError('A known device needs the moment it was issued.');
  }
  const payload = toBase64Url(
    utf8Encode(JSON.stringify({ d: value.deviceId, e: value.email, t: value.issuedAt })),
  );
  const mac = await crypto.subtle.sign('HMAC', key, utf8Encode(`${VERSION}.${payload}`));
  return `${VERSION}.${payload}.${toBase64Url(new Uint8Array(mac))}`;
}

/**
 * The device a cookie names, or `null` for anything this module did not write,
 * wrote under another key, or wrote more than ninety days ago. Never an error:
 * a browser without a good cookie is simply not known.
 */
export async function openKnownDevice(
  key: CryptoKey,
  cookie: string | null | undefined,
  now: Date,
): Promise<KnownDevice | null> {
  if (typeof cookie !== 'string' || cookie === '' || cookie.length > MAX_COOKIE_LENGTH) return null;
  const parts = cookie.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const [, payload = '', mac = ''] = parts;

  let macBytes: Uint8Array<ArrayBuffer>;
  try {
    macBytes = new Uint8Array(fromBase64Url(mac));
  } catch {
    return null;
  }
  if (macBytes.length !== 32) return null;
  const authentic = await crypto.subtle.verify(
    'HMAC',
    key,
    macBytes,
    utf8Encode(`${VERSION}.${payload}`),
  );
  if (!authentic) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(utf8Decode(fromBase64Url(payload)));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { d: deviceId, e: email, t: issuedAt } = raw as Record<string, unknown>;
  if (typeof deviceId !== 'string' || !DEVICE_ID_PATTERN.test(deviceId)) return null;
  if (!isAddress(email)) return null;
  if (typeof issuedAt !== 'number' || !Number.isSafeInteger(issuedAt) || issuedAt <= 0) return null;

  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (issuedAt > nowSeconds + CLOCK_SKEW_SECONDS) return null;
  if (nowSeconds - issuedAt > KNOWN_DEVICE_TTL_SECONDS) return null;
  return { deviceId, email, issuedAt };
}

/** The `Set-Cookie` value, for the answer that issues a session. */
export function knownDeviceCookie(value: string): string {
  return [
    `${KNOWN_DEVICE_COOKIE_NAME}=${value}`,
    'Path=/',
    `Max-Age=${KNOWN_DEVICE_TTL_SECONDS}`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
  ].join('; ');
}

/**
 * An address folded the way a person types it twice into one form: trimmed,
 * ASCII capitals lowered, nothing else — two spellings of an internationalised
 * address are not guessed to be one.
 */
export function foldAddress(value: string): string {
  return value.trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function isAddress(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ADDRESS_LENGTH &&
    value.includes('@') &&
    // eslint-disable-next-line no-control-regex -- control characters are the subject of the check.
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

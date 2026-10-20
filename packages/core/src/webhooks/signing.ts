import { fromBase64Url, randomBytes, timingSafeEqual, utf8Encode } from '../crypto/encoding';

/**
 * Standard Webhooks signing (https://www.standardwebhooks.com), for the webhooks
 * xecret *sends* (P19 §5).
 *
 * The same scheme the payment provider uses for the webhooks xecret *receives*,
 * on purpose: one construction to document, one a customer's existing verifier
 * library already speaks, and nothing invented.
 *
 *     webhook-id:        <a unique id, stable across retries of one delivery>
 *     webhook-timestamp: <seconds since the epoch, as sent>
 *     webhook-signature: v1,<base64 HMAC-SHA256(key, "<id>.<timestamp>.<body>")>
 *
 * The key is the secret with its `whsec_` prefix removed, base64-decoded. A
 * receiver that sees the same `webhook-id` twice has received a retry and should
 * do the work once — retries are at-least-once, and the documentation says so.
 *
 * Runs on Web Crypto only, so it is identical in a Worker, a browser and Node.
 */

export const WEBHOOK_SECRET_PREFIX = 'whsec_';

/** 32 random bytes: the top of the range the scheme recommends. */
const SECRET_BYTES = 32;

/** A fresh signing secret, shown to its creator once and stored encrypted. */
export function generateWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${toBase64(randomBytes(SECRET_BYTES))}`;
}

/** Whether a string has the shape of a signing secret. Says nothing about which one. */
export function isWebhookSecret(value: string): boolean {
  if (!value.startsWith(WEBHOOK_SECRET_PREFIX)) return false;
  try {
    const key = fromBase64(value.slice(WEBHOOK_SECRET_PREFIX.length));
    return key.length >= 24 && key.length <= 64;
  } catch {
    return false;
  }
}

/**
 * The `webhook-signature` header for one delivery.
 *
 * `body` is the exact string sent — the signature covers bytes, and a receiver
 * that re-serialises the JSON before checking will fail, which is why the
 * documentation tells them to verify the raw body.
 */
export async function signWebhook(params: {
  secret: string;
  id: string;
  timestamp: number;
  body: string;
}): Promise<string> {
  const key = await importSigningKey(params.secret);
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    utf8Encode(`${params.id}.${params.timestamp}.${params.body}`),
  );
  return `v1,${toBase64(new Uint8Array(signature))}`;
}

/**
 * Checks a delivery the way a receiver should: every `v1,` signature in the
 * header is tried, in constant time, and the timestamp must be within
 * `toleranceSeconds` of `now` so a captured delivery cannot be replayed later.
 *
 * xecret never receives its own webhooks; this exists so the tests pin the
 * signer against the scheme's published vector, and so the documentation's
 * example is code that has actually run.
 */
export async function verifyWebhook(params: {
  secret: string;
  id: string;
  timestamp: number;
  body: string;
  signatureHeader: string;
  now: number;
  toleranceSeconds?: number;
}): Promise<boolean> {
  const tolerance = params.toleranceSeconds ?? 300;
  if (Math.abs(params.now - params.timestamp) > tolerance) return false;

  const expected = utf8Encode(
    await signWebhook({
      secret: params.secret,
      id: params.id,
      timestamp: params.timestamp,
      body: params.body,
    }),
  );

  let matched = false;
  for (const candidate of params.signatureHeader.split(' ')) {
    if (timingSafeEqual(utf8Encode(candidate), expected)) matched = true;
  }
  return matched;
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
  if (!secret.startsWith(WEBHOOK_SECRET_PREFIX)) {
    throw new TypeError('A webhook signing secret begins with whsec_.');
  }
  const raw = fromBase64(secret.slice(WEBHOOK_SECRET_PREFIX.length));
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

/** Standard base64 — the scheme's encoding — with padding. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  // `atob` accepts standard base64; base64url secrets from other generators are
  // tolerated by mapping their two characters back, then decoded through the
  // codebase's strict decoder so a malformed secret fails loudly.
  const url = value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return fromBase64Url(url);
}

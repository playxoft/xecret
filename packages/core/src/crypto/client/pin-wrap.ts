/**
 * The device PIN: six digits on one browser, thirty-two bytes on the server,
 * and the wrap of the User Key that only both together open.
 *
 * ## Why six digits are not six digits
 *
 * 10^6 candidates is no protection at all against an offline attacker, and no
 * Argon2id cost fixes that — see {@link DEVICE_PIN_KDF_PARAMS}. So the PIN never
 * opens anything on its own. The wrap lives in that browser's `localStorage`
 * and **never reaches the server**; the key that opens it is
 * `HKDF(pinKey ‖ pepper, "xecret.v2.pin-wrap")`, and the pepper is 32 random
 * bytes the server mints at enrolment and hands back only to a client that has
 * just presented the matching verifier. Hold the device without the pepper and
 * there is nothing to attack; hold the whole pepper table without the device and
 * there is nothing to attack it *with*.
 *
 * The two halves meet for one request, under a five-attempt counter. That is
 * what turns a million offline guesses into five online ones.
 *
 * ## The trade-off, stated rather than implied
 *
 * A server that colludes with whoever holds the device *can* enumerate six
 * digits: it has the pepper and they have the wrap, and only the Argon2id cost
 * stands in the way. That is a real weakening of the zero-knowledge property,
 * and it is why enrolment is opt-in per browser, why the passphrase stays the
 * root, and why nothing turns this on by default. The settings screen says the
 * same thing to the person choosing.
 *
 * ## Two branches from one Argon2id output
 *
 * `pinKey` is HKDF input keying material, not a key, for exactly the reason `SK`
 * is (spec §3.3): the verifier branch is handed to the server and the wrap
 * branch must not be recoverable from it. Deriving them the other way round
 * would mean a server holding verifiers held half of every wrap key whose pepper
 * it also holds — which is all of them.
 *
 * Spec: docs/security/e2ee-crypto-spec.md §13.3.
 */

import { devicePinWrapAad } from '../aad';
import { KEY_LENGTH } from '../aead';
import { randomBytes } from '../encoding';
import type { Bytes } from '../types';
import { formatGcmBlob, parseGcmBlob } from './blob';
import { decryptGcm, encryptGcm } from './gcm';
import { deriveKey, HKDF_INFO } from './hkdf';
import { DEVICE_PIN_KDF_PARAMS, deriveStretchedKey } from './kdf';
import type { Argon2idProvider } from './kdf';

/** Six, and exactly six. The length the entry field and the server both assume. */
export const DEVICE_PIN_LENGTH = 6;

/** The server-minted half of the wrap key. 32 bytes, as the column's CHECK says. */
export const DEVICE_PIN_PEPPER_BYTES = 32;

/**
 * ASCII digits only, and a fixed length.
 *
 * Not `\d`, which in a Unicode-aware context also matches the Arabic-Indic and
 * Devanagari digit blocks: a PIN typed on one keyboard and re-typed on another
 * would derive a different key, and the failure would look like a forgotten PIN
 * rather than like an encoding difference.
 */
const DEVICE_PIN_PATTERN = /^[0-9]{6}$/;

/** Whether a string is a well-formed device PIN. */
export function isDevicePin(value: string): boolean {
  return typeof value === 'string' && DEVICE_PIN_PATTERN.test(value);
}

/** A fresh pepper. Minted by the server, never by the browser that will use it. */
export function generatePinPepper(): Bytes {
  return randomBytes(DEVICE_PIN_PEPPER_BYTES);
}

/**
 * A PIN and its device-local salt → the Argon2id output both branches come from.
 *
 * Through the same provider seam as the master passphrase, at
 * {@link DEVICE_PIN_KDF_PARAMS} rather than the passphrase cost. The salt is 16
 * bytes generated at enrolment and stored beside the wrap in the clear — an
 * Argon2id salt is not a secret, and a per-device one is what stops two browsers
 * with the same PIN deriving the same `pinKey`.
 */
export async function derivePinKey(params: {
  pin: string;
  salt: Bytes;
  argon2id?: Argon2idProvider;
}): Promise<Bytes> {
  if (!isDevicePin(params.pin)) {
    throw new TypeError(`A device PIN is ${DEVICE_PIN_LENGTH} digits`);
  }

  return deriveStretchedKey({
    passphrase: params.pin,
    salt: params.salt,
    params: DEVICE_PIN_KDF_PARAMS,
    ...(params.argon2id === undefined ? {} : { argon2id: params.argon2id }),
  });
}

/**
 * `pinKey` → the value the server stores the SHA-256 of.
 *
 * Possessing it opens nothing: it is a sibling HKDF branch of the wrap key, the
 * same construction and the same argument as `deriveUnlockVerifier`. What it
 * buys the server is the only thing a server can usefully do here — decide
 * whether to release the pepper, and count the attempt that asked.
 */
export async function derivePinVerifier(pinKey: Bytes): Promise<Bytes> {
  return deriveKey({ ikm: pinKey, info: HKDF_INFO.pinVerifier });
}

/**
 * `pinKey ‖ pepper` → the AES-256-GCM key that wraps the User Key.
 *
 * The concatenation needs no length prefix because both operands are fixed at 32
 * bytes, and both are checked here rather than assumed — a truncated pepper
 * would be a wrap key with less entropy than this design claims, and the failure
 * would surface as a successful enrolment rather than as an error.
 */
export async function derivePinWrapKey(pinKey: Bytes, pepper: Bytes): Promise<Bytes> {
  if (pinKey.length !== KEY_LENGTH) {
    throw new TypeError(`A PIN key is ${KEY_LENGTH} bytes`);
  }
  if (pepper.length !== DEVICE_PIN_PEPPER_BYTES) {
    throw new TypeError(`A PIN pepper is ${DEVICE_PIN_PEPPER_BYTES} bytes`);
  }

  const ikm = new Uint8Array(pinKey.length + pepper.length);
  ikm.set(pinKey, 0);
  ikm.set(pepper, pinKey.length);

  try {
    return await deriveKey({ ikm, info: HKDF_INFO.pinWrap });
  } finally {
    ikm.fill(0);
  }
}

/** Whose wrap this is, and on which browser. Bound into the wrap's AAD. */
export interface DevicePinContext {
  userId: string;
  /** The browser's own uuid, generated client-side at enrolment. */
  deviceId: string;
}

/** Wraps the User Key under a PIN and a pepper. Returns an `xk2.gcm.` blob. */
export async function wrapUserKeyWithPin(params: {
  pinKey: Bytes;
  pepper: Bytes;
  userKey: Bytes;
  context: DevicePinContext;
}): Promise<string> {
  if (params.userKey.length !== KEY_LENGTH) {
    throw new TypeError(`The User Key is ${KEY_LENGTH} bytes`);
  }

  const wrapKey = await derivePinWrapKey(params.pinKey, params.pepper);
  try {
    return formatGcmBlob(
      await encryptGcm(wrapKey, params.userKey, devicePinWrapAad(params.context)),
    );
  } finally {
    wrapKey.fill(0);
  }
}

/**
 * Unwraps the User Key. Throws `DecryptionError` on any failure.
 *
 * A wrong PIN, a pepper from another enrolment, a wrap copied from a different
 * browser and a tampered blob are one indistinguishable outcome, as everywhere
 * else in this layer. The caller cannot tell them apart and must not try: the
 * honest message is that the PIN did not open the vault, and the *count* of
 * attempts left is the server's answer rather than this function's.
 */
export async function unwrapUserKeyWithPin(params: {
  pinKey: Bytes;
  pepper: Bytes;
  blob: string;
  context: DevicePinContext;
}): Promise<Bytes> {
  const wrapKey = await derivePinWrapKey(params.pinKey, params.pepper);
  try {
    return await decryptGcm(wrapKey, parseGcmBlob(params.blob), devicePinWrapAad(params.context));
  } finally {
    wrapKey.fill(0);
  }
}

/**
 * HKDF-SHA256, with a closed registry of `info` strings.
 *
 * Every derivation in the zero-knowledge hierarchy goes through here, and the
 * `info` string is what separates one branch from another. Two branches derived
 * from the same input keying material with different `info` values are
 * independent: learning one reveals nothing about the other. That property is
 * the reason the Stretched Key can produce both the User Key wrap key and the
 * unlock verifier — the verifier is handed to the server, and a server holding
 * verifiers must not thereby hold wrap keys.
 *
 * The registry is closed **by assertion, not by convention**. A typo in an info
 * string does not fail loudly on its own: it derives a different, perfectly
 * valid-looking key, and the failure surfaces later as an undecryptable blob. So
 * an unregistered string is rejected here, at the one place every derivation
 * passes through.
 *
 * Spec: docs/security/e2ee-crypto-spec.md §3.2–3.3.
 */

import { isAadV2 } from '../aad';
import { utf8Encode } from '../encoding';
import type { Bytes } from '../types';

/**
 * The complete info-string table (spec §3.3).
 *
 * An implementation MUST NOT introduce a string that does not appear here. The
 * one derivation not named in this table is the sealed box, which passes the
 * blob's full AAD string as its info — see {@link deriveKey}.
 */
export const HKDF_INFO = {
  /** `SK` → the AES-256-GCM key wrapping the UK in the passphrase wrap. */
  ukWrap: 'xecret.v2.uk-wrap',
  /** `SK` → the value sent to the server by an unlock that derived `SK`. */
  unlockVerifier: 'xecret.v2.unlock-verifier',
  /**
   * `UK` → the value sent to the server by an unlock that did *not* derive `SK`.
   *
   * The one branch in this table whose input keying material is the User Key,
   * and it exists because an unlock does not always involve a passphrase. A
   * passkey opens blob type 3, which holds the UK; there is no derivation from
   * the UK back to `SK`, by construction, so such a client can decrypt
   * everything and still hold nothing the `unlockVerifier` branch could produce.
   *
   * Deriving an unlock proof from the UK concedes nothing: anyone who can
   * compute it already holds the UK, and therefore already holds every key the
   * account can reach. The proof is strictly weaker than the capability it
   * attests to. Kept separate from the `SK` branch so the two verifiers hash to
   * distinct stored columns and can never be replayed for one another.
   */
  ukUnlockVerifier: 'xecret.v2.uk-unlock-verifier',
  /** A recovery code's 16 bytes → that code's UK wrap key (`RCK`). */
  recoveryWrap: 'xecret.v2.recovery-wrap',
  /** A WebAuthn PRF output → the passkey wrap key (`PK`). */
  prfWrap: 'xecret.v2.prf-wrap',
  /** `EHK` → the HMAC-SHA256 key behind `valueHmac`. */
  valueHmac: 'xecret.v2.value-hmac',
  /** An invite fragment's seed → the invite keypair's X25519 private scalar. */
  inviteKey: 'xecret.v2.invite-key',
} as const;

export type HkdfInfo = (typeof HKDF_INFO)[keyof typeof HKDF_INFO];

const REGISTERED_INFO: readonly string[] = Object.values(HKDF_INFO);

/** Every derivation in this specification produces 32 bytes. */
export const HKDF_OUTPUT_BYTES = 32;

/** Whether a string may be used as an HKDF `info` value. */
export function isRegisteredInfo(info: string): boolean {
  return REGISTERED_INFO.includes(info) || isAadV2(info);
}

/**
 * HKDF-SHA256 → 32 bytes.
 *
 * The salt is empty for every branch except the sealed box, which puts
 * `ephemeralPub ‖ recipientPub` there. An empty salt is correct for the rest:
 * every input keying material in this hierarchy is already a uniformly random
 * 32-byte value or a KDF output — none is a password.
 */
export async function deriveKey(params: {
  ikm: Bytes;
  info: string;
  /** Defaults to empty. Only the sealed box (spec §5) supplies one. */
  salt?: Bytes;
}): Promise<Bytes> {
  if (params.ikm.length === 0) {
    throw new TypeError('HKDF input keying material must not be empty');
  }

  if (!isRegisteredInfo(params.info)) {
    // Not merely unusual — unregistered. Deriving under an unknown domain string
    // produces a key nothing else will ever reproduce.
    throw new TypeError('HKDF info string is not in the registry');
  }

  const baseKey = await crypto.subtle.importKey('raw', params.ikm, 'HKDF', false, ['deriveBits']);

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: params.salt ?? new Uint8Array(0),
      info: utf8Encode(params.info),
    },
    baseKey,
    HKDF_OUTPUT_BYTES * 8,
  );

  return new Uint8Array(bits);
}

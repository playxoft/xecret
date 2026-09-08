/**
 * Grant signatures: who created this `env_key_grants` row.
 *
 * A sealed box is anonymous, so without a signature `signedByUserId` is a
 * server-asserted field — and a malicious server could insert its own grant and
 * read everything written afterwards. Signing closes that, and signing **from
 * day one** is what makes turning verification on later a client update rather
 * than a data migration.
 *
 * Verification is deferred as a product decision (ADR 0009, trade-off 3: it
 * needs a trust root for signer keys, which is the key-substitution problem one
 * level up). {@link verifyGrantSignature} ships anyway, because a signature
 * scheme with no verifier in the same commit is a signature scheme nobody has
 * ever checked round-trips.
 *
 * ## Canonicalisation
 *
 * Ed25519 signs a message, so the message must be a byte string two
 * implementations cannot disagree about:
 *
 *     lp(x) := u32be(len(x)) ‖ x
 *
 *     lp("xecret.v2.grant-sig") ‖ lp(environmentId) ‖ lp(u32be(edkVersion))
 *   ‖ lp(recipientKind) ‖ lp(recipientId) ‖ lp(recipientPublicKey)
 *   ‖ lp(edkSealedBlob) ‖ lp(ehkSealedBlob)
 *
 * Every field is length-prefixed, **including the fixed-width ones**. Prefixing
 * only the variable-length fields would require both implementations to agree on
 * which fields are fixed, and that agreement holds right up until someone
 * changes a UUID representation. Four redundant bytes per field remove the
 * question.
 *
 * UUIDs are the canonical 36-character lowercase text, never 16 raw bytes: Go's
 * `uuid.UUID` is `[16]byte` and TypeScript's is a string, and converting between
 * them introduces a byte-order convention that RFC 9562 specifies and
 * implementations get wrong often enough to be a known class of bug.
 *
 * The **full blob strings** are signed, prefix included — not the decoded
 * payloads. That covers the `xk2.x25519.` version tag, so a downgrade to a
 * future weaker algorithm cannot reuse a signature, and a verifier never has to
 * re-encode anything.
 *
 * Both sealed blobs are signed. ADR 0009's source design named "the sealed blob"
 * singular; the row carries two, and signing only the EDK would leave the EHK
 * unauthenticated in a row that claims to be authenticated.
 *
 * Spec: docs/security/e2ee-crypto-spec.md §6.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { isUuid } from '../../ids/uuid-v7';
import { concatBytes, utf8Encode } from '../encoding';
import type { RecipientKind } from '../aad';
import type { Bytes } from '../types';
import { copyBytes, lengthPrefixed, u32be } from './bytes';
import { formatBlob, parseBlob } from './blob';
import { PRIVATE_KEY_BYTES, PUBLIC_KEY_BYTES, SIGNATURE_BYTES } from './keypair';

/** Domain separation. The same Ed25519 key will eventually sign other things. */
export const GRANT_SIGNATURE_DOMAIN = 'xecret.v2.grant-sig';

/** Everything a grant signature covers. Exactly the row's own columns. */
export interface GrantSignatureFields {
  environmentId: string;
  edkVersion: number;
  recipientKind: RecipientKind;
  recipientId: string;
  /** The recipient's X25519 public key, 32 raw bytes. */
  recipientPublicKey: Bytes;
  /** The full `xk2.x25519.…` string, as stored. */
  edkSealedBlob: string;
  /** The full `xk2.x25519.…` string, as stored. */
  ehkSealedBlob: string;
}

const RECIPIENT_KINDS: readonly RecipientKind[] = ['member', 'token', 'invite'];

/**
 * Builds the canonical signing payload.
 *
 * Exported in its own right because the test vectors carry it: Ed25519 is
 * deterministic, so a signature mismatch says only that *something* upstream
 * differs, while the payload bytes say which field the two implementations
 * disagreed about — which is where every cross-implementation bug in a
 * canonicalisation scheme actually lives.
 */
export function grantSigningPayload(fields: GrantSignatureFields): Bytes {
  if (!isUuid(fields.environmentId)) {
    throw new TypeError('environmentId must be a canonical lowercase UUID');
  }
  if (!isUuid(fields.recipientId)) {
    throw new TypeError('recipientId must be a canonical lowercase UUID');
  }
  if (!RECIPIENT_KINDS.includes(fields.recipientKind)) {
    throw new TypeError('recipientKind must be member, token, or invite');
  }
  if (fields.recipientPublicKey.length !== PUBLIC_KEY_BYTES) {
    throw new TypeError('recipientPublicKey must be 32 bytes');
  }

  // Parsed, not merely pattern-matched: a signature over a string that is not a
  // sealed box would authenticate something no reader can open.
  parseBlob(fields.edkSealedBlob, 'x25519');
  parseBlob(fields.ehkSealedBlob, 'x25519');

  return concatBytes(
    lengthPrefixed(utf8Encode(GRANT_SIGNATURE_DOMAIN)),
    lengthPrefixed(utf8Encode(fields.environmentId)),
    lengthPrefixed(u32be(fields.edkVersion)),
    lengthPrefixed(utf8Encode(fields.recipientKind)),
    lengthPrefixed(utf8Encode(fields.recipientId)),
    lengthPrefixed(fields.recipientPublicKey),
    lengthPrefixed(utf8Encode(fields.edkSealedBlob)),
    lengthPrefixed(utf8Encode(fields.ehkSealedBlob)),
  );
}

/** Signs a grant, returning an `xk2.ed25519.` blob. */
export function signGrant(params: {
  /** The 32-byte Ed25519 seed, as stored wrapped under the User Key. */
  signerPrivateSeed: Bytes;
  fields: GrantSignatureFields;
}): string {
  if (params.signerPrivateSeed.length !== PRIVATE_KEY_BYTES) {
    throw new TypeError('signer private seed must be 32 bytes');
  }

  const payload = grantSigningPayload(params.fields);
  return formatBlob('ed25519', copyBytes(ed25519.sign(payload, params.signerPrivateSeed)));
}

/**
 * Verifies a grant signature.
 *
 * Returns `false` rather than throwing for every negative outcome, including a
 * malformed signature blob: a verifier that throws on some rejections and
 * returns `false` on others invites a caller to handle one path and not the
 * other, and "unverified" is the same answer in every case.
 */
export function verifyGrantSignature(params: {
  signerPublicKey: Bytes;
  fields: GrantSignatureFields;
  /** The stored `xk2.ed25519.…` string. */
  signature: string;
}): boolean {
  if (params.signerPublicKey.length !== PUBLIC_KEY_BYTES) return false;

  let signature: Bytes;
  try {
    signature = parseBlob(params.signature, 'ed25519');
  } catch {
    return false;
  }

  if (signature.length !== SIGNATURE_BYTES) return false;

  try {
    return ed25519.verify(signature, grantSigningPayload(params.fields), params.signerPublicKey);
  } catch {
    return false;
  }
}

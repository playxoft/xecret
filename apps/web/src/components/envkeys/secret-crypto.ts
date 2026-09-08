'use client';

import {
  computeValueHmac,
  decryptSecret,
  encryptSecret,
  toBase64Url,
} from '@xecret/core/crypto/client';
import type { EnvKeyMaterial } from './env-key-store';
import type { ClientValueBody } from './types';

/**
 * A secret value and its note, between a text box and the wire.
 *
 * Everything here is a thin composition over `@xecret/core/crypto/client`, and
 * that is the point: the AAD components come from one place, so no screen ever
 * assembles a `SecretContext` itself. Getting one component wrong produces a
 * ciphertext that stores cleanly and fails to open for the rest of its life,
 * with nothing at write time saying so — which is the failure this module exists
 * to make unrepresentable.
 *
 * ── The four AAD components, and where each comes from ──
 * `orgId` from the session, `environmentId` from `GET …/keys`, `secretId` from
 * the listing (or minted by the client for a create), and `version` from the row
 * the value will occupy — **the version being written, not the one being read**.
 * That last distinction is what makes a restore a re-encryption rather than a
 * copy: bytes produced for version 3 and stored as version 7 authenticate
 * against nothing.
 */

/** Which row a ciphertext belongs to. Named once, so no caller assembles one. */
export interface SecretTarget {
  orgId: string;
  environmentId: string;
  secretId: string;
}

/**
 * The algorithm label recorded beside every value this client writes.
 *
 * Stated once and sent verbatim. The server draws no conclusion from it — the
 * blob's own `xk2.gcm.` prefix is what a reader parses — so its job is to let an
 * operator answer "what wrote this row" without decoding anything.
 */
export const CLIENT_ALGORITHM = 'xk2.gcm';

/**
 * Encrypts a value for a specific version and computes its change-detection tag.
 *
 * The HMAC is keyed from the **EHK**, not the EDK, which is the entire reason
 * the EHK exists: the EDK is replaced on every rotation, and an HMAC key that
 * rotated with it would make the first write to every secret after a rotation
 * look like a change when nothing changed.
 */
export async function encryptValue(params: {
  material: EnvKeyMaterial;
  target: SecretTarget;
  /** The version this ciphertext will be stored as. Bound into the AAD. */
  version: number;
  plaintext: string;
}): Promise<ClientValueBody> {
  const ciphertext = await encryptSecret({
    edk: params.material.edk,
    context: {
      field: 'value',
      orgId: params.target.orgId,
      environmentId: params.target.environmentId,
      secretId: params.target.secretId,
      version: params.version,
    },
    plaintext: params.plaintext,
  });

  const hmac = await computeValueHmac({ ehk: params.material.ehk, plaintext: params.plaintext });

  return {
    ciphertext,
    clientAlgorithm: CLIENT_ALGORITHM,
    envDataKeyId: params.material.envDataKeyId,
    valueHmac: toBase64Url(hmac),
  };
}

/**
 * Decrypts a stored value.
 *
 * Throws `DecryptionError` when the ciphertext was tampered with, when the key
 * is the wrong one — including this environment's *previous* key, after a
 * rotation — or when any AAD component disagrees with the row. The caller does
 * not get to tell those apart, and should not: the honest message is that this
 * value did not open.
 */
export function decryptValue(params: {
  material: EnvKeyMaterial;
  target: SecretTarget;
  version: number;
  ciphertext: string;
}): Promise<string> {
  return decryptSecret({
    edk: params.material.edk,
    context: {
      field: 'value',
      orgId: params.target.orgId,
      environmentId: params.target.environmentId,
      secretId: params.target.secretId,
      version: params.version,
    },
    blob: params.ciphertext,
  });
}

/**
 * Encrypts a note.
 *
 * No version: a note lives on the `secrets` row rather than on the append-only
 * `secret_versions` row, so binding one would invent a component the Go and
 * TypeScript implementations would eventually disagree about (spec §4.2).
 */
export function encryptNote(params: {
  material: EnvKeyMaterial;
  target: SecretTarget;
  note: string;
}): Promise<string> {
  return encryptSecret({
    edk: params.material.edk,
    context: {
      field: 'note',
      orgId: params.target.orgId,
      environmentId: params.target.environmentId,
      secretId: params.target.secretId,
    },
    plaintext: params.note,
  });
}

export function decryptNote(params: {
  material: EnvKeyMaterial;
  target: SecretTarget;
  blob: string;
}): Promise<string> {
  return decryptSecret({
    edk: params.material.edk,
    context: {
      field: 'note',
      orgId: params.target.orgId,
      environmentId: params.target.environmentId,
      secretId: params.target.secretId,
    },
    blob: params.blob,
  });
}

/**
 * A note as a request body carries it: a blob, `null` to clear, `undefined` to
 * leave alone.
 *
 * The three-state distinction is the plaintext `note` field's, kept because a
 * client that could not express "leave it alone" would have to re-encrypt and
 * resend a note on every value write.
 */
export async function encodeNote(params: {
  material: EnvKeyMaterial;
  target: SecretTarget;
  note: string | null | undefined;
}): Promise<string | null | undefined> {
  if (params.note === undefined) return undefined;
  if (params.note === null || params.note.length === 0) return null;
  return encryptNote({ material: params.material, target: params.target, note: params.note });
}

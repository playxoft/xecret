import { isUuid } from '../ids/uuid-v7';
import type { EncryptionContext } from './types';
import { utf8Encode } from './encoding';
import type { Bytes } from './types';

/**
 * Additional Authenticated Data (AAD) construction.
 *
 * AES-GCM authenticates AAD without encrypting it. Binding each ciphertext to
 * the identity of the row that holds it means a ciphertext moved to a different
 * row fails to decrypt instead of silently succeeding.
 *
 * The attack this defeats: an adversary with database write access — but no key
 * — copies the ciphertext of `DATABASE_URL` from the `production` environment
 * into a `development` environment they are allowed to read, then reads the
 * plaintext through the normal API. Encryption alone does not stop this. AAD
 * binding does, because the AAD computed at read time no longer matches the one
 * used at write time, and GCM authentication fails.
 *
 * ## Format
 *
 * A canonical string, domain-separated by purpose and versioned:
 *
 *     xecret.aad.v1.secret|<orgId>|<environmentId>|<secretId>|<version>
 *
 * Every interpolated identifier is asserted to be a canonical UUID, which
 * contains only `[0-9a-f-]`. The `|` delimiter therefore cannot appear inside a
 * component, so the encoding is unambiguous and no length-prefixing is needed.
 * That assertion is load-bearing, not decorative: without it, an identifier
 * containing `|` could produce the same AAD as a different tuple.
 *
 * The `v1` segment exists so a future format change cannot be confused with this
 * one — an old ciphertext read under a new format simply fails to authenticate.
 */

const PREFIX = 'xecret.aad.v1';

function assertUuid(value: string, label: string): void {
  if (!isUuid(value)) {
    // Never include the offending value: this runs on paths that handle secret
    // identifiers, and error messages reach logs.
    throw new TypeError(`AAD component "${label}" must be a canonical UUID`);
  }
}

/** Binds an Org Master Key to its organisation and key version. */
export function orgKeyAad(orgId: string, keyVersion: number): Bytes {
  assertUuid(orgId, 'orgId');
  assertVersion(keyVersion, 'keyVersion');
  return utf8Encode(`${PREFIX}.org-key|${orgId}|${keyVersion}`);
}

/** Binds an Env Data Key to its organisation, environment, and key version. */
export function envKeyAad(orgId: string, environmentId: string, keyVersion: number): Bytes {
  assertUuid(orgId, 'orgId');
  assertUuid(environmentId, 'environmentId');
  assertVersion(keyVersion, 'keyVersion');
  return utf8Encode(`${PREFIX}.env-key|${orgId}|${environmentId}|${keyVersion}`);
}

/** Binds a secret ciphertext to the exact row that stores it. */
export function secretAad(context: EncryptionContext): Bytes {
  assertUuid(context.orgId, 'orgId');
  assertUuid(context.environmentId, 'environmentId');
  assertUuid(context.secretId, 'secretId');
  assertVersion(context.version, 'version');

  return utf8Encode(
    `${PREFIX}.secret|${context.orgId}|${context.environmentId}|${context.secretId}|${context.version}`,
  );
}

function assertVersion(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`AAD component "${label}" must be a non-negative integer`);
  }
}

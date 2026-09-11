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
 *
 * ## v2
 *
 * The zero-knowledge blobs (`xk2.`, `crypto/client/`) carry `xecret.aad.v2.`
 * purposes, defined byte-for-byte in `docs/security/e2ee-crypto-spec.md` §4. The
 * mechanism is identical; only the purpose list and the component sets differ.
 *
 * The v2 builders return the AAD as a **string** where the v1 builders return
 * bytes. That is not an inconsistency for its own sake: a sealed box (spec §5)
 * uses the same AAD twice — once as HKDF `info` and once as GCM
 * `additionalData` — and the test vectors record it verbatim. One string, encoded
 * by whoever needs bytes, is one fewer place for the two encodings to drift.
 */

const PREFIX = 'xecret.aad.v1';

/** Purpose prefix for every client-side (`xk2.`) blob. */
export const AAD_PREFIX_V2 = 'xecret.aad.v2';

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

/* ────────────────────────────── v2 ────────────────────────────── */

/** Which principal a grant is sealed to. `env_key_grants` holds exactly one. */
export type RecipientKind = 'member' | 'token' | 'invite';

/** Which key opens a User Key wrap. `user_key_wraps.kind`. */
export type WrapKind = 'passphrase' | 'recovery' | 'prf';

const RECIPIENT_KINDS: readonly RecipientKind[] = ['member', 'token', 'invite'];
const WRAP_KINDS: readonly WrapKind[] = ['passphrase', 'recovery', 'prf'];

/**
 * The delimiter invariant, asserted on every interpolated component.
 *
 * `|` cannot appear inside a component, which is the whole reason the encoding
 * needs no length prefixes. UUIDs satisfy it, as do lowercase-hex digests,
 * base64url strings, and the fixed enum words above.
 */
const COMPONENT_PATTERN = /^[0-9a-zA-Z_-]+$/;

function assertComponent(value: string, label: string): void {
  if (typeof value !== 'string' || !COMPONENT_PATTERN.test(value)) {
    // As above: the value never reaches the message. These paths carry secret
    // identifiers and credential ids, and error messages reach logs.
    throw new TypeError(`AAD component "${label}" must match [0-9a-zA-Z_-]+`);
  }
}

function assertRecipientKind(value: RecipientKind): void {
  if (!RECIPIENT_KINDS.includes(value)) {
    throw new TypeError('AAD component "recipientKind" must be member, token, or invite');
  }
}

function assertWrapKind(value: WrapKind): void {
  if (!WRAP_KINDS.includes(value)) {
    throw new TypeError('AAD component "wrapKind" must be passphrase, recovery, or prf');
  }
}

/** Binds a secret value ciphertext to its org, environment, secret, and version. */
export function secretValueAad(context: EncryptionContext): string {
  assertUuid(context.orgId, 'orgId');
  assertUuid(context.environmentId, 'environmentId');
  assertUuid(context.secretId, 'secretId');
  assertVersion(context.version, 'version');

  return `${AAD_PREFIX_V2}.secret-value|${context.orgId}|${context.environmentId}|${context.secretId}|${context.version}`;
}

/**
 * Binds a secret note ciphertext to its org, environment, and secret.
 *
 * No version: notes live on the `secrets` row, not on the append-only
 * `secret_versions` row, so binding one would fabricate a component that the
 * TypeScript and Go implementations would eventually disagree about.
 */
export function secretNoteAad(context: {
  orgId: string;
  environmentId: string;
  secretId: string;
}): string {
  assertUuid(context.orgId, 'orgId');
  assertUuid(context.environmentId, 'environmentId');
  assertUuid(context.secretId, 'secretId');

  return `${AAD_PREFIX_V2}.secret-note|${context.orgId}|${context.environmentId}|${context.secretId}`;
}

/**
 * Binds a sealed Environment Data Key to the environment, the EDK version, and
 * the exact principal it was sealed to.
 *
 * The version is carried because rotation produces a new `env_data_keys` row: a
 * grant for version 3 must not open as a grant for version 4.
 */
export function edkGrantAad(params: {
  environmentId: string;
  edkVersion: number;
  recipientKind: RecipientKind;
  recipientId: string;
}): string {
  assertUuid(params.environmentId, 'environmentId');
  assertVersion(params.edkVersion, 'edkVersion');
  assertRecipientKind(params.recipientKind);
  assertUuid(params.recipientId, 'recipientId');

  return `${AAD_PREFIX_V2}.edk-grant|${params.environmentId}|${params.edkVersion}|${params.recipientKind}|${params.recipientId}`;
}

/**
 * Binds a sealed Environment HMAC Key to the environment and the principal.
 *
 * No version: the EHK is created once per environment and is deliberately never
 * rotated, which is what keeps `valueHmac` stable across EDK rotations.
 */
export function ehkGrantAad(params: {
  environmentId: string;
  recipientKind: RecipientKind;
  recipientId: string;
}): string {
  assertUuid(params.environmentId, 'environmentId');
  assertRecipientKind(params.recipientKind);
  assertUuid(params.recipientId, 'recipientId');

  return `${AAD_PREFIX_V2}.ehk-grant|${params.environmentId}|${params.recipientKind}|${params.recipientId}`;
}

/**
 * Binds one User Key wrap to its owner and to the credential that opens it.
 *
 * All five recovery wraps hold the same UK, so without `lookupHashHex` a swapped
 * row would go undetected; with it, a swap fails loudly. `credentialIdB64Url`
 * plays the same role for passkey wraps. The passphrase wrap needs no such
 * discriminator — there is only ever one.
 */
export function userKeyWrapAad(
  params:
    | { userId: string; wrapKind: 'passphrase' }
    | { userId: string; wrapKind: 'recovery'; lookupHashHex: string }
    | { userId: string; wrapKind: 'prf'; credentialIdB64Url: string },
): string {
  assertUuid(params.userId, 'userId');
  assertWrapKind(params.wrapKind);

  const head = `${AAD_PREFIX_V2}.uk-wrap|${params.userId}|${params.wrapKind}`;

  if (params.wrapKind === 'recovery') {
    assertComponent(params.lookupHashHex, 'lookupHashHex');
    return `${head}|${params.lookupHashHex}`;
  }

  if (params.wrapKind === 'prf') {
    assertComponent(params.credentialIdB64Url, 'credentialIdB64Url');
    return `${head}|${params.credentialIdB64Url}`;
  }

  return head;
}

/**
 * Binds a browser's device-PIN wrap of the User Key to its owner and to that
 * browser.
 *
 * Both components are load-bearing and for different reasons. `userId` is the
 * ordinary one: the wrap holds that account's User Key and must not open as
 * anybody else's. `deviceId` is what stops a wrap being moved between two
 * enrolments of the *same* account — two browsers hold two wraps of one User
 * Key, each with its own pepper row, and without the discriminator a wrap
 * copied from one `localStorage` to another would open against the other's
 * pepper as soon as the same PIN was typed.
 *
 * Not a `wrapKind` of {@link userKeyWrapAad}, deliberately. That purpose names
 * rows of `user_key_wraps`, and a PIN wrap is never stored on this server at
 * all (spec §13.3) — giving it a kind there would put a fourth value into a
 * column's CHECK for a ciphertext that column will never hold.
 */
export function devicePinWrapAad(params: { userId: string; deviceId: string }): string {
  assertUuid(params.userId, 'userId');
  assertUuid(params.deviceId, 'deviceId');

  return `${AAD_PREFIX_V2}.pin-wrap|${params.userId}|${params.deviceId}`;
}

/** Binds a user's encrypted X25519 private key to its owner. */
export function privateKeyEncAad(userId: string): string {
  assertUuid(userId, 'userId');
  return `${AAD_PREFIX_V2}.privkey-enc|${userId}`;
}

/** Binds a user's encrypted Ed25519 private key to its owner. */
export function privateKeySignAad(userId: string): string {
  assertUuid(userId, 'userId');
  return `${AAD_PREFIX_V2}.privkey-sign|${userId}`;
}

/**
 * Binds the User Key wrap that carries a vault across to `xecret login`.
 *
 * The one blob in this file that is never stored (spec §2.2 type 11, §13.2). It
 * exists for the length of one loopback redirect: the consent screen seals the
 * User Key to an ephemeral X25519 key the CLI generated and put in the authorize
 * URL, and the CLI process opens it on `127.0.0.1`. The server sees neither half.
 *
 * The two components are what identify this login and nothing else. The **PKCE
 * code challenge** names the authorization attempt — only the process holding
 * the verifier can complete it — so a wrap captured from one login cannot be
 * replayed into another. The **hand-off public key** names the recipient, so a
 * page cannot substitute a wrap sealed to a key it chose without also knowing a
 * challenge it never saw. Neither is a UUID, and both are base64url, which the
 * component pattern already admits.
 */
export function cliHandoffAad(params: { codeChallenge: string; handoffPublicKey: string }): string {
  assertComponent(params.codeChallenge, 'codeChallenge');
  assertComponent(params.handoffPublicKey, 'handoffPublicKey');

  return `${AAD_PREFIX_V2}.cli-handoff|${params.codeChallenge}|${params.handoffPublicKey}`;
}

/**
 * Whether a string is a well-formed v2 AAD.
 *
 * Used by the HKDF layer, where a sealed box passes its AAD as the `info`
 * string: the info registry is closed, and this is what admits the one entry
 * that is not a fixed constant.
 */
export function isAadV2(value: string): boolean {
  return /^xecret\.aad\.v2\.[a-z-]+(\|[0-9a-zA-Z_-]+)+$/.test(value);
}

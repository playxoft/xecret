import * as z from 'zod/mini';
import { environmentKeyInitSchema } from './env-keys';
import { uuidField } from './ids';
import {
  clientValueSchema,
  expectedVersionSchema,
  secretBlobSchema,
  secretIdSchema,
} from './secrets';

/**
 * The wire shapes of the upgrade from server-side to end-to-end encryption
 * (ADR 0009, Phase 5): `GET …/encryption-upgrade` (what it will do),
 * `GET …/encryption-upgrade/material` (the values to re-encrypt) and
 * `POST …/encryption-upgrade` (the re-encrypted environment).
 *
 * ── Nothing here is new, on purpose ──
 * Every cryptographic field is one the ordinary end-to-end encrypted write path
 * already accepts, through the schema it already uses: the key initialisation is
 * `environmentKeyInitSchema` verbatim — the creator's own grant, shape-checked
 * exactly as environment creation and the repair endpoint check it — and every
 * value is `clientValueSchema`, the body `PATCH …/secrets/{name}` takes. A
 * blob the upgrade accepts is a blob any e2ee write would have accepted, and the
 * server validates the shape and never the meaning, for the reason
 * `schemas/env-keys.ts` gives.
 *
 * What the upgrade adds is identity, not cryptography: each value names the
 * version row it replaces, by id and by number, and each secret the revision it
 * was read at — because the whole of its safety is that the set the browser
 * re-encrypted is exactly the set stored, and the transaction checks that.
 */

const UNEXPECTED_FIELD = 'The request contains a field this endpoint does not accept.';

/**
 * The most versions one upgrade rewrites, and therefore the most secrets.
 *
 * The rewrite is set-based (ten statements for the full five thousand — see
 * `reencryptVersionsInPlace`), but it is one transaction holding the
 * environment's rows, and the material read that feeds it decrypts every
 * version in one Worker request. Five thousand is many times the largest
 * environment this deployment has ever held; one that exceeds it is refused,
 * whole and with nothing changed, and is a conversation with support rather
 * than a transaction that runs for a minute.
 */
export const MAX_UPGRADE_VERSIONS = 5_000;

/** Every secret carries at least one version, so this can never bind first. */
export const MAX_UPGRADE_SECRETS = MAX_UPGRADE_VERSIONS;

/** Deleted secrets and keyless tokens an upgrade names. Bounded like any list. */
const MAX_UPGRADE_SIDE_EFFECTS = 5_000;

/**
 * The request ceiling for the upgrade, above the 1 MB every other route keeps.
 *
 * The upgrade carries an environment's whole history in one request, because
 * the switch has to be one transaction: a history split across requests would
 * spend some window with part of the environment under a key the server holds
 * and part under one it does not. Eight megabytes is a few thousand ordinary
 * versions; an environment larger than that is refused with a 413 before
 * anything is parsed, and nothing is changed.
 */
export const MAX_UPGRADE_BODY_BYTES = 8 * 1024 * 1024;

/**
 * An upper estimate of the POST body an upgrade of this history will take,
 * from sizes the database can sum without decrypting anything.
 *
 * A server-envelope ciphertext is the plaintext plus a 16-byte tag (its IV is a
 * column of its own), and the browser's `xk2.gcm.` blob of the same plaintext is
 * the prefix and the base64url of IV, plaintext and tag — 12 more bytes, times
 * four thirds, rounded up per row. A note's blob is the same shape over its
 * UTF-8. Around each, the JSON the body wraps it in: ids, the version, the
 * HMAC, the key id — a generous fixed allowance per version and per secret,
 * and one for the grant and the lists.
 */
export function estimateUpgradeBodyBytes(history: {
  liveSecretCount: number;
  versionCount: number;
  ciphertextBytes: number;
  noteCount: number;
  noteBytes: number;
  deletedSecrets: readonly unknown[];
  keylessTokens: readonly unknown[];
}): number {
  const blobs = (bytes: number, rows: number) => ((bytes + 12 * rows) * 4) / 3 + 12 * rows;
  return Math.ceil(
    blobs(history.ciphertextBytes, history.versionCount) +
      256 * history.versionCount +
      blobs(history.noteBytes + 28 * history.noteCount, history.noteCount) +
      128 * history.liveSecretCount +
      40 * (history.deletedSecrets.length + history.keylessTokens.length) +
      2048,
  );
}

const MALFORMED_REVISION = 'A revision is the number the material endpoint returned.';

const upgradedVersionSchema = z.strictObject(
  {
    /** The `secret_versions` row this value replaces. */
    id: uuidField('A version is named by a UUID.'),
    /** Its version number — and the one bound into the new ciphertext's AAD. */
    version: expectedVersionSchema,
    /** Exactly what `PATCH …/secrets/{name}` accepts for an e2ee value. */
    value: clientValueSchema,
  },
  UNEXPECTED_FIELD,
);

const upgradedSecretSchema = z.strictObject(
  {
    id: secretIdSchema,
    /** `HistorySecret.revision`, echoed. Detects a note or a version written since. */
    revision: z.string().check(z.regex(/^[0-9]{1,20}$/, MALFORMED_REVISION)),
    /** The note sealed under the new key, or `null` for a secret with none. */
    encNote: z.nullable(secretBlobSchema),
    versions: z
      .array(upgradedVersionSchema)
      .check(
        z.maxLength(
          MAX_UPGRADE_VERSIONS,
          `One upgrade cannot rewrite more than ${MAX_UPGRADE_VERSIONS} versions.`,
        ),
      ),
  },
  UNEXPECTED_FIELD,
);

export const encryptionUpgradeBody = z.strictObject(
  {
    /**
     * The `env_data_keys` id the new key will have, chosen by the client
     * because every value below states the key it was sealed against and the
     * server checks each one against this before storing any.
     */
    envDataKeyId: uuidField('A key is named by a UUID.'),
    /** The new key's initialisation: the upgrader's own grant on version 1. */
    keys: environmentKeyInitSchema,
    secrets: z
      .array(upgradedSecretSchema)
      .check(
        z.maxLength(
          MAX_UPGRADE_SECRETS,
          `One upgrade cannot carry more than ${MAX_UPGRADE_SECRETS} secrets.`,
        ),
      ),
    /**
     * The soft-deleted secrets the person agreed to erase — every one the
     * environment holds, or the upgrade is refused. Named rather than implied,
     * so a secret deleted after the dialog was read is not erased unseen.
     */
    eraseSecretIds: z
      .array(uuidField('A secret is named by a UUID.'))
      .check(z.maxLength(MAX_UPGRADE_SIDE_EFFECTS)),
    /** Likewise the keyless CI tokens the person agreed to revoke. */
    revokeTokenIds: z
      .array(uuidField('A token is named by a UUID.'))
      .check(z.maxLength(MAX_UPGRADE_SIDE_EFFECTS)),
  },
  UNEXPECTED_FIELD,
);

export type EncryptionUpgradeBody = z.infer<typeof encryptionUpgradeBody>;

/**
 * Why a caller cannot upgrade an environment, in stable words a client can
 * branch on.
 *
 *  - `already-e2ee` — there is nothing to upgrade.
 *  - `not-a-person` — a token; the key has to be made in a browser.
 *  - `not-permitted` — not `admin` on the environment, or a custom role without
 *    one of the secret actions an upgrade performs.
 *  - `no-vault` — nothing to seal the new key to yet.
 *  - `token-revoke` — CI tokens would be revoked, and that is an owner's or an
 *    admin's act.
 */
export type UpgradeBlocker =
  'already-e2ee' | 'not-a-person' | 'not-permitted' | 'no-vault' | 'token-revoke';

/** What an upgrade would do. Counts and names — never a value, never a note. */
export interface EncryptionUpgradeDetails {
  liveSecretCount: number;
  versionCount: number;
  noteCount: number;
  /** Erased by the upgrade: they cannot be re-encrypted, and they pin the server's key. */
  deletedSecrets: { id: string; name: string }[];
  /** Revoked by the upgrade: nothing can be sealed to a token with no key half. */
  keylessTokens: { id: string; name: string; tokenPrefix: string }[];
  /**
   * Members other than the caller, and sealable tokens, who may read the
   * environment — everybody the new key has to be shared with afterwards. An
   * upgrade runs without asking only when this is zero.
   */
  otherEntitledCount: number;
}

/**
 * `GET …/encryption-upgrade`: whether this caller can upgrade, why not, and —
 * for a caller who holds the upgrade's permissions — what it would do.
 *
 * Always a 200 for a member of the environment, never a refusal: the dashboard
 * asks it on every view of a `server`-mode environment, and "you cannot do
 * this" is an answer, not an event worth auditing.
 */
export interface EncryptionUpgradePreview {
  encryptionMode: 'server' | 'e2ee';
  environmentId: string;
  canUpgrade: boolean;
  /** Empty when `canUpgrade`. */
  reasons: UpgradeBlocker[];
  /**
   * `null` for a caller without the upgrade's permissions: the token names and
   * deleted-secret names it carries are not theirs to read.
   */
  details: EncryptionUpgradeDetails | null;
}

/** `GET …/encryption-upgrade/material`: every value the browser re-encrypts. */
export interface EncryptionUpgradeMaterial {
  /** The first component of every AAD the browser builds — checked against its own. */
  orgId: string;
  environmentId: string;
  secrets: {
    id: string;
    name: string;
    valueType: string;
    note: string | null;
    revision: string;
    versions: { id: string; version: number; value: string }[];
  }[];
  /** The same two lists the preview showed, re-read with the values. */
  deletedSecrets: { id: string; name: string }[];
  keylessTokens: { id: string; name: string; tokenPrefix: string }[];
}

/** `POST …/encryption-upgrade`'s answer. Counts and the new key's identity. */
export interface EncryptionUpgradeResult {
  activeEdk: { id: string; version: number };
  secretCount: number;
  versionCount: number;
  noteCount: number;
  erasedSecretCount: number;
  revokedTokenCount: number;
}

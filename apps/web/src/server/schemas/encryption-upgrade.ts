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
 * The most secrets one upgrade may carry: the largest environment any plan
 * allows (`secretsPerEnvironment`, 25,000), so no environment is too big by
 * count. What actually binds is the body size — see `MAX_UPGRADE_BODY_BYTES`.
 */
export const MAX_UPGRADE_SECRETS = 25_000;

/** The most versions one upgrade rewrites. Each is one UPDATE inside one transaction. */
export const MAX_UPGRADE_VERSIONS = 50_000;

/** Deleted secrets and keyless tokens an upgrade names. Bounded like any list. */
const MAX_UPGRADE_SIDE_EFFECTS = 25_000;

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
 * `GET …/encryption-upgrade`: what an upgrade would do, and whether this caller
 * may do it. Counts and names — never a value, never a note.
 */
export interface EncryptionUpgradePreview {
  encryptionMode: 'server';
  environmentId: string;
  liveSecretCount: number;
  versionCount: number;
  noteCount: number;
  /** Erased by the upgrade: they cannot be re-encrypted, and they pin the server's key. */
  deletedSecrets: { id: string; name: string }[];
  /** Revoked by the upgrade: nothing can be sealed to a token with no key half. */
  keylessTokens: { id: string; name: string; tokenPrefix: string }[];
  /**
   * Whether this caller may perform it: a person with a vault, `admin` on the
   * environment, and — only when there are keyless tokens to revoke —
   * `token.revoke`. The POST asks the same questions again.
   */
  mayUpgrade: boolean;
  /** Why not, in one stable word, when `mayUpgrade` is false. */
  blockedBy: 'no-vault' | 'token-revoke' | null;
}

/** `GET …/encryption-upgrade/material`: every value the browser re-encrypts. */
export interface EncryptionUpgradeMaterial {
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

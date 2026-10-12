import { toHex } from '../crypto/client/bytes';
import { deriveStretchedKey } from '../crypto/client/kdf';
import type { Argon2idProvider } from '../crypto/client/kdf';
import { encryptionPublicKey } from '../crypto/client/keypair';
import {
  deriveRecoveryKey,
  parseRecoveryCode,
  recoveryLookupHash,
} from '../crypto/client/recovery';
import { decryptSecret } from '../crypto/client/secret';
import {
  derivePassphraseWrapKey,
  openGrant,
  unwrapPrivateKey,
  unwrapUserKey,
} from '../crypto/client/wraps';
import { fromBase64Url, timingSafeEqual, zeroize } from '../crypto/encoding';
import { DecryptionError } from '../crypto/types';
import type { Bytes } from '../crypto/types';
import { ARCHIVE_MAX_DOCUMENT_BYTES, parseArchiveDocument } from './document';
import type { ArchiveEnvironment, VaultArchiveDocument } from './document';
import { ArchiveFormatError } from './errors';
import { looksLikeZip, readZipEntry } from './zip';
import type { InflateRaw } from './zip';

/**
 * Opening a vault escape archive, as spec §14.5 defines it.
 *
 * ── Two steps, and why they are separate ──
 * {@link readArchiveFile} needs no credential: it takes the file apart and
 * validates the document, so a screen can say "this archive was made on 12
 * October and holds three environments" — and a hostile or damaged file is
 * refused — before anybody types a passphrase. {@link openArchive} then takes the
 * credential and produces plaintext, in memory, in this process, and nowhere
 * else.
 *
 * ── What failure looks like ──
 * The credential either opens the User Key or does not, and when it does not
 * the answer is the uniform `DecryptionError` — a wrong passphrase, a wrong
 * recovery code, and a code that matches no wrap in this file are one outcome,
 * as on the server. A recovery code with a bad check character is the
 * exception, reported as a typo (`RecoveryCodeError`) by the parser, because it
 * says nothing about the vault and everything about the keyboard.
 *
 * After the User Key opens, nothing stops at the first failure. Each value comes
 * back `ok`, `no-key` (this account never held that key version), or `damaged`
 * (it should have opened and did not). A person holding a half-damaged archive
 * wants the other half.
 */

export type ArchiveCredential =
  { kind: 'passphrase'; passphrase: string } | { kind: 'recovery-code'; code: string };

export type SecretOutcome = 'ok' | 'no-key' | 'damaged';

export interface OpenedSecret {
  secretId: string;
  name: string;
  valueType: string;
  version: number;
  updatedAt: string;
  outcome: SecretOutcome;
  /** The plaintext, when `outcome` is `ok`; otherwise `null`. */
  value: string | null;
  /** The note, when one exists and some key of the environment opened it. */
  note: string | null;
  /** True when a note exists and no key of the environment opened it. Not an error. */
  noteUnavailable: boolean;
}

export type OpenedEnvironment = Omit<ArchiveEnvironment, 'keys' | 'secrets'> & {
  /** Key versions whose grant failed to open. Their values are `damaged`. */
  damagedKeyVersions: number[];
  secrets: OpenedSecret[];
};

export interface OpenedArchive {
  archiveId: string;
  part: number;
  parts: number;
  createdAt: string;
  userId: string;
  environments: OpenedEnvironment[];
}

/**
 * Takes an archive file apart and validates its document. No credential, no
 * key, no plaintext.
 *
 * Accepts the ZIP the server sends and a bare `archive.json` a person extracted
 * from it (§14.1). Deflated entries — what a desktop tool produces if somebody
 * re-zips the file — are inflated with the platform's `DecompressionStream`
 * unless `inflateRaw` is supplied.
 */
export async function readArchiveFile(
  file: Uint8Array,
  options: { inflateRaw?: InflateRaw } = {},
): Promise<VaultArchiveDocument> {
  let json: Uint8Array;

  if (file.length > 0 && file[0] === 0x7b) {
    if (file.length > ARCHIVE_MAX_DOCUMENT_BYTES) {
      throw new ArchiveFormatError('archive.json is larger than any archive this reader accepts.');
    }
    json = file;
  } else if (looksLikeZip(file)) {
    json = await readZipEntry(file, 'archive.json', {
      maxBytes: ARCHIVE_MAX_DOCUMENT_BYTES,
      inflateRaw: options.inflateRaw,
    });
  } else {
    throw new ArchiveFormatError(
      'This is not a vault archive: expected a .zip or an archive.json.',
    );
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(json);
  } catch {
    throw new ArchiveFormatError('archive.json is not valid UTF-8.');
  }
  return parseArchiveDocument(text);
}

/**
 * Opens every value in a validated archive with one credential (§14.5).
 *
 * Throws `DecryptionError` when the credential does not open the vault,
 * `RecoveryCodeError` for a mistyped recovery code, `ArchiveFormatError` when
 * the file is internally inconsistent. Otherwise returns every environment and
 * every secret with its outcome.
 *
 * Every key it opens is zeroised before it returns, on every path.
 */
export async function openArchive(
  doc: VaultArchiveDocument,
  credential: ArchiveCredential,
  options: { argon2id?: Argon2idProvider } = {},
): Promise<OpenedArchive> {
  const userId = doc.account.userId;
  const userKey = await openUserKey(doc, credential, options.argon2id);

  let encPrivateKey: Bytes;
  try {
    encPrivateKey = await unwrapPrivateKey({
      userKey,
      blob: doc.vault.encPrivateKeyBlob,
      userId,
      purpose: 'encryption',
    });
  } finally {
    zeroize(userKey);
  }

  try {
    // §14.5 step 2. A private key that does not belong to the public key every
    // grant was sealed to would report every grant as damaged, for a reason
    // that has nothing to do with them.
    if (
      !timingSafeEqual(
        encryptionPublicKey(encPrivateKey),
        fromBase64Url(doc.vault.encPublicKeyB64Url),
      )
    ) {
      throw new ArchiveFormatError(
        'This archive is inconsistent: its private key does not match its public key.',
      );
    }

    const environments: OpenedEnvironment[] = [];
    for (const environment of doc.environments) {
      environments.push(await openEnvironment(environment, userId, encPrivateKey));
    }

    return {
      archiveId: doc.archiveId,
      part: doc.part,
      parts: doc.parts,
      createdAt: doc.createdAt,
      userId,
      environments,
    };
  } finally {
    zeroize(encPrivateKey);
  }
}

async function openUserKey(
  doc: VaultArchiveDocument,
  credential: ArchiveCredential,
  argon2id: Argon2idProvider | undefined,
): Promise<Bytes> {
  const userId = doc.account.userId;

  if (credential.kind === 'passphrase') {
    const stretched = await deriveStretchedKey({
      passphrase: credential.passphrase,
      salt: fromBase64Url(doc.vault.kdfSaltB64Url),
      params: doc.vault.kdfParams,
      ...(argon2id === undefined ? {} : { argon2id }),
    });
    const wrapKey = await derivePassphraseWrapKey(stretched);
    zeroize(stretched);
    try {
      return await unwrapUserKey({
        wrapKey,
        blob: doc.vault.passphraseWrapBlob,
        context: { userId, wrapKind: 'passphrase' },
      });
    } finally {
      zeroize(wrapKey);
    }
  }

  // A typo is a `RecoveryCodeError` from the parser and escapes as one.
  const code = parseRecoveryCode(credential.code);
  try {
    const lookupHash = await recoveryLookupHash(code.codeBytes);
    const lookupHashHex = toHex(lookupHash);
    const wrap = doc.vault.recoveryWraps.find((entry) => entry.lookupHashHex === lookupHashHex);

    // No matching wrap is the same answer as a wrap that does not open: the
    // uniform failure, as the server's recovery lookup gives.
    if (wrap === undefined) throw new DecryptionError();

    const recoveryKey = await deriveRecoveryKey(code.codeBytes);
    try {
      return await unwrapUserKey({
        wrapKey: recoveryKey,
        blob: wrap.wrapBlob,
        context: { userId, wrapKind: 'recovery', lookupHash },
      });
    } finally {
      zeroize(recoveryKey);
    }
  } finally {
    zeroize(code.codeBytes);
  }
}

interface OpenedKey {
  edkVersion: number;
  edk: Bytes;
}

async function openEnvironment(
  environment: ArchiveEnvironment,
  userId: string,
  encPrivateKey: Bytes,
): Promise<OpenedEnvironment> {
  const opened = new Map<string, OpenedKey>();
  const damagedKeyVersions: number[] = [];

  try {
    for (const key of environment.keys) {
      try {
        const { edk, ehk } = await openGrant({
          recipient: {
            environmentId: environment.environmentId,
            edkVersion: key.edkVersion,
            recipientKind: 'member',
            recipientId: userId,
          },
          recipientPrivateKey: encPrivateKey,
          grant: { edkSealed: key.edkSealedBlob, ehkSealed: key.ehkSealedBlob },
        });
        // The EHK keys `valueHmac`, which only a writer needs. A reader has no
        // use for it, so it does not outlive the grant it came out of.
        zeroize(ehk);
        opened.set(key.envDataKeyId, { edkVersion: key.edkVersion, edk });
      } catch (cause) {
        if (!(cause instanceof DecryptionError)) throw cause;
        damagedKeyVersions.push(key.edkVersion);
      }
    }

    const heldIds = new Set(environment.keys.map((key) => key.envDataKeyId));
    // Highest version first: the note was most likely written under the
    // newest key, and trying it first is one decryption instead of several.
    const byVersion = [...opened.values()].sort((a, b) => b.edkVersion - a.edkVersion);

    const secrets: OpenedSecret[] = [];
    for (const secret of environment.secrets) {
      const target = {
        orgId: environment.orgId,
        environmentId: environment.environmentId,
        secretId: secret.secretId,
      };

      let outcome: SecretOutcome;
      let value: string | null = null;
      const key = opened.get(secret.envDataKeyId);

      if (!heldIds.has(secret.envDataKeyId)) {
        outcome = 'no-key';
      } else if (key === undefined) {
        outcome = 'damaged';
      } else {
        try {
          value = await decryptSecret({
            edk: key.edk,
            context: { field: 'value', ...target, version: secret.version },
            blob: secret.valueBlob,
          });
          outcome = 'ok';
        } catch {
          // A tag that did not verify, or plaintext that is not UTF-8 (§2.2):
          // either way this value did not come out, and the rest still might.
          outcome = 'damaged';
        }
      }

      let note: string | null = null;
      let noteUnavailable = false;
      if (secret.noteBlob !== null) {
        for (const candidate of byVersion) {
          try {
            note = await decryptSecret({
              edk: candidate.edk,
              context: { field: 'note', ...target },
              blob: secret.noteBlob,
            });
            break;
          } catch {
            // The next key, if there is one.
          }
        }
        noteUnavailable = note === null;
      }

      secrets.push({
        secretId: secret.secretId,
        name: secret.name,
        valueType: secret.valueType,
        version: secret.version,
        updatedAt: secret.updatedAt,
        outcome,
        value,
        note,
        noteUnavailable,
      });
    }

    return {
      orgId: environment.orgId,
      orgName: environment.orgName,
      orgSlug: environment.orgSlug,
      projectId: environment.projectId,
      projectName: environment.projectName,
      projectSlug: environment.projectSlug,
      environmentId: environment.environmentId,
      environmentName: environment.environmentName,
      environmentSlug: environment.environmentSlug,
      isProduction: environment.isProduction,
      damagedKeyVersions,
      secrets,
    };
  } finally {
    for (const key of opened.values()) zeroize(key.edk);
  }
}

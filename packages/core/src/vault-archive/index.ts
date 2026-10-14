/**
 * The vault escape archive: `@xecret/core/vault-archive`.
 *
 * Everything a vault archive needs on both sides of the wire, and nothing else:
 * the document schema (§14.4), the ZIP container (§14.1), the writer the reset
 * route uses to assemble one from stored ciphertext, and the reader the import
 * screen uses to open one in the browser. Browser-safe throughout — Web Crypto,
 * `@noble/*` through the crypto layer, and the platform's `DecompressionStream`.
 *
 * A separate subpath rather than more exports from `./crypto/client`, so a
 * screen that never touches an archive never bundles a ZIP reader, and so the
 * crypto barrel stays a list of primitives.
 *
 * Deliberately absent: the vector builder under `vectors/`, which reaches the
 * crypto layer's randomness-injecting entry points and is test scaffolding.
 *
 * Spec: docs/security/e2ee-crypto-spec.md §14.
 */

export {
  ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  ARCHIVE_MAX_DOCUMENT_BYTES,
  ARCHIVE_MAX_KEYS_PER_ENVIRONMENT,
  ARCHIVE_MAX_PARTS,
  ARCHIVE_MAX_RECOVERY_WRAPS,
  ARCHIVE_REASON,
  isArchivableSecret,
  parseArchiveDocument,
  serializeArchiveDocument,
  toArchiveLabel,
  toArchiveSlug,
} from './document';
export type {
  ArchiveEnvironment,
  ArchiveKey,
  ArchiveRecoveryWrap,
  ArchiveSecret,
  ArchiveVault,
  VaultArchiveDocument,
} from './document';

export {
  ARCHIVE_PART_BUDGET_BYTES,
  archiveFileName,
  archiveReadme,
  encodeArchivePart,
  planArchiveParts,
} from './build';
export type { ArchiveFile, ArchiveInput, ArchivePlanOptions } from './build';

export { openArchive, readArchiveFile } from './open';
export type {
  ArchiveCredential,
  OpenedArchive,
  OpenedEnvironment,
  OpenedSecret,
  SecretOutcome,
} from './open';

export { ArchiveFormatError, ArchiveTooLargeError } from './errors';
export type { InflateRaw } from './zip';

/**
 * The archive's error classes.
 *
 * Kept apart from the crypto layer's on purpose, and mapped onto the same two
 * classes spec §5.2 draws:
 *
 * - {@link ArchiveFormatError} — the file is not a well-formed archive of the
 *   version this reader understands. A fact about bytes the holder already has,
 *   raised loudly and before any key is derived where it can be. Messages name
 *   *where* in the document the problem is, never the value found there.
 * - `DecryptionError` (from the crypto layer) — the credential did not open the
 *   vault. Uniform and detail-free, whichever part of the guess was wrong.
 *
 * {@link ArchiveTooLargeError} is a writer-side refusal: the vault holds more
 * than any number of parts this format allows.
 *
 * Spec: docs/security/e2ee-crypto-spec.md §14.
 */

export class ArchiveFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveFormatError';
  }
}

export class ArchiveTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveTooLargeError';
  }
}

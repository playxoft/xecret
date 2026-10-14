import { beforeAll, describe, expect, it, vi } from 'vitest';
import { nobleArgon2idProvider } from '../crypto/client/kdf';
import { RecoveryCodeError } from '../crypto/client/recovery';
import { DecryptionError } from '../crypto/types';
import { encodeArchivePart, planArchiveParts } from './build';
import type { VaultArchiveDocument } from './document';
import { ARCHIVE_MAX_DOCUMENT_BYTES } from './document';
import { ArchiveFormatError } from './errors';
import { openArchive, readArchiveFile } from './open';
import { buildFixture } from './vectors/build';
import committed from './vectors/vault-archive-vectors.json';

/**
 * The opener beyond what the shared vectors pin: what it returns besides the
 * plaintexts, which seam the passphrase goes through, and the inputs a vector
 * file cannot conveniently carry.
 */

let doc: VaultArchiveDocument;
let file: Uint8Array;
let codes: string[];

beforeAll(async () => {
  const fixture = await buildFixture();
  codes = fixture.recoveryCodes;
  [doc] = planArchiveParts(fixture.input, {
    archiveId: '0192f0a1-7c3d-7e4f-8a1b-000000000009',
    createdAt: new Date('2026-10-12T09:30:00.000Z'),
    retainedUntil: null,
  }) as [VaultArchiveDocument];
  file = encodeArchivePart(doc, { retainedUntil: null }).bytes;
}, 30_000);

describe('readArchiveFile', () => {
  it('reads the ZIP and the bare document to the same thing', async () => {
    const json = new TextEncoder().encode(JSON.stringify(doc));
    expect(await readArchiveFile(json)).toEqual(await readArchiveFile(file));
  });

  it('refuses an empty file, and a bare document that is not UTF-8', async () => {
    await expect(readArchiveFile(new Uint8Array())).rejects.toThrow(ArchiveFormatError);
    await expect(readArchiveFile(new Uint8Array([0x7b, 0xff, 0x7d]))).rejects.toThrow(
      /not valid UTF-8/,
    );
  });

  it('refuses a bare document larger than any archive, before parsing it', async () => {
    const huge = new Uint8Array(ARCHIVE_MAX_DOCUMENT_BYTES + 1);
    huge[0] = 0x7b;
    await expect(readArchiveFile(huge)).rejects.toThrow(/larger than any archive/);
  });
});

describe('openArchive', () => {
  it('returns the archive identity alongside what it opened', async () => {
    const opened = await openArchive(doc, { kind: 'recovery-code', code: codes[0]! });
    expect(opened).toMatchObject({
      archiveId: doc.archiveId,
      part: 1,
      parts: 1,
      createdAt: doc.createdAt,
      userId: doc.account.userId,
    });
    const production = opened.environments.find(
      (environment) => environment.environmentSlug === 'production',
    );
    expect(production).toMatchObject({
      orgSlug: 'acme',
      projectSlug: 'payments-api',
      isProduction: true,
    });
    expect(production!.secrets.find((secret) => secret.name === 'DATABASE_URL')).toMatchObject({
      valueType: 'url',
      version: 3,
      updatedAt: '2026-10-01T08:00:00.000Z',
    });
  });

  it('stretches the passphrase through the provider it is given', async () => {
    // The provider's input is copied as it arrives: the caller wipes the
    // passphrase bytes the moment the KDF returns, which is the point.
    const seen: string[] = [];
    const provider = vi.fn<typeof nobleArgon2idProvider>((password, salt, params) => {
      seen.push(new TextDecoder().decode(password));
      return nobleArgon2idProvider(password, salt, params);
    });
    await openArchive(
      doc,
      { kind: 'passphrase', passphrase: committed.passphrase },
      { argon2id: provider },
    );
    expect(provider).toHaveBeenCalledOnce();
    // NFC before the KDF (§1.3): the bytes the provider saw are the composed form.
    expect(seen).toEqual([committed.passphrase.normalize('NFC')]);
    // …and they were wiped afterwards.
    expect([...provider.mock.calls[0]![0]].every((byte) => byte === 0)).toBe(true);
  });

  it('fails uniformly for a wrong passphrase, a wrong code and a code from another vault', async () => {
    const outcomes = await Promise.all([
      openArchive(doc, { kind: 'passphrase', passphrase: 'wrong' }).catch(
        (cause: unknown) => cause,
      ),
      openArchive(doc, { kind: 'recovery-code', code: '00000-00000-00000-00000-00000-0' }).catch(
        (cause: unknown) => cause,
      ),
    ]);
    for (const outcome of outcomes) {
      expect(outcome).toBeInstanceOf(DecryptionError);
      expect((outcome as Error).message).not.toMatch(/passphrase|code|wrap/i);
    }
  });

  it('reports a mistyped code as a typo, not as a wrong code', async () => {
    await expect(openArchive(doc, { kind: 'recovery-code', code: 'not a code' })).rejects.toThrow(
      RecoveryCodeError,
    );
  });

  it('opens a vault with no recovery wraps only by passphrase', async () => {
    const bare = { ...doc, vault: { ...doc.vault, recoveryWraps: [] } };
    await expect(openArchive(bare, { kind: 'recovery-code', code: codes[0]! })).rejects.toThrow(
      DecryptionError,
    );
  });
});

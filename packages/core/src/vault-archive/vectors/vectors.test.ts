import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { fromHex, toHex } from '../../crypto/client/bytes';
import { RecoveryCodeError } from '../../crypto/client/recovery';
import { DecryptionError } from '../../crypto/types';
import { parseArchiveDocument } from '../document';
import { ArchiveFormatError } from '../errors';
import { openArchive, readArchiveFile } from '../open';
import type { ArchiveCredential, OpenedArchive } from '../open';
import { buildArchiveVectorFile } from './build';
import type { ArchiveVector, ArchiveVectorFile } from './build';
import schema from './vault-archive-vectors.schema.json';
import committed from './vault-archive-vectors.json';

/**
 * The vault archive's cross-implementation contract, from the TypeScript side.
 *
 * Three things happen here, and the Go suite does the last two against the same
 * file:
 *
 * 1. The committed file is rebuilt from the writer and compared **byte for
 *    byte** — the ZIP included — so a writer that drifts, or a format change
 *    nobody regenerated, fails here.
 * 2. Every `open` and `split` vector is replayed through the reader: the bytes
 *    in the file, opened with the credential in the file, must yield exactly
 *    the plaintexts the fixture encrypted.
 * 3. Every `reject` vector must fail, and in the error class it names.
 */

const file = committed as unknown as ArchiveVectorFile;

const byId = new Map(file.vectors.map((vector) => [vector.id, vector]));
const of = (kind: ArchiveVector['kind']) => file.vectors.filter((vector) => vector.kind === kind);

/** The file bytes a vector's input names: a referenced file vector, inline hex, or JSON text. */
function fileBytes(input: Record<string, unknown>): Uint8Array {
  if (typeof input['fileVector'] === 'string') {
    const source = byId.get(input['fileVector']);
    if (source === undefined) throw new Error(`no vector ${String(input['fileVector'])}`);
    return fromHex(source.expected['fileHex'] as string);
  }
  if (typeof input['fileHex'] === 'string') return fromHex(input['fileHex']);
  return new TextEncoder().encode(input['jsonText'] as string);
}

/** Only what the vectors pin, in the shape they pin it. */
function summary(opened: OpenedArchive) {
  return opened.environments.map((environment) => ({
    environmentId: environment.environmentId,
    damagedKeyVersions: environment.damagedKeyVersions,
    secrets: environment.secrets.map((secret) => ({
      name: secret.name,
      outcome: secret.outcome,
      value: secret.value,
      note: secret.note,
      noteUnavailable: secret.noteUnavailable,
    })),
  }));
}

function errorClass(cause: unknown): string {
  if (cause instanceof ArchiveFormatError) return 'format';
  if (cause instanceof DecryptionError) return 'decryption';
  if (cause instanceof RecoveryCodeError) return 'recovery-code';
  return `unexpected: ${String(cause)}`;
}

describe('the archive vector file', () => {
  it('validates against its schema', () => {
    const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
    ajv.addFormat('date-time', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);

    const validate = ajv.compile(schema);
    const valid = validate(committed);

    expect(validate.errors ?? [], JSON.stringify(validate.errors, null, 2)).toEqual([]);
    expect(valid).toBe(true);
  });

  it('is exactly what the writer produces today, byte for byte', async () => {
    const rebuilt = await buildArchiveVectorFile({
      generatedAt: file.generatedAt,
      generator: file.generator,
    });

    // One assertion per vector, so a drift names the vector that drifted.
    expect(rebuilt.vectors.map((vector) => vector.id)).toEqual(
      file.vectors.map((vector) => vector.id),
    );
    for (const vector of rebuilt.vectors) {
      expect(vector, vector.id).toEqual(byId.get(vector.id));
    }
    expect(rebuilt.passphrase).toBe(file.passphrase);
    expect(rebuilt.recoveryCodes).toEqual(file.recoveryCodes);
  }, 60_000);

  it('carries every kind, and a passphrase NFC actually changes', () => {
    for (const kind of [
      'vault-archive/file',
      'vault-archive/open',
      'vault-archive/split',
      'vault-archive/reject',
    ] as const) {
      expect(of(kind).length, kind).toBeGreaterThan(0);
    }
    expect(file.passphrase.normalize('NFC')).not.toBe(file.passphrase);
  });
});

describe('the file vector', () => {
  it.each(of('vault-archive/file'))(
    '$id: holds the document it states, and its digest',
    async (vector) => {
      const bytes = fromHex(vector.expected['fileHex'] as string);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

      expect(toHex(digest)).toBe(vector.expected['sha256Hex']);
      expect(await readArchiveFile(bytes)).toEqual(
        parseArchiveDocument(vector.expected['archiveJson'] as string),
      );
    },
  );
});

describe('opening', () => {
  it.each(of('vault-archive/open'))(
    '$id',
    async (vector) => {
      const doc = await readArchiveFile(fileBytes(vector.input));
      const opened = await openArchive(doc, vector.input['credential'] as ArchiveCredential);

      expect(summary(opened)).toEqual(vector.expected['environments']);
    },
    30_000,
  );
});

describe('a split archive', () => {
  it.each(of('vault-archive/split'))(
    '$id: every part opens alone, and together they hold each secret once',
    async (vector) => {
      const parts = (vector.input['partsHex'] as string[]).map(fromHex);
      const limit = vector.input['maxPartBytes'] as number;
      expect(parts).toHaveLength(vector.expected['parts'] as number);

      const seen: string[] = [];
      const ids = new Set<string>();
      for (const [index, bytes] of parts.entries()) {
        expect(bytes.length).toBeLessThanOrEqual(limit);
        const doc = await readArchiveFile(bytes);
        expect(doc.part).toBe(index + 1);
        expect(doc.parts).toBe(parts.length);
        ids.add(doc.archiveId);

        const opened = await openArchive(doc, vector.input['credential'] as ArchiveCredential);
        const names = opened.environments.map((environment) => ({
          environmentId: environment.environmentId,
          names: environment.secrets.map((secret) => secret.name),
        }));
        expect(names).toEqual((vector.expected['partSecretNames'] as unknown[])[index]);

        for (const environment of opened.environments) {
          for (const secret of environment.secrets)
            seen.push(`${environment.environmentId}/${secret.name}`);
        }
      }

      expect(ids.size).toBe(1);
      expect(new Set(seen).size).toBe(seen.length);

      // Between them, the parts hold exactly the single archive's secrets.
      const whole = await readArchiveFile(fileBytes({ fileVector: 'vault-archive/file/single' }));
      const all = whole.environments.flatMap((environment) =>
        environment.secrets.map((secret) => `${environment.environmentId}/${secret.name}`),
      );
      expect([...seen].sort()).toEqual([...all].sort());
    },
    30_000,
  );
});

describe('refusing', () => {
  it.each(of('vault-archive/reject'))(
    '$id',
    async (vector) => {
      let failure: unknown = null;
      try {
        const doc = await readArchiveFile(fileBytes(vector.input));
        const credential = vector.input['credential'] as ArchiveCredential | undefined;
        if (credential !== undefined) await openArchive(doc, credential);
      } catch (cause) {
        failure = cause;
      }

      expect(failure, 'the vector must be refused').not.toBeNull();
      expect(errorClass(failure)).toBe(vector.expected['errorClass']);
    },
    30_000,
  );
});

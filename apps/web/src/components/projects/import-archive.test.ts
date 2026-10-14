import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DecryptionError,
  decryptSecret,
  generateEnvironmentDataKey,
  generateEnvironmentHmacKey,
  RecoveryCodeError,
} from '@xecret/core/crypto/client';
import { ArchiveFormatError, openArchive, readArchiveFile } from '@xecret/core/vault-archive';
import type { OpenedArchive } from '@xecret/core/vault-archive';
import vectors from '../../../../../packages/core/src/vault-archive/vectors/vault-archive-vectors.json';

const posted = vi.hoisted(() => [] as { path: string; body: unknown }[]);

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: {
    get: vi.fn(async () => ({ data: [], nextCursor: null })),
    post: vi.fn(async (path: string, body: unknown) => {
      posted.push({ path, body });
      return { dryRun: false, counts: { create: 3, overwrite: 0, unchanged: 0 }, items: [] };
    }),
  },
}));

// The dialog portals its content, and a server render has nowhere to portal
// to; rendering it in place is what lets the copy be asserted.
vi.mock('@/components/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui')>();
  const { createElement: h } = await import('react');
  return {
    ...actual,
    DialogContent: ({ children }: { children?: unknown }) => h('div', null, children as never),
  };
});

const { clientSecretIo, serverSecretIo } = await import('@/components/envkeys');
const { holdEnvKey } = await import('@/components/envkeys/env-key-store');
const { defaultMapping, importableValues, importValues, mappingProblem, summarise } =
  await import('./import-archive');
const { describeOpenFailure, ImportArchiveDialog } = await import('./import-archive-dialog');

/**
 * Importing an archive into a project: the default mapping, what is importable,
 * and — the property the whole design rests on — that for an end-to-end-
 * encrypted environment the request that leaves the browser carries ciphertext
 * and never a value.
 *
 * The archive is the shared vector file's: written by the real writer, opened
 * here by the real reader with the fixture's recovery code.
 */

async function openedFixture(): Promise<OpenedArchive> {
  const file = vectors.vectors.find((vector) => vector.id === 'vault-archive/file/single')!;
  const hex = (file.expected as { fileHex: string }).fileHex;
  const bytes = Uint8Array.from(hex.match(/../g)!, (pair) => Number.parseInt(pair, 16));
  return openArchive(await readArchiveFile(bytes), {
    kind: 'recovery-code',
    code: vectors.recoveryCodes[0]!,
  });
}

const production = (archive: OpenedArchive) =>
  archive.environments.find((environment) => environment.environmentSlug === 'production')!;

describe('the default mapping', () => {
  it('maps only environments of this very project, by slug', async () => {
    const archive = await openedFixture();
    const mapping = defaultMapping(archive, {
      orgSlug: 'acme',
      projectSlug: 'payments-api',
      environments: [
        { slug: 'production', name: 'Production', encryptionMode: 'e2ee' },
        { slug: 'staging', name: 'Staging', encryptionMode: 'e2ee' },
      ],
    });

    expect(mapping[production(archive).environmentId]).toBe('production');
    // acme/web/staging shares a slug with this project's staging, and is not
    // this project's: it starts as "don't import".
    const webStaging = archive.environments.find(
      (environment) => environment.projectSlug === 'web',
    )!;
    expect(mapping[webStaging.environmentId]).toBeNull();
  });

  it('refuses two archive environments poured into one target, and an empty plan', () => {
    expect(mappingProblem({ a: 'production', b: 'production' })).toMatch(/one environment/);
    expect(mappingProblem({ a: null })).toMatch(/at least one/);
    expect(mappingProblem({ a: 'production', b: 'staging', c: null })).toBeNull();
  });
});

describe('what is importable', () => {
  it('is every value that opened, and nothing that did not', async () => {
    const values = importableValues(production(await openedFixture()));

    expect(Object.keys(values).sort()).toEqual([
      'DATABASE_URL',
      'EMPTY_FLAG',
      'GREETING',
      'LEGACY_TOKEN',
      'NOTE_UNDER_OLD_KEY',
    ]);
    expect(values['EMPTY_FLAG']).toBe('');
    expect(summarise(production(await openedFixture()))).toEqual({
      importable: 5,
      noKey: 1,
      damaged: 1,
      notes: 3,
    });
  });
});

describe('importing into an end-to-end-encrypted environment', () => {
  it('sends ciphertext that opens to the archive value, and no value at all', async () => {
    posted.length = 0;
    const archive = await openedFixture();
    const values = importableValues(production(archive));
    const material = {
      environmentId: '0192f0a1-0000-7000-8000-0000000000e1',
      envDataKeyId: '0192f0a1-0000-7000-8000-0000000000e2',
      edkVersion: 1,
      edk: generateEnvironmentDataKey(),
      ehk: generateEnvironmentHmacKey(),
    };
    // Held, as `openEnvironmentKeys` holds it: the IO leases what the store holds.
    holdEnvKey(material);
    const io = clientSecretIo(
      {
        orgSlug: 'acme',
        orgId: '0192f0a1-0000-7000-8000-0000000000e3',
        projectSlug: 'api',
        envSlug: 'production',
      },
      material,
    );

    await importValues({ io, values, strategy: 'skip', dryRun: false });

    expect(posted).toHaveLength(1);
    const wire = JSON.stringify(posted[0]!.body);
    for (const value of Object.values(values).filter((value) => value.length >= 4)) {
      expect(wire).not.toContain(value);
      expect(wire).not.toContain(JSON.stringify(value).slice(1, -1));
    }

    // …and each entry is the archive's value, sealed for the row it names.
    const entries = (
      posted[0]!.body as {
        entries: {
          id: string;
          name: string;
          expectedVersion: number;
          value: { ciphertext: string };
        }[];
      }
    ).entries;
    for (const entry of entries) {
      const plaintext = await decryptSecret({
        edk: material.edk,
        context: {
          field: 'value',
          orgId: '0192f0a1-0000-7000-8000-0000000000e3',
          environmentId: material.environmentId,
          secretId: entry.id,
          version: entry.expectedVersion,
        },
        blob: entry.value.ciphertext,
      });
      expect(plaintext).toBe(values[entry.name]!.normalize('NFC'));
    }
  });

  it('goes through the ordinary server import for a server-mode environment', async () => {
    posted.length = 0;
    const io = serverSecretIo({
      orgSlug: 'acme',
      orgId: 'o',
      projectSlug: 'api',
      envSlug: 'legacy',
    });

    await importValues({ io, values: { A: 'one' }, strategy: 'overwrite', dryRun: true });

    expect(posted[0]).toMatchObject({
      path: expect.stringContaining('/import'),
      body: { content: '{"A":"one"}', format: 'json', strategy: 'overwrite', dryRun: true },
    });
  });
});

describe('the dialog', () => {
  it('starts by asking for the file, and says the passphrase stays in the browser', () => {
    const html = renderToStaticMarkup(
      createElement(ImportArchiveDialog, {
        open: true,
        onOpenChange: () => {},
        orgSlug: 'acme',
        orgId: 'o',
        projectSlug: 'api',
        environments: [],
        onImported: () => {},
      }),
    );
    expect(html).toContain('Import a vault archive');
    expect(html).toContain('neither is sent anywhere');
    expect(html).toContain('Archive file');
    expect(html).toContain('accept=".zip,.json,application/zip,application/json"');
  });

  it('says which credential, and which vault, did not open it', () => {
    expect(describeOpenFailure(new DecryptionError(), 'passphrase')).toMatch(
      /not your current one/,
    );
    expect(describeOpenFailure(new DecryptionError(), 'recovery-code')).toMatch(
      /vault that was reset/,
    );
    expect(describeOpenFailure(new RecoveryCodeError('checksum'), 'recovery-code')).toMatch(/typo/);
    expect(describeOpenFailure(new ArchiveFormatError('not an archive'), 'passphrase')).toBe(
      'not an archive',
    );
  });
});

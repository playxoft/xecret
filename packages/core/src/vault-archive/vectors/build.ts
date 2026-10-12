import { sha256 } from '@noble/hashes/sha2.js';
import {
  edkGrantAad,
  ehkGrantAad,
  privateKeyEncAad,
  secretNoteAad,
  secretValueAad,
  userKeyWrapAad,
} from '../../crypto/aad';
import { formatGcmBlob } from '../../crypto/client/blob';
import { normalizedUtf8, toHex } from '../../crypto/client/bytes';
import { encryptGcmWithIv } from '../../crypto/client/gcm';
import { deriveStretchedKey } from '../../crypto/client/kdf';
import type { Argon2idParams } from '../../crypto/client/kdf';
import { encryptionPublicKey } from '../../crypto/client/keypair';
import {
  deriveRecoveryKey,
  encodeRecoveryCode,
  recoveryLookupHash,
} from '../../crypto/client/recovery';
import { sealToPublicKeyWithRandomness } from '../../crypto/client/sealed-box';
import { derivePassphraseWrapKey } from '../../crypto/client/wraps';
import { toBase64Url } from '../../crypto/encoding';
import type { Bytes } from '../../crypto/types';
import { encodeArchivePart, planArchiveParts } from '../build';
import type { ArchiveInput } from '../build';
import { serializeArchiveDocument } from '../document';
import type { ArchiveEnvironment, ArchiveSecret, VaultArchiveDocument } from '../document';
import { writeStoredZip } from '../zip';

/**
 * Builds `vault-archive-vectors.json`: an archive made by the real writer from a
 * fixture vault, and what opening it must produce.
 *
 * ── Nothing here is written by hand ──
 * The same rule as the crypto vectors' README. Every blob is produced by the
 * real constructions, every byte of the ZIP by the real writer, and every
 * expected plaintext is the input the fixture encrypted. What *is* pinned is the
 * randomness: each IV, ephemeral key and key is `SHA-256` of a fixed label, so a
 * rebuild produces the same bytes and the test can compare a fresh build with
 * the committed file.
 *
 * ── Why this reaches the internal entry points ──
 * `encryptGcmWithIv` and `sealToPublicKeyWithRandomness` take caller-supplied
 * randomness and are deliberately absent from every barrel. A vector cannot be
 * reproducible otherwise. This module is test scaffolding: the `vault-archive`
 * barrel does not export it, and nothing outside `vectors/` and the generator
 * script imports it.
 *
 * Spec: docs/security/e2ee-crypto-spec.md §14.8.
 */

export const ARCHIVE_SPEC_VERSION = '2.1';

export interface ArchiveVector {
  id: string;
  kind:
    'vault-archive/file' | 'vault-archive/open' | 'vault-archive/split' | 'vault-archive/reject';
  description: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
}

export interface ArchiveVectorFile {
  $schema: string;
  specVersion: string;
  generatedAt: string;
  generator: string;
  /** Exactly the fixture's passphrase, as typed (not normalised). */
  passphrase: string;
  /** The fixture's recovery codes in display form. */
  recoveryCodes: string[];
  vectors: ArchiveVector[];
}

/* ───────────────────────────── pinned inputs ───────────────────────────── */

/** `n` bytes of pinned "randomness": SHA-256 of a label, stretched by counter. */
function pinned(label: string, length: number): Bytes {
  const out = new Uint8Array(length);
  let filled = 0;
  for (let counter = 0; filled < length; counter += 1) {
    const block = sha256(new TextEncoder().encode(`xecret.archive-vectors|${label}|${counter}`));
    const take = Math.min(block.length, length - filled);
    out.set(block.subarray(0, take), filled);
    filled += take;
  }
  return out;
}

const USER_ID = '0192f0a1-7c3d-7e4f-8a1b-2c3d4e5f6a7b';
const ARCHIVE_ID = '0192f0a1-7c3d-7e4f-8a1b-000000000001';
const CREATED_AT = new Date('2026-10-12T09:30:00.000Z');
const RETAINED_UNTIL = new Date('2026-10-19T09:30:00.000Z');
const VAULT_CREATED_AT = '2026-09-08T14:05:21.123Z';

/**
 * The passphrase, typed with a *decomposed* é (e + U+0301), so the NFC step of
 * §1.3 changes its bytes — the case an implementation silently gets wrong.
 */
const PASSPHRASE = 'Café au lait, sans sucre, mais avec une cuillère';

/**
 * The §3.1 floor: inside the production range, so a reader under test runs its
 * real parameter validator, and cheap enough that the suite stays fast.
 */
const KDF_PARAMS: Argon2idParams = { alg: 'argon2id', v: 19, m: 19456, t: 2, p: 1, len: 32 };

const ORG_ACME = '0192f0a1-0000-7000-8000-00000000a001';
const ORG_SIDE = '0192f0a1-0000-7000-8000-00000000a002';
const PROJECT_API = '0192f0a1-0000-7000-8000-00000000b001';
const PROJECT_WEB = '0192f0a1-0000-7000-8000-00000000b002';
const PROJECT_BOT = '0192f0a1-0000-7000-8000-00000000b003';
const ENV_PROD = '0192f0a1-0000-7000-8000-00000000c001';
const ENV_STAGING = '0192f0a1-0000-7000-8000-00000000c002';
const ENV_DEV = '0192f0a1-0000-7000-8000-00000000c003';
const ENV_EMPTY = '0192f0a1-0000-7000-8000-00000000c004';
const EDK_PROD_V1 = '0192f0a1-0000-7000-8000-00000000d001';
const EDK_PROD_V2 = '0192f0a1-0000-7000-8000-00000000d002';
const EDK_STAGING_V1 = '0192f0a1-0000-7000-8000-00000000d003';
const EDK_DEV_V1 = '0192f0a1-0000-7000-8000-00000000d004';
const EDK_EMPTY_V3 = '0192f0a1-0000-7000-8000-00000000d005';
/** A key version this account was never given. */
const EDK_NEVER_HELD = '0192f0a1-0000-7000-8000-00000000d0ff';

function secretId(n: number): string {
  return `0192f0a1-0000-7000-8000-${String(n).padStart(12, '0')}`;
}

/** What one fixture secret is, before it is sealed. */
interface FixtureSecret {
  id: string;
  name: string;
  valueType: string;
  version: number;
  /** The key its value is sealed under, or `never-held`, or `tampered` (wrong AAD). */
  valueKey: string;
  value: string;
  /** The key its note is sealed under, `stranger` for one no key opens, or `null` for none. */
  noteKey: string | null;
  note: string | null;
  updatedAt: string;
}

interface FixtureEnvironment {
  orgId: string;
  orgName: string;
  orgSlug: string;
  projectId: string;
  projectName: string;
  projectSlug: string;
  environmentId: string;
  environmentName: string;
  environmentSlug: string;
  isProduction: boolean;
  /** `sealedTo: 'stranger'` makes a grant this account's private key cannot open. */
  keys: { envDataKeyId: string; edkVersion: number; sealedTo: 'account' | 'stranger' }[];
  secrets: FixtureSecret[];
}

const FIXTURE: FixtureEnvironment[] = [
  {
    orgId: ORG_ACME,
    orgName: 'Acme Corp',
    orgSlug: 'acme',
    projectId: PROJECT_API,
    projectName: 'Payments API',
    projectSlug: 'payments-api',
    environmentId: ENV_PROD,
    environmentName: 'Production',
    environmentSlug: 'production',
    isProduction: true,
    keys: [
      { envDataKeyId: EDK_PROD_V1, edkVersion: 1, sealedTo: 'account' },
      { envDataKeyId: EDK_PROD_V2, edkVersion: 2, sealedTo: 'account' },
    ],
    secrets: [
      {
        id: secretId(1),
        name: 'DATABASE_URL',
        valueType: 'url',
        version: 3,
        valueKey: EDK_PROD_V2,
        value: 'postgres://app:example-not-a-real-key@db.internal:5432/payments?sslmode=require',
        noteKey: EDK_PROD_V2,
        note: 'Primary cluster. Rotated quarterly.',
        updatedAt: '2026-10-01T08:00:00.000Z',
      },
      {
        id: secretId(2),
        name: 'LEGACY_TOKEN',
        valueType: 'string',
        version: 1,
        valueKey: EDK_PROD_V1,
        value: 'legacy-token-example-not-a-real-key',
        noteKey: EDK_PROD_V1,
        note: 'Written before the key was rotated.',
        updatedAt: '2026-08-20T10:15:00.000Z',
      },
      {
        id: secretId(3),
        name: 'EMPTY_FLAG',
        valueType: 'string',
        version: 1,
        valueKey: EDK_PROD_V2,
        value: '',
        noteKey: null,
        note: null,
        updatedAt: '2026-09-30T12:00:00.000Z',
      },
      {
        id: secretId(4),
        name: 'GREETING',
        valueType: 'string',
        version: 2,
        valueKey: EDK_PROD_V2,
        // Decomposed on the way in; NFC on the way out (§2.2 types 9–10).
        value: 'Café — 日本語 ✓',
        noteKey: null,
        note: null,
        updatedAt: '2026-09-29T07:45:00.000Z',
      },
      {
        id: secretId(5),
        name: 'NOTE_UNDER_OLD_KEY',
        valueType: 'string',
        version: 4,
        valueKey: EDK_PROD_V2,
        value: 'value-under-version-2',
        // The note predates the rotation, so only the v1 key opens it. A reader
        // that tried only the value's key would report it unavailable.
        noteKey: EDK_PROD_V1,
        note: 'This note was written under key version 1.',
        updatedAt: '2026-10-02T09:00:00.000Z',
      },
      {
        id: secretId(6),
        name: 'NEVER_HELD',
        valueType: 'string',
        version: 1,
        valueKey: 'never-held',
        value: 'written under a key this account was never given',
        noteKey: null,
        note: null,
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
      {
        id: secretId(7),
        name: 'TAMPERED',
        valueType: 'string',
        version: 2,
        // Sealed under the right key with the AAD of version 1, then filed as
        // version 2: it must come out `damaged`, not opened and not fatal.
        valueKey: 'tampered',
        value: 'this value must not be returned',
        noteKey: null,
        note: null,
        updatedAt: '2026-10-03T09:00:00.000Z',
      },
    ],
  },
  {
    orgId: ORG_ACME,
    orgName: 'Acme Corp',
    orgSlug: 'acme',
    projectId: PROJECT_WEB,
    projectName: 'Web',
    projectSlug: 'web',
    environmentId: ENV_STAGING,
    environmentName: 'Staging',
    environmentSlug: 'staging',
    isProduction: false,
    keys: [{ envDataKeyId: EDK_STAGING_V1, edkVersion: 1, sealedTo: 'account' }],
    secrets: [
      {
        id: secretId(11),
        name: 'API_URL',
        valueType: 'url',
        version: 1,
        valueKey: EDK_STAGING_V1,
        value: 'https://staging.example.com/api',
        // A note no key of this environment opens: reported, never an error.
        noteKey: 'stranger',
        note: 'unreachable',
        updatedAt: '2026-09-15T16:20:00.000Z',
      },
      {
        id: secretId(12),
        name: 'MULTILINE',
        valueType: 'string',
        version: 2,
        valueKey: EDK_STAGING_V1,
        value: 'line one\nline two\n\ttabbed "quoted" \\ backslash',
        noteKey: EDK_STAGING_V1,
        note: 'A value with newlines, tabs, quotes and a backslash.',
        updatedAt: '2026-09-16T16:20:00.000Z',
      },
    ],
  },
  {
    orgId: ORG_SIDE,
    orgName: 'Side Project',
    orgSlug: 'side',
    projectId: PROJECT_BOT,
    projectName: 'Bot',
    projectSlug: 'bot',
    environmentId: ENV_DEV,
    environmentName: 'Development',
    environmentSlug: 'development',
    isProduction: false,
    // A grant this account's private key does not open: every value under it
    // is `damaged`, and the archive still opens.
    keys: [{ envDataKeyId: EDK_DEV_V1, edkVersion: 1, sealedTo: 'stranger' }],
    secrets: [
      {
        id: secretId(21),
        name: 'BOT_TOKEN',
        valueType: 'string',
        version: 1,
        valueKey: EDK_DEV_V1,
        value: 'bot-token-example-not-a-real-key',
        noteKey: null,
        note: null,
        updatedAt: '2026-06-01T00:00:00.000Z',
      },
    ],
  },
  {
    orgId: ORG_SIDE,
    orgName: 'Side Project',
    orgSlug: 'side',
    projectId: PROJECT_BOT,
    projectName: 'Bot',
    projectSlug: 'bot',
    environmentId: ENV_EMPTY,
    environmentName: 'Empty',
    environmentSlug: 'empty',
    isProduction: false,
    keys: [{ envDataKeyId: EDK_EMPTY_V3, edkVersion: 3, sealedTo: 'account' }],
    secrets: [],
  },
];

/* ─────────────────────────────── the fixture ─────────────────────────────── */

interface Fixture {
  input: ArchiveInput;
  recoveryCodes: string[];
  /** A different X25519 public key, for the key-mismatch vector. */
  strangerPublicKeyB64Url: string;
}

let ivCounter = 0;
function nextIv(): Bytes {
  ivCounter += 1;
  return pinned(`iv-${ivCounter}`, 12);
}

let ephemeralCounter = 0;
function nextEphemeral(): Bytes {
  ephemeralCounter += 1;
  return pinned(`ephemeral-${ephemeralCounter}`, 32);
}

async function gcm(key: Bytes, plaintext: Bytes, aad: string): Promise<string> {
  return formatGcmBlob(await encryptGcmWithIv(key, nextIv(), plaintext, aad));
}

function recoveryCodeBytes(label: string): Bytes {
  const bytes = pinned(label, 16);
  bytes[0] = bytes[0]! & 0x1f;
  return bytes;
}

/** Builds the fixture vault. Pinned counters restart, so two builds are identical. */
export async function buildFixture(): Promise<Fixture> {
  ivCounter = 0;
  ephemeralCounter = 0;

  const userKey = pinned('user-key', 32);
  const encPrivateKey = pinned('enc-private-key', 32);
  const encPublicKey = encryptionPublicKey(encPrivateKey);
  const strangerPrivateKey = pinned('stranger-private-key', 32);
  const strangerPublicKey = encryptionPublicKey(strangerPrivateKey);
  const kdfSalt = pinned('kdf-salt', 16);

  const stretched = await deriveStretchedKey({
    passphrase: PASSPHRASE,
    salt: kdfSalt,
    params: KDF_PARAMS,
  });
  const passphraseWrapKey = await derivePassphraseWrapKey(stretched);
  const passphraseWrapBlob = await gcm(
    passphraseWrapKey,
    userKey,
    userKeyWrapAad({ userId: USER_ID, wrapKind: 'passphrase' }),
  );

  const codes = [recoveryCodeBytes('recovery-1'), recoveryCodeBytes('recovery-2')];
  const recoveryWraps = [];
  for (const codeBytes of codes) {
    const lookupHashHex = toHex(await recoveryLookupHash(codeBytes));
    recoveryWraps.push({
      lookupHashHex,
      wrapBlob: await gcm(
        await deriveRecoveryKey(codeBytes),
        userKey,
        userKeyWrapAad({ userId: USER_ID, wrapKind: 'recovery', lookupHashHex }),
      ),
    });
  }

  const encPrivateKeyBlob = await gcm(userKey, encPrivateKey, privateKeyEncAad(USER_ID));

  const environments: ArchiveEnvironment[] = [];
  for (const fixture of FIXTURE) {
    const ehk = pinned(`ehk-${fixture.environmentId}`, 32);
    const edks = new Map(
      fixture.keys.map((key) => [key.envDataKeyId, pinned(`edk-${key.envDataKeyId}`, 32)]),
    );

    const keys = [];
    for (const key of fixture.keys) {
      const recipientPublicKey = key.sealedTo === 'account' ? encPublicKey : strangerPublicKey;
      keys.push({
        envDataKeyId: key.envDataKeyId,
        edkVersion: key.edkVersion,
        edkSealedBlob: await sealToPublicKeyWithRandomness({
          recipientPublicKey,
          plaintext: edks.get(key.envDataKeyId)!,
          aad: edkGrantAad({
            environmentId: fixture.environmentId,
            edkVersion: key.edkVersion,
            recipientKind: 'member',
            recipientId: USER_ID,
          }),
          ephemeralPrivateKey: nextEphemeral(),
          iv: nextIv(),
        }),
        ehkSealedBlob: await sealToPublicKeyWithRandomness({
          recipientPublicKey,
          plaintext: ehk,
          aad: ehkGrantAad({
            environmentId: fixture.environmentId,
            recipientKind: 'member',
            recipientId: USER_ID,
          }),
          ephemeralPrivateKey: nextEphemeral(),
          iv: nextIv(),
        }),
      });
    }

    const secrets: ArchiveSecret[] = [];
    for (const secret of fixture.secrets) {
      const context = {
        orgId: fixture.orgId,
        environmentId: fixture.environmentId,
        secretId: secret.id,
      };

      let envDataKeyId: string;
      let valueBlob: string;
      if (secret.valueKey === 'never-held') {
        envDataKeyId = EDK_NEVER_HELD;
        valueBlob = await gcm(
          pinned('never-held-edk', 32),
          normalizedUtf8(secret.value),
          secretValueAad({ ...context, version: secret.version }),
        );
      } else if (secret.valueKey === 'tampered') {
        envDataKeyId = EDK_PROD_V2;
        valueBlob = await gcm(
          edks.get(EDK_PROD_V2)!,
          normalizedUtf8(secret.value),
          secretValueAad({ ...context, version: secret.version - 1 }),
        );
      } else {
        envDataKeyId = secret.valueKey;
        valueBlob = await gcm(
          edks.get(secret.valueKey)!,
          normalizedUtf8(secret.value),
          secretValueAad({ ...context, version: secret.version }),
        );
      }

      let noteBlob: string | null = null;
      if (secret.note !== null && secret.noteKey !== null) {
        const noteKey =
          secret.noteKey === 'stranger'
            ? pinned('stranger-note-key', 32)
            : edks.get(secret.noteKey)!;
        noteBlob = await gcm(noteKey, normalizedUtf8(secret.note), secretNoteAad(context));
      }

      secrets.push({
        secretId: secret.id,
        name: secret.name,
        valueType: secret.valueType,
        version: secret.version,
        envDataKeyId,
        valueBlob,
        noteBlob,
        updatedAt: secret.updatedAt,
      });
    }

    environments.push({
      orgId: fixture.orgId,
      orgName: fixture.orgName,
      orgSlug: fixture.orgSlug,
      projectId: fixture.projectId,
      projectName: fixture.projectName,
      projectSlug: fixture.projectSlug,
      environmentId: fixture.environmentId,
      environmentName: fixture.environmentName,
      environmentSlug: fixture.environmentSlug,
      isProduction: fixture.isProduction,
      keys,
      secrets,
    });
  }

  return {
    input: {
      userId: USER_ID,
      vault: {
        createdAt: VAULT_CREATED_AT,
        kdfSaltB64Url: toBase64Url(kdfSalt),
        kdfParams: KDF_PARAMS,
        passphraseWrapBlob,
        recoveryWraps,
        encPublicKeyB64Url: toBase64Url(encPublicKey),
        encPrivateKeyBlob,
      },
      environments,
    },
    recoveryCodes: codes.map((codeBytes) => encodeRecoveryCode(codeBytes).displayForm),
    strangerPublicKeyB64Url: toBase64Url(strangerPublicKey),
  };
}

/* ─────────────────────────────── expectations ─────────────────────────────── */

/**
 * What opening the fixture archive must produce, derived from the fixture's own
 * plaintexts — the inputs, not anything a reader computed.
 */
function expectedOpened(environments: readonly FixtureEnvironment[]): unknown[] {
  return [...environments]
    .sort(
      (a, b) =>
        compare(a.orgName, b.orgName) ||
        compare(a.projectName, b.projectName) ||
        compare(a.environmentName, b.environmentName),
    )
    .map((environment) => {
      const openable = new Set(
        environment.keys.filter((key) => key.sealedTo === 'account').map((key) => key.envDataKeyId),
      );
      return {
        environmentId: environment.environmentId,
        damagedKeyVersions: environment.keys
          .filter((key) => key.sealedTo !== 'account')
          .map((key) => key.edkVersion),
        secrets: [...environment.secrets]
          .sort((a, b) => compare(a.name, b.name))
          .map((secret) => {
            const outcome =
              secret.valueKey === 'never-held'
                ? 'no-key'
                : secret.valueKey === 'tampered' || !openable.has(secret.valueKey)
                  ? 'damaged'
                  : 'ok';
            const noteOpens =
              secret.noteKey !== null &&
              secret.noteKey !== 'stranger' &&
              openable.has(secret.noteKey);
            return {
              name: secret.name,
              outcome,
              value: outcome === 'ok' ? secret.value.normalize('NFC') : null,
              note: noteOpens ? secret.note!.normalize('NFC') : null,
              noteUnavailable: secret.note !== null && !noteOpens,
            };
          }),
      };
    });
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ───────────────────────────────── vectors ───────────────────────────────── */

function hex(bytes: Uint8Array): string {
  return toHex(bytes as Bytes);
}

/** A copy of the document as JSON text, edited by `edit`, for a negative vector. */
function edited(doc: VaultArchiveDocument, edit: (raw: Record<string, unknown>) => void): string {
  const raw = JSON.parse(serializeArchiveDocument(doc)) as Record<string, unknown>;
  edit(raw);
  return `${JSON.stringify(raw, null, 2)}\n`;
}

export async function buildArchiveVectors(): Promise<{
  vectors: ArchiveVector[];
  recoveryCodes: string[];
}> {
  const fixture = await buildFixture();
  const [doc] = planArchiveParts(fixture.input, {
    archiveId: ARCHIVE_ID,
    createdAt: CREATED_AT,
    retainedUntil: RETAINED_UNTIL,
  });
  const file = encodeArchivePart(doc!, { retainedUntil: RETAINED_UNTIL });
  const json = serializeArchiveDocument(doc!);
  const opened = expectedOpened(FIXTURE);
  const [code1, code2] = fixture.recoveryCodes as [string, string];

  const vectors: ArchiveVector[] = [
    {
      id: 'vault-archive/file/single',
      kind: 'vault-archive/file',
      description:
        'The fixture vault as one archive: the exact ZIP bytes the writer produces, and the document inside.',
      input: {
        archiveId: ARCHIVE_ID,
        createdAt: CREATED_AT.toISOString(),
        retainedUntil: RETAINED_UNTIL.toISOString(),
      },
      expected: {
        fileName: file.fileName,
        fileHex: hex(file.bytes),
        sha256Hex: hex(sha256(file.bytes)),
        archiveJson: json,
      },
    },
    {
      id: 'vault-archive/open/passphrase',
      kind: 'vault-archive/open',
      description:
        'Opening with the passphrase, typed with a decomposed é so NFC changes its bytes (§1.3).',
      input: {
        fileVector: 'vault-archive/file/single',
        credential: { kind: 'passphrase', passphrase: PASSPHRASE },
      },
      expected: { environments: opened },
    },
    {
      id: 'vault-archive/open/recovery-code',
      kind: 'vault-archive/open',
      description:
        'Opening with the second recovery code, typed lower-case without hyphens (§7.1 normalisation).',
      input: {
        fileVector: 'vault-archive/file/single',
        credential: { kind: 'recovery-code', code: code2.replaceAll('-', '').toLowerCase() },
      },
      expected: { environments: opened },
    },
    {
      id: 'vault-archive/open/bare-json',
      kind: 'vault-archive/open',
      description: 'A bare archive.json, as a person who unzipped the file holds it (§14.1).',
      input: { jsonText: json, credential: { kind: 'recovery-code', code: code1 } },
      expected: { environments: opened },
    },
  ];

  vectors.push(splitVector(fixture, code1));
  vectors.push(...rejectVectors(doc!, file.bytes, fixture, code1));

  return { vectors, recoveryCodes: fixture.recoveryCodes };
}

/**
 * The fixture split under a small budget, so that one environment spans two
 * parts. Each part must open on its own, and between them they must hold every
 * secret exactly once (§14.6).
 */
function splitVector(fixture: Fixture, code: string): ArchiveVector {
  const maxPartBytes = 12 * 1024;
  const docs = planArchiveParts(fixture.input, {
    archiveId: ARCHIVE_ID,
    createdAt: CREATED_AT,
    retainedUntil: RETAINED_UNTIL,
    maxPartBytes,
  });

  return {
    id: 'vault-archive/split/fixture',
    kind: 'vault-archive/split',
    description:
      'The fixture split under a 12 KiB part budget. Every part opens alone with the same code; together they hold each secret exactly once.',
    input: {
      maxPartBytes,
      credential: { kind: 'recovery-code', code },
      partsHex: docs.map((part) =>
        hex(encodeArchivePart(part, { retainedUntil: RETAINED_UNTIL, maxPartBytes }).bytes),
      ),
    },
    expected: {
      parts: docs.length,
      partSecretNames: docs.map((part) =>
        part.environments.map((environment) => ({
          environmentId: environment.environmentId,
          names: environment.secrets.map((secret) => secret.name),
        })),
      ),
    },
  };
}

function rejectVectors(
  doc: VaultArchiveDocument,
  file: Uint8Array,
  fixture: Fixture,
  code: string,
): ArchiveVector[] {
  const reject = (
    id: string,
    description: string,
    input: Record<string, unknown>,
    errorClass: 'format' | 'decryption' | 'recovery-code',
  ): ArchiveVector => ({
    id: `vault-archive/reject/${id}`,
    kind: 'vault-archive/reject',
    description,
    input,
    expected: { errorClass },
  });

  const json = serializeArchiveDocument(doc);
  const encoder = new TextEncoder();
  const twoDocuments = writeStoredZip(
    [
      { name: 'archive.json', data: encoder.encode(json) },
      { name: 'archive.json', data: encoder.encode(json) },
    ],
    CREATED_AT,
  );

  // One byte of the stored document changed after the CRC was computed.
  const corrupted = file.slice();
  const marker = new TextEncoder().encode('"format"');
  const at = indexOf(corrupted, marker);
  corrupted[at + 2] = corrupted[at + 2]! ^ 0x20;

  // The encrypted flag (bit 0) set in the central directory entry of archive.json.
  const encrypted = file.slice();
  setCentralFlag(encrypted, 'archive.json', 0x0001);

  const salt = doc.vault.kdfSaltB64Url;
  const nonCanonicalSalt = salt.slice(0, -1) + bumpLowBits(salt.at(-1)!);

  return [
    reject(
      'format-version',
      'formatVersion 2: a document from a future version fails rather than being half-read.',
      { jsonText: edited(doc, (raw) => (raw['formatVersion'] = 2)) },
      'format',
    ),
    reject(
      'unknown-field',
      'A top-level field §14.4 does not define.',
      { jsonText: edited(doc, (raw) => (raw['comment'] = 'hello')) },
      'format',
    ),
    reject(
      'plaintext-field',
      'A secret carrying a "value" field: the shape of a writer that leaked plaintext. Refused, never read.',
      {
        jsonText: edited(doc, (raw) => {
          const environments = raw['environments'] as Record<string, unknown>[];
          const secrets = environments[0]!['secrets'] as Record<string, unknown>[];
          secrets[0]!['value'] = 'plaintext';
        }),
      },
      'format',
    ),
    reject(
      'kdf-params-out-of-range',
      'kdfParams.m of 2 GiB, above §3.1: refused before Argon2id is run.',
      {
        jsonText: edited(doc, (raw) => {
          ((raw['vault'] as Record<string, unknown>)['kdfParams'] as Record<string, unknown>)['m'] =
            2097152;
        }),
      },
      'format',
    ),
    reject(
      'wrong-blob-algorithm',
      'A value blob that is a sealed box rather than an xk2.gcm blob (§2).',
      {
        jsonText: edited(doc, (raw) => {
          const environments = raw['environments'] as Record<string, unknown>[];
          const secrets = environments[0]!['secrets'] as Record<string, unknown>[];
          const keys = environments[0]!['keys'] as Record<string, unknown>[];
          secrets[0]!['valueBlob'] = keys[0]!['edkSealedBlob'];
        }),
      },
      'format',
    ),
    reject(
      'non-canonical-base64url',
      'kdfSaltB64Url with non-zero trailing bits: several spellings of one value are refused.',
      {
        jsonText: edited(doc, (raw) => {
          (raw['vault'] as Record<string, unknown>)['kdfSaltB64Url'] = nonCanonicalSalt;
        }),
      },
      'format',
    ),
    reject(
      'two-documents',
      'A ZIP with two archive.json entries (§14.1).',
      { fileHex: hex(twoDocuments) },
      'format',
    ),
    reject(
      'crc-mismatch',
      'One byte of archive.json changed after the checksum was written.',
      { fileHex: hex(corrupted) },
      'format',
    ),
    reject(
      'encrypted-entry',
      'archive.json marked encrypted in the ZIP directory.',
      { fileHex: hex(encrypted) },
      'format',
    ),
    reject(
      'not-an-archive',
      'Neither a ZIP nor a JSON document.',
      { fileHex: hex(new TextEncoder().encode('hello, world')) },
      'format',
    ),
    reject(
      'public-key-mismatch',
      'encPublicKeyB64Url replaced by another key: the opened private key does not match it (§14.5 step 2).',
      {
        jsonText: edited(doc, (raw) => {
          (raw['vault'] as Record<string, unknown>)['encPublicKeyB64Url'] =
            fixture.strangerPublicKeyB64Url;
        }),
        credential: { kind: 'recovery-code', code },
      },
      'format',
    ),
    reject(
      'wrong-passphrase',
      "A passphrase that is not the vault's: the uniform decryption failure.",
      {
        fileVector: 'vault-archive/file/single',
        credential: { kind: 'passphrase', passphrase: 'not the passphrase' },
      },
      'decryption',
    ),
    reject(
      'unknown-recovery-code',
      'A well-formed recovery code that matches no wrap: the same uniform failure as a wrong one.',
      {
        fileVector: 'vault-archive/file/single',
        credential: {
          kind: 'recovery-code',
          code: encodeRecoveryCode(recoveryCodeBytes('recovery-unknown')).displayForm,
        },
      },
      'decryption',
    ),
    reject(
      'recovery-code-typo',
      'A recovery code with one character changed: a typo (§7.3), not a wrong code.',
      {
        fileVector: 'vault-archive/file/single',
        credential: { kind: 'recovery-code', code: typo(code) },
      },
      'recovery-code',
    ),
  ];
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** The display form with its first data character replaced by the next symbol. */
function typo(displayForm: string): string {
  const first = displayForm[0]!;
  const next = CROCKFORD[(CROCKFORD.indexOf(first) + 1) % CROCKFORD.length]!;
  return next + displayForm.slice(1);
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** The base64url symbol with its lowest bit set — non-zero trailing bits in a final symbol. */
function bumpLowBits(symbol: string): string {
  return B64URL[B64URL.indexOf(symbol) | 1]!;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  throw new Error('marker not found');
}

/** Sets flag bits on the central-directory entry with this name. */
function setCentralFlag(file: Uint8Array, name: string, flag: number): void {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const wanted = new TextEncoder().encode(name);
  for (let offset = 0; offset + 46 <= file.length; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue;
    const nameLength = view.getUint16(offset + 28, true);
    const candidate = file.subarray(offset + 46, offset + 46 + nameLength);
    if (candidate.length === wanted.length && candidate.every((byte, i) => byte === wanted[i])) {
      view.setUint16(offset + 8, view.getUint16(offset + 8, true) | flag, true);
      return;
    }
  }
  throw new Error('central entry not found');
}

/** The whole file, with the metadata the generator stamps. */
export async function buildArchiveVectorFile(meta: {
  generatedAt: string;
  generator: string;
}): Promise<ArchiveVectorFile> {
  const { vectors, recoveryCodes } = await buildArchiveVectors();
  return {
    $schema: './vault-archive-vectors.schema.json',
    specVersion: ARCHIVE_SPEC_VERSION,
    generatedAt: meta.generatedAt,
    generator: meta.generator,
    passphrase: PASSPHRASE,
    recoveryCodes,
    vectors,
  };
}

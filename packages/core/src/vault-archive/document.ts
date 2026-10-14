import { parseBlob, BlobFormatError } from '../crypto/client/blob';
import { parseKdfParams, KdfParamsError } from '../crypto/client/kdf';
import type { Argon2idParams } from '../crypto/client/kdf';
import { MAX_SECRET_BLOB_LENGTH } from '../crypto/client/secret';
import { fromBase64Url, toBase64Url } from '../crypto/encoding';
import type { Bytes } from '../crypto/types';
import { ArchiveFormatError } from './errors';

/**
 * `archive.json` — the document inside a vault escape archive, field by field.
 *
 * This module is the TypeScript reading of spec §14.4, and the two must not
 * disagree. Three rules shape it:
 *
 * - **Strict about the document.** A missing field, a wrong type, or a field
 *   the spec does not define is a format error at every level. A document from
 *   a future format version must fail to parse rather than be half-read as this
 *   one — the same discipline §2 applies to blobs.
 * - **Validation before any key is derived.** Every blob is parsed (§2) and
 *   `kdfParams` is checked against §3.1's ranges here, so a hostile file is
 *   refused before it can order an Argon2id allocation or reach a decryptor.
 * - **Errors name a place, never a value.** `environments[2].secrets[5].name`,
 *   not what was found there. Names are not secret, but blobs are key material,
 *   and one rule for every field is a rule nobody has to remember.
 */

export const ARCHIVE_FORMAT = 'xecret.vault-archive';
export const ARCHIVE_FORMAT_VERSION = 1;
export const ARCHIVE_REASON = 'vault-reset';

/** The most parts one archive may be split into (§14.4). */
export const ARCHIVE_MAX_PARTS = 64;
/** The largest `archive.json` a reader will inflate or parse (§14.1). */
export const ARCHIVE_MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
/** The most recovery wraps an archive may carry (§14.4). */
export const ARCHIVE_MAX_RECOVERY_WRAPS = 16;
/** The most key versions one environment may carry (§14.4). */
export const ARCHIVE_MAX_KEYS_PER_ENVIRONMENT = 1000;

/**
 * The product's own slug grammar (`validation/slug.ts`), restated here so this
 * browser module does not import that one's schema library. A test pins the
 * two together. Slugs are printed by the command-line reader and used as path
 * segments by `--out-dir`, so nothing outside this grammar is accepted.
 */
export const ARCHIVE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ARCHIVE_ENVIRONMENT_SLUG_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
export const ARCHIVE_SLUG_MAX_LENGTH = 63;

/**
 * What no display name may contain (§14.4): C0 and C1 control characters, DEL,
 * and the two Unicode line and paragraph separators. A name is printed to a
 * terminal and rendered in a page; any of these lets a hostile file draw its
 * own lines there.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const FORBIDDEN_IN_NAME = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** A UTF-16 surrogate with no partner: what `JSON.parse` yields for a lone `\\ud800`. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** The longest organisation, project, environment or secret name an archive carries. */
const MAX_NAME_LENGTH = 256;

/* ─────────────────────── what a writer puts in a field ─────────────────────── */

// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const FORBIDDEN_IN_NAME_ALL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const LONE_SURROGATE_ALL =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * A display name as a writer must put it in an archive: the characters a
 * reader refuses (§14.4) removed, a lone surrogate replaced with U+FFFD,
 * clamped to 256 code points, and `-` when nothing is left.
 *
 * The product validates names when they are typed, but an archive is written
 * from whatever a row holds — a name from before a rule, or from an import —
 * and a reader refuses the whole file over one bad name. A name in an archive
 * is a label to recognise an environment by, so cleaning it costs nothing.
 */
export function toArchiveLabel(value: string): string {
  const cleaned = [
    ...value.replace(FORBIDDEN_IN_NAME_ALL, '').replace(LONE_SURROGATE_ALL, '\ufffd'),
  ];
  if (cleaned.length === 0) return '-';
  return cleaned.slice(0, MAX_NAME_LENGTH).join('');
}

/**
 * A slug as a writer must put it in an archive: the stored slug when it is in
 * the product's grammar, and otherwise `x-` and the entity's id without its
 * hyphens — 34 characters, valid in both grammars, and as unique as the id, so
 * a replaced slug can never make two environments share a path (§14.4).
 *
 * A slug is not cleaned character by character, because two different bad
 * slugs could clean to the same good one, and the reader refuses that file too.
 */
export function toArchiveSlug(value: string, kind: 'slug' | 'environment', id: string): string {
  const pattern = kind === 'environment' ? ARCHIVE_ENVIRONMENT_SLUG_PATTERN : ARCHIVE_SLUG_PATTERN;
  if (value.length <= ARCHIVE_SLUG_MAX_LENGTH && pattern.test(value)) return value;
  return `x-${id.toLowerCase().replace(/[^0-9a-f]/g, '')}`;
}

/**
 * Whether a reader accepts this secret's name and value type (§14.4). A writer
 * leaves out a secret it would not, rather than write a file that cannot open.
 */
export function isArchivableSecret(secret: { name: string; valueType: string }): boolean {
  return (
    secret.name.length <= MAX_NAME_LENGTH &&
    SECRET_NAME.test(secret.name) &&
    VALUE_TYPE.test(secret.valueType)
  );
}

export interface ArchiveRecoveryWrap {
  /** `SHA-256("xecret.v2.recovery-lookup" ‖ codeBytes)`, lowercase hex — also an AAD component. */
  lookupHashHex: string;
  wrapBlob: string;
}

export interface ArchiveVault {
  createdAt: string;
  kdfSaltB64Url: string;
  kdfParams: Argon2idParams;
  passphraseWrapBlob: string;
  recoveryWraps: ArchiveRecoveryWrap[];
  encPublicKeyB64Url: string;
  encPrivateKeyBlob: string;
}

export interface ArchiveKey {
  envDataKeyId: string;
  edkVersion: number;
  edkSealedBlob: string;
  ehkSealedBlob: string;
}

export interface ArchiveSecret {
  secretId: string;
  name: string;
  valueType: string;
  version: number;
  envDataKeyId: string;
  valueBlob: string;
  noteBlob: string | null;
  updatedAt: string;
}

export interface ArchiveEnvironment {
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
  keys: ArchiveKey[];
  secrets: ArchiveSecret[];
}

export interface VaultArchiveDocument {
  format: typeof ARCHIVE_FORMAT;
  formatVersion: typeof ARCHIVE_FORMAT_VERSION;
  archiveId: string;
  part: number;
  parts: number;
  createdAt: string;
  reason: typeof ARCHIVE_REASON;
  account: { userId: string };
  vault: ArchiveVault;
  environments: ArchiveEnvironment[];
}

/* ───────────────────────────── serialising ───────────────────────────── */

/**
 * Renders the document as the writer emits it: fields in the spec's order, two
 * spaces of indentation, a trailing newline.
 *
 * Every object is rebuilt here in canonical order rather than trusted to arrive
 * that way. A caller assembling a document from database rows would otherwise
 * decide the byte layout by the order its query happened to name columns — and
 * the test vectors pin the bytes.
 */
export function serializeArchiveDocument(doc: VaultArchiveDocument): string {
  const canonical = {
    format: doc.format,
    formatVersion: doc.formatVersion,
    archiveId: doc.archiveId,
    part: doc.part,
    parts: doc.parts,
    createdAt: doc.createdAt,
    reason: doc.reason,
    account: { userId: doc.account.userId },
    vault: canonicalVault(doc.vault),
    environments: doc.environments.map(canonicalEnvironment),
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

function canonicalVault(vault: ArchiveVault): ArchiveVault {
  return {
    createdAt: vault.createdAt,
    kdfSaltB64Url: vault.kdfSaltB64Url,
    kdfParams: {
      alg: vault.kdfParams.alg,
      v: vault.kdfParams.v,
      m: vault.kdfParams.m,
      t: vault.kdfParams.t,
      p: vault.kdfParams.p,
      len: vault.kdfParams.len,
    },
    passphraseWrapBlob: vault.passphraseWrapBlob,
    recoveryWraps: vault.recoveryWraps.map((wrap) => ({
      lookupHashHex: wrap.lookupHashHex,
      wrapBlob: wrap.wrapBlob,
    })),
    encPublicKeyB64Url: vault.encPublicKeyB64Url,
    encPrivateKeyBlob: vault.encPrivateKeyBlob,
  };
}

/** One environment in canonical field order. Exported for the writer's size estimate. */
export function canonicalEnvironment(environment: ArchiveEnvironment): ArchiveEnvironment {
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
    keys: environment.keys.map((key) => ({
      envDataKeyId: key.envDataKeyId,
      edkVersion: key.edkVersion,
      edkSealedBlob: key.edkSealedBlob,
      ehkSealedBlob: key.ehkSealedBlob,
    })),
    secrets: environment.secrets.map(canonicalSecret),
  };
}

/** One secret in canonical field order. Exported for the writer's size estimate. */
export function canonicalSecret(secret: ArchiveSecret): ArchiveSecret {
  return {
    secretId: secret.secretId,
    name: secret.name,
    valueType: secret.valueType,
    version: secret.version,
    envDataKeyId: secret.envDataKeyId,
    valueBlob: secret.valueBlob,
    noteBlob: secret.noteBlob,
    updatedAt: secret.updatedAt,
  };
}

/* ─────────────────────────────── parsing ─────────────────────────────── */

/**
 * Parses and validates `archive.json`. Throws {@link ArchiveFormatError} for
 * anything §14.4 does not allow.
 *
 * `format` and `formatVersion` are checked before anything else, so a document
 * from another product or another version is told that, rather than that its
 * third environment is missing a field this version happens to require.
 */
export function parseArchiveDocument(text: string): VaultArchiveDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ArchiveFormatError('archive.json is not valid JSON.');
  }

  if (!isPlainObject(raw)) {
    throw new ArchiveFormatError('archive.json must hold a JSON object.');
  }
  if (raw['format'] !== ARCHIVE_FORMAT) {
    throw new ArchiveFormatError('This file is not an xecret vault archive.');
  }
  if (raw['formatVersion'] !== ARCHIVE_FORMAT_VERSION) {
    const found = raw['formatVersion'];
    throw new ArchiveFormatError(
      typeof found === 'number' && Number.isInteger(found)
        ? `This is a version ${found} vault archive, and this reader understands version ${ARCHIVE_FORMAT_VERSION} only.`
        : 'formatVersion must be an integer.',
    );
  }

  const top = fields(raw, '', [
    'format',
    'formatVersion',
    'archiveId',
    'part',
    'parts',
    'createdAt',
    'reason',
    'account',
    'vault',
    'environments',
  ]);

  const parts = integer(top.parts, 'parts', 1, ARCHIVE_MAX_PARTS);
  const part = integer(top.part, 'part', 1, parts);
  if (top.reason !== ARCHIVE_REASON) {
    throw new ArchiveFormatError('reason must be "vault-reset".');
  }

  const account = fields(top.account, 'account', ['userId']);
  const environments = array(top.environments, 'environments').map((entry, index) =>
    parseEnvironment(entry, `environments[${index}]`),
  );
  // One entry per environment, by id and by the slug path a reader prints and
  // writes files under — two entries for one would make one shadow the other.
  unique(
    environments.map((environment) => environment.environmentId),
    'environments',
    'environmentId',
  );
  unique(
    environments.map(
      (environment) =>
        `${environment.orgSlug}/${environment.projectSlug}/${environment.environmentSlug}`,
    ),
    'environments',
    'organisation, project and environment slug',
  );

  return {
    format: ARCHIVE_FORMAT,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    archiveId: uuid(top.archiveId, 'archiveId'),
    part,
    parts,
    createdAt: timestamp(top.createdAt, 'createdAt'),
    reason: ARCHIVE_REASON,
    account: { userId: uuid(account.userId, 'account.userId') },
    vault: parseVault(top.vault),
    environments,
  };
}

function parseVault(value: unknown): ArchiveVault {
  const vault = fields(value, 'vault', [
    'createdAt',
    'kdfSaltB64Url',
    'kdfParams',
    'passphraseWrapBlob',
    'recoveryWraps',
    'encPublicKeyB64Url',
    'encPrivateKeyBlob',
  ]);

  let kdfParams: Argon2idParams;
  try {
    kdfParams = parseKdfParams(vault.kdfParams);
  } catch (cause) {
    // §3.1's ranges, applied to a file exactly as to a server response: an
    // unvalidated `m` is an allocation chosen by whoever wrote the file.
    if (cause instanceof KdfParamsError) {
      throw new ArchiveFormatError(`vault.kdfParams is not acceptable: ${cause.message}`);
    }
    throw cause;
  }

  const wraps = array(vault.recoveryWraps, 'vault.recoveryWraps');
  if (wraps.length > ARCHIVE_MAX_RECOVERY_WRAPS) {
    throw new ArchiveFormatError('vault.recoveryWraps has more entries than an archive may carry.');
  }
  const recoveryWraps = wraps.map((entry, index) => {
    const path = `vault.recoveryWraps[${index}]`;
    const wrap = fields(entry, path, ['lookupHashHex', 'wrapBlob']);
    return {
      lookupHashHex: hex(wrap.lookupHashHex, `${path}.lookupHashHex`, 32),
      wrapBlob: blob(wrap.wrapBlob, `${path}.wrapBlob`, 'gcm'),
    };
  });
  unique(
    recoveryWraps.map((wrap) => wrap.lookupHashHex),
    'vault.recoveryWraps',
    'lookupHashHex',
  );

  return {
    createdAt: timestamp(vault.createdAt, 'vault.createdAt'),
    kdfSaltB64Url: base64Url(vault.kdfSaltB64Url, 'vault.kdfSaltB64Url', 16),
    kdfParams,
    passphraseWrapBlob: blob(vault.passphraseWrapBlob, 'vault.passphraseWrapBlob', 'gcm'),
    recoveryWraps,
    encPublicKeyB64Url: base64Url(vault.encPublicKeyB64Url, 'vault.encPublicKeyB64Url', 32),
    encPrivateKeyBlob: blob(vault.encPrivateKeyBlob, 'vault.encPrivateKeyBlob', 'gcm'),
  };
}

function parseEnvironment(value: unknown, path: string): ArchiveEnvironment {
  const environment = fields(value, path, [
    'orgId',
    'orgName',
    'orgSlug',
    'projectId',
    'projectName',
    'projectSlug',
    'environmentId',
    'environmentName',
    'environmentSlug',
    'isProduction',
    'keys',
    'secrets',
  ]);

  const keyEntries = array(environment.keys, `${path}.keys`);
  if (keyEntries.length > ARCHIVE_MAX_KEYS_PER_ENVIRONMENT) {
    throw new ArchiveFormatError(`${path}.keys has more entries than an archive may carry.`);
  }
  if (keyEntries.length === 0) {
    throw new ArchiveFormatError(`${path}.keys must hold at least one key.`);
  }
  const keys = keyEntries.map((entry, index) => {
    const keyPath = `${path}.keys[${index}]`;
    const key = fields(entry, keyPath, [
      'envDataKeyId',
      'edkVersion',
      'edkSealedBlob',
      'ehkSealedBlob',
    ]);
    return {
      envDataKeyId: uuid(key.envDataKeyId, `${keyPath}.envDataKeyId`),
      edkVersion: integer(key.edkVersion, `${keyPath}.edkVersion`, 1, 0x7fffffff),
      edkSealedBlob: blob(key.edkSealedBlob, `${keyPath}.edkSealedBlob`, 'x25519'),
      ehkSealedBlob: blob(key.ehkSealedBlob, `${keyPath}.ehkSealedBlob`, 'x25519'),
    };
  });
  unique(
    keys.map((key) => key.envDataKeyId),
    `${path}.keys`,
    'envDataKeyId',
  );
  unique(
    keys.map((key) => String(key.edkVersion)),
    `${path}.keys`,
    'edkVersion',
  );

  const secrets = array(environment.secrets, `${path}.secrets`).map((entry, index) =>
    parseSecret(entry, `${path}.secrets[${index}]`),
  );
  unique(
    secrets.map((secret) => secret.secretId),
    `${path}.secrets`,
    'secretId',
  );
  unique(
    secrets.map((secret) => secret.name),
    `${path}.secrets`,
    'name',
  );

  return {
    orgId: uuid(environment.orgId, `${path}.orgId`),
    orgName: label(environment.orgName, `${path}.orgName`),
    orgSlug: slug(environment.orgSlug, `${path}.orgSlug`, ARCHIVE_SLUG_PATTERN),
    projectId: uuid(environment.projectId, `${path}.projectId`),
    projectName: label(environment.projectName, `${path}.projectName`),
    projectSlug: slug(environment.projectSlug, `${path}.projectSlug`, ARCHIVE_SLUG_PATTERN),
    environmentId: uuid(environment.environmentId, `${path}.environmentId`),
    environmentName: label(environment.environmentName, `${path}.environmentName`),
    environmentSlug: slug(
      environment.environmentSlug,
      `${path}.environmentSlug`,
      ARCHIVE_ENVIRONMENT_SLUG_PATTERN,
    ),
    isProduction: boolean(environment.isProduction, `${path}.isProduction`),
    keys,
    secrets,
  };
}

const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VALUE_TYPE = /^[a-z0-9]{1,32}$/;

function parseSecret(value: unknown, path: string): ArchiveSecret {
  const secret = fields(value, path, [
    'secretId',
    'name',
    'valueType',
    'version',
    'envDataKeyId',
    'valueBlob',
    'noteBlob',
    'updatedAt',
  ]);

  const name = string(secret.name, `${path}.name`);
  if (name.length > MAX_NAME_LENGTH || !SECRET_NAME.test(name)) {
    throw new ArchiveFormatError(`${path}.name is not a valid secret name.`);
  }
  const valueType = string(secret.valueType, `${path}.valueType`);
  if (!VALUE_TYPE.test(valueType)) {
    throw new ArchiveFormatError(`${path}.valueType is not a valid value type.`);
  }

  return {
    secretId: uuid(secret.secretId, `${path}.secretId`),
    name,
    valueType,
    version: integer(secret.version, `${path}.version`, 1, 0x7fffffff),
    envDataKeyId: uuid(secret.envDataKeyId, `${path}.envDataKeyId`),
    valueBlob: blob(secret.valueBlob, `${path}.valueBlob`, 'gcm', MAX_SECRET_BLOB_LENGTH),
    noteBlob:
      secret.noteBlob === null
        ? null
        : blob(secret.noteBlob, `${path}.noteBlob`, 'gcm', MAX_SECRET_BLOB_LENGTH),
    updatedAt: timestamp(secret.updatedAt, `${path}.updatedAt`),
  };
}

/* ───────────────────────────── field checks ───────────────────────────── */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The object at `path`, with exactly these keys — none missing, none extra. */
function fields<K extends string>(
  value: unknown,
  path: string,
  keys: readonly K[],
): Record<K, unknown> {
  const where = path === '' ? 'archive.json' : path;
  if (!isPlainObject(value)) {
    throw new ArchiveFormatError(`${where} must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (!(keys as readonly string[]).includes(key)) {
      throw new ArchiveFormatError(`${where} has a field this reader does not understand.`);
    }
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new ArchiveFormatError(`${path === '' ? key : `${path}.${key}`} is missing.`);
    }
  }
  return value;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new ArchiveFormatError(`${path} must be an array.`);
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new ArchiveFormatError(`${path} must be a string.`);
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new ArchiveFormatError(`${path} must be true or false.`);
  return value;
}

function integer(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ArchiveFormatError(`${path} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

/**
 * A display name: 1 to 256 Unicode code points — not UTF-16 units, so the two
 * readers agree on an emoji — with no control or line-separator character and
 * no lone surrogate.
 */
function label(value: unknown, path: string): string {
  const text = string(value, path);
  const length = [...text].length;
  if (length === 0 || length > MAX_NAME_LENGTH) {
    throw new ArchiveFormatError(`${path} must be 1 to ${MAX_NAME_LENGTH} characters.`);
  }
  if (FORBIDDEN_IN_NAME.test(text) || LONE_SURROGATE.test(text)) {
    throw new ArchiveFormatError(`${path} contains a character a name may not.`);
  }
  return text;
}

/** A slug in the product's own grammar, at most 63 characters. */
function slug(value: unknown, path: string, pattern: RegExp): string {
  const text = string(value, path);
  if (text.length > ARCHIVE_SLUG_MAX_LENGTH || !pattern.test(text)) {
    throw new ArchiveFormatError(`${path} is not a valid slug.`);
  }
  return text;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Canonical lowercase text, as everywhere in the spec (§1.2). */
function uuid(value: unknown, path: string): string {
  const text = string(value, path);
  if (!UUID.test(text)) throw new ArchiveFormatError(`${path} must be a lowercase UUID.`);
  return text;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function timestamp(value: unknown, path: string): string {
  const text = string(value, path);
  if (!TIMESTAMP.test(text) || new Date(text).toISOString() !== text) {
    throw new ArchiveFormatError(`${path} must be a UTC timestamp like 2026-10-12T09:30:00.000Z.`);
  }
  return text;
}

function hex(value: unknown, path: string, bytes: number): string {
  const text = string(value, path);
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(text)) {
    throw new ArchiveFormatError(`${path} must be ${bytes * 2} lowercase hex characters.`);
  }
  return text;
}

function base64Url(value: unknown, path: string, bytes: number): string {
  const text = string(value, path);
  let decoded: Bytes;
  try {
    decoded = fromBase64Url(text);
  } catch {
    throw new ArchiveFormatError(`${path} must be unpadded base64url.`);
  }
  if (decoded.length !== bytes) {
    throw new ArchiveFormatError(`${path} must encode exactly ${bytes} bytes.`);
  }
  // Canonical only. A decoder that ignores trailing bits accepts several
  // spellings of one value, and two readers that disagree about which are
  // "valid" are two readers that disagree about a document.
  if (toBase64Url(decoded) !== text) {
    throw new ArchiveFormatError(`${path} must be canonical unpadded base64url.`);
  }
  return text;
}

function blob(
  value: unknown,
  path: string,
  algorithm: 'gcm' | 'x25519',
  maxLength?: number,
): string {
  const text = string(value, path);
  if (maxLength !== undefined && text.length > maxLength) {
    throw new ArchiveFormatError(`${path} is longer than any blob of its kind.`);
  }
  try {
    parseBlob(text, algorithm);
  } catch (cause) {
    if (cause instanceof BlobFormatError) {
      throw new ArchiveFormatError(`${path} is not a well-formed xk2.${algorithm} blob.`);
    }
    throw cause;
  }
  return text;
}

function unique(values: readonly string[], path: string, field: string): void {
  if (new Set(values).size !== values.length) {
    throw new ArchiveFormatError(`${path} repeats a ${field}.`);
  }
}

import {
  DecryptionError,
  MAX_SECRET_VALUE_BYTES,
  SecretTooLargeError,
  UnknownKeyVersionError,
  computeValueHmac,
  fromBase64Url,
  timingSafeEqual,
  zeroize,
} from '@xecret/core/crypto';
import type { Bytes, EncryptedValue, EncryptionContext } from '@xecret/core/crypto';
import { ExportFormatError, formatSecrets } from '@xecret/core/format';
import type { ExportFormat } from '@xecret/core/format';
import { uuidv7 } from '@xecret/core/ids';
import {
  DEFAULT_SECRET_VALUE_TYPE,
  checkSecretValue,
  toSecretValueType,
} from '@xecret/core/validation';
import type { SecretValueType } from '@xecret/core/validation';
import type { AuditMetadata } from '@xecret/core/audit';
import type { Action } from '@xecret/core/authz';
import {
  RepositoryError,
  addSecretVersion,
  createSecret,
  loadEnvironmentKeyChain,
  loadEnvironmentKeyState,
  loadEnvironmentSecrets,
  toBytes,
  updateSecretMetadata,
} from '@xecret/db/repositories';
import type { SecretMaterial, SecretWriterRef } from '@xecret/db/repositories';
import { encodeBlob } from './schemas/vault';
import { actorId } from './actor';
import type { Principal } from './actor';
import type { ServiceContext } from './context';
import { errors } from './errors';
import { enforce, rateLimitKey } from './rate-limit';
import type { RateLimitBucket } from './rate-limit';
import { authorize } from './tenancy';
import type { EnvironmentScope } from './tenancy';

/**
 * The only module in xecret where a plaintext secret can exist — and, for an
 * `e2ee` environment, the module where one provably cannot.
 *
 * ── The claim this comment used to make, and what it says now ──
 * It used to open "the only module in xecret where a plaintext secret exists",
 * and that was true of every environment. Under ADR 0009 it is true of exactly
 * half of them, and leaving the sentence unqualified would be the most misleading
 * line in the codebase: a reader would take the server-envelope guarantees below
 * as covering environments where the server holds no key at all.
 *
 * So the file has two halves, and which one runs is decided by
 * `environments.encryption_mode` — read from the stored row, never from a
 * request:
 *
 *  - **`server`** — the envelope of ADR 0001, unchanged, comment for comment.
 *    `withEnvironmentKey` unwraps the Env Data Key, this layer holds a key and a
 *    value at the same time, and the five properties below are what keep that
 *    safe.
 *  - **`e2ee`** — the hierarchy of ADR 0009. The functions in the client half
 *    (`applyClientSecretWrites`, `writeClientSecretValue`) **never call
 *    `withEnvironmentKey`**, and that is a structural rule rather than an
 *    oversight: there is no key for this environment anywhere in the process, so
 *    reaching for one would either fail or — far worse — succeed against a
 *    leftover `env_keys` row and encrypt a value under a key the server holds.
 *    Ciphertext arrives, is checked for shape, and is stored verbatim.
 *
 * "Where can a secret be decrypted?" is still answerable by
 * `grep -rn 'secrets-service' apps/web`, and the answer is now narrower than it
 * was: only the server half, and only for environments that have not migrated.
 *
 * Five properties are enforced here rather than left to each handler. **All five
 * are about the server half**; the client half needs none of them, because it
 * has no key to unwrap, no context to build, and no plaintext to keep out of a
 * log — which is the whole point of the migration:
 *
 *  1. **The environment key is unwrapped once per request.** `openEnvKey` walks
 *     root → org → env, which is two AES-GCM opens and two key imports. Doing it
 *     per secret would make a 200-secret pull do 200 unwraps for no benefit;
 *     `withEnvironmentKey` does it once and lends the bytes to a callback.
 *  2. **The unwrapped bytes are zeroed in a `finally`, including on the error
 *     path.** `zeroize` is honest about what that buys: a JavaScript engine makes
 *     no promise that this is the only copy of the bytes, and a moving collector
 *     may already have left one behind. It narrows the window in which a heap
 *     snapshot yields a usable key. It does not close it, and nothing here relies
 *     on it having done so.
 *  3. **`EncryptionContext` is built from the stored row, never from the
 *     request.** This is what makes AAD binding a real defence instead of a
 *     decoration. If a reveal of version 3 built its context from the *requested*
 *     version, an attacker who could move a ciphertext row between versions would
 *     have their relocation authenticate cleanly — which is precisely the attack
 *     `aad.ts` exists to defeat.
 *  4. **A `DecryptionError` never reaches a client as detail.** It means the key
 *     is wrong, the AAD is wrong, or the bytes were tampered with, and those are
 *     indistinguishable by design. It becomes a fixed `internal_error`, and only
 *     the category is logged.
 *  5. **No secret value is logged, put in an error message, or placed in an
 *     audit record.** The last of those is a type error rather than a convention:
 *     `AuditMetadata` is an allowlist with no `value` field and no index
 *     signature. The first two are this module's responsibility, and every
 *     `console` and every `errors.*` call below carries only categories, names
 *     and counts.
 *
 * ── What the client half is responsible for instead ──
 * One thing, and it is the same no-op detection the server half performs:
 * comparing the submitted `valueHmac` against the stored one, in constant time,
 * to decide whether a write appends a version. It works identically across an
 * EDK rotation because the HMAC key is derived from the long-lived EHK rather
 * than from the data key (spec §9) — which is the entire reason the EHK exists,
 * and the property that keeps "when did this credential last actually change?"
 * answerable after a revocation.
 */

/** A secret and its current plaintext. Never logged, never audited. */
export interface DecryptedSecret {
  secretId: string;
  name: string;
  value: string;
  version: number;
  updatedAt: Date;
  /** Exactly one of these two names the writer — a person, or a CI token. */
  updatedBy: string | null;
  updatedByServiceTokenId: string | null;
}

/**
 * Everything needed to decrypt one stored value.
 *
 * Deliberately a single record rather than loose `secretId`, `version`,
 * `ciphertext` and `iv` parameters. The context that authenticates a ciphertext
 * has to come from the row that stored it, and a positional parameter list is an
 * invitation to pass the *requested* version alongside the *stored* ciphertext —
 * a mistake that compiles, runs, and silently disables the relocation defence.
 * Taking the row as one value makes that mismatch unrepresentable.
 *
 * `SecretMaterial` from the repository satisfies this structurally, so callers
 * pass repository output straight through.
 */
export interface StoredSecretValue {
  secretId: string;
  environmentId: string;
  version: number;
  /**
   * `null` for a row written under a client-held key.
   *
   * Nullable so that `SecretMaterial` still satisfies this structurally after
   * the dual-mode change, and guarded in `openValue` rather than narrowed at
   * every call site: a row that reached the decryption path with no
   * server-envelope ciphertext is an `e2ee` row on a `server` code path, which is
   * a routing fault worth reporting loudly rather than a case to handle.
   */
  encrypted: EncryptedValue | null;
}

/** A secret this write appends to. Absent means the write creates one. */
export interface ExistingSecret {
  secretId: string;
  /** The current highest version. The new row will be this plus one. */
  version: number;
  valueHmac: Uint8Array | null;
  /** The type currently declared on the row, so a write can inherit it. */
  valueType?: string | undefined;
}

export interface SecretWrite {
  name: string;
  value: string;
  note?: string | null | undefined;
  /**
   * The shape this value is declared to have.
   *
   * Omitted means "whatever the secret already says", falling back to `string`
   * for a new one. That inheritance is what makes the type stick: a rotation
   * performed through the CLI, which knows nothing about types, must not
   * silently downgrade `PORT` back to an unchecked string.
   */
  valueType?: string | undefined;
  existing?: ExistingSecret | undefined;
}

export type SecretWriteStatus = 'created' | 'updated' | 'unchanged';

export interface SecretWriteResult {
  status: SecretWriteStatus;
  secretId: string;
  name: string;
  /** The version now current — unchanged writes report the existing one. */
  version: number;
}

/**
 * A batch of writes and how it should be executed.
 *
 * `dryRun` runs every decision — normalisation, the unchanged check, the version
 * each write would take — and stops before the transaction. The import preview
 * uses it, so the preview is produced by the same code that performs the import
 * rather than by a parallel implementation that can disagree with it.
 */
export interface SecretWriteBatch {
  /** Who the rows are attributed to — a person or a token. See `secretWriter`. */
  writer: SecretWriterRef;
  writes: readonly SecretWrite[];
  dryRun?: boolean | undefined;
}

/** The unwrapped environment key, valid only for the duration of one callback. */
interface EnvironmentKey {
  /** Recorded on every row written under these bytes. */
  envKeyId: string;
  bytes: Bytes;
}

/**
 * Decrypts every current secret in an environment.
 *
 * Two queries: the key chain, then the secrets. Both are constant in the number
 * of secrets — `loadEnvironmentSecrets` resolves "current version of each" with
 * one `DISTINCT ON`, and the key is unwrapped once for the whole set.
 *
 * Decryption is sequential rather than `Promise.all`. AES-GCM over a 64 KB
 * ceiling is CPU-bound, an isolate runs one thread, and parallelism would buy
 * nothing while making the number of simultaneously-live plaintexts unbounded.
 */
export async function decryptEnvironment(
  scope: EnvironmentScope,
  services: ServiceContext,
): Promise<DecryptedSecret[]> {
  return withEnvironmentKey(scope, services, async (key) => {
    const materials = await loadEnvironmentSecrets(
      services.db,
      scope.organization.id,
      scope.environment.id,
    );

    const decrypted: DecryptedSecret[] = [];
    for (const material of materials) {
      decrypted.push({
        secretId: material.secretId,
        name: material.name,
        value: await openValue(scope, services, key.bytes, material),
        version: material.version,
        updatedAt: material.createdAt,
        updatedBy: material.createdBy,
        updatedByServiceTokenId: material.createdByServiceTokenId,
      });
    }

    // Sorted by name, matching the order `listSecrets` renders in the dashboard.
    // `formatSecrets` preserves the caller's order for the line-oriented formats
    // on the grounds that it is "the order the user reasoned about" — which is
    // only true if this path hands it that order. It also makes an exported file
    // produce a one-line diff when a secret is added, rather than a reshuffle.
    // By code unit, not `localeCompare`, so the output does not depend on a
    // server locale.
    return decrypted.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  });
}

/**
 * Decrypts one stored value.
 *
 * One query — the key chain. The caller has already fetched the row, because the
 * row is what says which version this ciphertext belongs to.
 */
export async function decryptOne(
  scope: EnvironmentScope,
  services: ServiceContext,
  stored: StoredSecretValue,
): Promise<string> {
  return withEnvironmentKey(scope, services, (key) =>
    openValue(scope, services, key.bytes, stored),
  );
}

/** Writes one secret. See `applySecretWrites` for the semantics. */
export async function writeSecretValue(
  scope: EnvironmentScope,
  services: ServiceContext,
  params: SecretWrite & { writer: SecretWriterRef },
): Promise<SecretWriteResult> {
  const { writer, ...write } = params;
  const [result] = await applySecretWrites(scope, services, { writer, writes: [write] });

  if (!result) {
    // Unreachable: one write in, one result out. A throw rather than a non-null
    // assertion so that a future change to the batch semantics fails loudly
    // instead of returning a fabricated result for a row nobody wrote.
    throw errors.internal('secret write produced no result');
  }

  return result;
}

/**
 * Applies a batch of writes under a single unwrapped environment key, in a
 * single transaction.
 *
 * The unchanged short-circuit is the reason `value_hmac` exists. Re-submitting a
 * value that is already stored must not append a version: history is what
 * rotation tracking reads, and a column of no-op bumps makes "when did this
 * credential last actually change?" unanswerable. The comparison is done on the
 * HMAC rather than by decrypting the stored value, so the cheap path stays cheap,
 * and with `timingSafeEqual` rather than `===` because the attacker chooses the
 * plaintext and a byte-at-a-time timing signal on a stored tag is a real, if
 * narrow, oracle.
 *
 * Everything that needs the key — the HMAC and the encryption — happens before
 * the transaction opens, so no cryptography runs while a database transaction is
 * held open.
 */
export async function applySecretWrites(
  scope: EnvironmentScope,
  services: ServiceContext,
  batch: SecretWriteBatch,
): Promise<SecretWriteResult[]> {
  // No key is unwrapped for an empty batch: an import whose plan writes nothing
  // must not touch the key hierarchy at all.
  if (batch.writes.length === 0) return [];

  return withEnvironmentKey(scope, services, async (key) => {
    const prepared: PreparedWrite[] = [];

    for (const write of batch.writes) {
      prepared.push(await prepareWrite(scope, services, key, batch.dryRun === true, write));
    }

    const results = prepared.map(toWriteResult);

    // Stated as its own branch rather than left to fall out of `isPendingWrite`
    // returning nothing: "a dry run does not open a transaction" is a property
    // worth reading in one line instead of inferring from a type predicate.
    if (batch.dryRun === true) return results;

    const pending = prepared.filter(isPendingWrite);

    // A row whose value did not change but whose declared type did. It writes no
    // version and needs no key — see `updateSecretMetadata` — so it is collected
    // separately rather than smuggled through the ciphertext path.
    const retypeOnly = prepared.filter(
      (write): write is UnchangedWrite => write.kind === 'unchanged' && write.retypes,
    );

    if (pending.length === 0 && retypeOnly.length === 0) return results;

    await commitWrites(services, scope, key, batch.writer, pending, retypeOnly);
    return results;
  });
}

/**
 * Re-encrypts an earlier version as a new one.
 *
 * The old ciphertext is **decrypted and encrypted again**, never copied forward.
 * That is not a stylistic preference: the AAD binds `version`, so a row whose
 * ciphertext was produced for version 3 and stored as version 7 would fail to
 * decrypt for the rest of its life. Copying the bytes is the one implementation
 * of "restore" that looks obviously correct and is silently, permanently wrong.
 *
 * Both operations happen under one unwrapped key, and the old value's context is
 * built from the *old* row while the new value's context is built from the row
 * about to be written.
 */
export async function restoreSecretVersion(
  scope: EnvironmentScope,
  services: ServiceContext,
  params: { writer: SecretWriterRef; current: SecretMaterial; previous: SecretMaterial },
): Promise<SecretWriteResult> {
  return withEnvironmentKey(scope, services, async (key) => {
    const value = await openValue(scope, services, key.bytes, params.previous);

    const write: SecretWrite = {
      name: params.current.name,
      value,
      existing: {
        secretId: params.current.secretId,
        version: params.current.version,
        valueHmac: params.current.valueHmac,
      },
    };

    const prepared = await prepareWrite(scope, services, key, false, write);

    if (isPendingWrite(prepared)) {
      await commitWrites(services, scope, key, params.writer, [prepared]);
    }

    return toWriteResult(prepared);
  });
}

/**
 * One client-encrypted value, exactly as it arrived and exactly as it is stored.
 *
 * Every field is opaque to this process. `ciphertext` is the ASCII of an
 * `xk2.gcm.` blob whose IV is inside the payload (spec §2.1); `valueHmac` is a
 * tag keyed from a key the server has never held. Nothing here is decoded, and
 * the types say so: they are `string` and `Uint8Array`, never `EncryptedValue`,
 * because `EncryptedValue` is the shape `EnvelopeService` consumes and no value
 * in this record may ever reach it.
 */
export interface ClientSecretValue {
  /** `xk2.gcm.` blob (spec §2.2, type 9). Stored verbatim. */
  ciphertext: string;
  /** What the client says it used, e.g. `xk2.gcm`. A label, never a decision. */
  clientAlgorithm: string;
  /** The `env_data_keys` row the client sealed against. Checked, not trusted. */
  envDataKeyId: string;
  /** `HMAC-SHA256(HKDF(EHK), plaintext)`, base64url. The no-op detector. */
  valueHmac: string;
  /** `xk2.gcm.` blob (type 10), or `null` to clear. Absent leaves it unchanged. */
  encNote?: string | null | undefined;
}

export interface ClientSecretWrite {
  name: string;
  /**
   * The id the row takes if this write **creates** one.
   *
   * Chosen by the client and not by this process, because the AAD binds it (spec
   * §4.2) and the encryption happened in a browser before the request existed.
   * Ignored when `existing` is present: an append keeps the stored id, which is
   * the one that ciphertext was sealed against.
   */
  secretId: string;
  value: ClientSecretValue;
  valueType?: string | undefined;
  existing?: ExistingSecret | undefined;
}

export interface ClientSecretWriteBatch {
  writer: SecretWriterRef;
  writes: readonly ClientSecretWrite[];
  dryRun?: boolean | undefined;
}

/**
 * Applies client-encrypted writes.
 *
 * ── The shape of this function beside `applySecretWrites` ──
 * It is deliberately the *same* shape — batch in, results out, `dryRun` stopping
 * before the transaction, `unchanged` decided by an HMAC comparison — and
 * deliberately *not* a branch inside the other one. Two reasons, and the second
 * is the important one:
 *
 *  1. The server-mode path is a regression surface with its own test suite, and
 *     threading a mode through it would put an `if` between every existing
 *     assertion and the code it covers.
 *  2. **`withEnvironmentKey` is unreachable from here**, and that has to be
 *     visible rather than argued. A shared function with a mode flag would have
 *     one call site that unwraps a key and a flag deciding whether to take it;
 *     a reader would have to trust the flag. Two functions mean the client path
 *     contains no reference to the key hierarchy at all, and a diff that
 *     introduced one would be obvious.
 *
 * ── What is validated, and by whom ──
 * The shape of every blob was checked at the API boundary (`schemas/secrets.ts`).
 * The *key* it was sealed against is checked here, against the environment's
 * active EDK: a value encrypted under a key that has since been rotated away
 * would be stored looking exactly like a working row and would open for nobody.
 * Nothing else can be checked, because nothing else is legible without a key.
 */
export async function applyClientSecretWrites(
  scope: EnvironmentScope,
  services: ServiceContext,
  batch: ClientSecretWriteBatch,
): Promise<SecretWriteResult[]> {
  if (batch.writes.length === 0) return [];

  const activeKeyId = await requireActiveDataKey(scope, services);

  const prepared: PreparedClientWrite[] = [];
  for (const write of batch.writes) {
    prepared.push(prepareClientWrite(activeKeyId, write));
  }

  const results = prepared.map(toClientWriteResult);
  if (batch.dryRun === true) return results;

  const pending = prepared.filter((write) => write.kind !== 'unchanged');
  const noteOnly = prepared.filter(
    (write) => write.kind === 'unchanged' && write.encNote !== undefined,
  );

  if (pending.length === 0 && noteOnly.length === 0) return results;

  await commitClientWrites(services, scope, batch.writer, prepared);
  return results;
}

/** Writes one client-encrypted secret. See `applyClientSecretWrites`. */
export async function writeClientSecretValue(
  scope: EnvironmentScope,
  services: ServiceContext,
  params: ClientSecretWrite & { writer: SecretWriterRef },
): Promise<SecretWriteResult> {
  const { writer, ...write } = params;
  const [result] = await applyClientSecretWrites(scope, services, { writer, writes: [write] });

  if (!result) {
    // Unreachable: one write in, one result out. A throw rather than a non-null
    // assertion so a future change to the batch semantics fails loudly instead
    // of returning a fabricated result for a row nobody wrote.
    throw errors.internal('client secret write produced no result');
  }

  return result;
}

/**
 * Renders decrypted secrets into a downloadable document.
 *
 * Lives here rather than in a route because it takes plaintext values, and every
 * function that does belongs in the module a reviewer already reads for that
 * reason. `formatSecrets` guarantees the round trip; this adds the one thing a
 * route needs and the formatter cannot know — how the failure should be reported.
 */
export function renderSecretDocument(
  secrets: readonly DecryptedSecret[],
  format: ExportFormat,
): { body: string; contentType: string; extension: string } {
  try {
    return {
      body: formatSecrets(
        secrets.map((secret) => ({ name: secret.name, value: secret.value })),
        format,
      ),
      contentType: DOCUMENT_CONTENT_TYPE[format],
      extension: DOCUMENT_EXTENSION[format],
    };
  } catch (cause) {
    if (cause instanceof ExportFormatError) {
      // The secret's *name* is included and nothing else from the exception is.
      // A name is a stored, pattern-validated identifier, and the caller has
      // already been authorised to list every name in this environment — so it
      // discloses nothing new, while "one of your 200 secrets cannot be
      // represented" would be unactionable. The value, and the formatter's
      // reasoning about it, stay on the server.
      throw errors.badRequest(
        `"${cause.secretName}" cannot be represented in ${format} format. Export it as env or json instead.`,
      );
    }
    throw cause;
  }
}

/** A client-mode write, once its outcome has been decided. */
interface PreparedClientWrite {
  kind: 'create' | 'append' | 'unchanged';
  secretId: string;
  name: string;
  version: number;
  valueType: SecretValueType;
  retypes: boolean;
  value: ClientSecretValue;
  /** `undefined` leaves the stored note alone; `null` clears it. */
  encNote: Uint8Array | null | undefined;
}

/**
 * Decides what one client-encrypted write will do.
 *
 * ── What is deliberately *not* done here ──
 * No value-type check. `checkSecretValue` inspects a plaintext, and this path has
 * none: the shape of an `e2ee` value is the client's to enforce, using the same
 * `@xecret/core/validation` module the dashboard already runs as you type. This
 * is the one guarantee the migration genuinely gives up, and pretending otherwise
 * — by checking the ciphertext's length, say — would be worse than conceding it.
 * The declared type is still stored, still inherited, and still the rule the
 * client applies.
 *
 * The secret's id is chosen here for the same reason the server path chooses it:
 * the AAD binds it (spec §4.2), so a value cannot be encrypted for a row whose
 * identity does not exist yet. The difference is that on this path the *client*
 * chose it, minted it into the AAD, and sent it — which is why a create carries
 * a `secretId` from the request rather than one invented at this line.
 */
function prepareClientWrite(activeKeyId: string, write: ClientSecretWrite): PreparedClientWrite {
  if (write.value.envDataKeyId !== activeKeyId) {
    // Refused before anything is written, and a conflict rather than a
    // validation error: the body was well-formed and was correct when the client
    // built it. Somebody rotated in between, and the remedy is to re-read the
    // keys and encrypt again — which is a retry, not a fix.
    throw errors.conflict(
      'This environment was rotated while you were editing. Re-read its keys and try again.',
    );
  }

  const valueType = resolveClientValueType(write);
  const storedType = toSecretValueType(write.existing?.valueType);
  const retypes = write.existing !== undefined && storedType !== valueType;

  const encNote =
    write.value.encNote === undefined
      ? undefined
      : write.value.encNote === null
        ? null
        : encodeBlob(write.value.encNote);

  const existing = write.existing;
  const valueHmac = fromBase64Url(write.value.valueHmac);

  if (existing && existing.valueHmac !== null) {
    // The same comparison the server path makes, on the same column, with the
    // same `timingSafeEqual` — the attacker chooses the plaintext, and a
    // byte-at-a-time timing signal on a stored tag is a real if narrow oracle.
    // What differs is only who computed the tag: here the client did, from the
    // EHK, which is why it survives an EDK rotation.
    if (timingSafeEqual(toBytes(existing.valueHmac), valueHmac)) {
      return {
        kind: 'unchanged',
        secretId: existing.secretId,
        name: write.name,
        version: existing.version,
        valueType,
        retypes,
        value: write.value,
        encNote,
      };
    }
  }

  return {
    kind: existing ? 'append' : 'create',
    // The client's id on a create, the stored one on an append. Never minted
    // here: a value encrypted against an id this line invented would fail to
    // authenticate on its first read, for ever, with nothing at write time
    // saying so.
    secretId: existing ? existing.secretId : write.secretId,
    name: write.name,
    version: existing ? existing.version + 1 : 1,
    valueType,
    retypes,
    value: write.value,
    encNote,
  };
}

/**
 * Writes the prepared client rows in one transaction.
 *
 * The version check after `addSecretVersion` matters more here than it does on
 * the server path, not less. The AAD binds `version` (spec §4.2), and the client
 * encrypted for the version it expected; if another writer commits first, the
 * `MAX(version) + 1` subquery yields a higher number and the row inserts cleanly
 * at a version its ciphertext was never bound to. On the server path that row
 * would be undecryptable forever and an operator could at least re-encrypt it
 * from a backup. Here **nobody** can repair it, because nobody but the client
 * holds the key. So the mismatch is a rollback and a 409 the client retries.
 */
async function commitClientWrites(
  services: ServiceContext,
  scope: EnvironmentScope,
  writer: SecretWriterRef,
  writes: readonly PreparedClientWrite[],
): Promise<void> {
  try {
    await services.db.transaction(async (tx) => {
      for (const write of writes) {
        const payload = {
          mode: 'e2ee' as const,
          envDataKeyId: write.value.envDataKeyId,
          ciphertext: encodeBlob(write.value.ciphertext),
          clientAlgorithm: write.value.clientAlgorithm,
        };

        if (write.kind === 'create') {
          await createSecret(tx, {
            id: write.secretId,
            orgId: scope.organization.id,
            environmentId: scope.environment.id,
            name: write.name,
            // `note` is left NULL and `encNote` carries the note: an `e2ee`
            // secret must not have a plaintext note beside its encrypted value,
            // because a note is free text people put credentials in.
            encNote: write.encNote ?? null,
            valueType: write.valueType,
            payload,
            valueHmac: fromBase64Url(write.value.valueHmac),
            writer,
          });
          continue;
        }

        if (write.kind === 'append') {
          const version = await addSecretVersion(tx, {
            orgId: scope.organization.id,
            secretId: write.secretId,
            payload,
            valueHmac: fromBase64Url(write.value.valueHmac),
            writer,
          });

          if (version.version !== write.version) {
            throw errors.conflict('This secret was changed by another request. Retry the update.');
          }
        }

        // Metadata that travelled with the value — a redeclared type, a new
        // encrypted note — lands in the same transaction as the version, so a
        // committed value can never sit under a rolled-back label. Reached on
        // the `unchanged` branch too, which is the case that would otherwise
        // vanish: the HMAC matched, the write short-circuited, and the note the
        // user just typed would spring back on the next reload.
        if (write.retypes || write.encNote !== undefined) {
          await updateSecretMetadata(tx, {
            orgId: scope.organization.id,
            environmentId: scope.environment.id,
            name: write.name,
            ...(write.retypes ? { valueType: write.valueType } : {}),
            ...(write.encNote === undefined ? {} : { encNote: write.encNote }),
          });
        }
      }
    });
  } catch (cause) {
    rethrowRepositoryFailure(cause);
  }
}

/**
 * The environment's active data key id, or a refusal.
 *
 * An `e2ee` environment with no active key is not a state any code path can
 * create — `createEnvironment` writes the environment and its key in one
 * transaction — so this is the mirror of `withEnvironmentKey`'s unreachable
 * branch, and it answers the same way: a 503, because the deployment is broken
 * rather than the request. What differs is the repair, and the comment says so
 * plainly: no operator can fix this one, because the key never existed outside a
 * browser. Only `POST …/keys` from a member who somehow still holds it can.
 */
async function requireActiveDataKey(
  scope: EnvironmentScope,
  services: ServiceContext,
): Promise<string> {
  const state = await loadEnvironmentKeyState(
    services.db,
    scope.organization.id,
    scope.environment.id,
  );

  if (state.activeKey === null) {
    services.log
      .at('requireActiveDataKey')
      .error(
        'This end-to-end encrypted environment has no active data key, so nothing in it can be ' +
          'written or read. An environment is created together with its key in one transaction, ' +
          'so this should be unreachable — and unlike the server envelope, no operator can ' +
          'repair it: the key only ever existed inside the browser that generated it.',
        { environmentId: scope.environment.id },
      );
    throw errors.unavailable('environment has no active data key');
  }

  return state.activeKey.id;
}

/**
 * The declared shape of a client-encrypted write.
 *
 * The same precedence as the server path — request, then the stored declaration,
 * then `string` — so a type sticks to a secret across a rotation performed by a
 * client that sends none. What is missing, and missing on purpose, is the check:
 * see `prepareClientWrite`.
 */
function resolveClientValueType(write: ClientSecretWrite): SecretValueType {
  if (write.valueType !== undefined) return toSecretValueType(write.valueType);
  if (write.existing?.valueType !== undefined) return toSecretValueType(write.existing.valueType);
  return DEFAULT_SECRET_VALUE_TYPE;
}

function toClientWriteResult(write: PreparedClientWrite): SecretWriteResult {
  const status: SecretWriteStatus =
    write.kind === 'unchanged' ? 'unchanged' : write.kind === 'create' ? 'created' : 'updated';

  return { status, secretId: write.secretId, name: write.name, version: write.version };
}

/**
 * Refuses a server-side rendering of an end-to-end encrypted environment.
 *
 * `renderSecretDocument` takes plaintext, and for an `e2ee` environment there is
 * none to take. The client holds every value already — it decrypted them to show
 * them — so formatting is something it can do without a round trip, using the
 * same `@xecret/core/format` module compiled for the browser. Phase 3b moves it
 * there; this is the refusal in the meantime.
 *
 * 409 rather than 501 or 400: the resource exists, the caller may read it, and
 * the request is simply inapplicable to the state the environment is in — the
 * same reading `requireE2ee` gives the mirror case. The `reason` code is stable
 * so a client can branch on it rather than on prose.
 */
export function assertDocumentRenderable(scope: EnvironmentScope): void {
  if (scope.environment.encryptionMode === 'e2ee') {
    throw errors.conflict(
      'client_side_only: this environment is end-to-end encrypted, so the server cannot render ' +
        'its values. Format them in the client from the ciphertext it already holds.',
    );
  }
}

/**
 * Authorises a secret action, supplying a service token's own access level.
 *
 * `can()` is deny-closed when a service token arrives without its context, so
 * forgetting the third argument fails safe — but it fails safe by breaking CI,
 * which is a bug report rather than a breach. Threading it through one function
 * means no route can forget it, and there is still exactly one decision
 * procedure: this delegates to `authorize`, which delegates to `assertCan`.
 */
export function authorizeSecretAction(
  scope: EnvironmentScope,
  principal: Principal,
  action: Action,
): void {
  authorize(scope, action, {
    serviceTokenAccessLevel: principal.kind === 'serviceToken' ? principal.accessLevel : undefined,
  });
}

/**
 * Who a write is attributed to.
 *
 * Phase 4 refused service-token writes outright, because `created_by` was
 * `NOT NULL REFERENCES users` and a CI credential has no person behind it —
 * structurally, so that a stolen CI credential can never act as a person
 * (threat T5). Migration 0006 resolved that the honest way: a second
 * attribution column naming the *token*, with a CHECK requiring exactly one of
 * the two. A CI write is now recorded as the act of a named token — never as
 * the act of whoever minted it, which would put a person's name on a write
 * they did not make in the exact column the dashboard shows as "who changed
 * this".
 *
 * Whether a given service token *may* write is still the policy layer's
 * question: `can()` requires a `write`-level token, and `secret.delete` /
 * `secret.rotate` remain outside `SERVICE_TOKEN_ACTIONS` entirely.
 */
export function secretWriter(principal: Principal): SecretWriterRef {
  switch (principal.kind) {
    case 'user':
      return { userId: principal.user.id };
    case 'cliToken':
      return { userId: principal.userId };
    case 'serviceToken':
      return { serviceTokenId: principal.tokenId };
  }
}

/**
 * Applies the rate limit for a secret operation.
 *
 * §6 of the API contract assigns `RL_SECRET_READ` to reveal and pull,
 * `RL_MUTATION` to every other write, and `RL_SERVICE` to service-token traffic
 * — which is a separate bucket precisely so a runaway CI pipeline cannot spend
 * the budget a human's dashboard depends on. Deciding that here means no route
 * picks the bucket itself, and the key is always the actor, never the resource:
 * limiting per secret would let one caller hammer a thousand names in turn.
 *
 * The counters are per-colo, so this is abuse control and not a security
 * boundary. What protects a secret is authentication, authorization, and the
 * audit trail.
 */
export async function enforceSecretRateLimit(
  services: ServiceContext,
  principal: Principal,
  operation: 'read' | 'write',
): Promise<void> {
  const bucket: RateLimitBucket =
    principal.kind === 'serviceToken'
      ? 'RL_SERVICE'
      : operation === 'read'
        ? 'RL_SECRET_READ'
        : 'RL_MUTATION';

  await enforce(services.env, bucket, rateLimitKey([actorId(principal)]));
}

/** How an action reached the API, for the audit record. */
export function auditSource(principal: Principal): NonNullable<AuditMetadata['source']> {
  switch (principal.kind) {
    case 'user':
      return 'dashboard';
    case 'cliToken':
      return 'cli';
    case 'serviceToken':
      return 'ci';
  }
}

const DOCUMENT_CONTENT_TYPE: Readonly<Record<ExportFormat, string>> = {
  env: 'text/plain; charset=utf-8',
  shell: 'text/plain; charset=utf-8',
  docker: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  yaml: 'application/yaml; charset=utf-8',
};

const DOCUMENT_EXTENSION: Readonly<Record<ExportFormat, string>> = {
  env: 'env',
  shell: 'sh',
  docker: 'env',
  json: 'json',
  yaml: 'yaml',
};

interface UnchangedWrite {
  kind: 'unchanged';
  secretId: string;
  name: string;
  version: number;
  valueType: SecretValueType;
  /**
   * True when the value is unchanged but its *declared type* is not.
   *
   * Tracked on this branch as well as on a real write, because "declare PORT an
   * integer" submitted alongside the value it already holds is a change the user
   * asked for and would otherwise vanish: the HMAC matches, the write
   * short-circuits, and the dropdown silently springs back on the next reload.
   */
  retypes: boolean;
}

interface PlannedWrite {
  kind: 'create' | 'append';
  secretId: string;
  name: string;
  note: string | null;
  /** Resolved: the request's type, the stored one, or `string`. */
  valueType: SecretValueType;
  /** True when this write also changes the type declared on `secrets`. */
  retypes: boolean;
  version: number;
  /**
   * Absent on a dry run, which answers "what would happen" and has no reason to
   * produce ciphertext nobody will store. Its absence is also what stops a
   * previewed write from reaching the database: `isPendingWrite` is the only
   * route into `commitWrites`, and it requires this field.
   */
  encrypted?: EncryptedValue | undefined;
  valueHmac: Bytes;
}

type PreparedWrite = UnchangedWrite | PlannedWrite;

type PendingWrite = PlannedWrite & { encrypted: EncryptedValue };

function isPendingWrite(write: PreparedWrite): write is PendingWrite {
  return write.kind !== 'unchanged' && write.encrypted !== undefined;
}

function toWriteResult(write: PreparedWrite): SecretWriteResult {
  const status: SecretWriteStatus =
    write.kind === 'unchanged' ? 'unchanged' : write.kind === 'create' ? 'created' : 'updated';

  return { status, secretId: write.secretId, name: write.name, version: write.version };
}

/**
 * Decides what one write will do, and encrypts it if it will do anything.
 *
 * The secret's id is chosen *here* rather than by the database, because the AAD
 * binds it: a value cannot be encrypted for a row whose identity does not exist
 * yet. `createSecret` accepts the id for that reason. UUIDv7 is generated the
 * same way the repository would have generated it, so ordering by primary key
 * still means ordering by creation time.
 */
async function prepareWrite(
  scope: EnvironmentScope,
  services: ServiceContext,
  key: EnvironmentKey,
  dryRun: boolean,
  write: SecretWrite,
): Promise<PreparedWrite> {
  // ── The declared shape, checked before anything else happens ──
  //
  // First, so a value of the wrong shape costs a regular expression rather than
  // an HMAC and an encryption. And here rather than in the route, because *this*
  // is the choke point every write passes through: the dashboard, the CLI, the
  // import endpoint and a restore all arrive at this function, and a check in
  // any one of them would be a check the other three do not perform.
  //
  // The dashboard checks the same thing as you type, using the same module. That
  // copy is for the person; this one is the rule.
  const valueType = resolveValueType(write);
  const shape = checkSecretValue(write.value, valueType);
  if (!shape.valid) {
    // The message comes from `checkSecretValue`, which builds it from fixed
    // strings and the type's name and never from the value — see the note at
    // the top of `value-type.ts`. That is what makes it safe to return here.
    throw errors.validation([
      { field: 'value', message: shape.message ?? `That is not a valid ${valueType}.` },
    ]);
  }

  // Compared against the *normalised* stored type, not the raw column. An older
  // row, or a caller that passes no type at all, reads as `string` — which is
  // what it is. Comparing the raw `undefined` instead made every ordinary write
  // look like a retype and issued a pointless metadata UPDATE alongside it.
  const storedType = toSecretValueType(write.existing?.valueType);
  const retypes = write.existing !== undefined && storedType !== valueType;

  const valueHmac = await computeValueHmac({
    envKeyBytes: key.bytes,
    environmentId: scope.environment.id,
    plaintext: write.value,
  });

  const existing = write.existing;

  if (existing && existing.valueHmac !== null) {
    if (timingSafeEqual(toBytes(existing.valueHmac), valueHmac)) {
      return {
        kind: 'unchanged',
        secretId: existing.secretId,
        name: write.name,
        version: existing.version,
        valueType,
        retypes,
      };
    }
  }

  const secretId = existing ? existing.secretId : uuidv7();
  const version = existing ? existing.version + 1 : 1;
  const kind = existing ? ('append' as const) : ('create' as const);

  if (dryRun) {
    return {
      kind,
      secretId,
      name: write.name,
      note: write.note ?? null,
      valueType,
      retypes,
      version,
      valueHmac,
    };
  }

  const context: EncryptionContext = {
    orgId: scope.organization.id,
    environmentId: scope.environment.id,
    secretId,
    version,
  };

  try {
    return {
      kind,
      secretId,
      name: write.name,
      note: write.note ?? null,
      valueType,
      retypes,
      version,
      encrypted: await services.envelope.encrypt(key.bytes, context, write.value),
      valueHmac,
    };
  } catch (cause) {
    rethrowCryptoFailure(cause, services);
  }
}

/**
 * Writes the prepared rows in one transaction.
 *
 * The version check after `addSecretVersion` is the subtle part.
 * `secret_versions.version` is computed as `MAX(version) + 1` *inside* the
 * INSERT, while the AAD was computed against the version this request expected.
 * Two writers racing usually collide on
 * `secret_versions_secret_version_unique`, which the repository reports as a
 * retryable conflict — but not always: if the other writer commits first, the
 * subquery simply yields a higher number and our row inserts cleanly at a
 * version its ciphertext was never bound to. That row would be undecryptable
 * forever, with no error anywhere.
 *
 * Comparing the assigned version with the expected one turns that into a
 * rollback and a 409 the client can retry. It is the only reason these writes
 * need an outer transaction at all.
 */
async function commitWrites(
  services: ServiceContext,
  scope: EnvironmentScope,
  key: EnvironmentKey,
  writer: SecretWriterRef,
  writes: readonly PendingWrite[],
  retypes: readonly UnchangedWrite[] = [],
): Promise<void> {
  try {
    await services.db.transaction(async (tx) => {
      for (const write of writes) {
        const payload = {
          mode: 'server' as const,
          envKeyId: key.envKeyId,
          encrypted: write.encrypted,
        };

        if (write.kind === 'create') {
          await createSecret(tx, {
            id: write.secretId,
            orgId: scope.organization.id,
            environmentId: scope.environment.id,
            name: write.name,
            note: write.note,
            valueType: write.valueType,
            payload,
            valueHmac: write.valueHmac,
            writer,
          });
          continue;
        }

        const version = await addSecretVersion(tx, {
          orgId: scope.organization.id,
          secretId: write.secretId,
          payload,
          valueHmac: write.valueHmac,
          writer,
        });

        if (version.version !== write.version) {
          throw errors.conflict('This secret was changed by another request. Retry the update.');
        }

        // Inside the same transaction as the version it accompanies. "This is a
        // port number, and here it is" has to land as one change or neither —
        // a committed value under a rolled-back type is exactly the mismatch
        // this feature exists to prevent.
        if (write.retypes) {
          await updateSecretMetadata(tx, {
            orgId: scope.organization.id,
            environmentId: scope.environment.id,
            name: write.name,
            valueType: write.valueType,
          });
        }
      }

      for (const write of retypes) {
        await updateSecretMetadata(tx, {
          orgId: scope.organization.id,
          environmentId: scope.environment.id,
          name: write.name,
          valueType: write.valueType,
        });
      }
    });
  } catch (cause) {
    rethrowRepositoryFailure(cause);
  }
}

/**
 * Decides which type a write is checked against.
 *
 * The precedence — request, then the stored declaration, then `string` — is what
 * makes a type stick once it is set. A rotation performed by `xecret set`, which
 * has never heard of value types and sends no `valueType`, inherits the
 * declaration already on the row; without that, the CLI would silently downgrade
 * every typed secret it touched back to an unchecked string, and the check would
 * quietly stop applying to exactly the secrets that get rotated most.
 *
 * `toSecretValueType` rather than a cast, so a row written by a newer deployment
 * naming a type this build does not implement degrades to `string` — accepting
 * the value — instead of throwing and making the secret unwritable.
 */
function resolveValueType(write: SecretWrite): SecretValueType {
  if (write.valueType !== undefined) return toSecretValueType(write.valueType);
  if (write.existing?.valueType !== undefined) return toSecretValueType(write.existing.valueType);
  return DEFAULT_SECRET_VALUE_TYPE;
}

/**
 * Unwraps the environment's data key, lends it to `use`, and zeroes it.
 *
 * One query — `loadEnvironmentKeyChain` returns the env key and the org key that
 * wrapped it together, so the walk down the hierarchy costs no extra round trip.
 * The `finally` runs on the error path too, which is the path that matters: a
 * decryption failure is exactly when key bytes must not be left lying in the
 * heap while an exception unwinds through the runtime.
 *
 * See `zeroize` for what wiping does and does not achieve in a garbage-collected
 * runtime. It narrows the window; it is not a guarantee, and nothing here treats
 * it as one.
 */
async function withEnvironmentKey<T>(
  scope: EnvironmentScope,
  services: ServiceContext,
  use: (key: EnvironmentKey) => Promise<T>,
): Promise<T> {
  const chain = await loadEnvironmentKeyChain(
    services.db,
    scope.organization.id,
    scope.environment.id,
  );

  if (!chain) {
    // An environment is created together with its key, in one transaction, so
    // this is not reachable by any normal path. If it happens, the environment
    // is unusable and only an operator holding the Root KEK can repair it —
    // which is a 503, not a 500: the deployment is broken, not the request.
    services.log
      .at('withEnvironmentKey')
      .error(
        'This environment has no active data key, so nothing in it can be encrypted or ' +
          'decrypted. An environment is created together with its key in one transaction, so ' +
          'this should be unreachable — repairing it needs an operator holding the Root KEK.',
        { environmentId: scope.environment.id },
      );
    throw errors.unavailable('environment has no active env key');
  }

  let bytes: Bytes;
  try {
    bytes = await services.envelope.openEnvKey({
      orgId: scope.organization.id,
      environmentId: scope.environment.id,
      orgKey: chain.orgKey,
      envKey: chain.envKey,
    });
  } catch (cause) {
    rethrowCryptoFailure(cause, services);
  }

  try {
    return await use({ envKeyId: chain.envKeyId, bytes });
  } finally {
    zeroize(bytes);
  }
}

/**
 * Decrypts one value under an already-unwrapped key.
 *
 * **Every component of the context comes from the stored row.** `environmentId`
 * is taken from `stored` rather than from `scope`, even though the repository's
 * joins guarantee they are equal — the guarantee lives in a query someone may
 * later edit, and taking the value from the row means this function cannot be
 * the place that becomes wrong. `version` is the stored version, never a
 * requested one: using the request's version here would authenticate exactly the
 * relocation the AAD exists to reject.
 */
async function openValue(
  scope: EnvironmentScope,
  services: ServiceContext,
  envKeyBytes: Bytes,
  stored: StoredSecretValue,
): Promise<string> {
  if (stored.encrypted === null) {
    // An `e2ee` row on the server decryption path: a routing fault, not a
    // cryptographic one. It means a caller reached `decryptOne` for an
    // environment whose values the server holds no key for, and the correct
    // answer is a loud 500 rather than a `DecryptionError` that would read as
    // tampering and send an operator hunting for a corrupted row.
    services.log
      .at('openValue')
      .error(
        'A client-encrypted secret version reached the server decryption path. This environment ' +
          'is end-to-end encrypted, so no key here can open it — the caller routed to the wrong ' +
          'half of secrets-service.ts.',
        { environmentId: stored.environmentId, reason: 'clientEncrypted' },
      );
    throw errors.internal('clientEncryptedOnServerPath');
  }

  const context: EncryptionContext = {
    orgId: scope.organization.id,
    environmentId: stored.environmentId,
    secretId: stored.secretId,
    version: stored.version,
  };

  try {
    return await services.envelope.decrypt(envKeyBytes, context, stored.encrypted);
  } catch (cause) {
    rethrowCryptoFailure(cause, services);
  }
}

/**
 * Converts a cryptographic failure into a response, and logs only its category.
 *
 * A `DecryptionError` carries no detail on purpose — wrong key, wrong AAD,
 * truncated input and forged tag are indistinguishable, because telling an
 * attacker which part of their guess was wrong is a usable oracle. It is not a
 * client error either: a caller who was authorised to read a secret and got
 * ciphertext that will not open has hit either tampering or a key mismatch, and
 * both are operator-level events. So it becomes a fixed `internal_error`, and the
 * log line records the category and the request id and nothing about the value.
 */
function rethrowCryptoFailure(cause: unknown, services: ServiceContext): never {
  const log = services.log.at('rethrowCryptoFailure');

  if (cause instanceof DecryptionError) {
    log.error(
      'Could not decrypt a stored secret value. The ciphertext, the environment key, or the ' +
        'associated data does not match — which means either tampering with a stored row or a ' +
        'key that no longer corresponds to it. Neither is a client error.',
      { reason: 'decryptionFailed' },
    );
    throw errors.internal('decryptionFailed');
  }

  if (cause instanceof UnknownKeyVersionError) {
    // A stored row references a root key version the provider can no longer
    // supply: a rotation was completed before every row was re-wrapped. The
    // deployment is misconfigured, so 503 rather than 500.
    log.error(
      `A stored key is wrapped with root key version ${cause.requestedVersion}, which this ` +
        'deployment cannot supply. A key rotation was completed before every row had been ' +
        're-wrapped; restore that version to XECRET_ROOT_KEYS to make these secrets readable.',
      { requestedVersion: cause.requestedVersion },
    );
    throw errors.unavailable('root key version unavailable');
  }

  if (cause instanceof SecretTooLargeError) {
    // The byte length, not the value. `MAX_SECRET_VALUE_BYTES` is a constant and
    // the observed length is a property of a request the caller already sent.
    throw errors.tooLarge(`Secret value cannot exceed ${MAX_SECRET_VALUE_BYTES} bytes.`);
  }

  throw cause;
}

/**
 * Maps a repository invariant failure onto the API's vocabulary.
 *
 * The repository's messages name secrets and organisation ids, so they are used
 * as `logDetail` — which never leaves the server — and the client receives one
 * of the fixed strings from `errors`. `notFound` covers the case where the
 * environment or secret vanished between resolution and write; it is the same
 * response a caller with no right to it would have received.
 */
export function rethrowRepositoryFailure(cause: unknown): never {
  if (cause instanceof RepositoryError) {
    switch (cause.code) {
      case 'conflict':
        throw errors.conflict('A secret with that name already exists in this environment.');
      case 'notFound':
        throw errors.notFound(cause.message);
      default:
        throw errors.badRequest('The request could not be applied to this environment.');
    }
  }

  throw cause;
}

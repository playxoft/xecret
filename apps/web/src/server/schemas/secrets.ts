import * as z from 'zod/mini';
import { MAX_SECRET_VALUE_BYTES } from '@xecret/core/crypto';
import { MAX_SECRET_BLOB_LENGTH } from '@xecret/core/crypto/client';
import { toBytes } from '@xecret/db/repositories';
import type { SecretMaterial } from '@xecret/db/repositories';
import { decodeBlob } from './vault';
import {
  DEFAULT_SECRET_VALUE_TYPE,
  SECRET_NAME_MAX_LENGTH,
  SECRET_NAME_PATTERN,
  SECRET_VALUE_TYPES,
  secretNameSchema,
} from '@xecret/core/validation';
import { MAX_REQUEST_BODY_BYTES } from '@/server/http';
import { errors } from '@/server/errors';

/**
 * Request schemas for the secret routes.
 *
 * Kept out of the handlers so that the shape of every accepted body is readable
 * in one place, and so a reviewer checking "can a field carrying a secret value
 * end up somewhere it should not" has one file to read rather than seven.
 *
 * Two rules govern the schemas below:
 *
 *  1. **A rejected value is never echoed.** `parseWith` in `http.ts` discards
 *     Zod's `input` and forwards only the path and the message, because in this
 *     product the rejected input may itself be a credential. Nothing here adds a
 *     message that interpolates the value it rejected.
 *  2. **Every bound is a real bound.** Each `max()` exists to stop a caller
 *     making the Worker do unbounded work, not to look thorough — the byte
 *     ceilings are the ones the crypto and HTTP layers already enforce, restated
 *     here so the rejection happens before any work is done.
 */

/**
 * The value of a single secret.
 *
 * Bounded in *characters* here, and authoritatively in *bytes* by
 * `encryptSecretValue`. The two differ for non-ASCII input, and the byte check
 * is the one that matters — this is the cheap pre-filter that stops a hostile
 * body reaching the cipher at all. A string of at most `MAX_SECRET_VALUE_BYTES`
 * characters can still exceed the byte limit, which is exactly why the crypto
 * layer checks again rather than trusting this.
 */
const secretValueSchema = z
  .string()
  .check(
    z.maxLength(
      MAX_SECRET_VALUE_BYTES,
      `Secret value cannot exceed ${MAX_SECRET_VALUE_BYTES} bytes.`,
    ),
  );

/**
 * The human note shown beside a secret in the dashboard.
 *
 * `secrets.note` is documented as never holding a value, and nothing enforces
 * that but the user. It is bounded and nullable; it is not validated further,
 * because a note is free text.
 */
const noteSchema = z.nullish(
  z.string().check(z.maxLength(1024, 'Note cannot exceed 1024 characters.')),
);

/**
 * The declared shape of the value.
 *
 * An enum built from `SECRET_VALUE_TYPES`, so this schema, the `Bindings`-style
 * union in core, and the database's CHECK constraint cannot disagree about what
 * is acceptable. Defaulted rather than required: every existing client omits it,
 * and `string` accepts anything.
 */
const valueTypeSchema = z.enum(SECRET_VALUE_TYPES);

export const createSecretBody = z.object({
  name: secretNameSchema,
  value: secretValueSchema,
  note: noteSchema,
  valueType: z._default(valueTypeSchema, DEFAULT_SECRET_VALUE_TYPE),
});

/**
 * The client-encrypted half of this file.
 *
 * Everything below serves `e2ee` environments, where the server holds no key and
 * therefore checks shape and never meaning — the rule `schemas/vault.ts` and
 * `schemas/env-keys.ts` both state, applied to the one payload that is neither a
 * wrap nor a grant.
 *
 * The two rules at the top of this file still hold, and the first one holds
 * *harder*: a rejected value is never echoed, and on this path the rejected
 * value is a ciphertext whose length alone leaks the length of the plaintext.
 */

/**
 * The shortest and longest `xk2.gcm.` secret blob the API will store.
 *
 * The floor is the format's own minimum — `iv(12) ‖ tag(16)`, an empty plaintext
 * (spec §2.1) — so a truncated blob is refused rather than stored.
 *
 * The ceiling is **derived, not chosen**, and that is the whole point:
 * `MAX_SECRET_BLOB_LENGTH` is computed in `crypto/client` from
 * `MAX_SECRET_VALUE_BYTES` plus the IV, the tag and base64url's expansion, so the
 * limit a client enforces on a plaintext and the limit this endpoint enforces on
 * a ciphertext cannot drift apart. Restating a number here would be a second
 * definition of one bound, and the two would disagree the first time either
 * moved.
 */
const MIN_SECRET_BLOB_LENGTH = 'xk2.gcm.'.length + Math.ceil((28 * 4) / 3);

const MALFORMED_BLOB = 'That value is not a well-formed xk2 blob.';

const secretBlobSchema = z
  .string()
  .check(
    z.regex(/^xk2\.gcm\.[A-Za-z0-9_-]+$/, MALFORMED_BLOB),
    z.minLength(MIN_SECRET_BLOB_LENGTH, MALFORMED_BLOB),
    z.maxLength(MAX_SECRET_BLOB_LENGTH, 'That encrypted value is too large.'),
  );

/**
 * The note, encrypted. Nullable so it can be cleared, optional so it can be left
 * alone — the same three-state distinction the plaintext `note` field carries,
 * and one a client cannot otherwise express.
 */
const encNoteSchema = z.nullish(secretBlobSchema);

/**
 * `HMAC-SHA256(HKDF(EHK, "xecret.v2.value-hmac"), plaintext)`, base64url.
 *
 * Required, not optional. It is what decides whether a write appends a version,
 * and a client that omitted it would silently turn every re-submission of an
 * unchanged value into a rotation — filling the history with no-op bumps and
 * making "when did this credential last actually change?" unanswerable, which is
 * the exact question the column exists to answer.
 */
const valueHmacSchema = z.string().check(
  // Unpadded base64url of 32 bytes is exactly 43 characters, and no other byte
  // count produces that length — so the length is checked on the *encoding*
  // rather than by decoding, and a hostile body is refused before anything
  // allocates a buffer for it.
  z.regex(/^[A-Za-z0-9_-]+$/, 'A value HMAC is 32 bytes, base64url encoded.'),
  z.length(43, 'A value HMAC is 32 bytes, base64url encoded.'),
);

/**
 * A uuid naming the `env_data_keys` row a value was sealed against.
 *
 * Carried on every write and checked against the environment's *active* key. A
 * value encrypted under a key that has since been rotated away would be stored
 * looking exactly like a working row and would open for nobody — so the field is
 * not bookkeeping, it is the only way the server can catch a write that raced a
 * rotation.
 */
const dataKeyIdSchema = z.string().check(z.length(36, 'A key is named by a UUID.'));

/** One client-encrypted value, with everything needed to store and to re-find it. */
const clientValueSchema = z.object({
  ciphertext: secretBlobSchema,
  /**
   * The construction the client used, e.g. `xk2.gcm`. Recorded verbatim so an
   * operator can answer "what wrote this row" without decoding a blob. The
   * server draws no conclusion from it: the blob's own prefix is what a client
   * parses, and a disagreement between the two fails closed at decryption.
   */
  clientAlgorithm: z
    .string()
    .check(z.regex(/^xk2\.[a-z0-9]{1,16}$/, 'Unrecognised client algorithm.')),
  envDataKeyId: dataKeyIdSchema,
  valueHmac: valueHmacSchema,
});

/**
 * The id of the `secrets` row a client-encrypted create is for.
 *
 * ── Why the client chooses it ──
 * The AAD binds `secretId` (spec §4.2), so a value cannot be encrypted until the
 * identity of the row that will hold it exists. On the `server`-mode path the
 * Worker mints the id and encrypts afterwards, inside one transaction. Here it
 * cannot: encryption happens in a browser, before any request is sent. So the
 * browser mints the uuid, seals against it, and states it — and the server
 * stores the row under the id the ciphertext already names.
 *
 * A caller who supplies a colliding id is answered by the primary key, exactly
 * as a caller who supplies a colliding *name* is answered by the unique index.
 * Nothing else about the value is trusted, and nothing else can be: a mismatched
 * id produces a ciphertext that fails to authenticate on the first read, which
 * is the same failure mode as every other AAD component.
 */
const secretIdSchema = z.string().check(z.length(36, 'A secret is named by a UUID.'));

/**
 * The version this ciphertext was sealed for.
 *
 * ── Why a client-encrypted write cannot be version-free ──
 * The AAD binds `version` (spec §4.2), so the number is chosen *before* the
 * request exists — in the browser, from the listing it read a moment ago. The
 * server derives its own target from the stored row. When the two disagree, the
 * row commits at the server's number carrying a ciphertext that names the
 * client's, and it is unopenable **for ever**, by everyone, behind an HTTP 200.
 * Nobody can repair it: no operator holds the key, and the plaintext existed only
 * in a browser that has since navigated away.
 *
 * Two ordinary things produce the disagreement. A second writer commits between
 * the read and the write. Or one client holds a stale snapshot — a version-history
 * drawer left open across a restore is enough — and seals against a version that
 * has already been used.
 *
 * So the client states what it sealed for and the server refuses anything else.
 * A mismatch is a `conflict`, not a validation error: the body was well formed and
 * was correct when it was built, and the remedy is to re-read and encrypt again.
 */
const expectedVersionSchema = z
  .int()
  .check(z.gte(1, 'A version is at least 1.'), z.lte(2_147_483_647));

export const createClientSecretBody = z.object({
  id: secretIdSchema,
  name: secretNameSchema,
  value: clientValueSchema,
  encNote: encNoteSchema,
  valueType: z._default(valueTypeSchema, DEFAULT_SECRET_VALUE_TYPE),
});

/**
 * A new client-encrypted version.
 *
 * `encNote` *is* accepted here, unlike the plaintext `note` on the server-mode
 * update body — and the asymmetry is deliberate rather than an oversight. A
 * plaintext note is edited through `PUT …/secrets/{name}`, which needs no key; an
 * encrypted one is a blob only an unlocked client holding the EDK can produce, so
 * the moment it *can* be sent is the moment a value is being sent too. Splitting
 * them would mean a client that changed a note had to encrypt and submit the
 * value again to carry it.
 */
export const updateClientSecretBody = z.object({
  value: clientValueSchema,
  /** The version this ciphertext is bound to. See `expectedVersionSchema`. */
  expectedVersion: expectedVersionSchema,
  encNote: encNoteSchema,
  valueType: z.optional(valueTypeSchema),
});

/**
 * Restoring an earlier version, client-side.
 *
 * ── Why this body carries a ciphertext at all ──
 * A restore is a **re-encryption**, never a copy: the AAD binds `version` (spec
 * §4.2), so bytes produced for version 3 and stored as version 7 would fail to
 * decrypt for the rest of their life, silently. On a `server`-mode environment
 * the Worker performs that re-encryption because it holds the key. Here it does
 * not, so the client does: it reads version 3, decrypts it, encrypts the same
 * plaintext for the version about to be written, and sends it.
 *
 * `version` is still required, and is not merely decorative — it is what the
 * server checks exists, what the audit record names, and what makes the response
 * able to say `restoredFrom`. The server cannot verify that the ciphertext really
 * holds that version's value, and does not pretend to: this is a restore
 * performed by the client and recorded by the server.
 */
export const restoreClientSecretBody = z.object({
  version: z.int().check(z.gte(1), z.lte(2_147_483_647)),
  /**
   * The version being **written**, which is not `version` above.
   *
   * `version` is the one being restored from; this is the one the re-encrypted
   * bytes are bound to. Conflating them is the mistake the two names exist to
   * prevent — a stale history drawer restoring twice sends the same
   * `expectedVersion` for two different writes, and the second one is refused
   * rather than stored as a version its AAD does not name.
   */
  expectedVersion: expectedVersionSchema,
  value: clientValueSchema,
  encNote: encNoteSchema,
});

/**
 * A bulk import of pre-encrypted entries.
 *
 * The parsing moved to the client, and this is what is left of the endpoint. On
 * a `server`-mode environment the API receives a `.env` file and parses it with
 * `@xecret/core/importer`; here it receives the *outcome* — a list of names and
 * ciphertexts — because parsing a file means reading its values, and the values
 * are the thing the server must not see. The same module runs in the browser, so
 * the detection, the planning and the naming rules are unchanged; only where they
 * run has moved.
 *
 * `dryRun` is still required rather than defaulted, for the reason the plaintext
 * body gives: a client that forgets the field must not silently perform the write
 * it meant to preview.
 */
export const importClientBody = z.object({
  entries: z
    .array(
      z.object({
        /**
         * The id this entry takes **if it turns out to be a create**.
         *
         * Supplied for every entry rather than only the new ones, because the
         * client cannot know which is which: whether a name already exists is
         * the planner's answer, and the planner re-runs on the server against
         * the complete listing.
         *
         * **The server does not silently substitute.** An entry that turns out
         * to append must carry the stored id, because its ciphertext was sealed
         * against that one; if it carries a different id — the client planned a
         * create — the write is refused, not committed under the stored id. The
         * two are not interchangeable: `secretId` is in the AAD, and a row
         * written under an id its ciphertext does not name opens for nobody.
         */
        id: secretIdSchema,
        name: secretNameSchema,
        /**
         * The version this entry sealed for: 1 where the client planned a
         * create, the stored version plus one where it planned an overwrite.
         *
         * Both halves of that sentence are checked, because both can be wrong
         * independently. A client that planned a create for a name that already
         * exists sends this entry's own `id` and version 1, and the server
         * resolves a different id and a higher version — which is exactly the
         * >200-name listing bug this field closes, and exactly the case the old
         * code committed under the stored id with a shrug.
         */
        expectedVersion: expectedVersionSchema,
        value: clientValueSchema,
        encNote: encNoteSchema,
      }),
    )
    .check(z.maxLength(1000, 'An import cannot write more than 1000 secrets at once.')),
  dryRun: z.boolean(),
});

/**
 * A new version carries a value, and optionally a redeclaration of its shape.
 *
 * `note` is deliberately absent. It lives on `secrets`, not on
 * `secret_versions`, and editing a note is a separate change to a separate row —
 * accepting the field here would mean silently discarding it, which is worse
 * than not offering it.
 *
 * `valueType` *is* accepted, even though it also lives on `secrets`, because the
 * two changes belong together: "this is a port number, and here it is" is one
 * thought, and forcing it into two requests would make the intermediate state —
 * a value that does not match its declared type — reachable through the
 * product's own happy path.
 */
export const updateSecretBody = z.object({
  value: secretValueSchema,
  valueType: z.optional(valueTypeSchema),
});

/**
 * Changing what is *said about* a secret, without changing what it holds.
 *
 * Its own body, and its own route method, because it appends no version and
 * needs no key. At least one field must be present: an empty patch is a request
 * that means nothing, and answering 200 to it would tell a client its change was
 * applied.
 */
export const patchSecretMetadataBody = z
  .object({
    /**
     * A new name for the secret — metadata, not a rotation: the versions follow
     * the secret's id, so the history survives. The dashboard warns that
     * everything reading the old name stops finding it; the API's part is to
     * validate the new name exactly like a created one and record the old name
     * in the audit event.
     */
    name: z.optional(secretNameSchema),
    note: noteSchema,
    /**
     * The encrypted note, for an `e2ee` environment.
     *
     * Accepted on the same body as `note` rather than on a separate endpoint,
     * because they are the same field seen from the two sides of the migration
     * and a client editing a label should not have to know which route to use.
     * Which of the two is *permitted* is decided by the handler against the
     * environment's stored mode — sending the wrong one is refused rather than
     * ignored, because ignoring it would report a change that did not happen.
     */
    encNote: z.nullish(
      z
        .string()
        .check(
          z.regex(/^xk2\.gcm\.[A-Za-z0-9_-]+$/, 'That value is not a well-formed xk2 blob.'),
          z.maxLength(MAX_SECRET_BLOB_LENGTH, 'That encrypted note is too large.'),
        ),
    ),
    valueType: z.optional(valueTypeSchema),
  })
  .check(
    z.refine(
      (body) =>
        body.name !== undefined ||
        body.note !== undefined ||
        body.encNote !== undefined ||
        body.valueType !== undefined,
      'Supply a name, note or value type to change.',
    ),
  );

export const restoreSecretBody = z.object({
  /**
   * Version numbers start at 1 and are assigned by the database. The upper
   * bound is `int4`'s, since that is the column's type — a larger number cannot
   * name a row and is refused before it becomes a query parameter.
   */
  version: z.int().check(z.gte(1), z.lte(2_147_483_647)),
});

/**
 * Offset pagination, dressed as a cursor.
 *
 * §5 of `docs/architecture/api.md` specifies a `{ data, nextCursor }` envelope.
 * The repository behind these listings is offset-paginated by deliberate design
 * — see the note in `repositories/projects.ts`: a secret listing is bounded by
 * what a human scrolls and is not append-heavy, so the drift that makes offsets
 * wrong on the audit table does not arise here.
 *
 * The page number is therefore returned as an opaque `nextCursor` string rather
 * than as a `page` field. That is not decoration: a client that cannot do
 * arithmetic on the cursor is a client that keeps working when this becomes a
 * true keyset cursor, which is a change the audit log has already had to make.
 */
export const listQuery = z.object({
  limit: z.optional(z.pipe(z.coerce.number(), z.int().check(z.gte(1), z.lte(200)))),
  cursor: z.optional(z.pipe(z.coerce.number(), z.int().check(z.gte(1)))),
});

export const exportFormatSchema = z.enum(['env', 'json', 'yaml', 'shell', 'docker']);

/**
 * `env` is the default because it is the format every other one is a
 * translation of, and the only one every consumer in the ecosystem reads.
 */
export const documentQuery = z.object({
  format: z._default(exportFormatSchema, 'env'),
});

export const importBody = z.object({
  /**
   * The uploaded file, verbatim. Bounded by the same ceiling `readJsonBody`
   * applies to the whole body: a `content` field cannot exceed the document
   * that carries it, and restating the limit here makes the failure a field
   * error the import modal can render rather than a bare 413.
   */
  content: z.string().check(z.maxLength(MAX_REQUEST_BODY_BYTES, 'The uploaded file is too large.')),
  /**
   * Absent means "detect it". Detection is `detectFormat`, which weighs the
   * file name above the content — someone who named a file `config.yaml` knows
   * what is in it — so the name is accepted alongside the content. It is not in
   * §4's body list because §4 describes the minimum; omitting it merely makes
   * detection worse.
   */
  format: z.optional(z.enum(['dotenv', 'json', 'yaml', 'shell'])),
  filename: z.optional(z.string().check(z.maxLength(512))),
  strategy: z.enum(['skip', 'overwrite', 'rename']),
  /**
   * Required rather than defaulted. A client that forgets this field must not
   * silently perform the write it meant to preview.
   */
  dryRun: z.boolean(),
});

export type CreateSecretBody = z.infer<typeof createSecretBody>;
export type CreateClientSecretBody = z.infer<typeof createClientSecretBody>;
export type UpdateClientSecretBody = z.infer<typeof updateClientSecretBody>;
export type RestoreClientSecretBody = z.infer<typeof restoreClientSecretBody>;
export type ImportClientBody = z.infer<typeof importClientBody>;

/**
 * One stored ciphertext, on its way back to the client that can open it.
 *
 * `envDataKeyId` is included and matters: a version written before a rotation
 * names the retired key, and a client holding only the active grant has to know
 * that rather than discovering it as an unexplained decryption failure. It is
 * also what a Phase 3b client uses to decide whether it needs an older grant at
 * all.
 */
export interface ClientSecretPayload {
  /**
   * The `secrets` row id, which is an AAD component (spec §4.2).
   *
   * Without it the ciphertext beside it cannot be opened — not "is harder to
   * open": the AAD would be built from the wrong tuple and GCM would reject it.
   * It is an opaque identifier and confers nothing, exactly like `envDataKeyId`
   * below.
   */
  id: string;
  name: string;
  ciphertext: string;
  clientAlgorithm: string;
  envDataKeyId: string;
  version: number;
  updatedAt: string;
  updatedBy: string | null;
  updatedByServiceTokenId: string | null;
}

/**
 * A stored client-encrypted value as the API returns it.
 *
 * Throws rather than returning `null` when handed a server-mode row: reaching
 * this serialiser with one means a route branched on the wrong mode, and
 * producing a plausible-looking payload with an empty ciphertext would push the
 * failure into a client that cannot diagnose it.
 */
export function toClientSecret(material: SecretMaterial): ClientSecretPayload {
  if (material.clientValue === null || material.envDataKeyId === null) {
    throw errors.internal('serverEncryptedOnClientPath');
  }

  return {
    id: material.secretId,
    name: material.name,
    ciphertext: decodeBlob(toBytes(material.clientValue.ciphertext)),
    clientAlgorithm: material.clientValue.clientAlgorithm,
    envDataKeyId: material.envDataKeyId,
    version: material.version,
    updatedAt: material.createdAt.toISOString(),
    updatedBy: material.createdBy,
    updatedByServiceTokenId: material.createdByServiceTokenId,
  };
}

/** An encrypted note column back to the blob string it holds; `null` stays `null`. */
export function toEncNote(bytes: Uint8Array | null): string | null {
  return bytes === null ? null : decodeBlob(toBytes(bytes));
}
export type UpdateSecretBody = z.infer<typeof updateSecretBody>;
export type PatchSecretMetadataBody = z.infer<typeof patchSecretMetadataBody>;
export type RestoreSecretBody = z.infer<typeof restoreSecretBody>;
export type ImportBody = z.infer<typeof importBody>;
export type ListQuery = z.infer<typeof listQuery>;
export type DocumentQuery = z.infer<typeof documentQuery>;

/**
 * Turns the `[name]` path segment into a secret name.
 *
 * Two things happen here, and both must happen before the value reaches a query.
 *
 * **Decoding.** A path segment arrives percent-encoded. Decoding is safe to do
 * unconditionally because a valid secret name matches
 * `^[A-Za-z_][A-Za-z0-9_]*$` and therefore contains no `%` — so decoding an
 * already-decoded name is a no-op, and there is no double-decode to exploit. A
 * malformed escape sequence throws `URIError`, which is caught rather than
 * allowed to become a 500.
 *
 * **Validation.** The pattern is checked against the same regular expression the
 * `secrets_name_check` constraint enforces, so a name the database could not
 * hold never becomes a bound parameter.
 *
 * The failure is `not_found`, not `validation_failed`: this segment addresses a
 * resource, and a name outside the pattern names one that cannot exist. Saying
 * "invalid" instead would distinguish "malformed" from "absent" for a caller who
 * is entitled to neither answer.
 */
export function secretNameFromPath(raw: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw errors.notFound('malformed percent-encoding in secret name');
  }

  if (decoded.length > SECRET_NAME_MAX_LENGTH || !SECRET_NAME_PATTERN.test(decoded)) {
    throw errors.notFound('secret name outside the permitted pattern');
  }

  return decoded;
}

import { z } from 'zod';
import { MAX_SECRET_VALUE_BYTES } from '@xecret/core/crypto';
import {
  SECRET_NAME_MAX_LENGTH,
  SECRET_NAME_PATTERN,
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
  .max(MAX_SECRET_VALUE_BYTES, `Secret value cannot exceed ${MAX_SECRET_VALUE_BYTES} bytes.`);

/**
 * The human note shown beside a secret in the dashboard.
 *
 * `secrets.note` is documented as never holding a value, and nothing enforces
 * that but the user. It is bounded and nullable; it is not validated further,
 * because a note is free text.
 */
const noteSchema = z.string().max(1024, 'Note cannot exceed 1024 characters.').nullish();

export const createSecretBody = z.object({
  name: secretNameSchema,
  value: secretValueSchema,
  note: noteSchema,
});

/**
 * A new version carries a value and nothing else.
 *
 * `note` is deliberately absent. It lives on `secrets`, not on
 * `secret_versions`, and the repository exposes no update for it — so accepting
 * the field here would mean silently discarding it, which is worse than not
 * offering it. Editing a note is a separate change to a separate row.
 */
export const updateSecretBody = z.object({
  value: secretValueSchema,
});

export const restoreSecretBody = z.object({
  /**
   * Version numbers start at 1 and are assigned by the database. The upper
   * bound is `int4`'s, since that is the column's type — a larger number cannot
   * name a row and is refused before it becomes a query parameter.
   */
  version: z.number().int().min(1).max(2_147_483_647),
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
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.coerce.number().int().min(1).optional(),
});

export const exportFormatSchema = z.enum(['env', 'json', 'yaml', 'shell', 'docker']);

/**
 * `env` is the default because it is the format every other one is a
 * translation of, and the only one every consumer in the ecosystem reads.
 */
export const documentQuery = z.object({
  format: exportFormatSchema.default('env'),
});

export const importBody = z.object({
  /**
   * The uploaded file, verbatim. Bounded by the same ceiling `readJsonBody`
   * applies to the whole body: a `content` field cannot exceed the document
   * that carries it, and restating the limit here makes the failure a field
   * error the import modal can render rather than a bare 413.
   */
  content: z.string().max(MAX_REQUEST_BODY_BYTES, 'The uploaded file is too large.'),
  /**
   * Absent means "detect it". Detection is `detectFormat`, which weighs the
   * file name above the content — someone who named a file `config.yaml` knows
   * what is in it — so the name is accepted alongside the content. It is not in
   * §4's body list because §4 describes the minimum; omitting it merely makes
   * detection worse.
   */
  format: z.enum(['dotenv', 'json', 'yaml', 'shell']).optional(),
  filename: z.string().max(512).optional(),
  strategy: z.enum(['skip', 'overwrite', 'rename']),
  /**
   * Required rather than defaulted. A client that forgets this field must not
   * silently perform the write it meant to preview.
   */
  dryRun: z.boolean(),
});

export type CreateSecretBody = z.infer<typeof createSecretBody>;
export type UpdateSecretBody = z.infer<typeof updateSecretBody>;
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

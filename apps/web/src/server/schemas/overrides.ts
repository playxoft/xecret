import * as z from 'zod/mini';
import { MAX_OVERRIDE_BLOB_LENGTH } from '@xecret/core/crypto/client';
import { toBytes } from '@xecret/db/repositories';
import type { OverrideRecord } from '@xecret/db/repositories';
import { decodeBlob } from './vault';

/**
 * The request and response shapes of the personal-override routes (P19 §2).
 *
 * An override's value is an `xk2.gcm.` blob under its owner's override key — a
 * key derived from their own X25519 private key (spec §2.2, type 13) — and, the
 * rule `schemas/env-keys.ts` states for every blob, the server checks its prefix,
 * its alphabet and its length and never its meaning. It holds no key that could
 * open it, and none that could make one: an override is the one value in the
 * product that neither a teammate holding the environment's key nor this server
 * can read, or forge.
 */

const UNEXPECTED_FIELD = 'The request contains a field this endpoint does not accept.';
const MALFORMED = 'That value is not a well-formed xk2.gcm blob.';

/** `iv(12) ‖ tag(16)` — the blob of an empty value. */
const MIN_OVERRIDE_BLOB_LENGTH = 'xk2.gcm.'.length + Math.ceil((28 * 4) / 3);

export const overrideBodySchema = z.strictObject(
  {
    ciphertext: z
      .string()
      .check(
        z.regex(/^xk2\.gcm\.[A-Za-z0-9_-]+$/, MALFORMED),
        z.minLength(MIN_OVERRIDE_BLOB_LENGTH, MALFORMED),
        z.maxLength(MAX_OVERRIDE_BLOB_LENGTH, 'That value is too large for a secret.'),
      ),
  },
  UNEXPECTED_FIELD,
);

export interface OverridePayload {
  name: string;
  ciphertext: string;
  updatedAt: string;
}

export function toOverride(record: OverrideRecord): OverridePayload {
  return {
    name: record.name,
    ciphertext: decodeBlob(toBytes(record.ciphertext)),
    updatedAt: record.updatedAt.toISOString(),
  };
}

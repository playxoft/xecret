import * as z from 'zod/mini';
import { toBytes } from '@xecret/db/repositories';
import type {
  EnvDataKeyRecord,
  EnvKeyGrantRecord,
  PendingKeyGrantRecord,
} from '@xecret/db/repositories';
import { decodeBlob, encodeBlob } from './vault';

/**
 * The request schemas and response shapes of the environment-key routes.
 *
 * ── The rule that governs this file ──
 * **The server validates shape, never meaning** — the same rule `schemas/vault.ts`
 * states for the user half of the hierarchy, and for the same reason. Every
 * cryptographic value below is checked for its prefix, its alphabet and its
 * length, and then stored or returned verbatim. Nothing here decodes a sealed
 * box, verifies a signature, or derives a key, because the server holds no key
 * with which it could — and a validator that "helpfully" opened a grant would be
 * the first line of the code path ADR 0009 exists to make impossible.
 *
 * A length and a prefix are exactly the checks a party with no key *can* make,
 * and they are enough for what they are for: keeping a malformed or oversized
 * body out of the database, so a column cannot come to hold something no client
 * will ever parse. The real validation happens twice, in the two places that can
 * do it — the client's `parseBlob` rejects an unknown version loudly, and
 * AES-GCM rejects a wrong key or a wrong AAD. Between them, a value that passes
 * these schemas and is still wrong fails closed at the only point where failing
 * means anything.
 *
 * ── What the server *does* decide ──
 * One thing, and it is not cryptographic: **who must appear in a grant set.**
 * `POST …/keys/rotate` is checked for completeness against the authorization
 * model, because that is a question about `can()` and membership rather than
 * about bytes, and it is the one part of a rotation a client cannot be trusted
 * to get right — a client that quietly omitted a principal would produce a
 * rotation that reads as a success and is a silent revocation. That check lives
 * in `env-keys-service.ts`; this file only describes the shapes it operates on.
 */

const UNEXPECTED_FIELD = 'The request contains a field this endpoint does not accept.';

/** Base64url, unpadded — see the note on the same constant in `schemas/vault.ts`. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function base64UrlBytes(bytes: number, message: string) {
  const length = Math.ceil((bytes * 4) / 3);
  return z.string().check(z.regex(BASE64URL, message), z.length(length, message));
}

const MALFORMED_SEALED = 'That value is not a well-formed xk2.x25519 blob.';
const MALFORMED_SIGNATURE = 'That value is not a well-formed xk2.ed25519 blob.';

/**
 * The shortest and longest sealed box this endpoint will accept.
 *
 * The floor is the format's own minimum — `ephemeralPub(32) ‖ iv(12) ‖ tag(16)`,
 * an empty plaintext (spec §2.1) — so a truncated blob is refused rather than
 * stored. The ceiling is generous rather than exact: every grant this version
 * writes seals a 32-byte key, which is 92 payload bytes, and pinning the bound to
 * that would make a future construction with a slightly larger payload a server
 * change as well as a client one. 512 is far above anything the format defines
 * and far below a size at which this column becomes a place to hide a payload.
 */
const MIN_SEALED_LENGTH = 'xk2.x25519.'.length + Math.ceil((60 * 4) / 3);
const MAX_SEALED_LENGTH = 512;

/** An `xk2.x25519.` blob: a prefix, and base64url after it. Never decoded here. */
const sealedBlobSchema = z
  .string()
  .check(
    z.regex(/^xk2\.x25519\.[A-Za-z0-9_-]+$/, MALFORMED_SEALED),
    z.minLength(MIN_SEALED_LENGTH, MALFORMED_SEALED),
    z.maxLength(MAX_SEALED_LENGTH, MALFORMED_SEALED),
  );

/**
 * An `xk2.ed25519.` blob: exactly one 64-byte Ed25519 signature.
 *
 * Fixed-length rather than bounded, because unlike a sealed box this one has no
 * payload that could legitimately vary: a detached Ed25519 signature is 64 bytes
 * and there is no conforming value of any other size. Anything else is either a
 * different construction wearing this tag or a truncation, and both are refused
 * at the boundary rather than becoming a verification failure years from now
 * when verification is finally switched on.
 */
const SIGNATURE_LENGTH = 'xk2.ed25519.'.length + Math.ceil((64 * 4) / 3);

const signatureSchema = z
  .string()
  .check(
    z.regex(/^xk2\.ed25519\.[A-Za-z0-9_-]+$/, MALFORMED_SIGNATURE),
    z.length(SIGNATURE_LENGTH, MALFORMED_SIGNATURE),
  );

/** A 32-byte X25519 public key. */
export const publicKeySchema = base64UrlBytes(32, 'A public key is 32 bytes, base64url encoded.');

/** The three principals a grant can address (spec §4.1). */
export const recipientKindSchema = z.enum(['member', 'token', 'invite']);

/**
 * One sealed grant, exactly as the client produced it.
 *
 * `recipientKind` and `recipientId` are carried in the body rather than inferred
 * from the path, because both are **signed** (spec §6.1): the signature covers
 * the kind and the id alongside the two blobs, precisely so a server cannot
 * relabel a service-token grant as a member grant or move a valid grant between
 * two principals. Accepting them as fields, and storing them into the columns
 * the signature names, is what makes that guarantee reachable when verification
 * is later enabled — a server that derived them itself would be free to derive
 * them differently.
 */
export const grantSchema = z.strictObject(
  {
    recipientKind: recipientKindSchema,
    recipientId: z.string().check(z.length(36, 'A recipient is named by a UUID.')),
    /** `xk2.x25519.` blob (type 6): the EDK sealed to the recipient. */
    edkSealed: sealedBlobSchema,
    /** `xk2.x25519.` blob (type 7): the EHK, same construction, different AAD. */
    ehkSealed: sealedBlobSchema,
    /** `xk2.ed25519.` blob (type 8): the creator's signature over both. */
    signature: signatureSchema,
  },
  UNEXPECTED_FIELD,
);

export type GrantRequest = z.infer<typeof grantSchema>;

/**
 * How many grants one request may carry.
 *
 * A rotation seals to every principal in the environment, so the ceiling has to
 * clear a large team plus its CI tokens — and it is not a policy limit, it is the
 * bound on how much work one request can order. Without it a caller could post
 * ten thousand grants and have the Worker insert them in one transaction. Well
 * above any real environment, and reported as `payload_too_large` because it is
 * the size of the request that is the problem.
 */
export const MAX_GRANTS_PER_REQUEST = 500;

const grantsSchema = z
  .array(grantSchema)
  .check(
    z.minLength(1, 'Supply at least one grant.'),
    z.maxLength(
      MAX_GRANTS_PER_REQUEST,
      `A request cannot carry more than ${MAX_GRANTS_PER_REQUEST} grants.`,
    ),
  );

/**
 * Initialising an environment's keys: version 1, and the creator's own grant.
 *
 * One grant and not a set, deliberately. At creation the only principal that can
 * possibly hold this key is the person whose browser just generated it — nobody
 * else's public key was involved in the sealing — so accepting a set here would
 * accept grants the creator could only have produced by having somebody else's
 * key material, which is not a state this flow reaches. Everybody else is added
 * afterwards through `POST …/keys/grants`, which is the endpoint that exists for
 * exactly that.
 */
export const environmentKeyInitSchema = z.strictObject({ grant: grantSchema }, UNEXPECTED_FIELD);

export type EnvironmentKeyInitRequest = z.infer<typeof environmentKeyInitSchema>;

/**
 * Rotating: the new version number, and the **complete** replacement grant set.
 *
 * `newVersion` is supplied rather than computed server-side because every grant
 * in the set has already been sealed with that number bound into its AAD (spec
 * §4.2). If the server assigned it, a rotation racing another would produce
 * grants whose AAD names version 4 stored against a row numbered 5 — every one
 * of which would fail to open, for ever, with no error at write time. The client
 * states what it sealed for; the server checks it and refuses a mismatch.
 */
export const environmentKeyRotateSchema = z.strictObject(
  {
    newVersion: z.int().check(z.gte(2), z.lte(2_147_483_647)),
    grants: grantsSchema,
  },
  UNEXPECTED_FIELD,
);

export type EnvironmentKeyRotateRequest = z.infer<typeof environmentKeyRotateSchema>;

/**
 * Adding grants for principals that did not have one.
 *
 * `envDataKeyId` is required rather than resolved server-side, for the mirror of
 * the reason `newVersion` is: the client sealed against a specific key, and a
 * grant sealed against a version that has since been rotated away is a blob
 * nobody can open which would sit in the table looking exactly like a working
 * grant. Naming the key makes that a conflict the client retries.
 */
export const environmentKeyGrantsSchema = z.strictObject(
  {
    envDataKeyId: z.string().check(z.length(36, 'A key is named by a UUID.')),
    grants: grantsSchema,
  },
  UNEXPECTED_FIELD,
);

export type EnvironmentKeyGrantsRequest = z.infer<typeof environmentKeyGrantsSchema>;

/** The active key, as a client identifies it when sealing. */
export interface ActiveKeyPayload {
  id: string;
  version: number;
}

/** One grant, ready for the holder's client to open. */
export interface GrantPayload {
  id: string;
  recipientKind: 'member' | 'token' | 'invite';
  recipientId: string;
  edkSealed: string;
  ehkSealed: string;
  signature: string;
  /** Whose signing key to verify against, once verification is enabled. */
  signedByUserId: string;
}

/** One queued key share, for the admin banner. Ids and a timestamp only. */
export interface PendingGrantPayload {
  id: string;
  targetUserId: string;
  requestedBy: string;
  createdAt: string;
}

/**
 * Everything `GET …/keys` answers.
 *
 * ── Why `myGrant` and `pendingGrants` are not the same kind of field ──
 * `myGrant` is what the caller needs to *work*: without it the environment is a
 * list of names they cannot read. It is served to anybody with read access,
 * because it is sealed to them and useless to anyone else — the server is
 * handing back ciphertext addressed to the person asking.
 *
 * `pendingGrants` is administrative: it names other people. It is served only to
 * callers who can act on it, because a developer learning that "three teammates
 * are waiting for production keys" learns the shape of the team's access without
 * holding `member.read` over it.
 */
export interface EnvironmentKeysPayload {
  encryptionMode: 'server' | 'e2ee';
  activeEdk: ActiveKeyPayload | null;
  myGrant: Omit<GrantPayload, 'id' | 'recipientKind' | 'recipientId'> | null;
  ehkExists: boolean;
  /** Admins only; `null` for a caller who may not see who is waiting. */
  pendingGrants: PendingGrantPayload[] | null;
  /**
   * Whether a principal lost access since the active key was created.
   *
   * The honest name for "somebody's grant was deleted and the key they held has
   * not been replaced". Deleting a grant stops a principal being handed the key
   * *again*; only a rotation stops the key they already have from opening what is
   * written next. Until one lands with a version bump, the revocation is on
   * paper, and this field is how the dashboard says so rather than letting an
   * administrator believe an act completed that did not.
   */
  needsRotation: boolean;
  /**
   * The highest secret version currently stored in this environment.
   *
   * Freshness groundwork, and nothing more. ADR 0009 records rollback as an
   * accepted residual risk: a server can serve stale grants or silently omit
   * recent `secret_versions`, and signatures do not help, because they prove
   * origin rather than recency. Returning this on every key read means a
   * client-side monotonic counter can be added later without an API change.
   *
   * **Nothing on the server enforces it.** A compromised server would simply
   * report a lower number. The field is a place to put the future mitigation,
   * not the mitigation.
   */
  currentMaxSecretVersion: number;
}

export function toActiveKey(key: EnvDataKeyRecord): ActiveKeyPayload {
  return { id: key.id, version: key.version };
}

export function toGrant(grant: EnvKeyGrantRecord): GrantPayload {
  return {
    id: grant.id,
    recipientKind: grant.recipientKind,
    recipientId: grant.recipientId,
    edkSealed: decodeBlob(toBytes(grant.edkSealed)),
    ehkSealed: decodeBlob(toBytes(grant.ehkSealed)),
    signature: decodeBlob(toBytes(grant.signature)),
    signedByUserId: grant.signedByUserId,
  };
}

export function toPendingGrant(pending: PendingKeyGrantRecord): PendingGrantPayload {
  return {
    id: pending.id,
    targetUserId: pending.targetUserId,
    requestedBy: pending.requestedBy,
    createdAt: pending.createdAt.toISOString(),
  };
}

/** A request's grant, as the repository stores one. Blobs in, blobs out. */
export function toGrantSeed(grant: GrantRequest) {
  return {
    recipientKind: grant.recipientKind,
    recipientId: grant.recipientId,
    edkSealed: encodeBlob(grant.edkSealed),
    ehkSealed: encodeBlob(grant.ehkSealed),
    signature: encodeBlob(grant.signature),
  };
}

/**
 * A 32-byte public key, between the wire and a `bytea` column.
 *
 * Re-exported from `@xecret/core/crypto/client` rather than reimplemented, even
 * though decoding base64url is three lines: the core version asserts the length
 * as well, so a value that passed `publicKeySchema` and was then truncated
 * somewhere between fails here rather than being stored as a key nothing can
 * seal to. Two implementations of one codec is how the client and the server
 * come to disagree about what a public key is.
 *
 * Raw bytes rather than an `xk2.` blob, because a public key is not a
 * ciphertext: there is no version prefix and no AAD to carry, and the algorithm
 * lives in its own column.
 */
export { decodePublicKey, encodePublicKey } from '@xecret/core/crypto/client';

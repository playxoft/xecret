import * as z from 'zod/mini';
import { toBytes } from '@xecret/db/repositories';
import type {
  EnvDataKeyRecord,
  EnvKeyGrantRecord,
  InvitationGrantRecord,
  PendingKeyGrantRecord,
} from '@xecret/db/repositories';
import { decodePublicKey, encodePublicKey } from '@xecret/core/crypto/client';
import { uuidField } from './ids';
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
    recipientId: uuidField('A recipient is named by a UUID.'),
    /**
     * The public key the client sealed to, base64url. Signed, and therefore
     * stored (spec §6.1).
     *
     * The server does not check it against the principal's current key, and must
     * not: an invitation's key is deleted at acceptance and a member's is
     * replaced by a vault reset, so "matches the row we hold today" is neither
     * necessary nor sufficient for a grant written yesterday. What it is for is
     * making the row verifiable **from itself** — a deferred verifier recomputes
     * the signing payload from these columns rather than joining to a table this
     * server writes, which is the only reading under which the signature's
     * binding of this field means anything at all.
     */
    recipientPublicKey: publicKeySchema,
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
    envDataKeyId: uuidField('A key is named by a UUID.'),
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
  /** The key this grant was sealed to, base64url. Part of the signed payload. */
  recipientPublicKey: string;
  edkSealed: string;
  ehkSealed: string;
  signature: string;
  /** Whose signing key to verify against, once verification is enabled. */
  signedByUserId: string;
}

/**
 * One principal a client may seal this environment's key to.
 *
 * ── Why this exists, and why it is not a leak ──
 * Sealing is asymmetric. Producing a grant for somebody requires **their**
 * public key, and a browser has no other way to learn one — so without this
 * endpoint, rotation, the pending-share queue and an admin widening access are
 * not merely awkward, they are impossible to attempt. Phase 3a defined every
 * write that consumes a grant set and no read that could produce one.
 *
 * `publicKey` is public by construction: `user_keys.enc_public_key` and
 * `service_tokens.public_key` are both stored in the clear, and holding one lets
 * the holder *give* a key away, never take one.
 *
 * `holdsGrant` is what turns a list into an instruction. A rotation must seal to
 * everybody here; a share must seal only to those with `false`.
 */
export interface RecipientPayload {
  kind: 'member' | 'token';
  /** The user id or the service-token id — the `recipientId` a grant names. */
  id: string;
  /** 32 bytes, base64url. Absent principals are reported in `unsealable`. */
  publicKey: string;
  /** Whether they already hold a grant on the **active** key. */
  holdsGrant: boolean;
}

/**
 * Somebody the model says should hold this key and who cannot be sealed to.
 *
 * A member who has not completed the vault ceremony has no public key, so there
 * is nothing to seal to and no client can invent one. Naming them is the
 * difference between a rotation that refuses with a reason a person can act on
 * — "ask Dana to finish setting up her vault" — and one that is rejected by the
 * completeness check with an opaque user id.
 */
export interface UnsealablePayload {
  kind: 'member';
  id: string;
}

/** Everything `GET …/keys/recipients` answers. */
export interface RecipientsPayload {
  /** The active key these grants must be sealed against, or `null`. */
  activeEdk: ActiveKeyPayload | null;
  environmentId: string;
  recipients: RecipientPayload[];
  unsealable: UnsealablePayload[];
}

/**
 * A principal entitled to this environment who holds no key for it.
 *
 * Named by kind and id and nothing else, because that is all it is: an
 * observation about two sets of rows. What to do about it — seal them a grant
 * through `POST …/keys/grants` — is the same act `RecipientPayload.holdsGrant`
 * already describes, so this field points at the work rather than duplicating the
 * material for it.
 */
export interface MissingGrantPayload {
  kind: 'member' | 'token';
  id: string;
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
  /**
   * The environment's own id.
   *
   * Published here and nowhere else in the environment payloads, and it is not a
   * convenience: **every** AAD a client builds names it (spec §4.2) — the two
   * grant purposes, the secret value, the note. A client that could not learn it
   * could not open the grant it was just handed, could not encrypt a value, and
   * could not tell a decryption failure from a missing identifier.
   *
   * `EnvironmentPayload` keeps addressing environments by slug, which is right
   * for a URL; this is the cryptographic identity of the row, served on the one
   * endpoint that exists to hand a client its key material.
   */
  environmentId: string;
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
   *
   * **`null` means "not computed for you"**, not "no". Deciding it costs a read
   * of the whole active roster and its access grants, and the caller who pays for
   * it on the hottest path in the product — `POST …/pull`, on every `xecret run`
   * and every CI job — is exactly the caller who can do nothing about the answer.
   * So it is computed only for a caller who may act on it, and the type says so:
   * `false` would be a reassurance nobody checked.
   */
  needsRotation: boolean | null;
  /**
   * Principals who may read this environment and hold no key for it.
   *
   * The other direction of the same comparison, and until now nothing reported
   * it. A member entitled to an environment with no grant on its active key can
   * list every secret name and decrypt none of them — the state a vault reset
   * produces for every environment at once, and the state an acceptance leaves
   * behind when the re-seal never lands.
   *
   * Distinct from `pendingGrants` on purpose. That is a queue of *requests*: rows
   * somebody wrote when they changed an access level. This is derived from the
   * grants themselves, so it is still correct when the request was never recorded
   * or was deleted by a path that should not have deleted it. One is intent, the
   * other is state, and the reason this field exists is that they had drifted.
   *
   * Admins only, and `null` for everybody else, on the same terms as
   * `needsRotation` and `pendingGrants`: it names other people.
   */
  missingGrants: MissingGrantPayload[] | null;
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
    recipientPublicKey: encodePublicKey(toBytes(grant.recipientPublicKey)),
    edkSealed: decodeBlob(toBytes(grant.edkSealed)),
    ehkSealed: decodeBlob(toBytes(grant.ehkSealed)),
    signature: decodeBlob(toBytes(grant.signature)),
    signedByUserId: grant.signedByUserId,
  };
}

/**
 * One invitation-sealed grant, handed to the invitee at acceptance.
 *
 * ── Why acceptance is the only place this is served ──
 * The grant is sealed to the invitation's one-off keypair, whose private half
 * exists only inside the fragment that travelled by a second channel. There is
 * no principal the server can authenticate as "the holder of that fragment", so
 * there is no endpoint that could safely serve these on demand. Acceptance is
 * the single moment where the token, the session and the invited address have
 * all been checked at once — so the grants ride out on that response, and the
 * rows are deleted as they go.
 *
 * The two slugs travel with it because the invitee has no other view of this
 * organisation yet: they joined a moment ago, and the route they re-upload to
 * is addressed by slug.
 */
export interface InviteKeyGrantPayload {
  environmentId: string;
  projectSlug: string;
  environmentSlug: string;
  envDataKeyId: string;
  edkVersion: number;
  edkSealed: string;
  ehkSealed: string;
}

export function toInviteKeyGrant(grant: InvitationGrantRecord): InviteKeyGrantPayload {
  return {
    environmentId: grant.environmentId,
    projectSlug: grant.projectSlug,
    environmentSlug: grant.environmentSlug,
    envDataKeyId: grant.envDataKeyId,
    edkVersion: grant.edkVersion,
    edkSealed: decodeBlob(toBytes(grant.edkSealed)),
    ehkSealed: decodeBlob(toBytes(grant.ehkSealed)),
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
    recipientPublicKey: decodePublicKey(grant.recipientPublicKey),
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
export { decodePublicKey, encodePublicKey };

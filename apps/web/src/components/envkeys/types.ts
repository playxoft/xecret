/**
 * The environment-key payloads, as the API returns them.
 *
 * These mirror `server/schemas/env-keys.ts` and are stated here rather than
 * imported from it for the reason every other client type file in this codebase
 * gives: importing a server module into a client bundle drags its dependency
 * graph — the repository types, drizzle, `errors` — across a boundary that
 * exists to keep them apart. The cost is that the two can drift; the test suite
 * pins the direction that matters by validating the *request* bodies this module
 * builds against the server's own zod schemas.
 *
 * ── What is a blob and what is not ──
 * `edkSealed`, `ehkSealed` and `signature` are `xk2.` strings, parsed by
 * `@xecret/core/crypto/client` and never by hand. `publicKey` is raw base64url,
 * because a public key is not a ciphertext: it has no version tag and no AAD,
 * and its algorithm lives in a column beside it.
 */

/** The active `env_data_keys` row, as a client identifies it when sealing. */
export interface ActiveEdk {
  id: string;
  version: number;
}

/** The caller's own grant. Sealed to them, and useless to anybody else. */
export interface MyGrant {
  /** The key this grant was sealed to, base64url. Part of the signed payload. */
  recipientPublicKey: string;
  edkSealed: string;
  ehkSealed: string;
  signature: string;
  /** Whose Ed25519 key signed. Verification is deferred; the field is not. */
  signedByUserId: string;
}

/** One queued key share. Admins only — `pendingGrants` is `null` for anyone else. */
export interface PendingGrant {
  id: string;
  targetUserId: string;
  requestedBy: string;
  createdAt: string;
}

/**
 * A principal who may read the environment and holds no key for it.
 *
 * The mirror of `needsRotation`. Where that says "somebody holds the key who
 * should not", this says "somebody should hold it and does not" — the state a
 * vault reset leaves behind, and one no screen could see until the server began
 * reporting it.
 */
export interface MissingGrant {
  kind: 'member' | 'token';
  id: string;
}

/** The body of `GET …/environments/{envSlug}/keys`. */
export interface EnvironmentKeys {
  encryptionMode: 'server' | 'e2ee';
  /** The AAD component every seal and every secret ciphertext is bound to. */
  environmentId: string;
  activeEdk: ActiveEdk | null;
  myGrant: MyGrant | null;
  ehkExists: boolean;
  pendingGrants: PendingGrant[] | null;
  /**
   * A principal lost access and the key they held has not been replaced.
   *
   * `null` means the server did not compute it for this caller — it is answered
   * only for somebody who can act on it, because deciding it costs a read of the
   * whole roster and the caller who pays for it on the pull path can do nothing
   * with the answer. Treat `null` as "unknown", never as `false`.
   */
  needsRotation: boolean | null;
  /** Entitled principals holding no grant. `null` on the same terms as above. */
  missingGrants: MissingGrant[] | null;
  currentMaxSecretVersion: number;
}

export interface EnvironmentKeysResponse {
  keys: EnvironmentKeys;
}

/** One principal a grant may be sealed to. See `GET …/keys/recipients`. */
export interface Recipient {
  kind: 'member' | 'token';
  id: string;
  /** 32 bytes, base64url. */
  publicKey: string;
  holdsGrant: boolean;
}

/** Somebody entitled to the key who has no public key to seal to. */
export interface Unsealable {
  kind: 'member';
  id: string;
}

export interface RecipientsResponse {
  activeEdk: ActiveEdk | null;
  environmentId: string;
  recipients: Recipient[];
  unsealable: Unsealable[];
}

/** One grant as `POST …/keys/grants` and `POST …/keys/rotate` accept it. */
export interface GrantBody {
  recipientKind: 'member' | 'token' | 'invite';
  recipientId: string;
  /** 32 bytes, base64url — the key sealed to, which the signature binds. */
  recipientPublicKey: string;
  edkSealed: string;
  ehkSealed: string;
  signature: string;
}

/**
 * One invitation-sealed grant, as acceptance hands it over.
 *
 * Served exactly once, by `POST /api/invitations/accept`, and deleted as it
 * goes — see the note on that route. The two slugs travel with it because the
 * invitee has no other view of the organisation at that moment.
 */
export interface InviteKeyGrant {
  environmentId: string;
  projectSlug: string;
  environmentSlug: string;
  envDataKeyId: string;
  edkVersion: number;
  edkSealed: string;
  ehkSealed: string;
}

/** One client-encrypted value, as every `e2ee` write body carries it. */
export interface ClientValueBody {
  ciphertext: string;
  clientAlgorithm: string;
  envDataKeyId: string;
  /** base64url of 32 bytes. Decides whether a write appends a version. */
  valueHmac: string;
}

/** A stored ciphertext on its way back, from a reveal or from the pull bundle. */
export interface ClientSecretCiphertext {
  /** The `secrets` row id — an AAD component, not bookkeeping. */
  id: string;
  name: string;
  ciphertext: string;
  clientAlgorithm: string;
  /** May name a **retired** key: a version written before a rotation. */
  envDataKeyId: string;
  version: number;
}

/** `GET …/pull` in `e2ee` mode: the grant and the values, read together. */
export interface ClientEnvironmentBundle {
  encryptionMode: 'e2ee';
  keys: EnvironmentKeys;
  secrets: ClientSecretCiphertext[];
}

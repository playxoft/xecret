/**
 * Audit event types.
 *
 * The builder lands in Phase 8. The critical design rule is recorded here now:
 * `metadata` accepts an **allowlist of field names only**. Redaction is enforced
 * by the builder's type signature, not by asking developers to remember
 * (Rule 4/5, threat model §1).
 *
 * See docs/architecture/database-schema.md §8.
 */

export type ActorType = 'user' | 'cli_token' | 'service_token' | 'system';

export type AuditOutcome = 'success' | 'denied' | 'error';

/** Every auditable action. Dot-namespaced to match `Action` where they overlap. */
export type AuditAction =
  | 'auth.login'
  | 'auth.logout'
  | 'auth.login_failed'
  | 'auth.session_revoked'
  /**
   * The user vault was created: the moment an account acquires the key
   * hierarchy that every secret it can read is encrypted under.
   *
   * Terminal in one direction — a vault is created once, and re-creating it
   * would abandon everything sealed to the old public key — so this record is
   * the origin of the account's whole cryptographic history.
   */
  | 'vault.created'
  /**
   * A session was unlocked, or an unlock attempt was refused.
   *
   * The retired PIN deliberately did not audit *successful* unlocks, on the
   * reasoning that they happen twice a day and say nothing the surrounding
   * events do not. The vault reverses that call, because what an unlock now
   * marks is the moment key material became reachable on a device. "The vault
   * was opened at 03:00 from an address this account has never used" is a
   * sentence a zero-knowledge product has to be able to say, and no other event
   * says it.
   */
  | 'vault.unlocked'
  | 'vault.unlock_failed'
  /**
   * The master passphrase was changed: the User Key was re-wrapped under a new
   * passphrase-derived key and the unlock verifier replaced.
   *
   * Notably *not* a re-encryption of anything else. The User Key itself is
   * unchanged, so sessions on other devices stay valid and recovery codes keep
   * working — which is why this is worth dating separately from `vault.created`.
   */
  | 'vault.passphrase_changed'
  /**
   * A recovery code was redeemed — somebody got back into a vault without the
   * passphrase.
   *
   * The single most important line in this list for an incident review. It is
   * the only path that opens a vault with something other than the passphrase
   * or an enrolled passkey, it is single-use, and it forces a new passphrase and
   * a fresh set of codes in the same act.
   */
  | 'vault.recovery_used'
  /** The recovery-code set was replaced, invalidating every previous code. */
  | 'vault.recovery_codes_regenerated'
  /** A session was locked without being revoked — the user is still signed in. */
  | 'auth.locked'
  /** The idle auto-lock interval was changed. `reason` carries the new value. */
  | 'auth.autolock_changed'
  /**
   * The account deleted itself: memberships removed, solo organisations
   * soft-deleted, every session and CLI token revoked, the user row
   * soft-deleted. Terminal — the same identity can never sign in to it again.
   * Recorded against the account's primary organisation, whose soft-deleted
   * row keeps the record reachable.
   */
  | 'auth.account_deleted'
  | 'org.created'
  | 'org.updated'
  /**
   * An organisation was soft-deleted, taking every project, environment and
   * secret inside it out of reach in one act.
   *
   * The row it points at survives the deletion — that is what a soft delete is
   * for here — so this record, and every record filed against the organisation
   * before it, stays readable by an operator afterwards. Nobody in the product
   * can read them: the audit route resolves through `organizations` with a
   * `deleted_at is null` filter, so the organisation stops answering the moment
   * this event is written.
   */
  | 'org.deleted'
  | 'project.created'
  | 'project.updated'
  | 'project.deleted'
  | 'environment.created'
  | 'environment.updated'
  | 'environment.deleted'
  | 'secret.created'
  | 'secret.updated'
  | 'secret.deleted'
  | 'secret.rotated'
  | 'secret.read'
  | 'secret.revealed'
  | 'secret.imported'
  | 'member.invited'
  | 'member.joined'
  | 'member.removed'
  | 'member.role_changed'
  /**
   * A membership was switched off without being deleted, or switched back on.
   *
   * Distinct from `member.removed` because the histories differ in what they
   * imply: a suspension is reversible and keeps the member's grants intact,
   * which is exactly what an incident review needs to know when asking "could
   * this person still act during the window?" (they could not — a suspended
   * member resolves to `none` everywhere).
   */
  | 'member.suspended'
  | 'member.reinstated'
  /**
   * A pending invitation was withdrawn before anyone accepted it.
   *
   * `member.invited` records the offer and `member.joined` records the
   * acceptance; this records the third ending. An invitation that is neither
   * accepted nor revoked merely expires, which no event marks — expiry is the
   * absence of action, and inventing an actor for it would put a name on
   * something nobody did.
   */
  | 'invitation.revoked'
  | 'access.granted'
  | 'access.revoked'
  /**
   * A person approved CLI access for a named device on the consent screen.
   *
   * Distinct from `token.created`, which is recorded when the credential is
   * actually minted at exchange. The two happen from different network
   * positions — the browser and the CLI — and an incident review needs both:
   * an approval that was never exchanged is itself a signal.
   */
  | 'token.authorized'
  | 'token.created'
  | 'token.revoked'
  | 'token.used'
  | 'key.rotated'
  | 'access.denied';

/**
 * Fields permitted in `metadata`.
 *
 * There is deliberately no `value`, no `plaintext`, and no index signature. A
 * secret value cannot be placed in an audit record because the type system does
 * not allow it.
 *
 * The zero-knowledge events extend that guarantee rather than weakening it:
 * there is no `wrap`, no `verifier`, no `publicKey`, no `lookupHash`, and no
 * `recoveryCode`. Everything a vault event records is a *shape* — which kind of
 * wrap, how many codes — never the material itself. A wrap placed in an audit
 * record would put an offline attack surface into the one table the product is
 * built to keep readable, and the type system refuses it for the same reason it
 * refuses a secret value.
 */
export interface AuditMetadata {
  secretName?: string;
  /** The name a secret held before a rename; `secretName` carries the new one. */
  previousSecretName?: string;
  secretCount?: number;
  environmentSlug?: string;
  projectSlug?: string;
  targetEmail?: string;
  previousRole?: string;
  newRole?: string;
  /**
   * The access level a grant held before and after a change, e.g. `read`.
   *
   * Level names, never values. `access.granted` without them says a grant
   * changed; with them it says what the change *was*, which is the difference
   * between an audit line and a useful one when reviewing how someone came to
   * hold production access.
   */
  previousAccessLevel?: string;
  newAccessLevel?: string;
  tokenPrefix?: string;
  /** The device a CLI credential was approved for, e.g. a hostname. */
  deviceName?: string;
  keyVersion?: number;
  /**
   * Which wrap of the User Key an unlock or an enrolment used, e.g. `passkey`.
   *
   * The kind, never the wrap. Recording it is what lets a review distinguish
   * "they typed the passphrase" from "a passkey on some device did it" from
   * "a recovery code was burned" — three quite different stories that would
   * otherwise share one event.
   */
  wrapKind?: 'passphrase' | 'recovery' | 'prf';
  /** How many recovery codes a regeneration issued. A count, never a code. */
  recoveryCodeCount?: number;
  /** How many sessions one act affected — "lock everywhere", "sign out everywhere". */
  sessionCount?: number;
  /**
   * The declared shape of a secret's value, e.g. `int` or `url`.
   *
   * A type name, never a value. It is recorded because changing it changes what
   * future writes will be refused, which is a policy change worth being able to
   * date.
   */
  valueType?: string;
  reason?: string;
  source?: 'dashboard' | 'cli' | 'ci' | 'api';
}

export interface AuditEvent {
  orgId: string;
  actorType: ActorType;
  actorId: string | null;
  /** Denormalised so the record still reads correctly after the actor is deleted. */
  actorLabel: string | null;
  action: AuditAction;
  resourceType: string | null;
  resourceId: string | null;
  projectId: string | null;
  environmentId: string | null;
  outcome: AuditOutcome;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
  metadata: AuditMetadata;
}

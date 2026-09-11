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
  /**
   * The vault was destroyed and the account sent back to the setup ceremony.
   *
   * The end of the road for somebody who has lost both their passphrase and
   * every recovery code: there is no key left that opens their old data, and
   * nothing — no support ticket, no operator — can produce one. This event is
   * the only record that the data still sitting in the database became
   * permanently unreadable at a particular moment, which is what makes an
   * otherwise inexplicable "I cannot see any of my secrets" answerable.
   */
  | 'vault.reset'
  /**
   * A **bearer credential** read the account's vault material: the passphrase
   * wrap, the KDF salt and the Argon2 parameters.
   *
   * Not recorded for a browser session, and the asymmetry is the whole point. A
   * session reading its own material is the lock screen doing its job, several
   * times a day, and auditing it would bury this event under page views. A
   * long-lived `xct_…` token reading it is a different fact: that material is
   * offline-grindable, so the read hands whoever holds the token everything they
   * need to attack the passphrase at their leisure — and it discloses the Argon2
   * cost, which tells them how expensive that attack will be.
   *
   * The read is legitimate — it is what makes headless `xecret login
   * --passphrase` possible at all, since a CLI token cannot open a single grant
   * without the user's wrapped private key — and it is not removable without
   * removing the flow. So it is made *visible* instead: `principalKind` names the
   * credential, and "a token in a CI runner pulled my wraps at 04:00" becomes a
   * question somebody can ask. ADR 0009 records it under residual risks.
   */
  | 'vault.material_read'
  /**
   * A browser enrolled a six-digit device PIN, or re-enrolled under a new one.
   *
   * The one event that records an account choosing a *weaker* credential for
   * daily use, and that is exactly why it is here. The PIN is opt-in, the
   * passphrase stays the root, and the honest trade-off — a server colluding
   * with whoever holds the device can enumerate six digits — is stated in the
   * settings screen. An enrolment nobody remembers making is the shape of that
   * trade being taken by somebody else, and no other event marks it.
   */
  | 'vault.pin_enrolled'
  /**
   * A device PIN was turned off: on this browser, on another one, or on all of
   * them at once. `reason` says which, and which browser.
   *
   * Deliberately distinct from {@link 'vault.pin_burned'}. Both end an enrolment
   * and they answer opposite questions in a review: this one was somebody
   * deciding, the other was somebody failing.
   */
  | 'vault.pin_disabled'
  /**
   * A device PIN was destroyed by wrong guesses — the fifth failure in a row.
   *
   * The security event of the whole feature. A PIN's entire budget is five
   * attempts, so this record is the moment that budget was spent, and a burst of
   * them across an account is the shape of somebody working through a stolen
   * laptop. Afterwards that wrap opens for nobody who never saw its pepper.
   */
  | 'vault.pin_burned'
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
  /**
   * An environment acquired the key hierarchy its values are encrypted under:
   * version 1 of its EDK, its EHK, and the creator's own grant.
   *
   * Terminal in one direction, like `vault.created`: an environment is keyed
   * once, and re-keying it would abandon everything encrypted under the old key.
   * This record is therefore the origin of that environment's whole
   * cryptographic history, and the only event that can precede a secret in it.
   */
  | 'envkey.created'
  /**
   * The Environment Data Key was replaced and re-sealed to every remaining
   * principal.
   *
   * Distinct from `key.rotated`, which belongs to the server envelope and
   * records an operator rotating material this deployment holds. This one
   * records something a *member's browser* did with a key the server never saw,
   * and it is the event that closes a revocation: deleting somebody's grant
   * stops them being handed the key again, and only a rotation stops the key
   * they already have from opening what is written next. `keyVersion` carries
   * the new version and `grantCount` how many principals it reached.
   */
  | 'envkey.rotated'
  /**
   * A principal was handed an environment's keys — a member gaining access, a
   * service token at creation, an invitation being prepared.
   *
   * Worth its own event rather than folding into `access.granted`, because the
   * two answer different questions and routinely happen at different times: the
   * first says somebody is *allowed* to read an environment, this says somebody
   * *can*. Under a zero-knowledge model those come apart, and the gap between
   * them is exactly what the pending queue exists to track.
   */
  | 'envkey.granted'
  /**
   * A principal's grant was deleted — the bookkeeping half of a revocation.
   *
   * Deliberately *not* the moment the environment became safe again. The
   * principal read what they read while they held the grant, and the sealed key
   * may still be in a browser or a token string. What follows this record is an
   * `envkey.rotated`, and an environment where the second never arrives is one
   * where the revocation is on paper only — which is why both are recorded and
   * why the API reports `needsRotation` until it lands.
   */
  | 'envkey.grant_revoked'
  /**
   * Somebody was given access to an environment by a person who could not seal
   * its key, so the key share was queued.
   *
   * The honest record of a partial act. Access changed and the member still
   * cannot read anything, which is a state that looks like a bug from every
   * screen in the product; without this event, the audit log would show the
   * access grant and no explanation of the gap that followed it.
   */
  | 'envkey.grant_pending'
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
  /**
   * Which device an event concerned: a hostname for a CLI approval, the
   * browser's own uuid for a device PIN.
   *
   * A name the device gave or an id it minted — never a fingerprint this server
   * derived, and never a `User-Agent`. Both kinds are already known to the
   * account that owns them, which is what makes the field safe to keep and
   * useful to read: "which browser burned its PIN" is unanswerable without it.
   */
  deviceName?: string;
  keyVersion?: number;
  /**
   * Which kind of principal a key grant addressed: `member`, `token` or
   * `invite`.
   *
   * The kind, never the recipient's key and never the sealed blob — the same
   * rule `wrapKind` follows. It is recorded because the three have very
   * different implications in a review: a grant to a member is a person gaining
   * reach, a grant to a token is a credential in a CI provider gaining it, and a
   * grant to an invitation is a key sitting in a row waiting for somebody who
   * has not signed in yet.
   */
  principalKind?: 'member' | 'token' | 'invite';
  /**
   * How many principals a key operation covered. A count, never a list of them.
   *
   * On a rotation this is the whole point of the record: "the production key was
   * rotated and re-sealed to 9 principals" is checkable against the roster, and
   * a number that drops without a matching removal is the shape of a rotation
   * that quietly lost somebody.
   */
  grantCount?: number;
  /**
   * Which wrap of the User Key an unlock or an enrolment used, e.g. `passkey`.
   *
   * The kind, never the wrap. Recording it is what lets a review distinguish
   * "they typed the passphrase" from "a passkey on some device did it" from
   * "a recovery code was burned" — three quite different stories that would
   * otherwise share one event.
   */
  wrapKind?: 'passphrase' | 'recovery' | 'prf';
  /**
   * How a session was unlocked.
   *
   * Narrower than `wrapKind` and pointed at a different question. `wrapKind`
   * names which ciphertext was opened, which matters when reasoning about the
   * key hierarchy; this names what the person did, which is what somebody
   * reading an unlock trail is actually asking. "Every unlock on this account
   * last week was a passkey and then one was not" is the shape of a story, and
   * it is unreadable if the two paths are only distinguishable by wrap type.
   *
   * `pin` is the third, and the one most worth being able to count: it is the
   * weakest of the three by design, and "every unlock on this laptop for a month
   * was a PIN" is a posture somebody may want to notice.
   */
  method?: 'passphrase' | 'passkey' | 'pin';
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

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
   * The unlock PIN was created, replaced, or reset through an emailed link.
   *
   * Recorded because a PIN change is the one account-level act that alters who
   * can reach secrets from an already-signed-in device. `auth.pin_reset` in
   * particular is what an incident review looks for: it means somebody proved
   * control of the mailbox rather than knowledge of the PIN.
   */
  | 'auth.pin_set'
  | 'auth.pin_changed'
  | 'auth.pin_reset'
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

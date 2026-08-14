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
  | 'access.granted'
  | 'access.revoked'
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
  secretCount?: number;
  environmentSlug?: string;
  projectSlug?: string;
  targetEmail?: string;
  previousRole?: string;
  newRole?: string;
  tokenPrefix?: string;
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

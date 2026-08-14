import { uuidv7 } from '../ids';
import type { Decision } from '../authz/types';
import { sanitizeMetadataString } from './redaction';
import type { ActorType, AuditAction, AuditEvent, AuditMetadata, AuditOutcome } from './types';

/**
 * The audit event builder.
 *
 * Every audit record in xecret is produced here. That is the point: redaction is
 * guaranteed by a type signature and by this one code path, never by asking a
 * route author to remember what is safe to log.
 *
 * Three properties are enforced rather than documented:
 *
 *  1. **A secret value cannot be recorded.** `metadata` is typed `AuditMetadata`,
 *     an allowlist with no `value` field and no index signature, so
 *     `{ value: plaintext }` is a compile error rather than a code review catch.
 *     `audit.test.ts` pins this with a `@ts-expect-error` so the guarantee is a
 *     verified fact and not a claim in a comment.
 *  2. **Everything attacker-influenced is sanitised on the way in.** A secret
 *     name, an invitee's email address and a user agent are all strings a
 *     stranger chose. They pass through `sanitizeMetadataString`, so none of
 *     them can carry a credential or forge a log line.
 *  3. **Refusals are recorded as loudly as successes.** A log that only holds
 *     what worked cannot show an attack in progress — a burst of `denied`
 *     `secret.read` events against production is the signal, and it only exists
 *     because the denial path writes a record too.
 *
 * The builder holds request context (who, from where) so a route passes only
 * what varies per event, and it never touches a database: persistence goes
 * through the narrow `AuditSink` below, which keeps `packages/core` free of
 * database imports.
 */

/** Everything about the caller that is constant for one request. */
export interface AuditContext {
  orgId: string;
  actorType: ActorType;
  actorId: string | null;
  /**
   * How the actor should read in the log — an email address, a token name.
   * Denormalised at write time; see `resolveActorLabel`.
   */
  actorLabel: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
}

/**
 * The kinds of thing an event can be about.
 *
 * A closed union rather than the `string` the column stores. `resourceType` is
 * what the audit UI groups and filters by, and one route writing `'secrets'`
 * where every other writes `'secret'` splits a customer's history in half with
 * no error anywhere.
 */
export type AuditResourceType =
  | 'org'
  | 'project'
  | 'environment'
  | 'secret'
  | 'member'
  | 'invitation'
  | 'access_grant'
  | 'token'
  | 'session'
  | 'key'
  | 'user';

/**
 * What an event is about.
 *
 * `projectId` and `environmentId` are denormalised onto the row so the audit UI
 * can answer "everything that happened in production last week" from one index
 * (`audit_logs_environment_idx`) instead of joining back to tables whose rows
 * may since have been deleted — the audit log has no foreign keys precisely so
 * that it outlives them.
 */
export interface AuditResource {
  type: AuditResourceType;
  /** `null` when the action failed before a row existed — a rejected create. */
  id: string | null;
  projectId?: string | null | undefined;
  environmentId?: string | null | undefined;
}

/**
 * An `AuditEvent` with its identifier assigned.
 *
 * The id lives here rather than in `types.ts` because `types.ts` describes the
 * agreed shape of an event, while assigning the id is the builder's job. It is a
 * UUIDv7, so the 48-bit timestamp it embeds *is* the creation instant: events
 * sort in creation order by primary key, which matters because a buffered
 * recorder writes rows after the response, and `created_at DEFAULT now()`
 * therefore records the flush, not the act.
 */
export interface AuditRecord extends AuditEvent {
  id: string;
}

/**
 * The refusal half of an authorization `Decision`.
 *
 * Typed as an `Extract` rather than `Decision` so an allowed decision cannot be
 * handed to `denied()`. There is no reason to write down.
 */
export type AuditDenial = Extract<Decision, { allowed: false }>;

/**
 * Why an operation failed, as a category.
 *
 * A closed union, not a string, because the alternative that always happens is
 * `error(action, resource, err.message)` — and an exception message is the one
 * string in the system most likely to carry a connection string, a stack path,
 * or the identifier of a row in another tenant. There is no signature here that
 * accepts one.
 *
 * camelCase to match `Decision['reason']`: both land in the same
 * `metadata.reason` field, and one column should speak one vocabulary.
 */
export type AuditErrorReason =
  | 'internal'
  | 'invalidInput'
  | 'conflict'
  | 'notFound'
  | 'rateLimited'
  | 'decryptionFailed'
  | 'keyUnavailable'
  | 'upstreamUnavailable'
  | 'quotaExceeded'
  | 'timeout';

/**
 * `reason` is set from the outcome, never by the caller, so a denial always
 * carries the reason the authorization engine actually gave.
 */
type ExtraMetadata = Omit<AuditMetadata, 'reason'>;

export interface AuditBuilder {
  /** Records an action that took effect. */
  success(
    action: AuditAction,
    resource: AuditResource | null,
    metadata?: AuditMetadata,
  ): AuditRecord;

  /**
   * Records a refusal, with the reason the authorization engine gave.
   *
   * Note what a denial deliberately does *not* record: `Decision.message` is
   * presentation text whose wording changes and which may name a resource. The
   * category is what alerting groups by.
   */
  denied(
    action: AuditAction,
    resource: AuditResource | null,
    decision: AuditDenial,
    metadata?: ExtraMetadata,
  ): AuditRecord;

  /** Records an action that failed for a reason that is not authorization. */
  error(
    action: AuditAction,
    resource: AuditResource | null,
    reason: AuditErrorReason,
    metadata?: ExtraMetadata,
  ): AuditRecord;
}

/**
 * Per-field length limits, in characters.
 *
 * Bounded because these strings are chosen by whoever is being audited, and an
 * attacker who can write a megabyte into `secretName` can inflate the audit
 * partition, slow every query over it, and push the interesting rows off the
 * screen. `secretName` mirrors `SECRET_NAME_MAX_LENGTH` from the validation
 * module and is restated rather than imported so this path stays free of that
 * module's schema dependency.
 */
const LIMITS = {
  secretName: 256,
  slug: 128,
  email: 320,
  role: 64,
  accessLevel: 32,
  tokenPrefix: 32,
  deviceName: 128,
  valueType: 32,
  reason: 256,
  actorLabel: 320,
  userAgent: 512,
  requestId: 128,
} as const;

/**
 * How an actor with an id but no label is described.
 *
 * Per actor type, because `(deleted user)` on a row whose actor was a CI service
 * token would be an invented fact, and an audit log that invents facts is worse
 * than one that omits them.
 */
const UNLABELLED_ACTOR: Readonly<Record<ActorType, string>> = {
  user: '(deleted user)',
  cli_token: '(deleted CLI token)',
  service_token: '(deleted service token)',
  system: 'system',
};

export function createAuditBuilder(context: AuditContext): AuditBuilder {
  // Resolved once: these are properties of the request, not of the event, and a
  // request emitting twenty `secret.read` events should not sanitise the same
  // user agent twenty times.
  const actorLabel = resolveActorLabel(context);
  const userAgent = sanitizeOrNull(context.userAgent, LIMITS.userAgent);
  const requestId = sanitizeOrNull(context.requestId, LIMITS.requestId);

  function build(
    action: AuditAction,
    resource: AuditResource | null,
    outcome: AuditOutcome,
    metadata: AuditMetadata,
  ): AuditRecord {
    return {
      id: uuidv7(),
      orgId: context.orgId,
      actorType: context.actorType,
      actorId: context.actorId,
      actorLabel,
      action,
      resourceType: resource?.type ?? null,
      resourceId: resource?.id ?? null,
      projectId: resource?.projectId ?? null,
      environmentId: resource?.environmentId ?? null,
      outcome,
      // Not sanitised: the column is `inet`, which rejects anything that is not
      // an address outright — a stronger guarantee than any string cleaning, and
      // one that string cleaning could only weaken by quietly reshaping a value
      // into something that still parses.
      ipAddress: context.ipAddress,
      userAgent,
      requestId,
      metadata: sanitizeMetadata(metadata),
    };
  }

  return {
    success(action, resource, metadata = {}) {
      return build(action, resource, 'success', metadata);
    },

    denied(action, resource, decision, metadata = {}) {
      return build(action, resource, 'denied', { ...metadata, reason: decision.reason });
    },

    error(action, resource, reason, metadata = {}) {
      return build(action, resource, 'error', { ...metadata, reason });
    },
  };
}

/**
 * Decides what the actor column will say for the rest of time.
 *
 * The label is denormalised at write time because the row it came from will be
 * deleted eventually, and "who did this" must still be answerable afterwards. A
 * caller that knows the id but not the label — a token used long after the user
 * left — gets an honest placeholder instead of a `null` that renders as an empty
 * cell and reads like a bug.
 */
function resolveActorLabel(context: AuditContext): string | null {
  const label =
    context.actorLabel === null
      ? ''
      : sanitizeMetadataString(context.actorLabel, LIMITS.actorLabel);
  if (label !== '') return label;

  // A genuinely anonymous event — a failed login before any identity is known —
  // keeps a null actor. Inventing a label there would assert more than we know.
  return context.actorId === null ? null : UNLABELLED_ACTOR[context.actorType];
}

/**
 * Rebuilds `metadata` field by field.
 *
 * The repetition is the feature. `AuditMetadata` has no index signature, so
 * there is no loop that could copy an unknown key through, and adding a field to
 * the contract forces someone to decide here how it is sanitised and how long it
 * may be. A `for (const [k, v] of Object.entries(metadata))` would be shorter
 * and would quietly accept whatever a future caller passed through a cast.
 */
function sanitizeMetadata(metadata: AuditMetadata): AuditMetadata {
  const clean: AuditMetadata = {};

  if (metadata.secretName !== undefined) {
    clean.secretName = sanitizeMetadataString(metadata.secretName, LIMITS.secretName);
  }
  if (metadata.environmentSlug !== undefined) {
    clean.environmentSlug = sanitizeMetadataString(metadata.environmentSlug, LIMITS.slug);
  }
  if (metadata.projectSlug !== undefined) {
    clean.projectSlug = sanitizeMetadataString(metadata.projectSlug, LIMITS.slug);
  }
  if (metadata.targetEmail !== undefined) {
    clean.targetEmail = sanitizeMetadataString(metadata.targetEmail, LIMITS.email);
  }
  if (metadata.previousRole !== undefined) {
    clean.previousRole = sanitizeMetadataString(metadata.previousRole, LIMITS.role);
  }
  if (metadata.newRole !== undefined) {
    clean.newRole = sanitizeMetadataString(metadata.newRole, LIMITS.role);
  }
  if (metadata.previousAccessLevel !== undefined) {
    clean.previousAccessLevel = sanitizeMetadataString(
      metadata.previousAccessLevel,
      LIMITS.accessLevel,
    );
  }
  if (metadata.newAccessLevel !== undefined) {
    clean.newAccessLevel = sanitizeMetadataString(metadata.newAccessLevel, LIMITS.accessLevel);
  }
  if (metadata.tokenPrefix !== undefined) {
    clean.tokenPrefix = sanitizeMetadataString(metadata.tokenPrefix, LIMITS.tokenPrefix);
  }
  if (metadata.deviceName !== undefined) {
    clean.deviceName = sanitizeMetadataString(metadata.deviceName, LIMITS.deviceName);
  }
  if (metadata.valueType !== undefined) {
    clean.valueType = sanitizeMetadataString(metadata.valueType, LIMITS.valueType);
  }
  if (metadata.reason !== undefined) {
    clean.reason = sanitizeMetadataString(metadata.reason, LIMITS.reason);
  }

  // Non-finite numbers are dropped rather than stored: `JSON.stringify(NaN)` is
  // `null`, and a `null` in the column is indistinguishable from a field nobody
  // set. Omitting it says "not recorded", which is true.
  if (metadata.secretCount !== undefined && Number.isFinite(metadata.secretCount)) {
    clean.secretCount = metadata.secretCount;
  }
  if (metadata.keyVersion !== undefined && Number.isFinite(metadata.keyVersion)) {
    clean.keyVersion = metadata.keyVersion;
  }
  if (metadata.sessionCount !== undefined && Number.isFinite(metadata.sessionCount)) {
    clean.sessionCount = metadata.sessionCount;
  }

  // A closed union of four literals; there is nothing to sanitise.
  if (metadata.source !== undefined) clean.source = metadata.source;

  return clean;
}

function sanitizeOrNull(value: string | null, maxLength: number): string | null {
  if (value === null) return null;
  const sanitized = sanitizeMetadataString(value, maxLength);
  return sanitized === '' ? null : sanitized;
}

/**
 * Where audit records go.
 *
 * Deliberately one method wide. `packages/core` is runtime-agnostic (ADR 0005)
 * and must not import a database driver, so persistence is supplied from
 * outside: `packages/db` implements this with a batched INSERT, and tests use
 * `InMemoryAuditSink`.
 */
export interface AuditSink {
  write(events: readonly AuditRecord[]): Promise<void>;
}

/**
 * Collects the events of one request and writes them in a single batch.
 *
 * A Cloudflare Worker may only have six outgoing connections in flight at once,
 * and `xecret pull` can emit an event per secret. A round trip per event would
 * spend that budget on bookkeeping and add it to the time the user waits.
 * Buffering, then flushing from `ctx.waitUntil()` after the response has been
 * sent, keeps audit writes off the user-visible latency path entirely.
 *
 * What buffering must never become is a way to lose records:
 *
 * - `flush()` **propagates** whatever the sink throws. An audit write that
 *   fails silently is worse than one that fails loudly — the log would look
 *   complete while missing exactly the events an attacker caused.
 * - Events are dropped from the buffer only after the sink has accepted them,
 *   so a failed flush leaves the buffer intact and a retry is possible.
 * - Concurrent calls share one in-flight write, because a route that flushes
 *   explicitly and also hands `flush` to `waitUntil` must not write the same
 *   rows twice.
 *
 * The events themselves are still ordered by their UUIDv7 ids regardless of when
 * the flush lands.
 */
export class BufferedAuditRecorder {
  readonly #sink: AuditSink;
  #pending: AuditRecord[] = [];
  #inFlight: Promise<void> | null = null;

  constructor(sink: AuditSink) {
    this.#sink = sink;
  }

  record(...events: AuditRecord[]): void {
    this.#pending.push(...events);
  }

  /** How many events are waiting. Non-zero after a failed flush, by design. */
  get size(): number {
    return this.#pending.length;
  }

  flush(): Promise<void> {
    this.#inFlight ??= this.#drain();
    return this.#inFlight;
  }

  async #drain(): Promise<void> {
    try {
      const batch = [...this.#pending];
      // Nothing to write: a second flush after a successful one is a no-op
      // rather than an empty INSERT.
      if (batch.length === 0) return;

      await this.#sink.write(batch);

      // Only what the sink accepted is discarded. Anything recorded while the
      // write was in flight stays queued for the next flush.
      this.#pending = this.#pending.slice(batch.length);
    } finally {
      // Cleared even on failure, so a caller that catches the error can retry.
      this.#inFlight = null;
    }
  }
}

/** An `AuditSink` that keeps everything in memory. For tests. */
export class InMemoryAuditSink implements AuditSink {
  readonly #batches: AuditRecord[][] = [];

  write(events: readonly AuditRecord[]): Promise<void> {
    // Copied, so that a caller reusing its array cannot rewrite history here.
    this.#batches.push([...events]);
    return Promise.resolve();
  }

  /** One entry per `write` call, in call order. */
  get batches(): readonly (readonly AuditRecord[])[] {
    return this.#batches;
  }

  /** Every event written, flattened, in write order. */
  get events(): readonly AuditRecord[] {
    return this.#batches.flat();
  }
}

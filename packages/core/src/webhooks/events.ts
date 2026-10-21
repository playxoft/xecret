/**
 * What a webhook says, and when it is retried (P19 §5).
 *
 * ── The payload never contains a secret value ──
 * Not by convention: `WebhookEventData` is an allowlist with no field that could
 * hold one — the same shape as `AuditMetadata`, for the same reason. A value
 * cannot be placed in a payload because there is no property to put it in, and
 * `buildWebhookPayload` rebuilds the object field by field, so a cast that
 * smuggled one past the compiler is dropped on the way out.
 *
 * Under end-to-end encryption the server could not include a value if it tried
 * — it holds none — but the rule is stated as a type anyway, because the legacy
 * server-mode environments are still decrypted here, and because "the payload
 * never contains a secret value" is a promise to customers that should not
 * depend on which half of a migration their environment is in. Anybody who wants
 * the value fetches it with a credential, and that fetch is audited.
 */

export const WEBHOOK_EVENT_TYPES = [
  'secret.created',
  'secret.updated',
  'secret.deleted',
  /**
   * Reserved for scheduled rotation (P20 §2), which emits it. Subscribable now so
   * that an endpoint configured today receives it the day rotation ships.
   */
  'secret.rotated',
  'environment.promoted',
  'environment.restored',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** The one event no subscription selects: a delivery asked for from the dashboard. */
export const WEBHOOK_TEST_EVENT = 'webhook.test';

export type DeliverableEventType = WebhookEventType | typeof WEBHOOK_TEST_EVENT;

export function isWebhookEventType(value: unknown): value is WebhookEventType {
  return typeof value === 'string' && (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

/** Who did it. A label is an email or a token name — never a token. */
export interface WebhookActor {
  readonly type: 'user' | 'cli_token' | 'service_token' | 'system';
  readonly id: string | null;
  readonly label: string | null;
}

/**
 * Everything a payload may carry. Names, slugs, counts and versions — the same
 * vocabulary as the audit log, which the documentation states as the contract.
 */
export interface WebhookEventData {
  readonly organization: { readonly id: string; readonly slug: string };
  readonly project?: { readonly id: string; readonly slug: string } | undefined;
  readonly environment?: { readonly id: string; readonly slug: string } | undefined;
  /** The secret's name and the version now current. Never its value. */
  readonly secret?: { readonly name: string; readonly version?: number | undefined } | undefined;
  /**
   * For one write that changed several secrets the same way — an import, a
   * promotion, a restore: every one of them, by name and version, in one event
   * instead of one event each (review round 1, M4). Present instead of `secret`,
   * never beside it, and capped at {@link WEBHOOK_MAX_SECRETS_PER_EVENT}; `counts`
   * says how many there were in all.
   */
  readonly secrets?:
    readonly { readonly name: string; readonly version?: number | undefined }[] | undefined;
  /** For a promotion: where the values came from. */
  readonly source?: { readonly id: string; readonly slug: string } | undefined;
  /** For a promotion or a restore: what changed, as counts. */
  readonly counts?:
    | {
        readonly created?: number | undefined;
        readonly updated?: number | undefined;
        readonly deleted?: number | undefined;
        readonly unchanged?: number | undefined;
      }
    | undefined;
  /** For a restore: the moment the environment was returned to, ISO 8601. */
  readonly restoredTo?: string | undefined;
  readonly actor: WebhookActor;
}

export interface WebhookPayload {
  readonly type: DeliverableEventType;
  /** ISO 8601, when the event happened. */
  readonly timestamp: string;
  readonly data: WebhookEventData;
}

const NAME_LIMIT = 256;
const SLUG_LIMIT = 128;
const LABEL_LIMIT = 320;

/**
 * The most secrets one coalesced event lists. A batch is itself capped at a
 * thousand writes (an import, a promotion, a restore), so in practice the list
 * is whole; the cap is what keeps a body bounded if that ever changes, and
 * `counts` still says how many there were.
 */
export const WEBHOOK_MAX_SECRETS_PER_EVENT = 1000;

function clip(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit);
}

function count(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function ref(
  value: { id: string; slug: string } | undefined,
): { id: string; slug: string } | undefined {
  return value === undefined ? undefined : { id: value.id, slug: clip(value.slug, SLUG_LIMIT) };
}

function secretRef(value: { name: string; version?: number | undefined }): {
  name: string;
  version?: number;
} {
  const version = count(value.version);
  return { name: clip(value.name, NAME_LIMIT), ...(version === undefined ? {} : { version }) };
}

/**
 * Builds the payload, copying only the allowlisted fields.
 *
 * The repetition is the feature, as in the audit builder: a field added to
 * `WebhookEventData` has to be decided here, and a loop over `Object.entries`
 * would quietly forward whatever a future caller passed through a cast.
 */
export function buildWebhookPayload(
  type: DeliverableEventType,
  occurredAt: Date,
  data: WebhookEventData,
): WebhookPayload {
  const clean: {
    -readonly [K in keyof WebhookEventData]: WebhookEventData[K];
  } = {
    organization: { id: data.organization.id, slug: clip(data.organization.slug, SLUG_LIMIT) },
    actor: {
      type: data.actor.type,
      id: data.actor.id,
      label: data.actor.label === null ? null : clip(data.actor.label, LABEL_LIMIT),
    },
  };

  const project = ref(data.project);
  if (project !== undefined) clean.project = project;
  const environment = ref(data.environment);
  if (environment !== undefined) clean.environment = environment;
  const source = ref(data.source);
  if (source !== undefined) clean.source = source;

  if (data.secret !== undefined) {
    clean.secret = secretRef(data.secret);
  } else if (data.secrets !== undefined) {
    // Rebuilt entry by entry, for the reason the whole object is: an entry is
    // a name and a version, and nothing a cast slipped in beside them survives.
    clean.secrets = data.secrets.slice(0, WEBHOOK_MAX_SECRETS_PER_EVENT).map(secretRef);
  }

  if (data.counts !== undefined) {
    const counts: { created?: number; updated?: number; deleted?: number; unchanged?: number } = {};
    for (const key of ['created', 'updated', 'deleted', 'unchanged'] as const) {
      const value = count(data.counts[key]);
      if (value !== undefined) counts[key] = value;
    }
    clean.counts = counts;
  }

  if (data.restoredTo !== undefined && !Number.isNaN(Date.parse(data.restoredTo))) {
    clean.restoredTo = new Date(data.restoredTo).toISOString();
  }

  return { type, timestamp: occurredAt.toISOString(), data: clean };
}

/**
 * When each attempt after the first is made: a minute, five, half an hour, two
 * hours, six, twelve, a day. Eight attempts across roughly two days, after
 * which the delivery is abandoned and the log says so.
 *
 * Granular to the scheduler: retries are picked up by a Cron Trigger that runs
 * every five minutes, so "a minute" means "on the next run".
 */
export const WEBHOOK_RETRY_DELAYS_SECONDS: readonly number[] = Object.freeze([
  60, 300, 1800, 7200, 21_600, 43_200, 86_400,
]);

export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_SECONDS.length + 1;

/** When the next attempt is due after `attempts` have failed, or `null` to give up. */
export function nextAttemptAt(attempts: number, failedAt: Date): Date | null {
  const delay = WEBHOOK_RETRY_DELAYS_SECONDS[attempts - 1];
  if (delay === undefined) return null;
  return new Date(failedAt.getTime() + delay * 1000);
}

/**
 * "Sustained failure", for auto-disabling an endpoint: this many failed attempts
 * in a row with no success between them, spanning at least a day.
 *
 * Both halves, because either alone misfires. A count alone disables an
 * endpoint that was down for ten minutes during a burst of writes; a duration
 * alone disables one that failed twice a day apart and succeeded in between.
 */
export const WEBHOOK_DISABLE_AFTER_FAILURES = 15;
export const WEBHOOK_DISABLE_AFTER_MS = 86_400_000;

export function shouldDisableWebhook(
  consecutiveFailures: number,
  failingSince: Date | null,
  now: Date,
): boolean {
  return (
    consecutiveFailures >= WEBHOOK_DISABLE_AFTER_FAILURES &&
    failingSince !== null &&
    now.getTime() - failingSince.getTime() >= WEBHOOK_DISABLE_AFTER_MS
  );
}

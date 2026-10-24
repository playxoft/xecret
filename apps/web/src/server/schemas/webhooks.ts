import * as z from 'zod/mini';
import { WEBHOOK_EVENT_TYPES, WEBHOOK_URL_MAX_LENGTH } from '@xecret/core/webhooks';
import type { DeliveryRecord, WebhookRecord } from '@xecret/db/repositories';

/**
 * The webhook routes (P19 §5): the bodies they accept, and the shapes they
 * answer with.
 *
 * ── What no payload here carries ──
 * The signing secret, sealed or not. The repository's listing selects no secret
 * column, and these serialisers list their fields one by one, so a column added
 * to the table cannot reach a response by being on the row. The plaintext
 * `whsec_…` is returned exactly twice in a webhook's life — by the create and
 * the rotate routes, beside the payload, never inside it — and is not
 * recoverable afterwards by anyone, this server's own API included.
 *
 * The URL *is* returned, to the owners and admins who can read these routes at
 * all: it is theirs, they typed it, and editing it needs it. It is never
 * written to the audit log or a log line, where the host stands in for it — a
 * chat integration's incoming-webhook URL carries its credential in the path.
 */

const UNEXPECTED_FIELD = 'The request contains a field this endpoint does not accept.';
const NON_EMPTY_PATCH = 'Provide at least one field to update.';

/** How long a description may be. A label, not a document. */
export const WEBHOOK_DESCRIPTION_MAX_LENGTH = 500;

/**
 * Checked for shape here and for safety in the route: `checkWebhookUrl` is what
 * refuses `http:`, credentials in the URL and private addresses, and it runs
 * again before every delivery. The length bound is restated so a megabyte of
 * URL is refused by the schema before anything parses it.
 */
const urlSchema = z
  .string()
  .check(
    z.trim(),
    z.minLength(1, 'Enter the URL to deliver to.'),
    z.maxLength(
      WEBHOOK_URL_MAX_LENGTH,
      `A webhook URL may be at most ${WEBHOOK_URL_MAX_LENGTH} characters.`,
    ),
  );

/** Nullable so a description can be cleared; `undefined` leaves it alone. */
const descriptionSchema = z.nullable(
  z
    .string()
    .check(
      z.trim(),
      z.maxLength(
        WEBHOOK_DESCRIPTION_MAX_LENGTH,
        `A description must be at most ${WEBHOOK_DESCRIPTION_MAX_LENGTH} characters.`,
      ),
    ),
);

/**
 * At least one event, every one from the closed list, none twice. `webhook.test`
 * is not subscribable — it is what the dashboard's "send a test" button sends,
 * to one endpoint, on request.
 */
const eventTypesSchema = z.array(z.enum(WEBHOOK_EVENT_TYPES)).check(
  z.minLength(1, 'Choose at least one event to deliver.'),
  z.maxLength(WEBHOOK_EVENT_TYPES.length, 'Each event may be chosen once.'),
  z.refine((types) => new Set(types).size === types.length, {
    message: 'Each event may be chosen once.',
  }),
);

/** `POST /api/orgs/{orgSlug}/webhooks`. */
export const webhookCreateSchema = z.strictObject(
  {
    url: urlSchema,
    description: z.optional(descriptionSchema),
    eventTypes: eventTypesSchema,
  },
  UNEXPECTED_FIELD,
);

export type WebhookCreate = z.infer<typeof webhookCreateSchema>;

/**
 * `PATCH /api/orgs/{orgSlug}/webhooks/{webhookId}`.
 *
 * `enabled: true` re-enables — and clears the run of failures, so an endpoint
 * that was switched off for failing starts again with a clean slate rather than
 * one failure from being switched off again. `enabled: false` switches it off
 * as `manual`.
 */
export const webhookPatchSchema = z
  .strictObject(
    {
      url: z.optional(urlSchema),
      description: z.optional(descriptionSchema),
      eventTypes: z.optional(eventTypesSchema),
      enabled: z.optional(z.boolean()),
    },
    UNEXPECTED_FIELD,
  )
  .check(z.refine((patch) => Object.keys(patch).length > 0, { message: NON_EMPTY_PATCH }));

export type WebhookPatchBody = z.infer<typeof webhookPatchSchema>;

/** `?limit=` on the delivery log and the read sightings. */
export const listLimitQuerySchema = z.object({
  limit: z.optional(z.pipe(z.coerce.number(), z.int().check(z.gte(1), z.lte(200)))),
});

/** The host a URL delivers to — what the audit log and the logs carry instead of the URL. */
export function endpointHostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '(unparseable)';
  }
}

/** One endpoint, as every webhook route answers with it. */
export interface WebhookPayload {
  id: string;
  url: string;
  endpointHost: string;
  description: string | null;
  eventTypes: string[];
  /**
   * `active` delivers; `disabled` was switched off — by a person (`manual`) or
   * by sustained failure (`failures`, see `disabledReason`); `paused` is an
   * endpoint the plan no longer includes (a downgrade to Free), kept exactly as
   * it was and delivering again the moment the plan does.
   */
  state: 'active' | 'disabled' | 'paused';
  enabled: boolean;
  disabledReason: 'manual' | 'failures' | null;
  disabledAt: string | null;
  consecutiveFailures: number;
  failingSince: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

export function toWebhookPayload(record: WebhookRecord, pausedByPlan: boolean): WebhookPayload {
  return {
    id: record.id,
    url: record.url,
    endpointHost: endpointHostOf(record.url),
    description: record.description,
    eventTypes: [...record.eventTypes],
    state: !record.enabled ? 'disabled' : pausedByPlan ? 'paused' : 'active',
    enabled: record.enabled,
    disabledReason: record.disabledReason,
    disabledAt: iso(record.disabledAt),
    consecutiveFailures: record.consecutiveFailures,
    failingSince: iso(record.failingSince),
    lastSuccessAt: iso(record.lastSuccessAt),
    lastFailureAt: iso(record.lastFailureAt),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * How much of a delivery's body the log returns. A body is names, slugs and
 * counts — never a value — so it is safe to show; it is capped because a
 * listing of two hundred deliveries should not be two hundred full payloads.
 */
export const DELIVERY_BODY_PREVIEW_LENGTH = 2048;

/** One delivery, in the endpoint's log. */
export interface DeliveryPayload {
  id: string;
  eventType: string;
  status: DeliveryRecord['status'];
  attempts: number;
  /** The receiver's HTTP status on the last attempt; `null` when none answered. */
  lastStatusCode: number | null;
  /**
   * A fixed category — `timeout`, `network`, `redirect`, `http_<status>`,
   * `invalid_url`, `signing_failed` — or a fixed sentence for an abandonment.
   * Never anything the receiver sent.
   */
  lastError: string | null;
  createdAt: string;
  completedAt: string | null;
  nextAttemptAt: string | null;
  body: string;
  bodyTruncated: boolean;
}

export function toDeliveryPayload(record: DeliveryRecord): DeliveryPayload {
  const truncated = record.body.length > DELIVERY_BODY_PREVIEW_LENGTH;
  return {
    id: record.id,
    eventType: record.eventType,
    status: record.status,
    attempts: record.attempts,
    lastStatusCode: record.lastStatusCode,
    lastError: record.lastError,
    createdAt: record.createdAt.toISOString(),
    completedAt: iso(record.completedAt),
    nextAttemptAt: iso(record.nextAttemptAt),
    body: truncated ? record.body.slice(0, DELIVERY_BODY_PREVIEW_LENGTH) : record.body,
    bodyTruncated: truncated,
  };
}

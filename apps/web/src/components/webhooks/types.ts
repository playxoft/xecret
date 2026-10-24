/**
 * The webhook payloads, as the routes under `/api/orgs/{org}/webhooks` return
 * them (P19 §5).
 *
 * These mirror `server/schemas/webhooks.ts` and are restated rather than
 * imported, for the reason every client type file gives: that module drags zod
 * and the repository types into a browser bundle.
 *
 * ── What is not representable here ──
 * The signing secret, on any endpoint. The listing never carries one, and the
 * only two responses that do — creating an endpoint and rotating its secret —
 * carry it *beside* the endpoint rather than inside it, so a component holding
 * a `Webhook` cannot be holding a secret by accident. See `WebhookCreated`.
 */

/**
 * `active` delivers; `disabled` was switched off — by a person, or by
 * sustained failure (see `disabledReason`); `paused` is an endpoint the plan no
 * longer includes, kept exactly as it was and sent nothing until it does.
 */
export type WebhookState = 'active' | 'disabled' | 'paused';

export interface Webhook {
  id: string;
  /**
   * The full URL. Returned to the owners and admins who can read these routes
   * at all, because editing needs it — and only rendered in the edit form, never
   * in the list: a chat integration's incoming-webhook URL carries its own
   * credential in the path, and the list is a screen people share.
   */
  url: string;
  /** What the list shows instead of the URL. */
  endpointHost: string;
  description: string | null;
  eventTypes: string[];
  state: WebhookState;
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

/** `GET …/webhooks`. */
export interface WebhookListResponse {
  webhooks: Webhook[];
  /** `max` is `null` where the plan sets no ceiling. */
  limit: { max: number | null; used: number };
  /** The plan includes no webhooks: every endpoint is kept and sent nothing. */
  paused: boolean;
  /** The cheapest plan that would allow another endpoint, when this one is at its ceiling. */
  upgradeTo: string | null;
}

/** `GET` and `PATCH …/webhooks/{id}`. */
export interface WebhookResponse {
  webhook: Webhook;
}

/**
 * `POST …/webhooks` → 201.
 *
 * `secret` is the `whsec_…` signing secret, returned here and from
 * `…/rotate-secret` and nowhere else, ever.
 */
export interface WebhookCreated {
  webhook: Webhook;
  secret: string;
}

/** `POST …/webhooks/{id}/rotate-secret`: the new secret, this once. */
export interface WebhookSecretRotated {
  secret: string;
}

export type DeliveryStatus = 'pending' | 'delivering' | 'succeeded' | 'abandoned';

/** How one attempt went, as `POST …/test` answers it. */
export interface DeliveryAttempt {
  id: string;
  status: DeliveryStatus;
  lastStatusCode: number | null;
  /** A fixed category — `timeout`, `http_503` — or a fixed sentence. Never the receiver's words. */
  lastError: string | null;
}

export interface WebhookTestResponse {
  delivery: DeliveryAttempt;
}

/** One entry in an endpoint's delivery log. */
export interface WebhookDelivery {
  id: string;
  eventType: string;
  status: DeliveryStatus;
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: string;
  completedAt: string | null;
  nextAttemptAt: string | null;
  /** The body *sent* — names, slugs and counts, never a value — capped by the server. */
  body: string;
  bodyTruncated: boolean;
}

export interface WebhookDeliveriesResponse {
  deliveries: WebhookDelivery[];
}

/** `POST …/webhooks`. */
export interface WebhookCreateBody {
  url: string;
  description?: string;
  eventTypes: string[];
}

/** `PATCH …/webhooks/{id}`: only what changed, and never nothing. */
export interface WebhookPatchBody {
  url?: string;
  description?: string | null;
  eventTypes?: string[];
  enabled?: boolean;
}

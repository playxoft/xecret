import { createAuditBuilder } from '@xecret/core/audit';
import type { AuditResource } from '@xecret/core/audit';
import { DecryptionError } from '@xecret/core/crypto';
import type { SealedOrgValue, WrappedOrgKey } from '@xecret/core/crypto';
import { checkLimit } from '@xecret/core/entitlements';
import type { Entitlements, PlanId } from '@xecret/core/entitlements';
import {
  buildWebhookPayload,
  checkWebhookUrl,
  nextAttemptAt,
  shouldDisableWebhook,
  signWebhook,
  WEBHOOK_TEST_EVENT,
} from '@xecret/core/webhooks';
import type { WebhookActor, WebhookEventData, WebhookEventType } from '@xecret/core/webhooks';
import {
  abandonDelivery,
  appendAuditEvents,
  claimDeliveries,
  claimDueDeliveries,
  disableWebhookForFailures,
  enqueueDeliveries,
  findOrganizationById,
  listAdministratorAddresses,
  listEnabledWebhooksForEvents,
  loadEntitlements,
  loadOrgKeyForSealing,
  loadOrgKeyVersion,
  recordDeliveryAttempt,
  releaseDeliveries,
} from '@xecret/db/repositories';
import type {
  ClaimedDelivery,
  DeliveryOutcome,
  DeliveryRecord,
  WebhookRecord,
  WebhookSecretMaterial,
  WebhookWithSecret,
} from '@xecret/db/repositories';
import { actorId, actorLabel, actorType } from './actor';
import type { Principal } from './actor';
import { publicOrigin } from './bindings';
import type { ServiceContext } from './context';
import { requireCapacity } from './entitlements';
import { errors } from './errors';
import { describeError } from './logging';
import { describeMailFailure, mailerFrom } from './mail';
import { webhookDisabledMail } from './notification-mail';
import { isUuid } from './schemas/ids';
import { endpointHostOf } from './schemas/webhooks';

/**
 * Webhooks on secret change (P19 §5): emitting events, delivering them, and
 * giving up on an endpoint that has stopped answering.
 *
 * ── The write never waits, and never fails, for a webhook ──
 * `emitWebhookEvents` is synchronous to its caller and cannot throw: every step
 * — finding the endpoints, queueing the deliveries, the first attempts — runs in
 * `services.waitUntil`, after the response. A receiver that is slow, down, or
 * hostile costs the person who changed a secret nothing, and a bug in this file
 * cannot turn a successful write into a 500. Failures are logged, never
 * surfaced; the delivery log is where a customer sees them.
 *
 * ── An organisation without webhooks pays one indexed query ──
 * `listEnabledWebhooksForEvents` on `webhooks_org_idx`, and nothing else: no
 * payload is built, nothing is inserted, no key is touched. An organisation
 * whose plan allows none — Free, or a downgrade to it — pays nothing at all: the
 * plan is read from the entitlements the caller already holds, before any query.
 *
 * ── At-least-once, with a stable id ──
 * Each (event, endpoint) pair is one row in `webhook_deliveries`, queued in one
 * statement for the whole batch, and its id is the `webhook-id` header on every
 * attempt. The first attempts are made inline, up to
 * {@link WEBHOOK_INLINE_ATTEMPTS} per call; the rest wait, due now, for the
 * five-minute sweep (`sweepWebhookDeliveries`), which is also what retries a
 * failure at `nextAttemptAt` and takes back a claim whose sender died. A
 * receiver can therefore see a delivery twice, and the documentation says to do
 * the work once per `webhook-id`.
 *
 * ── What a delivery is ──
 * The stored body, byte for byte, re-signed per attempt with a fresh timestamp
 * (Standard Webhooks: `webhook-id`, `webhook-timestamp`, `webhook-signature`).
 * Success is a 2xx. Everything else — a 3xx (redirects are never followed: a
 * redirect is how an allowed URL becomes a request to one that is not), a 4xx,
 * a 5xx, a timeout, a refused connection — is a failure, recorded as a fixed
 * category and the status code. **The receiver's response body is never read**:
 * it is text a third party chose, and the delivery log is a page in our
 * dashboard.
 *
 * ── Six connections ──
 * A Worker invocation may hold six outgoing connections at once (ADR 0006), and
 * the database already holds one. Deliveries run at most
 * {@link WEBHOOK_DELIVERY_CONCURRENCY} at a time, and the one mail an
 * auto-disable sends is sent from inside the delivery that caused it, so it
 * occupies that delivery's slot rather than a seventh.
 */

/** How long a receiver has to answer. Long enough for a cold function; short enough to bound a sweep. */
export const WEBHOOK_DELIVERY_TIMEOUT_MS = 10_000;

/** Deliveries in flight at once — see "Six connections" above. */
export const WEBHOOK_DELIVERY_CONCURRENCY = 4;

/**
 * First attempts made inline, per call, after the response. A bulk import is a
 * thousand events; making a thousand requests inside one `waitUntil` would
 * outlive it. Everything past this is due now and sent by the next sweep.
 */
export const WEBHOOK_INLINE_ATTEMPTS = 10;

/**
 * No new inline attempt is started after this long. `waitUntil` work is cut off
 * about thirty seconds after the response, and a delivery claimed but never
 * finished waits five minutes for the sweep to take it back; one never claimed
 * is sent by the very next run.
 */
export const WEBHOOK_INLINE_BUDGET_MS = 20_000;

/**
 * Deliveries one claim of the sweep takes. The sweep claims again and again
 * until nothing is due or {@link WEBHOOK_SWEEP_BUDGET_MS} is spent, so this
 * bounds one round trip's locks, not a run's throughput.
 */
export const WEBHOOK_SWEEP_BATCH = 25;

/**
 * No new delivery is started by a sweep after this long (review round 1, M4).
 * One fixed claim of twenty-five every five minutes was a ceiling of 7,200
 * deliveries a day for every organisation together — a single large import
 * could fill it for days. Now the sweep keeps claiming while it has time, and
 * a delivery still waiting when the time is up is handed back, due, for the
 * next run. Twenty seconds of starts, plus the last attempts' ten-second
 * timeout, keeps a run well inside what a Cron Trigger allows.
 */
export const WEBHOOK_SWEEP_BUDGET_MS = 20_000;

export const WEBHOOK_USER_AGENT = 'xecret-webhooks/1';

/** How many owners and admins an auto-disable notice goes to. */
const NOTICE_RECIPIENT_LIMIT = 20;

const SECRET_PURPOSE = 'webhook-secret' as const;

/* ── events ──────────────────────────────────────────────────────────────── */

export interface WebhookEvent {
  orgId: string;
  type: WebhookEventType;
  /** Names, slugs, counts and the actor — `WebhookEventData` has no field a value could go in. */
  data: WebhookEventData;
  /** When it happened; defaults to now. */
  occurredAt?: Date | undefined;
}

/** One event. See {@link emitWebhookEvents}; this is that with a batch of one. */
export function emitWebhookEvent(
  services: ServiceContext,
  entitlements: Entitlements,
  event: WebhookEvent,
): void {
  emitWebhookEvents(services, entitlements, [event]);
}

/**
 * Queues every event in `events` for every enabled endpoint subscribed to its
 * type, and makes the first attempts — all after the response.
 *
 * Every event in one call belongs to one organisation, whose entitlements these
 * are. An event naming another organisation — in `orgId` or in its payload's
 * `organization` — is dropped and logged rather than delivered: these endpoints
 * belong to the first event's organisation, and a payload about anybody else's
 * secrets must never reach them.
 *
 * Costs, whatever the batch size: one listing query, then (only if an endpoint
 * is subscribed) one insert, then at most {@link WEBHOOK_INLINE_ATTEMPTS}
 * attempts. Synchronous, and never throws.
 */
export function emitWebhookEvents(
  services: ServiceContext,
  entitlements: Entitlements,
  events: readonly WebhookEvent[],
): void {
  try {
    if (events.length === 0) return;
    // Paused by plan: the endpoints are kept, nothing is sent, and the listing
    // says why. Decided from what the caller already holds, before any query.
    if (entitlements.limits.webhooks === 0) return;

    services.waitUntil(
      emitNow(services, events).catch((cause: unknown) => {
        services.log
          .at('webhooks')
          .error('Could not queue webhook deliveries for a change; those events were not sent', {
            events: events.length,
            error: describeError(cause),
          });
      }),
    );
  } catch (cause) {
    try {
      services.log
        .at('webhooks')
        .error('Could not schedule webhook delivery for a change', { error: describeError(cause) });
    } catch {
      // A logger that throws has nothing left to report to.
    }
  }
}

async function emitNow(services: ServiceContext, events: readonly WebhookEvent[]): Promise<void> {
  const orgId = events[0]!.orgId;
  const ours = events.filter(
    (event) => event.orgId === orgId && event.data.organization.id === orgId,
  );
  if (ours.length !== events.length) {
    services.log
      .at('webhooks')
      .error('Dropped webhook events that named another organisation than their batch', {
        orgId,
        dropped: events.length - ours.length,
      });
  }
  if (ours.length === 0) return;

  const hooks = await listEnabledWebhooksForEvents(
    services.db,
    orgId,
    ours.map((event) => event.type),
  );
  if (hooks.length === 0) return;

  const now = new Date();
  const queued: { webhookId: string; orgId: string; eventType: string; body: string }[] = [];
  for (const event of ours) {
    const subscribed = hooks.filter((hook) => hook.eventTypes.includes(event.type));
    if (subscribed.length === 0) continue;
    // One body per event, shared by every endpoint that receives it.
    const body = JSON.stringify(
      buildWebhookPayload(event.type, event.occurredAt ?? now, event.data),
    );
    for (const hook of subscribed) {
      queued.push({ webhookId: hook.id, orgId, eventType: event.type, body });
    }
  }
  if (queued.length === 0) return;

  const ids = await enqueueDeliveries(services.db, queued);
  const run = new DeliveryRun(services);
  const deadline = Date.now() + WEBHOOK_INLINE_BUDGET_MS;

  await inPool(
    ids.slice(0, WEBHOOK_INLINE_ATTEMPTS),
    WEBHOOK_DELIVERY_CONCURRENCY,
    async (id) => {
      // Past the budget, a delivery is left exactly as queued — pending and
      // due now — so the next sweep sends it. Claimed and abandoned mid-flight,
      // it would wait five minutes for the stale-claim rule instead.
      if (Date.now() > deadline) return;
      const [claimed] = await claimDeliveries(services.db, [id]);
      if (claimed === undefined) return;
      await run.attempt(claimed, { retries: true });
    },
    (cause) => {
      services.log
        .at('webhooks')
        .error('A first webhook delivery attempt failed to complete; the sweep retries it', {
          orgId,
          error: describeError(cause),
        });
    },
  );
}

/** Who did it, as a payload names them: the audit log's actor, never a credential. */
export function webhookActorOf(principal: Principal): WebhookActor {
  return { type: actorType(principal), id: actorId(principal), label: actorLabel(principal) };
}

/* ── the signing secret ───────────────────────────────────────────────────── */

/**
 * Seals a new signing secret under the organisation's current master key,
 * bound to this webhook. The plaintext goes back to its creator once, in the
 * response that minted it, and is never stored, logged or audited.
 */
export async function sealWebhookSecret(
  services: ServiceContext,
  orgId: string,
  webhookId: string,
  secret: string,
): Promise<WebhookSecretMaterial> {
  const orgKey = await loadOrgKeyForSealing(services.db, orgId);
  if (orgKey === null) {
    // An organisation without an active master key cannot have any server-side
    // secret sealed for it; an operator has to run key recovery first.
    throw errors.unavailable('organisation has no active master key to seal a webhook secret');
  }
  return services.envelope.sealOrgValue({
    orgId,
    orgKey,
    purpose: SECRET_PURPOSE,
    resourceId: webhookId,
    plaintext: secret,
  });
}

/* ── delivering ───────────────────────────────────────────────────────────── */

/** How one attempt went, as the test route answers it. */
export interface DeliveryAttemptSummary {
  id: string;
  status: DeliveryRecord['status'];
  lastStatusCode: number | null;
  lastError: string | null;
}

type AttemptResult =
  | { kind: 'succeeded'; statusCode: number }
  | { kind: 'failed'; statusCode: number | null; error: string };

/**
 * One batch of deliveries — an emission, a sweep, a test — and what it can
 * reuse across them: org keys by version, opened secrets by webhook, plans by
 * organisation. Built per batch and dropped with it, so nothing here outlives
 * the request it was made for.
 */
class DeliveryRun {
  readonly #services: ServiceContext;
  readonly #orgKeys = new Map<string, WrappedOrgKey | null>();
  readonly #secrets = new Map<string, string>();
  readonly #plans = new Map<string, boolean>();

  constructor(services: ServiceContext) {
    this.#services = services;
  }

  /** Whether the organisation's plan still allows any webhook — checked by the sweep, per organisation. */
  async planIncludesWebhooks(orgId: string): Promise<boolean> {
    const known = this.#plans.get(orgId);
    if (known !== undefined) return known;
    const entitlements = await loadEntitlements(this.#services.db, orgId);
    const included = entitlements.limits.webhooks !== 0;
    this.#plans.set(orgId, included);
    return included;
  }

  async attempt(
    claimed: ClaimedDelivery,
    options: { retries: boolean },
  ): Promise<DeliveryAttemptSummary> {
    const { delivery, webhook } = claimed;
    const services = this.#services;

    // Switched off after this was queued. A test is the exception: a person
    // asked for it, to see whether a switched-off endpoint works again.
    if (delivery.eventType !== WEBHOOK_TEST_EVENT && !webhook.enabled) {
      const reason = 'endpoint switched off before delivery';
      await abandonDelivery(services.db, delivery.id, reason);
      return { id: delivery.id, status: 'abandoned', lastStatusCode: null, lastError: reason };
    }

    let result: AttemptResult;
    try {
      const secret = await this.#secret(webhook);
      result = await send(webhook.url, delivery.id, delivery.body, secret);
    } catch (cause) {
      // Only the secret can land here — `send` classifies its own failures. It
      // is this server's fault, not the receiver's, so it is loud.
      services.log
        .at('webhooks')
        .error('Could not open a webhook signing secret, so the delivery was not sent', {
          webhookId: webhook.id,
          orgId: webhook.orgId,
          error: describeError(cause),
        });
      result = { kind: 'failed', statusCode: null, error: 'signing_failed' };
    }

    const now = new Date();
    const outcome: DeliveryOutcome =
      result.kind === 'succeeded'
        ? result
        : {
            ...result,
            retryAt: options.retries ? nextAttemptAt(delivery.attempts + 1, now) : null,
          };
    const after = await recordDeliveryAttempt(services.db, {
      deliveryId: delivery.id,
      webhookId: webhook.id,
      outcome,
      // A test is not part of the endpoint's record: it neither counts towards
      // an automatic disable nor clears a run of real failures (round 1, L13).
      affectsEndpoint: delivery.eventType !== WEBHOOK_TEST_EVENT,
    });

    if (
      outcome.kind === 'failed' &&
      after !== null &&
      after.enabled &&
      shouldDisableWebhook(after.consecutiveFailures, after.failingSince, now)
    ) {
      await this.#disableForFailures(after);
    }

    return {
      id: delivery.id,
      status:
        outcome.kind === 'succeeded'
          ? 'succeeded'
          : outcome.retryAt === null
            ? 'abandoned'
            : 'pending',
      lastStatusCode: outcome.statusCode,
      lastError: outcome.kind === 'succeeded' ? null : outcome.error,
    };
  }

  async #secret(webhook: WebhookWithSecret): Promise<string> {
    const cached = this.#secrets.get(webhook.id);
    if (cached !== undefined) return cached;

    const versionKey = `${webhook.orgId}:${webhook.secret.keyVersion}`;
    let orgKey = this.#orgKeys.get(versionKey);
    if (orgKey === undefined) {
      orgKey = await loadOrgKeyVersion(this.#services.db, webhook.orgId, webhook.secret.keyVersion);
      this.#orgKeys.set(versionKey, orgKey);
    }
    if (orgKey === null) throw new DecryptionError();

    const sealed: SealedOrgValue = {
      ciphertext: new Uint8Array(webhook.secret.ciphertext),
      iv: new Uint8Array(webhook.secret.iv),
      keyVersion: webhook.secret.keyVersion,
    };
    const secret = await this.#services.envelope.openOrgValue({
      orgId: webhook.orgId,
      orgKey,
      purpose: SECRET_PURPOSE,
      resourceId: webhook.id,
      sealed,
    });
    this.#secrets.set(webhook.id, secret);
    return secret;
  }

  /**
   * Switches the endpoint off, files `webhook.disabled` with a `system` actor,
   * and tells the owners and admins. Once: `disableWebhookForFailures` answers
   * `null` to every sender but the first. The record and the mail are each
   * allowed to fail without stopping the other — the disable itself has
   * already happened, and is the fact either way.
   */
  async #disableForFailures(failing: WebhookRecord): Promise<void> {
    const services = this.#services;
    const log = services.log.at('webhooks');
    const disabled = await disableWebhookForFailures(services.db, failing.id);
    if (disabled === null) return;

    const endpointHost = endpointHostOf(disabled.url);
    log.warn('Switched off a webhook after sustained delivery failure', {
      orgId: disabled.orgId,
      webhookId: disabled.id,
      endpointHost,
      failures: failing.consecutiveFailures,
    });

    try {
      const resource: AuditResource = { type: 'webhook', id: disabled.id };
      await appendAuditEvents(services.db, [
        createAuditBuilder({
          orgId: disabled.orgId,
          actorType: 'system',
          actorId: null,
          actorLabel: 'webhook delivery',
          ipAddress: null,
          userAgent: null,
          requestId: services.meta.requestId,
        }).success('webhook.disabled', resource, {
          endpointHost,
          eventTypes: disabled.eventTypes,
          reason: 'sustained delivery failure',
        }),
      ]);
    } catch (cause) {
      log.error('Could not file webhook.disabled for an endpoint switched off for failing', {
        orgId: disabled.orgId,
        webhookId: disabled.id,
        error: describeError(cause),
      });
    }

    await notifyAdministrators(services, failing, endpointHost);
  }
}

/**
 * The auto-disable notice, to each owner and admin. A missing mailer is an
 * `info` (a self-hoster may run without mail; the audit record stands), a
 * failed send an `error` per recipient; neither stops anything.
 */
async function notifyAdministrators(
  services: ServiceContext,
  failing: WebhookRecord,
  endpointHost: string,
): Promise<void> {
  const log = services.log.at('webhooks');
  try {
    const mailer = mailerFrom(services.env);
    if (mailer === null) {
      log.info('Mail is not configured, so nobody was emailed about a webhook switched off', {
        orgId: failing.orgId,
        webhookId: failing.id,
      });
      return;
    }

    const organization = await findOrganizationById(services.db, failing.orgId);
    if (organization === null) return;
    const recipients = await listAdministratorAddresses(
      services.db,
      failing.orgId,
      NOTICE_RECIPIENT_LIMIT,
    );

    // One at a time: this runs inside a delivery's connection slot.
    for (const recipient of recipients) {
      try {
        await mailer.send(
          webhookDisabledMail({
            to: recipient.email,
            toName: recipient.displayName,
            organizationName: organization.name,
            endpointHost,
            consecutiveFailures: failing.consecutiveFailures,
            failingSince: failing.failingSince,
            settingsUrl: `${publicOrigin(services.env)}/app/${organization.slug}/settings`,
          }),
        );
      } catch (cause) {
        log.error('Could not email an administrator about a webhook switched off', {
          orgId: failing.orgId,
          webhookId: failing.id,
          ...describeMailFailure(cause),
        });
      }
    }
  } catch (cause) {
    log.error('Could not notify the administrators about a webhook switched off', {
      orgId: failing.orgId,
      webhookId: failing.id,
      error: describeError(cause),
    });
  }
}

/**
 * One POST to one receiver. Classifies its own failures and never throws:
 * every outcome is a fixed category, a status code, or both.
 *
 * The URL is checked again here, not only when it was saved: the rules in
 * `checkWebhookUrl` can tighten between the two, and a row written before they
 * did must not be fetched under the old ones.
 */
async function send(url: string, id: string, body: string, secret: string): Promise<AttemptResult> {
  if (!checkWebhookUrl(url).valid)
    return { kind: 'failed', statusCode: null, error: 'invalid_url' };

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signWebhook({ secret, id, timestamp, body });

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      // Never followed: an allowed URL that redirects to a disallowed one is
      // the oldest way past an SSRF check, and the receiver can fix its URL.
      redirect: 'manual',
      signal: AbortSignal.timeout(WEBHOOK_DELIVERY_TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        'user-agent': WEBHOOK_USER_AGENT,
        'webhook-id': id,
        'webhook-timestamp': String(timestamp),
        'webhook-signature': signature,
      },
      body,
    });
  } catch (cause) {
    return { kind: 'failed', statusCode: null, error: isTimeout(cause) ? 'timeout' : 'network' };
  }

  // Released unread. Leaving it would hold the connection open until the
  // runtime collected it — one of four slots — and reading it would put text a
  // third party wrote somewhere it could end up displayed.
  await response.body?.cancel().catch(() => undefined);

  if (response.status >= 200 && response.status < 300) {
    return { kind: 'succeeded', statusCode: response.status };
  }
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    return {
      kind: 'failed',
      statusCode: response.status === 0 ? null : response.status,
      error: 'redirect',
    };
  }
  return { kind: 'failed', statusCode: response.status, error: `http_${response.status}` };
}

function isTimeout(cause: unknown): boolean {
  const name = (cause as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/**
 * Runs `work` over `items`, at most `limit` at a time. A failure in one item is
 * logged by the caller's `work` or swallowed here — never allowed to stop the
 * items after it, because one broken endpoint must not hold up another's
 * deliveries.
 */
async function inPool<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
  onError?: (cause: unknown) => void,
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next]!;
      next += 1;
      try {
        await work(item);
      } catch (cause) {
        try {
          onError?.(cause);
        } catch {
          // Reporting failed too; the next item still runs.
        }
      }
    }
  });
  await Promise.all(lanes);
}

/* ── the sweep and the test ──────────────────────────────────────────────── */

/**
 * The five-minute sweep: claims what is due — first attempts the inline budget
 * left, retries whose time has come, and claims a dead sender left behind — in
 * claims of {@link WEBHOOK_SWEEP_BATCH}, taken in turns across organisations
 * (`claimDueDeliveries`), and attempts them; then claims again, until nothing
 * is due or {@link WEBHOOK_SWEEP_BUDGET_MS} is spent. Answers how many were
 * attempted.
 *
 * What a claim holds past the budget is handed back unattempted
 * (`releaseDeliveries`), due as it was, rather than left claimed for the
 * stale-claim rule to find five minutes later.
 *
 * A delivery for an organisation whose plan no longer includes webhooks is
 * abandoned rather than sent: "paused" means nothing is delivered, and a
 * backlog that resumed the day an organisation upgraded again would be a
 * stream of stale events about changes long since superseded.
 */
export async function sweepWebhookDeliveries(
  services: ServiceContext,
  options: { budgetMs?: number } = {},
): Promise<number> {
  const deadline = Date.now() + (options.budgetMs ?? WEBHOOK_SWEEP_BUDGET_MS);
  const run = new DeliveryRun(services);
  let attempted = 0;

  while (Date.now() < deadline) {
    const claimed = await claimDueDeliveries(services.db, WEBHOOK_SWEEP_BATCH);
    if (claimed.length === 0) break;

    const unstarted: string[] = [];
    await inPool(
      claimed,
      WEBHOOK_DELIVERY_CONCURRENCY,
      async (entry) => {
        if (Date.now() >= deadline) {
          unstarted.push(entry.delivery.id);
          return;
        }
        if (!(await run.planIncludesWebhooks(entry.delivery.orgId))) {
          await abandonDelivery(
            services.db,
            entry.delivery.id,
            'paused: the plan no longer includes webhooks',
          );
          return;
        }
        // A test that was claimed and never finished is retried once, and not
        // again: nobody is waiting for its answer any more.
        await run.attempt(entry, { retries: entry.delivery.eventType !== WEBHOOK_TEST_EVENT });
        attempted += 1;
      },
      (cause) => {
        services.log
          .at('webhooks')
          .error('A scheduled webhook delivery failed to complete; the sweep takes it back later', {
            error: describeError(cause),
          });
      },
    );

    if (unstarted.length > 0) {
      await releaseDeliveries(services.db, unstarted);
      break;
    }
    // A short claim is everything that was due — or everything another sweep
    // running at once had not already locked. Either way, this one is done.
    if (claimed.length < WEBHOOK_SWEEP_BATCH) break;
  }
  return attempted;
}

/**
 * The dashboard's "send a test": one `webhook.test` delivery, queued and
 * attempted now, with the answer awaited. Tried once — a test that fails is the
 * answer the person asked for, not something to retry for two days.
 */
export async function sendTestDelivery(
  services: ServiceContext,
  webhook: WebhookRecord,
  data: WebhookEventData,
): Promise<DeliveryAttemptSummary> {
  const body = JSON.stringify(buildWebhookPayload(WEBHOOK_TEST_EVENT, new Date(), data));
  const [id] = await enqueueDeliveries(services.db, [
    { webhookId: webhook.id, orgId: webhook.orgId, eventType: WEBHOOK_TEST_EVENT, body },
  ]);
  const [claimed] = await claimDeliveries(services.db, [id!]);
  if (claimed === undefined) {
    return { id: id!, status: 'pending', lastStatusCode: null, lastError: null };
  }
  return new DeliveryRun(services).attempt(claimed, { retries: false });
}

/* ── the routes' shared gates ─────────────────────────────────────────────── */

/**
 * Webhooks are configured by people. A service token is a CI credential pinned
 * to one environment; an endpoint receives events from the whole organisation,
 * and its URL may carry the receiver's own credential — neither is anything a
 * build should be able to read or point somewhere else. Refused before the
 * organisation is resolved, so the answer is the same 403 whichever slug it
 * names.
 */
export function refuseServiceTokens(principal: Principal): void {
  if (principal.kind === 'serviceToken') {
    throw errors.forbidden('Webhooks are managed by a person, not a service token.');
  }
}

/** A path segment outside the UUID pattern names a webhook that cannot exist: 404, before any query. */
export function requireWebhookId(webhookId: string): void {
  if (!isUuid(webhookId)) throw errors.notFound('webhook id outside the permitted pattern');
}

/** The audit resource every webhook event is filed against. */
export function webhookResource(webhookId: string): AuditResource {
  return { type: 'webhook', id: webhookId };
}

/**
 * Refuses anything that would make an endpoint deliver while the plan allows
 * none — creating one, editing one, switching one back on, sending a test.
 * Switching one off and deleting one are never refused: taking a feature away
 * from yourself is always allowed. `refused` files the attempt first.
 */
export function refuseWhilePaused(entitlements: Entitlements, refused: () => void): void {
  if (entitlements.limits.webhooks !== 0) return;
  refused();
  requireCapacity(entitlements, 'webhooks', 0);
}

/* ── what the listing says about the plan ────────────────────────────────── */

export interface WebhookPlanStatus {
  limit: { max: number | null; used: number };
  /** The plan allows none: every endpoint is kept and nothing is delivered. */
  paused: boolean;
  /** The plan that would allow one more, when this one does not. */
  upgradeTo: PlanId | null;
}

/**
 * Read from the same `checkLimit` the create route refuses with, so the
 * listing's "upgrade to add more" and the create's refusal cannot disagree.
 */
export function webhookPlanStatus(entitlements: Entitlements, used: number): WebhookPlanStatus {
  const max = entitlements.limits.webhooks;
  const verdict = checkLimit(entitlements, 'webhooks', used);
  return {
    limit: { max, used },
    paused: max === 0,
    upgradeTo: verdict.kind === 'exceeded' ? verdict.upgradeTo : null,
  };
}

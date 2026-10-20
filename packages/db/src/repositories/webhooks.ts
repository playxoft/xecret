import {
  and,
  arrayContains,
  arrayOverlaps,
  asc,
  count,
  desc,
  eq,
  inArray,
  lt,
  or,
  sql,
} from 'drizzle-orm';
import type { WrappedOrgKey } from '@xecret/core/crypto';
import { uuidv7 } from '@xecret/core/ids';
import { orgKeys } from '../schema/keys';
import { webhookDeliveries, webhooks } from '../schema/paid-features';
import type { WebhookDeliveryStatus } from '../schema/paid-features';
import { toBytes, toCipherAlgorithm } from './environments';
import { RepositoryError } from './shared';
import type { Executor } from './shared';

/**
 * Webhook endpoints and their deliveries (P19 §5, migration 0028).
 *
 * ── The signing secret never leaves this file unsealed ──
 * It is stored as ciphertext under the organisation's master key, and the only
 * functions that return that ciphertext are the ones a *sender* needs: the two
 * `listEnabledWebhooksFor…` listings, `findWebhookWithSecret` and the claim
 * functions. The listing the dashboard reads (`listWebhooks`) selects no secret
 * column at all, so a response built from it cannot carry one by accident.
 * Opening it needs the org key row of the version it was sealed under
 * (`loadOrgKeyVersion`) and the Root KEK, which no database holds.
 *
 * ── At-least-once ──
 * A delivery is claimed (`pending` → `delivering`) by one sender at a time, and
 * a claim a sender never finished is taken back by the sweep after
 * `STALE_CLAIM_MS`. A sender that died *after* the receiver answered but
 * *before* recording it will therefore send that delivery again — which is the
 * duplicate the documentation tells receivers to expect, and why `webhook-id`
 * is stable across attempts.
 */

/** A claim older than this is a sender that died; the sweep takes it back. */
export const STALE_CLAIM_MS = 5 * 60_000;

export interface WebhookRecord {
  id: string;
  orgId: string;
  url: string;
  description: string | null;
  eventTypes: string[];
  enabled: boolean;
  disabledReason: 'manual' | 'failures' | null;
  disabledAt: Date | null;
  consecutiveFailures: number;
  failingSince: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The sealed signing secret, for a sender. */
export interface WebhookSecretMaterial {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  keyVersion: number;
}

export interface WebhookWithSecret extends WebhookRecord {
  secret: WebhookSecretMaterial;
}

const RECORD_COLUMNS = {
  id: webhooks.id,
  orgId: webhooks.orgId,
  url: webhooks.url,
  description: webhooks.description,
  eventTypes: webhooks.eventTypes,
  enabled: webhooks.enabled,
  disabledReason: webhooks.disabledReason,
  disabledAt: webhooks.disabledAt,
  consecutiveFailures: webhooks.consecutiveFailures,
  failingSince: webhooks.failingSince,
  lastSuccessAt: webhooks.lastSuccessAt,
  lastFailureAt: webhooks.lastFailureAt,
  createdBy: webhooks.createdBy,
  createdAt: webhooks.createdAt,
  updatedAt: webhooks.updatedAt,
};

const SECRET_COLUMNS = {
  secretCiphertext: webhooks.secretCiphertext,
  secretIv: webhooks.secretIv,
  secretKeyVersion: webhooks.secretKeyVersion,
};

function withSecret(
  row: WebhookRecord & {
    secretCiphertext: Uint8Array;
    secretIv: Uint8Array;
    secretKeyVersion: number;
  },
): WebhookWithSecret {
  const { secretCiphertext, secretIv, secretKeyVersion, ...record } = row;
  return {
    ...record,
    secret: { ciphertext: secretCiphertext, iv: secretIv, keyVersion: secretKeyVersion },
  };
}

export interface CreateWebhookParams {
  /** Supplied, because the secret's AAD names the webhook and is sealed before the insert. */
  id: string;
  orgId: string;
  url: string;
  description: string | null;
  eventTypes: string[];
  secret: WebhookSecretMaterial;
  createdBy: string | null;
}

export async function createWebhook(
  exec: Executor,
  params: CreateWebhookParams,
): Promise<WebhookRecord> {
  const [row] = await exec
    .insert(webhooks)
    .values({
      id: params.id,
      orgId: params.orgId,
      url: params.url,
      description: params.description,
      eventTypes: params.eventTypes,
      secretCiphertext: params.secret.ciphertext,
      secretIv: params.secret.iv,
      secretKeyVersion: params.secret.keyVersion,
      createdBy: params.createdBy,
    })
    .returning(RECORD_COLUMNS);
  if (!row) throw new RepositoryError('conflict', 'The webhook could not be created.');
  return row;
}

/** The organisation's endpoints — no secret column selected. */
export async function listWebhooks(exec: Executor, orgId: string): Promise<WebhookRecord[]> {
  return exec
    .select(RECORD_COLUMNS)
    .from(webhooks)
    .where(eq(webhooks.orgId, orgId))
    .orderBy(asc(webhooks.createdAt));
}

/** How many endpoints the organisation has, enabled or not — the plan's `webhooks` count. */
export async function countWebhooks(exec: Executor, orgId: string): Promise<number> {
  const [row] = await exec
    .select({ total: count() })
    .from(webhooks)
    .where(eq(webhooks.orgId, orgId));
  return row?.total ?? 0;
}

export async function findWebhook(
  exec: Executor,
  orgId: string,
  webhookId: string,
): Promise<WebhookRecord | null> {
  const [row] = await exec
    .select(RECORD_COLUMNS)
    .from(webhooks)
    .where(and(eq(webhooks.id, webhookId), eq(webhooks.orgId, orgId)))
    .limit(1);
  return row ?? null;
}

/** The same, with its sealed secret — for the test delivery a person asks for. */
export async function findWebhookWithSecret(
  exec: Executor,
  orgId: string,
  webhookId: string,
): Promise<WebhookWithSecret | null> {
  const [row] = await exec
    .select({ ...RECORD_COLUMNS, ...SECRET_COLUMNS })
    .from(webhooks)
    .where(and(eq(webhooks.id, webhookId), eq(webhooks.orgId, orgId)))
    .limit(1);
  return row === undefined ? null : withSecret(row);
}

export interface WebhookPatch {
  url?: string | undefined;
  description?: string | null | undefined;
  eventTypes?: string[] | undefined;
  /** `true` re-enables and clears the failure run; `false` disables as `manual`. */
  enabled?: boolean | undefined;
  secret?: WebhookSecretMaterial | undefined;
}

export async function updateWebhook(
  exec: Executor,
  orgId: string,
  webhookId: string,
  patch: WebhookPatch,
): Promise<WebhookRecord> {
  const set: Record<string, unknown> = { updatedAt: sql`now()` };
  if (patch.url !== undefined) set['url'] = patch.url;
  if (patch.description !== undefined) set['description'] = patch.description;
  if (patch.eventTypes !== undefined) set['eventTypes'] = patch.eventTypes;
  if (patch.secret !== undefined) {
    set['secretCiphertext'] = patch.secret.ciphertext;
    set['secretIv'] = patch.secret.iv;
    set['secretKeyVersion'] = patch.secret.keyVersion;
  }
  if (patch.enabled === true) {
    Object.assign(set, {
      enabled: true,
      disabledReason: null,
      disabledAt: null,
      consecutiveFailures: 0,
      failingSince: null,
    });
  } else if (patch.enabled === false) {
    Object.assign(set, { enabled: false, disabledReason: 'manual', disabledAt: sql`now()` });
  }

  const [row] = await exec
    .update(webhooks)
    .set(set)
    .where(and(eq(webhooks.id, webhookId), eq(webhooks.orgId, orgId)))
    .returning(RECORD_COLUMNS);
  if (!row) throw new RepositoryError('notFound', `Webhook ${webhookId} not found`);
  return row;
}

export async function deleteWebhook(
  exec: Executor,
  orgId: string,
  webhookId: string,
): Promise<WebhookRecord | null> {
  const [row] = await exec
    .delete(webhooks)
    .where(and(eq(webhooks.id, webhookId), eq(webhooks.orgId, orgId)))
    .returning(RECORD_COLUMNS);
  return row ?? null;
}

/**
 * The enabled endpoints subscribed to *any* of `eventTypes`, with their sealed
 * secrets — one query for a batch of events, whatever mix of types it holds.
 * Which event goes to which endpoint is the caller's to work out from each
 * row's `eventTypes`.
 */
export async function listEnabledWebhooksForEvents(
  exec: Executor,
  orgId: string,
  eventTypes: readonly string[],
): Promise<WebhookWithSecret[]> {
  if (eventTypes.length === 0) return [];
  const rows = await exec
    .select({ ...RECORD_COLUMNS, ...SECRET_COLUMNS })
    .from(webhooks)
    .where(
      and(
        eq(webhooks.orgId, orgId),
        eq(webhooks.enabled, true),
        arrayOverlaps(webhooks.eventTypes, [...new Set(eventTypes)]),
      ),
    );
  return rows.map(withSecret);
}

/* ── the org key a signing secret is sealed under ─────────────────────────── */

type OrgKeyRow = {
  version: number;
  wrappedKey: Uint8Array;
  wrapIv: Uint8Array;
  algorithm: string;
  rootKeyVersion: number;
};

const ORG_KEY_COLUMNS = {
  version: orgKeys.version,
  wrappedKey: orgKeys.wrappedKey,
  wrapIv: orgKeys.wrapIv,
  algorithm: orgKeys.algorithm,
  rootKeyVersion: orgKeys.rootKeyVersion,
};

function toWrappedOrgKey(row: OrgKeyRow): WrappedOrgKey {
  return {
    ciphertext: toBytes(row.wrappedKey),
    iv: toBytes(row.wrapIv),
    algorithm: toCipherAlgorithm(row.algorithm),
    version: row.version,
    rootKeyVersion: row.rootKeyVersion,
  };
}

/**
 * The organisation's current master key, for sealing a new signing secret.
 *
 * Newest active version, like the environment repository's own lookup — an
 * interrupted org-key rotation leaves two active rows, and sealing under the
 * newer is what keeps working while an operator finishes it. The version is
 * recorded on the webhook row, so the secret is always opened with the key
 * that sealed it, whatever happens to "current" afterwards.
 */
export async function loadOrgKeyForSealing(
  exec: Executor,
  orgId: string,
): Promise<WrappedOrgKey | null> {
  const [row] = await exec
    .select(ORG_KEY_COLUMNS)
    .from(orgKeys)
    .where(and(eq(orgKeys.orgId, orgId), eq(orgKeys.status, 'active')))
    .orderBy(desc(orgKeys.version))
    .limit(1);
  return row === undefined ? null : toWrappedOrgKey(row);
}

/**
 * One version of the organisation's master key, for opening a signing secret
 * sealed under it.
 *
 * Deliberately not filtered by status, for the reason `loadEnvironmentKeyChain`
 * gives: a key retired by a rotation still protects every row sealed before
 * the rotation re-sealed it.
 */
export async function loadOrgKeyVersion(
  exec: Executor,
  orgId: string,
  version: number,
): Promise<WrappedOrgKey | null> {
  const [row] = await exec
    .select(ORG_KEY_COLUMNS)
    .from(orgKeys)
    .where(and(eq(orgKeys.orgId, orgId), eq(orgKeys.version, version)))
    .limit(1);
  return row === undefined ? null : toWrappedOrgKey(row);
}

/** The enabled endpoints subscribed to `eventType`, with their sealed secrets. */
export async function listEnabledWebhooksForEvent(
  exec: Executor,
  orgId: string,
  eventType: string,
): Promise<WebhookWithSecret[]> {
  const rows = await exec
    .select({ ...RECORD_COLUMNS, ...SECRET_COLUMNS })
    .from(webhooks)
    .where(
      and(
        eq(webhooks.orgId, orgId),
        eq(webhooks.enabled, true),
        arrayContains(webhooks.eventTypes, [eventType]),
      ),
    );
  return rows.map(withSecret);
}

export interface DeliveryRecord {
  id: string;
  webhookId: string;
  orgId: string;
  eventType: string;
  body: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  nextAttemptAt: Date | null;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

const DELIVERY_COLUMNS = {
  id: webhookDeliveries.id,
  webhookId: webhookDeliveries.webhookId,
  orgId: webhookDeliveries.orgId,
  eventType: webhookDeliveries.eventType,
  body: webhookDeliveries.body,
  status: webhookDeliveries.status,
  attempts: webhookDeliveries.attempts,
  nextAttemptAt: webhookDeliveries.nextAttemptAt,
  lastStatusCode: webhookDeliveries.lastStatusCode,
  lastError: webhookDeliveries.lastError,
  createdAt: webhookDeliveries.createdAt,
  completedAt: webhookDeliveries.completedAt,
};

/**
 * How many deliveries one `INSERT` carries. Each row binds six parameters, and
 * the wire protocol's parameter count is sixteen bits — 65,535 for PostgreSQL
 * itself, but 32,767 for drivers that read it as signed, PGlite among them — so
 * a batch past this is split, keeping every statement under the smaller bound.
 * A bulk import into an organisation with many endpoints is the one caller that
 * gets near it; below it, a batch is one statement whatever its size.
 */
export const ENQUEUE_CHUNK = 5_000;

/** Queues one delivery per endpoint, due now. Answers the deliveries' ids, in order. */
export async function enqueueDeliveries(
  exec: Executor,
  deliveries: readonly { webhookId: string; orgId: string; eventType: string; body: string }[],
): Promise<string[]> {
  if (deliveries.length === 0) return [];
  const rows = deliveries.map((delivery) => ({ id: uuidv7(), ...delivery }));
  for (let start = 0; start < rows.length; start += ENQUEUE_CHUNK) {
    await exec.insert(webhookDeliveries).values(
      rows.slice(start, start + ENQUEUE_CHUNK).map((row) => ({
        id: row.id,
        webhookId: row.webhookId,
        orgId: row.orgId,
        eventType: row.eventType,
        body: row.body,
        status: 'pending' as const,
        nextAttemptAt: sql`now()`,
      })),
    );
  }
  return rows.map((row) => row.id);
}

/** A claimed delivery and everything sending it needs. */
export interface ClaimedDelivery {
  delivery: DeliveryRecord;
  webhook: WebhookWithSecret;
}

async function attachWebhooks(
  exec: Executor,
  deliveries: DeliveryRecord[],
): Promise<ClaimedDelivery[]> {
  if (deliveries.length === 0) return [];
  const ids = [...new Set(deliveries.map((delivery) => delivery.webhookId))];
  const hooks = await exec
    .select({ ...RECORD_COLUMNS, ...SECRET_COLUMNS })
    .from(webhooks)
    .where(inArray(webhooks.id, ids));
  const byId = new Map(hooks.map((hook) => [hook.id, withSecret(hook)]));
  return deliveries.flatMap((delivery) => {
    const webhook = byId.get(delivery.webhookId);
    return webhook === undefined ? [] : [{ delivery, webhook }];
  });
}

/**
 * Claims specific pending deliveries — the first attempt, made right after the
 * write that caused them. A delivery another sender already claimed is not in
 * the answer.
 */
export async function claimDeliveries(
  exec: Executor,
  deliveryIds: readonly string[],
): Promise<ClaimedDelivery[]> {
  if (deliveryIds.length === 0) return [];
  const claimed = await exec
    .update(webhookDeliveries)
    .set({ status: 'delivering', claimedAt: sql`now()` })
    .where(
      and(inArray(webhookDeliveries.id, [...deliveryIds]), eq(webhookDeliveries.status, 'pending')),
    )
    .returning(DELIVERY_COLUMNS);
  return attachWebhooks(exec, claimed);
}

/**
 * Claims up to `limit` deliveries that are due — pending and past their
 * `next_attempt_at` — or that a sender claimed and never finished.
 *
 * `FOR UPDATE SKIP LOCKED` in the subquery, so two sweeps running at once take
 * disjoint sets rather than racing for the same rows.
 */
export async function claimDueDeliveries(
  exec: Executor,
  limit: number,
): Promise<ClaimedDelivery[]> {
  const staleBefore = new Date(Date.now() - STALE_CLAIM_MS);
  const claimed = await exec
    .update(webhookDeliveries)
    .set({ status: 'delivering', claimedAt: sql`now()` })
    .where(
      inArray(
        webhookDeliveries.id,
        sql`(
          select ${webhookDeliveries.id} from ${webhookDeliveries}
          where (${webhookDeliveries.status} = 'pending' and ${webhookDeliveries.nextAttemptAt} <= now())
             or (${webhookDeliveries.status} = 'delivering' and ${webhookDeliveries.claimedAt} < ${staleBefore})
          order by ${webhookDeliveries.nextAttemptAt} asc nulls first
          limit ${limit}
          for update skip locked
        )`,
      ),
    )
    .returning(DELIVERY_COLUMNS);
  return attachWebhooks(exec, claimed);
}

export type DeliveryOutcome =
  | { kind: 'succeeded'; statusCode: number }
  | {
      kind: 'failed';
      statusCode: number | null;
      error: string;
      /** When to try again, or `null` to abandon it. */
      retryAt: Date | null;
    };

/**
 * Records how an attempt went, on the delivery and on its endpoint, in one
 * transaction. Answers the endpoint as it now stands, so the caller can decide
 * whether sustained failure has earned it an automatic disable.
 */
export async function recordDeliveryAttempt(
  exec: Executor,
  params: { deliveryId: string; webhookId: string; outcome: DeliveryOutcome },
): Promise<WebhookRecord | null> {
  return exec.transaction(async (tx) => {
    const { outcome } = params;
    if (outcome.kind === 'succeeded') {
      await tx
        .update(webhookDeliveries)
        .set({
          status: 'succeeded',
          attempts: sql`${webhookDeliveries.attempts} + 1`,
          lastStatusCode: outcome.statusCode,
          lastError: null,
          nextAttemptAt: null,
          claimedAt: null,
          completedAt: sql`now()`,
        })
        .where(eq(webhookDeliveries.id, params.deliveryId));

      const [hook] = await tx
        .update(webhooks)
        .set({ consecutiveFailures: 0, failingSince: null, lastSuccessAt: sql`now()` })
        .where(eq(webhooks.id, params.webhookId))
        .returning(RECORD_COLUMNS);
      return hook ?? null;
    }

    await tx
      .update(webhookDeliveries)
      .set({
        status: outcome.retryAt === null ? 'abandoned' : 'pending',
        attempts: sql`${webhookDeliveries.attempts} + 1`,
        lastStatusCode: outcome.statusCode,
        lastError: outcome.error.slice(0, 200),
        nextAttemptAt: outcome.retryAt,
        claimedAt: null,
        completedAt: outcome.retryAt === null ? sql`now()` : null,
      })
      .where(eq(webhookDeliveries.id, params.deliveryId));

    const [hook] = await tx
      .update(webhooks)
      .set({
        consecutiveFailures: sql`${webhooks.consecutiveFailures} + 1`,
        failingSince: sql`coalesce(${webhooks.failingSince}, now())`,
        lastFailureAt: sql`now()`,
      })
      .where(eq(webhooks.id, params.webhookId))
      .returning(RECORD_COLUMNS);
    return hook ?? null;
  });
}

/**
 * Gives up a claimed delivery without attempting it — its endpoint was switched
 * off after the delivery was queued, or the organisation's plan no longer
 * includes webhooks. Not an attempt, so nothing is counted against the
 * endpoint: a delivery that was never sent cannot have failed. `reason` is a
 * fixed sentence from the caller, never anything a receiver said.
 */
export async function abandonDelivery(
  exec: Executor,
  deliveryId: string,
  reason: string,
): Promise<void> {
  await exec
    .update(webhookDeliveries)
    .set({
      status: 'abandoned',
      lastError: reason.slice(0, 200),
      nextAttemptAt: null,
      claimedAt: null,
      completedAt: sql`now()`,
    })
    .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.status, 'delivering')));
}

/**
 * Switches an endpoint off for sustained failure, and abandons what it still
 * owes. Answers `null` when it was already off — so the email and the audit
 * record are sent once, by whichever sender got here first.
 */
export async function disableWebhookForFailures(
  exec: Executor,
  webhookId: string,
): Promise<WebhookRecord | null> {
  return exec.transaction(async (tx) => {
    const [hook] = await tx
      .update(webhooks)
      .set({
        enabled: false,
        disabledReason: 'failures',
        disabledAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(webhooks.id, webhookId), eq(webhooks.enabled, true)))
      .returning(RECORD_COLUMNS);
    if (!hook) return null;

    await tx
      .update(webhookDeliveries)
      .set({
        status: 'abandoned',
        lastError: 'endpoint disabled after sustained failure',
        nextAttemptAt: null,
        claimedAt: null,
        completedAt: sql`now()`,
      })
      .where(
        and(eq(webhookDeliveries.webhookId, webhookId), eq(webhookDeliveries.status, 'pending')),
      );
    return hook;
  });
}

/** The delivery log for one endpoint, newest first. */
export async function listDeliveries(
  exec: Executor,
  orgId: string,
  webhookId: string,
  limit: number,
): Promise<DeliveryRecord[]> {
  return exec
    .select(DELIVERY_COLUMNS)
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.webhookId, webhookId), eq(webhookDeliveries.orgId, orgId)))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
}

/** Deletes finished deliveries older than `before`. The log is a log, not an archive. */
export async function pruneWebhookDeliveries(exec: Executor, before: Date): Promise<number> {
  const rows = await exec
    .delete(webhookDeliveries)
    .where(
      and(
        lt(webhookDeliveries.createdAt, before),
        or(eq(webhookDeliveries.status, 'succeeded'), eq(webhookDeliveries.status, 'abandoned')),
      ),
    )
    .returning({ id: webhookDeliveries.id });
  return rows.length;
}

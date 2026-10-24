import type { WebhookEventData, WebhookEventType } from '@xecret/core/webhooks';
import type { Principal } from './actor';
import type { ServiceContext } from './context';
import { emitWebhookEvents, webhookActorOf } from './webhooks-service';
import type { WebhookEvent } from './webhooks-service';
import type { EnvironmentScope } from './tenancy';

/**
 * The webhook events a write produces (P19 §5), built once so every route that
 * changes a secret says it the same way: the organisation, the project, the
 * environment, the secret's name and the version now current, and who did it.
 * Never a value — `WebhookEventData` has no field one could go in.
 *
 * Emission is after the response and never fails the write it describes; see
 * `emitWebhookEvents`.
 */

export interface SecretChange {
  type: Extract<WebhookEventType, `secret.${string}`>;
  name: string;
  version?: number | undefined;
}

function base(scope: EnvironmentScope, principal: Principal) {
  return {
    organization: { id: scope.organization.id, slug: scope.organization.slug },
    project: { id: scope.project.id, slug: scope.project.slug },
    environment: { id: scope.environment.id, slug: scope.environment.slug },
    actor: webhookActorOf(principal),
  } satisfies WebhookEventData;
}

const COUNT_KEY = {
  'secret.created': 'created',
  'secret.updated': 'updated',
  'secret.deleted': 'deleted',
  'secret.rotated': 'updated',
} as const satisfies Record<SecretChange['type'], 'created' | 'updated' | 'deleted'>;

function secretRef(change: SecretChange): { name: string; version?: number } {
  return {
    name: change.name,
    ...(change.version === undefined ? {} : { version: change.version }),
  };
}

/**
 * The events one write's secret changes become: **one per kind of change**,
 * not one per secret (review round 1, M4).
 *
 * A kind with a single secret is the event a single write has always sent —
 * `data.secret`. A kind with several — an import that created four hundred, a
 * promotion that updated thirty — is one event listing them all in
 * `data.secrets`, with `data.counts` saying how many. So an import into an
 * organisation with three endpoints queues at most three deliveries per
 * endpoint (created, updated, deleted), whatever its size, where it used to
 * queue one per secret per endpoint: a thousand-line import was three thousand
 * deliveries, which one sweep of twenty-five took two days to send and which
 * held every other organisation's deliveries behind them.
 *
 * Why not one event for the whole write: an endpoint subscribes by kind, and a
 * single mixed event would either reach an endpoint that asked only for
 * deletions with the creations in it, or need a type nobody subscribed to.
 */
function secretEvents(
  scope: EnvironmentScope,
  principal: Principal,
  changes: readonly SecretChange[],
): WebhookEvent[] {
  const shared = base(scope, principal);
  const byType = new Map<SecretChange['type'], SecretChange[]>();
  for (const change of changes) {
    const group = byType.get(change.type);
    if (group === undefined) byType.set(change.type, [change]);
    else group.push(change);
  }

  return [...byType].map(([type, group]) => ({
    orgId: scope.organization.id,
    type,
    data:
      group.length === 1
        ? { ...shared, secret: secretRef(group[0]!) }
        : {
            ...shared,
            secrets: group.map(secretRef),
            counts: { [COUNT_KEY[type]]: group.length },
          },
  }));
}

/** The secret events of a batch write: what it created or changed, and what it removed. */
export function batchChanges(
  results: readonly {
    status: 'created' | 'updated' | 'unchanged';
    name: string;
    version: number;
  }[],
  removed: readonly { name: string }[],
): SecretChange[] {
  return [
    ...results
      .filter((result) => result.status !== 'unchanged')
      .map((result) => ({
        type:
          result.status === 'created' ? ('secret.created' as const) : ('secret.updated' as const),
        name: result.name,
        version: result.version,
      })),
    ...removed.map((secret) => ({ type: 'secret.deleted' as const, name: secret.name })),
  ];
}

/** The events of a write's secret changes — one per kind of change; see `secretEvents`. */
export function emitSecretChanges(
  services: ServiceContext,
  scope: EnvironmentScope,
  principal: Principal,
  changes: readonly SecretChange[],
): void {
  if (changes.length === 0) return;
  emitWebhookEvents(services, scope.entitlements, secretEvents(scope, principal, changes));
}

/**
 * A change to the environment as a whole — a promotion, a restore — and the
 * secret events beneath it, in one batch: subscribers to `secret.updated` hear
 * once about every value a promotion changed, and subscribers to
 * `environment.promoted` hear about the promotion once.
 */
export function emitEnvironmentChange(
  services: ServiceContext,
  scope: EnvironmentScope,
  principal: Principal,
  event: {
    type: Extract<WebhookEventType, 'environment.promoted' | 'environment.restored'>;
    source?: { id: string; slug: string } | undefined;
    counts: { created: number; updated: number; deleted: number; unchanged: number };
    restoredTo?: string | undefined;
  },
  changes: readonly SecretChange[],
): void {
  emitWebhookEvents(services, scope.entitlements, [
    {
      orgId: scope.organization.id,
      type: event.type,
      data: {
        ...base(scope, principal),
        counts: event.counts,
        ...(event.source === undefined ? {} : { source: event.source }),
        ...(event.restoredTo === undefined ? {} : { restoredTo: event.restoredTo }),
      },
    },
    ...secretEvents(scope, principal, changes),
  ]);
}

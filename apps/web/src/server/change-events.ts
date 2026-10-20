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

function secretEvents(
  scope: EnvironmentScope,
  principal: Principal,
  changes: readonly SecretChange[],
): WebhookEvent[] {
  const shared = base(scope, principal);
  return changes.map((change) => ({
    orgId: scope.organization.id,
    type: change.type,
    data: {
      ...shared,
      secret: {
        name: change.name,
        ...(change.version === undefined ? {} : { version: change.version }),
      },
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

/** One event per secret a write changed. */
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
 * about a value a promotion changed, and subscribers to `environment.promoted`
 * hear about the promotion once.
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

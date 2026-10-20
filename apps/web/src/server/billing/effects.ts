import { createAuditBuilder } from '@xecret/core/audit';
import type { AuditBuilder, AuditRecord, AuditResource } from '@xecret/core/audit';
import type { ServiceContext } from '../context';
import { describeError } from '../logging';
import type { LogFields } from '../logging';
import type { BillingReminder } from './mail';
import { sendBillingReminder } from './reminders';

/**
 * What a billing change does *after* it commits — and the audit identity of
 * the things that make billing changes without a person behind them.
 *
 * ── Why effects are deferred ──
 * A webhook handler runs inside the transaction that claims the delivery, and
 * an email sent from inside it would be sent for a change that might still
 * roll back. So handlers return effects; the webhook runs them once the
 * transaction has committed, from `waitUntil`, after the response — Dodo
 * counts a delivery failed after fifteen seconds, and a mail provider is not
 * allowed to spend them.
 *
 * Alerts are effects for the same reason: "a dispute was opened" logged for a
 * delivery that then rolled back and was retried would be logged twice, and an
 * alert that fires twice for one dispute teaches people to ignore it.
 */

export type BillingEffect =
  | { kind: 'mail'; orgId: string; occasion: string; reminder: BillingReminder }
  /** An error-level line a human acts on: drift, a dispute, a mismatch. */
  | { kind: 'alert'; message: string; fields: LogFields };

/** What a handler hands back: records written with its change, and work for after it. */
export interface HandlerOutcome {
  audit: AuditRecord[];
  effects: BillingEffect[];
}

export const noOutcome = (): HandlerOutcome => ({ audit: [], effects: [] });

export async function runBillingEffects(
  services: ServiceContext,
  effects: readonly BillingEffect[],
): Promise<void> {
  const log = services.log.at('billing');
  for (const effect of effects) {
    if (effect.kind === 'alert') {
      log.error(effect.message, effect.fields);
      continue;
    }
    try {
      await sendBillingReminder(services, {
        orgId: effect.orgId,
        occasion: effect.occasion,
        reminder: effect.reminder,
      });
    } catch (cause) {
      log.warn(`Could not send the ${effect.reminder.kind} billing email`, {
        orgId: effect.orgId,
        error: describeError(cause),
      });
    }
  }
}

/** Every billing record is about the organisation's subscription, by organisation id. */
export function subscriptionResource(orgId: string): AuditResource {
  // The row's primary key, never a provider identifier: those stay out of the
  // audit log entirely.
  return { type: 'subscription', id: orgId };
}

/**
 * The audit identity of a billing change nobody in the organisation made: a
 * `system` actor labelled by what it was — the payment webhook, the seat sync,
 * the reconciler. No `operator`, which is what distinguishes these from the
 * operator tool's `plan.changed` (see `AuditMetadata.operator`).
 */
export function systemAudit(
  services: Pick<ServiceContext, 'meta'>,
  orgId: string,
  label: 'Dodo webhook' | 'seat sync' | 'billing job' | 'billing reconciler',
): AuditBuilder {
  return createAuditBuilder({
    orgId,
    actorType: 'system',
    actorId: null,
    actorLabel: label,
    ipAddress: services.meta.ipAddress,
    userAgent: services.meta.userAgent,
    requestId: services.meta.requestId,
  });
}

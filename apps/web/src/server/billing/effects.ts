import type { AuditRecord } from '@xecret/core/audit';
import type { ServiceContext } from '../context';
import { describeError } from '../logging';
import type { LogFields } from '../logging';
import type { BillingReminder } from './mail';
import { sendBillingReminder } from './reminders';
import { syncSeats } from './seats';

/**
 * What a billing change does *after* it commits.
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
  | { kind: 'alert'; message: string; fields: LogFields }
  /**
   * Push the seat count — after an activation, whose checkout quantity may be
   * older than the membership by the time the payment lands.
   */
  | { kind: 'seat-sync'; orgId: string };

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
    switch (effect.kind) {
      case 'alert':
        log.error(effect.message, effect.fields);
        break;
      case 'seat-sync':
        // Never throws: a failed push is recorded as a debt for the hourly job.
        await syncSeats(services, effect.orgId);
        break;
      case 'mail':
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
        break;
    }
  }
}

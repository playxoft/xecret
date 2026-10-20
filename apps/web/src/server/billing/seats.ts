import { appendAuditEvents } from '@xecret/db/repositories';
import {
  completeSeatSync,
  failSeatSync,
  findSubscription,
  queueSeatSync,
  seatedMemberCount,
  writeSubscriptionState,
} from '@xecret/db/repositories';
import type { Executor, SubscriptionRecord } from '@xecret/db/repositories';
import { providerSeats, resolvePlanId } from '@xecret/core/entitlements';
import type { ServiceContext } from '../context';
import { errors } from '../errors';
import { describeError } from '../logging';
import { billingProvider, DodoApiError } from './client';
import { billingSetup } from './config';
import { subscriptionResource, systemAudit } from './audit';

/**
 * Seat sync (P12): the membership changes, and the seat count Dodo bills
 * follows it.
 *
 * ── After the transaction, never inside it ──
 * Every membership change — an invitation accepted, a just-in-time join, a
 * member removed, an account deleted, a suspension or a reinstatement —
 * commits first, under the organisation's row lock, exactly as it did before
 * billing existed. Only then is the new count pushed, from `waitUntil`, off the
 * response. A payment API call inside a transaction holding the organisation
 * lock would be a deadlock waiting for a network timeout; and a membership
 * change is never rolled back because Dodo was slow — the push is retried
 * instead.
 *
 * ── What is counted ──
 * `providerSeats`: every seated member whatever their status — suspension is a
 * security act, never a discount, so suspending and reinstating leave the bill
 * where it was — floored at the plan's minimum. A pending invitation is not
 * billed until it is accepted.
 *
 * ── How it cannot drift silently ──
 *  1. A debt is written to `billing_seat_syncs` *before* the push, so a push
 *     that fails, times out or dies with the isolate is collected by the
 *     hourly job (`jobs.ts`), which always pushes the count as it is then.
 *  2. After a push lands the count is read again, and pushed again if it moved
 *     in the meantime — two members joining a second apart converge on the
 *     second count whichever push Dodo saw last.
 *  3. The nightly reconciler compares our seats with Dodo's quantity and
 *     alerts on any difference no pending debt explains.
 *
 * ── How it is charged ──
 * `difference_immediately`: the difference for the rest of the period is
 * charged when somebody joins and credited when somebody leaves — the least
 * surprising behaviour, and the easiest to read on an invoice (01-billing
 * §P12). `apply_change` on a failed charge: the person has already joined, so
 * the subscription says so, and an unpaid difference is a dunning matter.
 */

/** Pushes after a push, if the count kept moving. Then the hourly job takes over. */
const MAX_PUSHES = 3;

export type SeatSyncOutcome =
  /** Payments are off on this deployment. */
  | 'off'
  /** No subscription Dodo bills — Free, or an operator's grant. Nothing to push. */
  | 'not-billed'
  /** Dodo already bills the right number. */
  | 'in-sync'
  /** Pushed. */
  | 'synced'
  /** Dodo refused or could not be reached; the debt stays for the hourly job. */
  | 'failed';

type SeatServices = Pick<ServiceContext, 'env' | 'db' | 'log' | 'meta'>;

/** Whether a subscription is one Dodo bills seats on right now. */
function billable(row: SubscriptionRecord | null): row is SubscriptionRecord & {
  dodoSubscriptionId: string;
  dodoProductId: string;
} {
  return (
    row !== null &&
    row.plan !== 'free' &&
    row.dodoSubscriptionId !== null &&
    row.dodoProductId !== null &&
    (row.status === 'active' ||
      row.status === 'trialing' ||
      row.status === 'past_due' ||
      row.status === 'on_hold')
  );
}

/**
 * Pushes the organisation's seat count to Dodo if it differs from what is
 * billed. Never throws: every failure is recorded as a debt and logged.
 */
export async function syncSeats(services: SeatServices, orgId: string): Promise<SeatSyncOutcome> {
  const log = services.log.at('syncSeats');

  let setup: ReturnType<typeof billingSetup>;
  try {
    setup = billingSetup(services.env);
  } catch (cause) {
    // Half-configured: nothing can be pushed, and the debt waits for the fix.
    await queueSeatSync(services.db, orgId);
    log.error('Billing is misconfigured, so a seat change was queued rather than pushed', {
      orgId,
      error: describeError(cause),
    });
    return 'failed';
  }
  if (setup.state === 'disabled') return 'off';
  const provider = billingProvider(setup.config);

  let outcome: SeatSyncOutcome = 'in-sync';
  for (let push = 0; push < MAX_PUSHES; push += 1) {
    const row = await findSubscription(services.db, orgId);
    if (!billable(row)) {
      // Nothing billed, so nothing owed: an old debt for it is cleared.
      await completeSeatSync(services.db, orgId, new Date());
      return outcome === 'synced' ? 'synced' : 'not-billed';
    }

    const plan = resolvePlanId(row.plan);
    const seats = providerSeats(plan, await seatedMemberCount(services.db, orgId));
    if (seats.billed === row.seats) {
      await completeSeatSync(services.db, orgId, new Date());
      return outcome;
    }

    // The debt first, so a push that never returns is still owed.
    await queueSeatSync(services.db, orgId);
    const startedAt = new Date();
    try {
      await provider.changePlan(row.dodoSubscriptionId, {
        productId: row.dodoProductId,
        quantity: seats.billed,
        proration: 'difference_immediately',
        effectiveAt: 'immediately',
        onPaymentFailure: 'apply_change',
      });
    } catch (cause) {
      const category = cause instanceof DodoApiError ? cause.category : 'unexpected';
      await failSeatSync(services.db, orgId, category);
      await appendAuditEvents(services.db, [
        systemAudit(services, orgId, 'seat sync').error(
          'billing.seats_synced',
          subscriptionResource(orgId),
          'upstreamUnavailable',
          { seatCount: seats.billed, previousSeatCount: row.seats },
        ),
      ]);
      log.warn('Could not push a seat change to Dodo; the hourly job will retry it', {
        orgId,
        category,
        ...(cause instanceof DodoApiError ? {} : { error: describeError(cause) }),
      });
      return 'failed';
    }

    await services.db.transaction(async (tx) => {
      await writeSubscriptionState(tx, orgId, {}, seats);
      await completeSeatSync(tx, orgId, startedAt);
      await appendAuditEvents(tx, [
        systemAudit(services, orgId, 'seat sync').success(
          'billing.seats_synced',
          subscriptionResource(orgId),
          { seatCount: seats.billed, previousSeatCount: row.seats },
        ),
      ]);
    });
    log.info(`Pushed the seat count to Dodo: ${row.seats} → ${seats.billed}`, {
      orgId,
      seatCount: seats.billed,
    });
    outcome = 'synced';
  }
  return outcome;
}

/**
 * Queues a seat sync to run after the response — the hook every membership
 * change calls once its own transaction has committed.
 */
export function scheduleSeatSync(
  services: ServiceContext,
  orgIds: string | readonly string[],
): void {
  for (const orgId of typeof orgIds === 'string' ? [orgIds] : orgIds) {
    services.waitUntil(
      syncSeats(services, orgId).catch((cause: unknown) => {
        services.log.at('scheduleSeatSync').error('A seat sync failed unexpectedly', {
          orgId,
          error: describeError(cause),
        });
      }),
    );
  }
}

/**
 * Refuses to delete an organisation Dodo is still billing.
 *
 * A soft-deleted organisation stops answering for everybody, and nothing about
 * that tells Dodo: the subscription would renew, every month, for an
 * organisation nobody can open. So it is cancelled first — from Billing →
 * Manage billing — and the deletion is allowed once the subscription is set to
 * end. Nothing is refused for a Free organisation or an operator's grant.
 */
export async function assertNotStillBilled(exec: Executor, orgId: string): Promise<void> {
  const row = await findSubscription(exec, orgId);
  if (row === null) return;
  if (row.plan === 'free' || row.dodoSubscriptionId === null || row.cancelAtPeriodEnd) return;
  throw errors.conflict(
    'This organisation still has an active subscription, which would keep renewing after it ' +
      'is deleted. Cancel it first from Billing → Manage billing, then delete the ' +
      'organisation. Nothing was deleted.',
  );
}

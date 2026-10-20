import { appendAuditEvents } from '@xecret/db/repositories';
import {
  claimSeatSync,
  clearSeatSync,
  completeSeatSync,
  deadLetterSeatSync,
  deferSeatSync,
  ensureSeatSync,
  failSeatSync,
  findSubscription,
  releaseSeatSync,
  SEAT_SYNC_MAX_ATTEMPTS,
  seatSyncGeneration,
  seatedMemberCount,
  writeSubscriptionState,
} from '@xecret/db/repositories';
import type { Executor, SubscriptionRecord } from '@xecret/db/repositories';
import { providerSeats, resolvePlanId } from '@xecret/core/entitlements';
import type { ServiceContext } from '../context';
import { errors } from '../errors';
import { describeError } from '../logging';
import { billingProvider, DODO_TIMEOUT_MS, DodoApiError } from './client';
import type { BillingProvider } from './client';
import { billingSetup } from './config';
import type { DodoMode } from './config';
import { subscriptionResource, systemAudit } from './audit';
import { sendBillingReminder } from './reminders';

/**
 * Seat sync (P12): the membership changes, and the seat count Dodo bills
 * follows it.
 *
 * ── The debt commits with the membership; the push comes after ──
 * Every membership change that moves a seat — an invitation accepted, a
 * just-in-time join, a member removed, an account deleted — writes the seat
 * debt to `billing_seat_syncs` **inside its own transaction**, under the
 * organisation's row lock (`queueBilledSeatSync`, called by `addMember` and
 * `removeMember`). The push to Dodo comes only after the commit, from
 * `waitUntil`, off the response: a payment API call inside a transaction
 * holding the organisation lock would be a deadlock waiting for a network
 * timeout, and a membership change is never rolled back because Dodo was slow.
 * So a push that fails, times out, dies with the isolate — or never starts,
 * because the isolate went before `waitUntil` ran it — leaves a debt the hourly
 * job (`jobs.ts`) collects.
 *
 * ── One push at a time, and never a stale count last ──
 * A push first takes the organisation's lease (`claimSeatSync`); a second push
 * that finds it held leaves the work to the holder. The holder counts under the
 * debt's *generation*, which every membership change bumps, and clears the
 * debt only if the generation is still the one it counted under
 * (`completeSeatSync`). A member who joins while a push for the previous count
 * is at Dodo bumps it, so the holder counts again and pushes again — the last
 * quantity Dodo sees is the membership's, whichever request got there first.
 *
 * ── What is counted ──
 * `providerSeats`: every seated member whatever their status — suspension is a
 * security act, never a discount, so suspending and reinstating leave the bill
 * where it was — floored at the plan's minimum. A pending invitation is not
 * billed until it is accepted.
 *
 * ── A plan change Dodo has scheduled ──
 * A downgrade waits for the end of the period (`effective_at:
 * next_billing_date`), and Dodo then refuses any other plan change — a seat
 * push included — with a 409 until it lands, unless the request replaces the
 * scheduled change (`cancel_scheduled_change_plan`), which would silently undo
 * the owner's downgrade. So while one is scheduled
 * (`dodo_scheduled_change_at`, from the subscription's `scheduled_change`) the
 * push is not attempted: the debt is put off until an hour after the change
 * takes effect, and the hourly job pushes the count as it is then. Dodo is
 * asked first whether the change is still scheduled — an owner can withdraw
 * it in the portal — and a change gone at Dodo is forgotten and the push
 * made; a 409 for one our row never heard of waits for the date Dodo gives.
 * https://docs.dodopayments.com/api-reference/subscriptions/change-plan
 *
 * ── A push Dodo refuses as no change ──
 * Refused, and Dodo already bills that quantity of that product: the debt is
 * paid, not failed — our row takes Dodo's count, and nothing is retried.
 *
 * ── How it is charged ──
 * `prorated_immediately_keep_cycle`: the difference for the rest of the period
 * is charged when somebody joins, and credited — as credit on the
 * subscription, applied to its renewals — when somebody leaves (01-billing
 * §P12), with the period and the renewal date left where they were. (Dodo's
 * `difference_immediately`, which the plan named, resets the billing cycle to
 * the day of every change; see `PlanChange.proration`.) `apply_change` on a
 * failed charge: the person has already joined, so the subscription says so,
 * and an unpaid difference is a dunning matter.
 *
 * ── The owners are told ──
 * Once a push lands, the owners get the "now billed for N seats" email, once
 * per push (`billing_reminders`).
 *
 * ── How it cannot drift silently ──
 * Debts are retried with backoff and given up on — raised once, for a human —
 * after {@link SEAT_SYNC_MAX_ATTEMPTS} failures; and the nightly reconciler
 * compares Dodo's quantity with the membership itself (`reconcile.ts`).
 */

/** Pushes after a push, if the count kept moving. Then the hourly job takes over. */
const MAX_PUSHES = 3;

/** How long one sync may hold the organisation's lease: every push it may make, and then some. */
export const SEAT_PUSH_LEASE_MS = MAX_PUSHES * (DODO_TIMEOUT_MS + 5_000) + 15_000;

/** How long after a scheduled plan change takes effect the push waits for Dodo's own event. */
export const SCHEDULED_CHANGE_GRACE_MS = 60 * 60 * 1000;

export type SeatSyncOutcome =
  /** Payments are off on this deployment. */
  | 'off'
  /** No subscription Dodo bills — Free, an operator's grant, or the other Dodo mode. */
  | 'not-billed'
  /** Dodo already bills the right number. */
  | 'in-sync'
  /** Pushed. */
  | 'synced'
  /** Another push for this organisation is in flight; it counts again before it lets go. */
  | 'busy'
  /** A plan change Dodo has scheduled is in the way; the debt waits for it. */
  | 'deferred'
  /** Dodo refused or could not be reached; the debt stays for the hourly job. */
  | 'failed';

type SeatServices = Pick<ServiceContext, 'env' | 'db' | 'log' | 'meta'>;

/** Whether a subscription is one this deployment's Dodo bills seats on right now. */
function billable(
  row: SubscriptionRecord | null,
  mode: DodoMode,
): row is SubscriptionRecord & { dodoSubscriptionId: string; dodoProductId: string } {
  return (
    row !== null &&
    row.plan !== 'free' &&
    row.dodoSubscriptionId !== null &&
    row.dodoProductId !== null &&
    (row.dodoMode === null || row.dodoMode === mode) &&
    (row.status === 'active' ||
      row.status === 'trialing' ||
      row.status === 'past_due' ||
      row.status === 'on_hold')
  );
}

/**
 * Pushes the organisation's seat count to Dodo if it differs from what is
 * billed. Never throws: every failure is recorded on the debt and logged.
 */
export async function syncSeats(services: SeatServices, orgId: string): Promise<SeatSyncOutcome> {
  const log = services.log.at('syncSeats');

  let setup: ReturnType<typeof billingSetup>;
  try {
    setup = billingSetup(services.env);
  } catch (cause) {
    // Half-configured: nothing can be pushed, and the debt waits for the fix.
    await ensureSeatSync(services.db, orgId);
    log.error('Billing is misconfigured, so a seat change was queued rather than pushed', {
      orgId,
      error: describeError(cause),
    });
    return 'failed';
  }
  if (setup.state === 'disabled') return 'off';
  const { mode } = setup.config;

  const first = await findSubscription(services.db, orgId);
  if (!billable(first, mode)) {
    // Nothing billed here, so nothing owed: an old debt for it is cleared.
    await clearSeatSync(services.db, orgId);
    return 'not-billed';
  }

  await ensureSeatSync(services.db, orgId);
  let generation = await claimSeatSync(services.db, orgId, SEAT_PUSH_LEASE_MS);
  if (generation === null) return 'busy';

  const provider = billingProvider(setup.config);
  let outcome: SeatSyncOutcome = 'in-sync';
  // Widened by hand: assigned inside the loop, read in `finally`, and a plain
  // `= null` would narrow it to `null` for both.
  let pushed = null as { from: number; to: number; at: Date; subscriptionId: string } | null;

  try {
    // Each push is followed by a fresh count before the debt is cleared, so a
    // pass either pushes or confirms; a few spare passes absorb a generation
    // bumped by a change that left the count where it was.
    let pushes = 0;
    for (let pass = 0; pass <= 2 * MAX_PUSHES; pass += 1) {
      const row = await findSubscription(services.db, orgId);
      if (!billable(row, mode)) {
        await clearSeatSync(services.db, orgId);
        return pushed ? 'synced' : 'not-billed';
      }

      const seats = providerSeats(
        resolvePlanId(row.plan),
        await seatedMemberCount(services.db, orgId),
      );
      if (seats.billed === row.seats) {
        if (await completeSeatSync(services.db, orgId, generation)) return outcome;
        // A change landed since the count: count again under its generation.
        generation = (await seatSyncGeneration(services.db, orgId)) ?? generation;
        continue;
      }

      if (pushes === MAX_PUSHES) break; // the count keeps moving: the hourly job takes over
      pushes += 1;

      const now = new Date();
      if (row.dodoScheduledChangeAt !== null && row.dodoScheduledChangeAt > now) {
        // Our row says a change is scheduled. Dodo is asked whether it still
        // is: an owner can withdraw a scheduled downgrade in the portal, and a
        // push put off for a change that no longer exists would wait out a
        // whole period for nothing.
        const scheduled = await scheduledChangeAtDodo(provider, row.dodoSubscriptionId);
        if (scheduled !== null) {
          const until = scheduled === 'unknown' ? row.dodoScheduledChangeAt : scheduled;
          if (until.getTime() !== row.dodoScheduledChangeAt.getTime()) {
            await recordScheduledChange(services, orgId, until);
          }
          await deferSeatSync(
            services.db,
            orgId,
            new Date(until.getTime() + SCHEDULED_CHANGE_GRACE_MS),
            'scheduled_change',
          );
          log.info('A seat change waits for the plan change Dodo has scheduled', {
            orgId,
            seatCount: seats.billed,
          });
          return 'deferred';
        }
        // Gone at Dodo: forgotten here too, and the push goes now.
        await recordScheduledChange(services, orgId, null);
        log.info('The plan change our row had scheduled is no longer at Dodo; pushing seats now', {
          orgId,
        });
      }

      try {
        await provider.changePlan(row.dodoSubscriptionId, {
          productId: row.dodoProductId,
          quantity: seats.billed,
          proration: 'prorated_immediately_keep_cycle',
          effectiveAt: 'immediately',
          onPaymentFailure: 'apply_change',
        });
      } catch (cause) {
        if (cause instanceof DodoApiError && cause.category === 'conflict') {
          // Dodo has a plan change scheduled that our row has not heard of
          // yet: it waits for that change's date, when Dodo can say it.
          const scheduled = await scheduledChangeAtDodo(provider, row.dodoSubscriptionId);
          if (scheduled instanceof Date) await recordScheduledChange(services, orgId, scheduled);
          await deferSeatSync(
            services.db,
            orgId,
            new Date(
              (scheduled instanceof Date ? scheduled : now).getTime() + SCHEDULED_CHANGE_GRACE_MS,
            ),
            'scheduled_change',
          );
          log.info('Dodo refused a seat push while a plan change is scheduled; it waits', {
            orgId,
          });
          return 'deferred';
        }
        if (
          cause instanceof DodoApiError &&
          cause.category === 'invalid' &&
          (await alreadyBilled(provider, row.dodoSubscriptionId, row.dodoProductId, seats.billed))
        ) {
          // Refused as no change at all: Dodo already bills exactly this. The
          // debt is paid — our row is brought to Dodo's count, and the next
          // pass clears it rather than retrying a push Dodo will always refuse.
          await services.db.transaction(async (tx) => {
            await writeSubscriptionState(tx, orgId, {}, seats);
            await appendAuditEvents(tx, [
              systemAudit(services, orgId, 'seat sync').success(
                'billing.seats_synced',
                subscriptionResource(orgId),
                { seatCount: seats.billed, previousSeatCount: row.seats },
              ),
            ]);
          });
          log.info('Dodo already bills the seat count; nothing to push', {
            orgId,
            seatCount: seats.billed,
          });
          continue;
        }
        await recordFailure(services, orgId, cause, { seats: seats.billed, previous: row.seats });
        return 'failed';
      }

      await services.db.transaction(async (tx) => {
        await writeSubscriptionState(tx, orgId, {}, seats);
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
      pushed = {
        from: pushed?.from ?? row.seats,
        to: seats.billed,
        at: pushed?.at ?? now,
        subscriptionId: row.dodoSubscriptionId,
      };
      outcome = 'synced';
      // Round again: the count is read afresh, and the debt is cleared only if
      // it still matches what Dodo was just sent.
    }
    return outcome;
  } finally {
    // Whatever happened, the lease goes (a paid debt took it with it), and the
    // owners hear about a bill that moved.
    await releaseSeatSync(services.db, orgId).catch(() => undefined);
    if (pushed !== null && pushed.from !== pushed.to) await tellOwners(services, orgId, pushed);
  }
}

/**
 * When the plan change Dodo has scheduled for the subscription takes effect —
 * `null` when it has none, `'unknown'` when Dodo could not be asked (a caller
 * then keeps what it believed).
 */
async function scheduledChangeAtDodo(
  provider: BillingProvider,
  subscriptionId: string,
): Promise<Date | null | 'unknown'> {
  try {
    const subscription = await provider.getSubscription(subscriptionId);
    const at = subscription.scheduled_change?.effective_at;
    if (at === null || at === undefined) return null;
    const date = new Date(at);
    return Number.isNaN(date.getTime()) ? 'unknown' : date;
  } catch {
    return 'unknown';
  }
}

/** Whether Dodo already bills `quantity` of the product. A failure to ask answers no. */
async function alreadyBilled(
  provider: BillingProvider,
  subscriptionId: string,
  productId: string,
  quantity: number,
): Promise<boolean> {
  try {
    const subscription = await provider.getSubscription(subscriptionId);
    return subscription.product_id === productId && subscription.quantity === quantity;
  } catch {
    return false;
  }
}

/** Records on the row when Dodo's scheduled change lands — or that there is none. */
async function recordScheduledChange(
  services: SeatServices,
  orgId: string,
  at: Date | null,
): Promise<void> {
  await services.db.transaction(async (tx) => {
    await writeSubscriptionState(tx, orgId, { dodoScheduledChangeAt: at });
  });
}

/** A failed push: the debt's backoff, the audit record, and — at the cap — the alert. */
async function recordFailure(
  services: SeatServices,
  orgId: string,
  cause: unknown,
  seats: { seats: number; previous: number },
): Promise<void> {
  const log = services.log.at('syncSeats');
  const category = cause instanceof DodoApiError ? cause.category : 'unexpected';
  const attempts = await failSeatSync(services.db, orgId, category);
  await appendAuditEvents(services.db, [
    systemAudit(services, orgId, 'seat sync').error(
      'billing.seats_synced',
      subscriptionResource(orgId),
      'upstreamUnavailable',
      { seatCount: seats.seats, previousSeatCount: seats.previous },
    ),
  ]);
  log.warn('Could not push a seat change to Dodo; the hourly job will retry it', {
    orgId,
    category,
    attempts,
    ...(cause instanceof DodoApiError ? {} : { error: describeError(cause) }),
  });
  if (attempts >= SEAT_SYNC_MAX_ATTEMPTS && (await deadLetterSeatSync(services.db, orgId))) {
    log.error(
      `A seat change has failed to reach Dodo ${attempts} times and is no longer retried; the ` +
        'organisation is billed for a seat count its membership no longer has. Check the ' +
        'subscription in Dodo (docs/operations/billing.md, "Seat-sync debts")',
      { orgId, lastError: category },
    );
  }
}

/** The "now billed for N seats" email, once per push that landed. */
async function tellOwners(
  services: SeatServices,
  orgId: string,
  pushed: { from: number; to: number; at: Date; subscriptionId: string },
): Promise<void> {
  try {
    const row = await findSubscription(services.db, orgId);
    if (row === null || row.billingInterval === null) return;
    await sendBillingReminder(services, {
      orgId,
      occasion: `${pushed.subscriptionId}:${pushed.at.toISOString()}`,
      reminder: {
        kind: 'seats_changed',
        seats: pushed.to,
        previousSeats: pushed.from,
        interval: row.billingInterval,
      },
    });
  } catch (cause) {
    services.log.at('syncSeats').warn('Could not send the seats-changed email', {
      orgId,
      error: describeError(cause),
    });
  }
}

/**
 * Pushes the seat count after the response — the hook every membership change
 * calls once its own transaction has committed. The debt is already written
 * by then; this only makes the push prompt.
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
  // A paid row with no product recorded is a grant written by hand (no
  // snapshot leaves one behind), whatever id it still carries.
  if (
    row.plan === 'free' ||
    row.dodoSubscriptionId === null ||
    row.dodoProductId === null ||
    row.cancelAtPeriodEnd
  ) {
    return;
  }
  throw errors.conflict(
    'This organisation still has an active subscription, which would keep renewing after it ' +
      'is deleted. Cancel it first from Billing → Manage billing, then delete the ' +
      'organisation. Nothing was deleted.',
  );
}

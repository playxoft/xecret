import { and, asc, count, eq, gt, isNotNull, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import type { AnyColumn, SQL } from 'drizzle-orm';
import {
  DEFAULT_PLAN,
  FETCHES_PER_METERED_UNIT,
  PLANS,
  resolvePlanId,
} from '@xecret/core/entitlements';
import type { BillingInterval, PlanId } from '@xecret/core/entitlements';
import {
  billingCheckouts,
  billingLicenseKeys,
  billingReminders,
  billingRequests,
  billingSeatSyncs,
  orgSubscriptions,
  orgUsageCounters,
} from '../schema/billing';
import type { BillingReminderKind, BillingRequestKind } from '../schema/billing';
import { planIdEnum } from '../schema/enums';
import { users } from '../schema/identity';
import { projects } from '../schema/resources';
import { invitations, orgMembers, organizations } from '../schema/tenancy';
import { serviceTokens } from '../schema/tokens';
import type { Executor, Transaction } from './shared';
import type { SubscriptionPatch, SubscriptionRecord } from './subscriptions';

/**
 * The payment side of `org_subscriptions`, and the four ledgers beside it (P12).
 *
 * ── The rule this file shares with `subscriptions.ts` ──
 * Nothing here reads the payment provider, and nothing here is on the
 * secret-fetch path. These functions are called by the webhook, the billing
 * routes and the scheduled jobs — all of them already doing IO, none of them
 * latency-sensitive — and by `addFetchCounts`, which is the destination of an
 * off-path flush and never of a fetch itself.
 *
 * ── Who decides ──
 * These write what they are told. What the subscription *should* say is
 * decided by the webhook's snapshot logic in `apps/web/src/server/billing`,
 * and what it costs by the payment provider. A repository that decided either
 * would be a second copy of a rule that must have one.
 */

/* ── subscription rows ─────────────────────────────────────────────────────── */

/**
 * The organisation's subscription row, locked for the rest of the transaction.
 *
 * Every webhook that writes a subscription takes this first, so two events for
 * one organisation — an `active` and a `payment.succeeded` delivered in the
 * same second — apply one after the other rather than each reading the row the
 * other is about to change. The lock is the row's, not the organisation's: the
 * membership transactions that take `organizations … FOR UPDATE` are not
 * blocked by a webhook, and a webhook never waits on an invitation.
 */
export async function lockSubscription(
  tx: Transaction,
  orgId: string,
): Promise<SubscriptionRecord | null> {
  const [row] = await tx
    .select()
    .from(orgSubscriptions)
    .where(eq(orgSubscriptions.orgId, orgId))
    .limit(1)
    .for('update');
  return row ?? null;
}

/** The organisation a provider subscription id belongs to, if we know it. */
export async function findOrgIdByDodoSubscription(
  exec: Executor,
  dodoSubscriptionId: string,
): Promise<string | null> {
  const [row] = await exec
    .select({ orgId: orgSubscriptions.orgId })
    .from(orgSubscriptions)
    .where(eq(orgSubscriptions.dodoSubscriptionId, dodoSubscriptionId))
    .limit(1);
  return row?.orgId ?? null;
}

/**
 * The organisation a provider customer id belongs to — **only when exactly one
 * does**.
 *
 * A customer at the payment provider is an email address, and one person can
 * own two organisations that each bought a plan. An event that can only be
 * placed by its customer is therefore placed only when the answer is
 * unambiguous; two matches answer `null`, and the caller does not guess.
 */
export async function findOrgIdByDodoCustomer(
  exec: Executor,
  dodoCustomerId: string,
): Promise<string | null> {
  const rows = await exec
    .select({ orgId: orgSubscriptions.orgId })
    .from(orgSubscriptions)
    .where(eq(orgSubscriptions.dodoCustomerId, dodoCustomerId))
    .limit(2);
  return rows.length === 1 ? (rows[0]?.orgId ?? null) : null;
}

/**
 * How many organisations hold this provider customer — one, for every
 * customer a checkout of ours created since checkouts force a customer per
 * organisation. The customer portal is opened only for a customer held by
 * exactly one, so one organisation's owner can never land in the portal that
 * pays for another's.
 */
export async function countOrgsWithDodoCustomer(
  exec: Executor,
  dodoCustomerId: string,
): Promise<number> {
  const [row] = await exec
    .select({ value: count() })
    .from(orgSubscriptions)
    .where(eq(orgSubscriptions.dodoCustomerId, dodoCustomerId));
  return row?.value ?? 0;
}

/** Whether a live organisation has this id. Metadata names one; this checks it is real. */
export async function liveOrganizationExists(exec: Executor, orgId: string): Promise<boolean> {
  const [row] = await exec
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)))
    .limit(1);
  return row !== undefined;
}

/** The organisation's name and slug, for an email or a log line. */
export async function findBillingOrganization(
  exec: Executor,
  orgId: string,
): Promise<{ id: string; name: string; slug: string } | null> {
  const [row] = await exec
    .select({ id: organizations.id, name: organizations.name, slug: organizations.slug })
    .from(organizations)
    .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)))
    .limit(1);
  return row ?? null;
}

/** The provider's columns, beside the ones the operator tool writes too. */
export interface ProviderSubscriptionPatch extends SubscriptionPatch {
  currentPeriodStart?: Date | null;
  dodoProductId?: string | null;
  dodoEventAt?: Date | null;
  renewalAmountMinor?: number | null;
  meteredFrom?: Date | null;
  dodoMode?: 'test_mode' | 'live_mode' | null;
  dodoEventId?: string | null;
  onHoldSince?: Date | null;
  dodoScheduledChangeAt?: Date | null;
  dodoCurrency?: string | null;
  dodoBillingCountry?: string | null;
}

/**
 * Whether a row still carries anything of a provider subscription — an id, a
 * mode, a product, an applied event. A row on Free keeps its subscription id
 * when the subscription ends (so Dodo's later events still find it), and a
 * row that carries one is a row a webhook can still write.
 */
export function carriesProviderIds(
  row: Pick<
    SubscriptionRecord,
    | 'dodoSubscriptionId'
    | 'dodoCustomerId'
    | 'dodoProductId'
    | 'dodoMode'
    | 'dodoEventAt'
    | 'dodoEventId'
    | 'dodoScheduledChangeAt'
  >,
): boolean {
  return (
    row.dodoSubscriptionId !== null ||
    row.dodoCustomerId !== null ||
    row.dodoProductId !== null ||
    row.dodoMode !== null ||
    row.dodoEventAt !== null ||
    row.dodoEventId !== null ||
    row.dodoScheduledChangeAt !== null
  );
}

/** What the operator tool does with a run that sets an organisation's plan by hand. */
export type OperatorBillingEdit =
  /** Nothing of a provider subscription on the row: write the change. */
  | 'write'
  /** Dodo bills the row and `--over-dodo` was not passed: refuse. */
  | 'refuse'
  /** Take the row off its provider ids first (`detachFromProvider`), then write. */
  | 'detach';

/**
 * The operator tool's rule for a run that touches the billing fields — plan,
 * interval, seats, status. Pure, so the rule is tested where it is stated.
 *
 *  - A subscription Dodo bills (a paid plan with a subscription id) is Dodo's
 *    to change: refused, unless the operator passes `--over-dodo`.
 *  - **Any** row that still carries provider ids is taken off them before the
 *    change is written — **whatever its plan**. A row on Free keeps the id of
 *    the subscription it ended on; a grant written over that id would leave
 *    the grant following a subscription Dodo can still send events for, and a
 *    late `cancelled`, or the subscription coming back, would be applied over
 *    the contract.
 *  - A run that touches no billing field (an add-on, a limit override) writes,
 *    whatever the row carries: those are never Dodo's.
 */
export function operatorBillingEdit(
  row: Pick<SubscriptionRecord, 'plan'> & Parameters<typeof carriesProviderIds>[0],
  run: { touchesBilling: boolean; overDodo: boolean },
): OperatorBillingEdit {
  if (!run.touchesBilling) return 'write';
  const billedByDodo = row.dodoSubscriptionId !== null && row.plan !== 'free';
  if (billedByDodo && !run.overDodo) return 'refuse';
  return carriesProviderIds(row) ? 'detach' : 'write';
}

/**
 * Takes an organisation off the provider subscription it followed — what the
 * operator tool does when it sets a plan by hand over one Dodo bills
 * (`plan:set --over-dodo`), and over a row on Free that kept the ids of a
 * subscription that ended (see {@link operatorBillingEdit}).
 *
 * Clears the provider ids and every column that only means something beside
 * them, so the row reads afterwards as exactly what it now is: an operator's
 * grant (a paid plan with no subscription), or Free. Nothing else — the plan,
 * seats and add-ons are the caller's to write in the same transaction.
 *
 * Returns the ids it cleared, for the operator's own record of the run: the
 * subscription may still be live at Dodo until somebody cancels it there, and
 * this is the only place that says which one it was. `null` when the row
 * carried nothing of one.
 */
export async function detachFromProvider(
  tx: Transaction,
  orgId: string,
): Promise<{ dodoSubscriptionId: string | null; dodoCustomerId: string | null } | null> {
  const row = await lockSubscription(tx, orgId);
  if (row === null) return null;
  if (!carriesProviderIds(row)) return null;
  await tx
    .update(orgSubscriptions)
    .set({
      dodoSubscriptionId: null,
      dodoCustomerId: null,
      dodoProductId: null,
      dodoEventAt: null,
      dodoEventId: null,
      dodoMode: null,
      dodoScheduledChangeAt: null,
      dodoCurrency: null,
      dodoBillingCountry: null,
      renewalAmountMinor: null,
      meteredFrom: null,
      onHoldSince: null,
      cancelAtPeriodEnd: false,
      updatedAt: new Date(),
    })
    .where(eq(orgSubscriptions.orgId, orgId));
  // A seat debt for a subscription nobody follows any more is owed to nobody.
  await tx.delete(billingSeatSyncs).where(eq(billingSeatSyncs.orgId, orgId));
  return { dodoSubscriptionId: row.dodoSubscriptionId, dodoCustomerId: row.dodoCustomerId };
}

/**
 * Writes a subscription change and, when given, the seat pair with it — in the
 * caller's transaction, so an invoice figure and an access ceiling can never be
 * left disagreeing by a crash between two statements.
 *
 * `seats.billed` is what the provider bills (its `quantity`); `seats.enforced`
 * is what invitations are refused against (`organizations.seat_limit`). See
 * `providerSeats` in `@xecret/core/entitlements` for how the pair is decided.
 */
export async function writeSubscriptionState(
  tx: Transaction,
  orgId: string,
  patch: ProviderSubscriptionPatch,
  seats?: { billed: number; enforced: number },
): Promise<SubscriptionRecord | null> {
  const now = new Date();
  const [row] = await tx
    .update(orgSubscriptions)
    .set({ ...patch, ...(seats ? { seats: seats.billed } : {}), updatedAt: now })
    .where(eq(orgSubscriptions.orgId, orgId))
    .returning();

  if (seats && row) {
    await tx
      .update(organizations)
      .set({ seatLimit: seats.enforced, updatedAt: now })
      .where(eq(organizations.id, orgId));
  }
  return row ?? null;
}

/**
 * Members holding a seat, **whatever their status** — the number a provider
 * subscription is billed for. Suspension is a security act, never a discount.
 * Pending invitations are not counted: nobody is billed for a seat until the
 * invitation is accepted, as the pricing page says.
 */
export async function seatedMemberCount(exec: Executor, orgId: string): Promise<number> {
  const [row] = await exec
    .select({ value: count() })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.seatAssigned, true)));
  return row?.value ?? 0;
}

/** Live owners' addresses — who a billing email goes to. Suspended owners get none. */
export async function listOwnerRecipients(
  exec: Executor,
  orgId: string,
): Promise<{ email: string; displayName: string | null }[]> {
  return exec
    .select({ email: users.email, displayName: users.displayName })
    .from(orgMembers)
    .innerJoin(users, and(eq(users.id, orgMembers.userId), isNull(users.deletedAt)))
    .where(
      and(
        eq(orgMembers.orgId, orgId),
        eq(orgMembers.role, 'owner'),
        eq(orgMembers.status, 'active'),
      ),
    )
    .orderBy(asc(orgMembers.createdAt))
    .limit(50);
}

/**
 * Every subscription the payment provider manages and we still treat as paid:
 * what the reconciler compares, and what the reminder sweep reads.
 *
 * Bounded per call; the reconciler pages with `afterOrgId`.
 */
export async function listProviderSubscriptions(
  exec: Executor,
  options: { limit: number; afterOrgId?: string | undefined },
): Promise<SubscriptionRecord[]> {
  return exec
    .select({ subscription: orgSubscriptions })
    .from(orgSubscriptions)
    .innerJoin(
      organizations,
      and(eq(organizations.id, orgSubscriptions.orgId), isNull(organizations.deletedAt)),
    )
    .where(
      and(
        isNotNull(orgSubscriptions.dodoSubscriptionId),
        ne(orgSubscriptions.plan, 'free'),
        options.afterOrgId === undefined
          ? undefined
          : gt(orgSubscriptions.orgId, options.afterOrgId),
      ),
    )
    .orderBy(asc(orgSubscriptions.orgId))
    .limit(options.limit)
    .then((rows) => rows.map((row) => row.subscription));
}

/**
 * Cancelled subscriptions whose paid period is over — the boundary the
 * `cancel_at_period_end` flag was waiting for. The hourly job returns each to
 * Free; this only finds them. By the database's clock, not a Worker's.
 */
export async function listEndedCancellations(
  exec: Executor,
  limit: number,
): Promise<SubscriptionRecord[]> {
  return exec
    .select()
    .from(orgSubscriptions)
    .where(
      and(
        eq(orgSubscriptions.cancelAtPeriodEnd, true),
        ne(orgSubscriptions.plan, 'free'),
        isNotNull(orgSubscriptions.dodoSubscriptionId),
        lt(orgSubscriptions.currentPeriodEnd, sql`now()`),
      ),
    )
    .orderBy(asc(orgSubscriptions.currentPeriodEnd))
    .limit(limit);
}

/**
 * Provider subscriptions on hold since before `since` — the ones the hourly
 * job ends, so an unpaid subscription cannot keep its plan for ever.
 */
export async function listLongHolds(
  exec: Executor,
  options: { since: Date; limit: number },
): Promise<SubscriptionRecord[]> {
  return exec
    .select()
    .from(orgSubscriptions)
    .where(
      and(
        eq(orgSubscriptions.status, 'on_hold'),
        ne(orgSubscriptions.plan, 'free'),
        isNotNull(orgSubscriptions.dodoSubscriptionId),
        lte(orgSubscriptions.onHoldSince, options.since),
      ),
    )
    .orderBy(asc(orgSubscriptions.onHoldSince))
    .limit(options.limit);
}

/**
 * Provider subscriptions still marked `trialing` although their trial ended
 * before `endedBefore` — a status no webhook moved on. The hourly job asks
 * Dodo what they became.
 */
export async function listLapsedTrials(
  exec: Executor,
  options: { endedBefore: Date; limit: number },
): Promise<SubscriptionRecord[]> {
  return exec
    .select()
    .from(orgSubscriptions)
    .where(
      and(
        eq(orgSubscriptions.status, 'trialing'),
        ne(orgSubscriptions.plan, 'free'),
        isNotNull(orgSubscriptions.dodoSubscriptionId),
        lt(orgSubscriptions.trialEndsAt, options.endedBefore),
      ),
    )
    .orderBy(asc(orgSubscriptions.trialEndsAt))
    .limit(options.limit);
}

/**
 * Rows on Free that a checkout's payment linked to a subscription whose
 * snapshot has never been applied, linked before `linkedBefore` — a paid
 * checkout stranded short of its plan (the `subscription.active` lost, or
 * refused until Dodo gave up). The hourly job asks Dodo what each became.
 * "Linked" is dated by the row's last write: nothing else writes a Free row
 * between the link and the activation.
 */
export async function listAwaitingActivation(
  exec: Executor,
  options: { linkedBefore: Date; limit: number },
): Promise<SubscriptionRecord[]> {
  return exec
    .select()
    .from(orgSubscriptions)
    .where(
      and(
        eq(orgSubscriptions.plan, 'free'),
        isNotNull(orgSubscriptions.dodoSubscriptionId),
        isNull(orgSubscriptions.dodoEventAt),
        lt(orgSubscriptions.updatedAt, options.linkedBefore),
      ),
    )
    .orderBy(asc(orgSubscriptions.updatedAt))
    .limit(options.limit);
}

/* ── checkouts ─────────────────────────────────────────────────────────────── */

export type CheckoutRecord = typeof billingCheckouts.$inferSelect;

/**
 * Records a hosted checkout the server just created, with the nonce it put in
 * the checkout's metadata. Insert-only by grant, but for a consumption.
 */
export async function recordCheckout(
  exec: Executor,
  checkout: {
    sessionId: string;
    orgId: string;
    plan: Exclude<PlanId, 'free'>;
    billingInterval: BillingInterval;
    quantity: number;
    createdBy: string | null;
    nonce: string;
  },
): Promise<void> {
  // The same session recorded twice is one checkout; the same nonce on two is
  // a broken random source, and must fail loudly rather than bind either.
  await exec
    .insert(billingCheckouts)
    .values(checkout)
    .onConflictDoNothing({ target: billingCheckouts.sessionId });
}

export async function findCheckout(
  exec: Executor,
  sessionId: string,
): Promise<CheckoutRecord | null> {
  const [row] = await exec
    .select()
    .from(billingCheckouts)
    .where(eq(billingCheckouts.sessionId, sessionId))
    .limit(1);
  return row ?? null;
}

/**
 * The organisation's open checkout carrying this nonce, if there is one —
 * what makes a subscription's metadata trustworthy enough to attach it.
 *
 * Open: created since `openSince`, not yet consumed by any subscription, and
 * the organisation still live. A nonce from another organisation's checkout,
 * one already spent, or one nobody minted answers `null`.
 */
export async function findOpenCheckout(
  exec: Executor,
  query: { orgId: string; nonce: string; openSince: Date },
): Promise<CheckoutRecord | null> {
  const [row] = await exec
    .select({ checkout: billingCheckouts })
    .from(billingCheckouts)
    .innerJoin(
      organizations,
      and(eq(organizations.id, billingCheckouts.orgId), isNull(organizations.deletedAt)),
    )
    .where(
      and(
        eq(billingCheckouts.orgId, query.orgId),
        eq(billingCheckouts.nonce, query.nonce),
        isNull(billingCheckouts.subscriptionId),
        gt(billingCheckouts.createdAt, query.openSince),
      ),
    )
    .limit(1);
  return row?.checkout ?? null;
}

/**
 * The organisation's checkout carrying this nonce, whatever its state — so a
 * caller that found no *open* one can tell an expired checkout of its own
 * (still unspent, older than the window) from a nonce nobody minted for it.
 */
export async function findCheckoutByNonce(
  exec: Executor,
  query: { orgId: string; nonce: string },
): Promise<CheckoutRecord | null> {
  const [row] = await exec
    .select()
    .from(billingCheckouts)
    .where(and(eq(billingCheckouts.orgId, query.orgId), eq(billingCheckouts.nonce, query.nonce)))
    .limit(1);
  return row ?? null;
}

/**
 * Spends a checkout on the subscription it produced — by its session id (a
 * payment names it) or its nonce (a subscription's metadata carries it).
 * Answers false when there was nothing open to spend: never minted, another
 * organisation's, or already spent on a subscription. A spent checkout attaches
 * nothing more, so a subscription taken off an organisation by hand cannot
 * come back through the checkout that first brought it.
 */
export async function consumeCheckout(
  exec: Executor,
  consumption: {
    orgId: string;
    subscriptionId: string;
    by: { sessionId: string } | { nonce: string };
  },
): Promise<boolean> {
  const key =
    'sessionId' in consumption.by
      ? eq(billingCheckouts.sessionId, consumption.by.sessionId)
      : eq(billingCheckouts.nonce, consumption.by.nonce);
  const spent = await exec
    .update(billingCheckouts)
    .set({ subscriptionId: consumption.subscriptionId, consumedAt: new Date() })
    .where(
      and(
        key,
        eq(billingCheckouts.orgId, consumption.orgId),
        isNull(billingCheckouts.subscriptionId),
      ),
    )
    .returning({ sessionId: billingCheckouts.sessionId });
  return spent.length > 0;
}

/* ── seat-sync debts ───────────────────────────────────────────────────────── */

export type SeatSyncRecord = typeof billingSeatSyncs.$inferSelect;

/** Failures before a debt is given up on and raised for a human. */
export const SEAT_SYNC_MAX_ATTEMPTS = 10;

/**
 * Records that the organisation's seat count changed and is owed to the
 * provider: a new debt, or a new generation of an existing one — which also
 * makes it due again at once, since a new count is a new chance for the push.
 *
 * Unconditional; membership changes use {@link queueBilledSeatSync}.
 */
export async function queueSeatSync(exec: Executor, orgId: string): Promise<void> {
  await exec
    .insert(billingSeatSyncs)
    .values({ orgId, queuedAt: new Date() })
    .onConflictDoUpdate({
      target: billingSeatSyncs.orgId,
      set: {
        generation: sql`${billingSeatSyncs.generation} + 1`,
        attempts: 0,
        notBefore: null,
        deadLetteredAt: null,
      },
    });
}

/**
 * {@link queueSeatSync}, but only for an organisation the provider bills seats
 * on — the call every membership change makes **inside its own transaction**,
 * so the debt commits with the membership or not at all. A push that never
 * starts (an isolate gone before `waitUntil` ran) still leaves the debt for the
 * hourly job. A Free organisation, or an operator's grant, writes nothing.
 */
export async function queueBilledSeatSync(exec: Executor, orgId: string): Promise<void> {
  await exec.execute(sql`
    insert into ${billingSeatSyncs} (org_id, queued_at)
    select ${orgSubscriptions.orgId}, ${new Date().toISOString()}::timestamptz
      from ${orgSubscriptions}
     where ${orgSubscriptions.orgId} = ${orgId}
       and ${orgSubscriptions.plan} <> 'free'
       and ${orgSubscriptions.dodoSubscriptionId} is not null
       and ${orgSubscriptions.dodoProductId} is not null
    on conflict (org_id) do update
      set generation = ${billingSeatSyncs.generation} + 1,
          attempts = 0,
          not_before = null,
          dead_lettered_at = null
  `);
}

/**
 * Makes sure a debt exists before a push claims it, without touching one that
 * does — a retry must not reset the backoff it is being retried under.
 */
export async function ensureSeatSync(exec: Executor, orgId: string): Promise<void> {
  await exec.insert(billingSeatSyncs).values({ orgId, queuedAt: new Date() }).onConflictDoNothing();
}

/**
 * Takes the one push allowed in flight for an organisation, for `leaseMs`.
 * Answers the generation it was taken under, or `null` when another push holds
 * it (or there is no debt). The lease outlives an isolate that dies holding
 * it by at most `leaseMs`.
 */
export async function claimSeatSync(
  exec: Executor,
  orgId: string,
  leaseMs: number,
): Promise<number | null> {
  const now = new Date();
  const [row] = await exec
    .update(billingSeatSyncs)
    .set({ claimedUntil: new Date(now.getTime() + leaseMs) })
    .where(
      and(
        eq(billingSeatSyncs.orgId, orgId),
        or(isNull(billingSeatSyncs.claimedUntil), lte(billingSeatSyncs.claimedUntil, now)),
      ),
    )
    .returning({ generation: billingSeatSyncs.generation });
  return row?.generation ?? null;
}

/** The debt's current generation, or `null` when there is none. */
export async function seatSyncGeneration(exec: Executor, orgId: string): Promise<number | null> {
  const [row] = await exec
    .select({ generation: billingSeatSyncs.generation })
    .from(billingSeatSyncs)
    .where(eq(billingSeatSyncs.orgId, orgId))
    .limit(1);
  return row?.generation ?? null;
}

/**
 * Pays a debt — only if no membership change has bumped it since the push
 * counted under `generation`. Answers whether it was paid; `false` means a
 * change landed mid-push, and the pusher must count again.
 */
export async function completeSeatSync(
  exec: Executor,
  orgId: string,
  generation: number,
): Promise<boolean> {
  const paid = await exec
    .delete(billingSeatSyncs)
    .where(and(eq(billingSeatSyncs.orgId, orgId), eq(billingSeatSyncs.generation, generation)))
    .returning({ orgId: billingSeatSyncs.orgId });
  return paid.length > 0;
}

/** Forgets any debt: the organisation is not billed for seats, so nothing is owed. */
export async function clearSeatSync(exec: Executor, orgId: string): Promise<void> {
  await exec.delete(billingSeatSyncs).where(eq(billingSeatSyncs.orgId, orgId));
}

/** Lets go of the lease without paying the debt. */
export async function releaseSeatSync(exec: Executor, orgId: string): Promise<void> {
  await exec
    .update(billingSeatSyncs)
    .set({ claimedUntil: null })
    .where(eq(billingSeatSyncs.orgId, orgId));
}

/**
 * Records a failed push and lets go of the lease. The debt is next due after
 * 2, 4, 8 … minutes, capped at a day. `category` is a short token, never a
 * provider message. Answers the attempts so far.
 */
export async function failSeatSync(
  exec: Executor,
  orgId: string,
  category: string,
): Promise<number> {
  const now = new Date();
  const [row] = await exec
    .insert(billingSeatSyncs)
    .values({
      orgId,
      attempts: 1,
      lastAttemptAt: now,
      lastError: category.slice(0, 64),
      notBefore: new Date(now.getTime() + 2 * 60_000),
    })
    .onConflictDoUpdate({
      target: billingSeatSyncs.orgId,
      set: {
        attempts: sql`${billingSeatSyncs.attempts} + 1`,
        lastAttemptAt: now,
        lastError: category.slice(0, 64),
        claimedUntil: null,
        notBefore: sql`${now.toISOString()}::timestamptz + least(
          interval '1 minute' * power(2, ${billingSeatSyncs.attempts} + 1),
          interval '1 day'
        )`,
      },
    })
    .returning({ attempts: billingSeatSyncs.attempts });
  return row?.attempts ?? 1;
}

/**
 * Puts a debt off until `until` without counting a failure — a push that
 * would collide with a plan change Dodo has scheduled waits for it to land.
 * Lets go of the lease.
 */
export async function deferSeatSync(
  exec: Executor,
  orgId: string,
  until: Date,
  reason: string,
): Promise<void> {
  await exec
    .insert(billingSeatSyncs)
    .values({ orgId, notBefore: until, lastError: reason.slice(0, 64) })
    .onConflictDoUpdate({
      target: billingSeatSyncs.orgId,
      set: { notBefore: until, lastError: reason.slice(0, 64), claimedUntil: null },
    });
}

/**
 * Gives up on a debt that has failed {@link SEAT_SYNC_MAX_ATTEMPTS} times.
 * Answers true only the first time, so the alert that follows is raised once.
 * The debt stays — the reconciler still reports the organisation — and the next
 * membership change makes it due again.
 */
export async function deadLetterSeatSync(exec: Executor, orgId: string): Promise<boolean> {
  const marked = await exec
    .update(billingSeatSyncs)
    .set({ deadLetteredAt: new Date(), claimedUntil: null })
    .where(and(eq(billingSeatSyncs.orgId, orgId), isNull(billingSeatSyncs.deadLetteredAt)))
    .returning({ orgId: billingSeatSyncs.orgId });
  return marked.length > 0;
}

/**
 * The debts due now, oldest first: not waiting out a backoff or a scheduled
 * change, not held by a push in flight, not given up on. A stuck debt waits
 * outside this list, so it cannot crowd out a newer one.
 */
export async function listDueSeatSyncs(
  exec: Executor,
  now: Date,
  limit: number,
): Promise<SeatSyncRecord[]> {
  return exec
    .select()
    .from(billingSeatSyncs)
    .where(
      and(
        isNull(billingSeatSyncs.deadLetteredAt),
        or(isNull(billingSeatSyncs.notBefore), lte(billingSeatSyncs.notBefore, now)),
        or(isNull(billingSeatSyncs.claimedUntil), lte(billingSeatSyncs.claimedUntil, now)),
      ),
    )
    .orderBy(asc(billingSeatSyncs.queuedAt))
    .limit(limit);
}

/** Every debt, oldest first — dead-lettered ones included. */
export async function listSeatSyncs(exec: Executor, limit: number): Promise<SeatSyncRecord[]> {
  return exec.select().from(billingSeatSyncs).orderBy(asc(billingSeatSyncs.queuedAt)).limit(limit);
}

/* ── usage ─────────────────────────────────────────────────────────────────── */

/**
 * `anchor` plus `months` calendar months, in UTC, as SQL. A day the month does
 * not have is the month's last (31 January plus one month is 28 February), and
 * every step is taken from the anchor rather than from the step before it, so
 * a period that began on the 31st returns to the 31st whenever there is one.
 */
function plusMonthsUtc(anchor: SQL | AnyColumn, months: SQL): SQL {
  return sql`(((${anchor} at time zone 'UTC') + make_interval(months => ${months})) at time zone 'UTC')`;
}

/**
 * The start of the month of a yearly period that `at` falls in, as SQL: the
 * period's own start plus however many whole months have passed since it, in
 * UTC — the billing anniversary, monthly. Whole calendar months between the
 * two, less one when `at` has not yet reached that month's anniversary day.
 */
function anniversaryMonthStart(anchor: SQL | AnyColumn, at: SQL): SQL {
  const months = sql`(((extract(year from (${at} at time zone 'UTC'))
                       - extract(year from (${anchor} at time zone 'UTC'))) * 12
                      + (extract(month from (${at} at time zone 'UTC'))
                       - extract(month from (${anchor} at time zone 'UTC'))))::int)`;
  return sql`(case
    when ${plusMonthsUtc(anchor, months)} > ${at} then ${plusMonthsUtc(anchor, sql`${months} - 1`)}
    else ${plusMonthsUtc(anchor, months)}
  end)`;
}

/**
 * Where, inside the paid period that covers `at`, a fetch at `at` is counted —
 * as SQL over `org_subscriptions`, for a row whose current period does cover it.
 *
 * **The allowance is monthly, so the meter is too.** A monthly plan's period
 * is its month. A yearly plan's period is a year, and counting a year of
 * fetches against `includedFetchesPerMonth` would bill Pro yearly's twelve
 * quiet months as one overspent one — so a yearly period is counted in months
 * of its own, from the billing anniversary: a period that began on 10 March
 * counts 10 March – 10 April, 10 April – 10 May, and so on. The meter's event
 * ids, the usage bar and the 80% and 100% emails all key on the month.
 */
function paidUsagePeriodStart(at: SQL): SQL {
  return sql`(case
    when ${orgSubscriptions.billingInterval} = 'yearly'
    then ${anniversaryMonthStart(orgSubscriptions.currentPeriodStart, at)}
    else ${orgSubscriptions.currentPeriodStart}
  end)`;
}

/**
 * The usage period a fetch counts towards now, as SQL over `org_subscriptions`.
 *
 * The paid period while one is current — so the meter and the invoice agree
 * on what "this month" is; for a yearly plan, the month of it we are in (see
 * {@link paidUsagePeriodStart}) — and the calendar month in UTC otherwise:
 * Free has no billing period, and a stale period (a renewal webhook that never
 * came) must not keep collecting fetches after its end.
 *
 * One expression, used by the writer and the reader alike, so the billing
 * screen can never be reading a different row from the one being added to.
 */
export const USAGE_PERIOD_START = sql<Date>`(case
  when ${orgSubscriptions.currentPeriodStart} is not null
   and ${orgSubscriptions.currentPeriodEnd} > now()
  then ${paidUsagePeriodStart(sql`now()`)}
  else (date_trunc('month', now() at time zone 'UTC') at time zone 'UTC')
end)`;

/**
 * Adds accumulated fetch counts, one statement for any number of
 * organisations.
 *
 * **The destination of a flush, never of a fetch.** The request path counts in
 * memory (`apps/web/src/server/billing/usage.ts`) and hands batches here from
 * `waitUntil`, after the response has gone. Additive inside the statement, so
 * two isolates flushing at once both land.
 *
 * ── Each count lands in the period it was **counted** in ──
 * `countedAt` is the second the fetches were made, not the moment of the
 * flush, and the period is decided against it: the paid period that covered
 * that second (for a yearly plan, the month of it from the billing
 * anniversary — `paidUsagePeriodStart`); the period before the current one,
 * when a renewal moved the row on between the fetch and its flush (the latest
 * counter row that began by then); or the calendar month, in UTC, when no paid
 * period covered it. So a fetch made on Free in the last seconds before an
 * upgrade is never counted
 * into the paid period that follows, nor a fetch at the end of one period into
 * the next. Rows that land in the same period are summed first — one
 * statement cannot update a row twice.
 */
export async function addFetchCounts(
  exec: Executor,
  counts: readonly { orgId: string; fetches: number; countedAt?: Date | undefined }[],
): Promise<void> {
  const rows = counts.filter((entry) => Number.isSafeInteger(entry.fetches) && entry.fetches > 0);
  if (rows.length === 0) return;

  const fallback = new Date().toISOString();
  const values = sql.join(
    rows.map((entry) => {
      const at =
        entry.countedAt !== undefined && !Number.isNaN(entry.countedAt.getTime())
          ? entry.countedAt.toISOString()
          : fallback;
      return sql`(${entry.orgId}::uuid, ${at}::timestamptz, ${entry.fetches}::bigint)`;
    }),
    sql`, `,
  );

  const start = orgSubscriptions.currentPeriodStart;
  const end = orgSubscriptions.currentPeriodEnd;
  // The month a conflicting row is for is the organisation's current one —
  // the only month whose allowance a flush may still raise.
  const isCurrentMonth = sql`${orgUsageCounters.periodStart} = (
    select ${USAGE_PERIOD_START} from ${orgSubscriptions}
     where ${orgSubscriptions.orgId} = ${orgUsageCounters.orgId})`;
  await exec.execute(sql`
    insert into ${orgUsageCounters} (org_id, period_start, secret_fetches, included_fetches)
    select placed.org_id, placed.period_start, sum(placed.fetches)::bigint,
           max(placed.included_fetches)::bigint
      from (
        select counted.org_id,
               (case
                  when ${start} is not null and ${start} <= counted.at and ${end} > counted.at
                    then ${paidUsagePeriodStart(sql`counted.at`)}
                  when ${start} is not null and ${start} > counted.at
                    then coalesce(
                      (select max(earlier.period_start) from ${orgUsageCounters} as earlier
                        where earlier.org_id = counted.org_id
                          and earlier.period_start <= counted.at),
                      date_trunc('month', counted.at at time zone 'UTC') at time zone 'UTC')
                  else date_trunc('month', counted.at at time zone 'UTC') at time zone 'UTC'
                end) as period_start,
               counted.fetches,
               ${includedFetchesAllowance()} as included_fetches
          from (values ${values}) as counted(org_id, at, fetches)
          join ${orgSubscriptions} on ${orgSubscriptions.orgId} = counted.org_id
      ) as placed
     group by placed.org_id, placed.period_start
    on conflict (org_id, period_start) do update
      set secret_fetches = ${orgUsageCounters.secretFetches} + excluded.secret_fetches,
          included_fetches = (case
            when ${isCurrentMonth}
              then greatest(
                coalesce(${orgUsageCounters.includedFetches}, excluded.included_fetches),
                excluded.included_fetches)
            else ${orgUsageCounters.includedFetches}
          end),
          updated_at = now()
  `);
}

/**
 * The fetches a month includes on the plan an `org_subscriptions` row is on
 * now, as SQL: `entitlementsFromRow(row).limits.includedFetchesPerMonth`,
 * worked out where the row is. The plan's own allowance — from `PLANS`, so it
 * cannot drift from it, a withdrawn plan resolved as `resolvePlanId` resolves
 * it — raised, never lowered, by a support override of it that is a number.
 * A fractional override is rounded up (in the customer's favour), and one too
 * large to read back exactly is held at the largest integer that can be.
 *
 * Written onto a counter row when its month opens (`addFetchCounts`), which is
 * the figure that month is metered against from then on.
 */
function includedFetchesAllowance(): SQL {
  const cases = planIdEnum.enumValues.map(
    (plan) =>
      sql`when ${plan} then ${PLANS[resolvePlanId(plan)].limits.includedFetchesPerMonth}::numeric`,
  );
  const plan = sql`(case ${orgSubscriptions.plan}::text ${sql.join(cases, sql` `)}
    else ${PLANS[DEFAULT_PLAN].limits.includedFetchesPerMonth}::numeric end)`;
  const raised = sql`(case
    when jsonb_typeof(${orgSubscriptions.limitOverrides} -> 'includedFetchesPerMonth') = 'number'
    then least(
      ceil((${orgSubscriptions.limitOverrides} ->> 'includedFetchesPerMonth')::numeric),
      ${Number.MAX_SAFE_INTEGER}::numeric)
    else 0::numeric end)`;
  return sql`(greatest(${plan}, ${raised})::bigint)`;
}

/**
 * Raises the allowance recorded for the organisation's current month to what
 * its plan includes now, if that is more — never lowers it. What the operator
 * tool calls after a change that can raise it (`--limit-override`, `--plan`),
 * in the same transaction, so a raise support grants counts for the month it
 * was granted in, and the month keeps it after the raise is cleared.
 */
export async function raiseCurrentUsageAllowance(exec: Executor, orgId: string): Promise<void> {
  await exec.execute(sql`
    update ${orgUsageCounters}
       set included_fetches = greatest(
             coalesce(${orgUsageCounters.includedFetches}, 0), ${includedFetchesAllowance()}),
           updated_at = now()
      from ${orgSubscriptions}
     where ${orgSubscriptions.orgId} = ${orgUsageCounters.orgId}
       and ${orgUsageCounters.orgId} = ${orgId}
       and ${orgUsageCounters.periodStart} = ${USAGE_PERIOD_START}
  `);
}

/** This period's counter for an organisation, as the billing screen shows it. */
export async function currentUsage(
  exec: Executor,
  orgId: string,
): Promise<{
  periodStart: Date;
  secretFetches: number;
  meteredUnitsSent: number;
  /** The allowance recorded for the month; `null` before its first fetch is counted. */
  includedFetches: number | null;
}> {
  const [period] = await exec
    .select({ start: USAGE_PERIOD_START })
    .from(orgSubscriptions)
    .where(eq(orgSubscriptions.orgId, orgId))
    .limit(1);
  const periodStart = period ? new Date(period.start) : monthStartUtc(new Date());

  const [row] = await exec
    .select({
      secretFetches: orgUsageCounters.secretFetches,
      meteredUnitsSent: orgUsageCounters.meteredUnitsSent,
      includedFetches: orgUsageCounters.includedFetches,
    })
    .from(orgUsageCounters)
    .where(and(eq(orgUsageCounters.orgId, orgId), eq(orgUsageCounters.periodStart, periodStart)))
    .limit(1);

  return {
    periodStart,
    secretFetches: row?.secretFetches ?? 0,
    meteredUnitsSent: row?.meteredUnitsSent ?? 0,
    includedFetches: row?.includedFetches ?? null,
  };
}

function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** A usage row the metering flush may owe the provider for. */
export interface MeterableUsage {
  orgId: string;
  periodStart: Date;
  secretFetches: number;
  meteredUnitsSent: number;
  /** The allowance the month was counted against — the figure it is billed past. */
  includedFetches: number;
  subscription: SubscriptionRecord;
}

/**
 * Usage rows that may owe the provider something — the overage report's work
 * list, one page of it, in primary-key order so a run can page past any number.
 * Only rows where the answer can be more than zero:
 *
 *  - **On a subscription the provider bills**, in this deployment's Dodo mode.
 *  - **In a period the subscription paid for** (`metered_from`): a period that
 *    began before the subscription's activation, or before its trial ended, is
 *    never metered — fetches made on Free, or during a trial, are not billed by
 *    the subscription that came after them. Rows of a subscription still on
 *    trial are left out for the same reason.
 *  - **Past another whole unit of the month's own allowance** — the
 *    `included_fetches` recorded when it opened, never the plan the
 *    organisation is on today: a Team month is billed past Team's allowance
 *    after a downgrade to Pro, and a month support raised keeps its raise
 *    after the override is cleared. A month with no allowance recorded is
 *    never listed. A row that cannot owe is never listed either, so it can
 *    never crowd out one that does.
 */
export async function listMeterableUsage(
  exec: Executor,
  options: {
    since: Date;
    limit: number;
    /** The deployment's Dodo mode; rows recorded under the other one are left out. */
    mode: 'test_mode' | 'live_mode';
    /** The last row of the previous page. */
    after?: { orgId: string; periodStart: Date } | undefined;
  },
): Promise<MeterableUsage[]> {
  const unit = FETCHES_PER_METERED_UNIT;
  const after = options.after;
  const rows = await exec
    .select({ usage: orgUsageCounters, subscription: orgSubscriptions })
    .from(orgUsageCounters)
    .innerJoin(orgSubscriptions, eq(orgSubscriptions.orgId, orgUsageCounters.orgId))
    .where(
      and(
        gt(orgUsageCounters.updatedAt, options.since),
        ne(orgSubscriptions.plan, 'free'),
        ne(orgSubscriptions.status, 'trialing'),
        isNotNull(orgSubscriptions.dodoCustomerId),
        isNotNull(orgSubscriptions.dodoSubscriptionId),
        or(isNull(orgSubscriptions.dodoMode), eq(orgSubscriptions.dodoMode, options.mode)),
        isNotNull(orgSubscriptions.meteredFrom),
        sql`${orgUsageCounters.periodStart} >= ${orgSubscriptions.meteredFrom}`,
        sql`(${orgSubscriptions.trialEndsAt} is null or ${orgUsageCounters.periodStart} >= ${orgSubscriptions.trialEndsAt})`,
        isNotNull(orgUsageCounters.includedFetches),
        sql`${orgUsageCounters.secretFetches} >= ${orgUsageCounters.includedFetches} + (${orgUsageCounters.meteredUnitsSent} + 1) * ${unit}::bigint`,
        after === undefined
          ? undefined
          : sql`(${orgUsageCounters.orgId}, ${orgUsageCounters.periodStart}) > (${after.orgId}::uuid, ${after.periodStart.toISOString()}::timestamptz)`,
      ),
    )
    .orderBy(asc(orgUsageCounters.orgId), asc(orgUsageCounters.periodStart))
    .limit(options.limit);

  return rows.map((row) => ({
    orgId: row.usage.orgId,
    periodStart: row.usage.periodStart,
    secretFetches: row.usage.secretFetches,
    meteredUnitsSent: row.usage.meteredUnitsSent,
    // Listed only with one recorded.
    includedFetches: row.usage.includedFetches ?? Number.MAX_SAFE_INTEGER,
    subscription: row.subscription,
  }));
}

/**
 * Records that the provider has accepted every unit up to `sentUpTo`.
 *
 * `GREATEST`, not an addition. Units are reported with deterministic ids, so
 * the provider is idempotent on its side; this makes the record idempotent on
 * ours. Two flushes that both reported units 0–9 both write 10, never 20 — an
 * addition here would mark units as billed that never were, and quietly stop
 * the next ten from being reported at all.
 */
export async function markMeteredUnitsSent(
  exec: Executor,
  orgId: string,
  periodStart: Date,
  sentUpTo: number,
): Promise<void> {
  if (!Number.isSafeInteger(sentUpTo) || sentUpTo <= 0) return;
  await exec
    .insert(orgUsageCounters)
    .values({ orgId, periodStart, secretFetches: 0, meteredUnitsSent: sentUpTo })
    .onConflictDoUpdate({
      target: [orgUsageCounters.orgId, orgUsageCounters.periodStart],
      set: {
        meteredUnitsSent: sql`greatest(${orgUsageCounters.meteredUnitsSent}, ${sentUpTo})`,
        updatedAt: new Date(),
      },
    });
}

/* ── reminders ─────────────────────────────────────────────────────────────── */

/**
 * Claims a reminder, returning false when it was already sent.
 *
 * **This is the deduplication**, the same way `claimWebhookEvent` is: the insert
 * wins the primary key or it does not, so two hourly runs racing cannot both
 * send. Claimed before the mail goes, so a mail provider that is down costs a
 * reminder rather than duplicating one — a missed "your trial ends tomorrow"
 * is an inconvenience, five of them is the mail bomb the throttle exists to
 * prevent.
 */
export async function claimReminder(
  exec: Executor,
  reminder: { orgId: string; kind: BillingReminderKind; occasion: string },
): Promise<boolean> {
  const inserted = await exec
    .insert(billingReminders)
    .values({ ...reminder, occasion: reminder.occasion.slice(0, 128) })
    .onConflictDoNothing()
    .returning({ orgId: billingReminders.orgId });
  return inserted.length > 0;
}

/** Whether a reminder of this kind went out for this organisation since `since`. */
export async function reminderSentSince(
  exec: Executor,
  orgId: string,
  kind: BillingReminderKind,
  since: Date,
): Promise<boolean> {
  const [row] = await exec
    .select({ orgId: billingReminders.orgId })
    .from(billingReminders)
    .where(
      and(
        eq(billingReminders.orgId, orgId),
        eq(billingReminders.kind, kind),
        gt(billingReminders.sentAt, since),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Housekeeping: forgets reminders sent before `before`. */
export async function pruneReminders(exec: Executor, before: Date): Promise<void> {
  await exec.delete(billingReminders).where(lt(billingReminders.sentAt, before));
}

/* ── idempotent owner requests ─────────────────────────────────────────────── */

export type BillingRequestClaim =
  /** First use of the key: go ahead, then `completeBillingRequest`. */
  | { state: 'claimed' }
  /** The key was used for this same request, which finished: its answer. */
  | { state: 'replay'; result: Record<string, unknown> }
  /** The key was used for this same request, which has not finished yet. */
  | { state: 'in-flight' }
  /** The key was used for a different request. */
  | { state: 'mismatch' };

/**
 * Claims an idempotency key for an owner's checkout or plan change. The
 * primary key is the deduplication: two requests with one key cannot both
 * claim it, and the second is told what became of the first.
 */
export async function claimBillingRequest(
  exec: Executor,
  request: { orgId: string; kind: BillingRequestKind; key: string; fingerprint: string },
): Promise<BillingRequestClaim> {
  const inserted = await exec
    .insert(billingRequests)
    .values({
      orgId: request.orgId,
      kind: request.kind,
      idempotencyKey: request.key,
      fingerprint: request.fingerprint,
    })
    .onConflictDoNothing()
    .returning({ key: billingRequests.idempotencyKey });
  if (inserted.length > 0) return { state: 'claimed' };

  const [existing] = await exec
    .select({ fingerprint: billingRequests.fingerprint, result: billingRequests.result })
    .from(billingRequests)
    .where(
      and(
        eq(billingRequests.orgId, request.orgId),
        eq(billingRequests.kind, request.kind),
        eq(billingRequests.idempotencyKey, request.key),
      ),
    )
    .limit(1);
  // Gone between the two statements (a failure released it): treat as in flight
  // rather than claim it twice in one call; the caller's retry claims it.
  if (!existing) return { state: 'in-flight' };
  if (existing.fingerprint !== request.fingerprint) return { state: 'mismatch' };
  return existing.result === null
    ? { state: 'in-flight' }
    : { state: 'replay', result: existing.result };
}

/** Stores the answer a claimed request produced, for any replay of its key. */
export async function completeBillingRequest(
  exec: Executor,
  request: {
    orgId: string;
    kind: BillingRequestKind;
    key: string;
    result: Record<string, unknown>;
  },
): Promise<void> {
  await exec
    .update(billingRequests)
    .set({ result: request.result })
    .where(
      and(
        eq(billingRequests.orgId, request.orgId),
        eq(billingRequests.kind, request.kind),
        eq(billingRequests.idempotencyKey, request.key),
      ),
    );
}

/** Lets go of a claim whose request failed, so the same key can try again. */
export async function releaseBillingRequest(
  exec: Executor,
  request: { orgId: string; kind: BillingRequestKind; key: string },
): Promise<void> {
  await exec
    .delete(billingRequests)
    .where(
      and(
        eq(billingRequests.orgId, request.orgId),
        eq(billingRequests.kind, request.kind),
        eq(billingRequests.idempotencyKey, request.key),
        isNull(billingRequests.result),
      ),
    );
}

/** Housekeeping: forgets idempotency keys used before `before`. */
export async function pruneBillingRequests(exec: Executor, before: Date): Promise<void> {
  await exec.delete(billingRequests).where(lt(billingRequests.createdAt, before));
}

/* ── licence keys ──────────────────────────────────────────────────────────── */

/**
 * Records a licence key the provider issued — **never the key itself**.
 * Returns false for one already recorded.
 */
export async function recordLicenseKey(
  exec: Executor,
  licence: {
    licenseKeyId: string;
    productId: string;
    dodoCustomerId: string | null;
    dodoSubscriptionId: string | null;
    dodoPaymentId: string | null;
    activationsLimit: number | null;
    expiresAt: Date | null;
    issuedAt: Date | null;
  },
): Promise<boolean> {
  const inserted = await exec
    .insert(billingLicenseKeys)
    .values(licence)
    .onConflictDoNothing()
    .returning({ id: billingLicenseKeys.licenseKeyId });
  return inserted.length > 0;
}

/* ── the billing screen ────────────────────────────────────────────────────── */

/**
 * The countables the billing screen warns about, in one round trip.
 *
 * For the dashboard only — never the request path of anything else.
 */
export async function billingCounts(
  exec: Executor,
  orgId: string,
  now: Date,
): Promise<{
  seatedMembers: number;
  pendingInvitations: number;
  projects: number;
  serviceTokens: number;
}> {
  const [row] = await exec
    .select({
      seatedMembers: sql<number>`(select count(*)::int from ${orgMembers}
        where ${orgMembers.orgId} = ${orgId} and ${orgMembers.seatAssigned})`,
      pendingInvitations: sql<number>`(select count(*)::int from ${invitations}
        where ${invitations.orgId} = ${orgId}
          and ${invitations.acceptedAt} is null
          and ${invitations.revokedAt} is null
          and ${invitations.expiresAt} > ${now})`,
      projects: sql<number>`(select count(*)::int from ${projects}
        where ${projects.orgId} = ${orgId} and ${projects.deletedAt} is null)`,
      serviceTokens: sql<number>`(select count(*)::int from ${serviceTokens}
        where ${serviceTokens.orgId} = ${orgId} and ${serviceTokens.revokedAt} is null)`,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  return {
    seatedMembers: Number(row?.seatedMembers ?? 0),
    pendingInvitations: Number(row?.pendingInvitations ?? 0),
    projects: Number(row?.projects ?? 0),
    serviceTokens: Number(row?.serviceTokens ?? 0),
  };
}

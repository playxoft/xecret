import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { FREE_SEAT_LIMIT, resolveBilledSeats } from '@xecret/core/entitlements';
import type { BillingInterval, PlanId, SeatDecision } from '@xecret/core/entitlements';
import {
  billingCheckouts,
  orgSubscriptions,
  promoCodeRedemptions,
  promoCodes,
} from '../schema/billing';
import type { PromoCodeKind, PromoDiscountType } from '../schema/billing';
import { users } from '../schema/identity';
import { orgMembers, organizations } from '../schema/tenancy';
import {
  awaitingActivation,
  detachFromProvider,
  lockSubscription,
  operatorBillingEdit,
  operatorManaged,
  raiseCurrentUsageAllowance,
} from './billing';
import type { Executor, Transaction } from './shared';
import type { SubscriptionRecord } from './subscriptions';

/**
 * Complimentary plans and promo codes (migration 0035): what xecret's own
 * admins hand out, from the admin page or `plan:set`, and what an owner
 * redeems with a code.
 *
 * ── A grant is the operator's grant that already existed ──
 * A paid plan with no Dodo subscription behind it (`operatorManaged`) — the
 * row `plan:set` has always written, and that the webhook, the hourly sweeps
 * and the reconciler already leave alone. What is new is that it can end
 * (`grant_ends_at`), and that it can be written from somewhere other than a
 * shell. The rules for writing one over a row Dodo bills are `plan:set`'s own
 * (`operatorBillingEdit`), so the admin page and the script cannot disagree.
 *
 * ── These write what they are told ──
 * Who may grant is the caller's question (`server/admin.ts`), and so is the
 * audit row: an admin in a browser and an operator at a shell are different
 * actors, and the caller knows which one it is.
 */

/** A paid plan an admin can grant. Enterprise included: it is never bought at checkout. */
export type GrantablePlan = Exclude<PlanId, 'free'>;

/** Why a grant was not written. */
export type GrantRefusal =
  /** No live organisation with that id. */
  | 'not-found'
  /** Dodo bills it, and the caller did not say to take it off Dodo. */
  | 'billed-by-dodo'
  /** A paid checkout is waiting for its subscription to activate. */
  | 'awaiting-activation'
  /** A redemption only: the organisation already has a grant or a contract. */
  | 'already-granted'
  /** A redemption only: the organisation already pays for a plan. */
  | 'already-subscribed';

export interface PlanGrantRequest {
  orgId: string;
  plan: GrantablePlan;
  /**
   * The seat ceiling to set, or `null` to keep `resolveBilledSeats`' own
   * answer — which never lowers what invitations are refused against.
   */
  seats: number | null;
  /** When it ends; `null` for no end. The caller checks it is in the future. */
  endsAt: Date | null;
  /** The line the billing screen shows about where it came from. */
  note: string;
  /**
   * Take an organisation Dodo bills off its subscription first — `plan:set
   * --over-dodo`. Its subscription keeps billing at Dodo until somebody
   * cancels it there.
   */
  overDodo: boolean;
  /**
   * A redemption: only an organisation on Free with nothing pending may take
   * one. An admin may also replace a grant (extend it, change its plan).
   */
  onlyFromFree: boolean;
}

export type PlanGrantOutcome =
  | {
      ok: true;
      previous: SubscriptionRecord;
      row: SubscriptionRecord;
      seats: SeatDecision;
      /** The Dodo subscription the row was taken off, when it was. */
      detached: { dodoSubscriptionId: string | null } | null;
    }
  | { ok: false; refusal: GrantRefusal };

/**
 * Writes a grant, in the caller's transaction — the plan, the seat pair, the
 * end date and the note together, or none of them.
 *
 * The subscription row is locked first, as every webhook locks it, so a
 * grant and a webhook for the same organisation apply one after the other.
 */
export async function applyPlanGrant(
  tx: Transaction,
  request: PlanGrantRequest,
): Promise<PlanGrantOutcome> {
  const [org] = await tx
    .select({ seatLimit: organizations.seatLimit })
    .from(organizations)
    .where(and(eq(organizations.id, request.orgId), isNull(organizations.deletedAt)))
    .limit(1);
  if (org === undefined) return { ok: false, refusal: 'not-found' };

  // Every organisation has a row (migration 0016, `provisionOrganization`);
  // a missing one is created rather than refused, as `plan:set` does.
  let row = await lockSubscription(tx, request.orgId);
  if (row === null) {
    await tx.insert(orgSubscriptions).values({ orgId: request.orgId }).onConflictDoNothing();
    row = await lockSubscription(tx, request.orgId);
    if (row === null) return { ok: false, refusal: 'not-found' };
  }
  const previous = row;

  if (request.onlyFromFree) {
    if (awaitingActivation(row)) return { ok: false, refusal: 'awaiting-activation' };
    if (operatorManaged(row)) return { ok: false, refusal: 'already-granted' };
    if (row.plan !== 'free') return { ok: false, refusal: 'already-subscribed' };
  }

  const edit = operatorBillingEdit(row, { touchesBilling: true, overDodo: request.overDodo });
  if (edit === 'refuse') {
    return {
      ok: false,
      refusal: awaitingActivation(row) ? 'awaiting-activation' : 'billed-by-dodo',
    };
  }
  const detached = edit === 'detach' ? await detachFromProvider(tx, request.orgId) : null;

  const seats = resolveBilledSeats({
    plan: request.plan,
    requested: request.seats,
    billed: row.seats,
    enforced: org.seatLimit,
  });

  // The interval means nothing to a plan nobody is billed for, but the schema
  // requires one on every paid plan: the one it had, or yearly — as `plan:set`.
  const interval: BillingInterval = row.billingInterval ?? 'yearly';
  const now = new Date();
  const [updated] = await tx
    .update(orgSubscriptions)
    .set({
      plan: request.plan,
      billingInterval: interval,
      status: 'active',
      seats: seats.billed,
      grantEndsAt: request.endsAt,
      grantNote: request.note,
      updatedAt: now,
    })
    .where(eq(orgSubscriptions.orgId, request.orgId))
    .returning();
  // Thrown, not returned: returning from a transaction callback commits it,
  // and the detach above would be left on disk without the grant it was for.
  if (updated === undefined) throw new Error('The subscription UPDATE matched no row.');

  await tx
    .update(organizations)
    .set({ seatLimit: seats.enforced, updatedAt: now })
    .where(eq(organizations.id, request.orgId));

  // A plan's larger allowance counts for the month it is granted in, as it
  // does for `plan:set --plan`.
  await raiseCurrentUsageAllowance(tx, request.orgId);

  return {
    ok: true,
    previous,
    row: updated,
    seats,
    detached: detached === null ? null : { dodoSubscriptionId: detached.dodoSubscriptionId },
  };
}

/**
 * Ends a grant now: the organisation returns to Free. `null` when there is no
 * grant to end — the row is on Free, or Dodo bills it, or (with `dueBy`) its
 * end date has moved past `dueBy` since it was listed.
 *
 * What a subscription that ends leaves behind, it leaves too: seats billed
 * back to one, the access ceiling back to Free's, nobody already seated
 * removed. Add-ons and support's limit overrides are kept — they were set on
 * the organisation, not bought with the plan, and they are raise-only.
 */
export async function endPlanGrant(
  tx: Transaction,
  orgId: string,
  options: { dueBy?: Date } = {},
): Promise<{ previous: SubscriptionRecord; row: SubscriptionRecord } | null> {
  const row = await lockSubscription(tx, orgId);
  if (row === null || !operatorManaged(row)) return null;
  if (
    options.dueBy !== undefined &&
    (row.grantEndsAt === null || row.grantEndsAt.getTime() > options.dueBy.getTime())
  ) {
    return null;
  }

  const now = new Date();
  const [updated] = await tx
    .update(orgSubscriptions)
    .set({
      plan: 'free',
      billingInterval: null,
      status: 'active',
      seats: 1,
      grantEndsAt: null,
      grantNote: null,
      updatedAt: now,
    })
    .where(eq(orgSubscriptions.orgId, orgId))
    .returning();
  if (updated === undefined) throw new Error('The subscription UPDATE matched no row.');

  await tx
    .update(organizations)
    .set({ seatLimit: FREE_SEAT_LIMIT, updatedAt: now })
    .where(eq(organizations.id, orgId));

  return { previous: row, row: updated };
}

/** A grant, as the admin page lists it. */
export interface GrantListing {
  orgId: string;
  orgName: string;
  orgSlug: string;
  plan: SubscriptionRecord['plan'];
  seats: number;
  seatLimit: number;
  grantEndsAt: Date | null;
  grantNote: string | null;
  updatedAt: Date;
}

/**
 * Every live grant — operator-managed rows, Enterprise contracts included —
 * soonest to end first, then the ones with no end. Bounded.
 */
export async function listPlanGrants(exec: Executor, limit: number): Promise<GrantListing[]> {
  return exec
    .select({
      orgId: orgSubscriptions.orgId,
      orgName: organizations.name,
      orgSlug: organizations.slug,
      plan: orgSubscriptions.plan,
      seats: orgSubscriptions.seats,
      seatLimit: organizations.seatLimit,
      grantEndsAt: orgSubscriptions.grantEndsAt,
      grantNote: orgSubscriptions.grantNote,
      updatedAt: orgSubscriptions.updatedAt,
    })
    .from(orgSubscriptions)
    .innerJoin(
      organizations,
      and(eq(organizations.id, orgSubscriptions.orgId), isNull(organizations.deletedAt)),
    )
    .where(operatorManagedSql())
    .orderBy(sql`${orgSubscriptions.grantEndsAt} asc nulls last`, asc(organizations.slug))
    .limit(limit);
}

/** `operatorManaged`, as SQL over `org_subscriptions`. */
function operatorManagedSql() {
  return and(
    ne(orgSubscriptions.plan, 'free'),
    or(isNull(orgSubscriptions.dodoSubscriptionId), isNull(orgSubscriptions.dodoProductId)),
  );
}

/**
 * Grants whose end date is at or before `before` — the hourly job's two lists:
 * the ones due to end now, and the ones a reminder is due for. Soonest first.
 */
export async function listGrantsEndingBy(
  exec: Executor,
  options: { before: Date; limit: number },
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
        isNotNull(orgSubscriptions.grantEndsAt),
        lte(orgSubscriptions.grantEndsAt, options.before),
        operatorManagedSql(),
      ),
    )
    .orderBy(asc(orgSubscriptions.grantEndsAt))
    .limit(options.limit)
    .then((rows) => rows.map((row) => row.subscription));
}

/* ── the admin page's search ───────────────────────────────────────────────── */

/** An organisation as the admin page shows it: who is in it, and what it is on. */
export interface AdminOrganization {
  id: string;
  name: string;
  slug: string;
  /** The searched-for person's role in it, when the search was by address. */
  role: string | null;
  seatLimit: number;
  createdAt: Date;
  subscription: SubscriptionRecord;
}

/**
 * The live organisations a person belongs to, found by their address — or the
 * one organisation with this slug, or this id. Bounded; deleted organisations
 * left out.
 *
 * Membership of any status is listed, so an admin looking for "the team
 * Priya's in" finds it whether or not Priya is its owner; the role says which.
 */
export async function findOrganizationsForAdmin(
  exec: Executor,
  query: { email: string } | { slug: string } | { id: string },
  limit: number,
): Promise<AdminOrganization[]> {
  const columns = {
    id: organizations.id,
    name: organizations.name,
    slug: organizations.slug,
    seatLimit: organizations.seatLimit,
    createdAt: organizations.createdAt,
    subscription: orgSubscriptions,
  };

  if ('slug' in query || 'id' in query) {
    const rows = await exec
      .select(columns)
      .from(organizations)
      .innerJoin(orgSubscriptions, eq(orgSubscriptions.orgId, organizations.id))
      .where(
        and(
          'slug' in query ? eq(organizations.slug, query.slug) : eq(organizations.id, query.id),
          isNull(organizations.deletedAt),
        ),
      )
      .limit(1);
    return rows.map((row) => ({ ...row, role: null }));
  }

  // `users.email` is citext: the comparison is case-insensitive in the database.
  const rows = await exec
    .select({ ...columns, role: orgMembers.role })
    .from(users)
    .innerJoin(orgMembers, eq(orgMembers.userId, users.id))
    .innerJoin(
      organizations,
      and(eq(organizations.id, orgMembers.orgId), isNull(organizations.deletedAt)),
    )
    .innerJoin(orgSubscriptions, eq(orgSubscriptions.orgId, organizations.id))
    .where(and(eq(users.email, query.email), isNull(users.deletedAt)))
    .orderBy(asc(organizations.name), asc(organizations.id))
    .limit(limit);
  return rows;
}

/* ── promo codes ───────────────────────────────────────────────────────────── */

export type PromoCodeRecord = typeof promoCodes.$inferSelect;

/** What an admin creates. Validated by the caller; the CHECKs are the backstop. */
export type NewPromoCode = {
  code: string;
  description: string | null;
  allowedEmails: string[] | null;
  maxRedemptions: number | null;
  expiresAt: Date | null;
  createdBy: string;
} & (
  | {
      kind: Extract<PromoCodeKind, 'grant'>;
      grantPlan: GrantablePlan;
      grantDays: number | null;
      grantSeats: number | null;
    }
  | {
      kind: Extract<PromoCodeKind, 'discount'>;
      discountType: PromoDiscountType;
      discountAmount: number;
      discountCurrency: string | null;
      discountCycles: number | null;
      discountPlans: ('pro' | 'team')[];
      dodoDiscountId: string;
      dodoMode: 'test_mode' | 'live_mode';
    }
);

export async function createPromoCode(
  exec: Executor,
  code: NewPromoCode,
): Promise<PromoCodeRecord> {
  const [row] = await exec
    .insert(promoCodes)
    .values(
      code.kind === 'grant'
        ? {
            code: code.code,
            kind: 'grant',
            description: code.description,
            allowedEmails: code.allowedEmails,
            maxRedemptions: code.maxRedemptions,
            expiresAt: code.expiresAt,
            createdBy: code.createdBy,
            grantPlan: code.grantPlan,
            grantDays: code.grantDays,
            grantSeats: code.grantSeats,
          }
        : {
            code: code.code,
            kind: 'discount',
            description: code.description,
            allowedEmails: code.allowedEmails,
            maxRedemptions: code.maxRedemptions,
            expiresAt: code.expiresAt,
            createdBy: code.createdBy,
            discountType: code.discountType,
            discountAmount: code.discountAmount,
            discountCurrency: code.discountCurrency,
            discountCycles: code.discountCycles,
            discountPlans: code.discountPlans,
            dodoDiscountId: code.dodoDiscountId,
            dodoMode: code.dodoMode,
          },
    )
    .returning();
  if (row === undefined) throw new Error('The promo code INSERT returned no row.');
  return row;
}

/** Whether a code is taken — revoked ones too: a code never comes to mean something else. */
export async function promoCodeExists(exec: Executor, code: string): Promise<boolean> {
  const [row] = await exec
    .select({ id: promoCodes.id })
    .from(promoCodes)
    .where(eq(promoCodes.code, code))
    .limit(1);
  return row !== undefined;
}

export async function findPromoCode(exec: Executor, code: string): Promise<PromoCodeRecord | null> {
  const [row] = await exec.select().from(promoCodes).where(eq(promoCodes.code, code)).limit(1);
  return row ?? null;
}

export async function findPromoCodeById(
  exec: Executor,
  id: string,
): Promise<PromoCodeRecord | null> {
  const [row] = await exec.select().from(promoCodes).where(eq(promoCodes.id, id)).limit(1);
  return row ?? null;
}

/** A code, with how many checkouts started with it — a discount's own count is Dodo's. */
export interface PromoCodeListing extends PromoCodeRecord {
  checkoutsStarted: number;
}

/** Newest first. Bounded. */
export async function listPromoCodes(exec: Executor, limit: number): Promise<PromoCodeListing[]> {
  const rows = await exec
    .select()
    .from(promoCodes)
    .orderBy(desc(promoCodes.createdAt), desc(promoCodes.id))
    .limit(limit);
  if (rows.length === 0) return [];

  const counts = await exec
    .select({ codeId: billingCheckouts.promoCodeId, value: sql<number>`count(*)::int` })
    .from(billingCheckouts)
    .where(
      inArray(
        billingCheckouts.promoCodeId,
        rows.map((row) => row.id),
      ),
    )
    .groupBy(billingCheckouts.promoCodeId);
  const started = new Map(counts.map((count) => [count.codeId, count.value]));
  return rows.map((row) => ({ ...row, checkoutsStarted: started.get(row.id) ?? 0 }));
}

/** Revokes a code. `false` when it was already revoked (or never existed). */
export async function revokePromoCode(
  exec: Executor,
  id: string,
  revokedBy: string,
): Promise<PromoCodeRecord | null> {
  const [row] = await exec
    .update(promoCodes)
    .set({ revokedAt: new Date(), revokedBy })
    .where(and(eq(promoCodes.id, id), isNull(promoCodes.revokedAt)))
    .returning();
  return row ?? null;
}

/** Why a grant code could not be spent. */
export type RedemptionRefusal =
  /** Revoked, expired, or every redemption it allows already used. */
  | 'unavailable'
  /** This organisation already redeemed it. */
  | 'org-redeemed'
  /** This person already redeemed it, for another organisation. */
  | 'user-redeemed';

/**
 * Spends one redemption of a grant code for an organisation, in the caller's
 * transaction — the one that then writes the grant, so a grant that fails
 * gives the redemption back.
 *
 * The count is taken in one conditional UPDATE, so two owners racing for a
 * code's last redemption cannot both get it. The once-per-organisation and
 * once-per-person rules are the redemption table's keys, checked first so a
 * refusal says which rule it was.
 */
export async function spendGrantRedemption(
  tx: Transaction,
  params: { codeId: string; orgId: string; userId: string },
): Promise<{ ok: true } | { ok: false; refusal: RedemptionRefusal }> {
  const [already] = await tx
    .select({ orgId: promoCodeRedemptions.orgId, userId: promoCodeRedemptions.userId })
    .from(promoCodeRedemptions)
    .where(
      and(
        eq(promoCodeRedemptions.codeId, params.codeId),
        or(
          eq(promoCodeRedemptions.orgId, params.orgId),
          eq(promoCodeRedemptions.userId, params.userId),
        ),
      ),
    )
    .limit(1);
  if (already !== undefined) {
    return {
      ok: false,
      refusal: already.orgId === params.orgId ? 'org-redeemed' : 'user-redeemed',
    };
  }

  const [counted] = await tx
    .update(promoCodes)
    .set({ redemptions: sql`${promoCodes.redemptions} + 1` })
    .where(
      and(
        eq(promoCodes.id, params.codeId),
        eq(promoCodes.kind, 'grant'),
        isNull(promoCodes.revokedAt),
        or(isNull(promoCodes.expiresAt), gt(promoCodes.expiresAt, sql`now()`)),
        or(
          isNull(promoCodes.maxRedemptions),
          sql`${promoCodes.redemptions} < ${promoCodes.maxRedemptions}`,
        ),
      ),
    )
    .returning({ id: promoCodes.id });
  if (counted === undefined) return { ok: false, refusal: 'unavailable' };

  // The keys are the guarantee; the read above only names the refusal. A
  // concurrent redemption that slipped between the two fails here, and its
  // transaction — the count included — rolls back with it.
  await tx.insert(promoCodeRedemptions).values({
    codeId: params.codeId,
    orgId: params.orgId,
    userId: params.userId,
  });
  return { ok: true };
}

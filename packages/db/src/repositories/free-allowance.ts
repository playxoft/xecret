import { and, count, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { FREE_ORGANIZATIONS_PER_ACCOUNT } from '@xecret/core/entitlements';
import type { StoredPlanId } from '@xecret/core/entitlements';
import { orgSubscriptions } from '../schema/billing';
import { users } from '../schema/identity';
import { organizations } from '../schema/tenancy';
import type { Executor, Transaction } from './shared';

/**
 * The free allowance: two Free organisations per account that work, and the
 * one past them waiting for a paid plan (`organizations.awaiting_paid_plan_since`,
 * migration 0037).
 *
 * ── The rule ──
 * An organisation's *open Free* count is taken over the organisations an
 * account created: on Free (no subscription row reads as Free), not deleted,
 * and not already waiting. Whether the creator is still a member of them does
 * not matter, and that is the point: leaving, or being removed, never takes an
 * organisation out of the count, so the allowance cannot be stepped round by
 * handing organisations to another account.
 *
 *  - **Creating** one while the creator already holds two open Free ones makes
 *    it wait, from the moment it exists (`provisionOrganization`).
 *  - **Dropping back to Free** (a subscription or a grant ending, or an
 *    operator setting Free) makes *that* organisation wait when its creator has
 *    two *other* open Free ones (`settleAwaitingPaidPlan`). It goes to the back
 *    of the queue; no other organisation changes, so nothing that worked
 *    yesterday starts waiting because something else lapsed.
 *  - **A paid plan or a grant** clears it (`settleAwaitingPaidPlan`).
 *
 * Nothing else writes the column: no membership change, no ownership change,
 * no reading of it. Where a deployment takes no payments, nobody can buy the
 * way out, so the rule does not apply: callers pass `applies: false`, and the
 * request path ignores a stored value (`resolveOrg`).
 *
 * Everything that decides here runs under the creator's account lock, the same
 * `SELECT … FOR UPDATE` organisation creation takes, so a creation and a lapse
 * for one account are decided one after the other and never both on a count
 * the other is about to change.
 */

/** Free, read the way `entitlementsFromRow` reads a plan: no row is Free. */
function onFree(): SQL {
  return sql`coalesce(${orgSubscriptions.plan}::text, 'free') = 'free'`;
}

/**
 * The open Free organisations `userId` created, counted no further than
 * `limit`, leaving out `excluding` (the organisation being decided).
 */
export async function countOpenFreeOrganizations(
  exec: Executor,
  userId: string,
  options: { excluding?: string | undefined; limit: number },
): Promise<number> {
  const rows = await openFreeOrganizationsQuery(exec, userId, options);
  return rows.length;
}

/** @internal Exported so the test can read the shape without a database. */
export function openFreeOrganizationsQuery(
  exec: Executor,
  userId: string,
  options: { excluding?: string | undefined; limit: number },
) {
  return exec
    .select({ id: organizations.id })
    .from(organizations)
    .leftJoin(orgSubscriptions, eq(orgSubscriptions.orgId, organizations.id))
    .where(
      and(
        eq(organizations.createdBy, userId),
        isNull(organizations.deletedAt),
        isNull(organizations.awaitingPaidPlanSince),
        onFree(),
        options.excluding === undefined ? undefined : ne(organizations.id, options.excluding),
      ),
    )
    .limit(options.limit);
}

/** How many of the organisations `userId` created are waiting for a paid plan. */
export async function countAwaitingOrganizations(exec: Executor, userId: string): Promise<number> {
  const [row] = await exec
    .select({ total: count() })
    .from(organizations)
    .leftJoin(orgSubscriptions, eq(orgSubscriptions.orgId, organizations.id))
    .where(
      and(
        eq(organizations.createdBy, userId),
        isNull(organizations.deletedAt),
        isNotNull(organizations.awaitingPaidPlanSince),
        onFree(),
      ),
    );
  return row?.total ?? 0;
}

/** How far into its free allowance an account is. See `freeOrganizationAllowance`. */
export interface FreeAllowance {
  /** Open Free organisations the account created, counted no further than the allowance. */
  free: number;
  /** How many of the organisations it created are waiting for a paid plan. */
  awaiting: number;
}

/**
 * Where an account stands against its free allowance: how many open Free
 * organisations it created, and how many of its organisations wait for a
 * plan. What the dashboard reads to say, before somebody creates one, that it
 * will need a plan, and to lock "New organisation" while one already waits.
 */
export async function freeOrganizationAllowance(
  exec: Executor,
  userId: string,
): Promise<FreeAllowance> {
  const [free, awaiting] = await Promise.all([
    countOpenFreeOrganizations(exec, userId, { limit: FREE_ORGANIZATIONS_PER_ACCOUNT }),
    countAwaitingOrganizations(exec, userId),
  ]);
  return { free, awaiting };
}

/**
 * Serialises one account's allowance decisions: the same row lock
 * `provisionOrganization` takes (`accountLockQuery` in `organizations.ts`,
 * restated here so this module needs nothing from that one). A deleted account
 * takes no lock, and holds nothing to decide against anyway.
 */
async function lockCreator(tx: Transaction, userId: string): Promise<void> {
  await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1)
    .for('update');
}

/** What a plan change did to the organisation's place in the allowance. */
export interface AllowanceSettlement {
  /** It dropped back to Free past its creator's allowance and now waits for a plan. */
  becameAwaiting: boolean;
}

/**
 * The free allowance, after a plan change: in the caller's transaction, after
 * the plan is written.
 *
 *  - A paid plan (or a grant): the organisation stops waiting, if it was.
 *  - Back to Free from a paid plan, where the rule `applies`: it waits when its
 *    creator has two other open Free organisations. Decided under the
 *    creator's account lock, so a creation for the same account is decided
 *    before or after, never beside.
 *  - Free to Free, or anything where the rule does not apply: nothing.
 *
 * Every writer of `org_subscriptions.plan` calls this: the subscription
 * snapshot and the billing jobs (`writeSubscriptionState`), a grant starting
 * and ending (`applyPlanGrant`, `endPlanGrant`) and the operator tool.
 */
export async function settleAwaitingPaidPlan(
  tx: Transaction,
  orgId: string,
  change: { previousPlan: StoredPlanId; plan: StoredPlanId; applies: boolean },
): Promise<AllowanceSettlement> {
  if (change.plan !== 'free') {
    await tx
      .update(organizations)
      .set({ awaitingPaidPlanSince: null })
      .where(and(eq(organizations.id, orgId), isNotNull(organizations.awaitingPaidPlanSince)));
    return { becameAwaiting: false };
  }
  if (change.previousPlan === 'free' || !change.applies) return { becameAwaiting: false };

  const [org] = await tx
    .select({
      createdBy: organizations.createdBy,
      awaitingPaidPlanSince: organizations.awaitingPaidPlanSince,
    })
    .from(organizations)
    .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)))
    .limit(1);
  if (org === undefined || org.awaitingPaidPlanSince !== null) return { becameAwaiting: false };

  await lockCreator(tx, org.createdBy);
  const others = await countOpenFreeOrganizations(tx, org.createdBy, {
    excluding: orgId,
    limit: FREE_ORGANIZATIONS_PER_ACCOUNT,
  });
  if (others < FREE_ORGANIZATIONS_PER_ACCOUNT) return { becameAwaiting: false };

  await tx
    .update(organizations)
    .set({ awaitingPaidPlanSince: new Date() })
    .where(eq(organizations.id, orgId));
  return { becameAwaiting: true };
}

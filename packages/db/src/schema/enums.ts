import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * PostgreSQL enums are additive-only: values can be appended without a table
 * rewrite, but never removed. Chosen over check constraints so the type flows
 * into TypeScript automatically.
 */

export const orgRoleEnum = pgEnum('org_role', ['owner', 'admin', 'developer', 'viewer']);

export const memberStatusEnum = pgEnum('member_status', ['active', 'suspended']);

export const keyStatusEnum = pgEnum('key_status', ['active', 'retired', 'compromised']);

export const accessLevelEnum = pgEnum('access_level', ['none', 'read', 'write', 'admin']);

export const actorTypeEnum = pgEnum('actor_type', ['user', 'cli_token', 'service_token', 'system']);

export const auditOutcomeEnum = pgEnum('audit_outcome', ['success', 'denied', 'error']);

/**
 * Billing enums. Ordered weakest to strongest, matching `PLAN_RANK` in
 * `@xecret/core/entitlements` — Postgres orders enum values by declaration, so
 * `ORDER BY plan` sorts the way a human expects without a CASE expression.
 */
/**
 * `scale` is **retired and cannot be removed.**
 *
 * The tier was withdrawn — four self-serve rungs asked a buyer to make a
 * distinction they had no basis for — but a Postgres enum is additive-only, so
 * the value stays in the type for as long as the column does. It is absent from
 * `PlanId` in `@xecret/core/entitlements` and present in `StoredPlanId`;
 * `resolvePlanId` maps it to Team, which is what its holders were sold.
 *
 * Do not reuse the name for something else, and do not attempt to drop it: the
 * only way to remove an enum value is to rewrite the type and every column using
 * it, which is a migration with an exclusive lock on the table every tenant
 * authorises through.
 */
export const planIdEnum = pgEnum('plan_id', ['free', 'pro', 'team', 'scale', 'enterprise']);

export const billingIntervalEnum = pgEnum('billing_interval', ['monthly', 'yearly']);

/**
 * Mirrors the payment provider's subscription lifecycle.
 *
 * `past_due` and `on_hold` are distinct on purpose: the first is a payment that
 * has not settled yet, the second is one that has failed. Neither removes any
 * access — see `isDataPlaneActive`.
 */
export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'active',
  'trialing',
  'past_due',
  'on_hold',
  'cancelled',
  'expired',
]);

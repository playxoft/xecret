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

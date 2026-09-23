/**
 * Ceiling checks, and the error a refusal produces.
 *
 * Two ceilings exist and they behave differently:
 *
 *   - A **plan limit** is a wall we sell against. Free gets 5 projects; the
 *     sixth is refused, with the plan that would allow it named in the refusal.
 *   - A **fair-use ceiling** applies where a plan limit is `null`. It warns and
 *     never refuses. Crossing one starts a support conversation, not a 403.
 *
 * Collapsing them would turn every "unlimited" on the pricing page into a lie,
 * so `checkLimit` returns a three-state verdict rather than a boolean.
 */

import { cheapestPlanWithLimit, FAIR_USE, WARN_AT } from './plans';
import type { Entitlements, LimitedResource, LimitVerdict, PlanId, PlanLimits } from './types';

/** Fair-use ceilings, indexed by the resources that have one. */
const FAIR_USE_BY_RESOURCE: Readonly<Partial<Record<LimitedResource, number | null>>> = FAIR_USE;

/**
 * Can this organisation add one more `resource`, given it currently has `current`?
 *
 * `current` is the count **before** the addition. A plan allowing 5 projects
 * refuses at `current === 5`, because the request would make it 6.
 *
 * Reads only the resolved entitlements, never a plan id, so support overrides
 * and add-ons are honoured automatically.
 */
export function checkLimit(
  entitlements: Entitlements,
  resource: LimitedResource,
  current: number,
): LimitVerdict {
  const limit = entitlements.limits[resource];

  // ── Unlimited for billing: only fair use applies, and it only warns. ──
  if (limit === null) {
    const ceiling = FAIR_USE_BY_RESOURCE[resource];
    if (typeof ceiling === 'number' && current >= ceiling) {
      return { kind: 'warn', limit: null, current, reason: 'fairUse' };
    }
    return { kind: 'ok', limit: null, current };
  }

  if (current >= limit) {
    return {
      kind: 'exceeded',
      limit,
      current,
      upgradeTo: nextPlanFor(entitlements.plan, resource, current + 1),
    };
  }

  // 80% of a hard ceiling. Early enough to act on, late enough not to be noise.
  if (limit > 0 && current / limit >= WARN_AT) {
    return { kind: 'warn', limit, current, reason: 'approaching' };
  }

  return { kind: 'ok', limit, current };
}

/**
 * The cheapest plan strictly above `from` that would allow `required`.
 *
 * Strictly above, because recommending the plan the customer is already on is
 * worse than recommending nothing — it reads as a bug, and it is the kind of
 * bug that makes people distrust the rest of the billing surface. `null` when
 * no plan clears it, which is the honest answer for a genuinely unusual
 * request: the dashboard renders "contact us" rather than a checkout button.
 */
function nextPlanFor(from: PlanId, resource: keyof PlanLimits, required: number): PlanId | null {
  const candidate = cheapestPlanWithLimit(resource, required);
  if (candidate === null || candidate === from) return null;
  return candidate;
}

/** Does this organisation hold the named capability? */
export function hasFeature(
  entitlements: Entitlements,
  feature: keyof Entitlements['features'],
): boolean {
  return entitlements.features[feature];
}

/** Does it hold the named separately-purchased add-on? */
export function hasAddon(entitlements: Entitlements, addon: keyof Entitlements['addons']): boolean {
  return entitlements.addons[addon];
}

/**
 * The machine-readable body of a plan refusal.
 *
 * A bare 403 is a dead end: the dashboard cannot render an upgrade path from
 * it and the CLI cannot print a useful hint. Every entitlement refusal carries
 * enough for both — what was refused, what the ceiling was, and which plan
 * would have allowed it.
 *
 * No secret, key name, or organisation-identifying value ever appears here.
 * These bodies are logged.
 */
export interface PlanLimitError {
  readonly error: 'plan_limit';
  readonly resource: string;
  readonly limit: number | null;
  readonly current: number | null;
  readonly plan: PlanId;
  readonly upgradeTo: PlanId | null;
  readonly message: string;
}

/** Build the refusal body for a ceiling that has been reached. */
export function limitError(
  entitlements: Entitlements,
  resource: LimitedResource,
  verdict: Extract<LimitVerdict, { kind: 'exceeded' }>,
): PlanLimitError {
  return {
    error: 'plan_limit',
    resource,
    limit: verdict.limit,
    current: verdict.current,
    plan: entitlements.plan,
    upgradeTo: verdict.upgradeTo,
    message: verdict.upgradeTo
      ? `This organisation is on the ${entitlements.plan} plan, which allows ${verdict.limit} ${resource}. The ${verdict.upgradeTo} plan allows more.`
      : `This organisation has reached its limit of ${verdict.limit} ${resource}.`,
  };
}

/** Build the refusal body for a capability the plan does not include. */
export function featureError(
  entitlements: Entitlements,
  feature: keyof Entitlements['features'],
  upgradeTo: PlanId | null,
): PlanLimitError {
  return {
    error: 'plan_limit',
    resource: feature,
    limit: null,
    current: null,
    plan: entitlements.plan,
    upgradeTo,
    message: upgradeTo
      ? `${feature} is not included in the ${entitlements.plan} plan. It is available from ${upgradeTo}.`
      : `${feature} is not available on this organisation's plan.`,
  };
}

/**
 * Metered units owed for a period, given the raw fetch count and what was sent.
 *
 * Returns whole units only — a partial thousand is not billed until it
 * completes, which errs in the customer's favour and makes the arithmetic
 * stable across a flush that arrives mid-thousand.
 *
 * Never negative: a counter reset or a replayed flush produces `0`, not a
 * credit. Refunds are a human decision, not an arithmetic side effect.
 */
export function meteredUnitsOwed(
  totalFetches: number,
  includedFetches: number,
  unitsAlreadySent: number,
  fetchesPerUnit: number,
): number {
  const billable = Math.max(0, totalFetches - includedFetches);
  const owed = Math.floor(billable / fetchesPerUnit) - unitsAlreadySent;
  return Math.max(0, owed);
}

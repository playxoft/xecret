/**
 * Ceiling checks, and the error a refusal produces.
 *
 * Two ceilings exist and they behave differently:
 *
 *   - A **plan limit** is a wall we sell against. Free gets 5 projects; the
 *     sixth is refused, with the plan that would allow it named in the refusal.
 *     Enforced from the day it is published, at every place the thing is
 *     created — and only there: what an organisation already holds past a
 *     ceiling stays readable and editable, and is never deleted or locked.
 *   - A **fair-use ceiling** applies where a plan limit is `null`. It warns and
 *     never refuses. Crossing one starts a support conversation, not a 403.
 *
 * Collapsing them would turn every "unlimited" on the pricing page into a lie,
 * so `checkLimit` returns a three-state verdict rather than a boolean.
 */

import { FAIR_USE, PLAN_IDS, PLAN_RANK, PLANS, WARN_AT } from './plans';
import type { Entitlements, LimitedResource, LimitVerdict, PlanId, PlanLimits } from './types';

/** Fair-use ceilings, indexed by the resources that have one. */
const FAIR_USE_BY_RESOURCE: Readonly<Partial<Record<LimitedResource, number | null>>> = FAIR_USE;

/**
 * Can this organisation add `adding` more `resource`, given it currently has
 * `current`?
 *
 * `current` is the count **before** the addition. A plan allowing 5 projects
 * refuses at `current === 5`, because the request would make it 6. `adding`
 * is one unless a single request creates several — an import, a promotion, a
 * project arriving with its environments — and the batch is refused whole when
 * it would carry the count past the ceiling.
 *
 * An organisation already **over** a ceiling — one that downgraded, or that
 * held more before a limit was enforced — is refused only further additions.
 * Nothing here ever asks for what exists to be taken away.
 *
 * Reads only the resolved entitlements, never a plan id, so support overrides
 * and add-ons are honoured automatically.
 */
export function checkLimit(
  entitlements: Entitlements,
  resource: LimitedResource,
  current: number,
  adding = 1,
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

  // Nothing added can exceed nothing: an organisation over its ceiling may still
  // change what it has. A malformed count is read as one, never as zero — a
  // check that fails open on bad input is not a check.
  const adds = Number.isFinite(adding) ? Math.max(0, Math.trunc(adding)) : 1;
  const required = current + adds;
  if (adds > 0 && required > limit) {
    return {
      kind: 'exceeded',
      limit,
      current,
      upgradeTo: nextPlanFor(entitlements.plan, resource, required),
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
  // Ranked, not merely "not the same plan": the cheapest plan that clears the
  // requirement can be one *below* `from` — an Enterprise contract with a lower
  // ceiling than Free's on some resource — and "upgrade to Free" is the worst
  // answer this function could give.
  for (const id of PLAN_IDS) {
    if (PLAN_RANK[id] <= PLAN_RANK[from]) continue;
    const limit = PLANS[id].limits[resource];
    if (limit === null || limit >= required) return id;
  }
  return null;
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

/**
 * How each limited resource reads in a sentence, singular and plural.
 *
 * The refusal's message is what a person sees — the dashboard renders it, the
 * CLI prints it — so it names `secretsPerEnvironment` the way the pricing page
 * does rather than the way the code does. The machine-readable name stays in
 * `resource`, beside it.
 */
const RESOURCE_NOUNS: Readonly<Record<LimitedResource, readonly [string, string]>> = Object.freeze({
  organizations: ['organisation', 'organisations'],
  projects: ['project', 'projects'],
  environmentsPerProject: ['environment per project', 'environments per project'],
  serviceTokens: ['service token', 'service tokens'],
  seats: ['member', 'members'],
  cliDevicesPerUser: ['CLI device per person', 'CLI devices per person'],
  webhooks: ['webhook', 'webhooks'],
  secretsPerEnvironment: ['secret per environment', 'secrets per environment'],
});

/** `5 projects`, `1 organisation`, `1,000 secrets per environment`. */
export function describeLimit(resource: LimitedResource, limit: number): string {
  const [one, many] = RESOURCE_NOUNS[resource];
  return `${limit.toLocaleString('en-US')} ${limit === 1 ? one : many}`;
}

/** Build the refusal body for a ceiling that has been reached. */
export function limitError(
  entitlements: Entitlements,
  resource: LimitedResource,
  verdict: Extract<LimitVerdict, { kind: 'exceeded' }>,
): PlanLimitError {
  const allows = describeLimit(resource, verdict.limit);
  return {
    error: 'plan_limit',
    resource,
    limit: verdict.limit,
    current: verdict.current,
    plan: entitlements.plan,
    upgradeTo: verdict.upgradeTo,
    message: verdict.upgradeTo
      ? `This organisation is on the ${PLANS[entitlements.plan].name} plan, which allows ${allows}. The ${PLANS[verdict.upgradeTo].name} plan allows more.`
      : `This organisation has reached its limit of ${allows}.`,
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

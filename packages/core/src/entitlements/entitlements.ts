/**
 * Resolving one organisation's entitlements, and the fail-open rule.
 *
 * Two functions matter here. `resolveEntitlements` turns a billing row into the
 * frozen object enforcement reads. `isDataPlaneActive` decides whether a lapsed
 * subscription may still fetch secrets — and the answer is always yes.
 */

import { DEFAULT_PLAN, NULLABLE_LIMITS, PLANS, RETIRED_PLANS } from './plans';
import type {
  Entitlements,
  OrgAddons,
  PlanId,
  PlanLimits,
  SubscriptionState,
  SubscriptionStatus,
} from './types';

/**
 * Statuses under which the **control plane** still accepts writes.
 *
 * Creating projects, inviting members, minting tokens. A subscription that has
 * lapsed loses these; it never loses reads, and it never loses secret fetches.
 * See `isDataPlaneActive`.
 *
 * ── Where the grace period actually lives, and why it is not here ──
 * Nowhere in this function, deliberately. A customer who cancels mid-month keeps
 * their paid month, but that is expressed by the *status* rather than by a date
 * comparison: cancelling sets `cancel_at_period_end` and leaves the status
 * `active` until the provider's webhook moves it to `cancelled` at the period
 * boundary. `current_period_end` is therefore information the dashboard and the
 * reconciler read, not an input to this decision.
 *
 * Written this way on purpose. Comparing `current_period_end` to a clock here
 * would make entitlement resolution time-dependent — the same row resolving two
 * ways either side of a boundary, in a pure function on the authorization path,
 * with a Worker clock deciding. The boundary is crossed once, by a webhook, in
 * one place, and what it writes is a status.
 *
 * `past_due` and `on_hold` are both included. A declined card is a payment
 * problem, and locking someone out of their own dashboard is a remarkably bad
 * way to ask them to update it — they cannot even reach the billing page to fix
 * it. Dunning is an email's job.
 */
const CONTROL_PLANE_ACTIVE: ReadonlySet<SubscriptionStatus> = new Set([
  'active',
  'trialing',
  'past_due',
  'on_hold',
] as const);

/**
 * **The rule that defines this product's character.**
 *
 * A secret fetch is never refused for a billing reason. Not for an expired
 * card, not for a cancelled plan, not for exceeding the included allowance.
 * This function exists to be `true`, unconditionally, and it takes a status
 * argument only so that the call sites read as deliberate rather than absent.
 *
 * Why it is written as a function that ignores its argument, rather than not
 * written at all: the alternative is enforcement code with no marker at the
 * point where a billing check would naturally go. The first person to "add the
 * missing status check" would be making a reasonable-looking change that breaks
 * a published promise. This is where that conversation happens instead, and
 * `entitlements.test.ts` asserts the answer for every status.
 *
 * The promise, from pricing-plan.md §5:
 *
 *   > A build never fails because of billing or fair use. Overage is invoiced,
 *   > not enforced.
 *
 * and §6's reasoning for why we can afford it: a secret read on Cloudflare
 * Workers makes zero external network calls, so serving a non-paying
 * organisation costs fractions of a cent. The revenue protected by refusing
 * them is smaller than the trust destroyed by a deploy that failed over an
 * invoice.
 *
 * Degrade in the dashboard. Email the owners. Never touch the data path.
 */
export function isDataPlaneActive(_status: SubscriptionStatus): true {
  return true;
}

/** Whether control-plane writes are accepted under this status. */
export function isControlPlaneActive(status: SubscriptionStatus): boolean {
  return CONTROL_PLANE_ACTIVE.has(status);
}

/**
 * Apply support-granted overrides to a plan's limits.
 *
 * **Raise-only.** An override below the plan's own ceiling is ignored, and
 * `null` (unlimited) wins wherever the limit has an unlimited to reach — see
 * `NULLABLE_LIMITS`. Two reasons: the mechanism exists to honour
 * the fair-usage promise that a ceiling hit in good faith gets raised for free,
 * and a raise-only rule means a malformed or stale override can never quietly
 * downgrade a paying customer. There is no code path that lowers a limit, so
 * there is no bug that lowers a limit.
 *
 * An override naming a field that does not exist is ignored rather than
 * throwing: these rows are written by an operator running a script, and a typo
 * in a support ticket should not take down entitlement resolution for an
 * organisation.
 */
function applyOverrides(
  limits: PlanLimits,
  overrides: Readonly<Record<string, number | null>> | undefined,
): PlanLimits {
  if (!overrides) return limits;

  const result: Record<string, number | null> = { ...limits };
  let changed = false;

  for (const [key, value] of Object.entries(overrides)) {
    // `Object.hasOwn`, not `key in limits`: `in` walks the prototype chain, so
    // an override named `constructor` or `toString` would pass the guard and
    // then write a field onto the limits object that no `LimitedResource` names.
    if (!Object.hasOwn(limits, key)) continue;

    const current = result[key];

    // Already unlimited: nothing can raise it further.
    if (current === null) continue;

    // An override to unlimited applies — but only to a limit that *has* an
    // unlimited. `secretVersionsRetained`, `auditRetentionDays`, `pitrDays` and
    // `includedFetchesPerMonth` are typed `number` and read as one; writing
    // `null` into any of them satisfied the "is this a known limit?" guard
    // above, was persisted, and then threw a `TypeError` on the next read of
    // that organisation — permanently, because the bad value is in the row.
    // Ignored rather than thrown, for the same reason an unknown key is: these
    // rows are written by an operator running a script, and a typo in a support
    // ticket must not take entitlement resolution down for a tenant. The script
    // refuses it up front, where there is somebody to tell.
    if (value === null) {
      if (!NULLABLE_LIMITS.has(key)) continue;
      result[key] = null;
      changed = true;
      continue;
    }

    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (typeof current !== 'number' || value <= current) continue;

    result[key] = value;
    changed = true;
  }

  return changed ? (result as unknown as PlanLimits) : limits;
}

/**
 * Resolve a billing row into the object every enforcement site reads.
 *
 * Nothing outside this module should branch on `PlanId` directly. Doing so
 * skips overrides and add-ons — the two things that make a specific
 * organisation differ from its plan — and the resulting bug is invisible until
 * a customer whose ceiling support raised gets refused anyway.
 *
 * An unrecognised plan id resolves to Free rather than throwing. The row comes
 * from our own database via a Postgres enum, so this should be unreachable; but
 * "unreachable" and "throws on the authorization path" is a combination worth
 * one defensive line.
 *
 * A **retired** plan is answered before that fallback, and the order matters. A
 * row saying `scale` is not an unrecognised value — it is a tier this product
 * sold and then withdrew, and dropping its holder to Free would take away the
 * per-environment grants they paid for.
 *
 * Both of those live in `resolvePlanId`, which uses `Object.hasOwn` rather than
 * `state.plan in PLANS`: `in` walks the prototype chain and would let
 * `'constructor'` and `'toString'` through the guard to a `PLANS[plan]` of
 * `undefined` and a `TypeError` one line later — on the authorization path,
 * which is the single place this line exists to keep exception-free. The
 * defensive line has to actually defend.
 */
export function resolveEntitlements(state: SubscriptionState): Entitlements {
  const plan: PlanId = resolvePlanId(state.plan);
  const definition = PLANS[plan];

  const addons: OrgAddons = Object.freeze({
    samlSso: state.addonSaml,
    directorySync: state.addonDirectorySync,
  });

  return Object.freeze({
    plan,
    status: state.status,
    limits: Object.freeze(applyOverrides(definition.limits, state.limitOverrides)),
    features: definition.features,
    addons,
    controlPlaneActive: isControlPlaneActive(state.status),
  });
}

/**
 * The plan a stored value resolves to: itself, its replacement, or Free.
 *
 * Exported so the operator tool and the dashboard read a retired row the same
 * way the authorization path does. A second copy of this precedence is a second
 * answer to "what is this organisation on", and the two would disagree on
 * exactly the rows where being wrong costs a customer something.
 */
export function resolvePlanId(stored: string): PlanId {
  if (Object.hasOwn(PLANS, stored)) return stored as PlanId;
  if (Object.hasOwn(RETIRED_PLANS, stored)) return RETIRED_PLANS[stored] ?? DEFAULT_PLAN;
  return DEFAULT_PLAN;
}

/**
 * The entitlements of an organisation with no billing row at all.
 *
 * Every organisation gets a row by migration, and P12's webhooks keep it
 * current — but a row can be missing for one legitimate reason: an organisation
 * created in the same transaction that has not yet been committed alongside its
 * subscription. Resolving to Free is the safe answer, and it is the same answer
 * the migration would have written.
 */
export const FREE_ENTITLEMENTS: Entitlements = resolveEntitlements({
  plan: DEFAULT_PLAN,
  status: 'active',
  addonSaml: false,
  addonDirectorySync: false,
});

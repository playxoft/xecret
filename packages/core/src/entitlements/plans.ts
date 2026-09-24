/**
 * The five plans, as data.
 *
 * ── This file is the single source of every limit in the product ──
 * The enforcement path reads it. The dashboard reads it. The pricing page reads
 * it (`apps/web/src/app/pricing/page.tsx`, via a test that fails the build if a
 * rendered limit and a limit here disagree). Nothing may hard-code a ceiling
 * that also appears here.
 *
 * The reason is not tidiness. A secrets manager whose pricing page advertises a
 * limit its server does not enforce is a product that will one day refuse a
 * customer something they paid for, in the middle of a deploy, with a receipt
 * in hand. One file, read three ways, cannot drift.
 *
 * ── Prices are NOT here ──
 * Only limits and capabilities. Prices vary by currency and by billing interval
 * and are typography as much as data — `'$12'` is a rendering decision, `12` is
 * a number, and the day one of them gains a suffix a shared constant would
 * publish the wrong thing somewhere. The pricing page owns its own price
 * strings; `MINIMUM_SEATS` is the one commercial number here, because it is
 * enforced at checkout rather than displayed.
 *
 * Every number below traces to a line in `.local/plans/pricing-plan.md` §3–§5.
 * Changing one here without changing it there is a bug in both places.
 */

import type { LimitedResource, OrgAddons, Plan, PlanFeatures, PlanId, PlanLimits } from './types';

/**
 * Ordering, weakest to strongest.
 *
 * Used to answer "what is the cheapest plan that would allow this?" for the
 * upgrade hint in a refusal, and to make `limitOverrides` raise-only. Not used
 * for access decisions — those read the resolved flags, never a rank
 * comparison, so that an override or an add-on is never silently skipped.
 */
export const PLAN_RANK: Readonly<Record<PlanId, number>> = Object.freeze({
  free: 0,
  pro: 1,
  team: 2,
  enterprise: 3,
});

/** Every plan id, weakest first. Iteration order is load-bearing for upgrade hints. */
export const PLAN_IDS: readonly PlanId[] = Object.freeze([
  'free',
  'pro',
  'team',
  'enterprise',
] as const);

/**
 * Plans that existed once and no longer do, mapped to what replaced them.
 *
 * Scale sat between Team and Enterprise and was removed: four self-serve rungs
 * asked a buyer to make a distinction they had no basis to make, and the two
 * capabilities that genuinely justified the tier — custom roles and SIEM
 * streaming — belong with the contract that asks for them.
 *
 * The row can still say `scale`, because `plan_id` is a Postgres enum and
 * Postgres enums are additive-only: the value cannot be dropped. Resolving it to
 * Team rather than letting it fall through to Free is the difference between a
 * customer who was sold the tier above Team keeping everything they paid for and
 * one who silently loses per-environment grants. Nothing should be on it — it
 * was never billed — and the map is here so that "nothing should be" does not
 * have to be true for the code to be safe.
 */
export const RETIRED_PLANS: Readonly<Record<string, PlanId>> = Object.freeze({
  scale: 'team',
});

/**
 * Fair-usage soft ceilings — pricing-plan.md §5.
 *
 * These apply wherever a plan limit is `null` ("unlimited"). They **warn and
 * never refuse**: crossing one produces a `warn` verdict, an email to the
 * owners, and a support conversation. Raising one is a `limitOverrides` entry,
 * not a deploy.
 *
 * They exist to catch abuse and runaway loops — a script creating projects in a
 * `while (true)` — not to upsell. Treating them as hard limits would break the
 * three commitments published beside them.
 */
export const FAIR_USE = Object.freeze({
  organizations: 25,
  projects: 500,
  environmentsPerProject: 25,
  secretsPerEnvironment: 5_000,
  serviceTokens: 1_000,
  webhooks: 50,
  /** No published ceiling; seats are billed, so abuse is self-limiting. */
  seats: null,
  cliDevicesPerUser: null,
} as const satisfies Readonly<Record<string, number | null>>);

/**
 * Which limits may be set to `null`, meaning unlimited.
 *
 * Not every field of `PlanLimits` can be: `secretVersionsRetained`,
 * `auditRetentionDays`, `pitrDays` and `includedFetchesPerMonth` are typed
 * `number`, and every reader treats them as one —
 * `includedFetchesPerMonth.toLocaleString()` in the operator tool, arithmetic in
 * the metered-usage calculation. A support override writing `null` into one of
 * them passed the "is this a known limit?" check, was persisted, and then threw
 * a `TypeError` on the *next* read of that organisation, for ever.
 *
 * `LimitedResource` is exactly the nullable set, and the `satisfies` is what
 * keeps that true: adding a member without adding it here fails to compile, and
 * a key that is not one fails too.
 */
const NULLABLE_LIMIT_KEYS = Object.freeze({
  organizations: true,
  projects: true,
  environmentsPerProject: true,
  serviceTokens: true,
  seats: true,
  cliDevicesPerUser: true,
  webhooks: true,
  secretsPerEnvironment: true,
} as const satisfies Readonly<Record<LimitedResource, true>>);

/** The names from `NULLABLE_LIMIT_KEYS`, for runtime membership tests. */
export const NULLABLE_LIMITS: ReadonlySet<string> = Object.freeze(
  new Set<string>(Object.keys(NULLABLE_LIMIT_KEYS)),
);

/**
 * How close to a hard ceiling counts as "approaching".
 *
 * 0.8 → the banner and the email fire at 80%, which is the number published in
 * the plan. Early enough to act on, late enough not to be noise.
 */
export const WARN_AT = 0.8;

/** Rate limits, per organisation and per token — pricing-plan.md §5. */
export const RATE_LIMITS = Object.freeze({
  perOrgPerMinute: 600,
  perTokenPerMinute: 60,
} as const);

/**
 * Overage: one metered unit is 1,000 fetches, priced at $0.01.
 *
 * The batching is not cosmetic. Dodo meters in whole events, and $0.00001 per
 * fetch is a number a billing system rounds into nonsense. Counting in
 * thousands keeps the unit price a clean cent and keeps the event volume
 * survivable. See `.local/dodo/dodo-setup.md` Part 6.
 */
export const FETCHES_PER_METERED_UNIT = 1_000;

/** No add-ons. The shape every organisation starts from. */
export const NO_ADDONS: OrgAddons = Object.freeze({
  samlSso: false,
  directorySync: false,
});

/* ── Feature sets, built by accumulation ───────────────────────────────────── */

/**
 * Written as four accumulating layers rather than five independent literals.
 *
 * A flat table of five objects with seventeen booleans each is 85 booleans that
 * must stay consistent by hand, and the failure mode is a feature silently
 * missing from Scale because someone added it to Team and stopped. Spreading
 * the tier below makes "Scale has everything Team has" a property of the code
 * rather than a thing to remember — and the exhaustiveness test asserts the
 * monotonicity that this construction is designed to guarantee.
 */
const FREE_FEATURES: PlanFeatures = {
  secretReferencing: false,
  personalOverrides: false,
  environmentPromotion: false,
  pointInTimeRestore: false,
  tokenIpAllowlist: false,
  newIpReadAlerts: false,
  perEnvironmentGrants: false,
  oidcSso: false,
  changeApprovals: false,
  secretPolicy: false,
  disableEnvExport: false,
  breakGlass: false,
  bulkRotate: false,
  customRoles: false,
  githubOidcFederation: false,
  scheduledSecrets: false,
  siemStreaming: false,
};

const PRO_FEATURES: PlanFeatures = {
  ...FREE_FEATURES,
  secretReferencing: true,
  personalOverrides: true,
  environmentPromotion: true,
  pointInTimeRestore: true,
  tokenIpAllowlist: true,
  newIpReadAlerts: true,
};

/**
 * Team — the last rung anybody reaches without talking to us.
 *
 * `githubOidcFederation` and `scheduledSecrets` are here rather than on
 * Enterprise, having come down from Scale when that tier was removed. Both are
 * security posture rather than scale: federation is how a team stops keeping a
 * static CI token in a GitHub secret at all, and an expiring secret is how a
 * contractor's access ends without somebody remembering to end it. Putting
 * either behind a contract would mean the customers most exposed to the problem
 * — small teams with outside help — are the ones who cannot have the fix. Both
 * also cost us nothing per customer, which is what makes the argument free to
 * act on.
 */
const TEAM_FEATURES: PlanFeatures = {
  ...PRO_FEATURES,
  perEnvironmentGrants: true,
  oidcSso: true,
  changeApprovals: true,
  secretPolicy: true,
  disableEnvExport: true,
  breakGlass: true,
  bulkRotate: true,
  githubOidcFederation: true,
  scheduledSecrets: true,
};

/**
 * Enterprise is Team plus the two capabilities a contract is what asks for.
 *
 * `customRoles` and `siemStreaming` came down from Scale when that tier was
 * removed, and they stopped here rather than at Team deliberately. Both are
 * bought by an organisation with a security function rather than by a team with
 * a contractor: custom roles only pay for themselves past the point where the
 * four built-in ones stop describing how a company is actually organised, and a
 * SIEM is something you have because somebody requires you to have one. Neither
 * is a thing a five-person team is held back by, which is the test for whether a
 * capability belongs above the last self-serve rung.
 *
 * The other two — `githubOidcFederation` and `scheduledSecrets` — went to Team
 * instead; the reasoning is on `TEAM_FEATURES`.
 */
const ENTERPRISE_FEATURES: PlanFeatures = {
  ...TEAM_FEATURES,
  customRoles: true,
  siemStreaming: true,
};

/* ── Limits ────────────────────────────────────────────────────────────────── */

/**
 * Free — pricing-plan.md §3.
 *
 * The tightest ceilings in the product, and deliberately generous enough to run
 * one real project with the two people who would actually run it. One
 * organisation is the sharpest of these: it is what makes a personal account a
 * personal account.
 *
 * Three seats rather than one. A single seat made Free a demo — the product's
 * whole subject is a secret *shared* between people, and a plan that cannot be
 * shared cannot show what it is for. Three is a founder and two others, which is
 * enough to hit the wall Team exists to solve (somebody who must not read
 * production) rather than the wall of not being able to invite anyone at all.
 */
const FREE_LIMITS: PlanLimits = {
  organizations: 1,
  projects: 5,
  environmentsPerProject: 3,
  serviceTokens: 10,
  /**
   * Three — and **still not what is enforced today**.
   *
   * Seats are the one limit in this file with a second home. Invitations are
   * refused by `assertSeatAvailable` against `organizations.seat_limit`, a
   * column that predates this file and defaults to 5; nothing sets it from the
   * plan at provisioning time. A Free organisation can therefore seat five
   * people, not three, and the looser number is the one that applies.
   *
   * The divergence is smaller than it was — this used to be 1, so the page said
   * one seat and the server allowed five — but it is still a divergence, and it
   * is still left documented rather than reconciled in either direction:
   * loosening this to 5 would put a number in this file that contradicts the
   * pricing page, which is the single thing this file exists to prevent;
   * tightening the column would retroactively lock teams out of organisations
   * they have already invited into, months before there is a checkout page to
   * pay past it with. `setBilledSeats` is the path that writes the two together,
   * and payments (P12) are where they stop diverging.
   */
  seats: 3,
  cliDevicesPerUser: 2,
  webhooks: 0,
  secretsPerEnvironment: 250,
  secretVersionsRetained: 5,
  auditRetentionDays: 7,
  pitrDays: 0,
  includedFetchesPerMonth: 20_000,
};

/**
 * Pro — the first paid rung.
 *
 * ── Why these are numbers and not `null` ──
 * Pro used to publish "unlimited" on every countable. It read generously and it
 * was a promise we could not describe: "unlimited" with a fair-use ceiling
 * behind it means the real limit is whatever an operator decides during an
 * incident, and the first customer to meet it finds out that the published word
 * was not the rule. A number that is comfortably above what the tier is bought
 * for says the same thing honestly, and it is a number support can raise for
 * free with a `limitOverrides` entry — which is the fair-usage promise working
 * as designed rather than as an apology.
 *
 * Each ceiling is set at roughly ten times what the tier's own audience uses, so
 * meeting one is a signal that the organisation has outgrown the rung rather
 * than a wall it hits in normal work.
 *
 * ── Seats are the exception, and stay `null` ──
 * Pro has no seat cap, deliberately. A forty-person team *could* buy forty Pro
 * seats rather than forty Team seats — and won't, because `perEnvironmentGrants`
 * is false here and everyone on Pro can read production. That gate is what lets
 * Pro sell unlimited seats without cannibalising Team, and capping headcount
 * would replace a real product distinction with an artificial one. See the note
 * on `perEnvironmentGrants` in `types.ts`.
 */
const PRO_LIMITS: PlanLimits = {
  organizations: 3,
  projects: 25,
  environmentsPerProject: 10,
  serviceTokens: 50,
  seats: null,
  cliDevicesPerUser: 5,
  webhooks: 3,
  secretsPerEnvironment: 1_000,
  secretVersionsRetained: 100,
  auditRetentionDays: 30,
  pitrDays: 30,
  includedFetchesPerMonth: 200_000,
};

/**
 * Team — the top of the self-serve ladder since Scale was removed.
 *
 * The countables are about four times Pro's rather than unlimited, for the
 * reason on `PRO_LIMITS`. The retention figures moved up when Scale went: a
 * year of audit history stayed with Enterprise, but 90 days was Team's number
 * when there was a rung above it to sell, and with none there it is the wrong
 * side of the six-month window most security reviews ask about.
 */
const TEAM_LIMITS: PlanLimits = {
  ...PRO_LIMITS,
  organizations: 10,
  projects: 100,
  environmentsPerProject: 25,
  serviceTokens: 250,
  cliDevicesPerUser: 10,
  webhooks: 25,
  secretsPerEnvironment: 5_000,
  secretVersionsRetained: 250,
  auditRetentionDays: 180,
  pitrDays: 180,
  includedFetchesPerMonth: 1_000_000,
};

/**
 * Enterprise — "custom" everywhere a number would otherwise be published.
 *
 * The retention figures are defaults a contract raises via `limitOverrides`,
 * not promises. Enterprise is a negotiated agreement and a manual invoice; the
 * plan exists here so the enforcement path has something to resolve, not
 * because anyone self-serves onto it.
 */
const ENTERPRISE_LIMITS: PlanLimits = {
  ...TEAM_LIMITS,
  // The only plan where a countable is genuinely uncapped, and the only one
  // where that is honest: an Enterprise ceiling is whatever the contract says,
  // and `FAIR_USE` is what the abuse bound falls back to in the absence of one.
  organizations: null,
  projects: null,
  environmentsPerProject: null,
  serviceTokens: null,
  cliDevicesPerUser: null,
  webhooks: null,
  secretsPerEnvironment: null,
  secretVersionsRetained: 1_000,
  auditRetentionDays: 365,
  pitrDays: 365,
  // A default, not a published figure. The pricing page renders "Contracted"
  // for this column rather than the number, because an Enterprise allowance is
  // whatever the agreement says and printing one would be quoting a price we
  // have not agreed. This is what the meter falls back to in the absence of an
  // override, which is the only thing it is for.
  includedFetchesPerMonth: 10_000_000,
};

/* ── The plans ─────────────────────────────────────────────────────────────── */

/**
 * Minimum purchasable seats — pricing-plan.md, open question 1.
 *
 * Stops a solo developer buying one Enterprise seat and expecting the support
 * that tier's price pays for. Enforced at checkout (P12) and by the manual plan tool,
 * never on the data path: an organisation that somehow holds fewer seats than
 * its plan's minimum keeps working. Billing is not a reason to break something
 * already running.
 */
export const MINIMUM_SEATS: Readonly<Record<PlanId, number>> = Object.freeze({
  free: 1,
  pro: 1,
  team: 3,
  enterprise: 10,
});

export const PLANS: Readonly<Record<PlanId, Plan>> = Object.freeze({
  free: Object.freeze({
    id: 'free',
    name: 'Free',
    minimumSeats: MINIMUM_SEATS.free,
    limits: Object.freeze(FREE_LIMITS),
    features: Object.freeze(FREE_FEATURES),
  }),
  pro: Object.freeze({
    id: 'pro',
    name: 'Pro',
    minimumSeats: MINIMUM_SEATS.pro,
    limits: Object.freeze(PRO_LIMITS),
    features: Object.freeze(PRO_FEATURES),
  }),
  team: Object.freeze({
    id: 'team',
    name: 'Team',
    minimumSeats: MINIMUM_SEATS.team,
    limits: Object.freeze(TEAM_LIMITS),
    features: Object.freeze(TEAM_FEATURES),
  }),
  enterprise: Object.freeze({
    id: 'enterprise',
    name: 'Enterprise',
    minimumSeats: MINIMUM_SEATS.enterprise,
    limits: Object.freeze(ENTERPRISE_LIMITS),
    features: Object.freeze(ENTERPRISE_FEATURES),
  }),
});

/** The plan every organisation has until something says otherwise. */
export const DEFAULT_PLAN: PlanId = 'free';

/**
 * The cheapest plan whose features include `feature`, or `null` if none does.
 *
 * Drives the `upgradeTo` field in a refusal, so that a 403 can say "Team" and
 * the dashboard can render one button instead of the whole pricing table.
 */
export function cheapestPlanWithFeature(feature: keyof PlanFeatures): PlanId | null {
  for (const id of PLAN_IDS) {
    if (PLANS[id].features[feature]) return id;
  }
  return null;
}

/**
 * The cheapest plan whose ceiling on `resource` clears `required`, or `null`.
 *
 * `null` (unlimited) always clears, which is why the `null` check precedes the
 * comparison — `null >= n` would coerce to `0 >= n` and quietly recommend the
 * wrong plan for every unlimited resource.
 */
export function cheapestPlanWithLimit(resource: keyof PlanLimits, required: number): PlanId | null {
  for (const id of PLAN_IDS) {
    const limit = PLANS[id].limits[resource];
    if (limit === null || limit >= required) return id;
  }
  return null;
}

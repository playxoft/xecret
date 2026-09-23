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

import type { OrgAddons, Plan, PlanFeatures, PlanId, PlanLimits } from './types';

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
  scale: 3,
  enterprise: 4,
});

/** Every plan id, weakest first. Iteration order is load-bearing for upgrade hints. */
export const PLAN_IDS: readonly PlanId[] = Object.freeze([
  'free',
  'pro',
  'team',
  'scale',
  'enterprise',
] as const);

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

const TEAM_FEATURES: PlanFeatures = {
  ...PRO_FEATURES,
  perEnvironmentGrants: true,
  oidcSso: true,
  changeApprovals: true,
  secretPolicy: true,
  disableEnvExport: true,
  breakGlass: true,
  bulkRotate: true,
};

const SCALE_FEATURES: PlanFeatures = {
  ...TEAM_FEATURES,
  customRoles: true,
  githubOidcFederation: true,
  scheduledSecrets: true,
  siemStreaming: true,
};

/** Enterprise is Scale plus negotiated terms that are contractual, not coded. */
const ENTERPRISE_FEATURES: PlanFeatures = { ...SCALE_FEATURES };

/* ── Limits ────────────────────────────────────────────────────────────────── */

/**
 * Free — pricing-plan.md §3.
 *
 * The only plan with hard ceilings on organisations, projects and environments.
 * Deliberately generous enough to run one real project and mean enough that a
 * second team member is a decision. One organisation is the sharpest of these:
 * it is what makes a personal account a personal account.
 */
const FREE_LIMITS: PlanLimits = {
  organizations: 1,
  projects: 5,
  environmentsPerProject: 3,
  serviceTokens: 10,
  /**
   * 1 per pricing-plan.md §3 — and **not what is enforced today**.
   *
   * Seats are the one limit in this file with a second home. Invitations are
   * refused by `assertSeatAvailable` against `organizations.seat_limit`, a
   * column that predates this file and defaults to 5; nothing sets it from the
   * plan at provisioning time. A Free organisation can therefore seat five
   * people, not one, and the looser number is the one that applies.
   *
   * Left as a documented divergence rather than reconciled, in either direction:
   * loosening this to 5 would put a number in this file that contradicts the
   * pricing page, which is the single thing this file exists to prevent;
   * tightening the column to 1 would retroactively lock teams out of
   * organisations they already invited into, months before there is a checkout
   * page to pay past it with. `setBilledSeats` is the path that writes the two
   * together, and payments (P12) are where they stop diverging.
   */
  seats: 1,
  cliDevicesPerUser: 2,
  webhooks: 0,
  secretsPerEnvironment: 250,
  secretVersionsRetained: 5,
  auditRetentionDays: 7,
  pitrDays: 0,
  includedFetchesPerMonth: 20_000,
};

/**
 * Pro — unlimited everything countable, at $5/seat/month on yearly.
 *
 * Seats are `null` on purpose: Pro has no seat cap. A forty-person team *could*
 * buy forty Pro seats rather than forty Team seats — and won't, because
 * `perEnvironmentGrants` is false here and everyone on Pro can read production.
 * See the note on `perEnvironmentGrants` in `types.ts`.
 */
const PRO_LIMITS: PlanLimits = {
  organizations: null,
  projects: null,
  environmentsPerProject: null,
  serviceTokens: null,
  seats: null,
  cliDevicesPerUser: null,
  webhooks: 3,
  secretsPerEnvironment: null,
  secretVersionsRetained: 100,
  auditRetentionDays: 30,
  pitrDays: 30,
  includedFetchesPerMonth: 150_000,
};

const TEAM_LIMITS: PlanLimits = {
  ...PRO_LIMITS,
  webhooks: null,
  secretVersionsRetained: 250,
  auditRetentionDays: 90,
  pitrDays: 90,
  includedFetchesPerMonth: 500_000,
};

const SCALE_LIMITS: PlanLimits = {
  ...TEAM_LIMITS,
  secretVersionsRetained: 500,
  auditRetentionDays: 365,
  pitrDays: 365,
  includedFetchesPerMonth: 2_000_000,
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
  ...SCALE_LIMITS,
  secretVersionsRetained: 1_000,
  auditRetentionDays: 365,
  pitrDays: 365,
  includedFetchesPerMonth: 10_000_000,
};

/* ── The plans ─────────────────────────────────────────────────────────────── */

/**
 * Minimum purchasable seats — pricing-plan.md, open question 1.
 *
 * Stops a solo developer buying one Scale seat and expecting the support that
 * tier's price pays for. Enforced at checkout (P12) and by the manual plan tool,
 * never on the data path: an organisation that somehow holds fewer seats than
 * its plan's minimum keeps working. Billing is not a reason to break something
 * already running.
 */
export const MINIMUM_SEATS: Readonly<Record<PlanId, number>> = Object.freeze({
  free: 1,
  pro: 1,
  team: 3,
  scale: 10,
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
  scale: Object.freeze({
    id: 'scale',
    name: 'Scale',
    minimumSeats: MINIMUM_SEATS.scale,
    limits: Object.freeze(SCALE_LIMITS),
    features: Object.freeze(SCALE_FEATURES),
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

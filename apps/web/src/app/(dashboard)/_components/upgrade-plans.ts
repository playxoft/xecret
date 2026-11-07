import { MINIMUM_SEATS, PLANS } from '@xecret/core/entitlements';
import type { PlanFeatures } from '@xecret/core/entitlements';

/**
 * What the in-app plans page says about each plan.
 *
 * ── Two sources, and which one wins ──
 * Every limit and every capability is read from `PLANS` in
 * `@xecret/core/entitlements` — the file the server enforces from — exactly as
 * the public pricing page reads them. A plans page inside the product that
 * promised a ceiling the server does not hold would be the worst place to
 * make that mistake: the reader is one click from paying for it.
 *
 * The prices are the exception, for the reason `plans.ts` gives: a price is
 * typography and lives with the page that prints it. The public pricing page
 * cannot export its sheets (a `page.tsx` exports only what Next allows), so the
 * US-dollar figures are restated here and `upgrade-plans.test.ts` reads the
 * pricing page's source and fails if the two ever disagree — figure, unit,
 * yearly total and the "save up to" percentage alike. Dollars only: checkout
 * prices in the buyer's own currency, and the pricing page is where every
 * sheet is published.
 *
 * ── What is never said here ──
 * Anything the pricing page marks "Coming soon". The engine already carries
 * flags for capabilities that are not built (approvals, break-glass, GitHub
 * federation, scheduled secrets, single sign-on), and a page whose job is to
 * persuade is exactly where one of those would quietly gain a tick. So the
 * capabilities below are a list of *shipped* flags, and the test pins that
 * none of the unbuilt ones is on it. Nor is a trial: the pricing page offers
 * none, so this page does not either.
 */

export type PaidPlanId = 'pro' | 'team';
export type OfferPlanId = 'free' | PaidPlanId;
export type BillingPeriod = 'monthly' | 'yearly';

/** One billing period's price for one plan, in US dollars. */
export interface PeriodPrice {
  /** The large figure. Typography, never parsed. */
  readonly price: string;
  /** The line under it, read as a continuation of the figure. */
  readonly unit: string;
  /** The yearly total, where the period needs spelling out. */
  readonly note: string | null;
  /**
   * The same rate as whole dollars a member a month — written beside `price`
   * rather than parsed out of it, the pricing page's rule. Only the saving is
   * computed from it; it is never rendered.
   */
  readonly perMemberMonth: number;
}

const PER_MEMBER = 'per member, per month';

/** The US-dollar sheet. Must agree with `PRICED_PLANS` on `/pricing`; the test says so. */
export const USD_PRICES: Readonly<
  Record<PaidPlanId, Readonly<Record<BillingPeriod, PeriodPrice>>>
> = {
  pro: {
    monthly: { price: '$8', unit: PER_MEMBER, note: null, perMemberMonth: 8 },
    yearly: {
      price: '$5',
      unit: PER_MEMBER,
      note: '$60 per member, billed yearly',
      perMemberMonth: 5,
    },
  },
  team: {
    monthly: { price: '$19', unit: PER_MEMBER, note: null, perMemberMonth: 19 },
    yearly: {
      price: '$12',
      unit: PER_MEMBER,
      note: '$144 per member, billed yearly',
      perMemberMonth: 12,
    },
  },
};

export const FREE_PRICE = { price: '$0', unit: 'forever, no card' } as const;

/**
 * What the yearly rate saves on one plan, as a whole percentage, floored.
 *
 * Floored rather than rounded so the figure is never larger than the saving:
 * Pro's is 37.5 per cent and Team's 36.8, and "37%" above Team's card would be
 * a promise that card does not keep.
 */
export function yearlySaving(plan: PaidPlanId): number {
  const { monthly, yearly } = USD_PRICES[plan];
  return Math.floor(
    ((monthly.perMemberMonth - yearly.perMemberMonth) * 100) / monthly.perMemberMonth,
  );
}

/**
 * The figure on the period toggle: the larger of the two savings, which is
 * what "up to" means — the same rule, and the same number, as the pricing
 * page's dollar sheet.
 */
export const YEARLY_SAVING_UP_TO = Math.max(yearlySaving('pro'), yearlySaving('team'));

/* ── Limits, as sentences ──────────────────────────────────────────────────── */

const LIMITS = {
  free: PLANS.free.limits,
  pro: PLANS.pro.limits,
  team: PLANS.team.limits,
} as const;

/** `3` → "3 members", `1` → "1 organisation", `null` → "Unlimited members". */
function many(limit: number | null, one: string, other: string): string {
  if (limit === null) return `Unlimited ${other}`;
  return `${limit.toLocaleString('en-GB')} ${limit === 1 ? one : other}`;
}

/** `20_000` → "20,000", `1_000_000` → "1 million" — the pricing page's rendering. */
export function formatCount(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)} million`;
  }
  return value.toLocaleString('en-GB');
}

/** `7` → "7 days", `365` → "1 year". */
export function formatRetention(days: number): string {
  if (days % 365 === 0) {
    const years = days / 365;
    return years === 1 ? '1 year' : `${years} years`;
  }
  return `${days} days`;
}

/**
 * The seat floor as a condition on the price — "Billed from 3 members up" — or
 * nothing for a plan without one. Under the figure, never as a tick: a minimum
 * charge is the opposite of an inclusion.
 */
function seatFloor(seats: number): string | null {
  return seats <= 1 ? null : `Billed from ${seats} members up`;
}

/* ── The cards ─────────────────────────────────────────────────────────────── */

export interface PlanOffer {
  readonly id: OfferPlanId;
  readonly name: string;
  /** One line answering "is this me?" before the list is read. */
  readonly audience: string;
  readonly features: readonly string[];
  /** A condition on the price, rendered under it. */
  readonly caveat: string | null;
  readonly recommended: boolean;
}

const proMembers =
  LIMITS.pro.seats === null
    ? // Uncapped on purpose: the gate to Team is per-environment access, not
      // headcount — so the sentence says what the absence of that gate means.
      PLANS.pro.features.perEnvironmentGrants
      ? 'Unlimited members'
      : 'Unlimited members — everyone can read every environment'
    : many(LIMITS.pro.seats, 'member', 'members');

export const PLAN_OFFERS: readonly PlanOffer[] = [
  {
    id: 'free',
    name: PLANS.free.name,
    audience: 'For one developer who has had enough of moving .env files around.',
    features: [
      `${many(LIMITS.free.organizations, 'organisation', 'organisations')}, ${many(LIMITS.free.projects, 'project', 'projects')}`,
      `${many(LIMITS.free.environmentsPerProject, 'environment', 'environments')} per project`,
      many(LIMITS.free.seats, 'member', 'members'),
      `${many(LIMITS.free.serviceTokens, 'service token', 'service tokens')} for CI`,
      `${formatCount(LIMITS.free.includedFetchesPerMonth)} secret fetches a month`,
      `${formatRetention(LIMITS.free.auditRetentionDays)} of audit history`,
    ],
    caveat: seatFloor(MINIMUM_SEATS.free),
    recommended: false,
  },
  {
    id: 'pro',
    name: PLANS.pro.name,
    audience:
      'For a small team that has outgrown the free limits and does not yet need to keep anyone out of production.',
    features: [
      `${many(LIMITS.pro.projects, 'project', 'projects')} across ${many(LIMITS.pro.organizations, 'organisation', 'organisations')}`,
      `${many(LIMITS.pro.environmentsPerProject, 'environment', 'environments')} per project, ${many(LIMITS.pro.secretsPerEnvironment, 'secret', 'secrets')} in each`,
      proMembers,
      `${many(LIMITS.pro.serviceTokens, 'service token', 'service tokens')} for CI, all free`,
      `${formatCount(LIMITS.pro.includedFetchesPerMonth)} secret fetches a month`,
      `${formatRetention(LIMITS.pro.auditRetentionDays)} of audit history`,
      'Secret referencing, overrides, promotion and point-in-time restore',
    ],
    caveat: seatFloor(MINIMUM_SEATS.pro),
    recommended: false,
  },
  {
    id: 'team',
    name: PLANS.team.name,
    audience:
      'For a team with somebody who must not see production — a contractor, a junior, an auditor.',
    features: [
      'Everything in Pro',
      'Roles and per-environment access',
      `${many(LIMITS.team.projects, 'project', 'projects')}, ${many(LIMITS.team.secretsPerEnvironment, 'secret', 'secrets')} per environment`,
      `${many(LIMITS.team.serviceTokens, 'service token', 'service tokens')} for CI`,
      `${formatCount(LIMITS.team.includedFetchesPerMonth)} secret fetches a month`,
      `${formatRetention(LIMITS.team.auditRetentionDays)} of audit history`,
      'A secret policy, and plaintext export switched off where you choose',
    ],
    caveat: seatFloor(MINIMUM_SEATS.team),
    recommended: true,
  },
];

/** The Enterprise row's condition on the (unpublished) price. */
export const ENTERPRISE_CAVEAT = seatFloor(MINIMUM_SEATS.enterprise);

/* ── What each plan unlocks ────────────────────────────────────────────────── */

/**
 * The capabilities a paid plan adds that are built and enforced today, in the
 * order a reader meets them.
 *
 * Keyed by the engine's own flag, so the ticks in the table are read from
 * `PLANS` rather than written here: move a capability to another plan in
 * `plans.ts` and the table follows. What is written here is only *which* flags
 * are shipped — see the note at the top of this file.
 */
export const SHIPPED_CAPABILITIES: readonly {
  readonly feature: keyof PlanFeatures;
  readonly label: string;
  readonly hint: string;
}[] = [
  {
    feature: 'secretReferencing',
    label: 'Secret referencing and environment inheritance',
    hint: 'Point one secret at another instead of copying the value into both.',
  },
  {
    feature: 'personalOverrides',
    label: 'Personal local overrides',
    hint: 'Replace a value on your own machine without changing it for the team.',
  },
  {
    feature: 'environmentPromotion',
    label: 'Environment promotion, with a diff',
    hint: 'Move staging to production after seeing exactly what would change.',
  },
  {
    feature: 'pointInTimeRestore',
    label: 'Point-in-time restore',
    hint: 'Roll a whole environment back to how it looked at a moment.',
  },
  {
    feature: 'tokenIpAllowlist',
    label: 'Token IP allowlists and lifetime policy',
    hint: 'Restrict where a token may be used from, and how long it lives.',
  },
  {
    feature: 'newIpReadAlerts',
    label: 'Alerts on reads from new addresses',
    hint: 'Owners and admins get an email the first time an environment is read from somewhere new.',
  },
  {
    feature: 'perEnvironmentGrants',
    label: 'Roles and per-environment access',
    hint: 'Give somebody staging without giving them production.',
  },
  {
    feature: 'secretPolicy',
    label: 'A secret policy for names and values',
    hint: 'Hold new secrets to a naming rule, a minimum strength and words they must not contain.',
  },
  {
    feature: 'disableEnvExport',
    label: 'Plaintext export switched off per environment',
    hint: 'Stop an environment’s values being written to a file. xecret run keeps working.',
  },
];

export interface CapabilityRow {
  readonly label: string;
  readonly hint: string;
  readonly on: Readonly<Record<OfferPlanId, boolean>>;
}

/**
 * The table under the cards: one row per shipped capability, plus webhooks —
 * a limit rather than a flag, carried by every plan whose ceiling is above
 * zero.
 */
export const CAPABILITY_ROWS: readonly CapabilityRow[] = [
  ...SHIPPED_CAPABILITIES.slice(0, 5).map((capability) => rowFor(capability)),
  {
    label: 'Webhooks on secret change',
    hint: 'Notify your own systems when a value changes.',
    on: {
      free: (LIMITS.free.webhooks ?? 1) > 0,
      pro: (LIMITS.pro.webhooks ?? 1) > 0,
      team: (LIMITS.team.webhooks ?? 1) > 0,
    },
  },
  ...SHIPPED_CAPABILITIES.slice(5).map((capability) => rowFor(capability)),
];

function rowFor(capability: (typeof SHIPPED_CAPABILITIES)[number]): CapabilityRow {
  return {
    label: capability.label,
    hint: capability.hint,
    on: {
      free: PLANS.free.features[capability.feature],
      pro: PLANS.pro.features[capability.feature],
      team: PLANS.team.features[capability.feature],
    },
  };
}

/**
 * What a ceiling the organisation is near becomes on the plan above it — the
 * line under a "close to a limit" warning. `null` when there is no plan above
 * to name, or it would not raise the ceiling.
 */
export function nextCeiling(
  current: OfferPlanId | 'enterprise',
  resource: 'seats' | 'projects' | 'serviceTokens',
): { plan: PaidPlanId; sentence: string } | null {
  const next: PaidPlanId | null = current === 'free' ? 'pro' : current === 'pro' ? 'team' : null;
  if (next === null) return null;
  const now = PLANS[current].limits[resource];
  const then = PLANS[next].limits[resource];
  if (then !== null && now !== null && then <= now) return null;

  const noun = { seats: 'members', projects: 'projects', serviceTokens: 'service tokens' }[
    resource
  ];
  return {
    plan: next,
    sentence:
      then === null
        ? `${PLANS[next].name} has no limit on ${noun}.`
        : `${PLANS[next].name} allows ${then.toLocaleString('en-GB')}.`,
  };
}

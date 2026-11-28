import { MINIMUM_SEATS, PLANS } from '@xecret/core/entitlements';

import {
  formatRetention,
  LIMITS,
  PLAN_COMPARISON,
  PRICING_FAQ,
  seatFloorCaveat,
} from '@/components/plans/pricing-content';
import type { MatrixGroup, PricingFaqId, PricingPlanId } from '@/components/plans/pricing-content';
import type { FaqItem } from '@/components/marketing/faq';
import { appPath, withQuery } from '../_lib/paths';

/**
 * What the in-app plans page says about each plan.
 *
 * ── Where each thing on the page comes from ──
 * Every limit and every capability is read from `PLANS` in
 * `@xecret/core/entitlements` — the file the server enforces from — exactly as
 * the public pricing page reads them. A plans page inside the product that
 * promised a ceiling the server does not hold would be the worst place to
 * make that mistake: the reader is one click from paying for it.
 *
 * The comparison table and the questions under it are not written here at
 * all. They are `PLAN_COMPARISON` and `PRICING_FAQ` in
 * `components/plans/pricing-content.ts`, the module the public pricing page
 * renders its own matrix and FAQ from. The owner asked (2026-11-08) for this
 * page to carry everything that table and that FAQ say rather than a reduced
 * version of them, so both pages now render one set of rows and one set of
 * answers, each in its own markup. What this file adds is only how this page
 * uses them: the four columns an organisation on the hosted service can be on,
 * the rows left out where nothing is sold, and the order the questions come in
 * for somebody about to buy. A correction to a row or an answer is one edit
 * there, and it reaches both pages.
 *
 * The prices are the exception, for the reason `plans.ts` gives: a price is
 * typography and lives with the page that prints it. The public pricing page
 * keeps its five currency sheets beside the CSS that reveals them, so the
 * US-dollar figures are restated here and `upgrade-plans.test.ts` reads the
 * pricing page's source and fails if the two ever disagree — figure, unit,
 * yearly total and the "save up to" percentage alike. Dollars only: checkout
 * prices in the buyer's own currency. The overage rate is not restated at all:
 * the page receives `OVERAGE_RATE_TEXT` from its server component, the constant
 * the billing screen and the usage emails print.
 *
 * ── What the cards never say ──
 * A capability the server does not enforce. A flag in `PLANS` is not enough:
 * the engine carries flags for things nobody has built (approvals, break-glass,
 * GitHub federation, scheduled secrets, single sign-on), and one for a thing
 * that is built and not gated — see `perEnvironmentGrants` below. The cards
 * are this page's own copy, and their capability bullets name only flags with
 * a `requireFeature` behind them. The shared table follows the same rule for
 * its ticks — a gated row reads them from `PLANS` and names its flag, and the
 * test reads the server for the gate behind each — and marks every announced,
 * unbuilt capability "Coming soon" in every column that names it.
 *
 * ── The free trial, said only as a condition ──
 * Team's checkout can start a fourteen-day trial (`TRIAL_PLANS` in
 * `server/billing/config.ts`), and the terms' billing clause says how it works:
 * one per organisation and one per account. Until 2026-11-28 this page said
 * nothing about it, because the pricing page says nothing about it either. The
 * owner has since asked (2026-11-28) for the chooser to name it beside the
 * button that starts it, so `trialNote` does, beside Team's checkout and
 * nowhere else. Nothing the client can read says whether this organisation and
 * this account are still eligible, so the sentence is a condition rather than a
 * promise, and the button says what it does either way ("Upgrade to Team").
 * The pricing page still names no trial; adding one there is a separate call.
 *
 * ── Per-environment access: a discrepancy, and an open decision ──
 * `PLANS` gives `perEnvironmentGrants` to Team, and the public site sells
 * "roles and per-environment access" as a Team feature. But nothing checks the
 * flag — neither a `requireFeature` nor a read of `features.perEnvironmentGrants`
 * anywhere in the server: the grants routes write per-environment grants on
 * every plan. Selling it beside a checkout button charges people for something
 * they already have.
 *
 * Until 2026-11-08 this page claimed it nowhere for that reason. The owner has
 * since asked for this page to say what `/pricing` says, and it now does: the
 * shared table's "Roles for members" and "Per-project and per-environment
 * grants" rows (dashed on Free and Pro) and the shared answer to "What is the
 * difference between Pro and Team?" appear here exactly as they appear there.
 * The cards were not part of that request and still name neither, and the
 * billing screen's plan sentences stay cut back to the seat floor. Whether to
 * enforce the gate or reword the copy is still the owner's decision and still
 * pending — and because both pages render one module, the correction is one
 * edit that fixes both. The tripwire in `upgrade-plans.test.ts` fails the
 * moment the server starts checking the flag, which is the signal to revisit
 * this note.
 *
 * Where the claim lives today — the sweep that decision needs. Each of these
 * presents per-environment access as a Team plan boundary:
 *
 *  - `components/plans/pricing-content.ts`, rendered by `/pricing` and by this
 *    page — the matrix rows "Roles for members" and "Per-project and
 *    per-environment grants", and the FAQ answer "What is the difference
 *    between Pro and Team?" ("Team adds roles and per-environment grants …
 *    That is the whole gate").
 *  - `app/pricing/page.tsx` — the Team card's "Roles and per-environment
 *    access" bullet; the Pro card's "Unlimited members — everyone can read
 *    every environment" and both audience lines.
 *  - `app/page.tsx` — the "What does it cost?" FAQ answer, both the no-payments
 *    and the payments-live versions ("Team … adds … roles and per-environment
 *    access").
 *  - `app/features/page.tsx` — "What does xecret cost?", both versions.
 *  - `app/faq/page.tsx` — "What does xecret cost?".
 *  - `app/about/page.tsx` — "How do you make money?", both versions, and the
 *    roadmap entry saying roles and per-environment access are "a plan
 *    boundary, not a promise".
 *  - `app/terms/page.tsx` — the Team plan's description in the plans section
 *    ("roles and per-environment access").
 *
 * And these describe it with no plan attached — true today, since every plan
 * has it, but they would need a plan named if the gate is enforced:
 * `app/page.tsx` "Access you can revoke" ("Members, roles and per-environment
 * access"); `app/features/page.tsx`, the roles feature and the "Roles and
 * per-environment access" guide link; and the FAQ category title "Members,
 * roles and per-environment access" in `app/faq/page.tsx`.
 *
 * ── Custom roles: resolved, corrected to match the gates (2026-11-08) ──
 * Custom roles are the gate that does exist (`requireFeature(…, 'customRoles')`
 * on defining, changing and assigning one) — at Enterprise, per `PLANS`. The
 * shared table and the pricing page's Enterprise card marked them "Coming
 * soon" anyway, so an Enterprise organisation here saw "Current plan" above a
 * row saying its own feature did not exist. Corrected in review of #156 (the
 * coordinator's call, which the owner may veto): the shared row reads its
 * ticks from `PLANS` like every other gated row, the pricing page's card bullet
 * lost its chip, and this page's Enterprise row names them again.
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

/**
 * The sentence a plan's figure carries about the other period, or `null`
 * where there is no saving to name.
 *
 * On yearly it is the saving against monthly; on monthly it is what switching
 * to yearly would save. Both are `yearlySaving`, worked out from the two rates
 * the card prints, so the figure is never larger than the arithmetic a reader
 * can do from the page. Free has no price to save on, and a plan whose two
 * rates were ever the same would say nothing rather than "Save 0%".
 */
export function savingLine(plan: OfferPlanId, period: BillingPeriod): string | null {
  if (plan === 'free') return null;
  const saving = yearlySaving(plan);
  if (saving <= 0) return null;
  return period === 'yearly' ? `Save ${saving}% on monthly` : `Save ${saving}% with yearly billing`;
}

/* ── Limits, as sentences ──────────────────────────────────────────────────── */

// The limits are the shared module's `LIMITS` — `PLANS`' own, per plan — so
// this page and the pricing page read one constant rather than two of the same
// name.

/** `3` → "3 members", `1` → "1 organisation", `null` → "Unlimited members". */
function many(limit: number | null, one: string, other: string): string {
  if (limit === null) return `Unlimited ${other}`;
  return `${limit.toLocaleString('en-GB')} ${limit === 1 ? one : other}`;
}

/**
 * The card's condition on its price — "Billed from 3 members up" — or `null`
 * for a plan without a seat floor. Under the figure, never as a tick: a minimum
 * charge is the opposite of an inclusion. The pricing page's own sentence,
 * `seatFloorCaveat`; not to be confused with the shared module's `seatFloor`,
 * which is the comparison table's cell ("3 members", "No minimum").
 */
function priceCaveat(seats: number): string | null {
  return seatFloorCaveat(seats) ?? null;
}

/* ── The cards ─────────────────────────────────────────────────────────────── */

export interface PlanOffer {
  readonly id: OfferPlanId;
  readonly name: string;
  /** One line answering "is this me?" before the list is read. */
  readonly audience: string;
  /**
   * The line over the list on a plan that builds on the one below it,
   * "Everything in Pro, plus", or `null` on the first rung. It is what lets
   * the list name only what changes.
   */
  readonly lead: string | null;
  /**
   * Ticked bullets: the few differences a team decides on (members, projects
   * and environments, audit history, and the gated capabilities), and not
   * every row. The rest is the comparison table's, which has every row. The
   * fetch allowance is not among them; see `includedFetches`.
   */
  readonly features: readonly string[];
  /**
   * Secret fetches included a month. Its own field, because the line it renders
   * carries a condition no other bullet has: what happens past it, which on a
   * paid plan is a charge and has to be said beside the number, as `/pricing`
   * says "Billed, never blocked".
   */
  readonly includedFetches: number;
  /** A condition on the price, rendered under it. */
  readonly caveat: string | null;
  readonly recommended: boolean;
}

/** "5 projects, 3 environments each": the room a plan gives, as one bullet. */
function room(plan: OfferPlanId): string {
  return `${many(LIMITS[plan].projects, 'project', 'projects')}, ${many(LIMITS[plan].environmentsPerProject, 'environment', 'environments')} each`;
}

export const PLAN_OFFERS: readonly PlanOffer[] = [
  {
    id: 'free',
    name: PLANS.free.name,
    audience: 'For one developer who has had enough of moving .env files around.',
    lead: null,
    features: [
      many(LIMITS.free.seats, 'member', 'members'),
      room('free'),
      `${formatRetention(LIMITS.free.auditRetentionDays)} of audit history`,
    ],
    includedFetches: LIMITS.free.includedFetchesPerMonth,
    caveat: priceCaveat(MINIMUM_SEATS.free),
    recommended: false,
  },
  {
    id: 'pro',
    name: PLANS.pro.name,
    // Not the pricing page's line, which describes Pro by a team that "does not
    // yet need to keep anyone out of production" — the unenforced gate above.
    audience: 'For a small team that has outgrown the free limits.',
    lead: `Everything in ${PLANS.free.name}, plus`,
    features: [
      // Just the count. It said "everyone can read every environment", which
      // is the unenforced per-environment gate stated from the other side.
      LIMITS.pro.seats === null ? 'Unlimited members' : many(LIMITS.pro.seats, 'member', 'members'),
      room('pro'),
      `${formatRetention(LIMITS.pro.auditRetentionDays)} of audit history`,
      'Secret referencing, overrides, promotion and point-in-time restore',
    ],
    includedFetches: LIMITS.pro.includedFetchesPerMonth,
    caveat: priceCaveat(MINIMUM_SEATS.pro),
    recommended: false,
  },
  {
    id: 'team',
    name: PLANS.team.name,
    // Not the pricing page's "somebody who must not see production" either —
    // what Team adds that the server enforces is room and policy.
    audience:
      'For a team that needs room to grow, and a say in how its secrets are named and exported.',
    lead: `Everything in ${PLANS.pro.name}, plus`,
    features: [
      room('team'),
      `${formatRetention(LIMITS.team.auditRetentionDays)} of audit history`,
      'A secret policy for names and values',
      'Plaintext export switched off per environment',
    ],
    includedFetches: LIMITS.team.includedFetchesPerMonth,
    caveat: priceCaveat(MINIMUM_SEATS.team),
    recommended: true,
  },
];

/** The two plans a checkout or a plan change can be for, in ladder order. */
export const PAID_OFFERS: readonly (PlanOffer & { readonly id: PaidPlanId })[] = PLAN_OFFERS.filter(
  (offer): offer is PlanOffer & { readonly id: PaidPlanId } => offer.id !== 'free',
);

/**
 * The words on the recommended plan's chip. Team is recommended because it is
 * the plan built for a team, which is what an organisation buying seats is;
 * the chip says that and no more. There is no sales data behind any plan, so
 * nothing here may call one the most popular.
 */
export const RECOMMENDED_LABEL = 'Recommended for teams';

/** The Enterprise row's condition on the (unpublished) price. */
export const ENTERPRISE_CAVEAT = priceCaveat(MINIMUM_SEATS.enterprise);

/**
 * What happens past a plan's fetch allowance, as the line under it says it.
 *
 * Free is never billed for usage; a paid plan is, at the metered rate, and
 * says so — `/pricing`'s "Billed, never blocked" with the rate attached. On an
 * installation that takes no payments nothing is billed on any plan, so only
 * the part that is true everywhere is said: nothing stops.
 */
export function pastTheAllowance(
  plan: OfferPlanId,
  payments: { taken: boolean; overageRate: string },
): string {
  if (!payments.taken) return 'Fetches past it keep working.';
  if (plan === 'free') return 'Fetches past it keep working, and are not billed.';
  return `Fetches past it keep working, and are billed at ${payments.overageRate}.`;
}

/* ── The free trial ────────────────────────────────────────────────────────── */

/**
 * How long Team's free trial runs, in days.
 *
 * The trial lives on the Dodo product rather than in this codebase, and
 * `server/billing/config.ts` (`TRIAL_PLANS`), `startCheckout` and the billing
 * runbook (docs/operations/billing.md §2) all give its length as fourteen
 * days. Restated here, with the plans that have one, because a client
 * component may import only types from the server's modules;
 * `upgrade-plans.test.ts` holds the list to the server's.
 */
export const TRIAL_DAYS = 14;

/** `TRIAL_PLANS` in `server/billing/config.ts`, as the client may know it: Team's alone. */
export const TRIAL_PLANS: ReadonlySet<PaidPlanId> = new Set<PaidPlanId>(['team']);

/**
 * The sentence beside a checkout that can start a free trial, or `null` for a
 * plan whose checkout cannot.
 *
 * A condition, because nothing this client can read says whether this one
 * will. A trial is had once per organisation and once per account
 * (`trialAlreadyUsed`, and the terms' billing clause); the billing read has no
 * field for it, and `trialEndsAt` is cleared when a subscription ends, so an
 * organisation back on Free after a trial looks like one that never had one.
 * So the button says what it does in every case, "Upgrade to Team", and this
 * says when a trial comes with it. The reminder is the terms' promise too,
 * kept by the hourly job's `trial_ending_3d` and `trial_ending_1d` emails to
 * the owners.
 */
export function trialNote(plan: PaidPlanId): string | null {
  if (!TRIAL_PLANS.has(plan)) return null;
  return (
    `Starts with a ${TRIAL_DAYS}-day free trial if neither this organisation nor your account ` +
    'has had one. Owners are emailed 3 days and 1 day before it ends.'
  );
}

/* ── What the chooser leads with ───────────────────────────────────────────── */

/**
 * The heading and the line under it, on the plans page and on the billing
 * screen alike: what an organisation gets, before what it costs or how it is
 * bought.
 *
 * Every word is one the product keeps. A paid plan does raise the limits on
 * members, environments and fetches (`PLANS`: three members, three
 * environments a project and 20,000 fetches a month on Free, and more of each
 * on every plan above it), and the encryption is the same on every plan (the
 * pricing page's "What every plan includes").
 */
export const PLAN_PITCH = {
  heading: 'Room for your whole team, and every build it ships',
  subhead:
    'Paid plans raise the limits on members, environments and secret fetches, and every plan keeps your secrets end-to-end encrypted.',
} as const;

/**
 * The same, for an organisation with a subscription: it is moving between
 * plans rather than buying one, and what it needs first is when a move takes
 * effect. The terms' billing clause, in its own order: up at once with the
 * unused part credited, down at the end of the period already paid for.
 */
export const CHANGE_PITCH = {
  heading: 'Move to the plan that fits your team now',
  subhead:
    'Moving up takes effect at once, with the unused part of this period credited. Moving down takes effect when the period you have paid for ends.',
} as const;

/* ── What is said beside the button ────────────────────────────────────────── */

export type ReassuranceId = 'provider' | 'currency' | 'cancel' | 'confirm' | 'kept';

/** One fact beside a purchase, with the icon the chooser draws for it. */
export interface ReassuranceItem {
  readonly id: ReassuranceId;
  readonly text: string;
}

/**
 * What is true of every checkout, said beside the button that starts one.
 *
 * Each line restates something the code or the terms already say, and
 * `upgrade-plans.test.ts` reads both for it:
 *
 *  - the checkout route: "We never see the card", and the terms: Dodo Payments
 *    is the merchant of record;
 *  - the terms: "the checkout shows the price in your currency before you
 *    pay", and prices exclude the tax that Dodo adds where it is due;
 *  - the terms: cancelling stops the next renewal and the organisation returns
 *    to Free at the end of the period paid for. Cancelling is the customer
 *    portal's, as the billing screen's portal card says.
 *
 * Nothing about refunds, which the terms limit, and nothing about a card at
 * the start of a trial, which is a setting on the Dodo product this code
 * cannot see.
 */
export const CHECKOUT_REASSURANCE: readonly ReassuranceItem[] = [
  {
    id: 'provider',
    text: 'Paid through Dodo Payments, our merchant of record. We never see your card.',
  },
  {
    id: 'currency',
    text: 'Checkout shows the price in your billing currency before you pay, and Dodo adds tax where it is due.',
  },
  {
    id: 'cancel',
    text: 'Cancel at any time from the customer portal. The plan runs to the end of the period you paid for, then moves to Free.',
  },
];

/**
 * What is true of every plan change, beside the button that asks for one: the
 * billing screen's preview comes before the confirm, and says whether the
 * change lands now or at the renewal; and a lower plan deletes nothing (the
 * terms: projects, environments, secrets and tokens "stay readable and
 * editable").
 */
export const CHANGE_REASSURANCE: readonly ReassuranceItem[] = [
  {
    id: 'confirm',
    text: 'Nothing changes until you confirm, and the review says when the change takes effect.',
  },
  {
    id: 'kept',
    text: 'Moving down deletes nothing: projects, environments, secrets and tokens stay readable and editable.',
  },
];

/**
 * The line for an organisation in a trial that is choosing a plan: moving up
 * ends the trial and is charged at once, as the terms say any move up during a
 * trial is.
 */
export const TRIALING_CHANGE_NOTE =
  'You are on a free trial. Moving up now ends the trial, and the new plan is charged at once.';

/* ── What each plan unlocks ────────────────────────────────────────────────── */

/** A column of the in-app comparison table. */
export type ComparisonPlanId = Exclude<PricingPlanId, 'self-hosted'>;

/**
 * The shared table's columns, less self-hosting.
 *
 * An organisation on this page is on the hosted service, and self-hosting is
 * not a plan it can move to from here — on `/pricing` it is the alternative to
 * buying, and it keeps its column there. The four left are the ones an
 * organisation can be on: three to buy here, and Enterprise to ask about.
 */
export const COMPARISON_COLUMNS: readonly {
  readonly id: ComparisonPlanId;
  readonly name: string;
}[] = [
  { id: 'free', name: PLANS.free.name },
  { id: 'pro', name: PLANS.pro.name },
  { id: 'team', name: PLANS.team.name },
  { id: 'enterprise', name: PLANS.enterprise.name },
];

/**
 * The shared table as this page shows it: every group and every row where the
 * installation sells. Where it sells nothing, two kinds of row are left out:
 *
 *  - the terms of a sale (`sale`) — the seat floor, what a machine costs, the
 *    overage, the SAML add-on — by the rule the cards follow for the price;
 *  - the facts about xecret's hosted service (`hosted`) — where the data sits,
 *    support, the SLA, running on your own hardware — which are false on an
 *    installation somebody else runs, and that is mostly who is reading here.
 *
 * What is left is the product: the limits the engine holds and the
 * capabilities it gates, true on any installation.
 */
export function comparisonFor(selling: boolean): readonly MatrixGroup[] {
  return PLAN_COMPARISON.map((group) => ({
    title: group.title,
    rows: group.rows.filter((row) => selling || (row.sale !== true && row.hosted !== true)),
  })).filter((group) => group.rows.length > 0);
}

/** Enterprise's column header, in the pricing page's words. Must agree with `/pricing`; the test says so. */
export const ENTERPRISE_PRICE = { price: 'Custom', unit: 'invoiced, with an SLA' } as const;

/**
 * The line under a paid plan's figure in the table header: which billing term
 * the figure is for. Free and Enterprise have no term to name.
 *
 * In the header rather than left to the toggle above, because the yearly
 * figure is a per-month rate that can only be bought twelve months at a time,
 * and a reader who scrolled to the table should not have to scroll back up to
 * find that out — the pricing page's header says it for the same reason.
 */
export function billingTerm(plan: ComparisonPlanId, period: BillingPeriod): string | null {
  if (plan === 'free' || plan === 'enterprise') return null;
  return period === 'yearly' ? 'billed yearly' : 'month to month';
}

/* ── The questions ─────────────────────────────────────────────────────────── */

/**
 * The order this page asks the shared questions in.
 *
 * Somebody on this page is deciding whether to buy, not whether to sign up, so
 * how to pay and what it costs come first, then what is counted, then what
 * changes later, and self-hosting — the way out of buying — last. A record
 * over the questions' ids, so a question added to the shared FAQ fails to
 * compile here until it is given a place: the page shows every question, and
 * a new one cannot quietly fall off the end.
 */
const FAQ_ORDER: Readonly<Record<PricingFaqId, number>> = {
  paying: 1,
  'annual-price': 2,
  members: 3,
  machines: 4,
  'pro-or-team': 5,
  'moving-plans': 6,
  'past-free': 7,
  'billing-and-builds': 8,
  'single-sign-on': 9,
  'regional-prices': 10,
  discounts: 11,
  stopping: 12,
  'self-hosting': 13,
};

/**
 * The shared FAQ as this page answers it.
 *
 * Shown only where the installation sells — the questions are about money, and
 * several quote prices — so every answer is the payments-live one, and where
 * the public answer describes the public page (its currency sheets, its second
 * price control) or sends the reader elsewhere to do what this page does, the
 * entry's `inApp` answer instead.
 */
export const PURCHASE_FAQ: readonly (FaqItem & { readonly id: PricingFaqId })[] = [...PRICING_FAQ]
  .sort((a, b) => FAQ_ORDER[a.id] - FAQ_ORDER[b.id])
  .map((item) => {
    const chosen = item.inApp ?? item.whenPaymentsLive ?? item;
    return { id: item.id, question: chosen.question, answer: chosen.answer };
  });

/* ── Ceilings, and the plan that lifts one ─────────────────────────────────── */

const ABOVE: Readonly<Record<OfferPlanId | 'enterprise', readonly PaidPlanId[]>> = {
  free: ['pro', 'team'],
  pro: ['team'],
  team: [],
  enterprise: [],
};

/**
 * The cheapest self-serve plan whose ceiling on `resource` is higher than the
 * one the organisation is near — the line under a "close to a limit" warning —
 * or `null` when no plan would lift it.
 *
 * `ceiling` is the limit the server actually warned at, which is not always
 * the plan's default: support can raise one for an organisation (a
 * `limitOverrides` entry, a raised seat limit). Comparing against the default
 * would tell an organisation allowed 40 projects that Pro "allows 25" as
 * though that were more.
 */
export function nextCeiling(
  current: OfferPlanId | 'enterprise',
  resource: 'seats' | 'projects' | 'serviceTokens',
  ceiling: number,
): { plan: PaidPlanId; sentence: string } | null {
  const noun = { seats: 'members', projects: 'projects', serviceTokens: 'service tokens' }[
    resource
  ];
  for (const plan of ABOVE[current]) {
    const limit = PLANS[plan].limits[resource];
    if (limit === null) return { plan, sentence: `${PLANS[plan].name} has no limit on ${noun}.` };
    if (limit > ceiling) {
      return { plan, sentence: `${PLANS[plan].name} allows ${limit.toLocaleString('en-GB')}.` };
    }
  }
  return null;
}

/* ── The billing screen's starting choice ──────────────────────────────────── */

/**
 * Where the plans page's "Switch to …" sends a subscriber: the billing screen,
 * opened on the plan and the period that were showing when it was pressed.
 */
export function switchPlanHref(org: string, plan: PaidPlanId, period: BillingPeriod): string {
  return withQuery(appPath.orgBilling(org), { plan, interval: period });
}

/**
 * The billing screen's half of `switchPlanHref`: its query, validated against
 * the two plans and two periods anybody can buy. Anything else — absent,
 * repeated, hand-typed — is dropped, and the form opens as it always has.
 *
 * Here rather than beside the billing screen because the page that calls it is
 * a server component, and a `'use client'` module's functions cannot be called
 * from one.
 */
export function billingChoiceFromQuery(
  query: Readonly<Record<string, string | string[] | undefined>>,
): { plan?: PaidPlanId; interval?: BillingPeriod } {
  const plan = query['plan'];
  const interval = query['interval'];
  return {
    ...(plan === 'pro' || plan === 'team' ? { plan } : {}),
    ...(interval === 'monthly' || interval === 'yearly' ? { interval } : {}),
  };
}

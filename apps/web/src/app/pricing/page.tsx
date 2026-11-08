import { Fragment } from 'react';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';

import {
  CtaBand,
  Faq,
  faqSchema,
  graph,
  JsonLd,
  PageHero,
  PublicPage,
  RevealGroup,
  Section,
  SectionHeading,
} from '@/components/marketing';
import type { FaqItem } from '@/components/marketing';
// Direct module imports rather than the `components/ui` barrel: this page is
// prerendered and public, and the barrel drags the dashboard's dependencies on
// to anything that touches it.
import { Badge } from '@/components/ui/badge';
import { CurrencyMenu } from './currency-menu';
import { RowHint, RowHintProvider } from './row-hint';
import { Button } from '@/components/ui/button';
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  FileTextIcon,
  HistoryIcon,
  LockIcon,
  MinusIcon,
  TerminalIcon,
} from '@/components/ui/icons';
// The comparison table, the FAQ and the limits they are composed from — shared
// with the in-app plans page, so the two cannot say different things. See the
// note at the top of that module.
import {
  ADDON_NOT_YET,
  formatCount,
  formatLimit,
  formatRetention,
  LIMITS,
  MINIMUM_SEATS,
  NOT_YET,
  PLAN_COMPARISON,
  PRICING_FAQ,
  seatFloorCaveat,
} from '@/components/plans/pricing-content';
import type { Cell, PricingPlanId } from '@/components/plans/pricing-content';
import { cn } from '@/lib/cn';
import { absoluteUrl, breadcrumbSchema, SITE_KEYWORDS, SITE_NAME } from '@/lib/site';
import { takesPayments } from '@/server/billing/payments-live';

/**
 * The pricing page.
 *
 * ── One place a price is written ──
 * Three things on this page state money: the plan cards, the header of the
 * comparison table, and the `Offer` nodes in the structured data. A rich result
 * advertising $12 above a page that renders $19 is a manual action from Google
 * waiting to happen, so the plan constants are the single source: the cards
 * read the four priced ones, the table header reads all five, and the JSON-LD
 * is derived from them rather than hand-written beside them. `PRICED_PLANS` is
 * a separate list only because self-hosting is not a rung on the ladder and
 * renders as a band; both flow into `PLANS`, and nothing is written twice.
 * The `amount` field exists so the published number is
 * never parsed back out of the display string — `'$12'` is typography and `'12'`
 * is data, and the day one of them gains a currency symbol or a suffix is the
 * day a regex would silently publish the wrong price.
 *
 * The same rule governs the limits, not only the price. Every `Offer`
 * description is composed from the audience line and the feature bullets the
 * card actually renders, so the free tier published to Google cannot advertise
 * a limit the page does not show.
 *
 * ── Why the billing toggle ships no JavaScript ──
 * Every currency and both periods are in the markup, and CSS shows whichever
 * pair the checked radios name — see `.x-price` and the eight reveal rules in
 * globals.css. The obvious alternative, `useState` and a client component
 * around the plans block, would turn the one part of this page a reader is
 * deciding on into something that arrives after hydration: on a slow connection
 * the card paints $12, the bundle lands, and the number changes under them. A
 * price that moves on its own is the last thing this page can afford. It also
 * costs a `'use client'` boundary on a document that otherwise ships none.
 *
 * The document is no longer *static*, which is a separate thing and is said
 * plainly at `resolveInitialCurrency` below: reading `CF-IPCountry` to pick the
 * opening currency opts this route into dynamic rendering.
 *
 * The shape of the JSX follows from the selector. `~` can only reach a later
 * sibling, so the two radios are the first children of the fieldset and
 * everything they govern — the segmented control and the four cards — sits in
 * one wrapper beside them. `:has()` would have allowed a freer arrangement and
 * a worse floor on browser support, on the page where being readable everywhere
 * matters most.
 *
 * ── Why the card bullets and the matrix are separate constants ──
 * A card bullet is a sentence — "3 environments per project" — and a table cell
 * is a token — "3". Deriving either from the other gives you bullets that read
 * like a spreadsheet or cells wide enough to break the table on a phone. So
 * they are written twice, deliberately. What is genuinely shared, and what
 * would actually cost something if it drifted, is the plan identity and the
 * price; that is shared, and the matrix is keyed by `PlanId` so a row can never
 * quietly fall out of step with the columns.
 *
 * ── Why the matrix is grouped ──
 * Twenty-six rows is past the point where a flat table is scannable — a reader
 * looking for "can CI read this?" should not have to pass every billing term on
 * the way. The groups are `<tbody>` elements with a spanning `scope="colgroup"`
 * header, which is the arrangement a screen reader announces as structure
 * rather than as a stray cell. Several rows read "Not yet" in all five columns.
 * They stay, because the row somebody is scanning for is the one that decides
 * whether they can migrate, and finding it absent tells them nothing.
 *
 * ── Saying "not yet" in both places at once ──
 * SAML and SCIM are named on the plans that will carry them, and neither is
 * built. So the bullet gets a `Not yet` chip and loses its tick, and the matrix
 * row says the same word in the same columns. A reader who finds a tick on a
 * card and an absence in the table for one capability has caught the page
 * lying, and on a product that holds credentials that is the most expensive
 * mistake available to us. `NOT_YET` is one constant for exactly that reason.
 *
 * ── On the honesty of every number here ──
 * Whether anything here is billed depends on the deployment, and the page asks
 * rather than assumes (`takesPayments`, `server/billing/payments-live.ts`). A
 * deployment with no payment provider configured — a self-hoster, this one
 * before Dodo is set up, or one rehearsing against Dodo's *test* mode — still
 * says that nothing is billed, in the description, the comparison table and
 * the FAQ. One that takes real payments (P12, Dodo's live mode) says how to pay
 * instead. The sentence came off in P12, as the plan said it would, and only
 * where it stopped being true.
 */

// Both of these name the billing period, and that is not pedantry: $5 and $12
// are the *yearly* rates and $8 and $19 the monthly ones, and these two strings
// are what a search result shows above the page. The cards open on yearly, so
// these lead with yearly and name monthly second — they follow the default
// rather than setting it, and if the toggle ever opens on monthly again they
// move back with it. A rich result advertising a price the page does not show
// is the failure mode the note at the top of this file is about; it just
// reaches the metadata too.
//
// Single sign-on came out of the description for the other reason: it is
// `notYet` on the Team card and `Coming soon` in the matrix, so promising it
// here made the metadata the most optimistic thing about the product.
// ── Why these are built per sheet, and not written once ──
// They quoted dollars unconditionally, which was correct until the body and the
// JSON-LD both learned to follow `CF-IPCountry`. After that a visitor in
// Bengaluru got a `<title>` and a `<meta name="description">` saying "$5 a
// member billed yearly" on the same response as cards painting ₹149 and a
// `Product` graph priced INR. `productSchema`'s own description dropped its
// prices for exactly that reason; leaving them here just moved the mismatch
// into the two strings a search result actually shows.
//
// A function rather than a constant means `metadata` has to become
// `generateMetadata`, which costs nothing here: the route is already dynamic
// because `resolveInitialCurrency` reads a header, so there is no prerender to
// give up.
function planPrices(id: PlanId, currency: CurrencyId) {
  const plan = PRICED_PLANS.find((candidate) => candidate.id === id);
  if (plan === undefined) throw new Error(`no priced plan named ${id}`);
  return plan.prices[currency];
}

function pricingTitle(currency: CurrencyId): string {
  return `Pricing: free forever, or ${planPrices('pro', currency).yearly.price} a member billed yearly`;
}

/**
 * The sentence above the cards, and why it names no price.
 *
 * It quoted "$12 … or $19" for a long time, which was wrong on four sheets out
 * of five once `resolveInitialCurrency` landed. Resolving it server-side fixed
 * that and broke something else: the hero is one string, while every other
 * figure on the page renders all five sheets and reveals one with CSS — and it
 * sits *before* the `x-cur-*` radios, so the forward-only `~` chain cannot
 * reach it even if the variants were emitted. A reader who opened on the euro
 * sheet and clicked USD got $12 on every card and €13 in the lede above them,
 * which also made `resolveInitialCurrency`'s promise that a wrong guess "costs
 * one click, not a wrong price" untrue.
 *
 * Both arrangements were a price that can disagree with the cards. So the hero
 * names none: it says what the shape of the pricing is, and the figures are
 * twenty pixels below it in the currency the reader actually chose. The only
 * alternative that works is moving the hero inside the radio wrapper, which
 * buys a sentence a figure it does not need at the cost of the page's
 * structure.
 */
const HERO_DESCRIPTION =
  'Four plans and a self-hosted option, published in full — the limits included. Free is ' +
  'genuinely free, every paid plan is per member with a lower yearly rate, service tokens and ' +
  'CI never cost anything, and running the whole server yourself is free forever.';

function pricingDescription(currency: CurrencyId, paymentsLive: boolean): string {
  const pro = planPrices('pro', currency);
  const team = planPrices('team', currency);

  return (
    `Four xecret plans: free for one developer, Pro ${pro.yearly.price} a member a month ` +
    `billed yearly (${pro.monthly.price} monthly), Team ${team.yearly.price} billed yearly ` +
    `(${team.monthly.price} monthly), Enterprise by contract, and self-hosted free forever. ` +
    (paymentsLive
      ? 'Service tokens and CI never cost anything, and a declined card never stops a build.'
      : 'Service tokens and CI never cost anything, and no card is taken in pre-alpha.')
  );
}

export async function generateMetadata(): Promise<Metadata> {
  const currency = await resolveInitialCurrency();
  const title = pricingTitle(currency);
  const description = pricingDescription(currency, await takesPayments());

  return {
    title,
    description,
    keywords: [
      'secret management pricing',
      'secrets manager pricing',
      'free secrets manager',
      'self-hosted secret management',
      ...SITE_KEYWORDS,
    ],
    alternates: { canonical: absoluteUrl('/pricing') },
    openGraph: {
      type: 'website',
      url: absoluteUrl('/pricing'),
      siteName: SITE_NAME,
      title: `${title} · ${SITE_NAME}`,
      description,
    },
  };
}

// Underlined at rest rather than on hover. With the accent gone monochrome
// there is no colour left to say "link", and foreground text that only reveals
// itself under a pointer is a link nobody navigating by keyboard can find.
const QUIET_LINK =
  'text-fg decoration-line-strong hover:decoration-fg inline-flex items-center gap-1.5 ' +
  'rounded-sm font-medium underline underline-offset-4 transition-colors';

// One half of the segmented control. The selected and focused states are not
// here: they are driven from the radio by a sibling rule in globals.css,
// because the inputs are `sr-only` and a Tailwind variant cannot reach across
// the wrapper that the `~` selector needs.
const SEGMENT =
  'text-fg-muted hover:text-fg flex h-9 cursor-pointer items-center gap-2 rounded-full px-4 ' +
  'text-sm font-medium transition-colors';

/**
 * The shell around each half of the control.
 *
 * Shared so the period toggle and the currency menu are the same height without
 * either one being measured against the other by hand. They sat at different
 * heights because one was a wrapper with `p-1` around `py-1.5` labels and the
 * other was a single bordered label: two ways of arriving at a pill, and two
 * answers. `h-11` on the shell and `h-9` on the control inside it is one answer,
 * applied twice.
 */
const CONTROL_SHELL =
  'border-line bg-canvas-inset inline-flex h-11 items-center rounded-full border p-1';

/**
 * The billing floor for a plan, or `1` where the plan has none.
 *
 * A function rather than an index because `PlanId` here spans two things the
 * engine does not: `self-hosted`, which is not a plan the engine bills at all,
 * and any future card added before its entitlements land. Indexing
 * `MINIMUM_SEATS` by `plan.id` would need a cast, and a cast is how
 * `undefined > 1` gets written by accident.
 */
function minimumSeats(id: PlanId): number {
  return id === 'self-hosted' ? 1 : MINIMUM_SEATS[id];
}

/* ── The plans ─────────────────────────────────────────────────────────────── */

/** The comparison table's columns, which are the cards and the self-hosting band. */
type PlanId = PricingPlanId;

/**
 * The four price sheets — pricing-plan.md §4.
 *
 * Not a conversion. Each is a deliberate number: the US and Australian sheets
 * are at parity because developer salaries are, Japan is about 25 per cent
 * below because yen pricing and a proper invoice matter there more than a deep
 * cut does, and India is about 65 per cent below because a price that is
 * reasonable in San Francisco is not reasonable in Bengaluru, and pretending
 * otherwise means not selling there at all.
 *
 * The euro sheet sits slightly *above* the dollar one — €9 against $8, €21
 * against $19 — which is the only sheet here that goes up. Two reasons, and
 * neither is that Europe can afford more: prices on the continent are quoted
 * and expected VAT-inclusive at rates from 19 to 27 per cent, and the euro has
 * spent long enough near parity that a sheet set from a 1.15 exchange rate would
 * be under water the first time it moves. Rounding up absorbs both rather than
 * leaving a customer to discover the difference at checkout.
 *
 * Ordered as they render in the selector.
 */
const CURRENCIES = [
  { id: 'usd', label: 'USD', symbol: '$' },
  { id: 'eur', label: 'EUR', symbol: '€' },
  { id: 'inr', label: 'INR', symbol: '₹' },
  { id: 'jpy', label: 'JPY', symbol: '¥' },
  { id: 'aud', label: 'AUD', symbol: 'A$' },
] as const;

type CurrencyId = (typeof CURRENCIES)[number]['id'];

const DEFAULT_CURRENCY: CurrencyId = 'usd';

/**
 * What the yearly rate saves, per sheet, as a whole percentage.
 *
 * ── Why these are written down and not computed ──
 * The rule at the top of this file is that a published number is never parsed
 * back out of a display string: `'$12'` is typography and `12` is data, and a
 * regex over the first would publish the wrong second the day a price gains a
 * suffix. So these are declared beside the prices they describe, the same way
 * `amount` is — and `pricing-page.test.ts` recomputes every one of them from
 * the price strings and fails if a sheet and its badge disagree. Parsing in a
 * test is safe in the way parsing at render is not: the test breaks loudly and
 * nothing reaches a customer.
 *
 * ── Why "up to" ──
 * Each figure is the *larger* of the two priced plans' savings on that sheet,
 * floored to a whole number. The two are not the same — the euro sheet saves
 * 33 per cent on Pro and 38 on Team, because each sheet is a set of deliberate
 * prices rather than one number converted five ways — so a bare percentage
 * would sit above a card contradicting it. An upper bound, floored, is true of
 * every card under it.
 */
const YEARLY_SAVING: Readonly<Record<CurrencyId, number>> = {
  usd: 37,
  eur: 38,
  inr: 40,
  jpy: 37,
  aud: 38,
};

/**
 * Which sheet a visitor sees first, by the country Cloudflare reports.
 *
 * Only a default. Every currency is in the markup and the selector switches
 * between them without JavaScript, so a wrong guess costs one click rather than
 * a wrong price — which is why this is allowed to be a short list of obvious
 * cases rather than an exhaustive mapping nobody can maintain.
 *
 * New Zealand joins Australia because the alternative for a New Zealander is
 * USD, and the Australian sheet is the closer of the two.
 */
const CURRENCY_BY_COUNTRY: Readonly<Record<string, CurrencyId>> = {
  IN: 'inr',
  JP: 'jpy',
  AU: 'aud',
  NZ: 'aud',
  // The euro area, which is a list rather than a rule: "in Europe" is not the
  // same set as "pays in euro", and a Swede, a Swiss or a Briton meeting a euro
  // price would be reading a currency they do not hold. Only the twenty
  // countries that actually use it are here; everywhere else falls to the
  // default, and one click fixes a wrong guess either way.
  AT: 'eur',
  BE: 'eur',
  HR: 'eur',
  CY: 'eur',
  EE: 'eur',
  FI: 'eur',
  FR: 'eur',
  DE: 'eur',
  GR: 'eur',
  IE: 'eur',
  IT: 'eur',
  LV: 'eur',
  LT: 'eur',
  LU: 'eur',
  MT: 'eur',
  NL: 'eur',
  PT: 'eur',
  SK: 'eur',
  SI: 'eur',
  ES: 'eur',
};

/** One billing period's figures, for one plan. */
interface PlanPrice {
  /** The large figure on the card. Typography, never parsed. */
  readonly price: string;
  /** The line under the figure. Reads as a continuation of it. */
  readonly unit: string;
  /** A third line, where the billing term needs spelling out in full. */
  readonly note?: string | undefined;
  /**
   * The same figure as a bare number, for structured data.
   *
   * Written beside `price` rather than extracted from it, for the reason
   * stated at the top of this file: `'₹1,317'` is typography and `1317` is
   * data, and a regex over the first would publish the wrong second the day a
   * sheet gains a thousands separator it did not have — which is exactly what
   * the rupee and yen sheets already have. `pricing-page.test.ts` checks the
   * two against each other so they cannot drift apart silently.
   *
   * Absent where there is no number to publish: `Custom`, and `Free`.
   */
  readonly amount?: string | undefined;
}

/**
 * One bullet on a card.
 *
 * An object rather than a string only because of `notYet`. A capability we have
 * announced but not shipped has to be marked wherever it is named, and a marker
 * that lives in a lookup table keyed by the bullet's own text is a marker that
 * silently stops applying the first time somebody rewords the bullet.
 */
interface PlanFeature {
  readonly text: string;
  /** Named on this plan, not built. Renders the chip and drops the tick. */
  readonly notYet?: boolean | undefined;
}

/** Both billing periods, for one currency. */
interface PlanPeriods {
  readonly monthly: PlanPrice;
  readonly yearly: PlanPrice;
}

interface Plan {
  readonly id: PlanId;
  readonly name: string;
  /**
   * Every currency, every period — all eight figures in the markup.
   *
   * The selector shows one and hides the rest with CSS, which is what lets a
   * visitor switch currency with no JavaScript and no request. It also means
   * the page publishes every price it charges, which is the honest arrangement
   * for a pricing page and an awkward one to argue against.
   */
  readonly prices: Readonly<Record<CurrencyId, PlanPeriods>>;
  /** One line, answering "is this me?" before the feature list is read. */
  readonly audience: string;
  readonly features: readonly PlanFeature[];
  readonly cta: {
    readonly label: string;
    readonly href: string;
    /** Leaves the site — gets the external icon and `rel="noreferrer noopener"`. */
    readonly external: boolean;
  };
  readonly recommended: boolean;
  /**
   * The published price where it is the same in every currency.
   *
   * Only two values are legitimate here: `'0'` for Free and self-hosting, and
   * `null` for Enterprise, which has no price to publish at all. A priced plan
   * leaves this alone — its figure lives on the sheet, as
   * `prices[currency].yearly.amount`, because `productSchema` publishes the
   * rate for the currency the page actually opened on and a single number
   * cannot be that for five sheets.
   *
   * It briefly held `'5'` and `'12'` as well, which was worse than redundant:
   * `productSchema` had stopped reading them, so editing the yearly rate here
   * changed nothing in the structured data while looking exactly like the place
   * to do it. A field that silently does nothing is a trap for the next
   * person, so the priced plans no longer carry one.
   *
   * Optional rather than `| null` for that reason: absent means "this plan's
   * price is on its sheets", which is a different statement from Enterprise's
   * explicit `null` — "there is no price to publish". The type now makes the
   * priced plans unable to carry a figure here by accident.
   */
  readonly amount?: string | null | undefined;
  /** Published as `unitText`, where the price is per something. */
  readonly unitText: string | null;
  /**
   * A condition on the price, rendered under it and never as a bullet.
   *
   * The seat floor lived in `features` for one commit, which gave it a
   * `CheckIcon` beside "Roles and per-environment access" and — because
   * `offerDescription` maps the same array — published it to shopping surfaces
   * as `Includes: … Billed from 3 members up`. A minimum charge is the opposite
   * of an inclusion, and a tick is the one affordance this file's rules say
   * must never sit beside something that is not a benefit. It belongs with the
   * price it qualifies, so it lives here rather than in `features`.
   *
   * `offerDescription` *does* read it — appended after the annual clause, never
   * into the `Includes:` list. Leaving it out of the structured data made the
   * one machine-readable surface the only one hiding the floor, which inverts
   * the reason `MINIMUM_SEATS` is published at all. The distinction that matters
   * is "not a bullet", not "not published"; an earlier version of this note said
   * the latter and contradicted the code two hundred lines down.
   */
  readonly priceCaveat?: string | undefined;
}

/**
 * The five plans with a price. These are the cards.
 *
 * ── Where the numbers come from ──
 * `.local/plans/pricing-plan.md` §3 and §4. Yearly is the headline rate and is
 * roughly 37 per cent below monthly, which is not generosity: it brings the
 * cash in on day one, removes twelve renewal decisions a year, and cuts the
 * payment processor's fee burden from about 9.5 per cent of revenue to about
 * 5.2, because the fixed per-charge component is paid once instead of twelve
 * times. Four of those thirty-seven points pay for themselves.
 *
 * ── Why the limits here are not written here ──
 * Every limit on a card and in the matrix below is read from `plans.ts` in
 * `@xecret/core/entitlements` through `LIMITS`, the same file the server
 * enforces from. A pricing page that advertises a ceiling the server does not
 * hold is a page that will one day refuse a customer something they paid for.
 * The *prices* stay local, because a price is typography as much as data and
 * varies by currency; a limit is a number with one correct value.
 *
 * Annotated rather than `as const satisfies`: a const assertion would give each
 * bullet its own object type, and half of them have no `notYet` key at all, so
 * the card renderer could not read the field on the union it maps over without
 * a cast. The annotation still rejects an unknown key or a missing one, which
 * is the whole of what the assertion was buying.
 */
const PRICED_PLANS: readonly Plan[] = [
  {
    id: 'free',
    name: 'Free',
    prices: {
      usd: {
        monthly: { price: '$0', unit: 'forever, no card' },
        yearly: { price: '$0', unit: 'forever, no card' },
      },
      eur: {
        monthly: { price: '€0', unit: 'forever, no card' },
        yearly: { price: '€0', unit: 'forever, no card' },
      },
      inr: {
        monthly: { price: '₹0', unit: 'forever, no card' },
        yearly: { price: '₹0', unit: 'forever, no card' },
      },
      jpy: {
        monthly: { price: '¥0', unit: 'forever, no card' },
        yearly: { price: '¥0', unit: 'forever, no card' },
      },
      aud: {
        monthly: { price: 'A$0', unit: 'forever, no card' },
        yearly: { price: 'A$0', unit: 'forever, no card' },
      },
    },
    audience: 'For one developer who has had enough of moving .env files around.',
    features: [
      { text: `${LIMITS.free.organizations} organisation, ${LIMITS.free.projects} projects` },
      { text: `${LIMITS.free.environmentsPerProject} environments per project` },
      { text: `${LIMITS.free.seats} members` },
      { text: `${LIMITS.free.serviceTokens} service tokens for CI` },
      { text: `${formatCount(LIMITS.free.includedFetchesPerMonth)} secret fetches a month` },
      { text: `${LIMITS.free.auditRetentionDays} days of audit history` },
      { text: 'Community support on GitHub' },
    ],
    cta: { label: 'Start free', href: '/sign-up', external: false },
    recommended: false,
    amount: '0',
    unitText: null,
  },
  {
    id: 'pro',
    name: 'Pro',
    prices: {
      usd: {
        monthly: { price: '$8', unit: 'per member, per month' },
        yearly: {
          price: '$5',
          amount: '5',
          unit: 'per member, per month',
          note: '$60 per member, billed yearly',
        },
      },
      eur: {
        monthly: { price: '€9', unit: 'per member, per month' },
        yearly: {
          price: '€6',
          amount: '6',
          unit: 'per member, per month',
          note: '€72 per member, billed yearly',
        },
      },
      inr: {
        monthly: { price: '₹249', unit: 'per member, per month' },
        yearly: {
          price: '₹149',
          amount: '149',
          unit: 'per member, per month',
          note: '₹1,788 per member, billed yearly',
        },
      },
      jpy: {
        monthly: { price: '¥900', unit: 'per member, per month' },
        yearly: {
          price: '¥567',
          amount: '567',
          unit: 'per member, per month',
          note: '¥6,800 per member, billed yearly',
        },
      },
      aud: {
        monthly: { price: 'A$13', unit: 'per member, per month' },
        yearly: {
          price: 'A$8',
          amount: '8',
          unit: 'per member, per month',
          note: 'A$96 per member, billed yearly',
        },
      },
    },
    audience:
      'For a small team that has outgrown the free limits and does not yet need to keep anyone out of production.',
    features: [
      {
        text: `${formatLimit(LIMITS.pro.projects)} projects across ${formatLimit(LIMITS.pro.organizations)} organisations`,
      },
      {
        text: `${formatLimit(LIMITS.pro.environmentsPerProject)} environments per project, ${formatLimit(LIMITS.pro.secretsPerEnvironment)} secrets in each`,
      },
      // The one uncapped thing on this tier, and it is uncapped on purpose:
      // the gate to Team is per-environment access control, not headcount.
      { text: 'Unlimited members — everyone can read every environment' },
      { text: `${formatLimit(LIMITS.pro.serviceTokens)} service tokens for CI, all free` },
      { text: `${formatCount(LIMITS.pro.includedFetchesPerMonth)} secret fetches a month` },
      { text: `${LIMITS.pro.auditRetentionDays} days of audit history` },
      { text: 'Secret referencing and environment inheritance' },
    ],
    cta: { label: 'Start on Pro', href: '/sign-up', external: false },
    recommended: false,
    unitText: 'member/month',
  },
  {
    id: 'team',
    name: 'Team',
    prices: {
      usd: {
        monthly: { price: '$19', unit: 'per member, per month' },
        yearly: {
          price: '$12',
          amount: '12',
          unit: 'per member, per month',
          note: '$144 per member, billed yearly',
        },
      },
      eur: {
        monthly: { price: '€21', unit: 'per member, per month' },
        yearly: {
          price: '€13',
          amount: '13',
          unit: 'per member, per month',
          note: '€156 per member, billed yearly',
        },
      },
      inr: {
        monthly: { price: '₹599', unit: 'per member, per month' },
        yearly: {
          price: '₹375',
          amount: '375',
          unit: 'per member, per month',
          note: '₹4,499 per member, billed yearly',
        },
      },
      jpy: {
        monthly: { price: '¥2,100', unit: 'per member, per month' },
        yearly: {
          price: '¥1,317',
          amount: '1317',
          unit: 'per member, per month',
          note: '¥15,800 per member, billed yearly',
        },
      },
      aud: {
        monthly: { price: 'A$29', unit: 'per member, per month' },
        yearly: {
          price: 'A$19',
          amount: '19',
          unit: 'per member, per month',
          note: 'A$228 per member, billed yearly',
        },
      },
    },
    audience:
      'For a team with somebody who must not see production — a contractor, a junior, an auditor.',
    features: [
      { text: 'Everything in Pro' },
      { text: 'Roles and per-environment access' },
      {
        text: `${formatLimit(LIMITS.team.projects)} projects, ${formatLimit(LIMITS.team.secretsPerEnvironment)} secrets per environment`,
      },
      { text: `${formatLimit(LIMITS.team.serviceTokens)} service tokens for CI` },
      { text: `${formatCount(LIMITS.team.includedFetchesPerMonth)} secret fetches a month` },
      { text: `${formatRetention(LIMITS.team.auditRetentionDays)} of audit history` },
      { text: 'Single sign-on with OIDC, included', notYet: true },
      // Came down from Scale when that tier went. Both are security posture a
      // small team with a contractor needs most, which is the argument for them
      // being here rather than behind a contract — see TEAM_FEATURES.
      { text: 'GitHub OIDC federation — no static CI tokens', notYet: true },
      { text: 'Scheduled and expiring secrets', notYet: true },
      { text: 'Change approvals and break-glass access', notYet: true },
    ],
    cta: { label: 'Start on Team', href: '/sign-up', external: false },
    recommended: true,
    priceCaveat: seatFloorCaveat(MINIMUM_SEATS.team),
    unitText: 'member/month',
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    prices: {
      usd: {
        monthly: { price: 'Custom', unit: 'invoiced, with an SLA' },
        yearly: { price: 'Custom', unit: 'invoiced, with an SLA' },
      },
      eur: {
        monthly: { price: 'Custom', unit: 'invoiced, with an SLA' },
        yearly: { price: 'Custom', unit: 'invoiced, with an SLA' },
      },
      inr: {
        monthly: { price: 'Custom', unit: 'invoiced, with an SLA' },
        yearly: { price: 'Custom', unit: 'invoiced, with an SLA' },
      },
      jpy: {
        monthly: { price: 'Custom', unit: 'invoiced, with an SLA' },
        yearly: { price: 'Custom', unit: 'invoiced, with an SLA' },
      },
      aud: {
        monthly: { price: 'Custom', unit: 'invoiced, with an SLA' },
        yearly: { price: 'Custom', unit: 'invoiced, with an SLA' },
      },
    },
    audience:
      'For an organisation that needs residency, its own root key and a contract behind both.',
    features: [
      { text: 'Everything in Team' },
      { text: 'No ceiling on projects, environments, secrets or tokens' },
      { text: 'Custom roles', notYet: true },
      { text: 'Audit streamed to your SIEM', notYet: true },
      // Both included, which is what `pricing-plan.md` §3 and §8.4 say: the
      // $1,500 Enterprise floor is sized to absorb the two WorkOS connections.
      // This bullet spent a few commits claiming SCIM was charged per
      // connection here, because the matrix cell said `Add-on` and everything
      // else was changed to agree with it. That is the wrong direction — the
      // plan of record is the tie-breaker and it includes both.
      { text: 'SAML single sign-on included', notYet: true },
      { text: 'Directory sync (SCIM) included', notYet: true },
      // Chipped, because it is not built. `packages/core/src/crypto/escrow.ts`
      // is the recovery-share format for an account, not a customer-held root
      // key — the hosted service holds the root key for every plan today, which
      // is what `/docs/security/trust-model` says and what the self-hosting
      // band offers as the actual alternative. This was the one bullet on the
      // page carrying a tick for something nobody can have.
      { text: 'Your own root key, and the escrow ceremony to go with it', notYet: true },
      // Split, for the same reason as Scale's audit bullet: the matrix already
      // publishes `Custom` retention for this column as a live value, so one
      // chip across both halves had the card and the table disagreeing. The
      // residency half is the unbuilt one — "Where your data sits" reads
      // "Cloudflare's network" in every hosted column, this one included.
      { text: 'Custom audit retention' },
      { text: 'Data residency', notYet: true },
      { text: 'A commercial, non-AGPL self-hosting licence' },
      { text: 'A contractual SLA and a named contact' },
    ],
    // ── Why this is a form now, and was an issue link ──
    // The issue tracker was the honest answer while there was nowhere else for
    // the conversation to go, and it was the wrong one for this card: an
    // Enterprise enquiry names a team size, a jurisdiction and sometimes a
    // questionnaire, and a public tracker is where none of that belongs. The
    // contact page is still not a sales funnel — it asks four fields and posts
    // them to the channel we already watch — and `/contact` keeps the issue link
    // beside the form, for the questions that genuinely are better in the open.
    cta: { label: 'Contact sales', href: '/contact', external: false },
    recommended: false,
    // Enterprise has a floor too, and a larger one than Team — ten seats
    // against three. It was stated in the matrix, the FAQ and the Terms but not
    // on the card, which is the omission the `MINIMUM_SEATS` docblock calls
    // misleading rather than terse, applied to one of the two plans that has a
    // floor and not the other.
    priceCaveat: seatFloorCaveat(MINIMUM_SEATS.enterprise),
    amount: null,
    unitText: null,
  },
];

/**
 * Self-hosting, which is not a rung on the ladder.
 *
 * It renders as a band under the cards rather than as a sixth card, because a
 * sixth card would invite the comparison the other five are asking for — more
 * money, more features — and self-hosting is the opposite arrangement: no
 * money, every feature, all of the operational work. It keeps its column in the
 * matrix and its `Offer` in the structured data, which is why it is a `Plan`.
 */
const SELF_HOSTED: Plan = {
  id: 'self-hosted',
  name: 'Self-hosted',
  prices: {
    usd: {
      monthly: { price: 'Free', unit: 'always' },
      yearly: { price: 'Free', unit: 'always' },
    },
    eur: {
      monthly: { price: 'Free', unit: 'always' },
      yearly: { price: 'Free', unit: 'always' },
    },
    inr: {
      monthly: { price: 'Free', unit: 'always' },
      yearly: { price: 'Free', unit: 'always' },
    },
    jpy: {
      monthly: { price: 'Free', unit: 'always' },
      yearly: { price: 'Free', unit: 'always' },
    },
    aud: {
      monthly: { price: 'Free', unit: 'always' },
      yearly: { price: 'Free', unit: 'always' },
    },
  },
  audience: 'For anyone who would rather hold their own root key and run their own server.',
  features: [
    { text: 'The whole server, under AGPL-3.0' },
    { text: 'No feature held back, no licence key' },
    { text: 'Single sign-on included — bring your own identity provider', notYet: true },
    { text: 'Unlimited organisations, projects, members and environments' },
    { text: 'Audit history for as long as your database keeps it' },
    { text: 'Community support, or an Enterprise contract' },
  ],
  cta: { label: 'Read the self-hosting guide', href: '/docs/self-hosting', external: false },
  recommended: false,
  amount: '0',
  unitText: null,
};

/** Every plan, in column order. The matrix header and the JSON-LD read this. */
const PLANS: readonly Plan[] = [...PRICED_PLANS, SELF_HOSTED];

/* ── Add-ons ───────────────────────────────────────────────────────────────── */

/**
 * The two capabilities that are bought rather than reached by moving tier.
 *
 * ── Why these are add-ons ──
 * Each is one WorkOS connection, and WorkOS bills us $125 a month for each one
 * whether or not anybody signs in through it. A connection is a connection
 * there: SAML and OIDC cost the same. That is the whole reason OIDC single
 * sign-on is *included* at Team and SAML is not — we implemented OIDC
 * ourselves, it costs us nothing per customer, and charging for it would be
 * the SSO tax this pricing is positioned against.
 *
 * The page used to publish that $125 beside the $199 ("show the receipt").
 * The owner withdrew it on 2026-11-06 — the rendered copy stays professional
 * and names no supplier costs or margins. The reasoning above is for THIS
 * file only; keep it out of `body` and out of the FAQ answer. The rule that
 * OIDC will ship included stays public, because that is a promise to buyers,
 * not a cost disclosure.
 */
/**
 * The add-ons, and the tier each one starts from.
 *
 * ── Why there is only SAML here ──
 * SCIM used to sit beside it at $249. It should not have: `pricing-plan.md` §3
 * marks SCIM `✅ included` in the Enterprise column and `add-on` in *Scale*,
 * and §8.3 says in as many words "offer it as a $249/mo add-on on Scale, and
 * include it in Enterprise", with §8.4 titled "Enterprise includes both,
 * because the floor pays for them". Scale was removed in #101, so the tier that
 * bought the add-on no longer exists, and §8.3's other half — "never bundle it
 * below Enterprise" — rules out moving the charge down to Team. That leaves
 * SCIM as a plain Enterprise inclusion with no price to publish.
 *
 * This was resolved the wrong way round once already. The band originally read
 * "Included with Enterprise", the matrix cell read `ADDON_NOT_YET`, and the
 * inconsistency was settled by believing the cell — which put a $249 charge in
 * front of Enterprise customers in the contractual Terms, for something the
 * $1,500 floor is documented as already absorbing. The plan of record was the
 * tie-breaker and it says included.
 *
 * `notYet` stays because SAML is not built, and this band was the last surface
 * still implying otherwise: the matrix cells read `Add-on, coming soon` and the
 * paragraph under the table says "neither is built for anybody, at any price",
 * while the band rendered a live price. `from` is here for the same reason — a
 * band that omits the gate tells a Free reader they can buy it.
 *
 * ── Why the add-on sheets are converted and the plan sheets are not ──
 * Every plan price on this page is *set* for its market: India is about 65 per
 * cent below the US sheet because a price that is reasonable in San Francisco is
 * not reasonable in Bengaluru, and a seat costs us the same either way — which
 * is to say almost nothing.
 *
 * An add-on does not work like that. Each one is a WorkOS connection billed to
 * us at $125 a month in dollars, wherever the customer is. Discounting these to
 * the Indian sheet would price them at roughly $75 and we would be paying for
 * the privilege of selling them. So these four figures are the same price
 * converted, not four decisions, and the band says so rather than letting a
 * reader infer a regional discount that is not there.
 */
const ADDONS = [
  {
    name: 'SAML single sign-on',
    prices: { usd: '$199', eur: '€185', inr: '₹16,900', jpy: '¥29,900', aud: 'A$309' },
    unit: 'per connection, per month',
    // "Team and above" put a $199 charge in front of an Enterprise buyer whom
    // three other surfaces — the Enterprise card bullet, the matrix and the
    // Terms — tell it is included. The Terms are the document they sign, so
    // the band was the outlier: this is a Team charge and an Enterprise
    // inclusion, which is the mirror of how SCIM works one entry below.
    from: 'Team only — included with Enterprise',
    notYet: true,
    body: 'Connect your SAML 2.0 identity provider — Okta, Microsoft Entra ID, OneLogin, PingFederate and the rest. Each connection is set up together with your identity team and comes with priority support for it. Enterprise plans include SAML connections. OIDC single sign-on will be included from Team at no extra cost — neither is built yet.',
  },
] as const;

/* ── The comparison matrix ─────────────────────────────────────────────────── */

// The rows are `PLAN_COMPARISON` in `components/plans/pricing-content.ts`, with
// the notes on why each cell says what it does. They moved there so the in-app
// plans page could render the same table rather than a reduced copy of it; how
// this page draws them — the grouped `<tbody>`s, the price header, `CellValue`
// — is still here.

/* ── True at every tier ────────────────────────────────────────────────────── */

const INCLUDED = [
  {
    icon: LockIcon,
    title: 'Per-environment encryption',
    body: 'Every environment gets its own data key the moment it is created, encrypted under a root key we hold. Nothing about that changes with the plan you are on — and we say plainly what it does and does not protect you from.',
    link: { href: '/docs/security/trust-model', label: 'What xecret can and cannot see' },
  },
  {
    icon: HistoryIcon,
    title: 'The audit log',
    body: 'Every read, write and decryption is written to an append-only log, on the free tier exactly as on Enterprise. A plan changes how far back you can look, never whether it was recorded.',
    link: { href: '/docs/security/audit-log', label: 'How the audit log works' },
  },
  {
    icon: TerminalIcon,
    title: 'The CLI',
    body: 'xecret run -- npm run dev, an offline cache for when the network is not there, and service tokens for CI. A free account gets the same binary as a paid one.',
    link: { href: '/docs/cli/commands', label: 'The CLI reference' },
  },
  {
    icon: FileTextIcon,
    title: 'The open source licence',
    body: 'The server is AGPL-3.0 and the CLI is MIT, at every tier. You can read the code that holds your credentials before you trust it, and keep running it if we disappear.',
    link: { href: '/about', label: 'Who is building xecret' },
  },
] as const;

/* ── FAQ ───────────────────────────────────────────────────────────────────── */

// The questions are `PRICING_FAQ` in `components/plans/pricing-content.ts`,
// shared with the in-app plans page for the same reason as the matrix. Each
// entry also carries an `id` and, on two of them, an `inApp` answer for that
// page; neither is read here.

/** The FAQ as this deployment answers it: plain `FaqItem`s, for the page and its structured data alike. */
function faqFor(paymentsLive: boolean): readonly FaqItem[] {
  return PRICING_FAQ.map((item) => {
    const chosen = paymentsLive && item.whenPaymentsLive ? item.whenPaymentsLive : item;
    return { question: chosen.question, answer: chosen.answer };
  });
}

/* ── Structured data ───────────────────────────────────────────────────────── */

/**
 * The offer description, assembled from what the card renders.
 *
 * A hand-written offer description is the field that goes stale the first time
 * a limit changes — and a stale limit in structured data is one Google keeps
 * serving long after the page is right. An unbuilt capability carries its
 * caveat here too: an `Offer` that lists SAML without it is the tick this page
 * refuses to show, published somewhere nobody on the team ever reads back.
 *
 * It takes the currency for the same reason `productSchema` does: this string
 * ends in the annual total, and reading that off `prices.usd` while the node
 * around it published `priceCurrency: 'INR'` put "Annual equivalent: $60" in
 * an offer priced ₹149 — the currency mismatch moved rather than fixed.
 *
 * `priceCaveat` is appended, and appended *after* the `Includes:` list rather
 * than into it. Keeping it out of `features` was right — a minimum charge is
 * not something the plan includes — but leaving it out of this string too made
 * the one machine-readable surface the only one that omits the seat floor,
 * which is the opposite of the argument the `MINIMUM_SEATS` docblock makes for
 * publishing it at all. A shopping surface rendering "Team, $12 per
 * member/month billed annually" with no floor is how a two-person team
 * computes $288 and is invoiced $432.
 */
function offerDescription(plan: Plan, currency: CurrencyId): string {
  const includes = plan.features
    .map((feature) => (feature.notYet === true ? `${feature.text} (not built yet)` : feature.text))
    .join('; ');
  const note = plan.prices[currency].yearly.note;
  const annual = note === undefined ? '' : ` Annual equivalent: ${note}.`;
  const caveat = plan.priceCaveat === undefined ? '' : ` ${plan.priceCaveat}.`;

  return `${plan.audience} Includes: ${includes}.${annual}${caveat}`;
}

/**
 * The plans as a `Product` with one `Offer` per plan, derived from `PLANS`.
 *
 * ── Why this takes the currency ──
 * It used to be a module constant pinned to `priceCurrency: 'USD'`, which was
 * true only until `resolveInitialCurrency` landed. After that a visitor in
 * Bengaluru was served a page painting ₹149 with structured data underneath it
 * claiming `price: '5', priceCurrency: 'USD'` — wrong on four sheets out of
 * five, and wrong in the specific way this file's own rule names: an offer
 * that publishes a number the default render does not show is the same defect
 * as publishing the wrong one. It is a function now, and it is handed the same
 * currency the cards open on.
 *
 * ── Why the offer says the term, in words ──
 * The published figure is the yearly rate, which is a per-month price that can
 * only be bought twelve at a time. A bare "member/month" reads to a shopping
 * surface as a monthly-purchasable price, so the unit string says
 * "member/month, billed annually" instead — the difference between "$5 a month"
 * and "$5 a month on an annual term", which is the difference between an
 * accurate rich result and a complaint.
 *
 * It is deliberately *not* `billingDuration`. Both spellings of that field were
 * wrong here: `12` with `unitCode: 'MON'` redefines the reference quantity and
 * contradicts the unit text, and `'P1Y'` means — per schema.org's own wording,
 * "for how long this price will be billed" — that five dollars covers the year,
 * understating the real $60 twelvefold. Google does not document the property
 * for `Offer` either, so neither spelling would have reached a rich result. The
 * note beside the field records this so it is not reintroduced a third time.
 *
 * Enterprise carries no `price` at all rather than a placeholder zero. A `0`
 * there would be published to a shopping surface as free, which is the one
 * mistake in this file that would end up in front of a customer.
 */
function productSchema(currency: CurrencyId) {
  const code = currency.toUpperCase();

  return {
    '@type': 'Product',
    '@id': absoluteUrl('/pricing#plans'),
    name: `${SITE_NAME} plans`,
    // Deliberately *not* `DESCRIPTION`. That string quotes "$5" and "$12"
    // because it is the meta description and a search result should carry a
    // figure — but it would sit here in the same `@graph` as offers priced in
    // euro or rupees, which is the mismatch this function exists to end. The
    // prices are in the offers; this only has to say what the product is.
    description: `Every ${SITE_NAME} plan, with the limits each one carries and what it costs. Free forever for a single developer, per-member pricing above that, and the whole server self-hostable at no charge.`,
    category: 'Secret management',
    brand: { '@id': absoluteUrl('/#organization') },
    url: absoluteUrl('/pricing'),
    offers: PLANS.map((plan) => {
      // The figure the card is painting: this sheet's yearly rate where the
      // plan has one, falling back to the plan-level amount for Free and
      // self-hosting, whose price is `0` in every currency.
      // `?? null` so the two ways of having no number — an absent field and
      // Enterprise's explicit `null` — collapse to one before the check below.
      // Without it a plan that carried neither would fall through the
      // `=== null` guard and publish `price: undefined`.
      const amount = plan.prices[currency].yearly.amount ?? plan.amount ?? null;

      return {
        '@type': 'Offer',
        '@id': absoluteUrl(`/pricing#${plan.id}`),
        name: plan.name,
        description: offerDescription(plan, currency),
        url: absoluteUrl(`/pricing#${plan.id}`),
        availability: 'https://schema.org/InStock',
        // Outside the price branch, because Enterprise has the *larger* floor —
        // ten seats against Team's three — and carries no price, so nesting this
        // under `amount !== null` published it for the smaller floor only. The
        // round-10 commit added `priceCaveat` to Enterprise to close exactly
        // this asymmetry on the card and left it open in the structured data.
        // `eligibleQuantity` qualifies the offer, not the figure, so it belongs
        // here whether or not there is a figure.
        ...(minimumSeats(plan.id) > 1
          ? {
              eligibleQuantity: {
                '@type': 'QuantitativeValue',
                minValue: minimumSeats(plan.id),
                unitText: 'member',
              },
            }
          : {}),
        ...(amount === null
          ? {}
          : {
              price: amount,
              priceCurrency: code,
              priceSpecification: {
                '@type': 'UnitPriceSpecification',
                price: amount,
                priceCurrency: code,
                // The term lives in the unit string, and `billingDuration` is
                // gone. Two goes at that field were both wrong in opposite
                // directions. `billingDuration: 12` with `unitCode: 'MON'`
                // redefines the reference quantity and contradicts
                // `unitText`; `billingDuration: 'P1Y'` reads, by schema.org's
                // own definition — "for how long this price will be billed" —
                // as *five dollars covering a year*, which understates the
                // real $60 by a factor of twelve. And it buys nothing even
                // when correct: `billingDuration` is not among the properties
                // Google documents for `Offer`, so the disclosure it was added
                // to publish never reached a rich result either way.
                //
                // A plain unit string cannot be misparsed, and the annual
                // total is already spelled out in the offer description, which
                // *is* read. Free and self-hosting keep the bare unit: they
                // are `0` on any term, and "billed annually" about free is
                // nonsense.
                ...(plan.unitText === null
                  ? {}
                  : {
                      unitText:
                        plan.prices[currency].yearly.amount === undefined
                          ? plan.unitText
                          : `${plan.unitText}, billed annually`,
                    }),
              },
            }),
      };
    }),
  };
}

/* ── Pieces ────────────────────────────────────────────────────────────────── */

/**
 * One bullet in a plan's feature list.
 *
 * Shared by the cards and by the self-hosting band, and that sharing is the
 * whole point rather than a tidiness: the band used to map `features` itself
 * and render an unconditional tick, so `Single sign-on included` sat under a
 * check on the band while the matrix row said `Not yet` in the same column and
 * the JSON-LD published "(not built yet)" for the same bullet. Three renderings
 * of one field, and only two of them read it. There is now one, so a bullet
 * that gains `notYet` cannot pick up a tick anywhere on the page.
 */
function PlanFeatureItem({ feature }: { feature: PlanFeature }) {
  const notYet = feature.notYet === true;

  return (
    <li className="flex gap-2.5">
      {/* No tick beside something that does not exist. The dash is the same
          glyph the matrix uses for an absence, and the chip beside the text is
          the same word the matrix row carries. */}
      {notYet ? (
        <MinusIcon className="text-fg-subtle mt-1 size-4 shrink-0" />
      ) : (
        <CheckIcon className="text-fg-subtle mt-1 size-4 shrink-0" />
      )}
      <span className="text-fg-muted text-sm leading-6">
        {feature.text}
        {notYet ? (
          <span className="border-line text-fg-subtle ml-1.5 rounded-full border px-1.5 py-0.5 text-[0.6875rem] font-medium whitespace-nowrap">
            {NOT_YET}
          </span>
        ) : null}
      </span>
    </li>
  );
}

/**
 * One currency and one billing period's figures, inside a card.
 *
 * All ten are rendered on every card and nine are `display: none` — not
 * `visibility: hidden`, which would leave every card announcing eight prices
 * one after another to a screen reader.
 */
function PriceBlock({
  value,
  className,
  reserveNote,
}: {
  value: PlanPrice;
  className: string;
  reserveNote: boolean;
}) {
  return (
    <div className={className}>
      <p className="text-fg text-3xl font-semibold tracking-[-0.02em]">{value.price}</p>
      <p className="text-fg-subtle mt-1 text-sm">{value.unit}</p>
      {/* The annual total, and where the plan has one for the *other* period, an
          invisible line of the same height in its place.

          This is what keeps the toggle from moving the page, and it replaces a
          `min-h` on the box. The cards sit in one grid row, so the row is as
          tall as the tallest card and pressing Yearly — which adds this line to
          two of the five — used to move every feature list and CTA in the row.
          A floor on the box fixed that by being as tall as the tallest yearly
          state, which meant Free carried four rems of empty space to hold a line
          it never renders.

          Reserving the line per card instead makes each card's two states the
          same height, so no card changes height, so the row cannot. Nothing is
          padded that does not need it, and the arithmetic stays correct on its
          own if a sheet gains or loses a note. `aria-hidden` because it is
          `invisible` rather than `hidden` — it occupies space, so it is still in
          the accessibility tree without it. */}
      {value.note === undefined ? (
        reserveNote ? (
          <p aria-hidden="true" className="invisible mt-1 text-xs leading-5">
            &nbsp;
          </p>
        ) : null
      ) : (
        <p className="text-fg-subtle mt-1 text-xs leading-5">{value.note}</p>
      )}
    </div>
  );
}

/**
 * One plan's price in a comparison-table column header.
 *
 * The compact sibling of `PriceBlock`: same ten-figures-one-shown mechanism
 * and the same `x-price` classes, sized for a header cell rather than a card.
 * Two components rather than a prop, because the card version carries the
 * yearly *total* on its third line and this one carries the billing *term* —
 * "billed yearly" or "month to month" — which is a different fact in the same
 * position.
 *
 * Both periods get that line even though only one of them adds information,
 * and that is the whole trick: a column header that grew a line when somebody
 * pressed Yearly would shift every row of the table down the page, so the two
 * states are kept the same height rather than one of them kept short. An
 * earlier version of this note said the header "deliberately does not" carry a
 * third line, which stopped being true when the yearly default made "$12 per
 * member, per month" a rate nobody can buy by the month.
 */
function HeaderPrice({
  value,
  className,
  term,
}: {
  value: PlanPrice;
  className: string;
  term: string;
}) {
  return (
    <span className={className}>
      <span className="text-fg block text-lg font-semibold tracking-[-0.02em]">{value.price}</span>
      <span className="text-fg-subtle block text-xs font-normal">{value.unit}</span>
      {/* The billing term, and it is rendered for *both* periods even though
          only the yearly one carries new information. The card gets a third
          line naming the annual total and this header deliberately does not —
          a column header that grew a line when somebody pressed Yearly would
          shift the whole table down the page. Giving monthly its own one-word
          term keeps the two states the same height, which is what buys the
          disclosure without the reflow.

          It matters now in a way it did not before: with yearly as the opening
          state, a reader who deep-links to `#compare` met "$12 per member, per
          month" for a rate that cannot be bought by the month. The real
          month-to-month figure is $19, and the caption that explained the
          control is `sr-only`. */}
      {term === '' ? null : (
        <span className="text-fg-subtle block text-[0.6875rem] font-normal">{term}</span>
      )}
    </span>
  );
}

/**
 * A single comparison cell.
 *
 * The check and the dash are decorative glyphs, so each carries the word a
 * screen reader needs. A table of a hundred cells that announces half of them
 * as nothing is a table nobody can use without sight.
 */
function CellValue({ value }: { value: Cell }) {
  if (value === true) {
    return (
      <>
        <CheckIcon className="text-fg inline-block size-4 align-middle" />
        <span className="sr-only">Included</span>
      </>
    );
  }

  if (value === false) {
    return (
      <>
        <MinusIcon className="text-fg-subtle inline-block size-4 align-middle" />
        <span className="sr-only">Not included</span>
      </>
    );
  }

  // Quieter than a value, louder than a dash. Compared against the constants
  // rather than the literals so this treatment cannot survive a reword of
  // either — `ADDON_NOT_YET` gets it too, because what it mostly says is that
  // nobody has this yet.
  const unbuilt = value === NOT_YET || value === ADDON_NOT_YET;
  return <span className={unbuilt ? 'text-fg-subtle' : 'text-fg-muted'}>{value}</span>;
}

/**
 * Which price sheet to show first.
 *
 * ── The cost of this function, stated ──
 * Reading a request header makes this route **dynamic**; it is no longer
 * prerendered. That is a real change to the highest-traffic marketing page in
 * the product and it should not be discovered in a commit nobody read.
 *
 * It is worth it, narrowly, because the page touches no database and no binding
 * — it is a render and nothing else, on an edge worker, so "dynamic" here costs
 * microseconds rather than a round trip. And the thing bought is the whole
 * point of having four price sheets: an Indian developer who lands on this page
 * and sees dollars concludes the product is not for them, and no selector they
 * did not notice will change their mind.
 *
 * ── Why it is only a default ──
 * Every currency is in the markup and the selector switches between them with
 * CSS. On localhost — the only place `currencyMenuShown` offers the selector
 * today — a wrong guess therefore costs one click. Everywhere the menu is
 * withheld, a wrong guess — a VPN, a traveller, a mis-geolocated range —
 * sticks for the visit: the owner's call (2026-11-04), accepted knowingly,
 * because **what somebody is actually charged is decided at checkout from
 * their billing country and the card that pays**, never from this header and
 * never from the sheet on screen. The short list of obvious countries, rather
 * than an exhaustive mapping nobody can maintain, is what the escape hatch
 * used to justify; it stays short because the price consequence is nil.
 */
async function resolveInitialCurrency(): Promise<CurrencyId> {
  try {
    const country = (await headers()).get('CF-IPCountry');
    if (!country) return DEFAULT_CURRENCY;
    return CURRENCY_BY_COUNTRY[country.toUpperCase()] ?? DEFAULT_CURRENCY;
  } catch {
    // Dollars wherever the header cannot be read, which is the right answer in
    // a test and during a build-time render, and not worth failing a page for.
    //
    // What this `catch` does **not** do is keep the route static. Next marks
    // the render dynamic inside `headers()` — `dynamicUsageDescription` is set
    // and the prerender store's `revalidate` is forced to 0 — *before* it
    // throws `DynamicServerError`, so swallowing the throw suppresses the
    // explanation and not the consequence. The route is dynamic either way;
    // see the note above for why that is accepted here.
    return DEFAULT_CURRENCY;
  }
}

/**
 * Whether this render should offer the currency menu at all.
 *
 * The owner's call (2026-11-04): the public page states one currency — the one
 * `resolveInitialCurrency` picked from the visitor's country — and does not
 * offer switching until multi-currency checkout has been rehearsed end to end.
 * The menu itself keeps working, so it stays visible in local development,
 * decided by the request's Host and not by an environment variable: "localhost
 * only" is the rule as stated, and a rule read off the request cannot drift
 * from it. Staging and every real domain — xecret.playxoft.com today, any
 * xecret.dev or xecret.app tomorrow — get no menu without a code change.
 *
 * Fails closed: where the header cannot be read (a test render, a build-time
 * pass), there is no menu, which is the right answer for every page a visitor
 * could be served.
 */
async function currencyMenuShown(): Promise<boolean> {
  try {
    const host = ((await headers()).get('host') ?? '').toLowerCase();
    // The hostname, with any port stripped — minding that an IPv6 literal
    // carries colons of its own inside its brackets.
    const name = host.startsWith('[')
      ? host.slice(0, host.indexOf(']') + 1)
      : (host.split(':')[0] ?? '');
    return (
      name === 'localhost' ||
      name.endsWith('.localhost') ||
      name === '127.0.0.1' ||
      name === '[::1]'
    );
  } catch {
    return false;
  }
}

/**
 * The currency and billing-period control, rendered wherever a price is.
 *
 * ── Why this is a component and the radios are not in it ──
 * There is **one** set of radios for the whole page, emitted once above
 * everything they govern, and this renders only the labels and the menu that
 * point at them. That is what makes the two controls — the one over the cards
 * and the one over the comparison table — the same control rather than two that
 * have to be kept in step: a `<label for>` reaches a radio anywhere in the
 * document, so pressing Yearly beside the table checks the same input the cards
 * read. Nothing synchronises them because nothing has to.
 *
 * Every selected state below is driven from `:checked` on those radios by
 * attribute selectors in globals.css, so both instances light up together for
 * the same reason.
 */
function PriceControls({ currencyMenu }: { currencyMenu: boolean }) {
  // Three columns so the period toggle is centred against the *row* rather than
  // against whatever sits beside it: an empty cell, the toggle, then the
  // currency menu pushed to the end. Centring with `justify-between` would put
  // the toggle wherever the menu's width left it, and the menu's width changes
  // with the currency name — so the toggle would drift sideways when somebody
  // switched to AUD.
  //
  // One column below `sm`, where there is no room for three and a centred stack
  // reads better than a squeezed row.
  return (
    <div className="flex flex-col items-center gap-3 sm:grid sm:grid-cols-[1fr_auto_1fr] sm:items-center sm:gap-3">
      <span className="hidden sm:block" aria-hidden="true" />

      <div className={cn(CONTROL_SHELL, 'gap-1 justify-self-center')}>
        <label htmlFor="billing-monthly" data-billing="monthly" className={SEGMENT}>
          Monthly
        </label>
        <label htmlFor="billing-yearly" data-billing="yearly" className={SEGMENT}>
          Yearly
          {/* One chip per sheet, and only the checked currency's is shown — the
              same `.x-cur-*:checked ~ .x-billing-body` mechanism the prices
              themselves use. A single literal cannot work here: the saving is
              33 per cent on the euro Pro rate and 40 on the rupee one, so one
              number would sit directly above a card contradicting it.

              Every chip is rendered and four of the five are `display: none`, never
              `visibility`, so the hidden ones leave the accessibility tree
              instead of being reachable text nobody can see.

              Note what this does *not* do: the radio carries an `aria-label`,
              which overrides label content, so none of these reaches the
              control's accessible name — see the note on that attribute for
              why the figure cannot go there either. The chip is a visual
              affordance, and the discount is stated in words in the label and
              spelled out with its arithmetic in the FAQ. */}
          {CURRENCIES.map((currency) => (
            <span
              key={currency.id}
              // A tint pill rather than bare green text: the chip rides inside
              // the Yearly label, which is `--accent`-filled while selected —
              // and Yearly opens selected. Green ON the accent fill fails
              // contrast, so the pill brings its own background (`--success-text`
              // on `--success-tint` is AA in both themes) and reads the same in
              // either state of the toggle.
              className={`x-save x-save-${currency.id} bg-success-tint text-success-text rounded-full px-1.5 py-0.5 text-xs font-normal`}
            >
              Save up to {YEARLY_SAVING[currency.id]}%
            </span>
          ))}
        </label>
      </div>

      {/* ── The currency menu ──
          A `<details>` and not a `<select>`, and the reason is the one the
          prices are built on: CSS picks one of eight figures per card from
          `:checked`, and no selector reads the value of a `<select>`. A real
          dropdown would mean the prices becoming client state, which means the
          card paints $12, the bundle lands, and the number changes under the
          reader. On the page somebody is deciding money on, that is the one
          thing this design does not do.

          So the radios stay: they remain the control a screen reader and a
          keyboard operate, and this is the pointer affordance over them.
          `CurrencyMenu` adds dismissal — outside press, Escape, selection — and
          touches nothing else; without its script the menu still works and every
          price still switches.

          Rendered only where `currencyMenuShown` said so — localhost, today.
          Leaving the menu out removes the *affordance*, not the mechanism: the
          radios above the page still exist with the server's pick checked, so
          every price, chip and structured-data sheet keeps meaning the same
          currency. The grid keeps its three columns either way, so the period
          toggle does not drift when the menu is absent. */}
      {currencyMenu && (
        <CurrencyMenu className="x-currency relative sm:justify-self-end">
          <summary
            className={cn(
              CONTROL_SHELL,
              'x-currency-summary min-w-28 list-none justify-between gap-2 px-4',
            )}
          >
            {/* Five names, one shown — the same mechanism as the prices, so the
              trigger cannot disagree with the figures below it. */}
            <span className="text-fg text-sm font-medium">
              {CURRENCIES.map((currency) => (
                <span
                  key={currency.id}
                  data-currency-name={currency.id}
                  className="x-currency-name"
                >
                  {currency.label}
                </span>
              ))}
            </span>
            <ChevronDownIcon className="x-currency-chevron text-fg-muted size-4 shrink-0" />
          </summary>

          <div
            className={cn(
              'x-currency-panel border-line bg-surface shadow-raised absolute top-full',
              'right-0 z-20 mt-2 w-36 rounded-xl border p-1',
            )}
          >
            {CURRENCIES.map((currency) => (
              <label
                key={currency.id}
                htmlFor={`currency-${currency.id}`}
                data-currency-option={currency.id}
                className={cn(
                  'text-fg-muted hover:text-fg hover:bg-canvas-inset flex cursor-pointer',
                  'items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm',
                  'font-medium transition-colors',
                )}
              >
                <span>
                  {currency.symbol} {currency.label}
                </span>
                {/* Hidden until this option is the checked one. The tick is what
                  says "current" to a reader who cannot tell two shades of
                  foreground apart. */}
                <CheckIcon className="x-currency-tick size-4 shrink-0" />
              </label>
            ))}
          </div>
        </CurrencyMenu>
      )}
    </div>
  );
}

export default async function PricingPage() {
  const initialCurrency = await resolveInitialCurrency();
  const paymentsLive = await takesPayments();
  const currencyMenu = await currencyMenuShown();
  const faq = faqFor(paymentsLive);

  return (
    <PublicPage current="pricing">
      {/* The same currency the cards open on. Structured data that disagreed
          with the rendered price was wrong on four sheets out of five while
          this was a constant. */}
      <JsonLd
        data={graph(
          productSchema(initialCurrency),
          faqSchema(faq),
          breadcrumbSchema([{ name: 'Pricing', path: '/pricing' }]),
        )}
      />

      {/* The sentence below names both rates and says which is which, because
          it sits a screen above the cards and used to disagree with them. It
          read "$12 per member per month" while the cards opened on monthly and
          painted $19 — exactly the mismatch the note at the top of this file
          exists to prevent. The cards now open on yearly, so $12 leads and $19
          is named as the month-to-month rate; the order follows the default
          and moves with it.

          Single sign-on stays out of it for the other reason: it is `notYet`
          on the Team card and the not-built chip in the matrix, so the hero was
          the one place on the page promising it outright. */}
      {/* `compact`, not the default `tall`. The default holds a 58svh floor and
          centres within it, so on this page the sentence describing the plans
          finished a third of the way down the screen and the plans themselves
          started below the fold — a pricing page whose first screen is mostly
          the absence of prices. Nothing here needs the room: the hero is three
          short lines and the thing a reader came for is directly under it. */}
      <PageHero
        height="compact"
        eyebrow="Pricing"
        title="Secret management pricing, without the sales call."
        description={HERO_DESCRIPTION}
      />

      {/* ── One control, two places it appears ──
          The radios are emitted **here**, above both sections, and everything
          they govern sits in the single `.x-billing-body` wrapper beside them.
          That is not tidiness: the CSS that swaps the prices reaches from
          `:checked` with `~`, which only travels forward and only between
          siblings. While the inputs lived inside the plans section the
          comparison table was out of reach of them, which is why its header used
          to hard-code the monthly USD figure and say so in the caption.

          Currency first, billing period second, and that order is load-bearing
          too: the rule that picks one of eight figures ANDs the two groups with
          `.x-cur-inr:checked ~ .x-billing-yearly:checked ~ …`. Swap these two
          blocks and every price on the page disappears.

          `min-w-0` because a fieldset's default `min-inline-size: min-content`
          would let the widest cell in the table push the whole page sideways. */}
      <fieldset className="min-w-0">
        <legend className="sr-only">Currency and billing period</legend>

        {CURRENCIES.map((currency) => (
          <input
            key={currency.id}
            id={`currency-${currency.id}`}
            type="radio"
            name="currency"
            value={currency.id}
            defaultChecked={currency.id === initialCurrency}
            // Disabled wherever the menu is not offered. The radios must still
            // EXIST there — `:checked` on a disabled input keeps matching, and
            // every price on the page is revealed from it — but an enabled,
            // sr-only radio with no visible control is a trap: focus vanishes
            // into a clipped 1px box (the focus ring is drawn on menu elements
            // that no longer render), and an arrow key silently switches every
            // figure with nothing on screen to switch them back. Disabled, they
            // leave the tab order and ignore keys, which is "no switching"
            // meant literally.
            disabled={!currencyMenu}
            // Named explicitly, because two controls render a `<label for>` at
            // this input and engines concatenate every associated label into the
            // accessible name — so it announced as "$ USD $ USD". An `aria-label`
            // replaces the lot with one.
            aria-label={currency.label}
            className={`x-cur-${currency.id} x-price-input`}
          />
        ))}

        {/* Yearly opens checked, and the ordering below still has to put
            monthly first: the reveal rules read
            `.x-cur-*:checked ~ .x-billing-*:checked ~ .x-billing-body`, and `~`
            only reaches forward, so both inputs must precede the body. Which of
            them carries `defaultChecked` is free; where they sit is not.

            Yearly is the rate the page is written around — the title, the
            description and the FAQ all quote it — so opening on monthly meant
            the loudest number on the card disagreed with the sentence above it
            until somebody clicked. */}
        <input
          id="billing-monthly"
          type="radio"
          name="billing"
          value="monthly"
          aria-label="Billed monthly"
          className="x-billing-monthly x-price-input"
        />
        <input
          id="billing-yearly"
          type="radio"
          name="billing"
          value="yearly"
          defaultChecked
          // Names the discount, without naming the figure. The saving chips sit
          // inside the label, but `aria-label` overrides label content for the
          // accessible name, so a screen-reader user heard "Billed yearly" and
          // never learned a discount existed while the visible control said
          // "Save up to 37%".
          //
          // The figure itself cannot come in here. `PriceControls` renders
          // twice — above the plans and above the matrix — so two labels point
          // at this one input and dropping `aria-label` would concatenate both
          // into the name. And the number changes with the currency, which is a
          // CSS state this server-rendered string cannot follow, so a literal
          // would be wrong for four sheets out of five the moment somebody
          // switched. "At a lower rate" is true on every sheet.
          aria-label="Billed yearly, at a lower rate per member"
          className="x-billing-yearly x-price-input"
        />

        <div className="x-billing-body">
          {/* `size="md"` rather than the default: this section sits directly
              under the hero, which already ends in its own generous run of
              whitespace, and two full rhythms stacked put a screen's worth of
              nothing between the sentence that describes the plans and the plans
              themselves. The documented use of the smaller size is exactly this
              — a band that follows another. */}
          <Section id="plans" aria-labelledby="plans-heading" tone="canvas" size="md">
            {/* The prices come first, with no heading introducing them: a reader
                who opened /pricing does not need to be told that the cards under
                the word "Pricing" are the plans. The h2 stays as a hidden one
                because the cards are h3s — a page whose headings jump from h1 to
                h3 has a hole in the outline a screen-reader user navigates by —
                and because `<section aria-labelledby>` needs something to name
                it. */}
            <h2 id="plans-heading" className="sr-only">
              Plans and prices
            </h2>

            <PriceControls currencyMenu={currencyMenu} />

            {/* ── Four cards, and why the row no longer overhangs ──
                At five columns inside an 80rem container each card had about
                180px of content, narrower than "₹1,490" wants to be and narrower
                than any feature bullet reads well at, so the row was let out
                past the container to compensate. Removing Scale removed the
                reason: four columns give each card roughly 290px inside the
                normal width, which is enough, and a row that breaks the page's
                left edge to solve a problem it no longer has is just a row that
                does not line up with anything above or below it.

                Two across from `sm` rather than three at `lg`: four cards make
                two even rows, where three columns leave one card alone on a
                second row looking like an afterthought. */}
            <RevealGroup
              className={cn('mt-6 grid gap-4 sm:grid-cols-2 sm:gap-5 xl:grid-cols-4 xl:gap-5')}
            >
              {PRICED_PLANS.map((plan) => (
                <article
                  key={plan.id}
                  id={plan.id}
                  className={cn(
                    // Equal height with the button on the baseline: `mt-auto` on
                    // the action pushes it down whatever the feature list does
                    // above it, so four cards of different lengths still end on
                    // one line.
                    'bg-surface flex h-full scroll-mt-24 flex-col rounded-xl border transition-colors',
                    'p-6',
                    plan.recommended
                      ? 'border-accent shadow-raised'
                      : 'border-line hover:border-line-strong',
                  )}
                >
                  {/* Wraps rather than shrinking: at five across the badge and a
                      two-word plan name do not fit on one line, and a squeezed
                      `Recommended` chip looks like a rendering fault. */}
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <h3 className="text-fg text-base font-semibold">{plan.name}</h3>
                    {/* Accent, not production. The production ramp marks exactly
                        one thing in this product and a recommended plan is not
                        it. */}
                    {plan.recommended ? (
                      <Badge tone="accent" className="text-xs">
                        Recommended
                      </Badge>
                    ) : null}
                  </div>

                  {/* ── The price, directly under the name ──
                      It used to sit below the audience line, which runs to one,
                      two or three lines depending on the plan — so the figure a
                      reader scans across five cards landed at a different height
                      on each of them, and comparing two of them meant moving the
                      eye diagonally. A plan name is always one line, so putting
                      the price against it puts every figure on one baseline. The
                      audience line follows, where a varying height costs nothing.

                      No `min-h` here any more. This box used to carry one,
                      because the yearly figures have a third line the monthly
                      ones do not and the cards share a grid row — so pressing
                      Yearly made the row taller and moved every feature list and
                      CTA in it. A floor equal to the tallest yearly state fixed
                      the movement and cost Free about four rems of empty space
                      held open for a line it never renders, which is a poor
                      trade on the one card whose whole message is that it is
                      simple.

                      `PriceBlock` reserves the line per card instead — see the
                      note there. Each card's two states are the same height, so
                      no card changes height, so the row cannot, and nothing is
                      padded that does not need padding. */}
                  <div className="mt-4">
                    {/* Ten figures, one shown. Every currency and both
                        periods are in the markup, and CSS picks the pair the
                        two radio groups name — so switching either needs no
                        request and no JavaScript. `display: none` on the seven
                        that are hidden, never `visibility`, or every card
                        announces ten prices in a row to a screen reader. */}
                    {CURRENCIES.map((currency) => (
                      <Fragment key={currency.id}>
                        <PriceBlock
                          className={`x-price x-price-${currency.id}-monthly`}
                          value={plan.prices[currency.id].monthly}
                          reserveNote={plan.prices[currency.id].yearly.note !== undefined}
                        />
                        <PriceBlock
                          className={`x-price x-price-${currency.id}-yearly`}
                          value={plan.prices[currency.id].yearly}
                          reserveNote={false}
                        />
                      </Fragment>
                    ))}

                    {/* A condition on the figure, so it sits with the figure —
                        no tick, because it is a floor on the bill rather than
                        something the plan includes. */}
                    {plan.priceCaveat === undefined ? null : (
                      <p className="text-fg-subtle mt-2 text-xs leading-5">{plan.priceCaveat}</p>
                    )}
                  </div>

                  {/* Ruled off from the price above it. With the figure moved up,
                      the card has two plain halves — what it costs, and who it is
                      for — and a hairline says so more cheaply than the
                      whitespace that would otherwise be needed. */}
                  <p className="text-fg-muted border-line-subtle border-t pt-4 text-sm leading-6">
                    {plan.audience}
                  </p>

                  <ul className="mt-5 space-y-2.5">
                    {plan.features.map((feature) => (
                      <PlanFeatureItem key={feature.text} feature={feature} />
                    ))}
                  </ul>

                  <div className="mt-auto pt-6">
                    <Button
                      asChild
                      variant={plan.recommended ? 'primary' : 'secondary'}
                      className="w-full"
                    >
                      {plan.cta.external ? (
                        <a href={plan.cta.href} target="_blank" rel="noreferrer noopener">
                          {plan.cta.label}
                          <ExternalLinkIcon className="size-4" />
                        </a>
                      ) : (
                        <Link href={plan.cta.href}>
                          {plan.cta.label}
                          <ArrowRightIcon className="size-4" />
                        </Link>
                      )}
                    </Button>
                  </div>
                </article>
              ))}
            </RevealGroup>

            {/* Under the cards rather than over them. It explains the figures a
                reader has just seen, and above them it was a caveat about prices
                nobody had read yet. */}
            <p className="text-fg-subtle mx-auto mt-6 max-w-2xl text-center text-sm leading-6">
              Prices in rupees, yen and Australian dollars are set for those markets rather than
              converted, and follow your billing country.
            </p>

            {/* ── Add-ons ──
            Between the cards and the self-hosting band, because they attach to
            a plan rather than replacing one.

            **Inside** `.x-billing-body`, and it has to be: the rule that reveals
            one add-on price per currency is
            `.x-cur-*:checked ~ .x-billing-body .x-addon-*`, so moving this band
            out blanks all five figures. This comment used to say the opposite.
            What is true is that add-ons have no *yearly* rate, which is why the
            rule keys on currency alone and not on the period.

            The full width of the section, laid out as the self-hosting band
            below it — the name and price in a fixed column, the explanation
            beside them. `sm:max-w-xl` used to cap the lone card instead, which
            left the right half of the section empty and the band looking like
            something had failed to load next to it (the owner's words,
            2026-11-04: use the width or balance it). One card in a row reads as
            a row; the half-width grid it replaced was only ever right while
            SCIM made it two.

            The body text states what it costs us. That is deliberate — see the
            note on ADDONS — and it is the part of this page most likely to be
            trimmed by somebody tidying marketing copy. It should not be. */}
            <div className="border-line bg-surface mt-6 grid gap-6 rounded-xl border p-6 sm:p-7">
              {ADDONS.map((addon) => (
                <div
                  key={addon.name}
                  className="flex flex-col gap-6 lg:flex-row lg:items-center lg:gap-8"
                >
                  <div className="lg:w-64 lg:shrink-0">
                    {/* The chip carries the same word the matrix cells and the card
                    bullets carry, for the same reason: this band publishes a
                    price, and a price with no qualifier beside it is an offer. */}
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-fg text-base font-semibold">{addon.name}</h3>
                      {addon.notYet ? (
                        <span className="border-line text-fg-subtle rounded-full border px-1.5 py-0.5 text-[0.6875rem] font-medium whitespace-nowrap">
                          {NOT_YET}
                        </span>
                      ) : null}
                    </div>
                    {/* Five figures, one shown — the same radios the cards and the
                        comparison table read, through a rule that keys on currency
                        alone. An add-on has no yearly rate, so unlike every other
                        price on the page this one must not follow the period half
                        of the control: pairing it with `x-price-*-yearly` would
                        have shown nothing at all whenever Yearly was selected. */}
                    <p className="text-fg mt-2 text-2xl font-semibold tracking-[-0.02em]">
                      {CURRENCIES.map((currency) => (
                        <span key={currency.id} className={`x-addon-price x-addon-${currency.id}`}>
                          {addon.prices[currency.id]}
                        </span>
                      ))}{' '}
                      <span className="text-fg-subtle text-sm font-normal">{addon.unit}</span>
                    </p>
                    <p className="text-fg-subtle mt-1 text-sm">{addon.from}</p>
                  </div>
                  {/* Capped: at the row's full width this paragraph ran about
                      120 characters a line, half again past comfortable. */}
                  <p className="text-fg-muted max-w-3xl text-sm leading-6 lg:flex-1">
                    {addon.body}
                  </p>
                </div>
              ))}
            </div>

            {/* Said out loud because the band now shows ₹16,900 beside a
                paragraph that explains a cost in dollars, and a reader comparing
                it against the plan cards would otherwise reasonably expect the
                same regional discount and not find it. */}
            <p className="text-fg-subtle mx-auto mt-4 max-w-3xl text-center text-sm leading-6">
              Add-on prices are the same figure converted, not set per market like the plans above:
              each one is a connection billed to us in dollars at the same rate wherever you are.
            </p>

            {/* ── Self-hosting ──
            Deliberately not a sixth card, and deliberately outside the fieldset
            above: it has no billing period to switch and it is not a rung on
            the ladder. A row instead — price, then what you get, then the way
            in — so the eye reads it as a different kind of offer rather than as
            the cheapest column of the same one. */}
            <div
              id={SELF_HOSTED.id}
              className="border-line bg-surface hover:border-line-strong mt-6 scroll-mt-24 rounded-xl border p-6 transition-colors sm:p-7"
            >
              <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:gap-8">
                <div className="lg:w-64 lg:shrink-0">
                  <h3 className="text-fg text-base font-semibold">{SELF_HOSTED.name}</h3>
                  <p className="text-fg mt-2 text-3xl font-semibold tracking-[-0.02em]">
                    {/* All five sheets, not `usd`. Every one of them currently
                        reads "Free", which is the only reason hard-coding one
                        was invisible — and is exactly why it would have stayed
                        invisible until somebody localised the word. */}
                    {CURRENCIES.map((currency) => (
                      <span key={currency.id} className={`x-addon-price x-addon-${currency.id}`}>
                        {SELF_HOSTED.prices[currency.id].monthly.price}
                      </span>
                    ))}
                  </p>
                  <p className="text-fg-subtle mt-1 text-sm">
                    {CURRENCIES.map((currency) => (
                      <span key={currency.id} className={`x-addon-price x-addon-${currency.id}`}>
                        {SELF_HOSTED.prices[currency.id].monthly.unit}
                      </span>
                    ))}
                  </p>
                  <p className="text-fg-muted mt-3 text-sm leading-6">{SELF_HOSTED.audience}</p>
                </div>

                <ul className="border-line-subtle grid flex-1 gap-x-6 gap-y-2 border-t pt-6 sm:grid-cols-2 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-8">
                  {SELF_HOSTED.features.map((feature) => (
                    <PlanFeatureItem key={feature.text} feature={feature} />
                  ))}
                </ul>

                <div className="lg:shrink-0">
                  <Button asChild variant="secondary" className="w-full lg:w-auto">
                    <Link href={SELF_HOSTED.cta.href}>
                      {SELF_HOSTED.cta.label}
                      <ArrowRightIcon className="size-4" />
                    </Link>
                  </Button>
                </div>
              </div>
            </div>
          </Section>

          <Section id="compare" aria-labelledby="compare-heading" tone="inset">
            <SectionHeading
              headingId="compare-heading"
              align="center"
              eyebrow="Comparison"
              title="Every plan compared, including the limits"
              description="The whole matrix rather than the flattering half of it. Where a plan does not have something the row says so, and where nobody has it yet the row says that too."
            />

            {/* The same control as the one over the cards — the same radios,
                reached by a second set of labels. Here because the table states
                prices too, and a reader who switched to rupees at the top should
                not meet dollars again two screens down. Nothing keeps the two in
                step; there is only one thing to keep. */}
            <div className="mt-8">
              <PriceControls currencyMenu={currencyMenu} />
            </div>

            {/* The table is wider than a phone and always will be, so it scrolls
            inside its own box rather than making the document scroll sideways.
            `tabindex` is what makes that box reachable without a pointer — a
            scroll container that only a mouse can move is a table a keyboard
            user can read one third of. The same arrangement as `.doc-table-wrap`
            in docs.css; the global `:focus-visible` rule rings it. */}
            <RowHintProvider>
              <div
                tabIndex={0}
                role="region"
                aria-label="Plan comparison"
                className="border-line bg-surface mt-10 overflow-x-auto rounded-xl border"
              >
                {/* `text-[0.9375rem]` rather than `text-sm`: this table is the
                  densest thing on the page and the one a buyer reads most
                  carefully, and 14px across twenty-six rows of capability names
                  is smaller than the body text everywhere else on the site. */}
                <table className="w-full min-w-[64rem] border-collapse text-[0.9375rem]">
                  <caption className="sr-only">
                    Every xecret plan compared, capability by capability, in five groups. The header
                    shows the price for the currency and billing period selected above the table,
                    which is the same pair the plan cards use.{' '}
                    {paymentsLive
                      ? 'Paid plans are bought from an organisation’s billing page.'
                      : 'During pre-alpha nothing is billed, and each plan’s limits and features apply as the table shows them.'}
                  </caption>
                  <thead className="bg-canvas-inset">
                    <tr className="border-line border-b">
                      <th scope="col" className="w-[17rem] px-4 py-3 text-left">
                        <span className="sr-only">Capability</span>
                      </th>
                      {PLANS.map((plan) => (
                        <th
                          key={plan.id}
                          scope="col"
                          className="px-4 py-4 text-center align-bottom"
                        >
                          <span className="text-fg block text-base font-semibold">{plan.name}</span>
                          {/* Ten figures, one shown — the same markup the cards
                            carry, now that the radios sit above both sections and
                            the sibling chain reaches in here. This used to be a
                            hard-coded monthly USD price with a caption
                            apologising for it, which meant a reader who chose
                            yearly rupees at the top met monthly dollars again
                            here: one page quoting two prices for the same plan. */}
                          {CURRENCIES.map((currency) => (
                            <Fragment key={currency.id}>
                              <HeaderPrice
                                className={`x-price x-price-${currency.id}-monthly`}
                                value={plan.prices[currency.id].monthly}
                                term={
                                  plan.prices[currency.id].yearly.note === undefined
                                    ? ''
                                    : 'month to month'
                                }
                              />
                              <HeaderPrice
                                className={`x-price x-price-${currency.id}-yearly`}
                                value={plan.prices[currency.id].yearly}
                                term={
                                  plan.prices[currency.id].yearly.note === undefined
                                    ? ''
                                    : 'billed yearly'
                                }
                              />
                            </Fragment>
                          ))}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  {PLAN_COMPARISON.map((group) => (
                    <tbody key={group.title}>
                      <tr className="border-line-subtle bg-canvas-inset/60 border-y">
                        {/* `colgroup`, not `col`: this heading names the rows beneath
                      it across every plan column, and it is what a screen reader
                      reads out before each row of the group. */}
                        <th
                          scope="colgroup"
                          colSpan={PLANS.length + 1}
                          className="text-fg px-4 py-3.5 text-left text-[0.9375rem] font-semibold tracking-[0.08em] uppercase"
                        >
                          {group.title}
                        </th>
                      </tr>
                      {group.rows.map((row) => (
                        <tr
                          key={row.label}
                          className="border-line-subtle hover:bg-surface-hover border-b transition-colors last:border-b-0"
                        >
                          <th scope="row" className="text-fg px-4 py-3.5 text-left font-medium">
                            <span className="inline-flex items-center gap-1.5">
                              {row.label}
                              <RowHint label={row.label} hint={row.hint} />
                            </span>
                          </th>
                          {PLANS.map((plan) => (
                            <td key={plan.id} className="px-4 py-3.5 text-center whitespace-nowrap">
                              <CellValue value={row.values[plan.id]} />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  ))}
                </table>
              </div>
            </RowHintProvider>

            <p className="text-fg-muted mx-auto mt-6 max-w-3xl text-center text-sm leading-7">
              SAML and SCIM are named on the plans that will carry them, and every column that names
              them says <span className="text-fg font-medium">coming soon</span>. Only one of them
              is ever charged separately: SAML is bought per connection from Team, so Team reads{' '}
              <span className="text-fg font-medium">{ADDON_NOT_YET}</span>, and it is included with
              Enterprise, which reads <span className="text-fg font-medium">{NOT_YET}</span>. SCIM
              is Enterprise only and included there rather than charged, so it reads{' '}
              <span className="text-fg font-medium">{NOT_YET}</span> in that column and a dash
              everywhere below it. Self-hosting reads{' '}
              <span className="text-fg font-medium">{NOT_YET}</span> for both, because nothing is
              held back there and nothing is charged for either — they simply do not exist yet.
              Neither is built for anybody, at any price. The chips on the cards and the rows in
              this table say so deliberately: the first contract that needs them is what gets them
              written, and until then you should plan as though they do not exist. Enterprise is a
              conversation rather than a checkout, which is why the card has no price and there is
              no form to fill in.
            </p>

            <div className="mt-5 flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm">
              <Link href="/features" className={QUIET_LINK}>
                Every feature in detail
                <ArrowRightIcon className="size-3.5" />
              </Link>
              <Link href="/docs/self-hosting" className={QUIET_LINK}>
                The self-hosting guide
                <ArrowRightIcon className="size-3.5" />
              </Link>
            </div>
          </Section>
        </div>
      </fieldset>

      <Section id="included" aria-labelledby="included-heading" tone="canvas">
        <SectionHeading
          headingId="included-heading"
          align="center"
          eyebrow="Every plan"
          title="What every plan includes"
          description="The parts a secrets product should never tier are not tiered here. These four are identical whether you pay nothing, pay for Team or sign a contract."
        />

        <RevealGroup className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {INCLUDED.map((item) => {
            const Icon = item.icon;
            return (
              <div
                key={item.title}
                className="border-line bg-surface hover:border-line-strong flex h-full flex-col rounded-xl border p-5 transition-colors"
              >
                <Icon className="text-fg-subtle size-5" />
                <h3 className="text-fg mt-3 text-sm font-semibold">{item.title}</h3>
                <p className="text-fg-muted mt-1.5 text-sm leading-6">{item.body}</p>
                {/* `mt-auto` rather than a fixed margin: the four bodies are
                    different lengths and the four links still land on one line. */}
                <Link href={item.link.href} className={cn(QUIET_LINK, 'mt-auto pt-3 text-sm')}>
                  {item.link.label}
                  <ArrowRightIcon className="size-3.5" />
                </Link>
              </div>
            );
          })}
        </RevealGroup>
      </Section>

      <Section id="faq" aria-labelledby="faq-heading" tone="inset">
        <SectionHeading
          headingId="faq-heading"
          align="center"
          eyebrow="Questions"
          title="Questions about the money"
          // Counted, not stated. The prose said "nine" against a list of
          // thirteen, which is the kind of number that is wrong the first time
          // somebody adds a question and right again only by accident.
          description={`The ${PRICING_FAQ.length} that decide whether a price is workable, answered including the several where the honest answer is that it is not built yet.`}
        />

        <Faq items={faq} className="mx-auto mt-10 max-w-3xl" />

        <p className="text-fg-muted mx-auto mt-6 max-w-3xl text-center text-sm leading-7">
          These are the billing questions.{' '}
          <Link href="/faq" className={QUIET_LINK}>
            The general FAQ
          </Link>{' '}
          covers how xecret works, and{' '}
          <Link href="/docs/security/trust-model" className={QUIET_LINK}>
            the trust model
          </Link>{' '}
          covers what we can and cannot see, which is the question worth asking before the price is.
        </p>
      </Section>

      <CtaBand
        title="Start on the free tier. Move when it stops fitting."
        // "Every CI token you need" sat beside `serviceTokens = 10`, which the
        // card and the matrix both publish as a hard ceiling — the sentence
        // derived its projects and environments from `LIMITS` and then stated
        // the one capped resource it did not derive as uncapped. The number is
        // read like the other two now, and the "never billed" claim is kept
        // separate from the "never capped" one, because only the first is true
        // on Free.
        description={`${LIMITS.free.projects} projects, ${LIMITS.free.environmentsPerProject} environments each, ${LIMITS.free.serviceTokens} CI tokens and the whole CLI, without a card — and a service token is never billed on any plan, whatever it pulls. If you outgrow it, the price is on this page and it will not change under you.`}
      />
    </PublicPage>
  );
}

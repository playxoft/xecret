import type { Metadata } from 'next';
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
import { Button } from '@/components/ui/button';
import {
  ArrowRightIcon,
  CheckIcon,
  ExternalLinkIcon,
  FileTextIcon,
  HistoryIcon,
  LockIcon,
  MinusIcon,
  TerminalIcon,
} from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { absoluteUrl, breadcrumbSchema, REPO_URL, SITE_KEYWORDS, SITE_NAME } from '@/lib/site';

/**
 * The pricing page.
 *
 * ── One place a price is written ──
 * Three things on this page state money: the plan cards, the header of the
 * comparison table, and the `Offer` nodes in the structured data. A rich result
 * advertising $9 above a page that renders $12 is a manual action from Google
 * waiting to happen, so the plan constants are the single source: the cards
 * read the four priced ones, the table header reads all five, and the JSON-LD
 * is derived from them rather than hand-written beside them. `PRICED_PLANS` is
 * a separate list only because self-hosting is not a rung on the ladder and
 * renders as a band; both flow into `PLANS`, and nothing is written twice.
 * The `amount` field exists so the published number is
 * never parsed back out of the display string — `'$9'` is typography and `'9'`
 * is data, and the day one of them gains a currency symbol or a suffix is the
 * day a regex would silently publish the wrong price.
 *
 * The same rule governs the limits, not only the price. Every `Offer`
 * description is composed from the audience line and the feature bullets the
 * card actually renders, so the free tier published to Google cannot advertise
 * a limit the page does not show.
 *
 * ── Why the billing toggle ships no JavaScript ──
 * Monthly and yearly figures are both in the markup, and CSS shows whichever
 * the checked radio names — see `.x-price-monthly` in globals.css. The obvious
 * alternative, `useState` and a client component around the plans block, would
 * turn the one part of this page a reader is deciding on into something that
 * arrives after hydration: on a slow connection the card paints $9, the bundle
 * lands, and the number changes under them. A price that moves on its own is
 * the last thing this page can afford. It also costs a `'use client'` boundary
 * on an otherwise fully static document.
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
 * Nothing on this page is billed yet, and the sentence that says so sits under
 * the billing toggle, above the first price rather than in a footnote below the
 * last one.
 */

const TITLE = 'Pricing: free forever, or $9 per member';
const DESCRIPTION =
  'Four xecret plans: free for 1 organisation and 3 members, Team at $9 a member a month, Business at $19, self-hosted free forever, and no card in pre-alpha.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
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
    title: `${TITLE} · ${SITE_NAME}`,
    description: DESCRIPTION,
  },
};

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
  'text-fg-muted hover:text-fg flex cursor-pointer items-center gap-2 rounded-full px-4 py-1.5 ' +
  'text-sm font-medium transition-colors';

/**
 * The one string that means "named on the plan, and not built".
 *
 * Shared between the chips on the cards and the cells in the matrix. The
 * failure mode this guards against is not a typo — it is the page showing a
 * tick beside SAML in one place and an absence in the other.
 */
const NOT_YET = 'Not yet';

/* ── The plans ─────────────────────────────────────────────────────────────── */

type PlanId = 'free' | 'team' | 'business' | 'enterprise' | 'self-hosted';

/** One billing period's figures, for one plan. */
interface PlanPrice {
  /** The large figure on the card. Typography, never parsed. */
  readonly price: string;
  /** The line under the figure. Reads as a continuation of it. */
  readonly unit: string;
  /** A third line, where the billing term needs spelling out in full. */
  readonly note?: string | undefined;
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

interface Plan {
  readonly id: PlanId;
  readonly name: string;
  readonly monthly: PlanPrice;
  readonly yearly: PlanPrice;
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
   * Published as `Offer.price`, and always the **monthly** figure — that is
   * what the page shows before anybody touches the toggle, and an offer that
   * publishes a number the default render does not show is the same defect as
   * publishing the wrong one. `null` where there is genuinely no price.
   */
  readonly amount: string | null;
  /** Published as `unitText`, where the price is per something. */
  readonly unitText: string | null;
}

/**
 * The four plans with a price. These are the cards.
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
    monthly: { price: '$0', unit: 'forever, no card' },
    yearly: { price: '$0', unit: 'forever, no card' },
    audience: 'For a solo project, or three people who have outgrown a shared .env file.',
    features: [
      { text: '1 organisation' },
      { text: '5 projects' },
      { text: '3 members' },
      { text: '3 environments per project' },
      { text: '7 days of audit history' },
      { text: 'CLI and CI service tokens' },
      { text: 'Community support on GitHub' },
    ],
    cta: { label: 'Start free', href: '/sign-up', external: false },
    recommended: false,
    amount: '0',
    unitText: null,
  },
  {
    id: 'team',
    name: 'Team',
    monthly: { price: '$9', unit: 'per member, per month' },
    yearly: {
      price: '$7',
      unit: 'per member, per month',
      note: '$84 per member, billed yearly',
    },
    audience: 'For a team that needs roles, per-environment access and a year of audit history.',
    features: [
      { text: 'Unlimited organisations, projects and members' },
      { text: 'Unlimited environments per project' },
      { text: '12 months of audit history' },
      { text: 'Roles and per-environment access' },
      { text: 'Service tokens for CI' },
      { text: 'Email support' },
    ],
    cta: { label: 'Start on Team', href: '/sign-up', external: false },
    recommended: true,
    amount: '9',
    unitText: 'member/month',
  },
  {
    id: 'business',
    name: 'Business',
    monthly: { price: '$19', unit: 'per member, per month' },
    yearly: {
      price: '$15',
      unit: 'per member, per month',
      note: '$180 per member, billed yearly',
    },
    audience:
      'For a company whose security review wants single sign-on, three years of audit history and an invoice.',
    features: [
      { text: 'Everything in Team' },
      { text: '3 years of audit history' },
      { text: 'SAML single sign-on', notYet: true },
      { text: 'Priority support, one business day' },
      { text: 'Invoiced billing' },
    ],
    cta: { label: 'Start on Business', href: '/sign-up', external: false },
    recommended: false,
    amount: '19',
    unitText: 'member/month',
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    monthly: { price: 'Custom', unit: 'invoiced, with an SLA' },
    yearly: { price: 'Custom', unit: 'invoiced, with an SLA' },
    audience:
      'For an organisation that needs directory provisioning, its own retention period and a contract behind both.',
    features: [
      { text: 'Everything in Business' },
      { text: 'SCIM provisioning', notYet: true },
      { text: 'Custom audit retention' },
      { text: 'A self-hosting support contract' },
      { text: 'A contractual SLA' },
      { text: 'A named contact' },
    ],
    // There is no sales form, no calendar link and no inbox pretending to be a
    // sales team. The issue tracker is where this conversation actually
    // happens, so that is where the button goes and what the label says.
    cta: { label: 'Open an issue to talk', href: `${REPO_URL}/issues`, external: true },
    recommended: false,
    amount: null,
    unitText: null,
  },
];

/**
 * Self-hosting, which is not a rung on the ladder.
 *
 * It renders as a band under the cards rather than as a fifth card, because a
 * fifth card would invite the comparison the other four are asking for — more
 * money, more features — and self-hosting is the opposite arrangement: no
 * money, every feature, all of the operational work. It keeps its column in the
 * matrix and its `Offer` in the structured data, which is why it is a `Plan`.
 */
const SELF_HOSTED: Plan = {
  id: 'self-hosted',
  name: 'Self-hosted',
  monthly: { price: 'Free', unit: 'always' },
  yearly: { price: 'Free', unit: 'always' },
  audience: 'For anyone who would rather hold their own root key and run their own server.',
  features: [
    { text: 'The whole server, under AGPL-3.0' },
    { text: 'No feature held back, no licence key' },
    { text: 'Unlimited organisations, projects, members and environments' },
    { text: 'Audit history for as long as your database keeps it' },
    { text: 'Cloudflare Workers, PostgreSQL, your own Firebase project' },
    { text: 'Community support, or an Enterprise contract' },
  ],
  cta: { label: 'Read the self-hosting guide', href: '/docs/self-hosting', external: false },
  recommended: false,
  amount: '0',
  unitText: null,
};

/** Every plan, in column order. The matrix header and the JSON-LD read this. */
const PLANS: readonly Plan[] = [...PRICED_PLANS, SELF_HOSTED];

/* ── The comparison matrix ─────────────────────────────────────────────────── */

/** `true` renders a check, `false` a dash, a string renders itself. */
type Cell = boolean | string;

interface MatrixRow {
  readonly label: string;
  /**
   * Keyed by plan rather than positional. A tuple would be shorter and would
   * let a row silently shift by one column the first time a plan is inserted;
   * this cannot, because the compiler requires every key on every row.
   */
  readonly values: Readonly<Record<PlanId, Cell>>;
}

interface MatrixGroup {
  /** Rendered as a spanning row, and as the group's accessible name. */
  readonly title: string;
  readonly rows: readonly MatrixRow[];
}

const MATRIX = [
  {
    title: 'Limits',
    rows: [
      {
        label: 'Organisations',
        values: {
          free: '1',
          team: 'Unlimited',
          business: 'Unlimited',
          enterprise: 'Unlimited',
          'self-hosted': 'Unlimited',
        },
      },
      {
        label: 'Projects',
        values: {
          free: '5',
          team: 'Unlimited',
          business: 'Unlimited',
          enterprise: 'Unlimited',
          'self-hosted': 'Unlimited',
        },
      },
      {
        label: 'Members',
        values: {
          free: 'Up to 3',
          team: 'Unlimited',
          business: 'Unlimited',
          enterprise: 'Unlimited',
          'self-hosted': 'Unlimited',
        },
      },
      {
        label: 'Environments per project',
        values: {
          free: '3',
          team: 'Unlimited',
          business: 'Unlimited',
          enterprise: 'Unlimited',
          'self-hosted': 'Unlimited',
        },
      },
      {
        label: 'Audit history',
        values: {
          free: '7 days',
          team: '12 months',
          business: '3 years',
          enterprise: 'Custom',
          'self-hosted': 'Your database',
        },
      },
    ],
  },
  {
    title: 'Secrets and data',
    rows: [
      {
        label: 'Version history and rollback',
        values: { free: true, team: true, business: true, enterprise: true, 'self-hosted': true },
      },
      {
        label: 'Import from .env, JSON, YAML or shell',
        values: { free: true, team: true, business: true, enterprise: true, 'self-hosted': true },
      },
      {
        label: 'Export as env, JSON, YAML, shell or Docker',
        values: { free: true, team: true, business: true, enterprise: true, 'self-hosted': true },
      },
      // Not a limitation of a tier — `pull` returns the current value of every
      // secret and there is no bulk history export at all. Saying so in five
      // columns is more useful than leaving the row out and letting somebody
      // discover it mid-migration.
      {
        label: 'Bulk export of version history',
        values: {
          free: NOT_YET,
          team: NOT_YET,
          business: NOT_YET,
          enterprise: NOT_YET,
          'self-hosted': NOT_YET,
        },
      },
    ],
  },
  {
    title: 'People and access',
    rows: [
      {
        label: 'Roles for members',
        values: { free: false, team: true, business: true, enterprise: true, 'self-hosted': true },
      },
      {
        label: 'Per-project and per-environment grants',
        values: { free: false, team: true, business: true, enterprise: true, 'self-hosted': true },
      },
      {
        label: 'Production marking and hazard hatching',
        values: { free: true, team: true, business: true, enterprise: true, 'self-hosted': true },
      },
      {
        label: 'PIN lock and idle auto-lock',
        values: { free: true, team: true, business: true, enterprise: true, 'self-hosted': true },
      },
      // The dash and the "Not yet" say different things, and the difference is
      // the point: a dash means the plan does not carry it, "Not yet" means the
      // plan names it and nobody has it — including a self-hosted deployment,
      // which authenticates through Firebase and does not gain a SAML
      // implementation by owning the server it would run on.
      {
        label: 'SAML single sign-on',
        values: {
          free: false,
          team: false,
          business: NOT_YET,
          enterprise: NOT_YET,
          'self-hosted': NOT_YET,
        },
      },
      {
        label: 'SCIM provisioning',
        values: {
          free: false,
          team: false,
          business: false,
          enterprise: NOT_YET,
          'self-hosted': NOT_YET,
        },
      },
    ],
  },
  {
    title: 'The CLI, CI and the API',
    rows: [
      {
        label: 'The CLI, including xecret run',
        values: { free: true, team: true, business: true, enterprise: true, 'self-hosted': true },
      },
      {
        label: 'Encrypted offline cache',
        values: { free: true, team: true, business: true, enterprise: true, 'self-hosted': true },
      },
      {
        label: 'Service tokens, pinned to one environment',
        values: { free: true, team: true, business: true, enterprise: true, 'self-hosted': true },
      },
      {
        label: 'The HTTP API',
        values: { free: true, team: true, business: true, enterprise: true, 'self-hosted': true },
      },
      {
        label: 'Webhooks and chat integrations',
        values: {
          free: NOT_YET,
          team: NOT_YET,
          business: NOT_YET,
          enterprise: NOT_YET,
          'self-hosted': NOT_YET,
        },
      },
    ],
  },
  {
    title: 'Operating it',
    rows: [
      {
        label: 'Audit export',
        values: {
          free: 'Via the API',
          team: 'Via the API',
          business: 'Via the API',
          enterprise: 'Custom',
          'self-hosted': 'Via the API',
        },
      },
      {
        label: 'Where your data sits',
        values: {
          free: "Cloudflare's network",
          team: "Cloudflare's network",
          business: "Cloudflare's network",
          enterprise: "Cloudflare's network",
          'self-hosted': 'Wherever you host it',
        },
      },
      {
        label: 'Runs on your own infrastructure',
        values: {
          free: false,
          team: false,
          business: false,
          enterprise: true,
          'self-hosted': true,
        },
      },
      {
        label: 'Support channel',
        values: {
          free: 'GitHub issues',
          team: 'Email',
          business: 'Priority email',
          enterprise: 'Contracted',
          'self-hosted': 'GitHub issues',
        },
      },
      // Identical in all five columns, and that is the point of including it:
      // the licence is not a tier. A reader scanning for the catch finds this.
      {
        label: 'Licence',
        values: {
          free: 'AGPL-3.0 + MIT',
          team: 'AGPL-3.0 + MIT',
          business: 'AGPL-3.0 + MIT',
          enterprise: 'AGPL-3.0 + MIT',
          'self-hosted': 'AGPL-3.0 + MIT',
        },
      },
      {
        label: 'SLA',
        values: {
          free: false,
          team: false,
          business: false,
          enterprise: 'Contractual',
          'self-hosted': 'Yours to set',
        },
      },
    ],
  },
] as const satisfies readonly MatrixGroup[];

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

const FAQ: readonly FaqItem[] = [
  {
    question: 'What counts as a member?',
    answer:
      'Anyone with a seat in your organisation who can sign in and read or write a secret. Service tokens are not members, so a CI pipeline that pulls secrets on every build costs nothing. A pending invitation is not counted until it is accepted, and removing someone frees their seat immediately.',
  },
  {
    question: 'What is the difference between Team and Business?',
    answer:
      'Three things you can hold us to: audit history goes from 12 months to 3 years, support moves from email to a one business day commitment, and you can be invoiced instead of paying by card. Business also lists SAML single sign-on, which is not built yet and is marked as such on the card and in the comparison table. If none of those change how you work, Team is the plan.',
  },
  {
    question: 'What happens when I exceed the free tier?',
    answer:
      'Nothing breaks and nothing is deleted. You are asked to move to Team the next time you invite a fourth member, create a sixth project, create a second organisation, or add a fourth environment to a project. Everything already stored keeps working and the CLI keeps running. During pre-alpha there is no limit to exceed at all.',
  },
  {
    question: 'Is there an annual price?',
    answer:
      'Yes. Billed yearly, Team is $7 per member per month and Business is $15, charged as $84 and $180 per member per year — a saving of up to 22 per cent. The control at the top of this page switches every price on it. Monthly stays available on both plans, and neither is billed at all during pre-alpha.',
  },
  {
    question: 'Do you take a card during pre-alpha?',
    answer:
      'No. There is no billing system connected yet, so there is nothing to enter a card into. Every paid feature is switched on for every account, and we will give notice well before that changes rather than converting anyone silently.',
  },
  {
    question: 'Is self-hosting really free and unlimited?',
    answer:
      'Yes. The server is AGPL-3.0 and the CLI is MIT, so you can run the whole thing on your own Cloudflare account, your own PostgreSQL database and your own Firebase project. No feature is held back for a paid tier and there is no licence key to buy. What you pay for is the infrastructure and the time to operate it, and the self-hosting guide states both plainly, including the parts that are friction.',
  },
  {
    question: 'What happens to my data if I stop paying?',
    answer:
      'Your organisation drops to the Free plan. Nothing is deleted: every secret is still readable, still exportable and still injectable by the CLI. If you are over the free limits, new members, projects and environments are blocked until you are back inside them or you export and self-host. We will not hold a credential hostage over a billing dispute — a secret manager that can lock you out of your own secrets is worse than the .env file it replaced.',
  },
  {
    question: 'Do you offer a discount for open source or non-profits?',
    answer:
      'Yes, and there is no automated flow for it — open an issue on GitHub or email us with a link to the project and we will sort it by hand. Public open-source projects, registered non-profits and student teams are the cases we intend to approve. Because a person reads every request, ask before you pay rather than after.',
  },
  {
    question: 'Can I move between plans?',
    answer:
      'Yes, in both directions and at any time. Moving up will take effect immediately and be prorated for the rest of the period; moving down will take effect at the end of the period you have already paid for, and nothing is deleted when it does. None of this is live yet, because no plan is billed yet.',
  },
];

/* ── Structured data ───────────────────────────────────────────────────────── */

/**
 * The offer description, assembled from what the card renders.
 *
 * A hand-written offer description is the field that goes stale the first time
 * a limit changes — and a stale limit in structured data is one Google keeps
 * serving long after the page is right. An unbuilt capability carries its
 * caveat here too: an `Offer` that lists SAML without it is the tick this page
 * refuses to show, published somewhere nobody on the team ever reads back.
 */
function offerDescription(plan: Plan): string {
  const includes = plan.features
    .map((feature) => (feature.notYet === true ? `${feature.text} (not built yet)` : feature.text))
    .join('; ');
  const annual = plan.yearly.note === undefined ? '' : ` Annual equivalent: ${plan.yearly.note}.`;

  return `${plan.audience} Includes: ${includes}.${annual}`;
}

/**
 * The plans as a `Product` with one `Offer` per plan, derived from `PLANS`.
 *
 * Enterprise carries no `price` at all rather than a placeholder zero. A `0`
 * there would be published to a shopping surface as free, which is the one
 * mistake in this file that would end up in front of a customer.
 */
const PRODUCT = {
  '@type': 'Product',
  '@id': absoluteUrl('/pricing#plans'),
  name: `${SITE_NAME} plans`,
  description: DESCRIPTION,
  category: 'Secret management',
  brand: { '@id': absoluteUrl('/#organization') },
  url: absoluteUrl('/pricing'),
  offers: PLANS.map((plan) => ({
    '@type': 'Offer',
    '@id': absoluteUrl(`/pricing#${plan.id}`),
    name: plan.name,
    description: offerDescription(plan),
    url: absoluteUrl(`/pricing#${plan.id}`),
    availability: 'https://schema.org/InStock',
    ...(plan.amount === null
      ? {}
      : {
          price: plan.amount,
          priceCurrency: 'USD',
          priceSpecification: {
            '@type': 'UnitPriceSpecification',
            price: plan.amount,
            priceCurrency: 'USD',
            ...(plan.unitText === null ? {} : { unitText: plan.unitText }),
          },
        }),
  })),
};

/* ── Pieces ────────────────────────────────────────────────────────────────── */

/**
 * One billing period's figures, inside a card.
 *
 * Both periods are rendered on every card and one of them is `display: none` —
 * not `visibility: hidden`, which would leave every card announcing two prices
 * one after the other to a screen reader.
 */
function PriceBlock({ value, className }: { value: PlanPrice; className: string }) {
  return (
    <div className={className}>
      <p className="text-fg text-3xl font-semibold tracking-[-0.02em]">{value.price}</p>
      <p className="text-fg-subtle mt-1 text-sm">{value.unit}</p>
      {value.note === undefined ? null : (
        <p className="text-fg-subtle mt-1 text-xs leading-5">{value.note}</p>
      )}
    </div>
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

  // Quieter than a value, louder than a dash. Compared against the constant
  // rather than the literal so this treatment cannot survive a reword of it.
  return <span className={value === NOT_YET ? 'text-fg-subtle' : 'text-fg-muted'}>{value}</span>;
}

export default function PricingPage() {
  return (
    <PublicPage current="pricing">
      <JsonLd
        data={graph(
          PRODUCT,
          faqSchema(FAQ),
          breadcrumbSchema([{ name: 'Pricing', path: '/pricing' }]),
        )}
      />

      <PageHero
        eyebrow="Pricing"
        title="Secret management pricing, without the sales call."
        description="Four plans and a self-hosted option, published in full — the limits included. Free is genuinely free, Team is $9 per member per month, and running the whole server yourself is free forever."
      />

      <Section id="plans" aria-labelledby="plans-heading" tone="canvas">
        {/* The prices come first, with no heading introducing them: a reader who
            opened /pricing does not need to be told that the four cards under
            the word "Pricing" are the plans. The h2 stays as a hidden one
            because the cards are h3s — a page whose headings jump from h1 to h3
            has a hole in the outline a screen-reader user navigates by — and
            because `<section aria-labelledby>` needs something to name it. */}
        <h2 id="plans-heading" className="sr-only">
          Plans and prices
        </h2>

        {/* ── The billing period ──
            The two radios come first and everything they govern sits in the one
            wrapper beside them, because the CSS that swaps the prices reaches
            from `:checked` with `~`. See the note at the top of this file, and
            `.x-price-monthly` in globals.css. `min-w-0` because a fieldset's
            default `min-inline-size: min-content` would let the widest cell in
            the grid push the page sideways. */}
        <fieldset className="min-w-0">
          <legend className="sr-only">Billing period</legend>

          <input
            id="billing-monthly"
            type="radio"
            name="billing"
            value="monthly"
            defaultChecked
            className="x-billing-monthly sr-only"
          />
          <input
            id="billing-yearly"
            type="radio"
            name="billing"
            value="yearly"
            className="x-billing-yearly sr-only"
          />

          <div className="x-billing-body">
            <div className="flex flex-col items-center">
              <div className="border-line bg-canvas-inset inline-flex items-center gap-1 rounded-full border p-1">
                <label htmlFor="billing-monthly" data-billing="monthly" className={SEGMENT}>
                  Monthly
                </label>
                <label htmlFor="billing-yearly" data-billing="yearly" className={SEGMENT}>
                  Yearly
                  <span className="text-fg-subtle text-xs font-normal">Save up to 22%</span>
                </label>
              </div>

              {/* The one sentence left of what used to be a banner between two
                  sections. It qualifies every figure below it, so it stays —
                  quietly, and above the first price rather than under the
                  last one. */}
              <p className="text-fg-subtle mt-4 max-w-2xl text-center text-sm leading-6">
                Pre-alpha: every paid feature below is on for every account, and no card is
                collected anywhere in the product.
              </p>
            </div>

            <RevealGroup className="mt-10 grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
              {PRICED_PLANS.map((plan) => (
                <article
                  key={plan.id}
                  id={plan.id}
                  className={cn(
                    // Equal height with the button on the baseline: `mt-auto` on
                    // the action pushes it down whatever the feature list does
                    // above it, so four cards of different lengths still end on
                    // one line.
                    'bg-surface flex h-full scroll-mt-24 flex-col rounded-xl border p-6 transition-colors',
                    plan.recommended
                      ? 'border-accent shadow-raised'
                      : 'border-line hover:border-line-strong',
                  )}
                >
                  <div className="flex items-center gap-2">
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

                  <p className="text-fg-muted mt-2 text-sm leading-6">{plan.audience}</p>

                  <div className="mt-5">
                    <PriceBlock className="x-price-monthly" value={plan.monthly} />
                    <PriceBlock className="x-price-yearly" value={plan.yearly} />
                  </div>

                  <ul className="mt-5 space-y-2.5">
                    {plan.features.map((feature) => (
                      <li key={feature.text} className="flex gap-2.5">
                        {/* No tick beside something that does not exist. The
                            dash is the same glyph the matrix uses for an
                            absence, and the chip beside the text is the same
                            word the matrix row carries. */}
                        {feature.notYet === true ? (
                          <MinusIcon className="text-fg-subtle mt-1 size-4 shrink-0" />
                        ) : (
                          <CheckIcon className="text-fg-subtle mt-1 size-4 shrink-0" />
                        )}
                        <span className="text-fg-muted text-sm leading-6">
                          {feature.text}
                          {feature.notYet === true ? (
                            <span className="border-line text-fg-subtle ml-1.5 rounded-full border px-1.5 py-0.5 text-[0.6875rem] font-medium whitespace-nowrap">
                              {NOT_YET}
                            </span>
                          ) : null}
                        </span>
                      </li>
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
          </div>
        </fieldset>

        {/* ── Self-hosting ──
            Deliberately not a fifth card, and deliberately outside the fieldset
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
                {SELF_HOSTED.monthly.price}
              </p>
              <p className="text-fg-subtle mt-1 text-sm">{SELF_HOSTED.monthly.unit}</p>
              <p className="text-fg-muted mt-3 text-sm leading-6">{SELF_HOSTED.audience}</p>
            </div>

            <ul className="border-line-subtle grid flex-1 gap-x-6 gap-y-2 border-t pt-6 sm:grid-cols-2 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-8">
              {SELF_HOSTED.features.map((feature) => (
                <li key={feature.text} className="flex gap-2.5">
                  <CheckIcon className="text-fg-subtle mt-1 size-4 shrink-0" />
                  <span className="text-fg-muted text-sm leading-6">{feature.text}</span>
                </li>
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

        {/* The table is wider than a phone and always will be, so it scrolls
            inside its own box rather than making the document scroll sideways.
            `tabindex` is what makes that box reachable without a pointer — a
            scroll container that only a mouse can move is a table a keyboard
            user can read one third of. The same arrangement as `.doc-table-wrap`
            in docs.css; the global `:focus-visible` rule rings it. */}
        <div
          tabIndex={0}
          role="region"
          aria-label="Plan comparison"
          className="border-line bg-surface mt-10 overflow-x-auto rounded-xl border"
        >
          <table className="w-full min-w-[64rem] border-collapse text-sm">
            <caption className="sr-only">
              Every xecret plan compared, capability by capability, in five groups. The header shows
              the monthly price; billed yearly, Team is $7 and Business is $15 per member per month.
              During pre-alpha every feature is available on every account and nothing is billed.
            </caption>
            <thead className="bg-canvas-inset">
              <tr className="border-line border-b">
                <th scope="col" className="w-[17rem] px-4 py-3 text-left">
                  <span className="sr-only">Capability</span>
                </th>
                {PLANS.map((plan) => (
                  <th key={plan.id} scope="col" className="px-4 py-3 text-center align-bottom">
                    <span className="text-fg block font-semibold">{plan.name}</span>
                    {/* The monthly figure, always. This header sits outside the
                        toggle's wrapper and cannot follow it, and a column that
                        silently kept a yearly price while the cards showed a
                        monthly one would be the same page contradicting
                        itself — so the caption says which one this is. */}
                    <span className="text-fg block text-xs font-medium">{plan.monthly.price}</span>
                    <span className="text-fg-subtle block text-xs font-normal">
                      {plan.monthly.unit}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            {MATRIX.map((group) => (
              <tbody key={group.title}>
                <tr className="border-line-subtle bg-canvas-inset/60 border-y">
                  {/* `colgroup`, not `col`: this heading names the rows beneath
                      it across every plan column, and it is what a screen reader
                      reads out before each row of the group. */}
                  <th
                    scope="colgroup"
                    colSpan={PLANS.length + 1}
                    className="text-fg-subtle px-4 py-2.5 text-left text-xs font-semibold tracking-[0.14em] uppercase"
                  >
                    {group.title}
                  </th>
                </tr>
                {group.rows.map((row) => (
                  <tr
                    key={row.label}
                    className="border-line-subtle hover:bg-surface-hover border-b transition-colors last:border-b-0"
                  >
                    <th scope="row" className="text-fg px-4 py-3 text-left font-medium">
                      {row.label}
                    </th>
                    {PLANS.map((plan) => (
                      <td key={plan.id} className="px-4 py-3 text-center whitespace-nowrap">
                        <CellValue value={row.values[plan.id]} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>

        <p className="text-fg-muted mx-auto mt-6 max-w-3xl text-center text-sm leading-7">
          SAML and SCIM are named on the plans that will carry them and marked{' '}
          <span className="text-fg font-medium">Not yet</span> in every column, because neither is
          built. The chips on the cards and the rows in this table say the same word deliberately:
          the first contract that needs them is what gets them written, and until then you should
          plan as though they do not exist. Enterprise is a conversation rather than a checkout,
          which is why the card has no price and there is no form to fill in.
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

      <Section id="included" aria-labelledby="included-heading" tone="canvas">
        <SectionHeading
          headingId="included-heading"
          align="center"
          eyebrow="Every plan"
          title="What every plan includes"
          description="The parts a secrets product should never tier are not tiered here. These four are identical whether you pay nothing, pay for Business or sign a contract."
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
          description="The nine that decide whether a price is workable, answered including the several where the honest answer is that it is not built yet."
        />

        <Faq items={FAQ} className="mx-auto mt-10 max-w-3xl" />

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
        description="Five projects, three members and the whole CLI, without a card. If you outgrow it, the price is on this page and it will not change under you."
      />
    </PublicPage>
  );
}

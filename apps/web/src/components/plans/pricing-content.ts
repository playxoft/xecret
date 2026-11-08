import { PLANS as PLAN_DEFINITIONS } from '@xecret/core/entitlements';
import type { PlanFeatures } from '@xecret/core/entitlements';

// Type-only, so nothing of the marketing kit reaches the dashboard bundle that
// imports this module too.
import type { ConditionalFaqItem, FaqItem } from '@/components/marketing/faq';

/**
 * What the plans are said to include, written once for the two pages that say
 * it: the public pricing page (`app/pricing/page.tsx`) and the in-app plans
 * page (`app/(dashboard)/_components/upgrade-screen.tsx`).
 *
 * ── Why this is a module and not the pricing page's own constants ──
 * It was the pricing page's own constants until the owner asked (2026-11-08)
 * for the in-app plans page to carry the whole comparison table and the FAQ
 * rather than a reduced copy of them. A `page.tsx` can export only what Next
 * allows, so the plans page could not import them from there, and a second copy
 * would be two tables that agree only until somebody edits one. So the data
 * lives here and both pages render it — each in its own markup: the pricing
 * page with its CSS currency machinery and its marketing type, the plans page
 * with the dashboard's table and tokens. One claim, one place to correct it.
 *
 * ── Data only ──
 * No React, no icons, no markup, nothing from the marketing kit or the
 * dashboard but types. The pricing page is a prerendered public page and the
 * plans page is a client component; both import this, so it must be safe for
 * either. What each row *means* is here; how a row is drawn is each page's.
 *
 * ── What is still the pricing page's alone ──
 * The prices. A price is typography as much as data and varies by currency, and
 * the five sheets, the add-on band and the self-hosting band stay in
 * `page.tsx` beside the CSS that reveals them. The plans page restates the
 * US-dollar figures it shows, and `upgrade-plans.test.ts` cross-checks them
 * against that file.
 *
 * ── What came with it ──
 * The rows, the questions and the helpers that compose them came from
 * `page.tsx` with their commentary, which explains decisions about the data and
 * belongs beside it wherever it lives. Three things are new with the move: the
 * gated rows read their ticks from `PLANS` (`flagRow`), three rows only the
 * plans page used to show are in the table for both, and each question has an
 * `id` — and, where the plans page needs one, an `inApp` answer.
 *
 * Several claims here are open decisions rather than settled facts —
 * per-environment access sold at Team though nothing enforces it, custom roles
 * marked "Coming soon" though built. The note at the top of
 * `app/(dashboard)/_components/upgrade-plans.ts` has them; the correction for
 * either is an edit to this file, and it reaches both pages.
 */

/* ── Words and numbers ────────────────────────────────────────────────────── */

/**
 * The one string that means "named on the plan, and not built".
 *
 * Shared between the chips on the cards and the cells in the matrix. The
 * failure mode this guards against is not a typo — it is the page showing a
 * tick beside SAML in one place and an absence in the other.
 */
export const NOT_YET = 'Coming soon';

/** One word, used wherever a plan limit is `null`. */
export const UNLIMITED = 'Unlimited';

/**
 * What an Enterprise cell says where every other column says a number.
 *
 * Its own token beside `UNLIMITED` because the two are different claims.
 * "Unlimited" is a ceiling we have decided not to impose; this is a ceiling that
 * exists and is written in an agreement rather than on a web page. Printing the
 * engine's fallback figure here would be quoting an allowance nobody negotiated.
 */
export const CONTRACTED = 'Contracted';

/**
 * Bought per connection rather than reached by moving tier.
 *
 * Its own token, beside `NOT_YET`, because "your plan does not have this" and
 * "your plan can have this, for a published price" are different answers and a
 * dash gives the first to a reader entitled to the second.
 */
export const ADDON = 'Add-on';

/**
 * Priced as an add-on, and not built.
 *
 * SAML and SCIM are both. The matrix used to read a bare `Add-on` for the paid
 * self-serve columns while the *enterprise* column on the same row read the
 * not-built chip, which told a Team customer they could buy SAML today and an
 * Enterprise customer they could not — the two answers inverted against the tier ladder, on the one
 * capability this page charges $199 a month for. Both halves have to be on the
 * cell, because dropping either one publishes a falsehood: `Add-on` alone sells
 * something that does not exist, `Not yet` alone hides that it will be charged
 * for separately when it does.
 */
export const ADDON_NOT_YET = `${ADDON}, coming soon`;

/**
 * The limits, read from the file the server enforces from.
 *
 * Not copied. `@xecret/core/entitlements` holds one definition of every ceiling
 * in the product, and `pricing-page.test.ts` fails the build if a number
 * rendered here stops matching it. A pricing page that advertises a limit the
 * server does not hold is a page that will one day refuse a customer something
 * they paid for, in the middle of a deploy, with a receipt in hand.
 *
 * Prices are deliberately *not* imported: a price is typography as much as
 * data, it varies by currency, and `'$12'` is a rendering decision where `12`
 * is a number.
 */
export const LIMITS = {
  free: PLAN_DEFINITIONS.free.limits,
  pro: PLAN_DEFINITIONS.pro.limits,
  team: PLAN_DEFINITIONS.team.limits,
  enterprise: PLAN_DEFINITIONS.enterprise.limits,
} as const;

/**
 * The smallest number of seats a plan can be bought with.
 *
 * Published because it is the one number on this page that can make a bill
 * larger than the arithmetic a reader just did. `resolveBilledSeats` floors
 * billed seats at it — `Math.max(billed, minimum)` — so a two-person team
 * reading "$12 per member per month" computes $288 a year and is invoiced
 * $432. A page that publishes every ceiling in the product and omits the one
 * that costs money is not being terse, it is being misleading, and it is the
 * exact failure the limits import exists to prevent: a customer meeting a
 * number at checkout that the page never showed them.
 *
 * Read from the engine rather than restated, like the limits above it.
 */
export const MINIMUM_SEATS = {
  free: PLAN_DEFINITIONS.free.minimumSeats,
  pro: PLAN_DEFINITIONS.pro.minimumSeats,
  team: PLAN_DEFINITIONS.team.minimumSeats,
  enterprise: PLAN_DEFINITIONS.enterprise.minimumSeats,
} as const;

/**
 * A ceiling as a cell or a bullet: the number, or the word for `null`.
 *
 * Every countable on Pro and Team is a number now, and Enterprise is where
 * `null` lives — so this exists to render one column rather than to paper over a
 * plan whose limits nobody wrote down. `String(limit)` on a `null` produces the
 * literal `"null"`, which is the failure this replaces.
 */
export function formatLimit(limit: number | null): string {
  return limit === null ? UNLIMITED : limit.toLocaleString('en-GB');
}

/**
 * `150_000` → `150,000`, and `2_000_000` → `2 million`.
 *
 * Seven digits in a card bullet is a number nobody reads; two million is a
 * number everybody does. The threshold is where the comma form stops being
 * scannable at a glance rather than where it stops being correct.
 */
export function formatCount(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)} million`;
  }
  return value.toLocaleString('en-GB');
}

/**
 * A seat floor as a cell: the number, or the words for "there isn't one".
 *
 * A floor of one is not a floor, and printing "1 member" said the opposite of
 * the FAQ and the Terms, which both state that Free and Pro have none. Free is
 * worse than redundant there: `resolveBilledSeats` returns `billed: 1` for it
 * unconditionally and it is never invoiced, so a billing figure in that column
 * describes a bill that does not exist. Pluralised rather than suffixed with a
 * bare "members", so a floor that ever moves to 1 cannot render "1 members".
 */
export function seatFloor(seats: number): string {
  if (seats <= 1) return 'No minimum';
  return `${seats} members`;
}

/**
 * The floor as a sentence fragment: "Billed from 3 members up", or nothing.
 *
 * Every surface that states a floor goes through this or `seatFloor`, and that
 * is the point. The matrix cell was converted to a helper and the two card
 * caveats and the FAQ answer were left interpolating `${…} members` directly —
 * so a floor moved to 1 would have printed "No minimum" in the table, "Billed
 * from 1 members up" on the card, and an FAQ asserting a floor that no longer
 * existed. Three renderings of one constant, one of them guarded, which is the
 * arrangement the matrix comment says the helper exists to prevent.
 *
 * Returns `undefined` rather than an empty string so a plan with no floor
 * carries no `priceCaveat` at all, instead of an empty paragraph.
 */
export function seatFloorCaveat(seats: number): string | undefined {
  if (seats <= 1) return undefined;
  return `Billed from ${seats} members up`;
}

/**
 * The FAQ's sentence about floors, composed from which plans actually have one.
 *
 * It used to name Team and Enterprise and then assert "Free and Pro have no
 * floor" as a literal, which is three claims about `MINIMUM_SEATS` and none of
 * them derived: a floor added to Pro would have left the page denying it. Both
 * halves are built from the constant now, so the sentence cannot outlive the
 * arrangement it describes.
 */
export function seatFloorSentence(): string {
  const NAMES = { free: 'Free', pro: 'Pro', team: 'Team', enterprise: 'Enterprise' } as const;
  const ALL = ['free', 'pro', 'team', 'enterprise'] as const;

  // Both halves partition the *same* list. An earlier version derived the
  // floored plans from ['pro', 'team', 'enterprise'] and the unfloored ones from
  // all four, so a floor added to Free would have appeared in neither clause —
  // dropped from a sentence whose whole point is that it cannot outlive the
  // arrangement it describes.
  const withFloor = ALL.filter((id) => MINIMUM_SEATS[id] > 1);
  const without = ALL.filter((id) => MINIMUM_SEATS[id] <= 1);

  // 'A', 'A and B', 'A, B and C' — reads as English at every length. The
  // previous one joined three or more with commas and no conjunction, and
  // rendered the empty case as 'no plan' against a plural verb.
  const list = (parts: readonly string[]): string => {
    if (parts.length === 0) return '';
    if (parts.length === 1) return parts[0] as string;
    return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] as string}`;
  };

  const floors = list(withFloor.map((id) => `${NAMES[id]} from ${MINIMUM_SEATS[id]}`));

  if (withFloor.length === 0) return 'No plan has a seat minimum.';
  if (without.length === 0) {
    return `Every plan is billed from a minimum — ${floors} — so a smaller group pays the minimum rather than a lower number.`;
  }

  return (
    `Seats are billed from a minimum on some plans — ${floors} — so a smaller group on one of ` +
    `those pays the minimum rather than a lower number; ${list(without.map((id) => NAMES[id]))} ` +
    `${without.length === 1 ? 'has' : 'have'} no floor.`
  );
}

/**
 * `7` → `7 days`, `365` → `1 year`.
 *
 * One column used to carry the literal `'1 year'` while the rest read
 * `LIMITS.*.auditRetentionDays`, which meant it could stop matching the server
 * with every test still green — the single thing importing the limits at all was
 * supposed to prevent. A year is the only retention worth rewording, so the
 * rewording lives here and every column goes through it.
 */
export function formatRetention(days: number): string {
  if (days % 365 === 0) {
    const years = days / 365;
    return years === 1 ? '1 year' : `${years} years`;
  }
  return `${days} days`;
}

/* ── The comparison matrix ─────────────────────────────────────────────────── */

/**
 * Every column the comparison table knows, in the pricing page's order.
 *
 * Wider than the engine's `PlanId`: self-hosting is a column here and not a
 * plan the engine bills. The in-app plans page renders the first four — the
 * ones an organisation on the hosted service can be on — and leaves this one
 * to the pricing page, where it is an alternative to buying rather than a
 * thing to buy.
 */
export type PricingPlanId = 'free' | 'pro' | 'team' | 'enterprise' | 'self-hosted';

/** `true` renders a check, `false` a dash, a string renders itself. */
export type Cell = boolean | string;

export interface MatrixRow {
  readonly label: string;
  /**
   * One sentence explaining what the row means, behind an info button.
   *
   * **Required, deliberately.** A table of forty-nine capability names is a
   * glossary as much as a comparison, and half the rows say something a reader
   * outside this product has no way to guess — "break-glass", "per-environment
   * grants", "point-in-time restore". Making it optional would have left the
   * rows nobody thought about as the ones with no explanation, which are the
   * same rows.
   *
   * A field rather than a lookup keyed on `label`, for the reason the note on
   * `PlanFeature.notYet` gives: a table keyed by a row's own text stops applying
   * the first time somebody rewords the text, and does it silently.
   *
   * Says what the row *is*, never what it is worth. A hint that sells is a hint
   * a reader learns to skip.
   */
  readonly hint: string;
  /**
   * Keyed by plan rather than positional. A tuple would be shorter and would
   * let a row silently shift by one column the first time a plan is inserted;
   * this cannot, because the compiler requires every key on every row.
   */
  readonly values: Readonly<Record<PricingPlanId, Cell>>;
  /**
   * The engine flag the row's ticks are read from, where it has one.
   *
   * Set only on rows built by `flagRow`, whose cells come from `PLANS` rather
   * than being written here, and only for flags with a `requireFeature` behind
   * them — `upgrade-plans.test.ts` reads the server for the gate behind every
   * row that names one. A flag the server never checks would tick a column for
   * something every plan already has.
   */
  readonly feature?: keyof PlanFeatures | undefined;
  /**
   * A term of the sale rather than a capability: the seat floor, what a
   * machine costs, what happens past the allowance.
   *
   * The pricing page shows these everywhere, because it always describes the
   * hosted service. The in-app plans page leaves them out on an installation
   * that takes no payments, for the reason it shows no price there: a term of
   * a sale nobody can make is a promise about a bill that does not exist.
   */
  readonly sale?: true | undefined;
}

export interface MatrixGroup {
  /** Rendered as a spanning row, and as the group's accessible name. */
  readonly title: string;
  readonly rows: readonly MatrixRow[];
}

/**
 * One countable ceiling, across every column.
 *
 * Replaces the constant that spread `Unlimited` across all four paid columns.
 * Pro and Team publish real numbers now — see the note on `PRO_LIMITS` in
 * `plans.ts` — and a shared "unlimited" would have been the page stating a
 * promise the server had stopped making, which is the single failure the
 * imported limits exist to prevent.
 *
 * Self-hosting is unlimited by construction rather than by plan: there is no
 * meter in a server you run, and nothing in the code to raise.
 */
function limitRow(
  label: string,
  resource:
    | 'organizations'
    | 'projects'
    | 'seats'
    | 'environmentsPerProject'
    | 'serviceTokens'
    | 'secretsPerEnvironment',
  hint: string,
): MatrixRow {
  return {
    label,
    hint,
    values: {
      free: formatLimit(LIMITS.free[resource]),
      pro: formatLimit(LIMITS.pro[resource]),
      team: formatLimit(LIMITS.team[resource]),
      enterprise: formatLimit(LIMITS.enterprise[resource]),
      'self-hosted': UNLIMITED,
    },
  };
}

/** A capability every column has. */
const EVERYWHERE = {
  free: true,
  pro: true,
  team: true,
  enterprise: true,
  'self-hosted': true,
} as const;

/**
 * Announced and not built, in every column.
 *
 * More useful than omitting the row: somebody scanning for a capability finds
 * out here rather than mid-migration. The dash and the "Not yet" say different
 * things and the difference is the point — a dash means the plan does not carry
 * it, "Not yet" means the plan names it and nobody has it.
 */
const NOWHERE_YET = {
  free: NOT_YET,
  pro: NOT_YET,
  team: NOT_YET,
  enterprise: NOT_YET,
  'self-hosted': NOT_YET,
} as const;

/**
 * A capability the engine gates by a flag, ticked wherever `PLANS` grants it.
 *
 * Read rather than written, so moving a capability to another plan in
 * `plans.ts` moves its ticks on both pages that render this table. Only for a
 * flag that is built and has a `requireFeature` behind it — an announced flag
 * nobody has built (approvals, break-glass, federation, scheduled secrets,
 * single sign-on) is `true` in `PLANS` and must still read `NOT_YET` here, so
 * those rows keep their cells written out.
 *
 * Self-hosting carries every built capability, as the band and its other rows
 * say: nothing is held back there.
 */
function flagRow(label: string, feature: keyof PlanFeatures, hint: string): MatrixRow {
  return {
    label,
    hint,
    feature,
    values: {
      free: PLAN_DEFINITIONS.free.features[feature],
      pro: PLAN_DEFINITIONS.pro.features[feature],
      team: PLAN_DEFINITIONS.team.features[feature],
      enterprise: PLAN_DEFINITIONS.enterprise.features[feature],
      'self-hosted': true,
    },
  };
}

/**
 * The comparison table, in five groups.
 *
 * Annotated rather than `as const satisfies`, now that two pages read it: the
 * in-app plans page reads `feature` and `sale` off every row, and on a const
 * tuple the rows without them have no such property to read.
 */
export const PLAN_COMPARISON: readonly MatrixGroup[] = [
  {
    title: 'Limits',
    rows: [
      limitRow(
        'Organisations',
        'organizations',
        'A separate tenant, with its own members, projects and master key. Most teams need one.',
      ),
      limitRow(
        'Projects',
        'projects',
        'A codebase or a service. Each holds its own environments and secrets.',
      ),
      limitRow(
        'Members',
        'seats',
        'People with a login. Service tokens, CI runners and agents are never counted here.',
      ),
      {
        label: 'Smallest billable team',
        hint: 'The fewest seats a plan can be bought with. Below it you are billed for the minimum, never blocked from using fewer.',
        // A floor of one is not a floor, and printing "1 member" here said the
        // opposite of the FAQ and the Terms, which both state that Free and Pro
        // have none. Free is worse than redundant: `resolveBilledSeats` returns
        // `billed: 1` for it unconditionally and it is never invoiced at all,
        // so a billing figure in that column describes a bill that does not
        // exist. `MINIMUM_SEATS` is still what decides which columns get a
        // number, so the row cannot drift from the engine.
        // All four columns go through the same helper. Two of them used to
        // interpolate `${…} members` directly, so a floor moved to 1 would have
        // printed "1 members" *and* contradicted the FAQ sentence built from
        // the same constant — the drift this row reads `MINIMUM_SEATS` to avoid.
        values: {
          free: seatFloor(MINIMUM_SEATS.free),
          pro: seatFloor(MINIMUM_SEATS.pro),
          team: seatFloor(MINIMUM_SEATS.team),
          enterprise: seatFloor(MINIMUM_SEATS.enterprise),
          'self-hosted': 'No minimum',
        },
        sale: true,
      },
      limitRow(
        'Environments per project',
        'environmentsPerProject',
        'development, staging, production — and any others you add.',
      ),
      limitRow(
        'Secrets per environment',
        'secretsPerEnvironment',
        'Individual keys stored inside one environment.',
      ),
      limitRow(
        'Service tokens for CI',
        'serviceTokens',
        'Machine credentials, each pinned to a single environment.',
      ),
      // Machines are free everywhere and this row is where a reader checks
      // that. The competing meter in this category bills per identity, human
      // or not, which is the comparison this row is written to invite.
      {
        label: 'Cost per service token, CI runner or AI agent',
        hint: 'What a non-human identity adds to the bill. Nothing, on every plan.',
        values: {
          free: 'Free',
          pro: 'Free',
          team: 'Free',
          enterprise: 'Free',
          'self-hosted': 'Free',
        },
        sale: true,
      },
      {
        label: 'Included secret fetches a month',
        hint: 'Reads across everything — the CLI, CI and the API.',
        values: {
          free: formatCount(LIMITS.free.includedFetchesPerMonth),
          pro: formatCount(LIMITS.pro.includedFetchesPerMonth),
          team: formatCount(LIMITS.team.includedFetchesPerMonth),
          // Not a number, deliberately. An Enterprise allowance is whatever the
          // agreement says, and printing the engine's fallback would be quoting
          // a figure nobody has agreed to. See `ENTERPRISE_LIMITS`.
          enterprise: CONTRACTED,
          'self-hosted': UNLIMITED,
        },
      },
      // The answer is the same in every column and it is the row most worth
      // reading twice: going over the allowance is an invoice, never a refusal.
      {
        label: 'What happens past the allowance',
        hint: 'Going over is a line on an invoice. A build never fails for a billing reason.',
        values: {
          free: 'Nothing breaks',
          pro: 'Billed, never blocked',
          team: 'Billed, never blocked',
          enterprise: 'Contracted',
          'self-hosted': 'Your infrastructure',
        },
        sale: true,
      },
      {
        label: 'Audit history',
        hint: 'How far back the log stays readable. Older records are pruned.',
        values: {
          free: formatRetention(LIMITS.free.auditRetentionDays),
          pro: formatRetention(LIMITS.pro.auditRetentionDays),
          team: formatRetention(LIMITS.team.auditRetentionDays),
          // The default a contract raises, not a wall — but a default is still a
          // number the server holds, and `'Custom'` here was the one column on
          // this row that could stop matching the engine with every test green.
          enterprise: `${formatRetention(LIMITS.enterprise.auditRetentionDays)}, or as contracted`,
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
        hint: 'Every write keeps the value it replaced, and any version can be restored.',
        values: EVERYWHERE,
      },
      {
        label: 'Import from .env, JSON, YAML or shell',
        hint: 'Bring existing secrets in without retyping them.',
        values: EVERYWHERE,
      },
      {
        label: 'Export as env, JSON, YAML, shell or Docker',
        hint: 'Take them out in whatever shape the thing consuming them wants.',
        values: EVERYWHERE,
      },
      {
        label: 'Per-environment encryption, zero-knowledge',
        hint: 'Values are sealed in your browser. The server stores ciphertext it cannot open.',
        values: EVERYWHERE,
      },
      flagRow(
        'Secret referencing and environment inheritance',
        'secretReferencing',
        'Point one secret at another instead of copying the value into both.',
      ),
      flagRow(
        'Personal local overrides',
        'personalOverrides',
        'Replace a value on your own machine without changing it for the team.',
      ),
      flagRow(
        'Environment promotion, with a diff',
        'environmentPromotion',
        'Move staging to production after seeing exactly what would change.',
      ),
      flagRow(
        'Point-in-time restore',
        'pointInTimeRestore',
        'Roll a whole environment back to how it looked at a moment.',
      ),
      // These two and the read alerts under the CLI group were rows only the
      // in-app plans page had, until the two pages began sharing this table:
      // built, gated, and missing from the public comparison. Both pages show
      // them now.
      flagRow(
        'A secret policy for names and values',
        'secretPolicy',
        'Hold new secrets to a naming rule, a minimum strength and words they must not contain.',
      ),
      flagRow(
        'Plaintext export switched off per environment',
        'disableEnvExport',
        'Stop an environment’s values being written to a file. xecret run keeps working.',
      ),
      {
        label: 'Scheduled and expiring secrets',
        hint: 'A value that switches on later, or stops working on a date.',
        // Team, not Enterprise: `TEAM_FEATURES.scheduledSecrets` is `true` in
        // the engine and the Team card names it. This row read `team: false`,
        // which by the convention above means "your plan does not carry this"
        // — so the table was selling a Team capability as Enterprise-only
        // three screens below the card that grants it.
        values: {
          free: false,
          pro: false,
          team: NOT_YET,
          enterprise: NOT_YET,
          'self-hosted': NOT_YET,
        },
      },
      // Not a limitation of a tier — `pull` returns the current value of every
      // secret and there is no bulk history export at all.
      {
        label: 'Bulk export of version history',
        hint: 'The full history for an environment, not only its current values.',
        values: NOWHERE_YET,
      },
    ],
  },
  {
    title: 'People and access',
    rows: [
      {
        label: 'Production marking and hazard hatching',
        hint: 'Production is visibly marked everywhere it appears, so nobody edits it by accident.',
        values: EVERYWHERE,
      },
      {
        label: 'PIN lock and idle auto-lock',
        hint: 'The vault relocks itself after a period of inactivity.',
        values: EVERYWHERE,
      },
      // The row the Pro → Team decision turns on, and the reason Pro can offer
      // unlimited members without undercutting Team: on Pro, everybody reads
      // production. A team with one person who must not is on Team.
      {
        label: 'Roles for members',
        hint: 'Owner, admin, developer and viewer, applied across the organisation.',
        values: {
          free: false,
          pro: false,
          team: true,
          enterprise: true,
          'self-hosted': true,
        },
      },
      {
        label: 'Per-project and per-environment grants',
        hint: 'Give somebody staging without giving them production.',
        values: {
          free: false,
          pro: false,
          team: true,
          enterprise: true,
          'self-hosted': true,
        },
      },
      {
        label: 'Change approvals',
        hint: 'A second person signs off before a production secret changes.',
        values: {
          free: false,
          pro: false,
          team: NOT_YET,
          enterprise: NOT_YET,
          'self-hosted': NOT_YET,
        },
      },
      {
        label: 'Break-glass emergency access',
        hint: 'A recorded, time-boxed override for the incident at 3am.',
        values: {
          free: false,
          pro: false,
          team: NOT_YET,
          enterprise: NOT_YET,
          'self-hosted': NOT_YET,
        },
      },
      {
        label: 'Custom roles',
        hint: 'Define your own permission sets when the four built-in roles do not fit.',
        values: {
          free: false,
          pro: false,
          team: false,
          enterprise: NOT_YET,
          'self-hosted': NOT_YET,
        },
      },
      // Included, not charged. Google Workspace, Entra ID, Okta, Auth0 and
      // JumpCloud all speak OIDC, and implementing it ourselves is what makes
      // giving it away at this tier affordable.
      {
        label: 'Single sign-on with OIDC',
        hint: 'Sign in through your own identity provider. Costs nothing extra, because it costs us nothing.',
        values: {
          free: false,
          pro: false,
          team: NOT_YET,
          enterprise: NOT_YET,
          'self-hosted': NOT_YET,
        },
      },
      // An add-on rather than a tier feature, because each connection costs us
      // $125 a month at WorkOS whether it is used or not. Self-hosting brings
      // its own identity provider and owes us nothing for it.
      {
        label: 'SAML single sign-on',
        hint: 'For a provider that speaks SAML rather than OIDC. Charged per connection, because it costs us per connection.',
        values: {
          free: false,
          pro: false,
          team: ADDON_NOT_YET,
          enterprise: NOT_YET,
          'self-hosted': NOT_YET,
        },
      },
      {
        label: 'Directory sync (SCIM)',
        hint: 'Members added and removed automatically by your directory.',
        values: {
          free: false,
          pro: false,
          team: false,
          // A bare chip, not `ADDON_NOT_YET`: SCIM is *included* at Enterprise.
          // `pricing-plan.md` §3 marks it `✅ included` in this column and §8.4
          // explains why — the $1,500 floor absorbs the two WorkOS connections
          // at 17 per cent of revenue. This cell said `Add-on` for a while and
          // the whole site was changed to agree with it, which billed Enterprise
          // customers $249 for something the tier covers. The cell was wrong,
          // not the band.
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
        hint: 'Inject secrets into a process as environment variables, without ever writing a file.',
        values: EVERYWHERE,
      },
      {
        label: 'Encrypted offline cache',
        hint: 'The last fetch is kept sealed on disk, so a network blip does not stop a build.',
        values: EVERYWHERE,
      },
      {
        label: 'Service tokens, pinned to one environment',
        hint: 'A leaked CI credential reaches one environment and nothing else.',
        values: EVERYWHERE,
      },
      {
        label: 'The HTTP API',
        hint: 'Everything the dashboard does, available to your own tooling.',
        values: EVERYWHERE,
      },
      {
        label: 'GitHub Action, Docker image and install script',
        hint: 'The ready-made ways to get secrets into a pipeline.',
        values: EVERYWHERE,
      },
      flagRow(
        'Token IP allowlists and lifetime policy',
        'tokenIpAllowlist',
        'Restrict where a token may be used from, and how long it lives.',
      ),
      flagRow(
        'Alerts on reads from new addresses',
        'newIpReadAlerts',
        'Owners and admins get an email the first time an environment is read from somewhere new.',
      ),
      {
        label: 'GitHub OIDC federation, with no static token',
        hint: 'CI authenticates with a short-lived identity instead of a stored secret.',
        // Team, for the same reason as scheduled secrets above:
        // `TEAM_FEATURES.githubOidcFederation` is `true` and the Team card
        // names it. Both came down from Scale when that tier went, and this
        // table was the one surface that did not come down with them.
        values: {
          free: false,
          pro: false,
          team: NOT_YET,
          enterprise: NOT_YET,
          'self-hosted': NOT_YET,
        },
      },
      // A ceiling rather than a flag: a plan carries webhooks when it allows
      // more than none (`null`, Enterprise's, allows any number), and the
      // server refuses the next one at the ceiling with `requireCapacity`.
      {
        label: 'Webhooks on secret change',
        hint: 'Notify your own systems when a value changes.',
        values: {
          free: LIMITS.free.webhooks !== 0,
          pro: LIMITS.pro.webhooks !== 0,
          team: LIMITS.team.webhooks !== 0,
          enterprise: LIMITS.enterprise.webhooks !== 0,
          'self-hosted': true,
        },
      },
    ],
  },
  {
    title: 'Operating it',
    rows: [
      {
        label: 'Audit export',
        hint: 'Download the log as a file, for your own retention.',
        values: {
          free: 'Via the API',
          pro: 'Via the API',
          team: 'Via the API',
          enterprise: 'Custom',
          'self-hosted': 'Via the API',
        },
      },
      {
        label: 'Audit streaming to a SIEM',
        hint: 'Events pushed to your security tooling as they happen.',
        values: {
          free: false,
          pro: false,
          team: false,
          enterprise: NOT_YET,
          'self-hosted': NOT_YET,
        },
      },
      {
        label: 'Where your data sits',
        hint: 'Which infrastructure holds the ciphertext.',
        values: {
          free: "Cloudflare's network",
          pro: "Cloudflare's network",
          team: "Cloudflare's network",
          enterprise: "Cloudflare's network",
          'self-hosted': 'Wherever you host it',
        },
      },
      // Both rows exist because the Enterprise card names both capabilities,
      // and a claim on a card that a reader cannot find in this table is the
      // half-told story the header note is about. Residency is chosen rather
      // than given, so it is a separate question from "Where your data sits"
      // above — that row says where it sits today, this one says whether you
      // get to decide.
      {
        label: 'Choose your data region',
        hint: 'Pin storage to the jurisdiction your contract requires.',
        values: {
          free: false,
          pro: false,
          team: false,
          enterprise: NOT_YET,
          'self-hosted': true,
        },
      },
      {
        label: 'Your own root key',
        hint: 'Hold the key that wraps every other key, with the escrow ceremony to go with it.',
        values: {
          free: false,
          pro: false,
          team: false,
          enterprise: NOT_YET,
          'self-hosted': true,
        },
      },
      {
        label: 'Runs on your own infrastructure',
        hint: 'The whole server, on hardware you control.',
        values: {
          free: false,
          pro: false,
          team: false,
          enterprise: true,
          'self-hosted': true,
        },
      },
      {
        label: 'Support channel',
        hint: 'How you reach us, and how quickly we answer.',
        values: {
          free: 'GitHub issues',
          pro: 'Email',
          team: 'Priority email',
          enterprise: 'Contracted',
          'self-hosted': 'GitHub issues',
        },
      },
      // Identical in all six columns, and that is the point of including it:
      // the licence is not a tier. A reader scanning for the catch finds this.
      {
        label: 'Licence',
        hint: 'The terms the server code is available under.',
        values: {
          free: 'AGPL-3.0 + MIT',
          pro: 'AGPL-3.0 + MIT',
          team: 'AGPL-3.0 + MIT',
          enterprise: 'AGPL-3.0 + MIT',
          'self-hosted': 'AGPL-3.0 + MIT',
        },
      },
      {
        label: 'SLA',
        hint: 'A contractual uptime commitment, with money behind it.',
        values: {
          free: false,
          pro: false,
          team: false,
          enterprise: 'Contractual',
          'self-hosted': 'Yours to set',
        },
      },
    ],
  },
];

/* ── FAQ ───────────────────────────────────────────────────────────────────── */

/**
 * A stable name for each question, so a page that orders or picks among them
 * is keyed by something that survives a reworded question.
 */
export type PricingFaqId =
  | 'members'
  | 'machines'
  | 'pro-or-team'
  | 'single-sign-on'
  | 'past-free'
  | 'billing-and-builds'
  | 'annual-price'
  | 'regional-prices'
  | 'paying'
  | 'self-hosting'
  | 'stopping'
  | 'discounts'
  | 'moving-plans';

/**
 * A question, and — where the honest answer changes once this deployment takes
 * payments — the answer it gives then. Carried on the entry rather than in a
 * table keyed by the question's text, which would stop applying the first time
 * somebody reworded the question.
 *
 * `inApp` is the same idea for the other reader: the answer as the in-app plans
 * page gives it, where the public one describes the public page — its currency
 * sheets, its two price controls — or sends somebody elsewhere to do what the
 * plans page does itself. The plans page shows the FAQ only where it sells, so
 * an `inApp` answer is always a payments-live one. The pricing page never
 * reads it.
 */
export interface PricingFaqItem extends ConditionalFaqItem {
  readonly id: PricingFaqId;
  readonly inApp?: FaqItem | undefined;
}

export const PRICING_FAQ: readonly PricingFaqItem[] = [
  {
    id: 'members',
    question: 'What counts as a member?',
    // The seat floor belongs in this answer specifically: it is the one that
    // walks through seat accounting in detail — invitations, removals, what is
    // and is not a member — so an omission here reads as "there is nothing
    // else to know about seats".
    answer: `Anyone with a seat in your organisation who can sign in and read or write a secret. Service tokens are not members, so a CI pipeline that pulls secrets on every build costs nothing — and neither does a Kubernetes workload or an AI agent. A pending invitation is not counted until it is accepted, and removing someone frees their seat immediately. ${seatFloorSentence()} Nothing stops you running with fewer people than you are billed for.`,
  },
  {
    id: 'machines',
    question: 'Do machines really cost nothing?',
    answer:
      'Yes, on every plan including Free, and we will put it in writing. Only humans are billed. The reason is not generosity: a secret read runs on Cloudflare’s edge and makes no external network call, so a service token costs us a fraction of a cent. Billing per identity would also punish the one habit a secret manager exists to encourage — a separate, narrowly scoped token per workload rather than one shared credential in ten places.',
  },
  {
    id: 'pro-or-team',
    question: 'What is the difference between Pro and Team?',
    answer:
      'Who can read production. On Pro every member sees every environment, which is fine while everyone on the team is trusted with everything. Team adds roles and per-environment grants, so a contractor can hold staging and not production. That is the whole gate, and it is why Pro has no member limit — most teams cross it because somebody joins who should not see prod, not because they hit a ceiling we invented.',
  },
  {
    id: 'single-sign-on',
    question: 'Is single sign-on an extra?',
    // Written in the future tense on purpose. Nothing here is built: the Team
    // card chips OIDC `Not yet` and the matrix row says the same in every
    // column, so the present tense this answer used to carry ("is included
    // from Team", "covers Google Workspace, Microsoft Entra ID, Okta…") was
    // the page promising a working integration with five named vendors. It
    // matters more here than in ordinary copy because `faqSchema(FAQ)`
    // republishes every answer as `FAQPage` structured data — so an answer
    // nobody reads back is still an answer Google indexes and quotes.
    answer:
      'It will not be. OIDC single sign-on is not built yet, and when it lands it is included from Team at no extra cost rather than priced separately. SAML is the exception: each SAML connection is provisioned and supported individually, so it will be a $199 per connection per month add-on from Team, and Enterprise plans include it. Directory sync is included with Enterprise and is not sold below it. None of this is available today, on any plan. Self-hosted deployments bring their own identity provider and pay nothing for any of it.',
  },
  {
    id: 'past-free',
    question: 'What happens when I exceed the free tier?',
    // The ceilings are named rather than counted past. The prose used to say
    // "a sixth project" and "a fourth environment", which are the free limits
    // plus one written as ordinals — correct only until a limit moves, and
    // wrong in a way no test would catch, because the cards would still be
    // right. Stating the limit rather than the first value above it lets the
    // sentence read from `LIMITS` like everything else on the page.
    answer: `Nothing breaks and nothing is deleted. Free covers ${LIMITS.free.organizations} organisation, ${LIMITS.free.projects} projects, ${LIMITS.free.environmentsPerProject} environments in each of them and ${LIMITS.free.seats} members, and the limits apply now: the next one of any of those past the limit is refused, with the plan that allows more named. Everything already stored keeps working, stays editable and the CLI keeps running. Going over the included fetch allowance is never blocked.`,
    // Both answers say the ceilings apply from the day they are published —
    // the owner's decision (docs/operations/billing.md §6) — and that only
    // the next creation past one is refused. The live one adds what fetches
    // past the allowance cost, which is something only on a paid plan: Free
    // has no subscription to bill them to.
    whenPaymentsLive: {
      question: 'What happens when I exceed the free tier?',
      answer: `Nothing breaks and nothing is deleted. Free covers ${LIMITS.free.organizations} organisation, ${LIMITS.free.projects} projects, ${LIMITS.free.environmentsPerProject} environments in each of them and ${LIMITS.free.seats} members, and the limits apply now: the next one of any of those past the limit is refused, with the plan that allows more named, and an owner can move up from the billing page. Everything already stored keeps working, stays editable and the CLI keeps running. Going over the included fetch allowance is never blocked: on Free it costs nothing, and on a paid plan the fetches past it are billed at the overage rate.`,
    },
  },
  {
    id: 'billing-and-builds',
    question: 'Can a billing problem break my build?',
    answer:
      'No, and this is the one commitment on this page we would rather be held to than any other. A declined card, a cancelled plan, an expired subscription or a fetch allowance ten times overspent all leave xecret run working exactly as before. Access is degraded in the dashboard and we send an email; the data path is never touched. A secret manager that can stop a deploy over an invoice is worse than the .env file it replaced.',
  },
  {
    id: 'annual-price',
    question: 'Is there an annual price?',
    answer:
      'Yes, and it is what the page opens on. In US dollars, billed yearly, Pro is $5 a member a month and Team is $12 — charged as $60 and $144 a member a year, a third to two fifths below the monthly rate. The other four sheets carry their own figures; the cards above show whichever one you are reading. The exact saving differs by plan as well as by currency, because each sheet is a set of deliberate prices rather than one number converted: on the euro sheet it is 33 per cent on Pro and 38 on Team, and on the rupee sheet 40 on Pro and 37 on Team. That is why the chip beside the toggle says "up to" — it carries the better of the two figures for whichever sheet you are reading, so it is an upper bound rather than a promise for every card. The controls above the plans and above the comparison table switch every price on the page and stay in step with each other. Monthly stays available on both, and neither is billed at all during pre-alpha.',
    whenPaymentsLive: {
      question: 'Is there an annual price?',
      answer:
        'Yes, and it is what the page opens on. In US dollars, billed yearly, Pro is $5 a member a month and Team is $12 — charged as $60 and $144 a member a year, a third to two fifths below the monthly rate. The other four sheets carry their own figures; the cards above show whichever one you are reading. The exact saving differs by plan as well as by currency, because each sheet is a set of deliberate prices rather than one number converted: on the euro sheet it is 33 per cent on Pro and 38 on Team, and on the rupee sheet 40 on Pro and 37 on Team. That is why the chip beside the toggle says "up to" — it carries the better of the two figures for whichever sheet you are reading, so it is an upper bound rather than a promise for every card. The controls above the plans and above the comparison table switch every price on the page and stay in step with each other. Monthly stays available on both.',
    },
    // The plans page has one sheet, one toggle and no currency to switch, so
    // the public answer's tour of the sheets and its two controls describes a
    // page the reader is not on. The figures are the same ones, and
    // `upgrade-plans.test.ts` holds them to the dollar sheet.
    inApp: {
      question: 'Is there an annual price?',
      answer:
        'Yes, and it is what this page opens on. Billed yearly, Pro is $5 a member a month and Team is $12 — charged as $60 and $144 a member a year, against $8 and $19 month to month. The toggle above the plans switches every price here between the two, and monthly stays available on both. The figures here are in US dollars; checkout shows the price in your billing currency before you pay.',
    },
  },
  {
    id: 'regional-prices',
    question: 'Why is it cheaper in India?',
    answer:
      'Because a price that is reasonable in San Francisco is not reasonable in Bengaluru, and pretending otherwise just means we do not sell there. Pro and Team are priced separately in rupees, yen and Australian dollars rather than converted. The rate follows your billing country and the card that pays, it is locked for twelve months so it cannot be changed by travelling, and it does not apply to Enterprise contracts.',
  },
  {
    id: 'paying',
    question: 'Do you take a card during pre-alpha?',
    answer:
      'No. There is no billing system connected yet, so there is nothing to enter a card into. Every organisation starts on Free, and each plan’s limits and features apply as this page shows them; the ones marked "Coming soon" are not built for anybody. Nothing will start charging without notice, and nobody is converted to a paid plan silently.',
    whenPaymentsLive: {
      question: 'How do I pay?',
      answer:
        'From your organisation’s billing page, as an owner: choose Pro or Team, monthly or yearly, and pay at the checkout of Dodo Payments, our merchant of record. Dodo takes the payment, charges the tax your country requires and issues the invoice; we never see the card number. Members are counted for you and the seat count follows the team as people join and leave. The card, the invoices and cancelling are in Dodo’s customer portal, linked from the same page.',
    },
    // Asked on the page that has the checkout on it, so the answer starts
    // there rather than sending the reader to another page to begin.
    inApp: {
      question: 'How do I pay?',
      answer:
        'From this page, as an owner of the organisation: choose Pro or Team, monthly or yearly, and pay at the checkout of Dodo Payments, our merchant of record. Dodo takes the payment, charges the tax your country requires and issues the invoice; we never see the card number. Members are counted for you and the seat count follows the team as people join and leave. The card, the invoices and cancelling are in Dodo’s customer portal, linked from the billing page.',
    },
  },
  {
    id: 'self-hosting',
    question: 'Is self-hosting really free and unlimited?',
    answer:
      'Yes. The server is AGPL-3.0 and the CLI is MIT, so you can run the whole thing on your own infrastructure. No feature is held back for a paid tier and there is no licence key to buy — single sign-on included, once it exists; it is not built for anybody yet. What an Enterprise self-hosting licence buys is a commercial, non-AGPL licence, priority security notification, help with the root-key escrow ceremony and an SLA. None of that is a feature we removed from the code.',
  },
  {
    id: 'stopping',
    question: 'What happens to my data if I stop paying?',
    answer:
      'Your organisation drops to the Free plan. Nothing is deleted: every secret is still readable, still exportable and still injectable by the CLI. If you are over the free limits, new members, projects and environments are blocked until you are back inside them or you export and self-host. We will not hold a credential hostage over a billing dispute.',
  },
  {
    id: 'discounts',
    question: 'Do you offer a discount for open source or non-profits?',
    answer:
      'Yes, and there is no automated flow for it — open an issue on GitHub or email us with a link to the project and we will sort it by hand. Public open-source projects, registered non-profits and student teams are the cases we intend to approve. Because a person reads every request, ask before you pay rather than after.',
  },
  {
    id: 'moving-plans',
    question: 'Can I move between plans?',
    answer:
      'Yes, in both directions and at any time. Moving up takes effect immediately and is prorated for the rest of the period; moving down takes effect at the end of the period you have already paid for, and nothing is deleted when it does. None of this is live yet, because no plan is billed yet.',
    whenPaymentsLive: {
      question: 'Can I move between plans?',
      answer:
        'Yes, in both directions and at any time, from the billing page. Moving up takes effect immediately and is prorated for the rest of the period; moving down takes effect at the end of the period you have already paid for, and nothing is deleted when it does.',
    },
  },
];

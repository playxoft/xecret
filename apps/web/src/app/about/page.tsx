import type { Metadata } from 'next';
import Link from 'next/link';

import type { FaqItem } from '@/components/marketing';
import {
  CtaBand,
  Faq,
  JsonLd,
  PageHero,
  PublicPage,
  QUIET_LINK,
  Reveal,
  RevealGroup,
  Section,
  SectionHeading,
  faqSchema,
  graph,
} from '@/components/marketing';
import { Button } from '@/components/ui/button';
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  BookIcon,
  BoxIcon,
  CopyIcon,
  EyeIcon,
  FileTextIcon,
  GitHubIcon,
  LayersIcon,
  TerminalIcon,
} from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import {
  absoluteUrl,
  breadcrumbSchema,
  PUBLISHER,
  REPO_URL,
  SITE_KEYWORDS,
  SITE_NAME,
} from '@/lib/site';

/**
 * /about — the position, not the company.
 *
 * A pre-alpha product from a small company has nothing to put in the slots an
 * about page usually reserves: no logo wall, no funding round, no team
 * photographs, no headcount worth quoting. So this page does not try to fill
 * them. It argues a position, states six commitments alongside what each one
 * costs us, and then shows a board of what is genuinely built.
 *
 * Every claim here is checkable against the repository, the licence files or
 * the pricing page. That constraint is the whole design: an about page is
 * where a company is most tempted to round up, and on a secrets product one
 * rounded-up claim ends the relationship the moment a reader checks it.
 *
 * The candour is not modesty either. "We can technically decrypt your secrets"
 * is a stronger sentence than any certification we could claim, because it is
 * the sentence a competitor's about page will not print.
 *
 * ── One layout rule ────────────────────────────────────────────────────────
 * Every section here is either centred or genuinely two-up: a heading with a
 * column of prose beside half a screen of nothing is the arrangement that made
 * this page read as a draft. Where the argument has two sides — the two camps,
 * a promise and its price — the layout has two sides too, and the pairing is
 * visible before a word of it is read.
 */

const TITLE = 'About: open-source secret management from Playxoft';
const DESCRIPTION =
  'xecret is open-source secret management from Playxoft — an AGPL-3.0 server, an MIT CLI, and a trust model we state plainly. What is built, what is not.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    'open source secret management',
    'about xecret',
    'Playxoft',
    'AGPL secrets manager',
    ...SITE_KEYWORDS,
  ],
  alternates: { canonical: absoluteUrl('/about') },
  openGraph: {
    type: 'website',
    url: absoluteUrl('/about'),
    siteName: SITE_NAME,
    title: `${TITLE} · ${SITE_NAME}`,
    description: DESCRIPTION,
  },
};

/* ── The two camps ──────────────────────────────────────────────────────────
   The argument the page opens with, laid out as the comparison it always was.
   It ran as four paragraphs of prose against an empty right half; every claim
   below was a sentence in that prose, re-laid out rather than re-argued.

   Both panels answer the same two questions in the same order, because a
   comparison whose halves answer different questions is not a comparison — it
   is two descriptions printed next to each other. The labels are repeated in
   each panel rather than being pulled out into a shared header row, since a
   header row stops meaning anything the moment the panels stack on a phone. */
const CAMPS = [
  {
    icon: LayersIcon,
    eyebrow: 'Camp one',
    title: 'Cloud KMS and IAM',
    summary:
      'Correct, thorough and shaped like infrastructure. Nothing about it is wrong; it is arranged for the person who owns the cloud account rather than for the person who needs one value.',
    rows: [
      { label: 'Time to a working database URL', value: 'An afternoon.' },
      {
        label: 'What it costs you',
        value: 'An IAM policy and a resource identifier, written before anybody is unblocked.',
      },
    ],
  },
  {
    // A copy, not a document: the failure mode of this camp is that the file
    // exists in as many places as it has been pasted into.
    icon: CopyIcon,
    eyebrow: 'Camp two',
    title: 'A .env file in a Slack thread',
    summary:
      'It works in about four seconds, and that is the entire reason it wins. Most teams live here.',
    rows: [
      { label: 'Time to a working database URL', value: 'About four seconds.' },
      {
        label: 'What it costs you',
        value: 'A production key in a direct message, and no record of who has read it.',
      },
    ],
  },
] as const;

/* ── What we believe ────────────────────────────────────────────────────────
   Each entry is a commitment that can be checked and therefore broken, paired
   with the thing it costs us. A principle with no cost attached is a slogan:
   nobody can tell whether we are keeping it, so nobody has any reason to care
   that we said it. `cost` is the load-bearing field here, not `body`. */
const PRINCIPLES = [
  {
    icon: EyeIcon,
    title: 'We describe the trust model as it is',
    body: 'xecret decrypts on the server. Every environment has its own data key, encrypted under a root key we hold, and every decryption lands in an append-only log. So we can technically read your secrets, and we say that before you migrate rather than after.',
    cost: 'The vaguer sentence sells better. "Zero-knowledge" converts; "we hold a root key" does not. We will not print the first one, because it is not true of us.',
  },
  {
    icon: GitHubIcon,
    title: 'The source is readable before you trust it',
    body: 'The server is AGPL-3.0 and the CLI is MIT. The cryptography you are relying on, the schema your secrets sit in and the handler that decrypts them are all in one public repository, next to the threat model.',
    cost: 'An MIT CLI can be shipped inside a competing product, and an AGPL server can be read by anyone deciding to build one. That is the trade for a binary your legal team can clear in an afternoon.',
  },
  {
    icon: BoxIcon,
    title: 'Self-hosting is a path, not a punishment',
    body: 'The self-hosted server is the same server, with no feature held back and no licence key gating a build you compiled yourself. The guide states the real dependency list, including the parts that are friction.',
    cost: 'Every self-hosted install is a team we never bill. We would rather have the install and the scrutiny that comes with it.',
  },
  {
    icon: AlertTriangleIcon,
    title: 'Colour means status and nothing else',
    body: 'Production is marked with a reserved colour, an uppercase label and hazard hatching, all three at once, so the marking survives colour blindness, a greyscale print-out and a failing monitor. Nothing else in the product is allowed to borrow that colour.',
    cost: 'It rules out most of the tricks a marketing site uses to look lively — no gradient headings, no colour-coded feature cards, no accent that means "click me". A mislabelled production environment costs an outage; a plain-looking page costs nothing.',
  },
  {
    icon: BookIcon,
    title: 'Documentation is written for the 2am reader',
    body: 'The person opening our docs is usually mid-incident, on a phone, looking for one command. So pages lead with the command and explain afterwards, and the failure modes are written down beside the happy path.',
    cost: 'Documentation aimed at somebody who is already in trouble is longer, blunter and far less quotable than documentation aimed at somebody still evaluating us.',
  },
  {
    icon: FileTextIcon,
    title: 'No dark patterns in the billing',
    body: 'Prices are on the pricing page in numbers. There is no trial that quietly becomes a subscription, no card taken for a free tier, and cancelling is a button rather than a conversation with support.',
    cost: 'The quiet auto-conversion is the single most effective growth mechanism in this category, and we have given it up.',
  },
] as const;

/* ── Where the product is ───────────────────────────────────────────────────
   Three states, no dates. A dated roadmap from a pre-alpha team is a list of
   apologies scheduled in advance; "shipped / in progress / next" is a claim we
   can keep, and every shipped row below is something a reader can go and use
   within a minute of signing up. */
const MILESTONE_STATES = {
  // Monochrome on purpose. Status hue in this product means what an
  // environment is doing, and a roadmap row is not an environment — so the
  // three states are told apart by which column they stand in and by the chip
  // above it. Nothing here depends on colour to be read.
  //
  // `column` and `list` are layout, held beside the labels deliberately: six
  // of the ten rows are shipped, and three equal columns would leave two of
  // them two-thirds empty — a board with a hole in it rather than a board. The
  // shipped column is therefore given twice the width and lays its own cards
  // out two across, which brings all three columns to roughly one height while
  // every card on the board stays the same size.
  shipped: {
    label: 'Shipped',
    gloss: 'In the product today.',
    chip: 'border-accent-line bg-accent-tint text-accent-text',
    column: 'lg:col-span-2',
    list: 'sm:grid-cols-2',
  },
  progress: {
    label: 'In progress',
    gloss: 'Being written now.',
    chip: 'border-line bg-canvas-inset text-fg-muted',
    column: '',
    list: 'sm:grid-cols-2 lg:grid-cols-1',
  },
  next: {
    label: 'Next',
    gloss: 'Named, and not built.',
    chip: 'border-line-subtle bg-canvas text-fg-subtle',
    column: '',
    list: 'sm:grid-cols-2 lg:grid-cols-1',
  },
} as const;

/** The board reads left to right in the order work reaches a reader. */
const MILESTONE_COLUMNS = ['shipped', 'progress', 'next'] as const;

const MILESTONE_CHIP =
  'inline-flex items-center rounded-full border px-2 py-0.5 text-[0.6875rem] font-semibold ' +
  'tracking-[0.12em] uppercase';

const MILESTONES = [
  {
    state: 'shipped',
    title: 'Organisations, projects and environments',
    body: 'The hierarchy the dashboard is built on. Each environment is given its own data key at the moment it is created, and production carries a reserved colour, an uppercase label and hazard hatching so it cannot be confused with staging at a glance.',
  },
  {
    state: 'shipped',
    title: 'Members, invites and service tokens',
    body: 'Bring a teammate in by email address; issue a token for a CI job. Both are revocable from the dashboard, and both leave a trail behind them.',
  },
  {
    state: 'shipped',
    title: 'An append-only audit log',
    body: 'Every decryption is written down, including the ones the server performs on your behalf. This is the feature the rest of the product is arranged around — encryption is the easy half.',
  },
  {
    state: 'shipped',
    title: 'The CLI, with an offline cache',
    body: 'xecret login, then xecret run -- npm run dev. The cache means a dropped connection does not stop your dev server. Framework guides are written for Next.js, Node, React and Vite, Go, Docker and CI.',
  },
  {
    state: 'shipped',
    title: 'Browser-side .env import',
    body: 'The file you already have is parsed in your tab rather than uploaded, so a pasted blob of production credentials never becomes a request body.',
  },
  {
    state: 'shipped',
    title: 'A self-hosting guide that states the real cost',
    body: 'Cloudflare Workers, a PostgreSQL database and your own Firebase project, written out with the parts that are friction left in. An open-source secrets manager that hides its operational cost is not being honest about the one thing it sells.',
  },
  {
    state: 'progress',
    title: 'Documentation written in the open',
    body: 'The docs tree lives in the repository and ships with the application, so a guide and the code it describes move in the same commit. Pages land as they are written rather than in a launch bundle.',
  },
  {
    state: 'progress',
    title: 'Hardening before the label changes',
    body: 'Key rotation and the recovery ceremony rehearsed rather than merely documented, and the threat model kept level with the code instead of a release behind it. This work is what decides when pre-alpha ends.',
  },
  {
    state: 'next',
    title: 'SSO and provisioning',
    // Roles used to be listed here as unbuilt. They are built — four of them,
    // with per-project and per-environment grants and an effective-access
    // preview, documented in guides/teams.md — so saying otherwise understated
    // the product and contradicted this page's own FAQ answer two screens
    // down. What is genuinely absent is SAML and SCIM, and the pricing matrix
    // now says "Not yet" in those rows rather than ticking them.
    body: 'SAML single sign-on is named on the pricing page as part of Business, and SCIM provisioning as part of Enterprise. Neither is built, and the comparison table says so in the row rather than in a footnote under it. Roles and per-environment access are built already — those are a plan boundary, not a promise.',
  },
  {
    state: 'next',
    title: 'Billing, switched on',
    body: 'Every paid feature is currently on for everybody and no card is collected anywhere. When that changes we will say so before it changes, and nobody will find out from an invoice.',
  },
] as const;

/* ── The stack ──────────────────────────────────────────────────────────────
   Stated here rather than left to be discovered during setup, because anyone
   self-hosting inherits all four of these decisions and the trade-off in each
   one. A stack list without its trade-offs is a badge wall. */
const STACK = [
  {
    role: 'Runtime',
    name: 'Cloudflare Workers',
    body: 'The API runs at the edge, so the CLI is not waiting on a round trip to a single region before your dev server starts. The trade-off is a runtime that is not Node: no native modules, a hard CPU budget per request, and a shorter list of libraries that work.',
  },
  {
    role: 'Data',
    name: 'PostgreSQL — Neon, or vanilla',
    body: 'Boring on purpose. Neon backs the hosted service and a plain PostgreSQL server backs a self-hosted one, on the same schema either way. Self-hosting is not a second implementation that quietly falls behind the first.',
  },
  {
    role: 'Identity',
    name: 'Firebase for identity',
    body: 'Sign-in, password reset and email verification are solved problems with a long tail of abuse cases, and we would rather trust an implementation that has already met them all. The cost is honest: a self-hosted install needs its own Firebase project.',
  },
  {
    role: 'Client',
    name: 'A Go CLI',
    body: 'One static binary and no runtime to install, which is what lets it drop into a scratch Docker image or a CI runner without dragging a Node installation in behind it. MIT, so the thing inside your pipeline carries a licence nobody has to argue about.',
  },
] as const;

/* ── FAQ ────────────────────────────────────────────────────────────────────
   Six questions a sceptical engineer actually asks about a company before
   trusting it with credentials — including the two most companies leave off
   the page, which are "can you read them" and "are you ready yet". Answers are
   plain text because the same strings are published as the page's FAQPage. */
const FAQ: readonly FaqItem[] = [
  {
    question: 'Who is behind xecret?',
    answer:
      'Playxoft, a small software company. There is no funding announcement to point at and no customer logos to show you. What there is, is a public repository, two real licences, a written threat model and a self-hosting guide — all of which you can read before you trust any of it.',
  },
  {
    question: 'Is xecret really open source, or is it open core?',
    answer:
      'Really open source. The server is AGPL-3.0 and the CLI is MIT, and a self-hosted install gets the whole server with no feature held back — no enterprise-only build, no licence key gating a capability inside a binary you compiled yourself. What we sell is the hosted service and, for organisations that want one, a support contract.',
  },
  {
    question: 'What happens to my secrets if Playxoft disappears?',
    answer:
      'The software outlives the company. The server is AGPL-3.0 and self-hosting is a documented path — Cloudflare Workers, a PostgreSQL database and your own Firebase project — so an instance can be stood up without us. Your values also come back out as the .env file they went in as, which means the exit path is a file format you already know how to use.',
  },
  {
    question: 'Can you read my secrets?',
    answer:
      'Technically, yes. xecret uses server-side envelope encryption: every environment has its own data key, itself encrypted under a root key we hold, and values are decrypted inside a single request handler with every decryption written to an append-only audit log. It is the same model Doppler uses, and it is what makes team sharing, CI tokens and browser-side .env import work without a key-exchange ceremony. If you need a provider that cannot read your secrets even in principle, you need a zero-knowledge product, and we would rather you knew that now than after migrating.',
  },
  {
    question: 'How do you make money?',
    answer:
      'From the hosted service. Free is $0 forever for 1 organisation, 5 projects, 3 members, 3 environments per project and 7 days of audit history. Team will be $9 per member per month, or $7 billed yearly, for unlimited organisations, projects, members and environments, 12 months of history, roles and per-environment access. Business will be $19 per member per month for three years of history and priority support, plus SAML single sign-on, which is not built yet. Enterprise is custom, for SCIM, custom audit retention and a self-hosting support contract. Self-hosting is free, always. While xecret is in pre-alpha every paid feature is on for everybody and no card is collected.',
  },
  {
    question: 'Is xecret production-ready?',
    answer:
      'No. It is pre-alpha. The API can still change under you, a migration can still be disruptive, and there is no uptime commitment to point at. Use it on side projects and internal tools, tell us what breaks, and wait for the label to change before you put your production database credentials behind it.',
  },
];

/** The small uppercase label that names a half of a pairing. */
const PAIR_LABEL = 'text-fg-subtle text-[0.6875rem] font-semibold tracking-[0.14em] uppercase';

export default function AboutPage() {
  return (
    <PublicPage current="about">
      <JsonLd
        data={graph(
          {
            '@type': 'AboutPage',
            '@id': absoluteUrl('/about#page'),
            url: absoluteUrl('/about'),
            name: `${TITLE} · ${SITE_NAME}`,
            description: DESCRIPTION,
            inLanguage: 'en',
            isPartOf: { '@id': absoluteUrl('/#website') },
            // Referenced rather than restated. One organisation that forty
            // pages agree on is what assembles a knowledge panel; forty
            // organisations that happen to share a name is what does not.
            about: { '@id': absoluteUrl('/#organization') },
            publisher: { '@id': absoluteUrl('/#organization') },
          },
          faqSchema(FAQ),
          breadcrumbSchema([{ name: 'About', path: '/about' }]),
        )}
      />

      <PageHero
        height="screen"
        eyebrow="About xecret"
        title="We built the secret manager we wanted to be able to audit."
        description="xecret is open-source secret management from Playxoft, and it is pre-alpha. The server is AGPL-3.0, the CLI is MIT, and the trust model is a document you can read before you trust a line of it."
      >
        {/* Two secondary actions and no primary, deliberately. This page's job
            is to be believed rather than to convert; the ask is at the foot,
            after the reader has seen what we are prepared to admit. */}
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button asChild variant="secondary" size="lg" className="rounded-full">
            <Link href="/features">
              What xecret does
              <ArrowRightIcon className="size-4" />
            </Link>
          </Button>
          <Button asChild variant="secondary" size="lg" className="rounded-full">
            <a href={REPO_URL} target="_blank" rel="noreferrer noopener">
              <GitHubIcon className="size-4" />
              Read the source
            </a>
          </Button>
        </div>
      </PageHero>

      {/* ── Why we built it ───────────────────────────────────────────────
          Two camps side by side, then our position underneath them rather
          than asserted between them. Underneath, because a middle claimed in
          the gap between two columns is a diagram of a compromise; underneath,
          the reader has already read both bills before we present ours. */}
      <Section id="why" aria-labelledby="why-heading">
        <SectionHeading
          align="center"
          headingId="why-heading"
          eyebrow="Why we built it"
          title="Secret management split into two camps, and most teams live in the worse one."
          description="Not because they do not know better — every engineer who has pasted a production key into a direct message knew exactly what they were doing as they did it — but because the first camp costs more than the problem appears to, right up until the week it does not."
        />

        <RevealGroup className="mt-12 grid gap-4 md:grid-cols-2">
          {CAMPS.map((camp) => {
            const Icon = camp.icon;

            return (
              // ── Why the card is one level in ──
              // `.x-reveal-group > *` declares its own `transition` on every
              // direct child, and that rule is unlayered, so it beats a
              // `transition-colors` utility set on the same element — the
              // hover would jump while the entrance animated. This wrapper
              // exists only to be animated; everything visible is inside it.
              // The same split is used by the other two card grids below.
              <div key={camp.title}>
                <div className="border-line bg-surface hover:border-line-strong flex h-full flex-col rounded-xl border p-6 transition-colors sm:p-7">
                  <div className="flex items-center gap-3">
                    <Icon className="text-fg-subtle size-5 shrink-0" />
                    <p className={PAIR_LABEL}>{camp.eyebrow}</p>
                  </div>
                  <h3 className="text-fg mt-4 text-lg font-semibold tracking-[-0.01em] text-balance">
                    {camp.title}
                  </h3>
                  <p className="text-fg-muted mt-3 text-sm leading-7">{camp.summary}</p>
                  {/* `mt-auto` so both panels put their axis on the same line
                      however long the characterisation above it runs. Two rows
                      that do not align are two rows nobody reads across. */}
                  <dl className="divide-line-subtle border-line-subtle mt-auto divide-y border-t pt-5">
                    {camp.rows.map((row) => (
                      <div key={row.label} className="py-3 first:pt-0 last:pb-0">
                        <dt className="text-fg-subtle text-[0.6875rem] font-semibold tracking-[0.12em] uppercase">
                          {row.label}
                        </dt>
                        <dd className="text-fg mt-1.5 text-sm leading-6 font-medium">
                          {row.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              </div>
            );
          })}
        </RevealGroup>

        <Reveal delay={140} className="mx-auto mt-4 max-w-4xl">
          {/* Tinted rather than white, so the third panel reads as a different
              kind of thing from the two above it rather than as a third camp. */}
          {/* The extra top padding is the chip's: it straddles the top border,
              and a lead line that starts level with it reads as a caption. */}
          <div className="border-line bg-canvas-inset/70 relative rounded-2xl border p-6 pt-10 sm:p-9 sm:pt-11">
            <span className="border-line bg-canvas text-fg-subtle absolute -top-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border px-3 py-1 text-[0.6875rem] font-semibold tracking-[0.14em] whitespace-nowrap uppercase">
              <TerminalIcon className="size-3.5" />
              The middle
            </span>

            <p className="text-fg mx-auto max-w-xl text-center text-lg leading-8 font-medium text-balance sm:text-xl">
              A tool only wins if it is easier than the habit it is replacing.
            </p>

            <div className="mt-8 grid gap-8 md:grid-cols-2 md:gap-0">
              <div className="md:pr-9">
                <p className={PAIR_LABEL}>What xecret is</p>
                <p className="text-fg-muted mt-3 text-sm leading-7">
                  An attempt at the middle, shaped like a developer tool: one command to log in, one
                  command to run your application, an offline cache so a flaky connection does not
                  stop your dev server, and an importer that takes the{' '}
                  <code className="text-fg-muted font-mono text-[0.8125rem]">.env</code> file you
                  already have. And it keeps the one thing that file can never keep — an append-only
                  record of who read which value, in which environment, and when.
                </p>
              </div>
              <div className="border-line-subtle border-t pt-8 md:border-t-0 md:border-l md:pt-0 md:pl-9">
                <p className={PAIR_LABEL}>And what the middle costs</p>
                <p className="text-fg-muted mt-3 text-sm leading-7">
                  It is built by{' '}
                  <a
                    href={PUBLISHER.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className={QUIET_LINK}
                  >
                    {PUBLISHER.name}
                  </a>
                  , a small software company, and the middle ground has a price. xecret decrypts on
                  the server, which means we can technically read your secrets. That is the trade
                  that makes team sharing, CI tokens and browser-side import work without a
                  key-exchange ceremony, and it is the first thing we would want to know about a
                  company holding our credentials.
                </p>
              </div>
            </div>

            <div className="mt-8 flex justify-center text-sm">
              <Link href="/docs/security/trust-model" className={QUIET_LINK}>
                What xecret can and cannot see
                <ArrowRightIcon className="size-3.5" />
              </Link>
            </div>
          </div>
        </Reveal>
      </Section>

      {/* ── What we believe ───────────────────────────────────────────────
          The page's centre, and the one section built to be readable without
          being read: every card ends in a tinted band with the same label on
          it, so a reader skimming the grid can see that all six promises carry
          a price before they have read a single one.

          The band is permanent rather than revealed on hover. A hover reveal
          was the tempting version — it is more fun, and it would hide exactly
          the half of this section that makes it worth publishing. Half our
          readers are on a touch screen with no hover at all, and the pairing
          is the argument, not a reward for finding it. Hover is left to do
          what hover is for: confirming which card the pointer is on. */}
      <Section id="beliefs" aria-labelledby="beliefs-heading" tone="inset">
        <SectionHeading
          align="center"
          headingId="beliefs-heading"
          eyebrow="What we believe"
          title="Six commitments, each with the thing it costs us."
          description="A principle you can hold a company to is one that could be broken visibly. These can be, which is why the price of each is printed underneath it."
        />
        <RevealGroup className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {PRINCIPLES.map((principle, index) => {
            const Icon = principle.icon;

            return (
              // Wrapper animated by the group; card inside — see the note on
              // the two-camps grid above.
              <div key={principle.title}>
                <div className="group border-line bg-surface hover:border-line-strong flex h-full flex-col overflow-hidden rounded-xl border transition-colors">
                  <div className="flex flex-1 flex-col p-6">
                    {/* The ledger rule: an ordinal, a hairline drawn across the
                        card, and the icon at the far end. It numbers the six
                        without an ordered list — the order carries no meaning,
                        only the count does. Hidden from assistive technology
                        for the same reason: the heading under it is the
                        content, and "zero one" read aloud is not. */}
                    <div aria-hidden="true" className="flex items-center gap-3">
                      <span className="text-fg-subtle group-hover:text-fg font-mono text-xs font-semibold tabular-nums transition-colors">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <span className="bg-line-subtle group-hover:bg-line-strong h-px flex-1 transition-colors" />
                      <Icon className="text-fg-subtle group-hover:text-fg size-5 shrink-0 transition-colors" />
                    </div>
                    <h3 className="text-fg mt-5 text-[1.0625rem] leading-6 font-semibold tracking-[-0.01em] text-balance">
                      {principle.title}
                    </h3>
                    <p className="text-fg-muted mt-3 text-sm leading-7">{principle.body}</p>
                  </div>

                  {/* The price, on its own ground, at the foot of every card:
                      six identical bands with one label on them is the whole
                      section legible before a word of it is read.

                      `bg-accent-tint` rather than `bg-canvas-inset` — the inset
                      grey and the surface sit one step apart in dark, where
                      this band would all but vanish. The tint is the one quiet
                      neutral that separates from a card in both themes. */}
                  <div className="border-line bg-accent-tint border-t px-6 py-5">
                    <p className={PAIR_LABEL}>What it costs us</p>
                    <p className="text-fg-muted mt-2 text-sm leading-6">{principle.cost}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </RevealGroup>
        <div className="mt-10 flex flex-wrap justify-center gap-x-6 gap-y-3 text-sm">
          <Link href="/docs/self-hosting" className={QUIET_LINK}>
            Run xecret on your own infrastructure
            <ArrowRightIcon className="size-3.5" />
          </Link>
          <Link href="/pricing" className={QUIET_LINK}>
            Prices, and what pre-alpha means for them
            <ArrowRightIcon className="size-3.5" />
          </Link>
        </div>
      </Section>

      {/* ── Where we are ──────────────────────────────────────────────────
          A board, not a rail. The rail this replaced ran ten rows down the
          left of the page with nothing beside them, and it buried the fact the
          section exists to show: six of the ten are already shipped and only
          two are promises. Three columns say that in one glance. */}
      <Section id="status" aria-labelledby="status-heading">
        <SectionHeading
          align="center"
          headingId="status-heading"
          eyebrow="Where we are"
          title="Pre-alpha, and here is exactly what that covers."
          description="Shipped, in progress, next. Nothing on this board is dated, because a date we cannot support is worse than no date at all."
        />

        <RevealGroup className="mt-12 grid gap-10 lg:grid-cols-4 lg:gap-8">
          {MILESTONE_COLUMNS.map((key) => {
            const state = MILESTONE_STATES[key];
            const items = MILESTONES.filter((milestone) => milestone.state === key);

            return (
              <div key={key} className={state.column}>
                <div className="border-line-subtle flex items-center justify-between gap-3 border-b pb-3">
                  <h3>
                    <span className={cn(MILESTONE_CHIP, state.chip)}>{state.label}</span>
                  </h3>
                  {/* The count is a scanning aid, and a bare "6" announced
                      after a heading is noise — the list itself is the count
                      for anyone listening to the page. */}
                  <span
                    aria-hidden="true"
                    className="text-fg-subtle font-mono text-xs tabular-nums"
                  >
                    {items.length}
                  </span>
                </div>
                <p className="text-fg-subtle mt-3 text-xs leading-5">{state.gloss}</p>

                <ul className={cn('mt-5 grid gap-4', state.list)}>
                  {items.map((milestone) => (
                    <li
                      key={milestone.title}
                      className="border-line bg-surface hover:border-line-strong h-full rounded-xl border p-5 transition-colors"
                    >
                      <h4 className="text-fg text-[0.9375rem] leading-6 font-semibold text-balance">
                        {milestone.title}
                      </h4>
                      <p className="text-fg-muted mt-2 text-sm leading-6">{milestone.body}</p>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </RevealGroup>

        <Reveal className="mx-auto mt-12 max-w-2xl">
          <p className="text-fg-muted text-center text-sm leading-7">
            Pre-alpha means the API can still move underneath you and a migration can still be
            disruptive. What changed and why goes up on{' '}
            <Link href="/blog" className={QUIET_LINK}>
              the xecret blog
            </Link>{' '}
            as it happens, rather than being collected into a launch post afterwards.
          </p>
        </Reveal>
      </Section>

      <Section id="stack" aria-labelledby="stack-heading" tone="inset">
        <SectionHeading
          align="center"
          headingId="stack-heading"
          eyebrow="The stack, and why"
          title="Four decisions you inherit if you self-host."
          description="Every one of these has a cost attached. They are stated here rather than discovered halfway through a setup guide."
        />
        <RevealGroup className="mt-12 grid gap-4 sm:grid-cols-2">
          {STACK.map((entry) => (
            // Wrapper animated by the group; card inside — see the note on the
            // two-camps grid above.
            <div key={entry.name}>
              <div className="border-line bg-surface hover:border-line-strong h-full rounded-xl border p-6 transition-colors">
                <div className="flex items-baseline justify-between gap-4">
                  <h3 className="text-fg text-base font-semibold">{entry.name}</h3>
                  {/* One word for the layer each choice sits in, so the four
                      cards read as one stack rather than as four unrelated
                      decisions that happen to be printed together. */}
                  <span className="text-fg-subtle font-mono text-[0.6875rem] tracking-[0.12em] uppercase">
                    {entry.role}
                  </span>
                </div>
                <p className="text-fg-muted mt-2 text-sm leading-7">{entry.body}</p>
              </div>
            </div>
          ))}
        </RevealGroup>
        <div className="mt-10 flex justify-center text-sm">
          <Link href="/docs/self-hosting" className={QUIET_LINK}>
            The self-hosting guide, dependency list and all
            <ArrowRightIcon className="size-3.5" />
          </Link>
        </div>
      </Section>

      <Section id="faq" aria-labelledby="faq-heading">
        <SectionHeading
          align="center"
          headingId="faq-heading"
          eyebrow="Questions"
          title="The questions we would ask a company holding our credentials."
        />
        <Reveal className="mx-auto mt-10 max-w-3xl">
          <Faq items={FAQ} />
          <p className="text-fg-muted mt-6 text-center text-sm leading-7">
            Questions about the CLI, CI, migrating off a{' '}
            <code className="text-fg-muted font-mono text-[0.8125rem]">.env</code> file and the
            plans are answered on the{' '}
            <Link href="/faq" className={QUIET_LINK}>
              full FAQ
            </Link>
            .
          </p>
        </Reveal>
      </Section>

      <CtaBand
        title="Read the source before you trust the product."
        description="The server is AGPL-3.0 and the CLI is MIT, so nothing on this page has to be taken on faith. Clone it, read the threat model, then create a free project and import the .env file you already have."
      />
    </PublicPage>
  );
}

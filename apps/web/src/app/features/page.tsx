import Link from 'next/link';
import type { Metadata } from 'next';
import type { ReactElement, ReactNode } from 'react';

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
import type { FaqItem } from '@/components/marketing';
// Direct module imports rather than the `components/ui` barrel, for the reason
// given in app/layout.tsx: this page is prerendered and public, and the barrel
// drags the dashboard's dependencies onto it.
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  BoxIcon,
  FileTextIcon,
  HistoryIcon,
  KeyIcon,
  LayersIcon,
  LockIcon,
  RefreshIcon,
  ShieldCheckIcon,
  TerminalIcon,
  UsersIcon,
  type IconProps,
} from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import {
  absoluteUrl,
  breadcrumbSchema,
  SITE_KEYWORDS,
  SITE_NAME,
  softwareApplicationSchema,
} from '@/lib/site';

/**
 * `/features` — the long page.
 *
 * Almost nobody arrives here first. They arrive from a search for ".env
 * alternative" already running something, and they are deciding whether to
 * move a production credential into a system they have not read yet. So the
 * page is written to be finished without a sales conversation: every claim is
 * one the reader can check in the documentation in the next tab, the
 * comparison names the single axis where the file they already have is the
 * better answer, and the encryption model is stated as it is rather than as it
 * would sell. A secrets product that oversells its guarantees has already
 * broken the only thing it sells.
 *
 * ── The layout rule every band on this page obeys ──
 * A band is either centred, or it is a genuine two-column with something real
 * on the second side — a terminal, an audit log, a list of environments, the
 * key hierarchy. A heading set left with an empty half beside it is the one
 * arrangement this page does not use. On a page whose entire job is to look
 * finished enough to be trusted with a production credential, half an empty
 * band reads as a section somebody walked away from.
 */

const TITLE = 'Secret management features for developers';
const DESCRIPTION =
  'Environment variables encrypted per environment, CLI injection instead of a .env file, an append-only secrets audit log, CI service tokens and self-hosting.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    'secret management features',
    'environment variable manager',
    '.env alternative',
    'encrypted environment variables',
    'secrets audit log',
    ...SITE_KEYWORDS,
  ],
  alternates: { canonical: absoluteUrl('/features') },
  openGraph: {
    type: 'website',
    url: absoluteUrl('/features'),
    siteName: SITE_NAME,
    title: `${TITLE} · ${SITE_NAME}`,
    description: DESCRIPTION,
  },
};

/**
 * The feature set, as data.
 *
 * The icon travels with the card rather than being picked at the call site.
 * Nine cards assembled by hand is exactly how a grid ends up using one glyph
 * for two unrelated ideas, and the reader who notices that stops trusting the
 * rest of the page.
 *
 * ── Why every card carries an artefact ──
 * `proof` is a real string from the documentation — a command, an audit event
 * name, an environment variable, a line of the key hierarchy. Nine paragraphs
 * of prose is a brochure; nine paragraphs each ending in the exact thing you
 * would type is a specification, and the reader can check any of them in the
 * next tab. `proofKind` names what sort of artefact it is, because
 * `secret.read` and `xecret run` are not the same kind of claim and a shell
 * prompt in front of the first one would be a small lie.
 */
interface Feature {
  readonly icon: (props: IconProps) => ReactElement;
  readonly title: string;
  readonly body: string;
  readonly proofKind: 'Command' | 'Audit events' | 'Environment' | 'Key hierarchy' | 'Access rule';
  readonly proof: string;
}

const FEATURES: readonly Feature[] = [
  {
    icon: KeyIcon,
    title: 'A key for every environment',
    body: "Each environment is created with its own data key, written in the same database transaction as the environment itself — there is no moment where one exists without the other. That key is wrapped under an organisation key, which is wrapped under a root key. Ciphertext copied out of staging cannot be read with production's key.",
    proofKind: 'Key hierarchy',
    proof: 'root → organisation → environment → version',
  },
  {
    icon: TerminalIcon,
    title: 'xecret run, instead of a file on disk',
    body: "xecret run -- npm run dev fetches the environment, injects it into the child process, forwards signals, and exits with the child's exit code. Secrets never touch disk, argv or stdout. Argv is the one people forget: anything passed there is readable by every other process on the machine.",
    proofKind: 'Command',
    proof: 'xecret run -- npm run dev',
  },
  {
    icon: FileTextIcon,
    title: 'Import that parses in your browser',
    body: '.env, JSON, YAML and export KEY=value scripts are parsed client-side, and only the resulting plan is sent — so a pasted blob of production credentials never becomes a request body. The dry run is produced by the same planning code the real import runs, which is why the preview cannot disagree with the outcome.',
    proofKind: 'Command',
    proof: 'xecret import .env --dry-run',
  },
  {
    icon: HistoryIcon,
    title: 'An append-only audit log',
    body: "Every mutation, every decryption and every denial is recorded; a log of what succeeded cannot show an attack in progress. Append-only is enforced by database grants rather than by convention, so the application's own credentials cannot alter it. No record can hold a secret value — the metadata type is a fixed allowlist of field names with no catch-all.",
    proofKind: 'Audit events',
    proof: 'secret.read · secret.revealed · access.denied',
  },
  {
    icon: LockIcon,
    title: 'Service tokens CI can hold',
    body: "A service token is scoped to one organisation, one project and one environment, and it acts as itself rather than as the person who minted it. Two separate columns hold the two kinds of actor, with a database constraint requiring exactly one to be set. Putting somebody's name on a write they did not make is worse than no attribution at all.",
    proofKind: 'Environment',
    proof: 'XECRET_TOKEN=xst_live_…',
  },
  {
    icon: UsersIcon,
    title: 'Roles, and production denied by default',
    body: 'Four roles — viewer, developer, admin, owner — decide what class of action exists for you, and per-project or per-environment grants decide where. Developers and viewers get no production access until somebody who manages members grants it explicitly, and that grant lands in the audit log with a name attached. The safe state is the one that costs nothing to maintain.',
    proofKind: 'Access rule',
    proof: 'developer → production = none',
  },
  {
    icon: RefreshIcon,
    title: 'An offline cache with one rule',
    body: 'The CLI keeps an AES-256-GCM copy of the last environment it fetched, with the key in your OS keychain and the exact scope bound into the ciphertext, so a cache file cannot be renamed from staging to production and decrypted. It answers when the API cannot — DNS failure, timeout, 5xx — and never when the API will not. A 401 is a decision, usually a revocation, and a local file is not allowed to soften it.',
    proofKind: 'Command',
    proof: 'xecret run --offline -- npm run dev',
  },
  {
    icon: AlertTriangleIcon,
    title: 'Production marked three ways',
    body: 'A production environment carries a reserved colour, an uppercase label and diagonal hazard hatching. Three signals rather than one, because the person about to paste a value into the wrong environment may be colour blind, on a monitor with a failing backlight, or reading a greyscale print-out. Nothing else in the interface may use that colour.',
    proofKind: 'Command',
    proof: 'xecret run --environment production -- ./verify.sh',
  },
  {
    icon: BoxIcon,
    title: 'Self-hosting, with the friction stated',
    body: 'The server is AGPL-3.0 and the CLI is MIT, so the binary that ships inside your Docker images carries a licence your legal team has already approved. The self-hosting guide lists the real dependencies, including the Firebase project needed for identity, which is genuine friction and is described that way. No feature is held back from the self-hosted build.',
    proofKind: 'Command',
    proof: 'npx wrangler deploy',
  },
];

/**
 * The three illustrations below are static markup, not the animated CLI demo
 * from the landing page.
 *
 * Two reasons. They are Server Components, so a page with three of them ships
 * no JavaScript beyond the reveal observer; and a second typing terminal, on a
 * page the reader reaches *after* the landing page, would be the same trick
 * performed twice. The data each one draws is real product output — the
 * transcript is the CLI's, the actions are the audit log's own event names —
 * because an illustration that shows something the product does not do is a
 * small lie in the middle of an honest page.
 */
const TERMINAL_LINES = [
  { kind: 'command', text: 'cat .env' },
  { kind: 'output', text: 'DATABASE_URL=postgres://…' },
  { kind: 'output', text: 'STRIPE_SECRET_KEY=sk_live_…' },
  { kind: 'command', text: 'rm .env' },
  { kind: 'command', text: 'xecret run -- npm run dev' },
  { kind: 'child', text: '> storefront@0.4.2 dev' },
  { kind: 'child', text: 'ready — http://localhost:3000' },
] as const;

const AUDIT_ROWS = [
  {
    action: 'secret.read',
    actor: 'deploy-bot',
    kind: 'service token',
    detail: '24 secrets',
    outcome: 'success',
    at: '09:41',
  },
  {
    action: 'secret.revealed',
    actor: 'dev@acme.dev',
    kind: 'session',
    detail: 'STRIPE_SECRET_KEY',
    outcome: 'success',
    at: '09:12',
  },
  {
    action: 'secret.read',
    actor: 'alex@acme.dev',
    kind: 'CLI token',
    detail: 'production',
    outcome: 'denied',
    at: '08:57',
  },
  {
    action: 'environment.created',
    actor: 'sam@acme.dev',
    kind: 'session',
    detail: 'preview-412',
    outcome: 'success',
    at: '08:30',
  },
] as const;

const ENVIRONMENTS = [
  { name: 'development', secrets: 24, developer: 'write', production: false },
  { name: 'staging', secrets: 26, developer: 'write', production: false },
  { name: 'production', secrets: 31, developer: 'none', production: true },
] as const;

/**
 * The key hierarchy, copied from the trust-model document rather than
 * paraphrased.
 *
 * `relation` is the verb the document's own diagram uses between two layers.
 * The last one is `encrypts` and not `wraps` because the bottom of the chain
 * is where a key stops protecting another key and starts protecting a value —
 * a distinction the diagram makes and a marketing page has no business
 * flattening.
 */
const KEY_HIERARCHY = [
  {
    layer: 'Root key',
    relation: null,
    where: 'Cloudflare Secrets Store, bound to the Worker. Never in the database.',
  },
  {
    layer: 'Organisation key',
    relation: 'wraps',
    where: 'In the database, encrypted under the root key.',
  },
  {
    layer: 'Environment key',
    relation: 'wraps',
    where: "In the database, encrypted under its organisation's key.",
  },
  {
    layer: 'Secret version',
    relation: 'encrypts',
    where: "In the database, encrypted under its environment's key.",
  },
] as const;

const COMPARISON = [
  {
    axis: 'Where the value lives',
    dotenv:
      'On every laptop that has ever run the application, in a chat thread, and in whichever CI provider was configured last. Usually all three, usually disagreeing.',
    xecret:
      'Once, encrypted under a key belonging to that environment alone, fetched by the CLI at the moment a process starts.',
  },
  {
    axis: 'Onboarding somebody',
    dotenv:
      'Somebody sends the file. Nobody is certain it is current, and there is now one more copy of production in a chat history that will outlive the job.',
    xecret:
      'xecret login, then xecret run. They get the environments their role and grants allow, and nothing else.',
  },
  {
    axis: 'Rotating a leaked key',
    dotenv:
      'Change it, then find every laptop, CI job, Dockerfile and deploy script holding a copy. You will miss one.',
    xecret:
      'Change it once. The next run of every process picks up the new value, and the old one becomes a previous version in the history.',
  },
  {
    axis: 'Knowing who read it',
    dotenv: 'You cannot. A file that has been copied leaves no record of the copy.',
    xecret:
      'One row per read, with the actor, the outcome and a count — including the reads that were refused.',
  },
  {
    axis: 'Somebody leaves',
    dotenv: 'Rotate everything, on the assumption they kept a copy. You are right to assume it.',
    xecret:
      'Remove them and every device they own stops working at once. Then rotate what actually matters, rather than all of it.',
  },
  {
    axis: 'Protecting production',
    dotenv: 'Four characters in a filename separate .env.production from .env.',
    xecret:
      'Production is deny-by-default for developers and viewers, and marked three ways in the interface so the marking survives colour blindness.',
  },
  {
    axis: 'What the provider can read',
    dotenv:
      'Nothing. The file never leaves machines you control. This is the one row where the file you already have wins, and it wins outright.',
    xecret:
      'xecret can technically decrypt your secrets, and writes an audit row every time it does. That trade is what pays for the six rows above.',
  },
] as const;

const FAQ: readonly FaqItem[] = [
  {
    question: 'Is xecret zero-knowledge?',
    answer:
      'No, and we will not describe it that way. xecret uses server-side envelope encryption: every environment has its own data key, that key is encrypted under a root key we hold, and values are decrypted inside a single request handler with every decryption written to an append-only audit log. So xecret can technically decrypt your secrets. It is the same model Doppler uses, and it is what makes team sharing, CI tokens and browser-side .env import work without a key-exchange ceremony. If you need a provider that cannot read your secrets even in principle, you need a zero-knowledge product.',
  },
  {
    question: 'Do I still need a .env file?',
    answer:
      "No. xecret run -- npm run dev fetches the environment, injects it into the child process, forwards signals and exits with the child's exit code, so nothing is written to disk. Your application keeps reading process.env exactly as it does today; there is no SDK to add and no import to write. The one file that stays in the repository is .xecret.yaml, which holds project and environment slugs only, never values, and is meant to be committed.",
  },
  {
    question: 'What happens when the xecret API is unreachable?',
    answer:
      'The CLI falls back to an encrypted local cache of the last environment it fetched, and says so loudly on stderr rather than stdout, so it never contaminates a pipe. The rule is that the cache answers when the API cannot — a DNS failure, a timeout, a 5xx — and never when the API will not. A 401, 403 or 404 is a decision, revocation above all, and softening a revocation with a local file would make the revoke button a suggestion.',
  },
  {
    question: 'How does this work in CI?',
    answer:
      "Create a service token scoped to one organisation, one project and one environment, store it in your CI provider's secret store as XECRET_TOKEN, and wrap the build step in xecret run. The token acts as itself, so every action it takes is attributed to that token by name rather than to the person who created it, and revoking it stops that one pipeline without touching anybody's account. Service tokens never write an offline cache.",
  },
  {
    question: 'Can I self-host xecret?',
    answer:
      'Yes, and no feature is held back. The server is AGPL-3.0 and the CLI is MIT. It runs on Cloudflare Workers with PostgreSQL and Cloudflare Secrets Store for the root key, plus a Firebase project for identity — that last dependency is real friction, and the self-hosting guide says so instead of burying it. One warning worth reading before you start: if you lose the root key, every secret is permanently unrecoverable, including by us.',
  },
  {
    question: 'What does xecret cost?',
    answer:
      'While xecret is pre-alpha, every paid feature is on for everybody and no card is collected. At 1.0 the free tier is $0 forever for 1 organisation, 5 projects, 3 members, 3 environments per project and 7 days of audit history. Team is $9 per member per month — $7 billed yearly — for unlimited organisations, projects, members and environments, 12 months of audit history, roles and per-environment access. Business is $19 per member per month for three years of history and priority support, and names SAML single sign-on, which is not built yet. Enterprise is custom. Self-hosting is free, always.',
  },
];

export default function FeaturesPage() {
  return (
    <PublicPage current="features">
      <JsonLd
        data={graph(
          softwareApplicationSchema(),
          faqSchema(FAQ),
          breadcrumbSchema([{ name: 'Features', path: '/features' }]),
        )}
      />

      <PageHero
        height="screen"
        eyebrow="Features"
        title="Encrypted environment variables, injected by a CLI, logged on every read"
        description="xecret stores your environment variables once, encrypted per environment, and hands them to whatever you run — locally, in CI, in production. This is the whole feature set, including the limits."
      >
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button asChild variant="primary" size="lg" className="rounded-full">
            <Link href="/sign-up">
              Start free
              <ArrowRightIcon className="size-4" />
            </Link>
          </Button>
          <Button asChild variant="secondary" size="lg" className="rounded-full">
            <Link href="/docs">Read the docs</Link>
          </Button>
        </div>
      </PageHero>

      <Section id="features" tone="inset" aria-labelledby="features-heading">
        <SectionHeading
          align="center"
          headingId="features-heading"
          eyebrow="Feature set"
          title="What xecret does with your environment variables"
          description="Nine of them, each documented in full. If a claim on this page is not in the documentation, treat it as a bug and tell us."
        />

        {/* ── One panel, nine cells ─────────────────────────────────────────
            Not nine free-floating cards. The hairlines between cells are the
            grid's own — the group carries a `--line-subtle` background and a
            one-pixel gap, and each cell paints `--surface` back over it —
            which is the same construction as the landing page's "drops into"
            band and is chosen for the same reason: it draws a correct rule at
            every breakpoint, with no `nth-child` arithmetic clearing a border
            on the last item of each row. That arithmetic is what rots the
            first time somebody adds a column.

            Nine divides by three but not by two, so at `sm` — where the grid
            is two across — the last cell spans both columns. A hole in the
            corner of a bordered panel reads as a card that failed to load. */}
        <div className="border-line mt-12 overflow-hidden rounded-2xl border">
          <RevealGroup className="bg-line-subtle grid gap-px sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((feature, index) => (
              <FeatureCard
                key={feature.title}
                feature={feature}
                index={index}
                wide={index === FEATURES.length - 1}
              />
            ))}
          </RevealGroup>
        </div>
      </Section>

      <Section id="up-close" tone="canvas" aria-labelledby="up-close-heading">
        <SectionHeading
          align="center"
          headingId="up-close-heading"
          eyebrow="Up close"
          title="Three parts worth seeing before you migrate"
          description="The command that replaces the file, the log that records every read, and the reason production never looks like its neighbours."
        />

        <div className="mt-14 space-y-16 sm:space-y-20">
          <DetailRow
            title="Delete the file. Keep the values."
            visual={<TerminalVisual />}
            copy={
              <>
                <p>
                  A <code className="font-mono text-[0.9375rem]">.env</code> file is a copy, and
                  copies multiply. Every laptop that has run the application has one, every CI job
                  has one, and none of them agree about which line is current.
                </p>
                <p>
                  <code className="font-mono text-[0.9375rem]">xecret run</code> resolves the
                  environment at the moment the process starts and injects it into the child.
                  Everything after <code className="font-mono text-[0.9375rem]">--</code> is your
                  command, unchanged — there is no SDK to install and no import to write, because
                  the application still reads{' '}
                  <code className="font-mono text-[0.9375rem]">process.env</code> exactly as it did
                  before.
                </p>
                <p className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
                  <Link href="/docs/quickstart" className={QUIET_LINK}>
                    Set it up in a minute
                    <ArrowRightIcon className="size-3.5" />
                  </Link>
                  <Link href="/docs/cli/commands" className={QUIET_LINK}>
                    Every CLI command
                    <ArrowRightIcon className="size-3.5" />
                  </Link>
                </p>
              </>
            }
          />

          <DetailRow
            reverse
            title="Every decryption leaves a row you can read"
            visual={<AuditVisual />}
            copy={
              <>
                <p>
                  Mutations, decryptions and denials, all recorded. Denials are the half most tools
                  leave out, and they are the half that shows an attack in progress rather than an
                  attack that already worked.
                </p>
                <p>
                  <code className="font-mono text-[0.9375rem]">secret.read</code> and{' '}
                  <code className="font-mono text-[0.9375rem]">secret.revealed</code> are the two
                  rows that mean a plaintext left the server. A 200-secret pull writes one{' '}
                  <code className="font-mono text-[0.9375rem]">secret.read</code> row with a count,
                  not 200 rows — an audit table that grows with every value read becomes a
                  denial-of-service surface aimed at itself.
                </p>
                <p className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
                  <Link href="/docs/security/audit-log" className={QUIET_LINK}>
                    Every event the audit log records
                    <ArrowRightIcon className="size-3.5" />
                  </Link>
                </p>
              </>
            }
          />

          <DetailRow
            title="Production does not look like anything else"
            visual={<EnvironmentVisual />}
            copy={
              <>
                <p>
                  One environment per project may be marked production, and marking it changes two
                  things at once. Developers and viewers lose access to it until somebody who
                  manages members grants that access by name. And it stops resembling its
                  neighbours.
                </p>
                <p>
                  The marking is a reserved colour, an uppercase label and diagonal hazard hatching
                  — three signals, so it survives colour blindness, a greyscale print-out and a
                  failing external monitor. The single-signal version of this is how a value ends up
                  in the wrong environment at two in the morning.
                </p>
                <p className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
                  <Link href="/docs/guides/teams" className={QUIET_LINK}>
                    Roles and per-environment access
                    <ArrowRightIcon className="size-3.5" />
                  </Link>
                </p>
              </>
            }
          />
        </div>
      </Section>

      <Section id="comparison" tone="inset" aria-labelledby="comparison-heading">
        <SectionHeading
          align="center"
          headingId="comparison-heading"
          eyebrow="The honest comparison"
          title="xecret against the .env file in your repository"
          description="Seven axes, including the last one, where the file you already have is the better answer and we are not going to pretend otherwise."
        />

        <Reveal className="mt-12">
          <div className="border-line bg-surface overflow-hidden rounded-xl border">
            {/* ── Why this is a description list and not a table ──
                A `<table>` with two columns of prose cannot be read on a phone
                without horizontal scrolling, and the usual fix — `display:
                block` on the cells — throws away the header association that
                made it a table in the first place. A `<dl>` keeps the
                association by construction: one term, two descriptions. The
                per-cell labels are `md:sr-only` rather than `md:hidden`, so the
                column an answer belongs to is announced at every width, even
                where it is only drawn once at the top of the card. */}
            <div className="border-line-subtle bg-canvas-inset/60 text-fg-subtle hidden border-b text-xs font-semibold tracking-[0.14em] uppercase md:grid md:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_minmax(0,1fr)]">
              <span className="px-5 py-3" />
              <span className="px-5 py-3">A .env file in the repo</span>
              <span className="px-5 py-3">xecret</span>
            </div>

            <dl className="divide-line-subtle divide-y">
              {COMPARISON.map((row) => (
                <div
                  key={row.axis}
                  className="px-5 py-5 md:grid md:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_minmax(0,1fr)] md:px-0"
                >
                  <dt className="text-fg text-sm font-semibold md:px-5">{row.axis}</dt>
                  <dd className="text-fg-muted mt-3 text-sm leading-6 md:mt-0 md:px-5">
                    <span className="text-fg-subtle block text-xs font-semibold tracking-[0.14em] uppercase md:sr-only">
                      A .env file in the repo
                    </span>
                    <span className="mt-1 block md:mt-0">{row.dotenv}</span>
                  </dd>
                  <dd className="text-fg mt-4 text-sm leading-6 md:mt-0 md:px-5">
                    <span className="text-fg-subtle block text-xs font-semibold tracking-[0.14em] uppercase md:sr-only">
                      xecret
                    </span>
                    <span className="mt-1 block md:mt-0">{row.xecret}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </Reveal>
      </Section>

      <Section id="trust-model" tone="canvas" aria-labelledby="trust-model-heading">
        {/* ── The admission, with the diagram that backs it ────────────────
            The paragraph on the left used to sit alone in a `max-w-3xl` card
            with half the band empty beside it, which on the one section that
            admits a limitation reads as a page that ran out of things to say.
            The key hierarchy answers it: the claim is "every environment has
            its own key, wrapped under a root key we hold", and the ladder is
            that sentence drawn. Nobody has to take the paragraph on faith
            when the four layers and where each one lives are printed next
            to it. */}
        <Reveal>
          <div className="grid items-stretch gap-8 lg:grid-cols-2 lg:gap-14">
            <div className="border-line bg-surface flex h-full flex-col gap-4 rounded-xl border p-6 sm:p-7">
              <div className="flex items-center gap-2.5">
                <ShieldCheckIcon className="text-accent-text size-5 shrink-0" />
                <h2
                  id="trust-model-heading"
                  className="text-fg text-base font-semibold tracking-tight"
                >
                  What xecret can and cannot see
                </h2>
              </div>
              <p className="text-fg-muted text-sm leading-7">
                xecret uses server-side envelope encryption. Every environment has its own data key,
                itself encrypted under a root key we hold; values are decrypted only inside a single
                request handler, and every decryption is written to an append-only audit log. That
                means we <span className="text-fg font-medium">can</span> technically decrypt your
                secrets — the same model Doppler uses, and the reason team sharing, CI tokens and
                browser-side import work without a key-exchange ceremony. If you need a provider
                that cannot read your secrets even in principle, you need a zero-knowledge product,
                and we would rather you learned that here than after migrating.
              </p>
              <div className="mt-auto flex flex-wrap gap-x-5 gap-y-2 text-sm">
                <Link href="/docs/security/trust-model" className={QUIET_LINK}>
                  The trust model in full
                  <ArrowRightIcon className="size-3.5" />
                </Link>
                <Link href="/docs/security/audit-log" className={QUIET_LINK}>
                  What the audit log records
                  <ArrowRightIcon className="size-3.5" />
                </Link>
              </div>
            </div>

            <KeyHierarchyVisual />
          </div>
        </Reveal>

        <Reveal delay={120} className="mt-8">
          <p className="text-fg-muted mx-auto max-w-2xl text-center text-sm leading-7">
            The threat model, the root-key ceremony and every architecture decision are documents in
            the repository rather than blog-post promises. We write the reasoning up as we go on the{' '}
            <Link href="/blog" className={QUIET_LINK}>
              engineering blog
            </Link>
            , and{' '}
            <Link href="/about" className={QUIET_LINK}>
              who is building xecret
            </Link>{' '}
            is a short page rather than a stock photograph.
          </p>
        </Reveal>
      </Section>

      <Section id="faq" tone="inset" aria-labelledby="faq-heading">
        <SectionHeading
          align="center"
          headingId="faq-heading"
          eyebrow="Questions"
          title="What developers ask before they migrate"
          description="The six that come up every time, answered where you can see them rather than in a document you have to request."
        />

        <Reveal className="mt-10">
          <Faq items={FAQ} className="mx-auto max-w-3xl" />
        </Reveal>

        <Reveal delay={120} className="mt-6">
          <p className="text-fg-muted mx-auto max-w-2xl text-center text-sm leading-7">
            The rest — SSO, data residency, what happens to your secrets if we shut down — are on
            the{' '}
            <Link href="/faq" className={QUIET_LINK}>
              frequently asked questions page
            </Link>
            , and the numbers behind that last answer are on the{' '}
            <Link href="/pricing" className={QUIET_LINK}>
              pricing page
            </Link>
            .
          </p>
        </Reveal>
      </Section>

      <CtaBand
        title="Move one environment and see."
        description="Create a project, drag in the .env file you already have, and run your app through the CLI. Nothing here needs a card, and the import parses in your browser before anything is sent."
      />
    </PublicPage>
  );
}

/**
 * One cell of the feature panel.
 *
 * ── Where the motion is, and where it deliberately is not ──
 * Two things move on hover: a hairline draws across the cell's top edge from
 * the left, and the icon chip inverts and lifts a couple of pixels. That is
 * the whole budget. What is *not* here is a background change on the cell
 * itself, which is the obvious third move and the wrong one — these cards are
 * not links, and a surface that lights up under the pointer promises a click
 * that never arrives.
 *
 * Nothing is revealed by hovering. Every word, including the artefact at the
 * foot, is on the page at rest, so a touch screen and a screen reader get the
 * same card a pointer does. A hover state that carries information is a hover
 * state most of the internet cannot use.
 *
 * Both transitions collapse to 0.01ms under `prefers-reduced-motion` via the
 * global rule in globals.css, and both have a visible resting state, so
 * neither needs an escape hatch of its own.
 */
function FeatureCard({
  feature,
  index,
  wide,
}: {
  feature: Feature;
  index: number;
  /** The last cell spans the two-column layout — see the grid's own note. */
  wide: boolean;
}) {
  const { icon: Icon, title, body, proofKind, proof } = feature;

  return (
    <article
      className={cn(
        'group bg-surface relative flex h-full min-w-0 flex-col',
        wide && 'sm:col-span-2 lg:col-span-1',
      )}
    >
      <span
        aria-hidden="true"
        className="bg-line-strong absolute inset-x-0 top-0 h-px origin-left scale-x-0 transition-transform duration-500 ease-out group-hover:scale-x-100"
      />

      <div className="flex flex-1 flex-col p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <span
            aria-hidden="true"
            className="border-accent-line bg-accent-tint text-accent-text group-hover:border-accent group-hover:bg-accent group-hover:text-accent-fg grid size-9 shrink-0 place-items-center rounded-md border transition-[color,background-color,border-color,transform] duration-300 group-hover:-translate-y-0.5"
          >
            <Icon className="size-[1.15rem]" />
          </span>
          {/* Decorative, so `aria-hidden`: the numbering says "this is all
              nine of them, and there is no tenth further down the page",
              which is a claim about the layout rather than about the
              feature, and reading "zero four" before every heading is a
              tax on the one reader who cannot see the layout. */}
          <span
            aria-hidden="true"
            className="text-fg-subtle group-hover:text-fg-muted font-mono text-xs tabular-nums transition-colors"
          >
            {String(index + 1).padStart(2, '0')}
          </span>
        </div>

        <h3 className="text-fg mt-4 text-base font-semibold tracking-tight">{title}</h3>
        <p className="text-fg-muted mt-2 text-sm leading-6">{body}</p>
      </div>

      {/* The artefact, on its own inset shelf at the foot of the cell.
          `mt-auto` comes from the `flex-1` above it, so the shelves line up
          across a row however unevenly the prose falls — which is what turns
          three cards of different lengths back into a row.

          Truncated rather than wrapped, for the reason the landing page's
          band gives: commands that break at different points give a row a
          ragged baseline, and every one of these strings is in the
          documentation this section links to. */}
      <div className="border-line-subtle bg-canvas-inset border-t px-5 py-3.5 sm:px-6">
        <p className="text-fg-subtle text-[0.6875rem] font-semibold tracking-[0.14em] uppercase">
          {proofKind}
        </p>
        <code className="text-fg-muted group-hover:text-fg mt-1.5 block truncate font-mono text-xs transition-colors">
          {proofKind === 'Command' ? <span className="text-fg-subtle select-none">$ </span> : null}
          {proof}
        </code>
      </div>
    </article>
  );
}

/**
 * One story: copy on one side, an illustration on the other, alternating down
 * the page.
 *
 * The copy is always first in the DOM, so a stacked column reads heading →
 * prose → illustration and a screen reader never meets the picture before the
 * claim it supports. `reverse` moves the illustration with `order`, which
 * applies only from `lg` up — the one width at which reading order and visual
 * order are genuinely allowed to differ.
 */
function DetailRow({
  title,
  copy,
  visual,
  reverse = false,
}: {
  title: string;
  copy: ReactNode;
  visual: ReactNode;
  reverse?: boolean;
}) {
  return (
    <Reveal>
      <div className="grid items-center gap-8 lg:grid-cols-2 lg:gap-14">
        <div className={cn('min-w-0', reverse && 'lg:order-2')}>
          <h3 className="text-fg text-xl leading-tight font-semibold tracking-[-0.02em] text-balance sm:text-2xl">
            {title}
          </h3>
          <div className="text-fg-muted mt-5 max-w-xl space-y-4 text-base leading-7 sm:leading-8">
            {copy}
          </div>
        </div>
        <div className={cn('min-w-0', reverse && 'lg:order-1')}>{visual}</div>
      </div>
    </Reveal>
  );
}

function TerminalVisual() {
  return (
    <figure className="border-line bg-surface shadow-raised overflow-hidden rounded-xl border">
      <figcaption className="sr-only">
        Illustration: a terminal in which the .env file is printed, deleted, and the application is
        started again through xecret run.
      </figcaption>
      <div className="border-line-subtle bg-canvas-inset text-fg-subtle flex items-center gap-2 border-b px-3 py-2 text-sm">
        <TerminalIcon className="size-3.5" />
        one command, no file
      </div>
      <div className="flex flex-col gap-0.5 px-4 py-3.5 font-mono text-sm leading-6">
        {TERMINAL_LINES.map((line) =>
          line.kind === 'command' ? (
            <span key={line.text} className="text-fg break-all">
              <span className="text-fg-subtle select-none">$ </span>
              {line.text}
            </span>
          ) : (
            <span
              key={line.text}
              className={cn(
                'break-all',
                line.kind === 'output' ? 'text-fg-muted' : 'text-fg-subtle',
              )}
            >
              {line.text}
            </span>
          ),
        )}
      </div>
    </figure>
  );
}

function AuditVisual() {
  return (
    <figure className="border-line bg-surface shadow-raised overflow-hidden rounded-xl border">
      <figcaption className="sr-only">
        Illustration: four rows of an audit log, one of them a denied read of production.
      </figcaption>
      <div className="border-line-subtle bg-canvas-inset text-fg-subtle flex items-center gap-2 border-b px-3 py-2 text-sm">
        <HistoryIcon className="size-3.5" />
        Audit log · storefront
        <span className="text-fg-subtle ml-auto">append-only</span>
      </div>
      <ul className="divide-line-subtle divide-y">
        {AUDIT_ROWS.map((row) => (
          <li key={`${row.action}-${row.at}`} className="flex items-start gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-fg font-mono text-sm break-all">{row.action}</p>
              <p className="text-fg-subtle mt-1 text-xs">
                {row.actor} · {row.kind} · {row.detail}
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <Badge tone={row.outcome === 'denied' ? 'danger' : 'success'} className="text-xs">
                {row.outcome}
              </Badge>
              <span className="text-fg-subtle font-mono text-xs">{row.at}</span>
            </div>
          </li>
        ))}
      </ul>
    </figure>
  );
}

function EnvironmentVisual() {
  return (
    <figure className="border-line bg-surface shadow-raised overflow-hidden rounded-xl border">
      <figcaption className="sr-only">
        Illustration: three environments in one project, with the production row marked by an
        uppercase label and hazard hatching, and developer access set to none.
      </figcaption>
      <div className="border-line-subtle bg-canvas-inset text-fg-subtle flex items-center gap-2 border-b px-3 py-2 text-sm">
        <LayersIcon className="size-3.5" />
        storefront · environments
      </div>
      <ul className="divide-line-subtle divide-y">
        {ENVIRONMENTS.map((environment) => (
          <li
            key={environment.name}
            className={cn(
              'flex items-center gap-3 border-l-2 px-4 py-3.5',
              // The only sanctioned use of the production ramp on this page:
              // it is marking a production environment, which is the one thing
              // the reserved colour exists for.
              environment.production ? 'border-production-line' : 'border-transparent',
            )}
          >
            <div className="min-w-0 flex-1">
              <p className="text-fg font-mono text-sm">{environment.name}</p>
              <p className="text-fg-subtle mt-1 text-xs">
                {environment.secrets} secrets · developer access: {environment.developer}
              </p>
            </div>
            {environment.production ? (
              <Badge tone="production" className="shrink-0 text-xs">
                Production
              </Badge>
            ) : null}
          </li>
        ))}
      </ul>
    </figure>
  );
}

/**
 * The key hierarchy, drawn.
 *
 * Unlike the three visuals above it, this is not a mock-up of an interface —
 * it is the trust-model document's own table, laid out vertically so the
 * wrapping order is something you can see rather than something you have to
 * hold in your head. It sits beside the paragraph that admits we can decrypt,
 * because that admission is only worth reading if the structure behind it is
 * on the same screen.
 *
 * The connectors are `aria-hidden`: each layer's own line already says what it
 * is encrypted under, so the verb between two rows is a second telling for the
 * eye only, and a screen reader reading "wraps" between list items would be
 * hearing the diagram rather than the fact.
 */
function KeyHierarchyVisual() {
  return (
    <figure className="border-line bg-surface shadow-raised h-full overflow-hidden rounded-xl border">
      <figcaption className="sr-only">
        The key hierarchy: four layers, from the root key down to a single encrypted secret version,
        with where each one is stored.
      </figcaption>
      <div className="border-line-subtle bg-canvas-inset text-fg-subtle flex items-center gap-2 border-b px-3 py-2 text-sm">
        <KeyIcon className="size-3.5" />
        Key hierarchy
        <span className="text-fg-subtle ml-auto font-mono text-xs">AES-256-GCM</span>
      </div>
      <ol className="px-4 py-4">
        {KEY_HIERARCHY.map((layer) => (
          <li key={layer.layer}>
            {layer.relation ? (
              <div aria-hidden="true" className="flex items-center gap-2 py-1.5 pl-5">
                <span className="bg-line-strong h-5 w-px" />
                <span className="text-fg-subtle font-mono text-[0.6875rem]">{layer.relation}</span>
              </div>
            ) : null}
            <div className="border-line-subtle bg-canvas-inset/60 rounded-lg border px-3.5 py-2.5">
              <p className="text-fg font-mono text-sm">{layer.layer}</p>
              <p className="text-fg-subtle mt-1 text-xs leading-5">{layer.where}</p>
            </div>
          </li>
        ))}
      </ol>
    </figure>
  );
}

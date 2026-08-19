import type { Metadata } from 'next';
import Link from 'next/link';

// Deliberately not the `components/ui` barrel — see the note in app/layout.tsx.
// This page is prerendered and public; it should not carry a byte of the
// dashboard. The `components/marketing` barrel is safe: everything under it is
// either a Server Component or one of the two small islands the public pages
// genuinely need.
import {
  Container,
  CtaBand,
  DockerLogo,
  Faq,
  GoLogo,
  JsonLd,
  NextjsLogo,
  NodejsLogo,
  PipelineLogo,
  PublicPage,
  QUIET_LINK,
  ReactLogo,
  Reveal,
  RevealGroup,
  Section,
  SectionHeading,
  faqSchema,
  graph,
} from '@/components/marketing';
import type { FaqItem } from '@/components/marketing';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import {
  ArrowRightIcon,
  CheckIcon,
  CloseIcon,
  GitHubIcon,
  HistoryIcon,
  KeyIcon,
  LayersIcon,
  RefreshIcon,
  ShieldCheckIcon,
  TerminalIcon,
  UsersIcon,
} from '@/components/ui/icons';
import {
  absoluteUrl,
  REPO_URL,
  SITE_KEYWORDS,
  SITE_NAME,
  softwareApplicationSchema,
} from '@/lib/site';
import { CliDemo } from './cli-demo';
import { InstallGuide } from './install-guide';

const RUN_COMMAND = 'xecret run -- npm run dev';

const TITLE = 'Secret management for developers';
const DESCRIPTION =
  'xecret replaces your .env file. Environment variables encrypted per environment, audited on every read, and injected into your app with one command. Open source.';

export const metadata: Metadata = {
  // The root layout's title template appends the product name, so the home
  // page opts out of it: "xecret · xecret" is the one place a template is
  // always wrong.
  title: { absolute: 'xecret — secret management for developers' },
  description: DESCRIPTION,
  keywords: [
    'secret management for developers',
    '.env file alternative',
    'encrypted environment variables',
    'open source secrets manager',
    ...SITE_KEYWORDS,
  ],
  alternates: { canonical: absoluteUrl('/') },
  openGraph: {
    type: 'website',
    url: absoluteUrl('/'),
    siteName: SITE_NAME,
    title: `${SITE_NAME} — ${TITLE}`,
    description: DESCRIPTION,
  },
};

const STEPS = [
  {
    title: 'Create a project',
    body: 'One project per application, with an environment for each stage you deploy to. Every environment gets its own encryption key at the moment it is created.',
  },
  {
    title: 'Import your .env',
    body: 'Drag in the file you already have. Parsing happens in your browser, so a pasted blob of production credentials never becomes a request body.',
  },
  {
    title: 'Run your app',
    body: 'The CLI resolves the environment, decrypts server-side, and injects everything into the process. No .env file on disk, and every read is in the audit log.',
  },
] as const;

const FEATURES = [
  {
    Icon: KeyIcon,
    title: 'A key per environment',
    body: 'Development, staging and production never share a data key. Compromising one environment does not hand over the others.',
  },
  {
    Icon: TerminalIcon,
    title: 'One command, any stack',
    body: 'xecret run injects the environment and execs your process. Next.js, Node, Vite, Go, Docker, CI — nothing in your code changes.',
  },
  {
    Icon: HistoryIcon,
    title: 'An append-only audit log',
    body: 'Every read, write and rotation is recorded with who, what and when. It is the record you need before an incident, not after.',
  },
  {
    Icon: UsersIcon,
    title: 'Access you can revoke',
    body: 'Members, roles and per-environment access. A leaver loses production the moment you remove them, not the next time somebody rotates.',
  },
  {
    Icon: RefreshIcon,
    title: 'Works on a plane',
    body: 'The CLI keeps an encrypted offline cache, so a flaky network does not stop you running the app you were already running.',
  },
  {
    Icon: LayersIcon,
    title: 'Yours to run',
    body: 'The server is AGPL-3.0 and the CLI is MIT. Self-hosting is a documented path with nothing held back behind it.',
  },
] as const;

/**
 * The "drops into" band.
 *
 * Every entry is a guide that exists under `/docs/guides`, and every command
 * is the real one from that guide. A row of framework names on a landing page
 * is usually decoration — a logo wall with the serial numbers filed off. This
 * one carries the exact line you would type, which is both the proof that the
 * integration is real and the answer to the only question a developer has at
 * this point on the page: *what do I actually have to change?*
 *
 * The marks are the official ones, in the official colours — see the note in
 * `components/marketing/brand-logos`. They are here to make the row scannable
 * at a glance, not to imply endorsement, which is why the command stays: a
 * logo wall alone would be exactly the borrowed legitimacy this page has no
 * use for. CI/CD is the one cell without a mark to borrow, since its guide
 * covers four runners rather than one product.
 */
const WORKS_WITH = [
  {
    label: 'Next.js',
    Logo: NextjsLogo,
    command: 'xecret run -- next dev',
    href: '/docs/guides/nextjs',
  },
  {
    label: 'Node.js',
    Logo: NodejsLogo,
    command: 'xecret run -- node server.js',
    href: '/docs/guides/nodejs',
  },
  {
    label: 'React + Vite',
    Logo: ReactLogo,
    command: 'xecret run -- vite',
    href: '/docs/guides/react-vite',
  },
  { label: 'Go', Logo: GoLogo, command: 'xecret run -- go run .', href: '/docs/guides/go' },
  {
    label: 'Docker',
    Logo: DockerLogo,
    command: 'xecret run -- docker compose up',
    href: '/docs/guides/docker',
  },
  {
    label: 'CI/CD',
    Logo: PipelineLogo,
    command: 'xecret run -- npm test',
    href: '/docs/guides/ci',
  },
] as const;

/* The honest inventory, as two lists rather than as one paragraph of prose.
   A visitor deciding whether to trust a secrets product is not reading for
   pleasure — they are looking for the one line that disqualifies us, and a list
   they can scan in eight seconds respects that more than a well-turned
   paragraph they have to parse. The paragraph beside it is still there for the
   reader who wants the reasoning. */
const CAN_SEE = [
  'Encrypted secret values, which we can technically decrypt — the root key is ours',
  'Secret names, project names, environment names and organisation names, unencrypted',
  'Your email address and the identity provider you signed in with',
  'Every read, write and rotation, in the audit log, with who and when',
] as const;

const CANNOT_SEE = [
  'Your source code — xecret never sees a repository',
  'The contents of the .env file you imported, before you imported it: parsing happens in your browser',
  'Your PIN, which unlocks the dashboard locally and is never sent to us',
  'Anything at all, on a self-hosted deployment — that database is yours',
] as const;

const FAQ: readonly FaqItem[] = [
  {
    question: 'Can xecret read my secrets?',
    answer:
      'Technically, yes. xecret uses server-side envelope encryption: every environment has its own data key, encrypted under a root key we hold, and values are decrypted inside a single request handler. That is the same model Doppler uses, and it is what makes team sharing, CI tokens and browser-side import work without a key-exchange ceremony. If you need a provider that cannot read your secrets even in principle, you need a zero-knowledge product, and we would rather you knew that now than after migrating.',
  },
  {
    question: 'Do I have to change my application code?',
    answer:
      'No. The CLI resolves the environment, decrypts it, and injects the variables into the process it starts — your code carries on reading process.env, os.Getenv or whatever it already used. The only file that changes is .xecret.yaml, which holds slugs rather than secrets and is meant to be committed.',
  },
  {
    question: 'What happens if xecret is down when I need to deploy?',
    answer:
      'The CLI keeps an encrypted offline cache of the environments you have already resolved, so a local run keeps working. For a deploy, the honest answer for a pre-alpha product is to hold a break-glass copy of your production credentials somewhere you control, and to treat any single provider — us included — as something that can fail.',
  },
  {
    question: 'Is it really open source, or is the useful half proprietary?',
    answer:
      'The server is AGPL-3.0 and the CLI is MIT, and self-hosting is a documented first-class path. No feature is held back from a self-hosted deployment. What a paid plan buys on the hosted service is capacity and support, not capability.',
  },
  {
    question: 'What does it cost?',
    answer:
      'The free tier is free forever: one organisation, five projects, three members, three environments per project, and seven days of audit history. Team is $9 per member per month — $7 billed yearly — for unlimited organisations, projects, members and environments, and twelve months of history. Business is $19 per member per month and adds three years of history, priority support, and SAML single sign-on once it is built. Enterprise is custom. Self-hosting is free and unlimited. While xecret is in pre-alpha, every paid feature is on for everybody and no card is collected.',
  },
  {
    question: 'Is xecret ready for production?',
    answer:
      'It is pre-alpha. The encryption, the audit log, the CLI and self-hosting all work today, but the API surface can still change and there is no SLA. Use it for a side project or a new service; do not migrate a payments system to it this week.',
  },
];

export default function LandingPage() {
  // No BreadcrumbList here: a breadcrumb whose only entry is the site root
  // describes nothing, and publishing one on the home page is how a site ends
  // up with a trail that says "xecret › xecret" under its own search result.
  const structuredData = graph(softwareApplicationSchema(), faqSchema(FAQ));

  return (
    <PublicPage>
      <JsonLd data={structuredData} />

      {/* ── Hero ──────────────────────────────────────────────────────────
          Two columns from `lg` up: the claim on the left, the proof on the
          right, both settled against the top of the grid rather than centred —
          the terminal is taller than the copy, and centring would push the
          headline down to meet it. Below `lg` they stack in the order they are
          read.

          Nothing here is wrapped in a Reveal. The headline and the primary
          action are the two things on the site that must not wait for a
          script, and an entrance animation on content that is already on
          screen at load is a delay dressed up as design. */}
      {/* The first screen is one centred composition — claim, terminal, then
          the band of what it drops into. The band trails the widgets it
          belongs to rather than being pushed to the foot of the viewport,
          where the empty space above it made it read as a separate thing that
          had drifted down the page.

          `pb-20` is the same optical lift `PageHero` applies — see the note
          there. It shifts the centred group up by half its value, because a
          block of content on the geometric centre of a viewport reads as
          sitting below it, and the floating header weights the top of the
          screen.

          `x-first-screen` rather than `min-h-svh`: a full `svh` overshoots by
          the height the sticky header already spent in flow above this
          section, which is enough on its own to push the foot of the
          composition under the fold. */}
      <section className="x-first-screen relative isolate flex flex-col justify-center overflow-hidden pb-20 sm:pb-24">
        <div className="x-hero-glow" aria-hidden="true" />
        <div className="x-grid-lines" aria-hidden="true" />

        {/* `items-center` from `lg` up, `items-start` below it: side by side
            the terminal and the copy are close enough in height that centring
            reads as deliberate, but stacked on a phone the copy must sit
            directly under the headline rather than floating in the middle of
            its own row. See `PageHero` for why a hero is sized to the first
            screen at all, and the note above for why this one measures it with
            `.x-first-screen`. */}
        <Container className="relative grid w-full items-start gap-12 pt-20 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:items-center lg:gap-16">
          <div>
            <span className="border-line bg-surface/60 text-fg-muted inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium backdrop-blur">
              <ShieldCheckIcon className="size-3.5" />
              Open source · Encrypted per environment · Audited
            </span>

            {/* Display type: the size is the whole hierarchy on this page —
                there is no colour left to carry it, by design. */}
            {/* `.env` is set in the sans face, not the mono one. At 64px a
                monospace full stop sits alone in the middle of a fixed advance
                width, which puts a visible gap on both sides of it — the
                headline read as "secrets in . env files". Mono is right for a
                path inside a paragraph and wrong for a word at display size. */}
            <h1 className="text-fg mt-6 text-[2.75rem] leading-[1.02] font-semibold tracking-[-0.035em] text-balance sm:text-6xl lg:text-[4rem]">
              Stop shipping secrets in .env files.
            </h1>
            <p className="text-fg-muted mt-6 max-w-xl text-base leading-8 text-pretty sm:text-[1.125rem]">
              xecret stores your environment variables once, encrypted per environment, and injects
              them into whatever you are running — locally, in CI, in production. No file on disk,
              no credentials in Slack, no &ldquo;works on my machine&rdquo;.
            </p>

            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Button asChild variant="primary" size="lg" className="rounded-full">
                <Link href="/sign-up">
                  Start free
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

            <p className="text-fg-subtle mt-5 text-sm">
              Free forever for small teams ·{' '}
              <Link href="/pricing" className="hover:text-fg-muted underline underline-offset-2">
                see what it costs
              </Link>
            </p>
          </div>

          <div className="min-w-0">
            <CliDemo />

            <div className="border-line bg-surface mt-3 flex items-center gap-2 rounded-lg border px-3 py-2">
              <code className="text-fg-muted min-w-0 flex-1 font-mono text-sm break-all">
                <span className="text-fg-subtle select-none">$ </span>
                {RUN_COMMAND}
              </code>
              <CopyButton value={RUN_COMMAND} label="the run command" />
            </div>
          </div>
        </Container>

        {/* ── Drops into ──────────────────────────────────────────────────
            Inside the hero rather than under it: it is the closing element of
            the first screen's composition, not the first thing you have to
            scroll to. A reader who has just met the claim has exactly one
            question — does this touch the stack I actually run? — and nothing
            else that could hold this space answers it as cheaply.

            No Reveal on it, for the reason given at the top of the hero: this
            is on screen at load now, and an entrance animation on content the
            reader is already looking at is a delay dressed up as design.

            The hairlines between cells are drawn by the grid itself — the list
            carries a `--line-subtle` background and a one-pixel gap, and each
            cell paints `--surface` back over it. That produces a correct rule
            at every breakpoint (six across, three, two) with no `nth-child`
            arithmetic clearing a border on the last item of each row, which is
            how this pattern normally rots the first time a column is added. */}
        <section aria-labelledby="works-with" className="relative mt-14 sm:mt-16">
          <Container>
            <div className="border-line bg-surface/80 shadow-raised overflow-hidden rounded-2xl border backdrop-blur-xl">
              {/* Set as written, not shouted. The wide tracking that came with
                  the caps went too: letterspacing is a repair for the tight fit
                  of all-caps, and leaving it on lower case just pulls the words
                  apart.

                  A step above the cell labels below it rather than level with
                  them — at the same size it read as a seventh item that had
                  lost its command, and `text-fg-subtle` is what keeps it from
                  outweighing the row it introduces. */}
              <h2
                id="works-with"
                className="border-line-subtle text-fg-subtle border-b px-5 py-3.5 text-center text-base font-semibold"
              >
                Drops into what you already run
              </h2>

              <ul className="bg-line-subtle grid grid-cols-2 gap-px sm:grid-cols-3 lg:grid-cols-6">
                {WORKS_WITH.map((entry) => (
                  <li key={entry.label} className="bg-surface">
                    <Link
                      href={entry.href}
                      className="group hover:bg-surface-hover flex h-full flex-col gap-1.5 px-4 py-4 transition-colors sm:px-5"
                    >
                      {/* The mark is decorative — the label right beside it is
                          the accessible name, so a second one here would just
                          make a screen reader say "Docker Docker". */}
                      <span className="flex items-center gap-2">
                        <entry.Logo className="size-[1.125rem] shrink-0" />
                        <span className="text-fg text-sm font-semibold">{entry.label}</span>
                      </span>
                      {/* Truncated rather than wrapped: six cells whose commands
                          break at different points give the row a ragged
                          baseline, and the full line is one click away on the
                          guide this links to. */}
                      <code className="text-fg-subtle group-hover:text-fg-muted truncate font-mono text-xs transition-colors">
                        {entry.command}
                      </code>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </Container>
        </section>
      </section>

      {/* ── How it works ─────────────────────────────────────────────────── */}
      <Section id="how-it-works" aria-labelledby="how-it-works-heading" size="md">
        <SectionHeading
          headingId="how-it-works-heading"
          eyebrow="How it works"
          title="Sixty seconds, start to finish"
          description="There is no agent to install, no sidecar to run and no IAM policy to write. Three steps, and your application never learns that anything changed."
          align="center"
        />
        {/* Three equal columns of centred text under a centred heading — the
            steps are unbounded (no card, no border), so left-aligning them
            under a centred heading would leave the section reading as two
            different layouts stacked. */}
        <RevealGroup className="mt-12 grid gap-10 sm:grid-cols-3">
          {STEPS.map((step, index) => (
            <div key={step.title} className="text-center">
              <span
                aria-hidden="true"
                className="border-accent-line bg-accent-tint text-accent-text mx-auto mb-4 grid size-9 place-items-center rounded-lg border text-sm font-semibold"
              >
                {index + 1}
              </span>
              <h3 className="text-fg text-base font-semibold">{step.title}</h3>
              <p className="text-fg-muted mx-auto mt-2 max-w-xs text-sm leading-6">{step.body}</p>
            </div>
          ))}
        </RevealGroup>
      </Section>

      {/* ── Install ───────────────────────────────────────────────────────
          Directly under the three steps, because the step above it ends at
          "run your app" and this is the reader's first chance to check that
          the claim survives contact with their own machine. Four tabs rather
          than a paragraph of prose per platform: nobody reads the three that
          are not theirs, and a page that makes you skip three quarters of a
          section to find your own line has already lost the argument about
          respecting your time.

          The transcript carries the credential story rather than a bullet
          list making the same promise — `credential store: OS keychain` is
          `xecret doctor` speaking, and a reader can run it and get the same
          line back. See `install-guide.tsx` for where every line comes
          from. */}
      <Section id="install" aria-labelledby="install-heading" tone="inset" size="md">
        <SectionHeading
          headingId="install-heading"
          eyebrow="Install"
          title="Thirty seconds to installed and signed in"
          description="One static binary — no Node, no Python, nothing to compile, nothing to keep running. Pick your platform, run the line, and the credential you get back is held by your operating system rather than by a file in your home directory."
          align="center"
        />
        <Reveal className="mx-auto mt-10 max-w-3xl">
          <InstallGuide
            installUrl={absoluteUrl('/install.sh')}
            releasesUrl={`${REPO_URL}/releases`}
          />
        </Reveal>
        <p className="text-fg-subtle mt-5 text-center text-sm">
          Every path, including checksum verification and upgrades, is in{' '}
          <Link href="/docs/install" className={QUIET_LINK}>
            installing the CLI
            <ArrowRightIcon className="size-3.5" />
          </Link>
        </p>
      </Section>

      {/* ── The statement ─────────────────────────────────────────────────
          One line, set at display size, alone on a band. It is the argument
          the whole product rests on, and burying it inside a paragraph of
          feature copy is how a position becomes a bullet point. */}
      <section
        aria-labelledby="statement"
        className="border-line-subtle bg-canvas-inset/60 relative isolate overflow-hidden border-y"
      >
        <div className="x-hero-glow" aria-hidden="true" />
        <Container className="relative py-20 sm:py-28">
          <Reveal className="mx-auto max-w-4xl text-center">
            <h2
              id="statement"
              className="text-fg text-3xl leading-[1.15] font-semibold tracking-[-0.03em] text-balance sm:text-5xl"
            >
              A secret you cannot audit is a secret you have already lost.
            </h2>
            <p className="text-fg-muted mx-auto mt-6 max-w-2xl text-base leading-8 text-pretty sm:text-lg">
              Encryption is the easy half. The half that decides how your next incident goes is
              knowing exactly who read what, and when — before you need to know it.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 text-sm">
              <Link href="/docs/security/audit-log" className={QUIET_LINK}>
                How the audit log works
                <ArrowRightIcon className="size-3.5" />
              </Link>
              <Link href="/blog" className={QUIET_LINK}>
                Read the blog
                <ArrowRightIcon className="size-3.5" />
              </Link>
            </div>
          </Reveal>
        </Container>
      </section>

      {/* ── Features ─────────────────────────────────────────────────────── */}
      <Section id="features" aria-labelledby="features-heading">
        <SectionHeading
          headingId="features-heading"
          eyebrow="What you get"
          title="Built for the way you already work"
          description="Six things that matter on a Tuesday, not six things that demo well."
          align="center"
        />
        <RevealGroup className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ Icon, title, body }) => (
            <div key={title} className="border-line bg-surface rounded-xl border p-5 sm:p-6">
              <span
                aria-hidden="true"
                className="border-line bg-canvas-inset text-fg mb-4 grid size-9 place-items-center rounded-lg border"
              >
                <Icon className="size-[1.05rem]" />
              </span>
              <h3 className="text-fg text-base font-semibold">{title}</h3>
              <p className="text-fg-muted mt-2 text-sm leading-6">{body}</p>
            </div>
          ))}
        </RevealGroup>

        <Reveal className="mt-10 text-center">
          <Link href="/features" className={QUIET_LINK}>
            See every feature in detail
            <ArrowRightIcon className="size-3.5" />
          </Link>
        </Reveal>
      </Section>

      {/* ── The trust model ──────────────────────────────────────────────
          Centred, and symmetric about that centre: the claim above, and the
          two halves of the inventory it is a claim about side by side beneath
          it.

          This went through a left-aligned card and then a two-column split
          before landing here, and centring is what finally made it read as the
          most important section on the page rather than as a footnote beside
          it. A disclosure that is off to one side looks like something being
          got out of the way.

          The content is the honest version, on the marketing page rather than
          buried in a document nobody reads before signing up. A security
          product that overstates its guarantees has broken the only thing it
          sells. */}
      <Section id="security" aria-labelledby="security-heading" tone="inset">
        <Reveal className="mx-auto max-w-3xl text-center">
          <div className="text-fg-subtle inline-flex items-center gap-2 text-xs font-semibold tracking-[0.14em] uppercase">
            <ShieldCheckIcon className="text-fg size-4 shrink-0" aria-hidden="true" />
            Trust model
          </div>
          <h2
            id="security-heading"
            className="text-fg mt-3 text-2xl leading-tight font-semibold tracking-[-0.02em] text-balance sm:text-[2rem]"
          >
            What xecret can and cannot see
          </h2>
          <p className="text-fg-muted mt-5 text-base leading-8 text-pretty">
            xecret uses server-side envelope encryption. Every environment has its own data key,
            which is itself encrypted under a root key we hold; values are decrypted only inside a
            single request handler, and every decryption is written to an append-only audit log.
          </p>
        </Reveal>

        {/* Two panels, equal width, equal height. The symmetry is the
            argument: neither half is the fine print. */}
        <RevealGroup className="mx-auto mt-12 grid max-w-5xl gap-5 md:grid-cols-2">
          <div className="border-line bg-surface h-full rounded-xl border p-6">
            <h3 className="text-fg flex items-center gap-2 text-sm font-semibold">
              <EyeMarker tone="can" />
              What we can see
            </h3>
            <ul className="mt-4 flex flex-col gap-3">
              {CAN_SEE.map((item) => (
                <li key={item} className="text-fg-muted flex gap-2.5 text-sm leading-6">
                  <CheckIcon aria-hidden="true" className="text-fg-subtle mt-1 size-3.5 shrink-0" />
                  {item}
                </li>
              ))}
            </ul>
          </div>

          <div className="border-line bg-surface h-full rounded-xl border p-6">
            <h3 className="text-fg flex items-center gap-2 text-sm font-semibold">
              <EyeMarker tone="cannot" />
              What we never receive
            </h3>
            <ul className="mt-4 flex flex-col gap-3">
              {CANNOT_SEE.map((item) => (
                <li key={item} className="text-fg-muted flex gap-2.5 text-sm leading-6">
                  <CloseIcon aria-hidden="true" className="text-fg-subtle mt-1 size-3.5 shrink-0" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </RevealGroup>

        {/* The concession, under the evidence rather than before it. A reader
            who has just scanned both lists is the reader this paragraph is
            written for. */}
        <Reveal className="mx-auto mt-10 max-w-3xl text-center">
          <p className="text-fg-muted text-base leading-8 text-pretty">
            That means we <span className="text-fg font-medium">can</span> technically decrypt your
            secrets — it is the same model Doppler uses, and it is what makes team sharing, CI
            tokens and browser-side import work without a key-exchange ceremony. If you need a
            provider that cannot read your secrets even in principle, you need a zero-knowledge
            product, and we would rather you knew that now than after migrating.
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 text-sm">
            <Link href="/docs/security/trust-model" className={QUIET_LINK}>
              The full trust model
              <ArrowRightIcon className="size-3.5" />
            </Link>
            <Link href="/docs/security/audit-log" className={QUIET_LINK}>
              The audit log
              <ArrowRightIcon className="size-3.5" />
            </Link>
          </div>
        </Reveal>
      </Section>

      {/* ── Open source ──────────────────────────────────────────────────── */}
      <Section id="open-source" aria-labelledby="open-source-heading">
        <SectionHeading
          headingId="open-source-heading"
          eyebrow="Open source"
          title="Read it before you trust it"
          description="The crypto you are relying on is reviewable by anyone, and the binary that ships inside your Docker images carries a licence your legal team has already approved."
          align="center"
        />
        {/* `mx-auto` on the pair: two columns at `max-w-4xl` inside an 80rem
            measure were centred on nothing, which is the same empty-right-half
            problem in a smaller box. */}
        <RevealGroup className="mx-auto mt-12 grid max-w-4xl gap-10 sm:grid-cols-2">
          <div>
            <h3 className="text-fg text-base font-semibold">AGPL server, MIT CLI</h3>
            <p className="text-fg-muted mt-2 text-sm leading-6">
              The threat model, the key-recovery ceremony and every architecture decision are
              documents in the repository, not blog-post promises. The CLI is MIT precisely because
              it ends up inside your images and pipelines, where a copyleft licence would be a
              question nobody wants to answer.
            </p>
          </div>
          <div>
            <h3 className="text-fg text-base font-semibold">Run it yourself</h3>
            <p className="text-fg-muted mt-2 text-sm leading-6">
              Cloudflare Workers, a Neon or vanilla PostgreSQL database, and your own Firebase
              project for identity. The self-hosting guide states the real dependency list plainly —
              including the parts that are friction — because an open-source secrets manager that
              hides its operational cost is not being honest about the one thing it sells.
            </p>
          </div>
        </RevealGroup>
        <Reveal className="mt-10 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 text-sm">
          <Link href="/docs/self-hosting" className={QUIET_LINK}>
            Self-hosting guide
            <ArrowRightIcon className="size-3.5" />
          </Link>
          <Link href="/docs" className={QUIET_LINK}>
            Read the documentation
            <ArrowRightIcon className="size-3.5" />
          </Link>
          <Link href="/about" className={QUIET_LINK}>
            Why we built this
            <ArrowRightIcon className="size-3.5" />
          </Link>
        </Reveal>
      </Section>

      {/* ── FAQ ───────────────────────────────────────────────────────────
          The six questions a visitor asks before signing up, answered on the
          page they are already on. The same strings are published as FAQPage
          structured data above — one set of answers, rendered once. */}
      <Section id="faq" aria-labelledby="faq-heading" tone="inset">
        {/* Stacked and centred rather than heading-beside-accordion. The
            two-column version put a three-line heading next to a 400px column
            of questions, which left most of the left half empty and made the
            accordion — the thing anybody actually came here to read — the
            narrower of the two. */}
        <SectionHeading
          headingId="faq-heading"
          eyebrow="Questions"
          title="The things people ask first"
          description="Short answers to the six that come up before anybody signs up."
          align="center"
        />
        <Reveal className="mx-auto mt-10 max-w-3xl">
          <Faq items={FAQ} />
        </Reveal>
        <Reveal className="mt-6 text-center">
          <p className="text-fg-muted text-sm leading-7">
            Forty more, including the ones about billing, rotation and what a departing employee can
            still reach, are on the{' '}
            <Link href="/faq" className={QUIET_LINK}>
              full FAQ page
            </Link>
            .
          </p>
        </Reveal>
      </Section>

      <CtaBand />
    </PublicPage>
  );
}

/**
 * The dot beside each trust-model list heading.
 *
 * Two neutral markers rather than a green tick and a red cross: on this
 * section, "what we can see" is not a failure and "what we never receive" is
 * not a win — it is one honest inventory in two halves, and colouring it like
 * a scorecard would turn a disclosure into a sales pitch. Hue in this product
 * means status, and neither of these is a status.
 */
function EyeMarker({ tone }: { tone: 'can' | 'cannot' }) {
  return (
    <span
      aria-hidden="true"
      className={
        tone === 'can'
          ? 'bg-fg size-1.5 shrink-0 rounded-full'
          : 'border-fg-subtle size-1.5 shrink-0 rounded-full border'
      }
    />
  );
}

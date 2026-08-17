import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

import type { FaqItem } from '@/components/marketing';
import {
  CtaBand,
  Faq,
  INLINE_LINK,
  JsonLd,
  PageHero,
  PublicPage,
  Reveal,
  RevealGroup,
  Section,
  SectionHeading,
  faqSchema,
  graph,
} from '@/components/marketing';
import { AlertCircleIcon, BookIcon, GitHubIcon } from '@/components/ui/icons';
import { absoluteUrl, breadcrumbSchema, REPO_URL, SITE_KEYWORDS, SITE_NAME } from '@/lib/site';

/**
 * The marketing FAQ — the questions somebody asks *before* they sign up.
 *
 * There is a second FAQ in the documentation, at `/docs/faq`, and the two are
 * not the same page written twice. That one answers "my app cannot see a
 * changed secret"; this one answers "can you read my secrets" and "what happens
 * if you go out of business". Where they overlap, the answer here is short and
 * points at the documentation for the long version — a visitor deciding whether
 * to trust us does not want a manual, and a user halfway through a deploy does
 * not want a sales page.
 *
 * ── Why the questions are data and not JSX ──
 * Every answer is a plain string, because the identical string is rendered on
 * the page and published as the `FAQPage` structured data. Structured data that
 * says something the page does not is the fastest route to a manual action from
 * Google, so there is exactly one copy of each answer and no way to edit one
 * without editing the other. The cost is that an answer cannot contain a link;
 * the links therefore live in the paragraph above each accordion, where they
 * are more findable anyway — nobody clicks a link inside a collapsed `details`.
 *
 * ── Why one `FAQPage` node for six sections ──
 * Google's guidance is one `FAQPage` per page. `ALL_QUESTIONS` is derived from
 * `CATEGORIES` by the same traversal the render uses, so the schema order and
 * the visible order cannot drift apart: adding a question to a category is the
 * only edit needed, and there is no second list to forget.
 */

const TITLE = 'Secret management FAQ — security, pricing, self-hosting';
const DESCRIPTION =
  'Answers to what people ask before they sign up: can xecret read my secrets, what it costs, how it replaces a .env file, and what self-hosting really takes.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    'secret management FAQ',
    'is xecret secure',
    'can xecret read my secrets',
    'self-hosted secrets manager',
    '.env alternative',
    ...SITE_KEYWORDS,
  ],
  alternates: { canonical: absoluteUrl('/faq') },
  openGraph: {
    type: 'website',
    url: absoluteUrl('/faq'),
    siteName: SITE_NAME,
    title: `${TITLE} · ${SITE_NAME}`,
    description: DESCRIPTION,
  },
};

interface FaqCategory {
  /** Human-readable on purpose: `/faq#security` is a link people paste at each other. */
  readonly id: string;
  /** The label in the hero's jump row, shorter than the heading. */
  readonly navLabel: string;
  readonly eyebrow: string;
  readonly title: string;
  /** Carries the links the answers cannot. */
  readonly lede: ReactNode;
  readonly items: readonly FaqItem[];
}

const CATEGORIES: readonly FaqCategory[] = [
  {
    id: 'getting-started',
    navLabel: 'Getting started',
    eyebrow: 'Getting started',
    title: 'What xecret is, and what it replaces',
    lede: (
      <>
        xecret replaces the <code className="text-fg-muted font-mono text-[0.9em]">.env</code> file
        rather than sitting beside it. The{' '}
        <Link href="/docs/quickstart" className={INLINE_LINK}>
          five-step quickstart
        </Link>{' '}
        is the fastest way to see it work, and the{' '}
        <Link href="/features" className={INLINE_LINK}>
          features tour
        </Link>{' '}
        covers what is in the product if you would rather look before you make an account.
      </>
    ),
    items: [
      {
        question: 'What is xecret?',
        answer:
          'xecret is open-source secret management for developers. You store your environment variables once, encrypted per environment, and the CLI injects them into whatever you run — locally, in CI, in production. It replaces the .env file rather than sitting beside it.',
      },
      {
        question: 'How is this different from a .env file?',
        answer:
          'A .env file is a copy, and copies are the thing you stop being able to track: who has one, whether it is current, and what was on the laptop that went missing. xecret stores the value once and injects it when your process starts, so rotating a key reaches everybody on their next run. You also get an audit trail, which a file on a laptop can never give you.',
      },
      {
        question: 'How long does it take to set up?',
        answer:
          'About five minutes for the first project. Sign up, drag in the .env file you already have, install the CLI, and put xecret run in front of your dev command — that is the whole of it. The quickstart in the documentation is five steps long.',
      },
      {
        question: 'Do I have to change my code?',
        answer:
          "No. xecret run puts the values into your process's environment, and your code carries on reading process.env, os.Getenv or whatever your language calls it. There is no SDK to install and no import to add.",
      },
      {
        question: 'Which languages and frameworks does it work with?',
        answer:
          'All of them. Secrets arrive as environment variables, so anything that can read its own environment works with no integration at all. There are written guides for Next.js, Node, React and Vite, Go, Docker and CI, but those are shortcuts rather than requirements.',
      },
      {
        question: 'Does it work with Docker and CI?',
        answer:
          'Yes. In Docker the CLI is a small binary you add to the image, or you start the container under xecret run from outside it. In CI you mint a service token pinned to one project and one environment, set XECRET_TOKEN on the runner, and the same commands work unchanged.',
      },
      {
        question: 'Does it work on Windows?',
        answer:
          'Yes — a native binary, with credentials held in Windows Credential Manager. PowerShell, cmd.exe and WSL are all supported.',
      },
    ],
  },
  {
    id: 'security',
    navLabel: 'Security',
    eyebrow: 'Security and trust',
    title: 'What xecret can see, and what it cannot',
    lede: (
      <>
        The full reasoning — the key hierarchy, what each kind of compromise actually yields, and
        the cases where you should pick a different product — is in{' '}
        <Link href="/docs/security/trust-model" className={INLINE_LINK}>
          the trust model
        </Link>
        . Read it before you store a real credential, not after.
      </>
    ),
    items: [
      {
        question: 'Can xecret read my secrets?',
        answer:
          'Yes, technically, and you should know that before you migrate rather than after. xecret uses server-side envelope encryption: every environment has its own data key, itself encrypted under a root key we hold, and values are decrypted inside a single request handler. Every one of those decryptions is written to an append-only audit log. This is the same model Doppler uses, and it is what makes team sharing, CI tokens and browser-side .env import work without a key-exchange ceremony.',
      },
      {
        question: 'Is xecret zero-knowledge or end-to-end encrypted?',
        answer:
          'No, and we do not use those words about xecret because they would not be true. If you need a provider that cannot read your secrets even in principle — because a regulator requires it, or because your threat model includes the provider being compelled — you need a zero-knowledge product, and you should choose one now. The trust model page makes the same argument at greater length.',
      },
      {
        question: 'What happens if your database is breached?',
        answer:
          'The attacker gets ciphertext. No key material at any layer is stored in the database: the root key lives in a Cloudflare Secrets Store binding the database has no access to. Each ciphertext is also bound to its exact position in the key hierarchy, so a secret row copied from staging to production simply does not decrypt.',
      },
      {
        question: 'What happens if your root key leaks?',
        answer:
          'The root key together with a database dump exposes everything, and that is the one scenario this model does not defend against. It is why the two are kept in different systems with no path between them. If you self-host, custody of that key becomes yours — generate it, split it, and escrow the shares before the first real credential goes in.',
      },
      {
        question: 'How are encryption keys rotated?',
        answer:
          'Every layer of the hierarchy — root, organisation, environment — is versioned, so any one of them can be rotated independently of the others. A key rotation is itself an audited event. Rotating an individual secret is just a write: the new version becomes current and the history stays readable.',
      },
      {
        question: 'Is there an audit log?',
        answer:
          'Yes, and every decryption is in it, including your own. Every mutation and every denial is recorded too, because a system that logs only what succeeded cannot show you an attack in progress. The table is append-only by database grant rather than by convention — the application credentials cannot alter it.',
      },
      {
        question: 'Could one of my secret values end up in a log line?',
        answer:
          'No, and that is enforced by the type system rather than by review. The type describing audit metadata is a fixed allowlist of field names with no catch-all, so code that tries to put a value into a record does not compile. Error messages are fixed strings for the same reason: nothing derived from an exception or from rejected input reaches a client, because the rejected input may itself be a secret.',
      },
      {
        question: 'Are my secrets ever written to my disk?',
        answer:
          "Only when you ask for it. xecret run never writes them — it hands them to your process and nothing else. xecret pull does write a file, by design, and warns on stderr every time. The CLI offline cache keeps an encrypted copy whose key lives in your operating system's keychain, not beside the file.",
      },
      {
        question: 'Do you have SOC 2 or ISO 27001?',
        answer:
          'No. xecret is pre-alpha and holds no compliance certification of any kind, and inventing one on a secrets product would be the worst thing we could ship. What exists instead is public: the source, the threat model, the licence and the self-hosting instructions.',
      },
      {
        question: 'Is xecret production-ready?',
        answer:
          'Not yet. It is feature-complete for its first version, but it has not run against production infrastructure and has not had an external security review. Do not put credentials you cannot afford to rotate into it today.',
      },
      {
        question: 'How do I report a vulnerability?',
        answer:
          'Privately — open a security advisory on the GitHub repository, or email security@playxoft.com. Please do not open a public issue. You get an acknowledgement within 48 hours and an initial assessment within five working days, and we credit you in the advisory unless you would rather we did not.',
      },
    ],
  },
  {
    id: 'pricing',
    navLabel: 'Pricing',
    eyebrow: 'Plans and billing',
    title: 'Pricing, seats and what free actually means',
    lede: (
      <>
        The numbers below are the ones on{' '}
        <Link href="/pricing" className={INLINE_LINK}>
          the pricing page
        </Link>
        , and they are what the plans will cost at 1.0. Nothing is charged while xecret is in
        pre-alpha.
      </>
    ),
    items: [
      {
        question: 'What does xecret cost?',
        answer:
          'Free is $0 forever: 1 organisation, 5 projects, 3 members, 3 environments per project, 7 days of audit history, the CLI and CI tokens, and community support on GitHub. Team is $9 per member per month, or $7 billed yearly, and adds unlimited organisations, projects, members and environments, 12 months of audit history, roles and per-environment access, service tokens and email support. Business is $19 per member per month, or $15 billed yearly, for three years of audit history and priority support, and names SAML single sign-on, which is not built yet. Enterprise is custom and covers SCIM provisioning, custom audit retention, a self-hosting support contract, invoiced billing and an SLA. Self-hosting is free, always.',
      },
      {
        question: 'Do I need a card to try it?',
        answer:
          'No. While xecret is in pre-alpha every paid feature is switched on for everybody and no card is collected at all. The prices are published now anyway, so that nobody is surprised at 1.0.',
      },
      {
        question: 'Is the free tier really free?',
        answer:
          'Yes — $0 forever, not a trial that expires into a quote. It is capped at one organisation, five projects, three members, three environments per project and seven days of audit history, and those are honest limits rather than a nag screen. Everything else on it behaves exactly as it does on the paid plans.',
      },
      {
        question: 'What counts as a member?',
        answer:
          'A person with a membership in your organisation. Service tokens are not people and never take a seat, so a CI pipeline costs nothing however many jobs it runs. The seat count is checked when an invitation is accepted, inside the same transaction that creates the membership.',
      },
      {
        question: 'How long is audit history kept?',
        answer:
          'Thirty days on Free, twelve months on Team, and whatever you specify on Enterprise, which can also export the log. Retention decides how far back you can read, not whether an event was recorded.',
      },
      {
        question: 'Is self-hosting limited compared to the hosted version?',
        answer:
          'No. You get the whole server under AGPL-3.0, with no licence key, no feature flag and no seat count. What an Enterprise contract buys is support and paperwork, not capability.',
      },
      {
        question: 'What happens to my data if I downgrade or stop paying?',
        answer:
          'Your secrets stay yours and stay readable, and you can export all of them at any time from the CLI or the dashboard. A secret manager you cannot get your configuration out of has taken it hostage, which is not a retention strategy we are interested in.',
      },
    ],
  },
  {
    id: 'cli',
    navLabel: 'CLI',
    eyebrow: 'The CLI',
    title: 'Running your app through xecret',
    lede: (
      <>
        Once you are actually using it, the{' '}
        <Link href="/docs/faq" className={INLINE_LINK}>
          documentation FAQ
        </Link>{' '}
        covers the day-to-day questions in more detail, and{' '}
        <Link href="/docs/cli/offline-cache" className={INLINE_LINK}>
          the offline cache page
        </Link>{' '}
        states the fallback rule exactly, including the cases where it deliberately does not apply.
      </>
    ),
    items: [
      {
        question: 'What does xecret run actually do?',
        answer:
          'It works out which project and environment you are in, fetches that environment, and execs your command with the values already in its environment. Nothing is written to disk. Signals are forwarded, so Ctrl-C reaches your application rather than the wrapper.',
      },
      {
        question: 'Does it work offline — on a plane, for instance?',
        answer:
          'For xecret run, yes. The CLI keeps an encrypted copy of the last environment it fetched and falls back to it when the API cannot be reached, printing the age of that copy to stderr so day-old configuration never passes silently. The first run in a given environment needs a network, because that is what fills the cache.',
      },
      {
        question: 'What happens if the network drops in the middle of a deploy?',
        answer:
          'A DNS failure, a timeout or a 5xx falls back to the cache, loudly. A 401, 403 or 404 does not, because those are decisions rather than outages — and the most important of them is revocation, which has to take effect immediately rather than immediately-unless-the-laptop-is-offline. CI has no cache at all, deliberately.',
      },
      {
        question: 'How do I import the .env file I already have?',
        answer:
          'Drag it into the import dialog. It is parsed in your browser and a dry-run preview shows exactly what will be created, renamed or skipped, so a pasted blob of production credentials never becomes a request body. The CLI has the same importer with the same dry run, and dotenv, JSON, YAML and shell formats are all detected.',
      },
      {
        question: 'Can I get everything back out again?',
        answer:
          'Yes — xecret pull writes five different formats, and the dashboard has an export dialog. There is no export fee and no lock-in mechanism. Version history is the one thing a bulk export does not carry.',
      },
      {
        question: 'How does CI get secrets?',
        answer:
          'Through a service token. A service token is not a person: it is pinned to one project and one environment, it is read-only unless you deliberately make it otherwise, and it can never delete a secret at any access level. Put it in XECRET_TOKEN on the runner and your existing xecret run command works there too.',
      },
      {
        question: 'Can I run several environments at the same time?',
        answer:
          'Yes. Pass --environment on each command and every process gets its own set of values, with nothing shared between them. The dashboard marks production with a reserved colour, an uppercase label and hazard hatching, so which environment you are looking at survives both a small screen and colour blindness.',
      },
    ],
  },
  {
    id: 'teams',
    navLabel: 'Teams',
    eyebrow: 'Teams and access',
    title: 'Members, roles and per-environment access',
    lede: (
      <>
        Roles, grants and the order they resolve in are written out in full in{' '}
        <Link href="/docs/guides/teams" className={INLINE_LINK}>
          the teams and access guide
        </Link>
        , including why production is denied by default to the people who write the code that uses
        it.
      </>
    ),
    items: [
      {
        question: 'How do I invite somebody?',
        answer:
          'From Members, with an email address and a role. The link is single-use, and accepting it requires being signed in as that same address, so a forwarded invitation cannot let a colleague join as somebody else. You cannot invite anybody at a role above your own.',
      },
      {
        question: 'What roles are there?',
        answer:
          'Four, ordered viewer, developer, admin, owner. The role is organisation-wide and decides what class of action is open to you at all: an admin manages members, tokens and projects; a developer reads and writes secrets where granted; a viewer only reads. Deleting the organisation is the owner alone.',
      },
      {
        question: 'Can I control access per environment?',
        answer:
          'Yes. Access levels — none, read, write, admin — are granted on a whole project or on a single environment, and the more specific grant wins. A grant can never exceed the role: an environment grant cannot turn a viewer into somebody who writes.',
      },
      {
        question: 'Can a developer see production by default?',
        answer:
          'No. Developers and viewers get none on production, and reaching it takes an explicit grant from somebody who manages members — a grant written to the audit log with a name attached. The alternative, production behaving like every other environment until somebody remembers to lock it down, makes the safe state the one that requires work.',
      },
      {
        question: 'How do I remove somebody who leaves?',
        answer:
          'Remove their membership. Their sessions and CLI tokens stop working straight away, and the offline cache does not soften that: the CLI treats a rejection as a decision and fails, rather than falling back to a cached copy on their laptop.',
      },
      {
        question: 'What can a departing employee still see?',
        answer:
          'Nothing new, and everything they already copied. Removing somebody revokes access; it cannot un-read a value they read last month. The audit log tells you exactly which secrets they decrypted and when, and that list is what you rotate — which is the whole reason every decryption is recorded.',
      },
    ],
  },
  {
    id: 'open-source',
    navLabel: 'Open source',
    eyebrow: 'Open source and self-hosting',
    title: 'The licence, running it yourself, and leaving',
    lede: (
      <>
        The server, the CLI and the threat model are all in{' '}
        <a href={REPO_URL} target="_blank" rel="noreferrer noopener" className={INLINE_LINK}>
          the public repository
        </a>
        , and{' '}
        <Link href="/docs/self-hosting" className={INLINE_LINK}>
          self-hosting
        </Link>{' '}
        has a page of its own — including the dependency list we would rather you read before you
        start than discover halfway through.
      </>
    ),
    items: [
      {
        question: 'Is xecret actually open source?',
        answer:
          'Yes, and you can read all of it before you sign up for anything. The server is AGPL-3.0 and the CLI is MIT. There is no open-core arrangement where the interesting half lives in a private repository.',
      },
      {
        question: 'Why is the server AGPL and the CLI MIT?',
        answer:
          'The AGPL means that if you modify the server and offer it to other people as a network service, you publish your changes. The CLI is MIT because it ships inside your Docker images and your CI runners, where a copyleft licence would be friction with no security benefit to anybody.',
      },
      {
        question: 'What do I need to run it myself?',
        answer:
          'Cloudflare Workers on a paid plan, a PostgreSQL database, a Cloudflare Secrets Store binding to hold the root key, and a Firebase project for identity. The Firebase requirement is real friction and the documentation says so rather than burying it; an identity-provider interface exists so that a Postgres-native alternative can be contributed. Mail is optional — without it, invitations become a shareable link instead of an email.',
      },
      {
        question: 'Are any features held back from the self-hosted build?',
        answer:
          'None. It is the same server that runs the hosted product, with nothing gated behind a licence check. If a feature exists, it exists for you.',
      },
      {
        question: 'What happens to my data if Playxoft disappears?',
        answer:
          'You export it, or you run the server yourself, and neither path needs us to still be here. The source is published under a licence that cannot be withdrawn from the copies already released, and self-hosting is a documented path rather than a theoretical right.',
      },
      {
        question: 'Can I fork it?',
        answer:
          'Yes. That is what the licence is for. If your fork is a modified server you offer to other people over a network, the AGPL asks you to publish your changes; beyond that, go ahead.',
      },
    ],
  },
];

/** The `FAQPage` payload, in render order by construction. See the note above. */
const ALL_QUESTIONS: readonly FaqItem[] = CATEGORIES.flatMap((category) => category.items);

const HELP_CARD =
  'border-line bg-surface hover:border-line-strong hover:bg-surface-hover block rounded-xl ' +
  'border p-5 transition-colors';

export default function FaqPage() {
  return (
    <PublicPage>
      <JsonLd
        data={graph(faqSchema(ALL_QUESTIONS), breadcrumbSchema([{ name: 'FAQ', path: '/faq' }]))}
      />

      <PageHero
        eyebrow="Frequently asked"
        title="The questions you ask before you trust a secrets manager."
        description={`${ALL_QUESTIONS.length} answers about how xecret works, what it costs, what it can see and what happens when you leave — including the several where the honest answer is no.`}
      >
        {/* Plain `#` anchors rather than a scroll-spy component. Six categories
            is exactly the length at which a reader wants to jump, and an anchor
            works with no JavaScript, survives being copied out of the address
            bar, and is what the browser's own back button already understands. */}
        <nav aria-label="Question categories" className="flex flex-wrap justify-center gap-2">
          {CATEGORIES.map((category) => (
            <a
              key={category.id}
              href={`#${category.id}`}
              className="border-line bg-surface text-fg-muted hover:border-line-strong hover:text-fg rounded-full border px-3.5 py-1.5 text-sm transition-colors"
            >
              {category.navLabel}
            </a>
          ))}
        </nav>
      </PageHero>

      {CATEGORIES.map((category, index) => (
        <Section
          key={category.id}
          id={category.id}
          // Alternating gives a page this long its horizon lines; without them
          // forty-odd questions are one uninterrupted scroll and the reader
          // loses track of which category they are in.
          tone={index % 2 === 0 ? 'canvas' : 'inset'}
          // Six named landmarks, which is precisely how a screen-reader user
          // moves between categories — the job the jump links above do for
          // everybody else.
          aria-labelledby={`${category.id}-heading`}
        >
          {/* Centred heading over a centred accordion, both on the same
              measure. Left-aligned, each category was a heading and a 3xl
              paragraph against the left edge of an 80rem page, with the empty
              right half repeated six times down the scroll — the one thing a
              long page cannot afford. */}
          <SectionHeading
            eyebrow={category.eyebrow}
            title={category.title}
            description={category.lede}
            headingId={`${category.id}-heading`}
            align="center"
            className="mx-auto max-w-3xl"
          />
          <Reveal className="mx-auto mt-10 max-w-3xl">
            <Faq items={category.items} />
          </Reveal>
        </Section>
      ))}

      <Section id="still-stuck" aria-labelledby="still-stuck-heading">
        <SectionHeading
          eyebrow="Not answered here"
          title="Still stuck?"
          description={
            <>
              Short answers have a limit. The longer arguments — why .env files rot, what an audit
              log is actually for — are on{' '}
              <Link href="/blog" className={INLINE_LINK}>
                the blog
              </Link>
              .
            </>
          }
          headingId="still-stuck-heading"
          align="center"
        />

        {/* Three cards, three columns, equal height — the row divides
              exactly, so there is no ragged tail under a centred heading. */}
        <RevealGroup className="mx-auto mt-10 grid max-w-5xl gap-4 sm:grid-cols-3">
          <Link href="/docs" className={HELP_CARD}>
            <BookIcon className="text-fg-subtle size-5" aria-hidden="true" />
            <h3 className="text-fg mt-3 text-base font-semibold">The documentation</h3>
            <p className="text-fg-muted mt-1.5 text-sm leading-6">
              Concepts, framework guides and the full command reference — every answer that is
              longer than a paragraph.
            </p>
          </Link>

          <Link href="/docs/troubleshooting" className={HELP_CARD}>
            <AlertCircleIcon className="text-fg-subtle size-5" aria-hidden="true" />
            <h3 className="text-fg mt-3 text-base font-semibold">Troubleshooting</h3>
            <p className="text-fg-muted mt-1.5 text-sm leading-6">
              Every error message the CLI and the API produce, what it actually means, and the fix.
            </p>
          </Link>

          <a href={REPO_URL} target="_blank" rel="noreferrer noopener" className={HELP_CARD}>
            <GitHubIcon className="text-fg-subtle size-5" aria-hidden="true" />
            <h3 className="text-fg mt-3 text-base font-semibold">The repository</h3>
            <p className="text-fg-muted mt-1.5 text-sm leading-6">
              Read the source, open an issue, or file a private security advisory. No account needed
              for any of it.
            </p>
          </a>
        </RevealGroup>
      </Section>

      <CtaBand
        title="Read the answers, then read the source."
        description="Nothing on this page asks you to take our word for it. Create a project, import the .env file you already have, and check the audit log afterwards to see exactly what was read."
      />
    </PublicPage>
  );
}

import Link from 'next/link';

// Deliberately not the barrels — see the note in app/layout.tsx. This page is
// prerendered and public; it should not carry a byte of the dashboard.
import { PlayxoftMark, Wordmark } from '@/components/layout/logo';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import {
  ArrowRightIcon,
  BookIcon,
  ExternalLinkIcon,
  GitHubIcon,
  ShieldCheckIcon,
} from '@/components/ui/icons';
import { CliDemo } from './cli-demo';

const REPO_URL = 'https://github.com/playxoft/xecret';
const DOCS_URL = 'https://github.com/playxoft/xecret/tree/main/docs';
const THREAT_MODEL_URL =
  'https://github.com/playxoft/xecret/blob/main/docs/security/threat-model.md';
const TRUST_MODEL_URL = 'https://github.com/playxoft/xecret/blob/main/docs/adr/0001-trust-model.md';

const RUN_COMMAND = 'xecret run -- npm run dev';

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

export default function LandingPage() {
  return (
    <div className="bg-canvas flex min-h-dvh flex-col">
      <a
        href="#main-content"
        className="bg-surface text-fg border-line sr-only z-50 rounded-md border px-3 py-2 text-sm focus:not-sr-only focus:absolute focus:top-3 focus:left-3"
      >
        Skip to content
      </a>

      <header className="border-line-subtle border-b">
        <div className="mx-auto flex h-16 w-full max-w-5xl items-center gap-4 px-5">
          <Wordmark />
          <span className="border-line text-fg-subtle ml-1 hidden rounded-full border px-2 py-0.5 text-[0.6875rem] sm:inline">
            Pre-alpha
          </span>
          <nav aria-label="Primary" className="ml-auto flex items-center gap-1">
            <Button asChild variant="ghost" size="sm">
              <a href={DOCS_URL} target="_blank" rel="noreferrer noopener">
                <BookIcon className="size-4" />
                <span className="hidden sm:inline">Docs</span>
              </a>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <a href={REPO_URL} target="_blank" rel="noreferrer noopener">
                <GitHubIcon className="size-4" />
                <span className="hidden sm:inline">GitHub</span>
              </a>
            </Button>
            <Button asChild variant="primary" size="sm" className="ml-1">
              <Link href="/sign-in">Sign in</Link>
            </Button>
          </nav>
        </div>
      </header>

      <main id="main-content" className="flex-1">
        <section className="relative overflow-hidden">
          <div
            aria-hidden="true"
            className="bg-accent/12 pointer-events-none absolute top-[-16rem] left-1/2 size-[40rem] -translate-x-1/2 rounded-full blur-[150px]"
          />
          <div className="relative mx-auto w-full max-w-5xl px-5 pt-16 pb-14 sm:pt-24 sm:pb-20">
            <h1 className="text-fg max-w-2xl text-3xl leading-[1.15] font-semibold tracking-tight sm:text-[2.75rem]">
              Secret management that gets out of your way.
            </h1>
            <p className="text-fg-muted mt-5 max-w-xl text-base leading-7">
              xecret stores your environment variables once, encrypted per environment, and injects
              them into whatever you are running — locally, in CI, in production. No{' '}
              <code className="text-fg-muted font-mono text-[0.85em]">.env</code> file on disk, no
              credentials in Slack, no &ldquo;works on my machine&rdquo;.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button asChild variant="primary" size="lg">
                <Link href="/sign-up">
                  Start free
                  <ArrowRightIcon className="size-4" />
                </Link>
              </Button>
              <Button asChild variant="secondary" size="lg">
                <a href={REPO_URL} target="_blank" rel="noreferrer noopener">
                  <GitHubIcon className="size-4" />
                  Read the source
                </a>
              </Button>
            </div>

            <CliDemo />

            <div className="border-line bg-surface mt-3 flex max-w-xl items-center gap-2 rounded-lg border px-3 py-2">
              <code className="text-fg-muted min-w-0 flex-1 font-mono text-[0.8125rem] break-all">
                <span className="text-fg-subtle select-none">$ </span>
                {RUN_COMMAND}
              </code>
              <CopyButton value={RUN_COMMAND} label="the run command" />
            </div>
          </div>
        </section>

        <section
          aria-labelledby="how-it-works"
          className="border-line-subtle bg-canvas-inset/50 border-y"
        >
          <div className="mx-auto w-full max-w-5xl px-5 py-14 sm:py-16">
            <h2 id="how-it-works" className="text-fg text-lg font-semibold tracking-tight">
              Sixty seconds, start to finish
            </h2>
            <ol className="mt-7 grid gap-6 sm:grid-cols-3 sm:gap-8">
              {STEPS.map((step, index) => (
                <li key={step.title}>
                  <span
                    aria-hidden="true"
                    className="border-accent-line bg-accent-tint text-accent-text mb-3 grid size-7 place-items-center rounded-md border text-xs font-semibold"
                  >
                    {index + 1}
                  </span>
                  <h3 className="text-fg text-sm font-semibold">{step.title}</h3>
                  <p className="text-fg-muted mt-1.5 text-sm leading-6">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section
          aria-labelledby="security"
          className="mx-auto w-full max-w-5xl px-5 py-14 sm:py-16"
        >
          <div className="border-line bg-surface flex max-w-3xl flex-col gap-4 rounded-xl border p-6 sm:p-7">
            <div className="flex items-center gap-2.5">
              <ShieldCheckIcon className="text-accent-text size-5 shrink-0" />
              <h2 id="security" className="text-fg text-base font-semibold tracking-tight">
                What xecret can and cannot see
              </h2>
            </div>
            {/* The honest version, on the marketing page rather than buried in
                a document nobody reads before signing up. A security product
                that overstates its guarantees has broken the only thing it
                sells. */}
            <p className="text-fg-muted text-sm leading-7">
              xecret uses server-side envelope encryption. Every environment has its own data key,
              which is itself encrypted under a root key we hold; values are decrypted only inside a
              single request handler, and every decryption is written to an append-only audit log.
              That means we <span className="text-fg font-medium">can</span> technically decrypt
              your secrets — it is the same model Doppler uses, and it is what makes team sharing,
              CI tokens, and browser-side import work without a key-exchange ceremony. If you need a
              provider that cannot read your secrets even in principle, you need a zero-knowledge
              product, and we would rather you knew that now than after migrating.
            </p>
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
              <a
                href={TRUST_MODEL_URL}
                target="_blank"
                rel="noreferrer noopener"
                className="text-accent-text inline-flex items-center gap-1.5 rounded-sm font-medium hover:underline"
              >
                Trust model
                <ExternalLinkIcon className="size-3.5" />
              </a>
              <a
                href={THREAT_MODEL_URL}
                target="_blank"
                rel="noreferrer noopener"
                className="text-accent-text inline-flex items-center gap-1.5 rounded-sm font-medium hover:underline"
              >
                Threat model
                <ExternalLinkIcon className="size-3.5" />
              </a>
            </div>
          </div>
        </section>

        <section
          aria-labelledby="open-source"
          className="border-line-subtle bg-canvas-inset/50 border-t"
        >
          <div className="mx-auto w-full max-w-5xl px-5 py-14 sm:py-16">
            <h2 id="open-source" className="text-fg text-lg font-semibold tracking-tight">
              Open source, honestly licensed
            </h2>
            <div className="mt-6 grid max-w-3xl gap-6 sm:grid-cols-2 sm:gap-8">
              <div>
                <h3 className="text-fg text-sm font-semibold">Read it before you trust it</h3>
                <p className="text-fg-muted mt-1.5 text-sm leading-6">
                  The server is AGPL-3.0, the CLI is MIT — so the crypto you are trusting is
                  reviewable by anyone, and the binary that ships inside your Docker images and CI
                  pipelines carries a licence your legal team has already approved. The threat
                  model, the key-recovery ceremony and every architecture decision are documents in
                  the repository, not blog-post promises.
                </p>
              </div>
              <div>
                <h3 className="text-fg text-sm font-semibold">Run it yourself</h3>
                <p className="text-fg-muted mt-1.5 text-sm leading-6">
                  Self-hosting is a documented first-class path: Cloudflare Workers, a Neon or
                  vanilla PostgreSQL database, and your own Firebase project for identity. The
                  self-hosting guide states the real dependency list plainly — including the parts
                  that are friction — because an open-source secrets manager that hides its
                  operational costs is not being honest about the one thing it sells.
                </p>
              </div>
            </div>
            <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm">
              <a
                href={`${DOCS_URL}/self-hosting.md`}
                target="_blank"
                rel="noreferrer noopener"
                className="text-accent-text inline-flex items-center gap-1.5 rounded-sm font-medium hover:underline"
              >
                Self-hosting guide
                <ExternalLinkIcon className="size-3.5" />
              </a>
              <a
                href={`https://github.com/playxoft/xecret/blob/main/CONTRIBUTING.md`}
                target="_blank"
                rel="noreferrer noopener"
                className="text-accent-text inline-flex items-center gap-1.5 rounded-sm font-medium hover:underline"
              >
                Contributing
                <ExternalLinkIcon className="size-3.5" />
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-line-subtle border-t">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-5 py-8 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <Wordmark />
            <PlayxoftMark />
          </div>
          <nav
            aria-label="Footer"
            className="text-fg-muted flex flex-wrap items-center gap-x-5 gap-y-2 text-sm"
          >
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="hover:text-fg rounded-sm"
            >
              Docs
            </a>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="hover:text-fg rounded-sm"
            >
              GitHub
            </a>
            <Link href="/sign-in" className="hover:text-fg rounded-sm">
              Sign in
            </Link>
            <span className="text-fg-subtle text-xs">AGPL-3.0</span>
          </nav>
        </div>
      </footer>
    </div>
  );
}

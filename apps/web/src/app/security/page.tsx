import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactElement } from 'react';

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
// Direct module imports rather than the `components/ui` barrel, for the reason
// given in app/layout.tsx: this page is public and prerendered, and the barrel
// drags the dashboard's dependencies onto it.
import { Button } from '@/components/ui/button';
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  BoxIcon,
  EyeIcon,
  EyeOffIcon,
  FileTextIcon,
  GitHubIcon,
  HistoryIcon,
  KeyIcon,
  LayersIcon,
  LockIcon,
  LogOutIcon,
  MailIcon,
  ShieldCheckIcon,
  ShieldIcon,
  TerminalIcon,
  UsersIcon,
  type IconProps,
} from '@/components/ui/icons';
import {
  DISCLOSURE_COMMITMENTS,
  SECURITY_ADVISORY_URL,
  SECURITY_EMAIL,
  SECURITY_POLICY_URL,
  SECURITY_TXT_PATH,
} from '@/lib/security-contact';
import { absoluteUrl, breadcrumbSchema, REPO_URL, SITE_KEYWORDS, SITE_NAME } from '@/lib/site';

/**
 * `/security` — the page a buyer's security reviewer opens first.
 *
 * It is read by somebody with a questionnaire beside it, or by an assistant
 * filling one in, and both are looking for the same thing: specific facts they
 * can check, and a plain answer where the answer is no. So every sentence here
 * is one the repository can back — the trust model, the audit-log and token
 * documentation, `SECURITY.md`, the privacy policy, the release workflow — and
 * each section ends in a link to the document that states it in full. Nothing
 * is rounded up: no certification we do not hold, no audit that has not
 * happened, no provider the privacy policy does not name.
 *
 * The disclosure channels and response times come from `lib/security-contact.ts`,
 * which `/.well-known/security.txt` reads too, and `marketing-pages.test.ts`
 * fails if `SECURITY.md` stops agreeing with either.
 *
 * ── Layout ──
 * The site's rule, as on `/features` and `/about`: a band is centred, or it is
 * a genuine two-up with something real on both sides. Cards are wrapped one
 * level in inside a `RevealGroup`, for the transition reason `/about` records.
 */

const TITLE = 'Security: end-to-end encrypted secret management';
const DESCRIPTION =
  'How xecret protects your secrets: end-to-end encryption we cannot read, least-privilege access, an append-only audit log, open-source code and a clear vulnerability disclosure process.';

const CANONICAL = absoluteUrl('/security');

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    'secrets manager security',
    'end-to-end encrypted secrets',
    'zero knowledge secret management',
    'vulnerability disclosure',
    'security.txt',
    ...SITE_KEYWORDS,
  ],
  alternates: { canonical: CANONICAL },
  openGraph: {
    type: 'website',
    url: CANONICAL,
    siteName: SITE_NAME,
    title: `${TITLE} · ${SITE_NAME}`,
    description: DESCRIPTION,
  },
};

type IconComponent = (props: IconProps) => ReactElement;

interface Fact {
  readonly title: string;
  readonly body: string;
}

interface IconFact extends Fact {
  readonly icon: IconComponent;
}

const [ACKNOWLEDGEMENT, ASSESSMENT, FIX_PLAN] = DISCLOSURE_COMMITMENTS;

/* ── At a glance ────────────────────────────────────────────────────────────
   The six answers a questionnaire asks for first, each expanded further down. */
const GLANCE: readonly { icon: IconComponent; label: string; value: string }[] = [
  { icon: LockIcon, label: 'Secret values', value: 'AES-256-GCM, encrypted on your device' },
  {
    icon: KeyIcon,
    label: 'Key sharing',
    value: 'X25519, sealed to each member and token — never to us',
  },
  {
    icon: ShieldCheckIcon,
    label: 'Master passphrase',
    value: 'Argon2id, 64 MiB and three passes, on your device',
  },
  { icon: HistoryIcon, label: 'Audit log', value: 'Append-only, enforced by database grant' },
  { icon: GitHubIcon, label: 'Source', value: 'AGPL-3.0 server, MIT CLI, signed releases' },
  {
    icon: MailIcon,
    label: 'Vulnerability reports',
    value: `Acknowledged ${ACKNOWLEDGEMENT.value}`,
  },
];

/* ── Encryption ─────────────────────────────────────────────────────────────
   Stated as the trust model and SECURITY.md state it, parameters included. */
const ENCRYPTION: readonly Fact[] = [
  {
    title: 'A key for every environment',
    body: 'Values and notes are encrypted with AES-256-GCM under a data key generated on the device of the member who creates the environment.',
  },
  {
    title: 'Sealed to people, never to us',
    body: 'That key is sealed with X25519 to the public key of each member and service token given access. No copy is ever sealed to xecret.',
  },
  {
    title: 'Private keys stay wrapped',
    body: 'Your private keys leave your device only wrapped under a User Key, which your master passphrase (Argon2id, 64 MiB, three passes, run on your device), a passkey (WebAuthn PRF) or one of five one-time recovery codes unlocks.',
  },
  {
    title: 'Bound to where it belongs',
    body: 'Every ciphertext is bound to its organisation, environment, secret and version. A row moved anywhere else fails to decrypt instead of quietly succeeding.',
  },
  {
    title: 'Imports never upload plaintext',
    body: 'A .env file is parsed and encrypted in your browser. Only ciphertext is sent.',
  },
  {
    title: 'CI decrypts on the runner',
    body: 'A service token carries its own private key. We keep only the public half and a hash of the part that authenticates, so a pipeline decrypts on its runner, never on our servers.',
  },
];

/** The trust model's own list of what is visible to us, shortened, not softened. */
const WE_CAN_SEE = [
  'Secret names, versions and timestamps — and roughly how long each value is',
  'Organisation, project and environment names',
  'Members, their email addresses, roles and access',
  'The audit log, including IP addresses',
  'Public keys, and so who holds which environment',
] as const;

const NEVER_REACHES_US = [
  'Secret values and notes',
  'Personal overrides and the text of templates',
  'Your master passphrase and recovery codes',
  'Any key in a form that opens something',
] as const;

/* ── Access control ─────────────────────────────────────────────────────── */
const ACCESS: readonly IconFact[] = [
  {
    icon: UsersIcon,
    title: 'Four roles, scoped by grants',
    body: 'Viewer, developer, admin and owner decide what kind of action is available to someone; grants on a project or a single environment decide where. The more specific grant wins, and no grant lifts anyone above their role.',
  },
  {
    icon: ShieldIcon,
    title: 'Production starts closed',
    body: 'Developers and viewers have no access to production until somebody who manages members grants it explicitly. Every grant and revocation is written to the audit log with the previous and new levels.',
  },
  {
    icon: KeyIcon,
    title: 'Service tokens, pinned',
    body: 'Each is pinned to one project and one environment, read-only by default, and can never delete a secret. Expiry is optional; from Pro, so is an IP allowlist, and an organisation can require both.',
  },
  {
    icon: LogOutIcon,
    title: 'Sessions you can end',
    body: 'See every active session and revoke any of them, or sign out everywhere at once. Session cookies are __Host- prefixed, and every change must echo a CSRF token in a header.',
  },
  {
    icon: LockIcon,
    title: 'A vault that locks itself',
    body: 'After an hour idle by default — 15 minutes, 4 hours or when the tab closes if you prefer — and no unlock lasts more than 8 hours. Unlock with your passphrase, a passkey, or a device PIN that five wrong guesses destroy.',
  },
  {
    icon: LayersIcon,
    title: 'Tenants kept apart',
    body: 'Every request is authorised against current database state through one function. A request for another organisation’s resource gets a 404, so even its existence is not confirmed.',
  },
];

/* ── Audit and monitoring ───────────────────────────────────────────────── */
const AUDIT_RECORDED: readonly Fact[] = [
  {
    title: 'Every value fetched',
    body: 'Each pull, run, reveal or export writes a record with the actor, the time and the IP address — at the moment the server hands ciphertext to someone holding the key.',
  },
  {
    title: 'Every change, and every denial',
    body: 'Writes, rotations, grants and revocations, and every refused attempt — a log of what succeeded cannot show an attack in progress.',
  },
  {
    title: 'The right name on every write',
    body: 'A service token’s write is recorded as that token, never as the person who minted it, with a database constraint holding the two apart.',
  },
];

const AUDIT_PROTECTED: readonly Fact[] = [
  {
    title: 'Append-only by database grant',
    body: 'The application’s database role has no UPDATE or DELETE on the audit table. Append-only is a permission, not a convention.',
  },
  {
    title: 'No value can reach a record',
    body: 'Audit metadata is a fixed, type-level allowlist of field names with no catch-all, so the compiler rejects a secret before a reviewer has to spot it.',
  },
  {
    title: 'Filtered when you need it',
    body: 'By actor, action, project, environment, outcome and date range, in the dashboard or over the API.',
  },
];

const ALERTS: readonly (IconFact & { href: string; link: string })[] = [
  {
    icon: HistoryIcon,
    title: 'Webhooks on secret change',
    body: 'A signed HTTPS call when a secret is created, changed, rotated or deleted, or an environment is promoted or restored. Payloads carry names and versions, never values. Pro and above.',
    href: '/docs/features/webhooks',
    link: 'Webhook events and signatures',
  },
  {
    icon: AlertTriangleIcon,
    title: 'Alerts when a new address reads',
    body: 'Owners and admins are emailed the first time an environment is read from an address or device it has not seen before. On by default for production; Pro and above.',
    href: '/docs/features/policies#new-address-read-alerts',
    link: 'How read alerts work',
  },
];

/* ── Infrastructure ─────────────────────────────────────────────────────────
   The privacy policy's sub-processor list, by name and role. That section is
   the authoritative one, and the band links to it rather than restating what
   each provider receives. */
const PROVIDERS = [
  {
    name: 'Cloudflare',
    role: 'Runtime',
    body: 'Workers serves every request across Cloudflare’s global network, with rate limiting at the edge. Secrets Store holds the service’s root key.',
  },
  {
    name: 'Neon',
    role: 'Database',
    body: 'Managed PostgreSQL holding your data — secret values only as ciphertext.',
  },
  {
    name: 'WorkOS',
    role: 'Identity',
    body: 'Verifies who you are on its hosted sign-in page, so xecret never receives your password; xecret then issues its own sessions. It never receives a secret.',
  },
  {
    name: 'ZeptoMail (Zoho)',
    role: 'Email',
    body: 'Transactional mail: invitations, billing notices, and the archive sent when you reset a vault — its values still encrypted.',
  },
  {
    name: 'Dodo Payments',
    role: 'Payments',
    body: 'Merchant of record for paid plans. It holds the card; xecret never sees the number, and Dodo never receives a secret.',
  },
  {
    name: 'Better Stack',
    role: 'Logs',
    body: 'Log shipping, where a deployment enables it. A field whose name suggests a credential is never written to a log.',
  },
] as const;

const HARDENING: readonly Fact[] = [
  {
    title: 'Tokens stored only as hashes',
    body: 'Session, CLI and service tokens alike. Each is shown once and cannot be read back.',
  },
  {
    title: 'Error messages are fixed strings',
    body: 'Never derived from an exception, a database error or the rejected input, because the rejected input may itself be a secret.',
  },
  {
    title: 'A root key that opens no secret',
    body: 'Held in Cloudflare Secrets Store, it protects the service’s own operational secrets, such as webhook signing keys, and opens no end-to-end encrypted value.',
  },
  {
    title: 'Hardened responses',
    body: 'Every page is served over HTTPS with HSTS, a Content Security Policy and framing denied.',
  },
  {
    title: 'An offline cache that cannot soften a revocation',
    body: 'The CLI keeps ciphertext and sealed keys so a local run keeps working through a network outage — and fails, rather than falling back, on a 401, 403 or 404.',
  },
  {
    title: 'CLI credentials in the keychain',
    body: 'xecret login stores its token in your OS keychain, or a file only you can read where there is none, after a browser consent flow with PKCE.',
  },
];

/* ── Open source ────────────────────────────────────────────────────────── */
const OPEN_SOURCE: readonly IconFact[] = [
  {
    icon: GitHubIcon,
    title: 'An AGPL-3.0 server',
    body: 'The server, the dashboard and the cryptography they share live in one public repository. The cryptography and authorisation logic sit in a package that imports nothing runtime-specific, so both can be audited in isolation.',
  },
  {
    icon: TerminalIcon,
    title: 'A CLI you can verify',
    body: 'MIT-licensed Go, buildable from source. Releases are built in CI, signed keylessly with Sigstore cosign, shipped with an SBOM for every archive, and published only after a person reviews the draft. The npm packages carry provenance.',
  },
  {
    icon: FileTextIcon,
    title: 'The specification, in public',
    body: 'The byte-level encryption format with its test vectors, the threat model and every architecture decision are documents in the repository, so an auditor can check the implementation against them.',
  },
  {
    icon: BoxIcon,
    title: 'Self-hosting, nothing held back',
    body: 'The self-hosted server is the same server, with no feature held back and no licence key. Whoever operates it cannot read end-to-end encrypted values either.',
  },
];

const REPO_DOCS = [
  {
    href: `${REPO_URL}/blob/main/docs/security/e2ee-crypto-spec.md`,
    label: 'Encryption specification',
  },
  { href: `${REPO_URL}/blob/main/docs/security/threat-model.md`, label: 'Threat model' },
  { href: `${REPO_URL}/tree/main/docs/adr`, label: 'Architecture decisions' },
] as const;

/* ── Compliance and data protection ─────────────────────────────────────────
   Every card is a sentence of the privacy policy, shortened. The deletion
   period is pinned against the purge job by `marketing-pages.test.ts`. */
const COMPLIANCE: readonly Fact[] = [
  {
    title: 'GDPR and UK GDPR rights',
    body: 'Access, correction, erasure, portability, objection and restriction, answered within one month. Export and account deletion are self-service.',
  },
  {
    title: 'A data processing agreement',
    body: 'For what you store in xecret we act as your processor, and your organisation is the controller. Ask for a DPA at support@playxoft.com.',
  },
  {
    title: 'Deletion that finishes',
    body: 'Deleted organisations, projects, environments and secrets are erased for good after 30 days — longer only where your plan’s restore window needs it — by a daily job that records each erasure in the audit log.',
  },
  {
    title: 'Breach notification',
    body: 'The owners of an affected organisation are told without undue delay, and the supervisory authority within 72 hours where the law requires it.',
  },
  {
    title: 'No trackers',
    body: 'No analytics, no advertising pixel, no session recorder and no third-party tag — which is why there is no cookie banner.',
  },
  {
    title: 'Your data stays yours',
    body: 'Never sold, never used to train models, and never used to profile you.',
  },
];

/* ── FAQ ────────────────────────────────────────────────────────────────────
   Plain text, because the same strings are published as the page's FAQPage. */
const FAQ: readonly FaqItem[] = [
  {
    question: 'Can xecret read my secrets?',
    answer:
      'No. Secret values and notes are encrypted on your device — in the browser or the CLI — under a key generated for each environment and sealed only to the members and service tokens you give access to. We store ciphertext and hold no key that opens it, so neither our staff nor anyone who obtains our database can read your values. We can see secret names, organisation, project and environment names, members, and the audit log. The one exception is an older environment created before end-to-end encryption became the default: it stays on server-side encryption, which we can decrypt, until its values are moved to a new environment — and its key settings say so.',
  },
  {
    question: 'What would an attacker get from xecret’s database?',
    answer:
      'Ciphertext, wrapped keys and public keys — nothing that opens a value. Session, CLI and service tokens are stored only as hashes, so a copy of the database yields hashes rather than usable sessions or tokens. The wrapped keys do allow offline guessing at each person’s master passphrase, at Argon2id’s cost of 64 MiB and three passes per guess, which is why a strong passphrase matters. Names and audit metadata are readable, as the trust model lists.',
  },
  {
    question: 'Is xecret SOC 2 or ISO 27001 certified?',
    answer:
      'No. xecret does not hold SOC 2 or ISO 27001 certification, and has not had an external security audit. What a review gets instead is the evidence itself: the source code, the byte-level encryption specification and the threat model are public, and the guarantee that matters most — that we cannot read your secret values — rests on cryptography you can check rather than on a policy we attest to. Under the GDPR and the UK GDPR we act as your processor, and a data processing agreement is available on request at support@playxoft.com.',
  },
  {
    question: 'How do I report a vulnerability?',
    answer: `Privately, through a GitHub security advisory on the xecret repository or by email to ${SECURITY_EMAIL} — never in a public issue. We acknowledge a report ${ACKNOWLEDGEMENT.value}, send an initial assessment ${ASSESSMENT.value}, have a fix or mitigation plan ${FIX_PLAN.value}, and coordinate public disclosure with you after a fix ships. We credit you in the advisory unless you prefer otherwise.`,
  },
  {
    question: 'What happens if I lose my master passphrase?',
    answer:
      'A passkey or any one of your five recovery codes still opens your vault. Lose the passphrase, every recovery code and every passkey, and nobody can open it — including us. There is no escrow and no support reset, because a way round it would be a way for us to read your secrets. Your teammates’ data is unaffected, and they can share their environments with your new vault.',
  },
  {
    question: 'Can I verify the encryption myself?',
    answer:
      'Yes. The server is AGPL-3.0 and the CLI is MIT, in one public repository alongside the byte-level encryption specification, its test vectors and the threat model. The CLI is the client you can check end to end: written in Go, buildable from source, and every release signed with Sigstore cosign. Reading values with it, and running CI with a service token, never involves a page we serve.',
  },
];

/** The small uppercase label that names a panel or a group. */
const LABEL = 'text-fg-subtle text-[0.6875rem] font-semibold tracking-[0.14em] uppercase';

const CARD =
  'border-line bg-surface hover:border-line-strong h-full rounded-xl border p-6 transition-colors';

const EXTERNAL = { target: '_blank', rel: 'noreferrer noopener' } as const;

export default function SecurityPage() {
  return (
    <PublicPage>
      <JsonLd
        data={graph(
          {
            '@type': 'WebPage',
            '@id': `${CANONICAL}#page`,
            url: CANONICAL,
            name: `${TITLE} · ${SITE_NAME}`,
            description: DESCRIPTION,
            inLanguage: 'en',
            isPartOf: { '@id': absoluteUrl('/#website') },
            about: { '@id': absoluteUrl('/#organization') },
            publisher: { '@id': absoluteUrl('/#organization') },
          },
          faqSchema(FAQ),
          breadcrumbSchema([{ name: 'Security', path: '/security' }]),
        )}
      />

      <PageHero
        height="screen"
        eyebrow="Security at xecret"
        title="Your secrets are end-to-end encrypted. We cannot read them."
        description="Secret values are encrypted on your device, under keys shared only with the people and tokens you choose. xecret stores ciphertext it holds no key to open. This page sets out how, what we can see, and how to report a vulnerability."
      >
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button asChild variant="primary" size="lg" className="rounded-full">
            <Link href="/docs/security/trust-model">
              Read the trust model
              <ArrowRightIcon className="size-4" />
            </Link>
          </Button>
          <Button asChild variant="secondary" size="lg" className="rounded-full">
            <a href="#disclosure">
              <MailIcon className="size-4" />
              Report a vulnerability
            </a>
          </Button>
        </div>
      </PageHero>

      {/* ── At a glance ────────────────────────────────────────────────────
          One panel, six cells, hairlines drawn by the grid's own gap — the
          construction `/features` uses, for the same reason: a correct rule
          at every breakpoint with no `nth-child` arithmetic. A `<dl>` because
          each cell is a term and its answer. */}
      <Section id="at-a-glance" aria-labelledby="at-a-glance-heading" tone="inset">
        <SectionHeading
          align="center"
          headingId="at-a-glance-heading"
          eyebrow="At a glance"
          title="The six answers a security review asks for first."
          description="Each is expanded below, and specified in a document you can read in full."
        />
        <Reveal className="mt-12">
          <dl className="border-line bg-line-subtle grid gap-px overflow-hidden rounded-2xl border sm:grid-cols-2 lg:grid-cols-3">
            {GLANCE.map(({ icon: Icon, label, value }) => (
              <div key={label} className="bg-surface flex flex-col p-5 sm:p-6">
                <dt className="flex items-center gap-2.5">
                  <Icon className="text-fg-subtle size-4 shrink-0" />
                  <span className={LABEL}>{label}</span>
                </dt>
                <dd className="text-fg mt-3 text-[0.9375rem] leading-6 font-medium">{value}</dd>
              </div>
            ))}
          </dl>
        </Reveal>
      </Section>

      {/* ── Encryption ─────────────────────────────────────────────────────
          The claim on the left, and on the right the list that makes it worth
          something: what we can see, stated beside what never reaches us. */}
      <Section id="encryption" aria-labelledby="encryption-heading">
        <SectionHeading
          align="center"
          headingId="encryption-heading"
          eyebrow="Encryption"
          title="Encrypted on your device, under keys we never hold."
          description="Every new environment is end-to-end encrypted from its first key. The server stores ciphertext and holds nothing that opens it — not for our staff, not for anyone who obtains our database, and not for anyone who compels us to hand it over."
        />

        <div className="mt-12 grid items-start gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:gap-8">
          <Reveal>
            <ol className="border-line bg-surface divide-line-subtle divide-y rounded-xl border">
              {ENCRYPTION.map((fact, index) => (
                <li key={fact.title} className="flex gap-4 p-5 sm:p-6">
                  <span
                    aria-hidden="true"
                    className="text-fg-subtle mt-0.5 font-mono text-xs font-semibold tabular-nums"
                  >
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <div className="min-w-0">
                    <h3 className="text-fg text-[0.9375rem] leading-6 font-semibold">
                      {fact.title}
                    </h3>
                    <p className="text-fg-muted mt-1.5 text-sm leading-6">{fact.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </Reveal>

          <Reveal delay={120}>
            <div className="border-line bg-surface overflow-hidden rounded-xl border">
              <div className="p-5 sm:p-6">
                <h3 className="flex items-center gap-2.5">
                  <EyeIcon className="text-fg-subtle size-4 shrink-0" />
                  <span className={LABEL}>What we can see</span>
                </h3>
                <ul className="text-fg-muted mt-4 space-y-2.5 text-sm leading-6">
                  {WE_CAN_SEE.map((item) => (
                    <li key={item} className="flex gap-2.5">
                      <span
                        aria-hidden="true"
                        className="bg-line-strong mt-2.5 size-1 shrink-0 rounded-full"
                      />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="border-line-subtle bg-accent-tint border-t p-5 sm:p-6">
                <h3 className="flex items-center gap-2.5">
                  <EyeOffIcon className="text-fg-subtle size-4 shrink-0" />
                  <span className={LABEL}>What never reaches us</span>
                </h3>
                <ul className="text-fg mt-4 space-y-2.5 text-sm leading-6 font-medium">
                  {NEVER_REACHES_US.map((item) => (
                    <li key={item} className="flex gap-2.5">
                      <span
                        aria-hidden="true"
                        className="bg-fg mt-2.5 size-1 shrink-0 rounded-full"
                      />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
              <p className="border-line-subtle text-fg-muted border-t p-5 text-sm leading-6 sm:p-6">
                <span className="text-fg font-medium">One exception, stated plainly.</span> An older
                environment created before end-to-end encryption became the default stays on
                server-side encryption, which we can decrypt, until its values are moved to a new
                environment — and its key settings say so.
              </p>
            </div>
          </Reveal>
        </div>

        <div className="mt-10 flex flex-wrap justify-center gap-x-6 gap-y-3 text-sm">
          <Link href="/docs/security/trust-model" className={QUIET_LINK}>
            The trust model in full
            <ArrowRightIcon className="size-3.5" />
          </Link>
          <Link
            href="/docs/security/trust-model#the-limits-of-the-guarantee"
            className={QUIET_LINK}
          >
            Where the guarantee stops
            <ArrowRightIcon className="size-3.5" />
          </Link>
          <a href={REPO_DOCS[0].href} {...EXTERNAL} className={QUIET_LINK}>
            The byte-level specification
            <ArrowRightIcon className="size-3.5" />
          </a>
        </div>
      </Section>

      {/* ── Access control ─────────────────────────────────────────────── */}
      <Section id="access-control" aria-labelledby="access-control-heading" tone="inset">
        <SectionHeading
          align="center"
          headingId="access-control-heading"
          eyebrow="Access control"
          title="Least access by default, and every grant on the record."
          description="Roles and grants come with Team and Enterprise: roles decide what kind of action exists for someone, grants decide where, and production starts closed. On every plan, credentials are scoped to the job they do."
        />
        <IconCardGrid items={ACCESS} />
        <div className="mt-10 flex flex-wrap justify-center gap-x-6 gap-y-3 text-sm">
          <Link href="/docs/guides/teams" className={QUIET_LINK}>
            Roles and per-environment access
            <ArrowRightIcon className="size-3.5" />
          </Link>
          <Link href="/docs/api/tokens" className={QUIET_LINK}>
            Sessions, CLI tokens and service tokens
            <ArrowRightIcon className="size-3.5" />
          </Link>
          <Link href="/docs/features/policies" className={QUIET_LINK}>
            Token policies
            <ArrowRightIcon className="size-3.5" />
          </Link>
        </div>
      </Section>

      {/* ── Audit and monitoring ───────────────────────────────────────────
          A genuine two-up — what is written down, and why it can be trusted
          — then the two ways the log comes to you rather than waiting to be
          read. */}
      <Section id="audit" aria-labelledby="audit-heading">
        <SectionHeading
          align="center"
          headingId="audit-heading"
          eyebrow="Audit and monitoring"
          title="Every value fetched leaves a record the application cannot alter."
          description="Encryption keeps a value private; the audit log tells you who was handed it. Owners and admins read it in the dashboard or over the API."
        />

        <RevealGroup className="mt-12 grid gap-4 md:grid-cols-2">
          <div>
            <FactPanel icon={HistoryIcon} label="What is recorded" facts={AUDIT_RECORDED} />
          </div>
          <div>
            <FactPanel icon={LockIcon} label="Why you can rely on it" facts={AUDIT_PROTECTED} />
          </div>
        </RevealGroup>

        <RevealGroup className="mt-4 grid gap-4 md:grid-cols-2">
          {ALERTS.map(({ icon: Icon, title, body, href, link }) => (
            <div key={title}>
              <div className={`${CARD} flex flex-col`}>
                <div className="flex items-center gap-3">
                  <Icon className="text-fg-subtle size-5 shrink-0" />
                  <h3 className="text-fg text-base font-semibold">{title}</h3>
                </div>
                <p className="text-fg-muted mt-3 text-sm leading-6">{body}</p>
                <Link href={href} className={`${QUIET_LINK} mt-auto pt-4 text-sm`}>
                  {link}
                  <ArrowRightIcon className="size-3.5" />
                </Link>
              </div>
            </div>
          ))}
        </RevealGroup>

        <div className="mt-10 flex justify-center text-sm">
          <Link href="/docs/security/audit-log" className={QUIET_LINK}>
            Every event the audit log records
            <ArrowRightIcon className="size-3.5" />
          </Link>
        </div>
      </Section>

      {/* ── Infrastructure ─────────────────────────────────────────────────
          Who runs what, beside how it is hardened. The provider list is the
          privacy policy's, and the link at the foot goes to it. */}
      <Section id="infrastructure" aria-labelledby="infrastructure-heading" tone="inset">
        <SectionHeading
          align="center"
          headingId="infrastructure-heading"
          eyebrow="Infrastructure"
          title="Where xecret runs, and how it is hardened."
          description="The hosted service runs on these providers and nothing else. Each is named in the privacy policy with what it receives, and a new one is listed there before it processes anything."
        />

        <RevealGroup className="mt-12 grid gap-4 lg:grid-cols-2">
          <div>
            <div className="border-line bg-surface h-full rounded-xl border">
              <h3 className="border-line-subtle flex items-center gap-2.5 border-b px-5 py-4 sm:px-6">
                <LayersIcon className="text-fg-subtle size-4 shrink-0" />
                <span className={LABEL}>Providers</span>
              </h3>
              <dl className="divide-line-subtle divide-y">
                {PROVIDERS.map((provider) => (
                  <div key={provider.name} className="px-5 py-4 sm:px-6">
                    <dt className="flex items-baseline justify-between gap-4">
                      <span className="text-fg text-[0.9375rem] font-semibold">
                        {provider.name}
                      </span>
                      <span className="text-fg-subtle font-mono text-[0.6875rem] tracking-[0.12em] uppercase">
                        {provider.role}
                      </span>
                    </dt>
                    <dd className="text-fg-muted mt-1.5 text-sm leading-6">{provider.body}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
          <div>
            <FactPanel icon={ShieldCheckIcon} label="Hardening" facts={HARDENING} />
          </div>
        </RevealGroup>

        <div className="mt-10 flex flex-wrap justify-center gap-x-6 gap-y-3 text-sm">
          <Link href="/privacy#sub-processors" className={QUIET_LINK}>
            Every sub-processor, and what it receives
            <ArrowRightIcon className="size-3.5" />
          </Link>
          <Link href="/docs/cli/offline-cache" className={QUIET_LINK}>
            How the offline cache decides
            <ArrowRightIcon className="size-3.5" />
          </Link>
        </div>
      </Section>

      {/* ── Open source ────────────────────────────────────────────────── */}
      <Section id="open-source" aria-labelledby="open-source-heading">
        <SectionHeading
          align="center"
          headingId="open-source-heading"
          eyebrow="Open source and verifiable"
          title="Nothing on this page has to be taken on trust."
          description="The code that encrypts, the format it writes and the threats it was designed against are public, in one repository."
        />
        <IconCardGrid items={OPEN_SOURCE} columns="two" />
        <div className="mt-10 flex flex-wrap justify-center gap-x-6 gap-y-3 text-sm">
          {REPO_DOCS.map((doc) => (
            <a key={doc.href} href={doc.href} {...EXTERNAL} className={QUIET_LINK}>
              {doc.label}
              <ArrowRightIcon className="size-3.5" />
            </a>
          ))}
          <Link href="/docs/self-hosting" className={QUIET_LINK}>
            The self-hosting guide
            <ArrowRightIcon className="size-3.5" />
          </Link>
        </div>
      </Section>

      {/* ── Vulnerability disclosure ───────────────────────────────────────
          The channels beside the commitments. Both come from SECURITY.md by
          way of `lib/security-contact.ts`, which security.txt reads too. */}
      <Section id="disclosure" aria-labelledby="disclosure-heading" tone="inset">
        <SectionHeading
          align="center"
          headingId="disclosure-heading"
          eyebrow="Vulnerability disclosure"
          title="Report a vulnerability privately, and hold us to these times."
          description="We would rather hear about a problem early and awkwardly than late and publicly. Please never report one in a public GitHub issue."
        />

        <RevealGroup className="mt-12 grid gap-4 lg:grid-cols-2">
          <div>
            <div className={`${CARD} flex flex-col`}>
              <h3 className={LABEL}>Two private channels</h3>
              <ul className="divide-line-subtle border-line-subtle mt-4 divide-y border-y">
                <li className="flex items-start gap-3 py-4">
                  <GitHubIcon className="text-fg-subtle mt-0.5 size-5 shrink-0" />
                  <div className="min-w-0">
                    <a href={SECURITY_ADVISORY_URL} {...EXTERNAL} className={QUIET_LINK}>
                      Open a private security advisory
                    </a>
                    <p className="text-fg-muted mt-1 text-sm leading-6">
                      The report stays between you and the maintainers, and the advisory is
                      published from the same thread.
                    </p>
                  </div>
                </li>
                <li className="flex items-start gap-3 py-4">
                  <MailIcon className="text-fg-subtle mt-0.5 size-5 shrink-0" />
                  <div className="min-w-0">
                    <a href={`mailto:${SECURITY_EMAIL}`} className={QUIET_LINK}>
                      {SECURITY_EMAIL}
                    </a>
                    <p className="text-fg-muted mt-1 text-sm leading-6">
                      Either channel is fine — use the one you prefer.
                    </p>
                  </div>
                </li>
              </ul>
              <p className="text-fg-muted mt-4 text-sm leading-6">
                Include the affected component, reproduction steps and what an attacker could
                achieve — a rough report is more useful than none. A suspected weakness in the
                cryptography is high severity: say so in the subject line.
              </p>
              <p className="text-fg-muted mt-3 text-sm leading-6">
                In scope: the web application, the API, the CLI, the cryptographic design,
                authorisation logic and the published release artifacts.
              </p>
            </div>
          </div>
          <div>
            <div className={`${CARD} flex flex-col`}>
              <h3 className={LABEL}>What we commit to</h3>
              <dl className="divide-line-subtle border-line-subtle mt-4 divide-y border-y">
                {DISCLOSURE_COMMITMENTS.map((commitment) => (
                  <div
                    key={commitment.label}
                    className="flex flex-col gap-1 py-3.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6"
                  >
                    <dt className="text-fg-muted text-sm">{commitment.label}</dt>
                    <dd className="text-fg text-sm font-medium sm:text-right">
                      {commitment.value}
                    </dd>
                  </div>
                ))}
                <div className="flex flex-col gap-1 py-3.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
                  <dt className="text-fg-muted text-sm">Credit</dt>
                  <dd className="text-fg text-sm font-medium sm:text-right">
                    in the advisory, unless you prefer otherwise
                  </dd>
                </div>
              </dl>
              <div className="mt-auto flex flex-wrap gap-x-5 gap-y-2 pt-5 text-sm">
                <a href={SECURITY_POLICY_URL} {...EXTERNAL} className={QUIET_LINK}>
                  The full policy, SECURITY.md
                  <ArrowRightIcon className="size-3.5" />
                </a>
                <a href={SECURITY_TXT_PATH} className={QUIET_LINK}>
                  security.txt
                  <ArrowRightIcon className="size-3.5" />
                </a>
              </div>
            </div>
          </div>
        </RevealGroup>
      </Section>

      {/* ── Compliance and data protection ─────────────────────────────────
          The certification answer first, in one sentence, then what an
          organisation can hold us to instead. */}
      <Section id="compliance" aria-labelledby="compliance-heading">
        <SectionHeading
          align="center"
          headingId="compliance-heading"
          eyebrow="Compliance and data protection"
          title="Obligations in writing, and evidence you can check."
          description="xecret does not hold SOC 2 or ISO 27001 certification, and has not had an external security audit. Here is what an organisation gets instead, each item stated in our privacy policy."
        />

        <RevealGroup className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {COMPLIANCE.map((fact) => (
            <div key={fact.title}>
              <div className={CARD}>
                <h3 className="text-fg text-base font-semibold">{fact.title}</h3>
                <p className="text-fg-muted mt-2 text-sm leading-6">{fact.body}</p>
              </div>
            </div>
          ))}
        </RevealGroup>

        <Reveal className="mx-auto mt-8 max-w-3xl">
          <p className="text-fg-muted text-center text-sm leading-7">
            xecret is operated by Playxoft Studios Private Limited, incorporated in India with
            corporate identity number U58203TN2025PTC178070, registered office 19B/1, Ananthapettai
            Street, Kanchipuram, Tamil Nadu 631501, India. Read the{' '}
            <Link href="/privacy" className={QUIET_LINK}>
              privacy policy
            </Link>{' '}
            and the{' '}
            <Link href="/terms" className={QUIET_LINK}>
              terms of service
            </Link>
            , or write to{' '}
            <a href="mailto:support@playxoft.com" className={QUIET_LINK}>
              support@playxoft.com
            </a>
            .
          </p>
        </Reveal>
      </Section>

      <Section id="faq" aria-labelledby="faq-heading" tone="inset">
        <SectionHeading
          align="center"
          headingId="faq-heading"
          eyebrow="Questions"
          title="What security reviewers ask us."
        />
        <Reveal className="mx-auto mt-10 max-w-3xl">
          <Faq items={FAQ} />
          <p className="text-fg-muted mt-6 text-center text-sm leading-7">
            Questions about the product, the plans and leaving are answered on the{' '}
            <Link href="/faq" className={QUIET_LINK}>
              full FAQ
            </Link>
            .
          </p>
        </Reveal>
      </Section>

      <CtaBand
        title="Check every claim on this page."
        description="The server is AGPL-3.0, the CLI is MIT, and the document behind each sentence here is in the repository. Read it, then create a free project and move one environment."
      />
    </PublicPage>
  );
}

/**
 * A grid of icon cards — the access-control and open-source bands.
 *
 * Six cards run three across; four run two across, so neither leaves a hole
 * in the last row.
 */
function IconCardGrid({
  items,
  columns = 'three',
}: {
  items: readonly IconFact[];
  columns?: 'two' | 'three';
}) {
  return (
    <RevealGroup
      className={
        columns === 'three'
          ? 'mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3'
          : 'mt-12 grid gap-4 md:grid-cols-2'
      }
    >
      {items.map(({ icon: Icon, title, body }) => (
        // Wrapper animated by the group; card inside — see `/about`.
        <div key={title}>
          <div className={CARD}>
            <span
              aria-hidden="true"
              className="border-accent-line bg-accent-tint text-accent-text grid size-9 place-items-center rounded-md border"
            >
              <Icon className="size-[1.15rem]" />
            </span>
            <h3 className="text-fg mt-4 text-base font-semibold tracking-tight">{title}</h3>
            <p className="text-fg-muted mt-2 text-sm leading-6">{body}</p>
          </div>
        </div>
      ))}
    </RevealGroup>
  );
}

/** A titled panel of short facts, one per row. */
function FactPanel({
  icon: Icon,
  label,
  facts,
}: {
  icon: IconComponent;
  label: string;
  facts: readonly Fact[];
}) {
  return (
    <div className="border-line bg-surface h-full rounded-xl border">
      <h3 className="border-line-subtle flex items-center gap-2.5 border-b px-5 py-4 sm:px-6">
        <Icon className="text-fg-subtle size-4 shrink-0" />
        <span className={LABEL}>{label}</span>
      </h3>
      <ul className="divide-line-subtle divide-y">
        {facts.map((fact) => (
          <li key={fact.title} className="px-5 py-4 sm:px-6">
            <h4 className="text-fg text-[0.9375rem] leading-6 font-semibold">{fact.title}</h4>
            <p className="text-fg-muted mt-1 text-sm leading-6">{fact.body}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

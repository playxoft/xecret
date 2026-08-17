import type { Metadata } from 'next';

import { graph, LegalPage } from '@/components/marketing';
import type { LegalSection } from '@/components/marketing';
// Not from the barrel: these two are authoring tools for the documents' data,
// not pieces of the public-site kit. `Placeholder` in particular should stop
// existing the day the company details are filled in, and an export nobody can
// see the end of is an export that outlives its reason.
import { LegalLink, Placeholder } from '@/components/marketing/legal-page';
import { absoluteUrl, breadcrumbSchema, REPO_URL, SITE_KEYWORDS, SITE_NAME } from '@/lib/site';

/**
 * The privacy policy for the hosted service.
 *
 * ── The rule this page is written under ──
 * Every claim here is checkable against the code or against
 * `public/docs/security/trust-model.md`, and where a fact does not exist yet —
 * the registered address, the supervisory authority, a support mailbox — the
 * page says so in the rendered text rather than inventing something plausible.
 * A privacy policy on a secrets product is read by exactly the sort of person
 * who checks, and the first invented sentence costs more than the whole
 * document earns.
 *
 * The data categories in section 2 are deliberately specific — column names,
 * cookie names, the two `localStorage` keys — because "we collect certain
 * information to provide and improve our services" is not a disclosure. That
 * specificity is also the maintenance burden: change the session table or add a
 * third cookie and this page is wrong until it is edited.
 */

const TITLE = 'Privacy policy';

const DESCRIPTION =
  'What xecret stores, what our encryption model does and does not protect, who else processes it, how long we keep it, and how to exercise your rights.';

const UPDATED = '2026-08-16';
const EFFECTIVE = '2026-08-16';

const CANONICAL = absoluteUrl('/privacy');

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    'xecret privacy policy',
    'secret manager privacy',
    'gdpr secret management',
    'data processing',
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
  // Legal pages are indexed on purpose. A privacy policy that a search engine
  // cannot see is a privacy policy a buyer's security reviewer cannot find, and
  // finding it is most of what it is for.
  robots: { index: true, follow: true },
};

const SUMMARY = [
  'We hold your email address, the names of your organisations, projects, environments and secrets, the encrypted secret values themselves, and a log of who read or changed what.',
  'xecret can technically decrypt your secret values. Envelope encryption, decryption inside one request handler, and every decryption written to an append-only audit log. This is not a zero-knowledge product and we will not describe it as one.',
  'Secret names, structure and audit metadata are not encrypted the way values are. Treat the name of a secret as something we can read.',
  'We do not sell or share personal information. There is no advertising or analytics cookie on this site — the only two cookies are your session and a CSRF token.',
  'You can export everything with the CLI and delete your own account. If you self-host, none of this is us: the operator of that deployment writes their own policy.',
] as const;

const SECTIONS: readonly LegalSection[] = [
  {
    id: 'who-we-are',
    heading: 'Who we are, and what this covers',
    paragraphs: [
      <>
        xecret is a secret-management service operated by Playxoft (
        <Placeholder>Playxoft legal entity name and company registration number</Placeholder>, of{' '}
        <Placeholder>Playxoft registered address</Placeholder>). Playxoft is the controller for the
        personal data described below, and &ldquo;we&rdquo; means Playxoft throughout.
      </>,
      'This policy covers the hosted service we run, this website, the documentation, and the CLI when it talks to our servers. It does not cover a xecret server that somebody else runs — see section 13.',
      <>
        It sits alongside two documents that say the same things in more detail:{' '}
        <LegalLink href="/docs/security/trust-model">what xecret can and cannot see</LegalLink>, and{' '}
        <LegalLink href="/docs/security/audit-log">the audit log</LegalLink>. Where this page
        summarises the encryption model, those pages are the longer answer, and they agree with each
        other because they are edited together.
      </>,
    ],
  },
  {
    id: 'what-we-collect',
    heading: 'What we collect',
    paragraphs: [
      'By category, because a paragraph of adjectives is not a disclosure.',
      [
        <>
          <strong className="text-fg font-medium">Account identity.</strong> Your email address,
          whether it has been verified, and the identifier Firebase issues for your account. If you
          sign in with Google, that includes the Google account identifier and the display name and
          avatar URL Google returns. We never receive your Google password, and we never see a
          password you set through Firebase: Firebase verifies who you are once, and xecret issues
          its own session afterwards.
        </>,
        <>
          <strong className="text-fg font-medium">Structure.</strong> The names and slugs of your
          organisations, projects and environments, their settings, who is a member of what, each
          member&rsquo;s role, and per-environment access grants.
        </>,
        <>
          <strong className="text-fg font-medium">Secret values.</strong> Encrypted, one ciphertext
          per version, with the version history that lets you roll one back. Section 3 states
          exactly what that encryption protects.
        </>,
        <>
          <strong className="text-fg font-medium">Secret names and metadata.</strong> The name of a
          secret, its versions, when each changed and who changed it. These are{' '}
          <strong className="text-fg font-medium">not</strong> encrypted the way values are. A name
          like <code className="text-fg font-mono text-[0.9em]">STRIPE_LIVE_SECRET_KEY</code> tells
          us — and anybody holding the database — what you keep, though not what it is.
        </>,
        <>
          <strong className="text-fg font-medium">Audit records.</strong> Who read, wrote, revealed
          or deleted what, and when, plus every denial: actor, action, outcome, resource, timestamp
          and a fixed set of metadata fields. No audit record can contain a secret value — the type
          describing that metadata is an allowlist of field names with no catch-all, so the compiler
          rejects an attempt to put one there.
        </>,
        <>
          <strong className="text-fg font-medium">Sessions and devices.</strong> For each browser
          session: its IP address, its user agent, when it was created, when it was last seen, when
          it expires, and when its PIN was last accepted. The session token itself is stored only as
          a hash, so a database dump yields hashes rather than usable sessions.
        </>,
        <>
          <strong className="text-fg font-medium">Token metadata.</strong> For each CLI or service
          token: its name, its prefix, its scope, who created it, and when it was created, expires,
          was last used and was revoked. The token value is stored as a hash and shown to you
          exactly once.
        </>,
        <>
          <strong className="text-fg font-medium">Your PIN, as a hash.</strong> Plus the
          failed-attempt counter and lockout state that stop it being guessed. We cannot recover a
          PIN; a reset link goes to the address on the account.
        </>,
        <>
          <strong className="text-fg font-medium">Request logs.</strong> Method, path, a request
          identifier, Cloudflare&rsquo;s ray id, the IP address, the user agent, and a stable event
          key such as <code className="text-fg font-mono text-[0.9em]">secret.reveal</code>. A field
          whose name suggests a credential is never serialised, and connection strings and
          authorisation headers are scrubbed out of message text by pattern.
        </>,
        <>
          <strong className="text-fg font-medium">Mail we send.</strong> A PIN reset link, and
          organisation invitations to the address you type. That is the whole of it: no newsletter,
          no product marketing, no tracking pixel.
        </>,
      ],
      'There is no analytics on this site. No page-view tracker, no session recorder, no advertising pixel, no fingerprinting script. If that ever changes, this paragraph is the first thing that changes with it.',
    ],
  },
  {
    id: 'trust-model',
    heading: 'What our encryption protects, and what it does not',
    paragraphs: [
      'xecret uses server-side envelope encryption. Every environment has its own data key; that key is encrypted under its organisation’s key, which is itself encrypted under a root key we hold in a Cloudflare Secrets Store binding the database has no access to. Values are AES-256-GCM, and each ciphertext is bound to its exact position in that hierarchy — a row copied from staging into production does not decrypt.',
      'Decryption happens inside a single request handler, and every decryption writes a row to an append-only audit log that the application’s own database credentials cannot alter. An audit row therefore means a plaintext actually left the server.',
      <>
        <strong className="text-fg font-medium">
          Which means xecret can technically decrypt your secret values.
        </strong>{' '}
        It is the same model Doppler uses, and it is what makes team sharing, CI tokens and
        browser-side <code className="text-fg font-mono text-[0.9em]">.env</code> import work
        without a key-exchange ceremony. We do not call xecret zero-knowledge or end-to-end
        encrypted, because it is neither.
      </>,
      'What is not encrypted the way values are: the names of your secrets, organisations, projects and environments; membership, roles and access grants; audit metadata; and everything in the request logs. Those are readable by us and by anybody who obtains the database. The values are not.',
      <>
        If you need a provider that cannot read your secrets even in principle, you need a
        zero-knowledge product, and we would rather you knew that now than after migrating.{' '}
        <LegalLink href="/docs/security/trust-model">What xecret can and cannot see</LegalLink> sets
        out the full key hierarchy and what each kind of compromise yields.
      </>,
    ],
  },
  {
    id: 'why-we-process',
    heading: 'Why we process it, and on what basis',
    paragraphs: [
      'Under the GDPR and the UK GDPR, each thing above rests on one of these:',
      [
        <>
          <strong className="text-fg font-medium">Performance of a contract</strong> (Article
          6(1)(b)) — running the service you signed up for: authenticating you, storing and
          returning your secrets, delivering an invitation to somebody you invited.
        </>,
        <>
          <strong className="text-fg font-medium">Legitimate interests</strong> (Article 6(1)(f)) —
          security and abuse prevention, and keeping the service working: rate limiting, session and
          token records, request logs, and the audit trail. On a secrets product the audit trail is
          the interest: an organisation that cannot tell who read a credential cannot respond to an
          incident.
        </>,
        <>
          <strong className="text-fg font-medium">Legal obligation</strong> (Article 6(1)(c)) —
          records we are required to keep, and responses to lawful requests.
        </>,
        <>
          <strong className="text-fg font-medium">Consent</strong>, where the law requires it. Today
          nothing here relies on it, because there is no marketing mail and no advertising or
          analytics cookie to consent to.
        </>,
      ],
      'Two roles, and the distinction matters. For your account data we are the controller. For what you put into xecret — secrets, names, structure, and the audit records about them — we act as a processor on the instructions of the organisation that owns it, and that organisation is the controller. A standard data processing agreement will be published before general availability; until then, ask for one through the repository.',
      'We do not use your data to train models. We do not profile you, we do not enrich your account from third-party data sources, and we make no automated decision that produces a legal effect for you.',
    ],
  },
  {
    id: 'sub-processors',
    heading: 'Who else processes it',
    paragraphs: [
      'The hosted service runs on these, and on nothing else:',
      [
        <>
          <strong className="text-fg font-medium">Cloudflare</strong> — hosting, the Workers runtime
          that serves every request, the edge network, rate limiting, and the Secrets Store binding
          that holds the root key.
        </>,
        <>
          <strong className="text-fg font-medium">Neon</strong> — the managed PostgreSQL database
          that holds everything in section 2. A self-hosted deployment can use any PostgreSQL.
        </>,
        <>
          <strong className="text-fg font-medium">Google (Firebase Authentication)</strong> —
          identity only. It verifies who you are; xecret issues its own session, and the Firebase
          admin SDK does not run anywhere in this product.
        </>,
        <>
          <strong className="text-fg font-medium">ZeptoMail (Zoho)</strong> — transactional email:
          PIN reset links and organisation invitations.
        </>,
        <>
          <strong className="text-fg font-medium">Better Stack</strong> — log shipping, when a
          deployment is configured for it. When it is not, request logs stay in Cloudflare&rsquo;s
          own tail.
        </>,
      ],
      'We will list a new sub-processor here before it starts processing anything.',
      <>
        If you run xecret yourself, this list is not yours. Your sub-processors are whoever you
        chose to host the Worker, run the database, verify identity and relay mail —{' '}
        <LegalLink href="/docs/self-hosting">the self-hosting guide</LegalLink> names the ones the
        software needs.
      </>,
    ],
  },
  {
    id: 'retention',
    heading: 'How long we keep it',
    paragraphs: [
      [
        <>
          <strong className="text-fg font-medium">Audit records</strong> — 7 days on Free, 12 months
          on Team, 3 years on Business, and whatever an Enterprise agreement states. A single audit
          query returns at most a 90-day window, which is a limit on the query and not on the
          retention.
        </>,
        <>
          <strong className="text-fg font-medium">Secrets</strong> — for as long as the environment
          exists. Deleting a secret soft-deletes it: the ciphertext and its earlier versions stay,
          so that the audit record still refers to something real and so a rollback remains
          possible. They go when the environment, project or organisation is purged.
        </>,
        <>
          <strong className="text-fg font-medium">Soft-deleted records</strong> — purged{' '}
          <Placeholder>
            Playxoft purge window for soft-deleted organisations, projects and secrets
          </Placeholder>{' '}
          after deletion.
        </>,
        <>
          <strong className="text-fg font-medium">Closed accounts</strong> — deleting your account
          revokes every session and CLI token, deletes your PIN, removes you from the organisations
          you are not the last owner of, and soft-deletes the organisations that were only yours.
          The user record itself is soft-deleted rather than erased, because the audit records you
          made have to keep meaning something; the actor&rsquo;s label was written into each record
          at the time, so the log still reads correctly with the account gone. Ask us if you need
          the identity record erased outright.
        </>,
        <>
          <strong className="text-fg font-medium">Sessions</strong> — 30 days from creation, and
          immediately on sign-out or on &ldquo;sign out everywhere&rdquo;.
        </>,
        <>
          <strong className="text-fg font-medium">Request logs</strong> — kept only as long as they
          are useful for debugging and abuse control, by whichever log sink the deployment uses.
          They are not used to build a profile of you.
        </>,
      ],
      'Backups keep their own clock. A record deleted today can survive inside a database backup until that backup rotates — a property of every hosted database, stated here rather than left for you to assume otherwise.',
    ],
  },
  {
    id: 'your-rights',
    heading: 'Your rights',
    paragraphs: [
      'If the GDPR or the UK GDPR applies to you, you have the right to: get access to the personal data we hold about you; have it corrected; have it erased; receive it in a portable, machine-readable form; object to processing we base on a legitimate interest; and ask us to restrict processing while a dispute is being resolved. Where we rely on consent, you can withdraw it.',
      <>
        Two of those are self-service, and faster that way.{' '}
        <strong className="text-fg font-medium">Portability</strong>:{' '}
        <code className="text-fg font-mono text-[0.9em]">xecret pull</code> and the{' '}
        <LegalLink href="/docs/api/reference">HTTP API</LegalLink> export your secrets and their
        structure at any time, in a form another tool can read.{' '}
        <strong className="text-fg font-medium">Erasure of an account</strong>: Settings &rarr;
        delete account, which does everything described in section 6.
      </>,
      <>
        For anything else, ask through the repository —{' '}
        <LegalLink href={`${REPO_URL}/issues`}>open an issue on GitHub</LegalLink> — or at{' '}
        <Placeholder>Playxoft contact email address</Placeholder> once that address exists. We
        answer within one month, which is the period the GDPR allows, and sooner where we can. We
        may have to verify that you are who you say you are before acting on a request about an
        account.
      </>,
      <>
        If a request would mean writing personal information into a public issue, say so in the
        issue <em>without</em> including it, and we will give you a private channel.
      </>,
      <>
        If you think we have got this wrong, you can complain to the data protection authority where
        you live, or to{' '}
        <Placeholder>
          lead supervisory authority for Playxoft&rsquo;s place of establishment
        </Placeholder>
        . We would rather you told us first.
      </>,
    ],
  },
  {
    id: 'california',
    heading: 'California residents',
    paragraphs: [
      'We do not sell personal information, and we do not share it for cross-context behavioural advertising, as the CCPA — as amended by the CPRA — uses those words. We have not done so in the preceding twelve months, and we offer no financial incentive in exchange for personal information.',
      'You may ask what we collect and why (section 2 is that list), ask for a copy, ask for correction, and ask for deletion. There is no “do not sell or share my personal information” link on this site, because there is nothing to opt out of. Exercising any of these rights costs you nothing and changes nothing about the service you receive.',
      'Sensitive personal information: we do not collect it in order to infer characteristics about you. A secret value you store may contain anything you choose to put in it, which is why the value is encrypted and why every reveal is audited.',
    ],
  },
  {
    id: 'transfers',
    heading: 'International transfers',
    paragraphs: [
      <>
        Playxoft is established in{' '}
        <Placeholder>Playxoft&rsquo;s place of establishment</Placeholder>. The sub-processors in
        section 5 are global companies, so your data will be processed outside the country you are
        in.
      </>,
      'Where a transfer leaves the United Kingdom or the EEA, it relies on the European Commission’s standard contractual clauses and the UK international data transfer addendum, together with each provider’s own transfer arrangements. The Workers runtime serves each request from whichever data centre is nearest to the caller and stores nothing; the database that holds your data lives in one region, fixed when the deployment was created.',
    ],
  },
  {
    id: 'cookies',
    heading: 'Cookies and browser storage',
    paragraphs: [
      'Two cookies, both strictly necessary, neither of them a tracker:',
      [
        <>
          <code className="text-fg font-mono text-[0.9em]">__Host-xecret_session</code> — your
          signed-in session. HttpOnly, secure, same-site, and valid for 30 days unless you sign out.
          It carries an opaque token; the server stores only its hash.
        </>,
        <>
          <code className="text-fg font-mono text-[0.9em]">__Host-xecret_csrf</code> — a token this
          site&rsquo;s own JavaScript reads and echoes back, so a form on somebody else&rsquo;s site
          cannot make a request as you. Same lifetime as the session.
        </>,
      ],
      <>
        Two preferences live in <code className="text-fg font-mono text-[0.9em]">localStorage</code>{' '}
        on your own device and are never sent to us:{' '}
        <code className="text-fg font-mono text-[0.9em]">xecret.theme</code> (light, dark or system)
        and <code className="text-fg font-mono text-[0.9em]">xecret.sidebar</code> (whether the
        dashboard sidebar is collapsed).
      </>,
      'There is no advertising cookie, no analytics cookie and no third-party tag on this site. That is why there is no cookie banner: there is nothing to ask you about. If we ever add analytics, this section will say so, and we will ask first where the law requires it.',
    ],
  },
  {
    id: 'security',
    heading: 'How we protect it',
    paragraphs: [
      [
        'Secrets are AES-256-GCM under a per-environment key, wrapped up a four-layer hierarchy whose root key is never in the database.',
        'Session tokens, CLI tokens, service tokens and PINs are stored as hashes. A token is shown once, at creation, and cannot be re-read afterwards.',
        'The application’s database role cannot alter the audit table. It is append-only by grant rather than by discipline.',
        'Error messages returned to a client are fixed strings — never derived from an exception, a database error or the rejected input, because the rejected input may itself be a secret.',
        'Reveals and destructive actions sit behind a PIN lock with an idle auto-lock, so an unattended session cannot read a value.',
      ],
      <>
        No system is perfect, and this one is pre-alpha. If we discover a breach affecting your
        personal data, we will notify the affected organisation&rsquo;s owners without undue delay,
        and the relevant supervisory authority within 72 hours where the law requires it. To report
        a vulnerability, follow{' '}
        <LegalLink href={`${REPO_URL}/blob/main/SECURITY.md`}>SECURITY.md</LegalLink> in the
        repository rather than opening a public issue.
      </>,
    ],
  },
  {
    id: 'children',
    heading: 'Children',
    paragraphs: [
      'xecret is a developer tool and is not directed at children. We do not knowingly collect personal data from anyone under 16. If you believe a child has created an account, tell us and we will delete it.',
    ],
  },
  {
    id: 'self-hosting',
    heading: 'Self-hosted deployments',
    paragraphs: [
      'The server is AGPL-3.0 and running it yourself is a documented, supported path. If you do, this policy does not govern your users: the operator of that deployment is the controller, chooses the database, the identity provider and the mail relay, holds the root key, and writes their own privacy policy.',
      <>
        We receive nothing from a self-hosted instance — no telemetry, no phone-home, no licence
        check. <LegalLink href="/docs/self-hosting">Self-hosting</LegalLink> states the real
        dependency list, including the parts that are friction, and is blunt about the one
        irreversible risk: lose the root key and every secret is unrecoverable.
      </>,
    ],
  },
  {
    id: 'changes',
    heading: 'Changes to this policy',
    paragraphs: [
      'When this policy changes, the date at the top of the page changes with it. For a change that materially affects your rights, we will email the owners of every organisation and announce it in the repository before it takes effect.',
      <>
        This page lives in the same repository as the product, so its history is the git history:
        you can see what it said before, and when it changed, without taking our word for it. That
        is the point of{' '}
        <LegalLink href={REPO_URL}>publishing the source of the thing you are trusting</LegalLink>.
      </>,
    ],
  },
  {
    id: 'contact',
    heading: 'How to contact us',
    paragraphs: [
      <>
        There is no support email address published yet, and we would rather say that than invent
        one. Until <Placeholder>Playxoft contact email address</Placeholder> is live, the way to
        reach us about anything on this page is{' '}
        <LegalLink href={`${REPO_URL}/issues`}>an issue in the repository</LegalLink>.
      </>,
      <>
        Postal address: <Placeholder>Playxoft registered address</Placeholder>. Data protection
        officer or Article 27 representative:{' '}
        <Placeholder>none appointed — to be confirmed before general availability</Placeholder>.
      </>,
      <>
        The two documents that answer most follow-up questions before you have to ask them are{' '}
        <LegalLink href="/docs/security/trust-model">the trust model</LegalLink> and{' '}
        <LegalLink href="/terms">the terms of service</LegalLink>.
      </>,
    ],
  },
];

const STRUCTURED_DATA = graph(
  {
    '@type': 'WebPage',
    '@id': `${CANONICAL}#page`,
    name: `${TITLE} · ${SITE_NAME}`,
    url: CANONICAL,
    description: DESCRIPTION,
    inLanguage: 'en',
    datePublished: EFFECTIVE,
    dateModified: UPDATED,
    isPartOf: { '@id': absoluteUrl('/#website') },
    publisher: { '@id': absoluteUrl('/#organization') },
    about: { '@id': absoluteUrl('/#organization') },
  },
  breadcrumbSchema([{ name: TITLE, path: '/privacy' }]),
);

export default function PrivacyPage() {
  return (
    <LegalPage
      eyebrow="Legal"
      title="Privacy policy"
      description="What Playxoft collects when you use xecret, what our encryption model does and does not protect, who else processes it, and how to get your data back or get it deleted."
      updated={UPDATED}
      effective={EFFECTIVE}
      summary={SUMMARY}
      sections={SECTIONS}
      structuredData={STRUCTURED_DATA}
    />
  );
}

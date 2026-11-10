import type { Metadata } from 'next';

import { graph, LegalPage } from '@/components/marketing';
import type { LegalSection } from '@/components/marketing';
// Not from the barrel: an authoring tool for the documents' data, not a piece
// of the public-site kit.
import { LegalLink } from '@/components/marketing/legal-page';
import { absoluteUrl, breadcrumbSchema, REPO_URL, SITE_KEYWORDS, SITE_NAME } from '@/lib/site';

/**
 * The privacy policy for the hosted service.
 *
 * ── The rule this page is written under ──
 * Every claim here is checkable against the code or against
 * `public/docs/security/trust-model.md`, and the company details are the ones
 * on the public register (Ministry of Corporate Affairs, by the CIN below).
 * Where a fact does not exist — no data protection officer has been appointed
 * — the page says so plainly rather than inventing something plausible.
 * A privacy policy on a secrets product is read by exactly the sort of person
 * who checks, and the first invented sentence costs more than the whole
 * document earns.
 *
 * The data categories in section 2 are deliberately specific — column names,
 * cookie names, every key the site keeps in browser storage — because "we
 * collect certain information to provide and improve our services" is not a
 * disclosure. That specificity is also the maintenance burden: change the
 * session table or add a fourth cookie and this page is wrong until it is
 * edited. The browser storage, at least, is pinned: `marketing-pages.test.ts`
 * finds every storage key the app's code declares and fails when this page
 * does not name it, or names it under the wrong kind of storage.
 */

const TITLE = 'Privacy policy';

const DESCRIPTION =
  'What xecret stores, what our encryption model does and does not protect, who else processes it, how long we keep it, and how to exercise your rights.';

const UPDATED = '2026-11-11';
const EFFECTIVE = '2026-11-11';

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
  'We do not sell or share personal information. There is no advertising or analytics cookie on this site — the only cookies are your session, a CSRF token, and the few short-lived ones that protect a sign-in in progress or remember which account last signed in on this browser.',
  'What you delete is kept for 30 days, so that a mistake can be undone, and then erased for good — a deleted secret longer only where your plan’s restore window needs it. You can export everything with the CLI and delete your own account.',
  'If you self-host, none of this is us: the operator of that deployment writes their own policy.',
] as const;

const SECTIONS: readonly LegalSection[] = [
  {
    id: 'who-we-are',
    heading: 'Who we are, and what this covers',
    paragraphs: [
      <>
        xecret is a secret-management service operated by Playxoft Studios Private Limited
        (&ldquo;Playxoft&rdquo;), a company incorporated in India with corporate identity number
        U58203TN2025PTC178070, whose registered office is at 19B/1, Ananthapettai Street,
        Kanchipuram, Tamil Nadu 631501, India. Playxoft is the controller for the personal data
        described below, and &ldquo;we&rdquo; means Playxoft throughout.
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
          whether it has been verified, and the identifier WorkOS issues for your account. If WorkOS
          holds a name or a profile picture for you — as it does when you sign in with Google, which
          supplies both — we receive the name and the picture&rsquo;s URL too. We never see your
          password, and never receive your Google password: a password is entered on a sign-in page
          hosted by WorkOS, or on Google&rsquo;s own for a Google account, WorkOS verifies who you
          are once, and xecret issues its own session afterwards. Accounts created before we moved
          to WorkOS also still carry the identifier our previous identity provider, Firebase, issued
          them.
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
          it expires, when its PIN was last accepted, how it signed in &mdash; password, Google, or
          which organisation&rsquo;s single sign-on &mdash; and the sign-in provider&rsquo;s own
          session identifier, so that signing out here can end that session too. The session token
          itself is stored only as a hash, so a database dump yields hashes rather than usable
          sessions. If you reset your vault, the session you signed in again with also records when
          that sign-in happened, when a code was last emailed and how many were requested, and how
          many codes were tried &mdash; never a code itself, and the proof it leads to only as a
          hash. That record belongs to the session and is removed with it; it stops counting for
          anything ten minutes after the sign-in.
        </>,
        <>
          <strong className="text-fg font-medium">Token metadata.</strong> For each CLI or service
          token: its name, its prefix, its scope, who created it, and when it was created, expires,
          was last used and was revoked. The token value is stored as a hash and shown to you
          exactly once.
        </>,
        <>
          <strong className="text-fg font-medium">Membership, and its end.</strong> Which
          organisations your account belongs to and your role in each. When an organisation removes
          you, a record that you were removed &mdash; by whom and when &mdash; is kept, so that its
          single sign-on cannot silently re-admit you. Accepting a fresh invitation clears it.
        </>,
        <>
          <strong className="text-fg font-medium">Billing, for a paid plan.</strong> The
          organisation&rsquo;s plan, billing period, seat count, currency and billing country, the
          dates of the current period, the identifiers Dodo Payments issues for its customer record
          and its subscription, and a count of secret fetches per period. We never see or store a
          card number; Dodo holds the card.
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
          <strong className="text-fg font-medium">Mail we send.</strong> A PIN reset link;
          organisation invitations to the address you type; and, when you reset your vault, your{' '}
          <LegalLink href="/docs/security/vault-archive">vault archive</LegalLink> — your secrets,
          still encrypted, with the names of your organisations, projects, environments and secrets
          in plain text — attached to a message to your own address, or a notice in its place if you
          chose to reset without it. On a paid plan, an organisation&rsquo;s owners also receive its
          billing emails — a trial ending, a payment that failed, a renewal coming up, a seat
          change, a receipt being ready. WorkOS also sends, on our behalf, the mail that belongs to
          signing in: a message to verify your email address, a password reset link when you ask for
          one, a one-time sign-in code if you choose to sign in by email, and the one-time code that
          confirms a vault reset. That is the whole of it: no newsletter, no product marketing, and
          no tracking pixel in the mail we send ourselves.
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
      'Two roles, and the distinction matters. For your account data we are the controller. For what you put into xecret — secrets, names, structure, and the audit records about them — we act as a processor on the instructions of the organisation that owns it, and that organisation is the controller. If your organisation needs a data processing agreement with us, ask at support@playxoft.com.',
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
          <strong className="text-fg font-medium">WorkOS, Inc.</strong> — identity only. It hosts
          the sign-in page, checks your password if you use one, and verifies who you are, so it
          sees your email address, your name and your sign-in events, including the IP address and
          browser each one came from. It also sends the sign-in mail listed in section 2. It never
          receives a secret or anything else you store in xecret. Once it has verified you, xecret
          issues its own session and keeps none of the tokens WorkOS issues.
        </>,
        <>
          <strong className="text-fg font-medium">ZeptoMail (Zoho)</strong> — transactional email:
          PIN reset links, organisation invitations, the billing emails an organisation&rsquo;s
          owners receive on a paid plan, and the vault archive or notice sent when you reset your
          vault. The archive passes through it as an attachment: encrypted values it cannot read,
          and names in plain text.
        </>,
        <>
          <strong className="text-fg font-medium">Better Stack</strong> — log shipping, when a
          deployment is configured for it. When it is not, request logs stay in Cloudflare&rsquo;s
          own tail.
        </>,
        <>
          <strong className="text-fg font-medium">Dodo Payments</strong> — payments, as the merchant
          of record, for an organisation that buys a paid plan. It takes the payment, charges the
          tax and issues the invoice, so it receives the name, email address and billing country of
          the owner who checks out, and it holds the card: the card number is entered on its
          checkout and never reaches xecret. We send it the organisation&rsquo;s id, the seat count
          and, past the included allowance, a count of secret fetches. It never receives a secret or
          anything else you store in xecret.
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
          <strong className="text-fg font-medium">Audit records</strong> — 7 days on Free, 30 days
          on Pro, 180 days on Team, a year on Enterprise, and whatever an Enterprise agreement
          states above that. A single audit query returns at most a 90-day window, which is a limit
          on the query and not on the retention.
        </>,
        <>
          <strong className="text-fg font-medium">Secrets</strong> — for as long as you keep them.
          Every earlier version of a value is kept with it, which is what lets you roll one back.
        </>,
        <>
          <strong className="text-fg font-medium">
            Deleted organisations, projects, environments and secrets
          </strong>{' '}
          — kept for 30 days after deletion, out of everybody&rsquo;s reach, and then erased for
          good: the values, every earlier version of them, and the keys they were encrypted under. A
          job runs every night to do it, and it records each erasure in the audit log.
        </>,
        <>
          <strong className="text-fg font-medium">Why 30 days.</strong> What xecret holds is
          credentials, and a credential is deleted by mistake far more often than on purpose: the
          wrong environment, a script that cleaned up too much, a value somebody did not know was
          still in use &mdash; or an account that had been taken over. The first sign is usually an
          outage days later, when an application restarts and cannot fetch what it needs. Thirty
          days gives you time to notice and ask us to put it back, and gives an investigation the
          record of what existed. After that, keeping a credential nobody can use would only add
          risk, so we erase it.
        </>,
        <>
          <strong className="text-fg font-medium">One exception.</strong> A secret deleted from an
          environment that still exists is kept for your plan&rsquo;s point-in-time restore window
          when that is longer than 30 days &mdash; 180 days on Team, a year on Enterprise &mdash;
          because restoring the environment to an earlier moment brings such secrets back, and it
          can only do that while they are still here.
        </>,
        <>
          <strong className="text-fg font-medium">Reset vaults</strong> — when you reset your vault,
          the old one is kept for seven days so that you can recover it, and nothing in xecret can
          delete it in that window — not you, and not us through the product. It is purged
          automatically within about an hour after the seven days end. The archive emailed at the
          reset is a copy in your mailbox, and stays there for as long as you keep it: we cannot
          delete mail we have sent.
        </>,
        <>
          <strong className="text-fg font-medium">Closed accounts</strong> — deleting your account
          revokes every session and CLI token, deletes your PIN, removes you from the organisations
          you are not the last owner of, and deletes the organisations that were only yours, which
          are then erased 30 days later as described above. The user record itself is soft-deleted
          rather than erased, because the audit records you made have to keep meaning something; the
          actor&rsquo;s label was written into each record at the time, so the log still reads
          correctly with the account gone. A vault you reset in the last seven days is kept until
          its window ends, then purged as above. Ask us if you need the identity record erased
          outright.
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
        For anything else, email{' '}
        <LegalLink href="mailto:support@playxoft.com">support@playxoft.com</LegalLink>. We answer
        within one month, which is the period the GDPR allows, and sooner where we can. We may have
        to verify that you are who you say you are before acting on a request about an account.
      </>,
      <>
        If you think we have got this wrong, you can complain to the data protection authority where
        you live &mdash; in the United Kingdom the Information Commissioner&rsquo;s Office, in the
        EEA the authority of your own country. Playxoft is established in India, where the authority
        under the Digital Personal Data Protection Act, 2023 is the Data Protection Board of India.
        We would rather you told us first.
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
        Playxoft is established in India. The sub-processors in section 5 are global companies, so
        your data will be processed outside the country you are in.
      </>,
      'Where a transfer leaves the United Kingdom or the EEA, it relies on the European Commission’s standard contractual clauses and the UK international data transfer addendum, together with each provider’s own transfer arrangements. The Workers runtime serves each request from whichever data centre is nearest to the caller and stores nothing; the database that holds your data lives in one region, fixed when the deployment was created.',
    ],
  },
  {
    id: 'cookies',
    heading: 'Cookies and browser storage',
    paragraphs: [
      'Six cookies, all strictly necessary, none of them a tracker:',
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
        <>
          <code className="text-fg font-mono text-[0.9em]">__Host-xecret_oauth_state</code> — set
          when you leave for the sign-in page and cleared when you come back, so that a sign-in can
          only be completed in the browser that started it. HttpOnly, secure, signed, and valid for
          ten minutes. It holds the one-time values that tie the sign-in to your browser and the
          page to return you to.
        </>,
        <>
          <code className="text-fg font-mono text-[0.9em]">__Host-xecret_sign_in_confirm</code> —
          set only when a sign-in is held back for your confirmation (&ldquo;Is this you?&rdquo;).
          It carries the held-back sign-in, sealed so that only this site can read it. HttpOnly,
          secure, single-use, and valid for five minutes.
        </>,
        <>
          <code className="text-fg font-mono text-[0.9em]">__Host-xecret_sso_continue</code> — set
          when you open an organisation&rsquo;s sign-in link, so that only the warning page&rsquo;s
          own Continue button can start that organisation&rsquo;s sign-in. HttpOnly, secure, and
          valid for five minutes.
        </>,
        <>
          <code className="text-fg font-mono text-[0.9em]">__Host-xecret_last_account</code> — a
          signed note of which account last signed in on this browser, so we do not ask &ldquo;Is
          this you?&rdquo; needlessly when our sign-in provider remembers you. HttpOnly, secure, and
          valid for 180 days. It names an account id and nothing else.
        </>,
      ],
      'The sign-in page itself is served by WorkOS, and whatever it stores in your browser is governed by WorkOS’s own policy rather than this one.',
      <>
        Besides the cookies, this site keeps the entries below in your browser&rsquo;s own storage.
        They are written and read by the site&rsquo;s code in your browser, and the entries
        themselves are never uploaded to us. Several of them hold identifiers our server also has
        &mdash; your account&rsquo;s, members&rsquo; and service tokens&rsquo; identifiers, and
        organisation, project and environment slugs &mdash; and one of those identifiers, the device
        identifier in <code className="text-fg font-mono text-[0.9em]">xecret.pin.v1</code>, is sent
        to us whenever you set up, use or turn off a device PIN, because naming this browser to our
        server is what it is for.
      </>,
      <>
        In <code className="text-fg font-mono text-[0.9em]">localStorage</code>, which keeps them
        until you clear this site&rsquo;s data in your browser:
      </>,
      [
        <>
          <code className="text-fg font-mono text-[0.9em]">xecret.theme</code> — light, dark or
          system.
        </>,
        <>
          <code className="text-fg font-mono text-[0.9em]">xecret.sidebar</code> — whether the
          dashboard sidebar is collapsed.
        </>,
        <>
          <code className="text-fg font-mono text-[0.9em]">xecret.projects.view</code> — whether the
          projects page shows a grid or a list.
        </>,
        <>
          <code className="text-fg font-mono text-[0.9em]">xecret.nudge.unlock.v1</code> — when this
          browser last offered you a faster way to unlock your vault, as a timestamp, so that the
          offer is not made again for 30 days.
        </>,
        <>
          <code className="text-fg font-mono text-[0.9em]">xecret.pins.v1</code> — the public keys
          of the members and service tokens this browser has encrypted keys for, each filed under
          its xecret identifier with the date it was first recorded. A public key is not a secret.
          It is kept so that if our server ever presented a different key for one of them, this
          browser would notice and warn you instead of encrypting to it.
        </>,
        <>
          <code className="text-fg font-mono text-[0.9em]">xecret.pins.mode.v1</code> — for each
          environment this browser has worked with, filed under its organisation, project and
          environment slugs: whether it was end-to-end encrypted, and when that was first seen. If
          our server later claimed that such an environment was no longer end-to-end encrypted, this
          browser would refuse to send it secret values in plain text.
        </>,
        <>
          <code className="text-fg font-mono text-[0.9em]">xecret.pin.v1</code> — present only if
          you set up a device PIN on this browser. It holds your vault key — the key your master
          passphrase unlocks — encrypted so that this device alone cannot open it: the other half of
          the key it is encrypted under stays on our server, which releases it only when the PIN you
          type is right, and deletes it after five wrong attempts in a row. Beside it are a random
          salt, and an identifier for this browser that is sent to our server whenever you set up,
          use or turn off the PIN, so that it knows which half to release. The encrypted vault key
          itself never leaves this browser. Turning the PIN off in this browser deletes the entry.
          If the PIN ends any other way &mdash; turned off from another browser, or revoked because
          your passphrase was changed or your vault was recovered or reset &mdash; our server has
          deleted its half, and the entry can stay here until this browser next tries to use it.
        </>,
      ],
      <>
        In <code className="text-fg font-mono text-[0.9em]">sessionStorage</code>, which belongs to
        a single tab:
      </>,
      [
        <>
          <code className="text-fg font-mono text-[0.9em]">xecret.last-org</code> — the slug of the
          organisation this tab was last working in, so that your account pages keep pointing at it.
        </>,
        <>
          <code className="text-fg font-mono text-[0.9em]">xecret.uk.session.v1</code> — while your
          vault is unlocked in a tab, that tab keeps a copy of the vault&rsquo;s keys here,{' '}
          <strong className="text-fg font-medium">unencrypted</strong>: your vault key, your
          account&rsquo;s encryption and signing key pairs, and your account identifier. It is what
          lets a reload skip your passphrase, and the entry is never sent to us. Locking the vault,
          or signing out in that tab, deletes it. If your session ends any other way &mdash; it
          expires, it is revoked, or you sign out everywhere from another device &mdash; the copy
          can stay in that tab until the tab is closed or the vault is locked there. Closing a tab
          normally ends it, but a browser that reopens closed tabs, restores a previous session or
          duplicates a tab can carry it along. So on a computer you share, lock the vault or close
          the tab yourself, rather than relying on signing out from somewhere else.
        </>,
      ],
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
        The version of 11 November 2026 is not a material change. It names the company that operates
        xecret and how to reach it, and it sets how long deleted data is kept &mdash; 30 days, then
        erased, under <LegalLink href="#retention">How long we keep it</LegalLink> &mdash; where the
        version before it left that period to be decided. That shortens how long we hold data; what
        we collect, why we process it, who processes it for us, and your rights are unchanged.
      </>,
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
        Email <LegalLink href="mailto:support@playxoft.com">support@playxoft.com</LegalLink> about
        anything on this page. For a question that is not about you personally, you are welcome to{' '}
        <LegalLink href={`${REPO_URL}/issues`}>open an issue in the repository</LegalLink> instead
        &mdash; but please keep personal information out of it, since issues are public.
      </>,
      <>
        By post: Playxoft Studios Private Limited, 19B/1, Ananthapettai Street, Kanchipuram, Tamil
        Nadu 631501, India.
      </>,
      <>
        We have not appointed a data protection officer, or a representative in the EU or the United
        Kingdom. While xecret is at this early stage, privacy requests go straight to the people who
        build it, at the address above. If we appoint either, this section will name them.
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

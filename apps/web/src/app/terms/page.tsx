import type { Metadata } from 'next';

import { graph, LegalPage } from '@/components/marketing';
import type { LegalSection } from '@/components/marketing';
// See the note on the same import in `app/privacy/page.tsx`: these two are
// authoring tools for the documents' data rather than parts of the public-site
// kit, so they stay off the barrel.
import { LegalLink, Placeholder } from '@/components/marketing/legal-page';
import { absoluteUrl, breadcrumbSchema, REPO_URL, SITE_KEYWORDS, SITE_NAME } from '@/lib/site';

/**
 * The terms for the hosted service.
 *
 * ── Two things this document refuses to do ──
 * It does not pretend the product is further along than it is: the availability
 * clause says there is no SLA, the liability cap states the actual number, and
 * the pre-alpha section is where a template would have put a maturity claim.
 * And it does not invent the company details these clauses depend on — the
 * jurisdiction, the registration number, the registered address are marked in
 * the rendered page, because a governing-law clause naming the wrong court is
 * worse than one that visibly has not been completed.
 *
 * The plan table restates the pricing page rather than linking to it, because a
 * price a customer agreed to has to be in the agreement. That is a real
 * duplication, and the two have to be edited together.
 */

const TITLE = 'Terms of service';

const DESCRIPTION =
  'The terms for the hosted xecret service: pre-alpha status, plans and billing, your account and your tokens, the AGPL and MIT licences, and liability.';

const UPDATED = '2026-08-16';
const EFFECTIVE = '2026-08-16';

const CANONICAL = absoluteUrl('/terms');

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    'xecret terms of service',
    'secret manager terms',
    'agpl hosted service',
    'pre-alpha software terms',
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
  robots: { index: true, follow: true },
};

const SUMMARY = [
  'xecret is pre-alpha. No SLA, no warranty, breaking changes, and you should keep your own copy of anything you cannot rebuild.',
  'Every paid feature is switched on for everybody right now and no card is collected. Nothing starts charging without telling you first.',
  'You are responsible for your account, your PIN and your tokens — including revoking one when a laptop or a CI system goes away.',
  'The server is AGPL-3.0 and the CLI is MIT. Running it yourself is governed by those licences, not by these terms, and we receive nothing from your deployment.',
  'Our total liability is capped at US$100 while you are paying us nothing. Read section 13 before you store something whose loss would be catastrophic.',
] as const;

const SECTIONS: readonly LegalSection[] = [
  {
    id: 'agreement',
    heading: 'The agreement',
    paragraphs: [
      <>
        These terms are between Playxoft (
        <Placeholder>Playxoft legal entity name and company registration number</Placeholder>, of{' '}
        <Placeholder>Playxoft registered address</Placeholder>) and you. By creating an account,
        signing in, or using the CLI, the API or this website against our hosted service, you accept
        them. If you do not accept them, do not use the service.
      </>,
      'If you accept them on behalf of a company, you are telling us you have the authority to bind it, and “you” means that company from then on.',
      <>
        Two documents sit alongside these terms and are part of the deal:{' '}
        <LegalLink href="/privacy">the privacy policy</LegalLink>, and{' '}
        <LegalLink href="/docs/security/trust-model">what xecret can and cannot see</LegalLink>.
        Read the second one before you store a real credential — it is the document that says we can
        technically decrypt what you store.
      </>,
    ],
  },
  {
    id: 'eligibility',
    heading: 'Eligibility',
    paragraphs: [
      'You must be at least 16 and able to enter into a contract. You must not be barred from using the service by the sanctions or export-control laws that apply to either of us, and you must not be using it from a jurisdiction we are prohibited from serving.',
      'One person, one account. Accounts are not shared: a colleague gets their own account and a role. That is not bureaucracy — a shared login makes every row of the audit log attribute an action to the wrong person, which is the one thing the log exists to prevent.',
    ],
  },
  {
    id: 'account',
    heading: 'Your account, and keeping it secure',
    paragraphs: [
      'You are responsible for what happens under your account, and for everything any credential you created can reach.',
      [
        <>
          <strong className="text-fg font-medium">Your sign-in.</strong> Firebase verifies it, so if
          your email account or your Google account is compromised, your xecret account is too. Turn
          on two-factor authentication wherever you sign in from.
        </>,
        <>
          <strong className="text-fg font-medium">Your PIN.</strong> It gates reveals and
          destructive actions on a session that is already signed in. We store only a hash of it and
          cannot recover it; a reset link goes to the address on the account. Choosing a guessable
          PIN, or writing it on the laptop, is not a failure of the service.
        </>,
        <>
          <strong className="text-fg font-medium">Your tokens.</strong> CLI tokens and service
          tokens act as you within their scope. Scope them narrowly, give them an expiry, and revoke
          them the moment a laptop is lost or a CI system is retired. Revocation is immediate and is
          never softened by the CLI&rsquo;s offline cache.
        </>,
        <>
          <strong className="text-fg font-medium">Your members.</strong> Removing somebody who has
          left is your job, and so is reviewing who holds production access. The tools are there;
          the decision is yours.
        </>,
      ],
      <>
        Tell us as soon as you believe an account or a token has been compromised. The{' '}
        <LegalLink href="/docs/security/audit-log">audit log</LegalLink> is what tells you what it
        reached; rotating the underlying credential at its source is what actually ends the
        exposure. Revoking a token does not un-leak a value it has already read.
      </>,
    ],
  },
  {
    id: 'acceptable-use',
    heading: 'Acceptable use',
    paragraphs: [
      'Do not:',
      [
        'use the service unlawfully, or to store credentials you are not entitled to hold;',
        'attack it — no probing for vulnerabilities outside the disclosure process, no denial of service, no attempt to reach another organisation’s data;',
        'work around a rate limit or a plan limit, or automate the creation of accounts;',
        'resell the hosted service or run it as a service for third parties under our name — running the software yourself is governed by the AGPL, and section 10 says what that means;',
        'upload malware, or use the service to distribute it;',
        'misrepresent who you are, or use somebody else’s account.',
      ],
      <>
        Security research is welcome through the process in{' '}
        <LegalLink href={`${REPO_URL}/blob/main/SECURITY.md`}>SECURITY.md</LegalLink>. Testing
        against your own organisation, in a way that does not degrade the service for anybody else,
        is not a breach of this section.
      </>,
      'We may investigate suspected abuse and take reasonable steps to stop it, including suspending an account. Where we can tell you what happened and why, we will.',
    ],
  },
  {
    id: 'your-data',
    heading: 'Your content, and your own compliance',
    paragraphs: [
      'Your secrets, your names, your structure and your audit history are yours. We claim no ownership of them. You grant us only the licence we need to run the service: to store, transmit, encrypt, decrypt on your instruction, back up, and display that content to the people you have authorised.',
      'What you store is your decision, and so is whether you are permitted to store it. If personal data ends up inside a secret value, you are its controller and we process it on your instructions. If you are subject to a regime with specific requirements — PCI DSS, HIPAA, a sector regulator, a customer contract — decide whether this service meets them before you store anything under it. We hold no certification and publish no attestation, and we would rather write that sentence than let you assume otherwise.',
      <>
        Read <LegalLink href="/docs/security/trust-model">the trust model</LegalLink> first. xecret
        uses server-side envelope encryption and can technically decrypt your values. If your
        obligations require a provider that cannot, this is not that product, and we would rather
        tell you here than after you have migrated.
      </>,
    ],
  },
  {
    id: 'pre-alpha',
    heading: 'Pre-alpha: availability and change',
    paragraphs: [
      'xecret is pre-alpha software. That is not a disclaimer bolted onto a finished product; it is the current state of it.',
      [
        <>
          <strong className="text-fg font-medium">No SLA.</strong> There is no uptime commitment on
          any plan today, and there will never be one on the free tier. An Enterprise agreement may
          add one in writing.
        </>,
        <>
          <strong className="text-fg font-medium">Breaking changes.</strong> APIs, CLI flags, data
          shapes and the dashboard will change, sometimes without a deprecation period. We announce
          what we can in the repository.
        </>,
        <>
          <strong className="text-fg font-medium">Maintenance and migration.</strong> We may migrate
          data between regions or schema versions, and take the service down to do it.
        </>,
        <>
          <strong className="text-fg font-medium">Features may be removed</strong>, including ones
          you have come to rely on.
        </>,
        <>
          <strong className="text-fg font-medium">Keep your own copy</strong> of anything you cannot
          rebuild. <code className="text-fg font-mono text-[0.9em]">xecret pull</code> exists; use
          it before a change you could not undo.
        </>,
      ],
      'Design for this service being unavailable. The CLI’s offline cache exists for exactly that reason, and a deploy pipeline whose only path to a credential is a live API call to a pre-alpha service is a pipeline with a single point of failure you chose.',
    ],
  },
  {
    id: 'plans',
    heading: 'Plans, prices and billing',
    paragraphs: [
      'While xecret is in pre-alpha, every paid feature is switched on for everybody and no card is collected. The prices below are what they will be at 1.0.',
      [
        <>
          <strong className="text-fg font-medium">Free — $0, forever.</strong> 1 organisation, 5
          projects, 3 members, 3 environments per project, 7 days of audit history, CLI and CI
          tokens, community support on GitHub.
        </>,
        <>
          <strong className="text-fg font-medium">Team — $9 per member per month</strong>, or $7 per
          member per month billed yearly. Unlimited organisations, projects, members and
          environments, 12 months of audit history, roles and per-environment access, service
          tokens, email support.
        </>,
        <>
          <strong className="text-fg font-medium">Business — $19 per member per month</strong>, or
          $15 per member per month billed yearly. Everything in Team, plus 3 years of audit history,
          SAML single sign-on, priority support with a one-business-day response target, and
          invoiced billing.
        </>,
        <>
          <strong className="text-fg font-medium">Enterprise — custom.</strong> Everything in
          Business, plus SCIM provisioning, custom audit retention, a self-hosting support contract,
          a named contact, and a contractual SLA.
        </>,
        <>
          <strong className="text-fg font-medium">Self-hosted — free, always.</strong> The whole
          server under AGPL-3.0 on your own infrastructure, with no feature held back. Support is
          the community, or an Enterprise contract.
        </>,
      ],
      'When billing starts, we will tell you before it applies to your organisation and you will have to enter a card yourself. Nothing moves from free to charged silently. Paid plans are then billed in advance, per member, for whichever term you choose — monthly, or yearly at the lower per-member rate. A yearly term is paid up front and does not pro-rate if you leave part-way through it. Prices exclude VAT and sales tax, which we add where we are required to charge it.',
      <>
        Cancelling stops the next renewal, and the organisation returns to Free at the end of the
        period you have paid for. We will not delete data because a plan lapsed: we will tell you
        what exceeds the Free limits and give you a reasonable window to bring the organisation
        under them or export it. The current numbers are on{' '}
        <LegalLink href="/pricing">the pricing page</LegalLink>, and if they ever disagree with this
        section, this section is the one you agreed to.
      </>,
      'Refunds: nothing has been charged during pre-alpha, so there is nothing to refund. Once billing is live, your statutory rights apply in full; beyond those, we do not refund part-months.',
    ],
  },
  {
    id: 'suspension',
    heading: 'Suspension, termination, and what happens to your data',
    paragraphs: [
      <>
        You can stop at any time: delete the organisation, or delete your account from Settings.{' '}
        <LegalLink href="/privacy#retention">The privacy policy</LegalLink> describes exactly what
        deletion does, what survives it, and why the audit trail is the part that survives.
      </>,
      'We may suspend or terminate an account that breaches these terms, that is being used to attack the service or another user, or where the law requires it. Except where the abuse is serious or continuing, or where the law forbids it, we will tell you first and give you a chance to put it right.',
      <>
        If we discontinue the service, or terminate your access to it, you get at least 30 days to
        export what you have. Export is{' '}
        <code className="text-fg font-mono text-[0.9em]">xecret pull</code> and the{' '}
        <LegalLink href="/docs/api/reference">HTTP API</LegalLink>, and both work on the free tier.
        We will still provide an export on request after a termination for abuse, unless the law
        prevents us.
      </>,
      'The clauses meant to outlive this agreement do: intellectual property, disclaimers, limitation of liability, indemnity, and governing law.',
    ],
  },
  {
    id: 'ip',
    heading: 'Intellectual property and licences',
    paragraphs: [
      'The server is licensed under the GNU Affero General Public License v3.0. The CLI is MIT. Those licences are what govern the software, they are in the repository, and nothing on this page narrows a right either of them grants you.',
      'These terms govern the hosted service we operate — the account, the availability, the support and the price. They are not a software licence.',
      'The xecret name, the Playxoft name and our logos are ours. An open-source licence covers code, not trade marks: fork the software freely, and do not present the fork as xecret.',
      'Feedback: if you send us a suggestion, we may use it without owing you anything for it. Do not send anything confidential in a public issue.',
    ],
  },
  {
    id: 'self-hosting',
    heading: 'Self-hosting',
    paragraphs: [
      'Running your own instance is governed by the AGPL-3.0, not by these terms. You do not need our permission, we make no promises about your deployment, and we receive nothing from it — no telemetry, no phone-home, no licence check.',
      <>
        The AGPL&rsquo;s network clause applies to you in turn: if you offer a modified version to
        users over a network, they are entitled to the source of your modifications.{' '}
        <LegalLink href="/docs/self-hosting">The self-hosting guide</LegalLink> walks through the
        deployment and is blunt about the one irreversible risk — lose the root key and every secret
        is permanently unrecoverable, and there is no support ticket that fixes it.
      </>,
    ],
  },
  {
    id: 'third-party',
    heading: 'Third-party services',
    paragraphs: [
      <>
        The hosted service depends on Cloudflare, a managed PostgreSQL provider, Firebase for
        identity, and an email provider. Their terms govern their part, and an outage at any of them
        is an outage here. <LegalLink href="/privacy#sub-processors">The privacy policy</LegalLink>{' '}
        names each of them and says what it processes.
      </>,
      'Anything you connect xecret to — your CI system, your cloud provider, your own applications — is between you and them. We are not responsible for what a third party does with a secret you gave it access to.',
    ],
  },
  {
    id: 'warranty',
    heading: 'No warranty',
    paragraphs: [
      'The service is provided “as is” and “as available”, with no warranty of any kind, express or implied, including any implied warranty of merchantability, fitness for a particular purpose, title, or non-infringement. We do not warrant that the service will be uninterrupted, that it will be error-free, or that it will preserve any particular data. The AGPL and the MIT licence disclaim warranties for the software itself in the same way.',
      'Where a jurisdiction does not allow a warranty to be excluded, the exclusion applies to the maximum extent that jurisdiction allows. Nothing here excludes liability for death or personal injury caused by negligence, for fraud or fraudulent misrepresentation, or for anything else that cannot lawfully be excluded.',
    ],
  },
  {
    id: 'liability',
    heading: 'Limitation of liability',
    paragraphs: [
      'To the maximum extent the law allows, neither party is liable for indirect, incidental, special, consequential or punitive damages, or for lost profits, lost revenue, lost goodwill, or the cost of substitute services, however caused.',
      'Our total liability for all claims relating to the service in any twelve-month period is capped at the greater of the fees you paid us for the service in that period and US$100. During pre-alpha you pay us nothing, so that cap is US$100.',
      'That is a real number, printed here rather than buried, because it is the number that should decide what you store. You are responsible for keeping your own copy of anything you cannot afford to lose, and for rotating a credential you believe has been exposed. Section 6 is not a formality.',
    ],
  },
  {
    id: 'indemnity',
    heading: 'Indemnity',
    paragraphs: [
      'You will indemnify Playxoft against claims, losses and reasonable legal costs arising from your content, from your use of the service in breach of these terms or of the law, or from your infringement of somebody else’s rights.',
      'We will tell you promptly about any such claim, let you control its defence, and cooperate with you at your expense. You will not settle in a way that admits fault on our part, or that imposes an obligation on us, without our written agreement.',
    ],
  },
  {
    id: 'changes',
    heading: 'Changes to these terms',
    paragraphs: [
      'We may change these terms. The date at the top of the page changes with them, and the history is the git history of the repository this page lives in — you can see what it said before without taking our word for it.',
      'For a material change we will give notice by email to organisation owners and in the product before it takes effect, 30 days ahead where we reasonably can. Continuing to use the service after a change takes effect is acceptance of it. If you do not accept it, delete your account before then.',
    ],
  },
  {
    id: 'law',
    heading: 'Governing law and disputes',
    paragraphs: [
      <>
        These terms are governed by the law of the jurisdiction in which Playxoft is established,
        without regard to its conflict-of-laws rules:{' '}
        <Placeholder>
          governing law jurisdiction — Playxoft&rsquo;s place of establishment
        </Placeholder>
        .
      </>,
      <>
        Disputes go to the courts of that jurisdiction:{' '}
        <Placeholder>courts of the governing law jurisdiction</Placeholder>. If you are a consumer,
        nothing here deprives you of the protection of the mandatory law of the country you live in,
        or of your right to bring proceedings there.
      </>,
      'Before filing anything, tell us what the problem is. Most disputes about a pre-alpha developer tool are a misunderstanding that one honest message resolves faster than either of us could file a claim.',
      'The company details these clauses depend on are marked above because they are not settled yet. A governing-law clause naming the wrong court is worse than one that visibly has not been completed, so we left the gaps visible.',
    ],
  },
  {
    id: 'contact',
    heading: 'Contact, and the small print',
    paragraphs: [
      <>
        Reach us through the repository —{' '}
        <LegalLink href={`${REPO_URL}/issues`}>open an issue on GitHub</LegalLink> — until{' '}
        <Placeholder>Playxoft contact email address</Placeholder> is published. To report a
        vulnerability, follow{' '}
        <LegalLink href={`${REPO_URL}/blob/main/SECURITY.md`}>SECURITY.md</LegalLink> rather than
        opening a public issue.
      </>,
      [
        <>
          <strong className="text-fg font-medium">Entire agreement.</strong> These terms, the
          privacy policy, and any written order between us are the whole agreement about the hosted
          service, and they replace anything said before it.
        </>,
        <>
          <strong className="text-fg font-medium">Severability.</strong> If a clause turns out to be
          unenforceable, the rest of the agreement stands.
        </>,
        <>
          <strong className="text-fg font-medium">No waiver.</strong> Not enforcing something once
          does not give up the right to enforce it later.
        </>,
        <>
          <strong className="text-fg font-medium">Assignment.</strong> You may not assign these
          terms without our consent. We may assign them to a successor of the business, and will
          tell you if we do.
        </>,
        <>
          <strong className="text-fg font-medium">No agency.</strong> Nothing here creates a
          partnership, an agency, or an employment relationship.
        </>,
        <>
          <strong className="text-fg font-medium">Force majeure.</strong> Neither party is liable
          for a failure caused by something genuinely outside its control.
        </>,
      ],
      'These are pre-alpha terms, written by the people building the product and reviewed by a lawyer before general availability rather than before you read them. They are not legal advice, to you or to anybody else.',
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
  breadcrumbSchema([{ name: TITLE, path: '/terms' }]),
);

export default function TermsPage() {
  return (
    <LegalPage
      eyebrow="Legal"
      title="Terms of service"
      description="The agreement for the hosted xecret service — what we owe you while the product is pre-alpha, what you owe us, and which parts are governed by the AGPL instead."
      updated={UPDATED}
      effective={EFFECTIVE}
      summary={SUMMARY}
      sections={SECTIONS}
      structuredData={STRUCTURED_DATA}
    />
  );
}

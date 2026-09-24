import type { Metadata } from 'next';
import Link from 'next/link';

import { PageHero, PublicPage, QUIET_LINK, Section } from '@/components/marketing';
import { ArrowRightIcon, ExternalLinkIcon } from '@/components/ui/icons';
import { absoluteUrl, REPO_URL, SITE_KEYWORDS, SITE_NAME } from '@/lib/site';

import { ContactForm } from './contact-form';

/**
 * The sales page, for the one plan that has no checkout.
 *
 * ── What this deliberately is not ──
 * Not a lead-capture form. There is no phone field, no "company size" dropdown,
 * no budget qualifier and nothing that exists to score the sender before a human
 * reads them. Those fields are there to sort people, and a product with four
 * published plans and every limit on the pricing page has already done the
 * sorting — anybody who reaches this page has read the numbers and still has a
 * question, which is the only signal worth having.
 *
 * ── Why the alternatives are on the page ──
 * A contact form is the slowest way to ask most questions, so the two faster
 * ones sit beside it. Somebody with a bug should open an issue, and somebody
 * deciding whether the product fits should read the docs; sending either of them
 * through a form and a reply cycle wastes a day to arrive at a link.
 */

const TITLE = 'Contact sales';
const DESCRIPTION =
  'Talk to the people building xecret about an Enterprise agreement, data residency, your own root key, or a security review. No forms that sort you first.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: ['contact xecret', 'enterprise secret management', ...SITE_KEYWORDS],
  alternates: { canonical: absoluteUrl('/contact') },
  openGraph: {
    type: 'website',
    url: absoluteUrl('/contact'),
    siteName: SITE_NAME,
    title: `${TITLE} · ${SITE_NAME}`,
    description: DESCRIPTION,
  },
};

const REACHES_US = [
  {
    title: 'An Enterprise agreement',
    body: 'Residency, your own root key, a commercial licence for self-hosting, an SLA with a named contact. A conversation rather than a checkout, which is why that card has no price.',
  },
  {
    title: 'A security review',
    body: 'Send the questionnaire. The architecture and threat model are already published, so most of it is answerable with links — and where it is not, the answer becomes a page rather than a PDF.',
  },
  {
    title: 'A migration',
    body: 'Moving off something else, with more secrets than a weekend of copy-paste allows. Tell us what you are on and how it is structured.',
  },
] as const;

export default function ContactPage() {
  // No `current` is passed: contact is not a top-level nav entry. It is reached
  // from the Enterprise card and from the pricing page, which is where a page
  // nobody browses to on purpose belongs — putting it in the header would give a
  // product with four published prices a permanent "talk to sales" button.
  return (
    <PublicPage>
      <PageHero
        height="compact"
        eyebrow="Contact"
        title="Talk to the people building it."
        description="There is no sales team, so this reaches the people who write the code. Everything self-serve is on the pricing page with its limits published; this is for the things a page cannot answer."
      />

      <Section id="contact" aria-labelledby="contact-heading" tone="canvas" size="md">
        <h2 id="contact-heading" className="sr-only">
          Send a message
        </h2>

        {/* One centred column rather than a form beside a sidebar. The
            two-column arrangement put the thing somebody came to do off to one
            side of the thing explaining it, and on a page with exactly one
            action that is the wrong emphasis — the supporting material reads
            better *after* the form than beside it, where it competed. */}
        <div className="mx-auto max-w-2xl">
          <div className="border-line bg-surface rounded-xl border p-6 sm:p-8">
            <ContactForm />
          </div>

          <div className="mt-12 grid gap-8 sm:grid-cols-3">
            {REACHES_US.map((item) => (
              <div key={item.title}>
                <h3 className="text-fg text-sm font-semibold">{item.title}</h3>
                <p className="text-fg-muted mt-2 text-sm leading-6">{item.body}</p>
              </div>
            ))}
          </div>

          {/* The two faster routes, said plainly rather than buried. A form is
              the wrong tool for a bug report and for a question the docs already
              answer, and pretending otherwise costs the sender a day to be
              handed a link. */}
          <div className="border-line-subtle mt-10 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 border-t pt-6">
            <a
              href={`${REPO_URL}/issues`}
              target="_blank"
              rel="noreferrer noopener"
              className={QUIET_LINK}
            >
              Open an issue
              <ExternalLinkIcon className="size-3.5" />
            </a>
            <Link href="/docs" className={QUIET_LINK}>
              Read the documentation
              <ArrowRightIcon className="size-3.5" />
            </Link>
            <Link href="/pricing" className={QUIET_LINK}>
              Every plan, with its limits
              <ArrowRightIcon className="size-3.5" />
            </Link>
          </div>
        </div>
      </Section>
    </PublicPage>
  );
}

import Link from 'next/link';
import type { ReactNode } from 'react';

import { CtaBand } from './cta-band';
import { JsonLd } from './json-ld';
import { INLINE_LINK } from './link-styles';
import { PageHero } from './page-hero';
import { PublicPage } from './public-page';
import { Container } from './section';

/**
 * The frame the privacy policy and the terms of service render inside.
 *
 * ── Why a document is data and not JSX ──
 * Two legal documents written by hand drift apart on the first edit: one grows
 * a contents list and the other does not, clause nine loses its anchor, and the
 * link that used to point at it now points at nothing. So a document is a
 * `LegalSection[]`, and every structural thing — the contents list, the
 * numbering, the `#` anchors, the `aria-labelledby` — is derived from that one
 * array. The contents cannot disagree with the body because it is not written
 * down twice, and renumbering happens by editing the array.
 *
 * ── Why not `.doc-prose` ──
 * That stylesheet exists because the markdown renderer emits HTML with no JSX
 * to hang a `className` on. Here there is JSX. Importing it would drag the
 * code-block chrome, the callout variants and a syntax palette onto a page that
 * has none of them, and would tie the setting of a contract to a stylesheet
 * maintained for reference documentation.
 *
 * The one number taken from it is `scroll-mt-[5.5rem]`, which matches
 * `.doc-heading`'s `scroll-margin-top`: the clearance a `#` link needs to land
 * below the sticky header instead of underneath it. Copied on purpose — a
 * design token shared by two files is a token nobody maintains — but it is the
 * value here that has to move the day the header's height does.
 *
 * ── Why the body is `--fg-muted` and the docs' body is `--fg` ──
 * On a reference page the prose is the page. Here it is not: what a person acts
 * on is the summary box, the headings and the contents rail, and four thousand
 * words of clause text set at full ink drowns all three. `--fg-muted` measures
 * AAA on both canvases, so this costs legibility nothing.
 */

/** A paragraph. An array of them renders as a bulleted list instead. */
export type LegalBlock = ReactNode | readonly ReactNode[];

export interface LegalSection {
  /**
   * The `#` anchor, and the section's identity. Stable: somebody citing clause
   * nine cites this string, and a link from another page or an email survives
   * only as long as it does. Rename the heading freely; do not rename this.
   */
  readonly id: string;
  readonly heading: string;
  readonly paragraphs: readonly LegalBlock[];
}

export interface LegalPageProps {
  eyebrow: string;
  title: string;
  description: string;
  /** ISO dates. Rendered long-form, and published in `<time dateTime>`. */
  updated: string;
  effective: string;
  /**
   * The plain-English précis, above the formal text. On a secrets product this
   * is not a gimmick — it is the part people read — so it is a required prop
   * rather than an optional one a second document could quietly omit.
   */
  readonly summary: readonly string[];
  readonly sections: readonly LegalSection[];
  /** The page's `@graph`, rendered here so neither document can forget it. */
  structuredData: unknown;
}

/**
 * The caveat both documents carry, written once.
 *
 * It is the sentence most likely to be edited under pressure — the day the
 * product stops being pre-alpha, somebody rewrites it — and two copies is how a
 * site ends up telling one visitor it is pre-alpha and the next that it is not.
 */
const NOTICE =
  'xecret is in pre-alpha. This document was written for that stage and will be reviewed by a ' +
  'lawyer before general availability, so expect it to change and expect to be told when it ' +
  'does. It is written to be understood rather than to be exhaustive, and it is not legal advice.';

/**
 * `16 August 2026`, formatted in UTC.
 *
 * The timezone is the whole point of the option: an ISO date parses as UTC
 * midnight, and formatting it anywhere west of Greenwich prints the day before
 * — on the one line of a legal document whose job is to say when it took
 * effect.
 */
const LONG_DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

function formatDate(iso: string): string {
  return LONG_DATE.format(new Date(iso));
}

function isList(block: LegalBlock): block is readonly ReactNode[] {
  return Array.isArray(block);
}

/**
 * A fact we cannot state truthfully yet, marked in the rendered page.
 *
 * Not a `TODO` in a comment, and not an invented address: a company number
 * nobody has checked reads exactly like a real one, and on the two pages that
 * exist to be believed, an invention is worse than a gap. So the gap is visible
 * to the reader, it carries the warning colour, and it is impossible to ship
 * without noticing. The brackets are added here so a call site cannot forget
 * them.
 */
export function Placeholder({ children }: { children: string }) {
  return (
    <mark className="border-warning-line bg-warning-tint text-warning-text rounded-sm border px-1 py-px text-[0.9em] font-medium">
      [{children}]
    </mark>
  );
}

/**
 * A cross-reference inside a clause, wearing the site's inline link treatment.
 *
 * `link-styles.ts` argues for a class string over a component, and it is right
 * everywhere a page is written as JSX and the author can see which element they
 * are reaching for. These two documents are written as data: every link in them
 * is one entry in an array, edited later by whoever is updating a clause, and
 * that is exactly where `rel="noreferrer noopener"` gets left off an outbound
 * link. So the choice is made once, from the href, and the class string is
 * still the shared one.
 */
export function LegalLink({ href, children }: { href: string; children: ReactNode }) {
  if (href.startsWith('http')) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener" className={INLINE_LINK}>
        {children}
      </a>
    );
  }

  return (
    <Link href={href} className={INLINE_LINK}>
      {children}
    </Link>
  );
}

function Blocks({ blocks }: { blocks: readonly LegalBlock[] }) {
  return (
    <>
      {blocks.map((block, index) =>
        isList(block) ? (
          // `space-y` rather than a flex column: `display: flex` on a list
          // stops its items being `list-item`, and the disc silently
          // disappears. Margins keep the marker.
          <ul
            key={index}
            className="marker:text-fg-subtle text-fg-muted mt-4 list-disc space-y-2 pl-5 text-[0.9375rem] leading-7"
          >
            {block.map((item, itemIndex) => (
              <li key={itemIndex} className="pl-1">
                {item}
              </li>
            ))}
          </ul>
        ) : (
          <p key={index} className="text-fg-muted mt-4 text-[0.9375rem] leading-7">
            {block}
          </p>
        ),
      )}
    </>
  );
}

export function LegalPage({
  eyebrow,
  title,
  description,
  updated,
  effective,
  summary,
  sections,
  structuredData,
}: LegalPageProps) {
  return (
    // No `current`: neither document is in the top navigation, and marking one
    // of the five product links as current on a page that is not it is worse
    // than marking nothing.
    <PublicPage>
      <JsonLd data={structuredData} />

      {/* `compact`, not the full-screen hero the marketing pages use: somebody
          opening the privacy policy came to read it, and a screen of
          atmosphere between them and clause one is burying the terms. */}
      <PageHero eyebrow={eyebrow} title={title} description={description} height="compact" />

      <Container className="pb-20 sm:pb-24">
        {/* A legal measure, not the site measure. Contract text at 80rem is
            unreadable, and the reason this article is not built from `Section`
            is that a single column of prose does not want horizon lines through
            it every four clauses. */}
        <article className="mx-auto max-w-3xl">
          <p className="text-fg-subtle text-sm">
            Last updated{' '}
            <time dateTime={updated} className="text-fg-muted font-medium">
              {formatDate(updated)}
            </time>
            {' · Effective '}
            <time dateTime={effective} className="text-fg-muted font-medium">
              {formatDate(effective)}
            </time>
          </p>

          <div className="border-warning-line bg-warning-tint mt-6 rounded-xl border p-5">
            <p className="text-warning-text text-xs font-semibold tracking-[0.14em] uppercase">
              Pre-alpha · not legal advice
            </p>
            <p className="text-fg-muted mt-2 text-[0.9375rem] leading-7">{NOTICE}</p>
          </div>

          <section
            id="short-version"
            aria-labelledby="short-version-heading"
            className="border-line bg-surface mt-6 scroll-mt-[5.5rem] rounded-xl border p-5 sm:p-6"
          >
            <h2
              id="short-version-heading"
              className="text-fg text-lg font-semibold tracking-[-0.01em]"
            >
              The short version
            </h2>
            <p className="text-fg-subtle mt-1.5 text-sm leading-6">
              Plain English, and not the agreement. Where this summary and the text below disagree,
              the text below is what applies.
            </p>
            <ul className="marker:text-fg-subtle text-fg-muted mt-4 list-disc space-y-2.5 pl-5 text-[0.9375rem] leading-7">
              {summary.map((point) => (
                <li key={point} className="pl-1">
                  {point}
                </li>
              ))}
            </ul>
          </section>

          <nav aria-labelledby="contents-heading" className="mt-10">
            <h2
              id="contents-heading"
              className="text-fg-subtle text-xs font-semibold tracking-[0.14em] uppercase"
            >
              Contents
            </h2>
            {/* The numbers are rendered rather than left to `list-decimal`,
                because the same `index + 1` numbers the headings below. One
                source, so a reader following "see clause 9" lands on 9. */}
            <ol className="mt-4 grid gap-x-8 gap-y-2 sm:grid-cols-2">
              {sections.map((section, index) => (
                <li key={section.id} className="flex gap-2.5 text-[0.9375rem] leading-6">
                  <span aria-hidden="true" className="text-fg-subtle tabular-nums">
                    {index + 1}.
                  </span>
                  <a
                    href={`#${section.id}`}
                    className="text-fg-muted hover:text-fg decoration-line-strong hover:decoration-fg rounded-sm underline underline-offset-4 transition-colors"
                  >
                    {section.heading}
                  </a>
                </li>
              ))}
            </ol>
          </nav>

          {sections.map((section, index) => (
            <section
              key={section.id}
              id={section.id}
              aria-labelledby={`${section.id}-heading`}
              className="border-line-subtle mt-10 scroll-mt-[5.5rem] border-t pt-8"
            >
              <h2
                id={`${section.id}-heading`}
                className="text-fg text-lg font-semibold tracking-[-0.01em] sm:text-xl"
              >
                <span aria-hidden="true" className="text-fg-subtle mr-2 font-normal tabular-nums">
                  {index + 1}.
                </span>
                {section.heading}
              </h2>
              <Blocks blocks={section.paragraphs} />
            </section>
          ))}
        </article>
      </Container>

      {/* The site's one closing action, unchanged. A bespoke pitch at the foot
          of a privacy policy reads as a sales page wearing a legal document,
          which is the impression these two pages exist to avoid. */}
      <CtaBand />
    </PublicPage>
  );
}

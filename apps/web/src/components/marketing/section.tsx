import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

/**
 * The layout primitives every public page is built from.
 *
 * Eight marketing pages written by hand drift within a week: one uses `py-16`,
 * the next `py-20`, a third centres its heading and a fourth does not, and the
 * site stops reading as one product. So the rhythm is three components, and a
 * page is a list of `<Section>`s.
 */

/** The site's measure. `.x-container` — see globals.css — owns the numbers. */
export function Container({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('x-container', className)}>{children}</div>;
}

export interface SectionProps {
  /** The section's own anchor, for `#` links from a table of contents. */
  id?: string;
  /**
   * The `id` of the heading that names this section — pass the same string as
   * the `SectionHeading`'s `headingId`.
   *
   * A `<section>` is only exposed as a landmark to assistive technology when it
   * has an accessible name. Without this, a page of eight sections is one
   * undifferentiated region and the shortcut that jumps between landmarks —
   * which is how a screen-reader user skims a long marketing page — has
   * nothing to jump to.
   */
  'aria-labelledby'?: string;
  /**
   * `inset` tints the band and rules it off top and bottom. Alternating it
   * against the default canvas is what gives a long page its horizon lines —
   * without them a marketing page is one uninterrupted scroll and the reader
   * loses their place in it.
   */
  tone?: 'canvas' | 'inset';
  /** Trims the vertical rhythm, for a band that sits directly under another. */
  size?: 'md' | 'lg';
  className?: string;
  children: ReactNode;
}

export function Section({
  id,
  'aria-labelledby': labelledBy,
  tone = 'canvas',
  size = 'lg',
  className,
  children,
}: SectionProps) {
  return (
    <section
      // The id belongs on the section rather than the heading so that a `#`
      // link lands above the heading's own top padding, not level with it.
      id={id}
      aria-labelledby={labelledBy}
      className={cn(
        // `scroll-mt-24` clears the floating header. Without it every `#`
        // link on the site lands with its heading tucked under the bar, which
        // is the sort of thing nobody files a bug about and everybody notices.
        'relative scroll-mt-24',
        tone === 'inset' && 'border-line-subtle bg-canvas-inset/60 border-y',
        className,
      )}
    >
      <Container className={size === 'lg' ? 'py-20 sm:py-24' : 'py-14 sm:py-16'}>
        {children}
      </Container>
    </section>
  );
}

export interface SectionHeadingProps {
  /** The small label above the heading. Sentence case, never a sentence. */
  eyebrow?: string;
  title: ReactNode;
  /** One or two sentences. Longer than that belongs in the section body. */
  description?: ReactNode;
  /** The heading's `id`, for the section's `aria-labelledby`. */
  headingId?: string;
  align?: 'left' | 'center';
  /** `h2` by default; a page whose section is a sub-part passes `h3`. */
  as?: 'h2' | 'h3';
  className?: string;
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  headingId,
  align = 'left',
  as: Heading = 'h2',
  className,
}: SectionHeadingProps) {
  return (
    <div
      className={cn(
        // `text-balance` on the heading and a measure on the description: a
        // marketing heading that breaks one word onto its own line, and a
        // paragraph that runs 140 characters wide, are the two things that make
        // an otherwise finished page look unfinished.
        align === 'center' ? 'mx-auto max-w-2xl text-center' : 'max-w-2xl',
        className,
      )}
    >
      {eyebrow ? (
        <p className="text-fg-subtle text-xs font-semibold tracking-[0.14em] uppercase">
          {eyebrow}
        </p>
      ) : null}
      <Heading
        id={headingId}
        className={cn(
          'text-fg text-2xl leading-tight font-semibold tracking-[-0.02em] text-balance sm:text-[2rem]',
          eyebrow && 'mt-3',
        )}
      >
        {title}
      </Heading>
      {description ? (
        <p className="text-fg-muted mt-4 text-base leading-7 sm:text-[1.0625rem] sm:leading-8">
          {description}
        </p>
      ) : null}
    </div>
  );
}

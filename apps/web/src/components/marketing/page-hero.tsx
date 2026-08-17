import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';
import { Container } from './section';

/**
 * The top of every public page except the landing page, which has a hero of
 * its own because it has a product demo to put beside the claim.
 *
 * Shared so that /features, /pricing, /about, /blog and the legal pages all
 * start at the same point on the page. A visitor moving between them should
 * see the headline land in the same place every time; that steadiness is most
 * of what makes a set of pages feel like a site rather than a folder.
 *
 * The glow and the grid are absolutely positioned behind the copy — see
 * `.x-hero-glow` and `.x-grid-lines` in globals.css — and the content is
 * lifted over them with `relative`, not with a z-index scale nobody maintains.
 */
export function PageHero({
  eyebrow,
  title,
  description,
  height = 'tall',
  children,
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  /**
   * How much of the first screen the hero claims.
   *
   * ── `screen` — the whole viewport ──
   * For a page where the first screen *is* the argument, and where the hero
   * carries enough content to fill it: an eyebrow, a two-line headline, a
   * three-line description and a pair of buttons. `/features` and `/about`.
   *
   * ── `tall` — the default ──
   * Sized by its content, with a floor. A hero pinned to the full viewport
   * with its copy centred leaves roughly a third of a screen empty beneath
   * that copy; where the hero is short — no buttons, two lines of description
   * — that emptiness stacks with the next section's own padding and reads as a
   * hole rather than as breathing room. `/pricing`, `/blog` and `/faq` all
   * have short heroes, so they get a box that fits them.
   *
   * The distinction is content, not importance. A `screen` hero with nothing
   * in it is the exact defect `tall` exists to avoid.
   *
   * ── `compact` — out of the way ──
   * For a page somebody came to read: the privacy policy and the terms.
   * Making a reader scroll past a screen of atmosphere to reach the document
   * they opened is a small act of contempt, and on a legal page it is also the
   * one place a court would call it burying the terms.
   */
  height?: 'screen' | 'tall' | 'compact';
  /** Buttons, a price toggle, a search box — whatever the page needs below the copy. */
  children?: ReactNode;
}) {
  return (
    // ── Full viewport height ──
    // `min-h-svh`, not `h-screen` and not `dvh`. `min-h` because a three-line
    // headline on a 13" laptop must be allowed to push past the fold rather
    // than being clipped by it; `svh` because `dvh` re-measures as a mobile
    // browser's address bar hides on scroll, which would resize the hero
    // under the reader's thumb the moment they start scrolling.
    //
    // The header floats over this rather than sitting above it — it is
    // `sticky top-0` with a transparent gutter — so the hero genuinely owns
    // the first screen, and the vertical centring accounts for the bar with
    // padding rather than by subtracting its height from the viewport.
    <section
      className={cn(
        'relative isolate flex flex-col justify-center overflow-hidden',
        // The floor differs by variant. See the `height` prop's documentation
        // for why a full-viewport hero is right for a page with buttons in it
        // and wrong for a page without.
        //
        // `svh` rather than `dvh` throughout: `dvh` re-measures as a mobile
        // browser's address bar hides on scroll, which would resize the hero
        // under the reader's thumb the moment they started scrolling. `min-h`
        // rather than `h` so a three-line headline on a 13" laptop pushes past
        // the fold instead of being clipped by it.
        //
        // ── The optical lift, on `screen` only ──
        // `justify-center` puts the copy on the geometric centre, and the
        // geometric centre of a full viewport reads as low: the eye places the
        // centre of a block of type below where it measures, and the floating
        // header weights the top of the screen with nothing at the foot to
        // answer it. This padding shifts the centred block up by half its
        // value — 48px, 56px from `sm` — which is the correction, not a
        // repositioning.
        //
        // Only `screen` needs it. `tall` is sized by its content, so there is
        // no dead space to be centred within and nothing to correct; adding a
        // lift there would just reintroduce the gap that variant exists to
        // avoid.
        height === 'screen' && 'x-hero-screen min-h-svh pb-24 sm:pb-28',
        height === 'tall' && 'x-hero-screen min-h-[58svh]',
      )}
    >
      <div className="x-hero-glow" aria-hidden="true" />
      <div className="x-grid-lines" aria-hidden="true" />

      {/* The top value is the larger of the two because the floating header
          overlaps this padding and eats about 4.5rem of it — so `pt-32 pb-24`
          is closer to balanced than it looks, and on a short viewport where
          there is no spare height to centre within it is what stops the
          headline landing under the bar.

          Any *deliberate* upward shift belongs to the section, not here — see
          the optical-lift note above. Splitting one adjustment across two
          elements is how a layout ends up with a number nobody can account
          for. The compact variant has no viewport height to centre within at
          all, so it keeps the top clearance and drops the rest. */}
      <Container className={height === 'compact' ? 'relative pt-28 pb-12' : 'relative pt-32 pb-24'}>
        <div className="mx-auto max-w-3xl text-center">
          {eyebrow ? (
            <p className="text-fg-subtle text-xs font-semibold tracking-[0.14em] uppercase">
              {eyebrow}
            </p>
          ) : null}
          {/* Not wrapped in a Reveal, deliberately: the one thing on the page a
              reader must see is the thing that must not depend on a script. */}
          <h1 className="text-fg mt-4 text-4xl leading-[1.08] font-semibold tracking-[-0.03em] text-balance sm:text-5xl">
            {title}
          </h1>
          {description ? (
            <p className="text-fg-muted mx-auto mt-5 max-w-2xl text-base leading-8 text-pretty sm:text-[1.0625rem]">
              {description}
            </p>
          ) : null}
          {children ? <div className="mt-8 flex flex-col items-center">{children}</div> : null}
        </div>
      </Container>
    </section>
  );
}

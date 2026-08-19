import { cn } from '@/lib/cn';

/**
 * The xecret mark.
 *
 * ── One drawing, three places ──
 * The same geometry ships in the favicon set (`scripts/generate-icons.ts`) and
 * in the social card (`scripts/generate-og.ts`). Deliberately identical: a mark
 * that differs between the browser tab and the page it labels is not a mark, it
 * is two logos that happen to share a product. The numbers below — a 32-unit
 * box, a 9-unit corner radius, blades 4.4 units wide reaching 14 units out,
 * tips stopping 2.6 short of centre — were settled at 16px, because that is the
 * size a favicon has to survive. Change one and change the others, then run
 * `npm run icons` and `npm run og`.
 *
 * ── Four blades and the gap between them ──
 * A crosshair turned onto the diagonals. Each blade is pointed at both ends and
 * stops short of the middle, so the X is drawn by four marks that never touch.
 * The 5.2-unit gap is the mark: it is what makes this an X assembled out of
 * what surrounds a centre, rather than a letter with a stroke through it. The
 * outer points are shallower than the inner ones (1.8 against 2.4) — matched
 * points turn each blade into a leaf, and the mark reads as a flower.
 *
 * ── Achromatic, and why the chip still carries a gradient ──
 * This used to run cyan into indigo, which made it the last saturated thing in
 * a product whose palette is now pure grey — where colour means "production",
 * "destructive" or "failed", and nothing else may borrow it. So the chip is
 * black. It keeps a gradient anyway, #1c1c1c to #000 under a 13% white
 * hairline, and that is not decoration: flat black on this application's own
 * #0a0a0a canvas is a mark with no edges. The sheen and the hairline are what
 * let one drawing sit on a white tab strip and on our own dark shell without
 * being redrawn for either.
 *
 * @param gradientId The `id` of this instance's `<linearGradient>`. Only worth
 *   passing when a page renders the mark more than once — see below.
 */
export function LogoMark({
  className,
  gradientId = 'xecret-mark-gradient',
}: {
  className?: string;
  // Explicitly `| undefined` because `exactOptionalPropertyTypes` is on and
  // `Wordmark` forwards the prop whether or not its own caller supplied one.
  gradientId?: string | undefined;
}) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn('size-6', className)}
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        {/* The id comes from a prop rather than `useId`: this file is imported
            by Server Components — the marketing page and the auth layout —
            where hooks cannot run, and making it a client component to
            generate a string would pull the mark into every consumer's bundle.
            So the caller names it, and the one page that renders the mark
            twice gives its second instance a different name. Sharing the
            default across both would still paint correctly while the two
            definitions match; it costs a duplicate `id` in the document, and
            a `url(#…)` that would quietly resolve to whichever gradient came
            first the moment they stop matching. */}
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#1c1c1c" />
          <stop offset="1" stopColor="#000000" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${gradientId})`} />
      {/* The hairline, inset by half its own width so it lands inside the chip
          rather than straddling its edge. It is the only thing separating a
          black chip from the near-black canvas behind it in the dark theme. */}
      <rect x="0.5" y="0.5" width="31" height="31" rx="8.5" stroke="#ffffff" strokeOpacity="0.13" />
      <path
        fill="#fafafa"
        d="M25.9 25.9L23.07 26.18L17.98 21.09L17.84 17.84L21.09 17.98L26.18 23.07ZM25.9 6.1L26.18 8.93L21.09 14.02L17.84 14.16L17.98 10.91L23.07 5.82ZM6.1 6.1L8.93 5.82L14.02 10.91L14.16 14.16L10.91 14.02L5.82 8.93ZM6.1 25.9L5.82 23.07L10.91 17.98L14.16 17.84L14.02 21.09L8.93 26.18Z"
      />
    </svg>
  );
}

/**
 * The mark and the product name, locked together.
 *
 * ── Why the chip is sized in `em` ──
 * The whole lockup scales from one number: the wrapper's font size. The chip is
 * `1.6em` of it and the gap `0.5em`, which are the 24px and 8px this pair has
 * always had against a 15px word — so a caller that wants a bigger wordmark
 * passes one text size and the rest follows in proportion. The alternative — a
 * `size-*` on the chip, a `gap-*` between, and a `text-*` on the word — is
 * three numbers a caller has to keep in proportion by hand, and they drift the
 * first time somebody bumps one of them.
 *
 * ── This is an inline-flex span, so mind what wraps it ──
 * Put it in a flex container. Inside an *inline* parent — a bare `<a>` — it is
 * laid out on that parent's text baseline, which reserves a descender's worth
 * of unused space beneath it and lifts the lockup off the centre of whatever
 * bar it sits in. That is a real bug this header shipped with; see the note at
 * the anchor in `site-header`.
 */
export function Wordmark({
  className,
  gradientId,
}: {
  className?: string;
  // Explicitly `| undefined` for the same reason `LogoMark` states it above:
  // `exactOptionalPropertyTypes` is on, and callers forward the prop whether or
  // not they were given one.
  gradientId?: string | undefined;
}) {
  return (
    <span className={cn('inline-flex items-center gap-[0.5em] text-[0.9375rem]', className)}>
      <LogoMark className="size-[1.6em] shrink-0" gradientId={gradientId} />
      <span className="text-fg font-semibold tracking-tight">xecret</span>
    </span>
  );
}

/**
 * The attribution mark. Deliberately quiet: it belongs in a footer or the base
 * of a sign-in card, not competing with the product name.
 *
 * A link to the company site, in a new tab — the reader is mid-task in xecret
 * (often mid-sign-in), and attribution must not navigate them out of it.
 * `rel="noopener noreferrer"` because every `target="_blank"` gets it: the
 * opened page must not hold a handle back to a window with a session in it.
 */
export function PlayxoftMark({ className }: { className?: string }) {
  return (
    <a
      href="https://playxoft.com"
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'text-fg-subtle inline-flex items-center gap-1.5 rounded-sm text-sm transition-colors',
        'hover:text-fg-muted',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="bg-fg-subtle/40 inline-block h-3 w-px shrink-0 rotate-12 rounded-full"
      />
      Powered by <span className="text-fg-muted font-medium">Playxoft</span>
    </a>
  );
}

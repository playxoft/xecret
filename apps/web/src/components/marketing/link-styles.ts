/**
 * The public site's inline link treatment.
 *
 * ── Why underlined at rest ──
 * The palette went monochrome deliberately: hue on this site means status —
 * success, warning, danger, production — and nothing may borrow it. That
 * leaves no colour to say "link". Bold foreground text that only reveals
 * itself on hover is a link nobody who is not already dragging a pointer over
 * it can find, which on a touch screen is everybody. So the underline is
 * always there and the hover state only strengthens it.
 *
 * A class string rather than a component because half its uses are `next/link`
 * and half are a plain `<a>` to somewhere off-site, and a wrapper that has to
 * accept either ends up being two components with one name.
 */

/** An inline link inside a paragraph. Inherits its surroundings' size. */
export const INLINE_LINK =
  'text-fg decoration-line-strong hover:decoration-fg rounded-sm font-medium ' +
  'underline underline-offset-4 transition-colors';

/**
 * A standalone link that ends a section — usually carrying a trailing arrow.
 *
 * `inline-flex` so the arrow sits on the text's baseline box rather than
 * dangling below it, and `gap-1.5` so the two never touch.
 */
export const QUIET_LINK = `${INLINE_LINK} inline-flex items-center gap-1.5`;

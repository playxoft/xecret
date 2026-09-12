/**
 * How a keyboard shortcut is announced, as opposed to drawn.
 *
 * ── Why this is not in `kbd.tsx` ──
 * That file is a `'use client'` module, and every export of one is a *client
 * reference* when a Server Component imports it — not the value. Calling one
 * from the server fails at render with "attempted to call … from the server",
 * which is what happened the moment the public site header — a Server
 * Component, deliberately — wanted to announce the landing page's `S` shortcut.
 *
 * These two are pure string functions with no runtime of their own, so they
 * belong in a module either side can import. `kbd.tsx` re-exports them, which
 * keeps every client call site unchanged.
 */

/**
 * A chord as an `aria-keyshortcuts` value — `['Shift','1']` → `Shift+1`.
 *
 * This, on the control itself, is how a shortcut is announced. The key caps
 * beside it are decorative: read individually they come out as "up-pointing
 * triangle, one", and read as part of a link's name they turn "Projects" into
 * "Projects Shortcut Shift 1". `aria-keyshortcuts` is the attribute the
 * platform already has for this, and screen readers announce it separately from
 * the name.
 *
 * The attribute's grammar is a space-separated list of `+`-joined tokens, so a
 * chord that itself contained a space would be two shortcuts; there is no such
 * key, but the join is written to be obvious about that.
 */
export function ariaKeyShortcuts(keys: readonly string[]): string {
  return keys.join('+');
}

/**
 * The `aria-keyshortcuts` name for the modifier `useModKey` prints.
 *
 * The cap and the attribute speak different vocabularies: a cap draws `⌘`,
 * while the attribute's grammar is written in `KeyboardEvent.key` names, where
 * that key is `Meta`. Derived from the value the cap is drawn from so the two
 * can never announce a different key than the one printed beside them.
 */
export function ariaModKey(mod: string): string {
  return mod === '⌘' ? 'Meta' : 'Control';
}

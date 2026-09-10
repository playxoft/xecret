'use client';

import { useSyncExternalStore } from 'react';
import type { HTMLAttributes } from 'react';

import { cn } from '@/lib/cn';

/**
 * The glyphs a key cap shows instead of its name.
 *
 * Only keys whose symbol is genuinely universal are here. `⇧` and `↵` are
 * read the same way on every keyboard sold; `Esc` and `Tab` are *printed* as
 * words on the physical key, so showing a word is showing the key. Anything
 * absent from this table renders as whatever the caller passed, which is why
 * a bare letter — the common case — needs no entry at all.
 *
 * `Mod` is deliberately not here. Rendering `⌘` on macOS and `Ctrl` elsewhere
 * requires reading `navigator` at runtime, which the server cannot do; the
 * markup would hydrate into a different string and React would warn on every
 * shortcut on the page. `useModKey` below is how a caller gets it: after the
 * commit, never during render, so both passes agree.
 */
const GLYPHS: Record<string, string> = {
  shift: '⇧',
  enter: '↵',
  return: '↵',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  backspace: '⌫',
  delete: '⌦',
  space: '␣',
};

/**
 * The glyph for a key name, or the name itself.
 *
 * Asked with `Object.hasOwn` rather than by indexing: `GLYPHS` is an object
 * literal, so it inherits from `Object.prototype`, and two of the names living
 * there are already lower case. `constructor` reads back the `Object`
 * function and `__proto__` the prototype object; `??` never fires on either,
 * because neither is nullish; and React is handed a value where a string
 * belongs. Every chord in this repository is a literal written at its call
 * site, so nothing reaches that today — the guard is one call, and it means
 * the component stays correct without anyone having to know that.
 */
function glyphFor(key: string): string {
  const name = key.toLowerCase();
  return (Object.hasOwn(GLYPHS, name) ? GLYPHS[name] : undefined) ?? key;
}

/**
 * The same chord as an `aria-keyshortcuts` value — `['Shift','1']` → `Shift+1`.
 *
 * This, on the control itself, is how a shortcut is announced. The caps are
 * decorative: read individually they come out as "up-pointing triangle, one",
 * and read as part of a link's name they turn "Projects" into "Projects
 * Shortcut Shift 1". `aria-keyshortcuts` is the attribute the platform already
 * has for this, and screen readers announce it separately from the name.
 *
 * The attribute's grammar is a space-separated list of `+`-joined tokens, so a
 * chord that itself contains a space would be two shortcuts; there is no such
 * key, but the join is written to be obvious about that.
 */
export function ariaKeyShortcuts(keys: readonly string[]): string {
  return keys.join('+');
}

export interface KbdProps extends HTMLAttributes<HTMLElement> {
  /** Rendered as-is. `Shortcut` maps names to glyphs before it gets here. */
  children?: string;
}

/**
 * One key cap.
 *
 * Sans rather than the monospace `<kbd>` default: these sit at the trailing
 * edge of a nav row beside a sans label, and a monospace `Q` next to a sans
 * "Tracker" reads as a code fragment that wandered into the furniture. The
 * cap earns its "physical key" shape from `--sheen` — a hairline drawn on the
 * top edge in dark and the underside in light — rather than from its face.
 *
 * Muted rather than full-contrast ink, because a shortcut hint is an offer,
 * not a label. It should be legible the moment you look for it and silent
 * when you are not.
 */
export function Kbd({ className, children, ...props }: KbdProps) {
  return (
    <kbd
      className={cn(
        'border-line-strong bg-surface-hover text-fg-muted shadow-sheen font-sans',
        'inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-sm border',
        'px-1.5 text-[0.6875rem] leading-none font-semibold',
        className,
      )}
      {...props}
    >
      {children}
    </kbd>
  );
}

export interface ShortcutProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  /**
   * The chord, one key per entry: `['Shift', '1']`, `['G']`.
   *
   * Separate caps rather than a `Shift+1` string, because that is the shape of
   * the thing being described — two keys — and it survives translation into a
   * glyph without inventing a `⇧+1` that no keyboard legend uses.
   */
  keys: readonly string[];
}

/**
 * A chord, as a row of key caps.
 *
 * Entirely decorative — see `ariaKeyShortcuts` for the half of this that
 * assistive technology reads. The caps describe a shortcut that some *other*
 * element owns, so putting them in the accessibility tree can only duplicate
 * or corrupt that element's name.
 */
export function Shortcut({ keys, className, ...props }: ShortcutProps) {
  if (keys.length === 0) return null;

  return (
    <span
      className={cn('inline-flex shrink-0 items-center gap-1', className)}
      aria-hidden="true"
      {...props}
    >
      {keys.map((key, index) => (
        // Index-keyed deliberately: a chord is a fixed-length literal written
        // at the call site, and the same key can legitimately appear twice.
        <Kbd key={`${key}-${index}`}>{glyphFor(key)}</Kbd>
      ))}
    </span>
  );
}

function subscribeToNothing(): () => void {
  // The platform cannot change under a running tab, so there is nothing to
  // subscribe to. The store is a constant read through the hook that knows how
  // to keep a constant off the server.
  return () => {};
}

function modKeySnapshot(): string {
  const source = `${navigator.platform ?? ''} ${navigator.userAgent}`;
  return /mac|iphone|ipad|ipod/i.test(source) ? '⌘' : 'Ctrl';
}

function noModKey(): null {
  return null;
}

/**
 * The platform's modifier key: `'⌘'` on a Mac, `'Ctrl'` everywhere else — and
 * `null` on the server, where the question has no answer.
 *
 * ── Why `useSyncExternalStore` and not an effect ──
 * The server has no `navigator`, so a cap computed during render would be
 * `Ctrl` in the HTML and `⌘` after hydration — a mismatch on every shortcut on
 * the page. This hook is React's own answer to exactly that: `getServerSnapshot`
 * is used for the server render *and* for hydration, and `getSnapshot` takes
 * over immediately afterwards. No setState, no cascading render, no mismatch.
 *
 * Callers render nothing while it is `null`. That lasts until the first commit,
 * which is long before anybody could have pressed the key.
 *
 * `navigator.platform` is deprecated and still the most reliable answer where
 * it exists, so it is consulted first and the user-agent string is the
 * fallback — the same order every editor in the browser uses.
 */
export function useModKey(): string | null {
  return useSyncExternalStore(subscribeToNothing, modKeySnapshot, noModKey);
}

'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo } from 'react';

import type { NavItem, NavSection } from './sidebar';

/**
 * The physical key a declared chord means.
 *
 * `event.key` is the wrong thing to match on for anything held with Shift: on
 * a US layout `Shift` + the `1` key reports `"!"`, on a German one it reports
 * `"!"` from a different physical key, and a chord declared as `['Shift','1']`
 * would match neither. `event.code` names the position instead, which is what
 * a key cap printed `1` actually refers to.
 *
 * Non-Latin and non-QWERTY layouts are the known cost. A Dvorak typist sees
 * `Q` on the cap and presses the key their keyboard calls `Q`, which reports
 * `KeyQ` and works; a Cyrillic layout reports `KeyQ` for `Й`, so the cap lies.
 * That is the same trade every application with single-letter navigation makes,
 * and the alternative — matching `event.key` — breaks the Shift chords for
 * everybody instead of the caps for a few.
 */
function codeFor(key: string): string | null {
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  return null;
}

/** `['Shift','1']` → `shift:Digit1`. `null` when the chord is unmatchable. */
function chordId(keys: readonly string[]): string | null {
  const shift = keys.some((key) => key.toLowerCase() === 'shift');
  const rest = keys.filter((key) => key.toLowerCase() !== 'shift');
  if (rest.length !== 1) return null;

  const code = codeFor(rest[0] as string);
  if (code === null) return null;

  return `${shift ? 'shift:' : ''}${code}`;
}

function collect(sections: readonly NavSection[]): ReadonlyMap<string, string> {
  const map = new Map<string, string>();

  function walk(items: readonly NavItem[]): void {
    for (const item of items) {
      if (item.shortcut && item.shortcut.length > 0) {
        const id = chordId(item.shortcut);
        // First declaration wins. A duplicate is a bug in the nav definition
        // rather than something to resolve at runtime, and silently
        // preferring the later one would make it depend on section order.
        if (id !== null && !map.has(id)) map.set(id, item.href);
      }
      if (item.children) walk(item.children);
    }
  }

  walk(sections.flatMap((section) => section.items));
  return map;
}

/**
 * True when a keystroke belongs to whatever the user is doing, not to us.
 *
 * Unmodified single letters are a hostile thing to claim globally in this
 * product in particular: people paste and hand-edit secret values here all
 * day, and a stray `S` that navigates away mid-edit is indistinguishable from
 * data loss. So the bar for stealing one is deliberately high.
 */
function isTypingContext(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * True while a dialog, menu or listbox owns the keyboard.
 *
 * Radix marks its open overlays with `data-state="open"`, and every one of
 * them has its own key handling — `Escape` to close, typeahead to jump to an
 * item. Navigating out from under an open dialog would also strand the focus
 * trap on a page that no longer exists.
 */
function isOverlayOpen(): boolean {
  return (
    document.querySelector(
      '[data-state="open"][role="dialog"],' +
        '[data-state="open"][role="alertdialog"],' +
        '[data-state="open"][role="menu"],' +
        '[data-state="open"][role="listbox"]',
    ) !== null
  );
}

/**
 * Makes the key caps in the sidebar do what they say.
 *
 * The nav tree is the single source of truth in both directions: `Sidebar`
 * draws a cap for every item carrying `shortcut`, and this builds its key map
 * from the same items. Neither half can drift into advertising a chord that
 * does nothing, or handling one nobody was told about.
 */
export function useNavShortcuts(nav: readonly NavSection[], enabled = true): void {
  const router = useRouter();

  // Keyed on the nav's own shape rather than the array identity: the dashboard
  // rebuilds this array on every render, and re-subscribing a document-level
  // listener that often is both wasteful and a good way to miss a keystroke
  // between teardown and setup.
  const shortcuts = useMemo(() => collect(nav), [nav]);
  const fingerprint = useMemo(
    () =>
      [...shortcuts]
        .map(([id, href]) => `${id}>${href}`)
        .sort()
        .join('|'),
    [shortcuts],
  );

  useEffect(() => {
    if (!enabled || fingerprint === '') return;

    const map = new Map(
      fingerprint.split('|').map((entry) => entry.split('>') as [string, string]),
    );

    function onKeyDown(event: KeyboardEvent) {
      // `Ctrl`/`Cmd`/`Alt` belong to the browser and the OS. Only `Shift` is
      // ours to combine with, and only because it is part of the declared
      // chord rather than a modifier we invented.
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.defaultPrevented || event.repeat) return;
      if (isTypingContext(event.target) || isOverlayOpen()) return;

      const href = map.get(`${event.shiftKey ? 'shift:' : ''}${event.code}`);
      if (href === undefined) return;

      event.preventDefault();
      router.push(href);
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [enabled, fingerprint, router]);
}

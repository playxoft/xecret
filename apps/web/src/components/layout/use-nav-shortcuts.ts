'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo } from 'react';

import { askBeforeLeaving } from '@/components/ui/leave-guard';
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
 * ARIA roles belonging to a widget that reads plain keys for itself.
 *
 * A tag name alone does not identify one. A closed Radix `Select` trigger is a
 * `<button role="combobox">`, and pressing `M` on it is meant to typeahead to
 * "Member" — but Radix consumes that letter *without* calling
 * `preventDefault`, so `event.defaultPrevented` cannot be used to detect it
 * either. The role is the only thing on the element that announces "I have my
 * own keyboard", which makes it the thing to match on.
 *
 * The list is wider than the roles that typeahead today — a `slider` or a
 * `tab` reads arrows, not letters — because the two mistakes are not the same
 * size. Standing down costs the user one keypress somewhere else on the page;
 * firing costs them the interaction they were halfway through. So anything
 * that declares itself a keyboard widget is left alone.
 */
const SELF_MANAGED_ROLES: ReadonlySet<string> = new Set([
  // ARIA's composite widgets, which own the arrow keys and usually typeahead.
  'application',
  'combobox',
  'grid',
  'listbox',
  'menu',
  'menubar',
  'radiogroup',
  'tablist',
  'tree',
  'treegrid',
  // The descendants that actually hold focus inside those — which is what
  // `event.target` will be, since a composite moves focus onto its items.
  'gridcell',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'row',
  'tab',
  'treeitem',
  // Standalone controls whose key handling goes beyond Enter and Space.
  'searchbox',
  'slider',
  'spinbutton',
  'textbox',
]);

/**
 * True when a keystroke belongs to whatever the user is doing, not to us.
 *
 * Unmodified single letters are a hostile thing to claim globally in this
 * product in particular: people paste and hand-edit secret values here all
 * day, and a stray `S` that navigates away mid-edit is indistinguishable from
 * data loss. So the bar for stealing one is deliberately high.
 *
 * Split out from the DOM so it can be tested without a browser, and kept to
 * the focused element's *own* role rather than walking ancestors: an ordinary
 * button nested inside a widget — the delete button in a table row, say — is a
 * leaf that handles nothing, and suppressing shortcuts across a whole subtree
 * would over-reach as badly as the tag-only check under-reached.
 *
 * ── The invariant that makes reading only the explicit `role` safe ──
 * Nothing here computes an *implicit* role, and that is only sound because
 * every native element carrying a self-managed implicit role is already caught
 * by the tag check on the line above: `<input type="range">` is a `slider`,
 * `type="number"` a `spinbutton`, `type="search"` a `searchbox`, `<select>` a
 * `combobox`, `<select multiple>` a `listbox`, and `<textarea>` a `textbox` —
 * all of them INPUT, SELECT or TEXTAREA, all matched before `role` is ever
 * consulted. The set below therefore only ever has to catch elements that
 * *declare* a role, which in practice means a widget library.
 *
 * Adding a native element that owns plain keys without one of those three tags
 * breaks this silently — no test fails, the shortcut simply fires mid
 * interaction. `<audio controls>` and `<video controls>` are the likely next
 * arrivals, and a native `<dialog>` after them; each belongs in the tag check,
 * not in the set, because none of them writes a `role` attribute for the set
 * to match on.
 */
export function ownsPlainKeys(tagName: string, role: string | null): boolean {
  if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return true;
  if (role === null) return false;

  // `role` holds a token list, not one value: `role="combobox listbox"` is a
  // fallback chain for a user agent that does not recognise the first token.
  // Any token naming a widget is reason enough to stand down.
  return role.split(/\s+/).some((token) => SELF_MANAGED_ROLES.has(token.toLowerCase()));
}

function focusOwnsPlainKeys(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  return ownsPlainKeys(target.tagName, target.getAttribute('role'));
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

  // `useDashboardNav` hands over a memoised array, so this re-derives only when
  // the nav genuinely changes — a project arriving, a role resolving — and the
  // listener is re-subscribed with it. A caller that rebuilt the array every
  // render would re-subscribe every render, which is wasteful but not lossy:
  // React runs the cleanup and the setup inside one commit, so there is no gap
  // between them for a keystroke to fall into.
  const shortcuts = useMemo(() => collect(nav), [nav]);

  useEffect(() => {
    if (!enabled || shortcuts.size === 0) return;

    function onKeyDown(event: KeyboardEvent) {
      // `Ctrl`/`Cmd`/`Alt` belong to the browser and the OS. Only `Shift` is
      // ours to combine with, and only because it is part of the declared
      // chord rather than a modifier we invented.
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.defaultPrevented || event.repeat) return;
      if (focusOwnsPlainKeys(event.target) || isOverlayOpen()) return;

      const href = shortcuts.get(`${event.shiftKey ? 'shift:' : ''}${event.code}`);
      if (href === undefined) return;

      event.preventDefault();
      // A shortcut leaves through a door `UnsavedChangesGuard` cannot watch: no
      // anchor, no popstate, just a call. Unasked, one keypress unmounted a
      // table holding a screen full of staged credentials.
      if (askBeforeLeaving(href)) return;
      router.push(href);
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [enabled, shortcuts, router]);
}

/**
 * The one thing `UnsavedChangesGuard` cannot watch from the outside.
 *
 * Anchors are interceptable — the guard listens for clicks — and so is Back,
 * through `popstate`. `router.push` is neither: it is a function call, and a
 * caller that makes one leaves through a door no listener is behind. The
 * keyboard shortcuts in `useNavShortcuts` do exactly that, so a single keypress
 * unmounted a table holding a screen full of staged credentials with no dialog
 * at all.
 *
 * A module-level slot rather than React context, because the callers that need
 * to ask are siblings of the guard rather than descendants of it. One guard is
 * armed at a time — there is one save bar on screen — and it clears the slot
 * when it disarms or unmounts.
 *
 * Its own module, and not the component's: `use-nav-shortcuts.ts` is a `.ts`
 * file, and importing a `.tsx` one from it drags JSX into transforms that do not
 * expect it.
 */
let armedGuard: ((href: string) => void) | null = null;

/** Called by the guard while it has something to protect. */
export function armLeaveGuard(ask: (href: string) => void): () => void {
  armedGuard = ask;
  return () => {
    // Only if it is still ours. A guard unmounting after another has armed
    // would otherwise disarm the live one.
    if (armedGuard === ask) armedGuard = null;
  };
}

/**
 * Asks the armed guard, if any, to take this navigation.
 *
 * Returns whether it did. `false` means nothing is at stake and the caller
 * should navigate as it normally would.
 */
export function askBeforeLeaving(href: string): boolean {
  if (armedGuard === null) return false;
  armedGuard(href);
  return true;
}

/**
 * The parts of a click that decide whether it is ours to intercept.
 *
 * Taken as plain data rather than a `MouseEvent` so the rule can be tested
 * without a DOM — the shape `use-nav-shortcuts.ts` uses for the same reason.
 */
export interface ClickFlags {
  defaultPrevented: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Whether this click is a plain left click nobody nearer has claimed.
 *
 * A modified click opens a new tab or window and leaves this one — and the work
 * in it — exactly where it is, so there is nothing to protect and no question
 * worth asking.
 */
export function isPlainLeftClick(flags: ClickFlags): boolean {
  if (flags.defaultPrevented) return false;
  return flags.button === 0 && !flags.metaKey && !flags.ctrlKey && !flags.shiftKey && !flags.altKey;
}

/** The anchor's own properties, as the rule below needs them. */
export interface AnchorFacts {
  /** Already resolved against the document, as `HTMLAnchorElement.href` is. */
  href: string;
  hasDownload: boolean;
  target: string;
}

/**
 * The path this click would navigate to, or `null` to let it through.
 *
 * A download is a file, not a navigation; a `target` other than this frame
 * leaves the page standing; another origin unloads the document, which is
 * `beforeunload`'s business and not this one's — intercepting it would replace
 * the browser's guarantee with a dialog the user could not act on. A link to
 * the same path and query loses nothing, hash included: a jump within this
 * screen is not a departure from it.
 */
export function interceptedHref(anchor: AnchorFacts, currentHref: string): string | null {
  if (anchor.hasDownload) return null;
  if (anchor.target !== '' && anchor.target !== '_self') return null;

  const current = new URL(currentHref);
  let url: URL;
  try {
    url = new URL(anchor.href, currentHref);
  } catch {
    // An href the URL parser refuses is not one this guard can reason about.
    return null;
  }

  if (url.origin !== current.origin) return null;
  if (url.pathname === current.pathname && url.search === current.search) return null;

  return `${url.pathname}${url.search}${url.hash}`;
}

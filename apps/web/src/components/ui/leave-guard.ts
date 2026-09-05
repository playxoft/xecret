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

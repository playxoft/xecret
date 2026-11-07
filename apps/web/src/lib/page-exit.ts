/**
 * "This page is on its way out, on purpose."
 *
 * ── The race it closes ──
 * Signing out ends with `window.location.assign` to WorkOS's logout URL, and
 * that navigation is only *pending* until the document unloads. Anything that
 * assigns a second location in the meantime replaces it. Two things on the
 * dashboard do exactly that, because the session they belong to has just been
 * revoked: the API client's redirect to sign-in on a 401, and the shell's
 * re-read of `/api/auth/me` when the sign-out releases the vault keys — whose
 * cookie-less request is that 401. The sign-in redirect would win, the round
 * trip through WorkOS would never be sent, and AuthKit's own session would
 * survive to sign the next visitor straight back in without asking.
 *
 * So a deliberate departure says so first, and both of those stand down. A
 * `pagehide` listener would be too late: the race is decided before the old
 * document starts unloading.
 *
 * ── Never lowered, except by coming back ──
 * Every caller navigates unconditionally after raising it. The one way back to
 * a document that has raised it is the back-forward cache, which restores the
 * page with this module's state intact — so a restored page lowers it, or its
 * own 401s would be ignored forever.
 */

let leaving = false;

/** Called before a deliberate full navigation away — signing out — and before anything it releases. */
export function beginLeavingPage(): void {
  leaving = true;
}

/** Whether a deliberate navigation away has started. Nothing should start another. */
export function isLeavingPage(): boolean {
  return leaving;
}

/** Lowers the flag: a page restored from the back-forward cache. Test-facing as well. */
export function stayOnPage(): void {
  leaving = false;
}

if (typeof window !== 'undefined') {
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) stayOnPage();
  });
}

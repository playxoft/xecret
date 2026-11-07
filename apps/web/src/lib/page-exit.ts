/**
 * "This page is on its way out."
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
 * So a departure says so first, and both of those stand down. A `pagehide`
 * listener would be too late: the race is decided before the old document
 * starts unloading.
 *
 * ── Two departures, told apart by one question ──
 * Both stop every further redirect and every re-read of the session. They
 * differ over the browser's "Leave site?" prompt, which `UnsavedChangesGuard`
 * raises for staged edits:
 *
 * - **Leaving on purpose** — a sign-out — skips it. The session is revoked
 *   before the navigation starts, so nothing staged could be saved by staying,
 *   and a "Stay" would leave this document alive with the flag up: no 401 would
 *   ever redirect again, no lock would ever reach the lock screen.
 * - **A redirect to sign in** — a 401 — keeps it. The session ended without
 *   anybody choosing it, and staged values may be credentials pasted from
 *   somewhere they cannot be fetched again; the prompt is the one chance to copy
 *   them out. Staying leaves a document whose session is gone and whose keys
 *   were released before the redirect, so the flag being up there costs nothing
 *   but redirects the person has just declined.
 *
 * ── Why it is never lowered by a timer ──
 * A sign-out's document can still survive: the person can press Stop while
 * WorkOS's page loads. Lowering the flag after some delay would not tell that
 * apart from a navigation that is merely slow — a pending navigation has no
 * deadline and no event — and lowering it under a slow one reopens the race
 * above. Reloading the stopped page starts it fresh. The one way back to a
 * document that raised it is the back-forward cache, which restores the page
 * with this module's state intact, so a restored page lowers it.
 */

type Departure = 'none' | 'sign-in-redirect' | 'leaving-on-purpose';

let departure: Departure = 'none';

/** Called before a sign-out revokes or releases anything. */
export function beginLeavingPage(): void {
  departure = 'leaving-on-purpose';
}

/** Called by the API client before its redirect to sign in. A sign-out under way stays one. */
export function beginSignInRedirect(): void {
  if (departure === 'none') departure = 'sign-in-redirect';
}

/** Whether any departure has started. Nothing should start another navigation, or a re-read. */
export function isLeavingPage(): boolean {
  return departure !== 'none';
}

/** Whether the departure is a sign-out: staged edits can no longer be saved, so nobody is asked. */
export function isLeavingOnPurpose(): boolean {
  return departure === 'leaving-on-purpose';
}

/** Lowers the flag: a page restored from the back-forward cache. Test-facing as well. */
export function stayOnPage(): void {
  departure = 'none';
}

if (typeof window !== 'undefined') {
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) stayOnPage();
  });
}

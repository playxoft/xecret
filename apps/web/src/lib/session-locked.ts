/**
 * "The server has just refused this session as locked", as a signal anything
 * can listen for.
 *
 * ── Why the API client raises it ──
 * Every gated route answers a locked session with a 403 `session_locked`, and
 * `lib/api.ts` is the one place all of those answers pass through. The shell
 * learns that the vault is locked only from `GET /api/auth/me`, and it used to
 * re-read that only after a lock it had performed itself. A lock it did not
 * perform — the server's idle window closing before the browser's, a lock
 * request the server refused because the session was already locked — reached
 * each screen as a failure of its own: "Could not load this project", a toast,
 * a page of empty tables. Raised here, it reaches the one component that can
 * answer with the lock screen instead.
 *
 * ── Why a module and not a context ──
 * The API client has no React in it and must not grow any; it is the same
 * shape `components/vault/key-store.ts` uses for the same reason, a set of
 * listeners and an unsubscribe.
 *
 * ── Delivery ──
 * After the request has thrown, never in place of the throw: each listener is
 * queued as a microtask, so one that fails cannot replace the `ApiError` its
 * caller is about to receive, and every `catch` and `finally` on the way out of
 * that request still runs. A listener removed before its turn is skipped.
 *
 * Raised once per refused response, so a screen whose parallel requests are all
 * refused raises it several times in quick succession. Listeners treat it as
 * idempotent; the shell ignores it while a re-read is already under way.
 */

const listeners = new Set<() => void>();

/** Tells every listener that a request was refused with `session_locked`. */
export function announceSessionLocked(): void {
  for (const listener of listeners) {
    queueMicrotask(() => {
      if (listeners.has(listener)) listener();
    });
  }
}

/** Listens for {@link announceSessionLocked}. Returns the unsubscribe function. */
export function subscribeSessionLocked(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

import { isApiError } from '@/lib/api';
import type { SecretSummary } from '@/components/secrets/types';

/**
 * The environment screen's masked listing, as it sits in state.
 *
 * Kept apart from the screen so the one rule below — what a failed re-read does
 * to rows already on screen — can be asserted without rendering it.
 */
export interface SecretListState {
  /** The environment this page set belongs to. `null` before the first response. */
  path: string | null;
  items: readonly SecretSummary[] | null;
  cursor: string | null;
  error: unknown;
  /** From the last `loadMore`; see `SecretList.loadMoreError` in the screen. */
  loadMoreError: unknown;
}

/**
 * The listing after a read of `path` failed with `cause`.
 *
 * Normally the failure replaces the rows: the screen swaps the table for a retry
 * state, and nothing stale is left looking current.
 *
 * Except when the session has locked under rows that are already on screen. The
 * table re-reads after every save, the failed ones included, so a save pressed
 * after the server's idle window closed is refused, and the re-read after it is
 * refused too. Replacing the rows then unmounted the table — and every staged
 * edit in it — which disarmed the leave guard and let the shell's held-back
 * catch-up take the screen to the lock screen: exactly the loss the guard
 * exists to prevent. Those rows are kept, unchanged. The lock itself is the
 * shell's to deal with (`_lib/lock-catch-up.ts`), and a person who unlocks in
 * another tab can save from here, against the rows they were editing.
 */
export function listingAfterFailure(
  current: SecretListState,
  path: string,
  cause: unknown,
): SecretListState {
  const lockedUnderRows =
    isApiError(cause) &&
    cause.code === 'session_locked' &&
    current.path === path &&
    current.items !== null;
  if (lockedUnderRows) return current;

  return { path, items: null, cursor: null, error: cause, loadMoreError: null };
}

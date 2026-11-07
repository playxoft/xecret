import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api';
import type { SecretSummary } from '@/components/secrets/types';
import { listingAfterFailure } from './secret-listing';
import type { SecretListState } from './secret-listing';

/**
 * What a failed re-read of the listing does to the rows on screen.
 *
 * The table re-reads after every save, failed ones included. Pressing Save after
 * the server's idle window had closed was refused, the re-read was refused too,
 * and the failure replaced the rows — unmounting the table and every staged
 * edit in it, which is the loss the leave guard holds the lock screen back to
 * prevent.
 */

const PATH = '/api/orgs/acme/projects/api/environments/production/secrets';

const ROWS = [{ name: 'DATABASE_URL' }] as unknown as readonly SecretSummary[];

const ON_SCREEN: SecretListState = {
  path: PATH,
  items: ROWS,
  cursor: 'page-2',
  error: null,
  loadMoreError: null,
};

function refusal(code: string, status = 403): ApiError {
  return new ApiError({ code: code as never, message: 'A sentence.', status, requestId: 'r' });
}

describe('listingAfterFailure', () => {
  it('keeps the rows on screen — and the edits staged in them — when the session locked', () => {
    const next = listingAfterFailure(ON_SCREEN, PATH, refusal('session_locked'));

    // The same state, so React renders nothing new and the table stays mounted.
    expect(next).toBe(ON_SCREEN);
  });

  it('replaces the rows for any other failure, so nothing stale passes for current', () => {
    for (const cause of [refusal('forbidden'), refusal('internal_error', 500), new Error('x')]) {
      const next = listingAfterFailure(ON_SCREEN, PATH, cause);
      expect(next).toEqual({
        path: PATH,
        items: null,
        cursor: null,
        error: cause,
        loadMoreError: null,
      });
    }
  });

  it('reports a lock on a first read, where there are no rows to keep', () => {
    const cause = refusal('session_locked');
    const next = listingAfterFailure(
      { path: null, items: null, cursor: null, error: null, loadMoreError: null },
      PATH,
      cause,
    );

    // Drawn as the calm "your vault is locked" state, not a table of nothing.
    expect(next.items).toBeNull();
    expect(next.error).toBe(cause);
  });

  it('never keeps rows that belong to another environment', () => {
    const cause = refusal('session_locked');
    const next = listingAfterFailure(ON_SCREEN, `${PATH}-elsewhere`, cause);

    expect(next.items).toBeNull();
    expect(next.error).toBe(cause);
  });
});

import { describe, expect, it } from 'vitest';

import { sealedNoteKey, unopenedNotes, withOpenedNotes } from './use-opened-notes';
import type { OpenedNotes } from './use-opened-notes';
import type { SecretSummary } from './types';

/**
 * What the environment screen hands the table: the listing, with the notes it
 * has opened put where the table reads them. The decrypting is `SecretIo`'s and
 * is exercised against the real routes in `server/secret-notes-routes.test.ts`;
 * this is the bookkeeping around it — above all, that a re-read listing keeps
 * showing the notes it already opened rather than blanking them on every save.
 */

function row(name: string, encNote: string | null, note: string | null = null): SecretSummary {
  return {
    id: `id-${name}`,
    name,
    note,
    encNote,
    valueType: 'string',
    version: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    createdBy: 'user-1',
    createdByServiceTokenId: null,
  };
}

describe('the opened notes', () => {
  it('fills in each note it has opened, and leaves every other row as it came', () => {
    const listing = [row('A', 'xk2.gcm.aaa'), row('B', 'xk2.gcm.bbb'), row('C', null)];
    const opened: OpenedNotes = new Map([
      [sealedNoteKey(listing[0]!)!, 'first'],
      // One that would not open: remembered, and shown as absent.
      [sealedNoteKey(listing[1]!)!, null],
    ]);

    const shown = withOpenedNotes(listing, opened);
    expect(shown.map((secret) => secret.note)).toEqual(['first', null, null]);
    // Nothing left to open: neither the one that failed nor the row with none.
    expect(unopenedNotes(listing, opened)).toEqual([]);
  });

  it('keeps a note across a re-read listing, and opens it again once it is rewritten', () => {
    const before = [row('A', 'xk2.gcm.one')];
    const opened: OpenedNotes = new Map([[sealedNoteKey(before[0]!)!, 'one']]);

    // The listing a save re-reads: a new array, the same sealed note.
    const reread = [row('A', 'xk2.gcm.one')];
    expect(withOpenedNotes(reread, opened)[0]?.note).toBe('one');
    expect(unopenedNotes(reread, opened)).toEqual([]);

    // The note was edited: a new blob, so the old plaintext must not stand in.
    const rewritten = [row('A', 'xk2.gcm.two')];
    expect(withOpenedNotes(rewritten, opened)[0]?.note).toBeNull();
    expect(unopenedNotes(rewritten, opened).map((secret) => secret.name)).toEqual(['A']);
  });

  it('hands back the listing itself when there is nothing to fill in', () => {
    // A server-mode listing, whose notes are already plaintext.
    const listing = [row('A', null, 'plain')];
    expect(withOpenedNotes(listing, new Map())).toBe(listing);
    expect(withOpenedNotes(listing, new Map([['other\u0000xk2.gcm.x', 'x']]))).toBe(listing);
    expect(unopenedNotes(listing, new Map())).toEqual([]);
  });
});

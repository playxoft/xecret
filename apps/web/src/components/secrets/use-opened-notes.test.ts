import { describe, expect, it } from 'vitest';

import { NOTE_STATE_COPY, noteEditable } from './note-state';
import { pruneNotes, sealedNoteKey, unopenedNotes, withOpenedNotes } from './use-opened-notes';
import type { OpenedNotes, WrittenNote, WrittenNotes } from './use-opened-notes';
import type { SecretSummary } from './types';

/**
 * What the environment screen hands the table: the listing, with the notes it
 * has opened put where the table reads them. The decrypting is `SecretIo`'s and
 * is exercised against the real routes in `server/secret-notes-routes.test.ts`;
 * this is the bookkeeping around it — that no sealed note is shown as an empty
 * one, that a re-read listing keeps showing what it already opened, that a note
 * just written shows at once, and that nothing superseded is kept.
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

function writtenOf(...notes: WrittenNote[]): WrittenNotes {
  return new Map(notes.map((note) => [note.id, note]));
}

describe('the opened notes', () => {
  it('fills in each note it has opened, and says why it shows every other sealed one', () => {
    const listing = [
      row('A', 'xk2.gcm.aaa'),
      row('B', 'xk2.gcm.bbb'),
      row('C', 'xk2.gcm.ccc'),
      row('D', null),
    ];
    const opened: OpenedNotes = new Map([
      [sealedNoteKey(listing[0]!)!, 'first'],
      // One that would not open: remembered as such.
      [sealedNoteKey(listing[1]!)!, null],
    ]);

    const shown = withOpenedNotes(listing, opened);
    expect(shown.map((secret) => [secret.note, secret.noteState])).toEqual([
      ['first', undefined],
      [null, 'unreadable'],
      // Not opened yet: never presented as a note that is not there.
      [null, 'sealed'],
      [null, undefined],
    ]);
    // Only the one still waiting is asked for.
    expect(unopenedNotes(listing, opened).map((secret) => secret.name)).toEqual(['C']);
  });

  it('keeps a note across a re-read listing, and opens it again once it is rewritten', () => {
    const before = [row('A', 'xk2.gcm.one')];
    const opened: OpenedNotes = new Map([[sealedNoteKey(before[0]!)!, 'one']]);

    // The listing a save re-reads: a new array, the same sealed note.
    const reread = [row('A', 'xk2.gcm.one')];
    expect(withOpenedNotes(reread, opened)[0]?.note).toBe('one');
    expect(unopenedNotes(reread, opened)).toEqual([]);

    // The note was edited elsewhere: a new blob, so the old plaintext must not stand in.
    const rewritten = [row('A', 'xk2.gcm.two')];
    expect(withOpenedNotes(rewritten, opened)[0]).toMatchObject({
      note: null,
      noteState: 'sealed',
    });
    expect(unopenedNotes(rewritten, opened).map((secret) => secret.name)).toEqual(['A']);
  });

  it('hands back the listing itself when no row carries a sealed note', () => {
    // A server-mode listing, whose notes are already plaintext.
    const listing = [row('A', null, 'plain')];
    expect(withOpenedNotes(listing, new Map())).toBe(listing);
    expect(withOpenedNotes(listing, new Map([['other\u0000xk2.gcm.x', 'x']]))).toBe(listing);
    expect(unopenedNotes(listing, new Map())).toEqual([]);
  });
});

describe('a note the row cannot show', () => {
  it('may not be written over while it is still being opened', () => {
    // An editor seeded from "nothing" over a note nobody has seen yet writes
    // straight over it.
    expect(noteEditable('sealed')).toBe(false);
    // One that will not open may be replaced — the row says so first.
    expect(noteEditable('unreadable')).toBe(true);
    expect(NOTE_STATE_COPY.unreadable).toMatch(/replaces it/);
    expect(noteEditable(undefined)).toBe(true);
  });
});

describe('a note this screen has just written', () => {
  const mine: WrittenNote = {
    id: 'id-A',
    replaced: 'xk2.gcm.old',
    sealed: 'xk2.gcm.new',
    note: 'the new one',
  };

  it('shows at once, while the listing still carries the note it replaced', () => {
    // The save has landed and dropped the staged note; the re-read has not.
    // Showing the listing here was the flicker back to the old note.
    const stale = [row('A', 'xk2.gcm.old')];
    const opened: OpenedNotes = new Map([[sealedNoteKey(stale[0]!)!, 'the old one']]);

    expect(withOpenedNotes(stale, opened, writtenOf(mine))[0]).toMatchObject({
      note: 'the new one',
    });
  });

  it('shows at once in the listing that carries it, with nothing to decrypt', () => {
    // The flicker to "no note" while the new seal was opened.
    const fresh = [row('A', 'xk2.gcm.new')];
    const shown = withOpenedNotes(fresh, new Map(), writtenOf(mine))[0];
    expect(shown).toMatchObject({ note: 'the new one' });
    expect(shown?.noteState).toBeUndefined();
    expect(unopenedNotes(fresh, new Map(), writtenOf(mine))).toEqual([]);
  });

  it('gives way to the listing once somebody else has written since', () => {
    const theirs = [row('A', 'xk2.gcm.theirs')];
    expect(withOpenedNotes(theirs, new Map(), writtenOf(mine))[0]).toMatchObject({
      note: null,
      noteState: 'sealed',
    });
  });
});

describe('what is kept between listings', () => {
  it('drops the plaintext of every note the listing no longer carries', () => {
    const listing = [row('A', 'xk2.gcm.current')];
    const state = {
      opened: new Map<string, string | null>([
        ['id-A\u0000xk2.gcm.current', 'current'],
        // Superseded by an edit.
        ['id-A\u0000xk2.gcm.older', 'older'],
        // A row that is gone.
        ['id-B\u0000xk2.gcm.b', 'deleted'],
      ]),
      written: writtenOf(),
    };

    expect([...pruneNotes(state, listing).opened.keys()]).toEqual(['id-A\u0000xk2.gcm.current']);
  });

  it('hands a written note to the opened ones once the listing carries it, and keeps it until then', () => {
    const mine: WrittenNote = {
      id: 'id-A',
      replaced: 'xk2.gcm.old',
      sealed: 'xk2.gcm.new',
      note: 'n',
    };
    const state = { opened: new Map<string, string | null>(), written: writtenOf(mine) };

    // Not caught up: kept, and nothing has changed.
    expect(pruneNotes(state, [row('A', 'xk2.gcm.old')])).toBe(state);

    // Caught up: the plaintext is now simply an opened note.
    const caught = pruneNotes(state, [row('A', 'xk2.gcm.new')]);
    expect(caught.written.size).toBe(0);
    expect(caught.opened.get('id-A\u0000xk2.gcm.new')).toBe('n');

    // Overtaken by somebody else's write: dropped, and nothing claimed for it.
    const overtaken = pruneNotes(state, [row('A', 'xk2.gcm.theirs')]);
    expect(overtaken.written.size).toBe(0);
    expect(overtaken.opened.size).toBe(0);
  });
});

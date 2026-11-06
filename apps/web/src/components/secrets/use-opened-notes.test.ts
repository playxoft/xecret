import { describe, expect, it } from 'vitest';

import { NOTE_STATE_COPY, noteEditable, stagedNote } from './note-state';
import {
  advanceNotes,
  pruneNotes,
  sealedNoteKey,
  unopenedNotes,
  withOpenedNotes,
} from './use-opened-notes';
import type {
  NotesState,
  OpenedNote,
  OpenedNotes,
  WrittenNote,
  WrittenNotes,
} from './use-opened-notes';
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

/** A note that opened, under the active key unless said otherwise. */
function openedAs(note: string, underRetiredKey = false): OpenedNote {
  return { note, underRetiredKey };
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
      [sealedNoteKey(listing[0]!)!, openedAs('first')],
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

  it('marks a note that opened only under a retired key, and no other', () => {
    // A note carries no key id, so one sealed under a retired key after the
    // rotation opens exactly like one written before it. The row says which.
    const listing = [row('OLD', 'xk2.gcm.old'), row('NEW', 'xk2.gcm.new')];
    const opened: OpenedNotes = new Map([
      [sealedNoteKey(listing[0]!)!, openedAs('from before', true)],
      [sealedNoteKey(listing[1]!)!, openedAs('from after')],
    ]);

    const [old, current] = withOpenedNotes(listing, opened);
    expect(old).toMatchObject({ note: 'from before', noteUnderRetiredKey: true });
    expect(current).toMatchObject({ note: 'from after' });
    expect(current?.noteUnderRetiredKey).toBeUndefined();
  });

  it('keeps a note across a re-read listing, and opens it again once it is rewritten', () => {
    const before = [row('A', 'xk2.gcm.one')];
    const opened: OpenedNotes = new Map([[sealedNoteKey(before[0]!)!, openedAs('one')]]);

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
    expect(withOpenedNotes(listing, new Map([['other\u0000xk2.gcm.x', openedAs('x')]]))).toBe(
      listing,
    );
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

  it('is cleared by an empty box, rather than the empty box un-staging itself', () => {
    // The box over an unreadable note shows nothing, and the note it stands
    // for is not nothing. Comparing the empty box with "" un-staged the clear,
    // so Replace, empty, Save did nothing and said nothing.
    const unreadable = { note: null, noteState: 'unreadable' as const };
    expect(stagedNote(unreadable, null)).toBe('');
    expect(stagedNote(unreadable, '')).toBe('');
    expect(stagedNote(unreadable, 'a new one')).toBe('a new one');
  });

  it('un-stages, everywhere else, once the box is back to what is stored', () => {
    expect(stagedNote({ note: 'kept' }, 'kept')).toBeNull();
    expect(stagedNote({ note: 'kept' }, null)).toBe('');
    expect(stagedNote({ note: null }, null)).toBeNull();
    expect(stagedNote({ note: null }, 'new')).toBe('new');
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
    const opened: OpenedNotes = new Map([
      [sealedNoteKey(stale[0]!)!, openedAs('the old one', true)],
    ]);

    const shown = withOpenedNotes(stale, opened, writtenOf(mine))[0];
    expect(shown).toMatchObject({ note: 'the new one' });
    // Sealed here, under the active key: the old one's provenance is not its.
    expect(shown?.noteUnderRetiredKey).toBeUndefined();
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
      opened: new Map<string, OpenedNote | null>([
        ['id-A\u0000xk2.gcm.current', openedAs('current')],
        // Superseded by an edit.
        ['id-A\u0000xk2.gcm.older', openedAs('older')],
        // A row that is gone.
        ['id-B\u0000xk2.gcm.b', openedAs('deleted')],
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
    const state = { opened: new Map<string, OpenedNote | null>(), written: writtenOf(mine) };

    // Not caught up: kept, and nothing has changed.
    expect(pruneNotes(state, [row('A', 'xk2.gcm.old')])).toBe(state);

    // Caught up: the plaintext is now simply an opened note, sealed under the active key.
    const caught = pruneNotes(state, [row('A', 'xk2.gcm.new')]);
    expect(caught.written.size).toBe(0);
    expect(caught.opened.get('id-A\u0000xk2.gcm.new')).toEqual(openedAs('n'));

    // Overtaken by somebody else's write: dropped, and nothing claimed for it.
    const overtaken = pruneNotes(state, [row('A', 'xk2.gcm.theirs')]);
    expect(overtaken.written.size).toBe(0);
    expect(overtaken.opened.size).toBe(0);
  });
});

describe('advanceNotes settles', () => {
  // The render-phase adjustment calls this until its inputs stop differing
  // from the state. If the result does not carry exactly the io and listing
  // it was given, the hook setStates on every render and React stops the page
  // with error #301 — the 2026-11-06 outage: every environment screen crashed
  // because the old state was spread over the new io while the listing was
  // still loading.
  const io = { tag: 'io-a' } as never;
  const empty: NotesState = { io: null, listing: null, opened: new Map(), written: new Map() };

  function settled(state: NotesState, nextIo: never | null, listing: SecretSummary[] | null) {
    const once = advanceNotes(state, nextIo, listing);
    expect(once.io).toBe(nextIo);
    expect(once.listing).toBe(listing);
    // A second pass with the same inputs changes nothing the hook compares.
    const again = advanceNotes(once, nextIo, listing);
    expect(again.io).toBe(nextIo);
    expect(again.listing).toBe(listing);
    return once;
  }

  it('when the io arrives before the listing — the outage shape', () => {
    settled(empty, io, null);
  });

  it('when the listing arrives, with and before an io', () => {
    const listing = [row('A', null)];
    settled(empty, null, listing);
    const withIo = settled(empty, io, null);
    settled(withIo, io, listing);
  });

  it('when the listing goes back to null on a reload', () => {
    const listing = [row('A', null)];
    const loaded = settled(empty, io, listing);
    settled(loaded, io, null);
  });

  it('a rotation drops what the old io opened', () => {
    const listing = [row('A', 'xk2.gcm.blob')];
    const loaded = advanceNotes(empty, io, listing);
    const opened: OpenedNotes = new Map([['x', null]]);
    const turned = settled({ ...loaded, opened }, { tag: 'io-b' } as never, listing);
    expect(turned.opened.size).toBe(0);
  });
});

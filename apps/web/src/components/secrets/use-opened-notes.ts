'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { SecretIo } from '@/components/envkeys';
import type { SecretSummary } from './types';

/**
 * The notes of an end-to-end encrypted environment, readable.
 *
 * The listing carries an `e2ee` secret's note only as `encNote`, and the table
 * reads `note` — so without this step a note was encrypted, saved and listed
 * and then shown as absent, which is indistinguishable from a note that never
 * saved. `SecretIo.openNotes` does the decrypting; this decides when, keeps
 * what it opened, and says which notes it could not show and why
 * (`noteState`), so that no sealed note is ever presented as an empty one.
 *
 * ── Why the opened notes are kept between listings ──
 * The listing is re-read after every save, and a fresh listing is a fresh array.
 * Decrypting it from nothing each time would blank every note on screen for the
 * moment the decryptions take — on the very save that wrote one. So what was
 * opened is kept, keyed by the row *and the exact ciphertext*: a note that has
 * been rewritten is a different blob and is opened again, and one that has not
 * is shown straight away. A note that would not open is remembered as such, so
 * it is not retried on every render. Whatever the current listing no longer
 * holds is dropped, so a superseded note's plaintext does not outlive it.
 *
 * ── And why the notes this screen writes are kept too ──
 * A save drops the row's staged note as it lands, and the listing that carries
 * the new one arrives a request later — so the row went from the new note, to
 * the one it replaced, to nothing while the new seal was opened, to the new
 * note again. `remember` takes what the save wrote, with the exact blob it
 * stored, and the row shows it throughout.
 */

/** A sealed note that opened: its plaintext, and whether only a retired key opened it. */
export interface OpenedNote {
  note: string;
  underRetiredKey: boolean;
}

/** What each sealed note opened to, or `null` for one that did not open. */
export type OpenedNotes = ReadonlyMap<string, OpenedNote | null>;

/**
 * A note this screen has just written, until the listing shows it.
 *
 * `replaced` is the sealed note the row carried before the write and `sealed`
 * the one the write stored — `null` for none. While the row still carries
 * either, it is this note; once it carries anything else, somebody has written
 * since, and the listing is the one to believe.
 */
export interface WrittenNote {
  id: string;
  replaced: string | null;
  sealed: string | null;
  note: string | null;
}

export type WrittenNotes = ReadonlyMap<string, WrittenNote>;

const NOTHING_OPENED: OpenedNotes = new Map();
const NOTHING_WRITTEN: WrittenNotes = new Map();

/** One sealed note's identity — the row and its exact ciphertext — or `null` for a row with none. */
export function sealedNoteKey(secret: Pick<SecretSummary, 'id' | 'encNote'>): string | null {
  const blob = secret.encNote ?? null;
  return blob === null ? null : noteKey(secret.id, blob);
}

function noteKey(id: string, blob: string): string {
  return `${id}\u0000${blob}`;
}

/** The note this screen wrote for a row, while the row is still the one it wrote it to. */
function writtenFor(secret: SecretSummary, written: WrittenNotes): WrittenNote | undefined {
  const mine = written.get(secret.id);
  if (mine === undefined) return undefined;
  const blob = secret.encNote ?? null;
  return blob === mine.replaced || blob === mine.sealed ? mine : undefined;
}

/** The rows whose sealed note has not been opened yet, and was not just written here. */
export function unopenedNotes(
  secrets: readonly SecretSummary[],
  opened: OpenedNotes,
  written: WrittenNotes = NOTHING_WRITTEN,
): SecretSummary[] {
  return secrets.filter((secret) => {
    const key = sealedNoteKey(secret);
    return key !== null && !opened.has(key) && writtenFor(secret, written) === undefined;
  });
}

/**
 * The listing as a table should render it: every opened note in `note`, every
 * one that is not with a `noteState` saying why, and every note this screen
 * has just written shown as written. The same array when no row carries a
 * sealed note, so a `server`-mode listing keeps its identity.
 */
export function withOpenedNotes(
  secrets: readonly SecretSummary[],
  opened: OpenedNotes,
  written: WrittenNotes = NOTHING_WRITTEN,
): readonly SecretSummary[] {
  let changed = false;
  const next = secrets.map((secret): SecretSummary => {
    const mine = writtenFor(secret, written);
    if (mine !== undefined) {
      changed = true;
      // Sealed here, under the active key: nothing to say about where it came from.
      return { ...secret, note: mine.note, noteState: undefined, noteUnderRetiredKey: undefined };
    }

    const key = sealedNoteKey(secret);
    if (key === null) return secret;

    changed = true;
    const opening = opened.get(key);
    if (opening === undefined) return { ...secret, note: null, noteState: 'sealed' };
    if (opening === null) return { ...secret, note: null, noteState: 'unreadable' };
    return {
      ...secret,
      note: opening.note,
      noteState: undefined,
      noteUnderRetiredKey: opening.underRetiredKey ? true : undefined,
    };
  });
  return changed ? next : secrets;
}

/**
 * What is still worth keeping, against the listing now on screen.
 *
 * An opened note stays only while its row still carries that exact blob. A
 * written note stays while its row still carries the blob it replaced — the
 * listing has not caught up — and, once the row carries the blob it stored,
 * hands its plaintext to the opened notes and goes. Anything else is a row
 * somebody has written since, or one that is gone.
 */
export function pruneNotes(
  state: { opened: OpenedNotes; written: WrittenNotes },
  secrets: readonly SecretSummary[],
): { opened: OpenedNotes; written: WrittenNotes } {
  const live = new Map(secrets.map((secret) => [secret.id, secret.encNote ?? null]));
  let changed = false;

  const opened = new Map<string, OpenedNote | null>();
  for (const [key, note] of state.opened) {
    const separator = key.indexOf('\u0000');
    if (live.get(key.slice(0, separator)) === key.slice(separator + 1)) opened.set(key, note);
    else changed = true;
  }

  const written = new Map<string, WrittenNote>();
  for (const mine of state.written.values()) {
    const blob = live.has(mine.id) ? (live.get(mine.id) ?? null) : undefined;
    if (blob === mine.replaced) {
      written.set(mine.id, mine);
      continue;
    }
    changed = true;
    if (blob === mine.sealed && blob !== null && mine.note !== null) {
      opened.set(noteKey(mine.id, blob), { note: mine.note, underRetiredKey: false });
    }
  }

  return changed ? { opened, written } : state;
}

export interface NotesState {
  /**
   * The IO these were opened with. A rotation re-opens the environment and
   * produces a new one — and a note opened under the retired key is not this
   * one's to show, nor a note it failed to open one this one must fail on.
   * (A lock does not come through here: it takes the whole screen down behind
   * the lock screen, and this state with it.)
   */
  io: SecretIo | null;
  /** The listing these were last pruned against. */
  listing: readonly SecretSummary[] | null;
  opened: OpenedNotes;
  written: WrittenNotes;
}

/**
 * The state as it should read for this `io` and `secrets` — the pure step
 * behind the hook's render-phase adjustment. A new IO (a rotation) drops
 * everything held; a new listing keeps what it still carries. The fields are
 * written out one by one, never by spreading the old state last: the old
 * state carries `io` and `listing` too, and a spread that wins over the new
 * values re-creates the loop this function exists to prevent.
 */
export function advanceNotes(
  state: NotesState,
  io: SecretIo | null,
  secrets: readonly SecretSummary[] | null,
): NotesState {
  const base =
    state.io === io ? state : { ...state, opened: NOTHING_OPENED, written: NOTHING_WRITTEN };
  const kept =
    secrets === null ? { opened: base.opened, written: base.written } : pruneNotes(base, secrets);
  return { io, listing: secrets, opened: kept.opened, written: kept.written };
}

export interface OpenedListing {
  /** `secrets` with its notes opened — what the table renders. */
  secrets: readonly SecretSummary[] | null;
  /** Shows the notes a save has just written, until the listing carries them. */
  remember: (notes: readonly WrittenNote[]) => void;
}

/**
 * The listing as the table should render it: `secrets` with its sealed notes
 * opened by `io`. A row whose note is still being opened arrives marked
 * `sealed`, and fills in when the decryption lands.
 */
export function useOpenedNotes(
  secrets: readonly SecretSummary[] | null,
  io: SecretIo | null,
): OpenedListing {
  const [state, setState] = useState<NotesState>({
    io,
    listing: secrets,
    opened: NOTHING_OPENED,
    written: NOTHING_WRITTEN,
  });

  // Brought up to date with the IO and the listing during render rather than in
  // an effect, which is React's documented way to follow a changed prop — and
  // the only one here that never paints a frame of a note the listing has
  // already moved past.
  //
  // `advanceNotes` must be a fixed point: feeding its result back with the
  // same io and listing returns the SAME object, or this setState-in-render
  // never settles and React stops the page with error #301 — which is exactly
  // how the first version of this block took every environment screen down
  // (2026-11-06): it spread the old state *over* the new `io` and `listing`
  // while the listing was still null, so the condition never cleared.
  // `advanceNotes` is pure and its idempotence is pinned by a test.
  let current = state;
  if (state.io !== io || state.listing !== secrets) {
    current = advanceNotes(state, io, secrets);
    setState(current);
  }
  const { opened, written } = current;

  useEffect(() => {
    if (secrets === null || io === null) return;
    const pending = unopenedNotes(secrets, opened, written);
    if (pending.length === 0) return;

    let live = true;
    io.openNotes(pending).then(
      (results) => {
        if (!live) return;
        setState((previous) => {
          if (previous.io !== io) return previous;
          const next = new Map(previous.opened);
          for (const secret of results) {
            const key = sealedNoteKey(secret);
            if (key === null) continue;
            next.set(
              key,
              secret.noteState === 'unreadable' || secret.note === null
                ? null
                : { note: secret.note, underRetiredKey: secret.noteUnderRetiredKey === true },
            );
          }
          // Pruned against the listing now on screen, so a note superseded
          // while this was decrypting is not kept for it.
          const notes = { opened: next, written: previous.written };
          return {
            ...previous,
            ...(previous.listing === null ? notes : pruneNotes(notes, previous.listing)),
          };
        });
      },
      () => {
        // The key was released while this ran — a lock landing mid-decrypt,
        // which is about to take this screen down anyway. The rows stay
        // `sealed`, which is what they are.
      },
    );

    return () => {
      live = false;
    };
  }, [secrets, io, opened, written]);

  const remember = useCallback((notes: readonly WrittenNote[]) => {
    const kept = notes.filter((note) => note.replaced !== note.sealed);
    if (kept.length === 0) return;
    setState((previous) => {
      const next = new Map(previous.written);
      for (const note of kept) next.set(note.id, note);
      return { ...previous, written: next };
    });
  }, []);

  const listing = useMemo(
    () => (secrets === null ? null : withOpenedNotes(secrets, opened, written)),
    [secrets, opened, written],
  );

  return useMemo(() => ({ secrets: listing, remember }), [listing, remember]);
}

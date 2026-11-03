import type { NoteState, SecretSummary } from './types';

/**
 * What a row says in place of a note it cannot show — see `NoteState`.
 *
 * One sentence per state, shared by the note mark beside the key and the
 * details panel beside the value, so the two never describe the same note two
 * ways. Neither names anything from the ciphertext: there is nothing in it a
 * person could act on, and it is not theirs to read.
 */
export const NOTE_STATE_COPY: Readonly<Record<NoteState, string>> = {
  sealed: 'This note is still encrypted. It opens with this environment’s key.',
  unreadable:
    'This note was sealed under a key this browser does not hold — usually one rotated away since it was written — so it cannot be read here. A new note replaces it.',
};

/** The short form, for an accessible name and a placeholder. */
export const NOTE_STATE_LABEL: Readonly<Record<NoteState, string>> = {
  sealed: 'still encrypted',
  unreadable: 'cannot be read here',
};

/** Whether the note may be edited from this state. A note nobody has seen may not be written over. */
export function noteEditable(state: NoteState | undefined): boolean {
  return state !== 'sealed';
}

/**
 * What a row stages when its note box is changed to `next` — the text to
 * write, `''` for a clear — or `null` to stage nothing, because the box is back
 * to what is stored.
 *
 * "Back to what is stored" is a comparison with the stored note, and an
 * unreadable one is not the empty string, whatever its box shows: it is a note
 * that exists. Comparing with `''` there un-staged a deliberate clear, so
 * replacing an unreadable note with nothing and saving did nothing, and said
 * nothing either.
 */
export function stagedNote(
  stored: Pick<SecretSummary, 'note' | 'noteState'>,
  next: string | null,
): string | null {
  const value = next ?? '';
  if (stored.noteState === 'unreadable') return value;
  return value === (stored.note ?? '') ? null : value;
}

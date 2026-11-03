'use client';

import { useEffect, useMemo, useState } from 'react';

import type { SecretIo } from '@/components/envkeys';
import type { SecretSummary } from './types';

/**
 * The notes of an end-to-end encrypted environment, readable.
 *
 * The listing carries an `e2ee` secret's note only as `encNote`, and the table
 * reads `note` — so without this step a note was encrypted, saved and listed
 * and then shown as absent, which is indistinguishable from a note that never
 * saved. `SecretIo.openNotes` does the decrypting; this decides when, and keeps
 * what it opened.
 *
 * ── Why the opened notes are kept between listings ──
 * The listing is re-read after every save, and a fresh listing is a fresh array.
 * Decrypting it from nothing each time would blank every note on screen for the
 * moment the decryptions take — on the very save that wrote one. So what was
 * opened is kept, keyed by the row *and the exact ciphertext*: a note that has
 * been rewritten is a different blob and is opened again, and one that has not
 * is shown straight away. A note that would not open is remembered as such, so
 * it is not retried on every render.
 */

/** What each sealed note opened to: its plaintext, or `null` for one that did not open. */
export type OpenedNotes = ReadonlyMap<string, string | null>;

const NOTHING_OPENED: OpenedNotes = new Map();

/** One sealed note's identity — the row and its exact ciphertext — or `null` for a row with none. */
export function sealedNoteKey(secret: Pick<SecretSummary, 'id' | 'encNote'>): string | null {
  const blob = secret.encNote ?? null;
  return blob === null ? null : `${secret.id}\u0000${blob}`;
}

/** The rows whose sealed note has not been opened yet. */
export function unopenedNotes(
  secrets: readonly SecretSummary[],
  opened: OpenedNotes,
): SecretSummary[] {
  return secrets.filter((secret) => {
    const key = sealedNoteKey(secret);
    return key !== null && !opened.has(key);
  });
}

/**
 * The listing with every opened note in `note`. The same array when there is
 * nothing to put there, so a server-mode listing keeps its identity.
 */
export function withOpenedNotes(
  secrets: readonly SecretSummary[],
  opened: OpenedNotes,
): readonly SecretSummary[] {
  if (opened.size === 0) return secrets;

  let changed = false;
  const next = secrets.map((secret) => {
    const key = sealedNoteKey(secret);
    const note = key === null ? undefined : opened.get(key);
    if (note === undefined || note === null) return secret;
    changed = true;
    return { ...secret, note };
  });
  return changed ? next : secrets;
}

/**
 * The listing as the table should render it: `secrets` with its sealed notes
 * opened by `io`. Rows whose note is still being opened are passed through as
 * they came, and fill in when the decryption lands.
 */
export function useOpenedNotes(
  secrets: readonly SecretSummary[] | null,
  io: SecretIo | null,
): readonly SecretSummary[] | null {
  // Tagged with the IO that opened them: a rotation or a lock produces a new
  // one, and a note opened under the previous key is not this one's to show.
  const [cache, setCache] = useState<{ io: SecretIo | null; notes: OpenedNotes }>({
    io: null,
    notes: NOTHING_OPENED,
  });
  const notes = cache.io === io ? cache.notes : NOTHING_OPENED;

  useEffect(() => {
    if (secrets === null || io === null) return;
    const pending = unopenedNotes(secrets, notes);
    if (pending.length === 0) return;

    let current = true;
    io.openNotes(pending).then(
      (opened) => {
        if (!current) return;
        setCache((previous) => {
          const next = new Map(previous.io === io ? previous.notes : NOTHING_OPENED);
          for (const secret of opened) {
            const key = sealedNoteKey(secret);
            if (key !== null) next.set(key, secret.note);
          }
          return { io, notes: next };
        });
      },
      () => {
        // The key was released mid-way — a lock. The rows stay as they came,
        // and the IO the unlock produces opens them again.
      },
    );

    return () => {
      current = false;
    };
  }, [secrets, io, notes]);

  return useMemo(
    () => (secrets === null ? null : withOpenedNotes(secrets, notes)),
    [secrets, notes],
  );
}

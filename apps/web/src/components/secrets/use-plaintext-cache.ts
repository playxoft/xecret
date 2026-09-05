'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';

/**
 * One decryption per secret, kept for as long as the page is open.
 *
 * ── Why this exists ──
 * Every way of looking at a value used to be its own round trip. Revealing a
 * secret, masking it, revealing it again: two decryptions. Revealing it and then
 * clicking it to edit: two more. Filtering the table so the row unmounts, then
 * clearing the filter: everything the row knew went with it. The user waits on a
 * spinner each time for a value the page already had, and the audit log fills up
 * with `secret.revealed` records that all describe one act of looking.
 *
 * So the plaintexts live here, above the rows, and a value this page has already
 * decrypted is never decrypted again.
 *
 * ── What invalidates an entry ──
 * Everything that could make it wrong, and nothing else:
 *
 *  - **A new version of that secret.** Entries carry the version they were read
 *    at and a read at any other version misses, so a row that has just been
 *    saved decrypts afresh and cannot hand the superseded credential to Copy or
 *    seed it into the next edit.
 *  - **A write anywhere in the environment** — a save, a delete, a restore, an
 *    import. All of them call `forget`; see `forgetDecrypted` in the table.
 *  - **The environment.** Entries are filed under it, so dev's plaintexts are
 *    unreachable from a row rendered under production's heading even in the
 *    frame before the effect below empties them.
 *  - **A reload.** Nothing is persisted. This is a `Map` in a ref and it dies
 *    with the page.
 *
 * ── What does *not* invalidate an entry ──
 * Time, and hiding the tab. Both still take the value off the *screen* — see the
 * masking windows in `ValueField` and `useRevealAll` — but masking and
 * forgetting are different acts, and only the first of them is about what
 * somebody walking past an unattended screen can read. Making the window drop
 * the plaintext as well bought nothing: the value was one click away from being
 * fetched again, and that click cost a round trip and a second audit record for
 * a value the user had already legitimately read.
 *
 * ── Why a ref and not state ──
 * Nothing renders from this. It is read inside the reveal callback, on the way
 * to deciding whether to issue a request at all, so writing to it must not
 * re-render sixty rows.
 */
export interface PlaintextCache {
  /** The plaintext held for this exact version, or `undefined` — a miss. */
  read: (name: string, version: number) => string | undefined;
  write: (name: string, version: number, value: string) => void;
  /** Drops everything. Called by every write to the environment. */
  forget: () => void;
}

interface Entry {
  version: number;
  value: string;
}

/**
 * Where an entry is filed: the environment, then the name.
 *
 * Exported and pure so the rule can be tested without a DOM — the same shape
 * `use-nav-shortcuts.ts` uses. The separator is NUL because it cannot occur in
 * either half: environment keys are slugs and secret names are
 * `[A-Za-z0-9_]`, so no pair of (environment, name) can spell another pair.
 */
export function entryKeyFor(key: string, name: string): string {
  return `${key}\u0000${name}`;
}

/**
 * What an entry is worth at `version`.
 *
 * A miss rather than a stale hit when the versions disagree: the value has
 * moved on and this copy describes the one before it. Returning it would put a
 * superseded credential on the clipboard and seed the next edit from it — see
 * the header above.
 */
export function readEntry(entry: Entry | undefined, version: number): string | undefined {
  return entry !== undefined && entry.version === version ? entry.value : undefined;
}

export function usePlaintextCache(key: string): PlaintextCache {
  const entries = useRef<Map<string, Entry>>(new Map());

  // Entries are filed under the environment as well as the name. That is what
  // makes the clearing below a matter of memory rather than of correctness: an
  // effect runs after paint, and for that one frame a row under the new
  // environment's heading would otherwise be able to read a plaintext belonging
  // to the previous one — same key name, different secret entirely.
  const entryKey = useCallback((name: string) => entryKeyFor(key, name), [key]);

  useEffect(() => {
    const held = entries.current;
    return () => held.clear();
  }, [key]);

  const read = useCallback(
    (name: string, version: number): string | undefined => {
      const entry = entries.current.get(entryKey(name));
      // A miss rather than a stale hit: the value has moved on, and this copy
      // describes the version before it.
      return readEntry(entry, version);
    },
    [entryKey],
  );

  const write = useCallback(
    (name: string, version: number, value: string): void => {
      entries.current.set(entryKey(name), { version, value });
    },
    [entryKey],
  );

  const forget = useCallback((): void => {
    entries.current.clear();
  }, []);

  // A stable object, so a row's reveal callback is not rebuilt on every render
  // of the table.
  return useMemo(() => ({ read, write, forget }), [read, write, forget]);
}

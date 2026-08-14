'use client';

import { useCallback, useMemo, useRef, useState } from 'react';

import { checkSecretName } from '@xecret/core/validation';
import { api, isApiError } from '@/lib/api';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
import type { SecretWriteResponse } from './types';

/**
 * The editor's unsaved work.
 *
 * The table stages changes and writes them in one action rather than opening a
 * dialog per secret. That is the whole point of editing in place: adding six
 * keys to a new environment is one task, and six modal round-trips make it feel
 * like six.
 *
 * ── What is held here, and for how long ──
 * Two kinds of plaintext live in this state: values typed into a new row, and
 * values typed as a replacement for a stored secret. Both are the *user's own*
 * input — the same thing a form field held before — and both are dropped the
 * instant they are no longer needed: a successful write removes its row from
 * state, and `discardAll` clears everything at once. Nothing here is written to
 * `localStorage` or `sessionStorage` (a draft-restore feature would persist a
 * credential to disk), put in a URL, or passed to `console`.
 *
 * **A stored value is never loaded into this state on its own.** Opening the
 * editor on an existing secret starts it *empty*: the current value is only
 * obtainable through the audited reveal endpoint, and seeding it here would
 * decrypt a secret merely because somebody clicked "edit". The row offers an
 * explicit "load current value" action for people who want to amend rather than
 * retype, and that action goes through the same audited endpoint as any other
 * reveal, so the read is recorded like every other read.
 */

/** Which input an inline error belongs under. */
export type DraftField = 'name' | 'value';

export interface DraftError {
  field: DraftField;
  message: string;
}

/** A secret being composed in the table. Nothing here has reached the server. */
export interface Draft {
  id: string;
  name: string;
  value: string;
  note: string;
  /** From the last save attempt; cleared as soon as the row is edited again. */
  error: DraftError | null;
}

/** A new value staged against a secret that already exists. */
export interface PendingEdit {
  value: string;
  /** From the last save attempt. */
  error: string | null;
}

/** What one row of a draft is seeded with — by the add button, or by a paste. */
export interface DraftSeed {
  name?: string;
  value?: string;
  note?: string;
}

export interface SaveOutcome {
  created: number;
  updated: number;
  /** Submitted a value the server already held, so no version was appended. */
  unchanged: number;
  failed: number;
}

export interface StagedChanges {
  drafts: readonly Draft[];
  /** Keyed by secret name. Presence means that row's editor is open. */
  edits: ReadonlyMap<string, PendingEdit>;
  /** Rows a save would actually write. Blank rows are not changes. */
  pendingCount: number;
  saving: boolean;

  addDraft: (seed?: DraftSeed) => void;
  addDrafts: (seeds: readonly DraftSeed[]) => void;
  patchDraft: (id: string, patch: DraftSeed) => void;
  /** Replaces one draft with several — how a pasted `.env` block expands. */
  expandDraft: (id: string, seeds: readonly DraftSeed[]) => void;
  removeDraft: (id: string) => void;

  openEdit: (name: string) => void;
  setEdit: (name: string, value: string) => void;
  closeEdit: (name: string) => void;

  discardAll: () => void;
  /**
   * Writes every staged row. Rows that succeed are dropped; rows that fail stay
   * staged carrying the reason, so a batch that half-succeeds leaves the user
   * with exactly the work that is still outstanding.
   */
  save: (existingNames: ReadonlySet<string>) => Promise<SaveOutcome>;
}

export function isBlankDraft(draft: Draft): boolean {
  return draft.name.trim() === '' && draft.value === '' && draft.note.trim() === '';
}

/**
 * What is wrong with a draft's name, live, as it is typed.
 *
 * Returns `null` for an empty name: a row the user has just added is not yet
 * wrong, and flagging it before they have typed anything is noise. Save treats
 * an empty name on a row that has a value as the error it is.
 */
export function draftNameProblem(
  draft: Draft,
  drafts: readonly Draft[],
  existingNames: ReadonlySet<string>,
): string | null {
  const name = draft.name.trim();
  if (name.length === 0) return null;

  const check = checkSecretName(name);
  if (!check.valid) return check.message ?? 'That name cannot be used.';

  if (existingNames.has(name)) {
    return 'This environment already has a secret with that name.';
  }
  const twin = drafts.some((other) => other.id !== draft.id && other.name.trim() === name);
  return twin ? 'Another new row already uses that name.' : null;
}

/**
 * Turns a failed write into a message pinned to the right input.
 *
 * A non-`ApiError` is collapsed to a fixed string rather than having its
 * `message` read: an arbitrary exception's message may have been built from the
 * request payload, which on this path is a credential.
 */
function describeWriteFailure(cause: unknown): DraftError {
  if (!isApiError(cause)) return { field: 'value', message: 'Could not save this secret.' };

  if (cause.code === 'conflict') {
    return {
      field: 'name',
      message: 'A secret with this name already exists in this environment.',
    };
  }

  const fields = cause.fieldErrors();
  const nameProblem = fields['name'];
  if (nameProblem !== undefined) return { field: 'name', message: nameProblem };
  const valueProblem = fields['value'];
  if (valueProblem !== undefined) return { field: 'value', message: valueProblem };

  return { field: 'value', message: cause.message };
}

export function useStagedChanges(
  orgSlug: string,
  projectSlug: string,
  envSlug: string,
): StagedChanges {
  const [drafts, setDrafts] = useState<readonly Draft[]>([]);
  const [edits, setEdits] = useState<ReadonlyMap<string, PendingEdit>>(new Map());
  const [saving, setSaving] = useState(false);

  // Monotonic and never reused, so React keys stay stable while rows are added
  // and removed around them. An index key would make removing the first of
  // three drafts re-key the other two and move their DOM — which, in a row
  // holding a half-typed credential, moves the text the user is looking at.
  //
  // A ref rather than state: two `addDraft` calls in one tick would both read
  // the same rendered value and mint the same id, and duplicate keys in a list
  // of credential fields is how React starts showing one row's value in another.
  const nextId = useRef(1);

  const mint = useCallback((seeds: readonly DraftSeed[]): Draft[] => {
    return seeds.map((seed) => {
      const id = `draft-${nextId.current}`;
      nextId.current += 1;
      return {
        id,
        name: seed.name ?? '',
        value: seed.value ?? '',
        note: seed.note ?? '',
        error: null,
      };
    });
  }, []);

  const addDrafts = useCallback(
    (seeds: readonly DraftSeed[]) => {
      if (seeds.length === 0) return;
      const rows = mint(seeds);
      setDrafts((current) => [...current, ...rows]);
    },
    [mint],
  );

  const addDraft = useCallback((seed?: DraftSeed) => addDrafts([seed ?? {}]), [addDrafts]);

  const patchDraft = useCallback((id: string, patch: DraftSeed) => {
    setDrafts((current) =>
      current.map((draft) =>
        draft.id === id
          ? // The stale error is dropped on any edit: leaving "already exists"
            // under a name the user has since changed is worse than no message.
            { ...draft, ...patch, error: null }
          : draft,
      ),
    );
  }, []);

  const expandDraft = useCallback(
    (id: string, seeds: readonly DraftSeed[]) => {
      if (seeds.length === 0) return;
      const replacements = mint(seeds);
      setDrafts((current) => {
        const at = current.findIndex((draft) => draft.id === id);
        if (at === -1) return current;
        return [...current.slice(0, at), ...replacements, ...current.slice(at + 1)];
      });
    },
    [mint],
  );

  const removeDraft = useCallback((id: string) => {
    setDrafts((current) => current.filter((draft) => draft.id !== id));
  }, []);

  const openEdit = useCallback((name: string) => {
    setEdits((current) => {
      if (current.has(name)) return current;
      const next = new Map(current);
      // Empty, always. See the note at the top of this file about why a stored
      // value is never seeded into the editor.
      next.set(name, { value: '', error: null });
      return next;
    });
  }, []);

  const setEdit = useCallback((name: string, value: string) => {
    setEdits((current) => {
      const next = new Map(current);
      next.set(name, { value, error: null });
      return next;
    });
  }, []);

  const closeEdit = useCallback((name: string) => {
    setEdits((current) => {
      if (!current.has(name)) return current;
      const next = new Map(current);
      next.delete(name);
      return next;
    });
  }, []);

  const discardAll = useCallback(() => {
    setDrafts([]);
    setEdits(new Map());
  }, []);

  const pendingCount = useMemo(() => {
    const rows = drafts.filter((draft) => !isBlankDraft(draft)).length;
    let values = 0;
    for (const edit of edits.values()) if (edit.value.length > 0) values += 1;
    return rows + values;
  }, [drafts, edits]);

  const save = useCallback(
    async (existingNames: ReadonlySet<string>): Promise<SaveOutcome> => {
      setSaving(true);

      const outcome: SaveOutcome = { created: 0, updated: 0, unchanged: 0, failed: 0 };
      const survivingDrafts: Draft[] = [];
      const survivingEdits = new Map<string, PendingEdit>();

      // Grows as the batch proceeds, so two rows that both say `API_KEY` cannot
      // both be attempted. Without it the second would race the unique index and
      // come back as a 409 that reads like a server fault rather than a typo.
      const claimed = new Set(existingNames);

      // Wrapped so the two `set` calls and `setSaving(false)` happen on every
      // exit. Each write below already handles its own failure, so nothing is
      // *expected* to escape — but if anything ever does, the alternative is a
      // save button that spins forever over rows the user cannot get back.
      try {
        // Sequential, not `Promise.all`. Each write is a separate audited
        // mutation against the `RL_MUTATION` bucket, and firing thirty at once
        // would trip the rate limit and leave a partial save nobody asked for.
        // Slower, and the outcome is always describable.
        for (const draft of drafts) {
          if (isBlankDraft(draft)) continue;

          const name = draft.name.trim();
          const localProblem: DraftError | null =
            name.length === 0
              ? { field: 'name', message: 'Enter a name.' }
              : draft.value.length === 0
                ? { field: 'value', message: 'Enter a value.' }
                : claimed.has(name)
                  ? { field: 'name', message: 'That name is already taken in this environment.' }
                  : (() => {
                      const check = checkSecretName(name);
                      return check.valid
                        ? null
                        : {
                            field: 'name' as const,
                            message: check.message ?? 'That name cannot be used.',
                          };
                    })();

          if (localProblem !== null) {
            survivingDrafts.push({ ...draft, error: localProblem });
            outcome.failed += 1;
            continue;
          }

          try {
            await api.post<SecretWriteResponse>(apiPath.secrets(orgSlug, projectSlug, envSlug), {
              name,
              value: draft.value,
              ...(draft.note.trim().length === 0 ? {} : { note: draft.note.trim() }),
            });
            claimed.add(name);
            outcome.created += 1;
            // Not pushed to `survivingDrafts`, which is what drops the plaintext.
          } catch (cause) {
            survivingDrafts.push({ ...draft, error: describeWriteFailure(cause) });
            outcome.failed += 1;
          }
        }

        for (const [name, edit] of edits) {
          // An editor opened and left empty is not a change. Closing it silently
          // is right: the user opened a row, thought better of it, and does not
          // need an error for having changed their mind.
          if (edit.value.length === 0) continue;

          try {
            const result = await api.patch<SecretWriteResponse>(
              apiPath.secret(orgSlug, projectSlug, envSlug, name),
              { value: edit.value },
            );
            if (result.secret.status === 'unchanged') outcome.unchanged += 1;
            else outcome.updated += 1;
          } catch (cause) {
            survivingEdits.set(name, { ...edit, error: describeWriteFailure(cause).message });
            outcome.failed += 1;
          }
        }

        return outcome;
      } finally {
        setDrafts(survivingDrafts);
        setEdits(survivingEdits);
        setSaving(false);
      }
    },
    [drafts, edits, orgSlug, projectSlug, envSlug],
  );

  return {
    drafts,
    edits,
    pendingCount,
    saving,
    addDraft,
    addDrafts,
    patchDraft,
    expandDraft,
    removeDraft,
    openEdit,
    setEdit,
    closeEdit,
    discardAll,
    save,
  };
}

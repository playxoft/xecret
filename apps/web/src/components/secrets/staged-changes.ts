'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  checkSecretName,
  checkSecretValue,
  DEFAULT_SECRET_VALUE_TYPE,
  toSecretValueType,
} from '@xecret/core/validation';
import type { SecretValueType } from '@xecret/core/validation';
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
 * **A stored value reaches this state only through the audited reveal.**
 * Opening the editor on an existing secret fetches the current value from
 * `GET .../secrets/{name}` and seeds it here, so amending one character does not
 * mean retyping a credential out of a password manager. That fetch is a reveal
 * like any other and writes the same `secret.revealed` record: opening an editor
 * *is* reading the secret, and the audit log says so. What was seeded is
 * remembered as `baseline`, which is what keeps "opened it and changed nothing"
 * from counting as unsaved work or costing a write.
 */

/**
 * How long a seeded plaintext may sit in this state.
 *
 * The same window `SecretValue`, `ValueField` and `useRevealAll` keep, and it
 * lives here as well as in the row because this is where the plaintext actually
 * is: a row unmounts the moment the filter stops listing it, taking its timer
 * with it, and the credential it was seeded with would otherwise stay in this
 * map for the rest of the page's life.
 *
 * Only an editor still holding exactly what was loaded is dropped. Once the user
 * has typed, the box holds their own work — quite possibly pasted from somewhere
 * they cannot get it again — and no timer may take that.
 */
const SEED_DURATION_MS = 180_000;

/** How often the sweep looks. Coarse: the window is three minutes, not three. */
const SWEEP_INTERVAL_MS = 15_000;

/** Which input an inline error belongs under. */
export type DraftField = 'name' | 'value';

export interface DraftError {
  field: DraftField;
  message: string;
}

/**
 * Where a new row goes.
 *
 * The button above the table puts one at the top and the one under the last row
 * puts one at the bottom, because in both cases the row should appear where the
 * user was already looking. A single list with a single end would send half of
 * those clicks to the other end of sixty rows.
 */
export type DraftPlacement = 'start' | 'end';

/** A secret being composed in the table. Nothing here has reached the server. */
export interface Draft {
  id: string;
  /** Which end of the table this row was added at. */
  placement: DraftPlacement;
  name: string;
  value: string;
  note: string;
  /** One of `SECRET_VALUE_TYPES`. New rows start as `string`, which accepts anything. */
  valueType: SecretValueType;
  /** From the last save attempt; cleared as soon as the row is edited again. */
  error: DraftError | null;
}

/** A new value staged against a secret that already exists. */
export interface PendingEdit {
  value: string;
  /**
   * The stored value the editor was seeded with, when it was seeded at all.
   *
   * Present so a typed value can be compared against the stored one without
   * asking the server: an editor opened, read and closed again has
   * `value === baseline` and is not a change. It must not light the save bar,
   * and it must not produce a write the server would only answer `unchanged`.
   */
  baseline?: string | undefined;
  /**
   * When the baseline was fetched, as `Date.now()`. Present exactly when
   * `baseline` is, and read only by the sweep that enforces the window above —
   * counted from the decryption, so an editor left open cannot extend how long
   * the plaintext lives by being looked at.
   */
  seededAt?: number | undefined;
  /**
   * A type change staged alongside the value, or `undefined` to keep the stored
   * one.
   *
   * Carried here rather than written immediately, so "declare it an integer and
   * give it a new value" saves as one action. Applying the type on the dropdown's
   * change event would make the intermediate state — a value that does not match
   * its own declared type — reachable through the product's happy path.
   */
  valueType?: SecretValueType | undefined;
  /**
   * A staged rename, or `undefined` to keep the stored name. The row stages it
   * only when the input differs from the stored name, so its presence *is* the
   * change. Saved through the metadata route: a rename appends no version.
   */
  name?: string | undefined;
  /** A staged note, on the same terms. An empty string clears the stored note. */
  note?: string | undefined;
  /** From the last save attempt. */
  error: string | null;
}

/** What one row of a draft is seeded with — by the add button, or by a paste. */
export interface DraftSeed {
  name?: string;
  value?: string;
  note?: string;
  valueType?: SecretValueType;
}

export interface SaveOutcome {
  created: number;
  updated: number;
  /** Submitted a value the server already held, so no version was appended. */
  unchanged: number;
  failed: number;
  /**
   * Whether anything at all reached the server, including from a row that then
   * failed halfway.
   *
   * A row writes its value and its metadata as two requests, so a rename that
   * is rejected after the value has already been PATCHed leaves the environment
   * changed while the row counts only as `failed`. Callers holding a decrypted
   * snapshot of the environment have to drop it on that outcome too — asking
   * `created > 0 || updated > 0` would keep a snapshot of values that no longer
   * exist, and the next edit would seed itself from it.
   */
  wrote: boolean;
}

export interface StagedChanges {
  drafts: readonly Draft[];
  /** Keyed by secret name. Presence means that row's editor is open. */
  edits: ReadonlyMap<string, PendingEdit>;
  /** Rows a save would actually write. Blank rows are not changes. */
  pendingCount: number;
  saving: boolean;

  addDraft: (seed?: DraftSeed, placement?: DraftPlacement) => void;
  addDrafts: (seeds: readonly DraftSeed[], placement?: DraftPlacement) => void;
  patchDraft: (id: string, patch: DraftSeed) => void;
  /** Replaces one draft with several — how a pasted `.env` block expands. */
  expandDraft: (id: string, seeds: readonly DraftSeed[]) => void;
  removeDraft: (id: string) => void;

  openEdit: (name: string) => void;
  /**
   * Opens the editor on the value the secret already holds: the caller passes
   * the plaintext it has just revealed. Kept as the baseline, so an editor
   * opened and closed again leaves nothing staged.
   */
  seedEdit: (name: string, value: string) => void;
  setEdit: (name: string, value: string) => void;
  /**
   * Drops the staged value and its baseline, keeping a staged rename, note or
   * type. The row calls it when the value editor is cancelled: closing that box
   * must not throw away a rename typed into the field beside it.
   */
  resetEditValue: (name: string) => void;
  /** Stages a type change, opening the editor if it is not already open. */
  setEditType: (name: string, valueType: SecretValueType) => void;
  /**
   * Un-stages a type change. The row calls it when the type picked is the one
   * already stored: Radix fires `onValueChange` for the item that is already
   * checked, so re-picking a secret's own type would otherwise stage a change
   * to nothing and save it as a real write.
   */
  clearEditType: (name: string) => void;
  /**
   * Stages a rename or a note change. `null` un-stages that field — the row
   * passes it when the input is back to the stored value, so typing a name and
   * then restoring it leaves nothing pending.
   */
  setEditMeta: (name: string, patch: { name?: string | null; note?: string | null }) => void;
  closeEdit: (name: string) => void;

  discardAll: () => void;
  /**
   * Writes every staged row. Rows that succeed are dropped; rows that fail stay
   * staged carrying the reason, so a batch that half-succeeds leaves the user
   * with exactly the work that is still outstanding.
   */
  save: (existingNames: ReadonlySet<string>) => Promise<SaveOutcome>;
  /**
   * Drops every seeded plaintext, keeping whatever the user typed over it.
   *
   * For a write this table did not make — an import, a restore from another
   * surface. Every `baseline` here describes the environment as it stood before
   * that write, so an editor still holding one is offering a superseded
   * credential as the basis of the next edit, and a save would write it straight
   * back over what has just landed.
   */
  forgetSeeds: () => void;
}

/**
 * Whether this editor holds a value that differs from the stored one.
 *
 * The one place that question is answered, because three callers ask it and
 * they have to agree: the save bar's count, the row's "would closing this lose
 * work?" check, and the save loop deciding whether to issue a write at all.
 */
export function hasNewValue(edit: PendingEdit): boolean {
  return edit.value.length > 0 && edit.value !== edit.baseline;
}

/**
 * Whether the user has typed in this editor at all.
 *
 * A wider question than `hasNewValue`, and a different one. Emptying a seeded
 * box is not something a save would write — an empty value is not a value — but
 * it is unmistakably the user at work, and the editor must not then behave as
 * though it were untouched: Escape, a click elsewhere and the reveal window
 * would all close the box while somebody was reaching for their password
 * manager to paste the replacement.
 */
export function isTouched(edit: PendingEdit): boolean {
  return edit.baseline === undefined ? edit.value.length > 0 : edit.value !== edit.baseline;
}

/**
 * Whether this editor's staged name is a real rename.
 *
 * Shared by the save bar's count and by the save loop, because they used to
 * disagree: the count asked "is a name staged at all", the loop asked "is it
 * different from the stored one". Typing a trailing space satisfied the first
 * and not the second, so the bar claimed an unsaved change that Save then
 * dropped without writing anything, reporting "Nothing to save".
 *
 * `storedName` is the key this editor is filed under, which *is* the stored
 * name — a rename is staged in the entry, never applied to the key.
 */
export function wantsRename(storedName: string, edit: PendingEdit): boolean {
  const next = edit.name?.trim();
  return next !== undefined && next !== storedName;
}

/**
 * The same entry with its value and baseline removed, or `null` where nothing
 * would be left to keep.
 *
 * Shared by cancel, by the type/name/note un-staging paths, and by the sweep,
 * because all four have to agree about what "no value" leaves behind — an entry
 * that keeps an empty husk stays in `edits` forever, and one that is deleted
 * while it still holds a rename throws that rename away.
 */
function withoutValue(edit: PendingEdit): PendingEdit | null {
  if (edit.valueType === undefined && edit.name === undefined && edit.note === undefined) {
    return null;
  }
  return {
    value: '',
    ...(edit.valueType === undefined ? {} : { valueType: edit.valueType }),
    ...(edit.name === undefined ? {} : { name: edit.name }),
    ...(edit.note === undefined ? {} : { note: edit.note }),
    error: null,
  };
}

/**
 * Drops the seeded plaintext from every entry `expired` selects, and returns the
 * new map — or `null` when nothing had to change.
 *
 * Shared by the reveal-window sweep and by `forgetSeeds`, because the two have
 * to treat an editor identically and disagreed when they were written apart. An
 * untouched editor goes entirely; a touched one keeps the user's own work and
 * loses only the credential it was seeded with.
 */
export function dropSeeds(
  current: ReadonlyMap<string, PendingEdit>,
  expired: (edit: PendingEdit & { seededAt: number }) => boolean,
): Map<string, PendingEdit> | null {
  let changed = false;
  const next = new Map(current);

  for (const [name, edit] of current) {
    if (edit.seededAt === undefined) continue;
    if (!expired({ ...edit, seededAt: edit.seededAt })) continue;

    // `isTouched`, not `hasNewValue`: emptying a seeded box is not a value a
    // save would write, but it is unmistakably the user at work, and closing the
    // editor out from under somebody who cleared it and went to their password
    // manager for the replacement is the exact case `isTouched` exists to name.
    if (isTouched(edit)) {
      // Their work stays; the credential the box was seeded with does not, or an
      // edit begun and left open would pin the old plaintext here for the rest
      // of the page's life. Only once the box holds something of its own:
      // `isTouched` falls back to "not empty" when there is no baseline, so
      // stripping it from an emptied editor would make that editor read as
      // untouched and every guard would close it.
      if (edit.value.length === 0) continue;

      changed = true;
      // Rebuilt rather than spread-minus-two, so the seed cannot come back by
      // someone adding a field to `PendingEdit`.
      next.set(name, {
        value: edit.value,
        ...(edit.valueType === undefined ? {} : { valueType: edit.valueType }),
        ...(edit.name === undefined ? {} : { name: edit.name }),
        ...(edit.note === undefined ? {} : { note: edit.note }),
        error: edit.error,
      });
      continue;
    }

    changed = true;
    const stripped = withoutValue(edit);
    if (stripped === null) next.delete(name);
    else next.set(name, stripped);
  }

  return changed ? next : null;
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

/**
 * What is wrong with a draft at save time.
 *
 * Extracted from the save loop because it grew a fourth clause and a nested
 * ternary chain that long stops being readable as a list of rules. The order is
 * the order a person would check in: is there a name, is there a value, is the
 * name free, is the name legal, is the value the shape it says it is.
 */
function draftProblem(draft: Draft, name: string, claimed: ReadonlySet<string>): DraftError | null {
  if (name.length === 0) return { field: 'name', message: 'Enter a name.' };
  if (draft.value.length === 0) return { field: 'value', message: 'Enter a value.' };
  if (claimed.has(name)) {
    return { field: 'name', message: 'That name is already taken in this environment.' };
  }

  const nameCheck = checkSecretName(name);
  if (!nameCheck.valid) {
    return { field: 'name', message: nameCheck.message ?? 'That name cannot be used.' };
  }

  const shape = checkSecretValue(draft.value, toSecretValueType(draft.valueType));
  if (!shape.valid) {
    return { field: 'value', message: shape.message ?? 'That value does not match its type.' };
  }

  return null;
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

  const mint = useCallback((seeds: readonly DraftSeed[], placement: DraftPlacement): Draft[] => {
    return seeds.map((seed) => {
      const id = `draft-${nextId.current}`;
      nextId.current += 1;
      return {
        id,
        placement,
        name: seed.name ?? '',
        value: seed.value ?? '',
        note: seed.note ?? '',
        valueType: seed.valueType ?? DEFAULT_SECRET_VALUE_TYPE,
        error: null,
      };
    });
  }, []);

  const addDrafts = useCallback(
    (seeds: readonly DraftSeed[], placement: DraftPlacement = 'end') => {
      if (seeds.length === 0) return;
      const rows = mint(seeds, placement);
      // A row added at the top goes above the ones already there, so pressing
      // the button twice leaves the newest under the cursor rather than
      // three rows down.
      setDrafts((current) =>
        placement === 'start' ? [...rows, ...current] : [...current, ...rows],
      );
    },
    [mint],
  );

  const addDraft = useCallback(
    (seed?: DraftSeed, placement: DraftPlacement = 'end') => addDrafts([seed ?? {}], placement),
    [addDrafts],
  );

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
      // Minted outside the updater: `mint` advances the id counter, and a state
      // updater must be pure — React may call it twice.
      const rows = mint(seeds, 'end');
      setDrafts((current) => {
        const at = current.findIndex((draft) => draft.id === id);
        if (at === -1) return current;
        // The rows a paste expands into take the place, and the end, of the row
        // that was pasted into.
        const placement = current[at]?.placement ?? 'end';
        const replacements = rows.map((row) => ({ ...row, placement }));
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

  const seedEdit = useCallback((name: string, value: string) => {
    setEdits((current) => {
      const next = new Map(current);
      const existing = current.get(name);
      next.set(name, {
        value,
        baseline: value,
        seededAt: Date.now(),
        ...(existing?.valueType === undefined ? {} : { valueType: existing.valueType }),
        ...(existing?.name === undefined ? {} : { name: existing.name }),
        ...(existing?.note === undefined ? {} : { note: existing.note }),
        error: null,
      });
      return next;
    });
  }, []);

  const setEdit = useCallback((name: string, value: string) => {
    setEdits((current) => {
      const next = new Map(current);
      const existing = current.get(name);
      next.set(name, {
        value,
        // The baseline survives every keystroke: it is what the editor was
        // seeded with, and typing the stored value back in has to stay
        // recognisable as the non-change it is.
        ...(existing?.baseline === undefined
          ? {}
          : { baseline: existing.baseline, seededAt: existing.seededAt }),
        ...(existing?.valueType === undefined ? {} : { valueType: existing.valueType }),
        ...(existing?.name === undefined ? {} : { name: existing.name }),
        ...(existing?.note === undefined ? {} : { note: existing.note }),
        error: null,
      });
      return next;
    });
  }, []);

  const resetEditValue = useCallback((name: string) => {
    setEdits((current) => {
      const existing = current.get(name);
      if (existing === undefined) return current;

      const next = new Map(current);
      const stripped = withoutValue(existing);
      // Nothing else staged means there is no reason for the row to stay in the
      // map; an empty entry left behind would keep it marked as being edited for
      // the rest of the page's life.
      if (stripped === null) next.delete(name);
      else next.set(name, stripped);
      return next;
    });
  }, []);

  const setEditType = useCallback((name: string, valueType: SecretValueType) => {
    setEdits((current) => {
      const next = new Map(current);
      // Opens the editor when it was closed, so choosing a type from the row's
      // menu produces a visible pending change rather than a silent one. The
      // value stays empty, which the save path reads as "type only".
      const existing = current.get(name);
      next.set(name, {
        value: existing?.value ?? '',
        ...(existing?.baseline === undefined
          ? {}
          : { baseline: existing.baseline, seededAt: existing.seededAt }),
        valueType,
        ...(existing?.name === undefined ? {} : { name: existing.name }),
        ...(existing?.note === undefined ? {} : { note: existing.note }),
        error: null,
      });
      return next;
    });
  }, []);

  const clearEditType = useCallback((name: string) => {
    setEdits((current) => {
      const existing = current.get(name);
      if (existing === undefined || existing.valueType === undefined) return current;

      const next = new Map(current);
      // `baseline` is checked as well as `value`: a seeded editor whose box has
      // been emptied still has one open, and deleting the entry here would slam
      // it shut mid-edit and cost a second audited read to get back.
      if (
        existing.value.length === 0 &&
        existing.baseline === undefined &&
        existing.name === undefined &&
        existing.note === undefined
      ) {
        next.delete(name);
        return next;
      }

      next.set(name, {
        value: existing.value,
        ...(existing.baseline === undefined
          ? {}
          : { baseline: existing.baseline, seededAt: existing.seededAt }),
        ...(existing.name === undefined ? {} : { name: existing.name }),
        ...(existing.note === undefined ? {} : { note: existing.note }),
        error: null,
      });
      return next;
    });
  }, []);

  const setEditMeta = useCallback(
    (name: string, patch: { name?: string | null; note?: string | null }) => {
      setEdits((current) => {
        const next = new Map(current);
        const existing = current.get(name);
        // `undefined` in the patch means "not mentioned"; `null` means "back to
        // the stored value, drop it". Both collapse to omission below, which is
        // what keeps `pendingCount` honest about a field typed and then undone.
        const stagedName = patch.name === undefined ? (existing?.name ?? null) : patch.name;
        const stagedNote = patch.note === undefined ? (existing?.note ?? null) : patch.note;

        // A name typed and then restored, on a row holding nothing else, leaves
        // no reason for the entry to exist. Without this the row stays in the
        // map forever, which is what makes the "editor already open" no-op path
        // below reachable on a row nobody is editing.
        if (
          stagedName === null &&
          stagedNote === null &&
          (existing === undefined ||
            (existing.value.length === 0 &&
              existing.baseline === undefined &&
              existing.valueType === undefined))
        ) {
          next.delete(name);
          return next;
        }

        next.set(name, {
          value: existing?.value ?? '',
          ...(existing?.baseline === undefined
            ? {}
            : { baseline: existing.baseline, seededAt: existing.seededAt }),
          ...(existing?.valueType === undefined ? {} : { valueType: existing.valueType }),
          ...(stagedName === null ? {} : { name: stagedName }),
          ...(stagedNote === null ? {} : { note: stagedNote }),
          error: null,
        });
        return next;
      });
    },
    [],
  );

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

  const forgetSeeds = useCallback(() => {
    setEdits((current) => dropSeeds(current, () => true) ?? current);
  }, []);

  // The window, enforced where the plaintext actually lives. An interval rather
  // than a timer per entry: a timer keyed on `edits` would restart every time
  // anything anywhere in the table was typed, so one row's activity would extend
  // another row's window indefinitely — which is exactly what counting from the
  // decryption is supposed to prevent.
  useEffect(() => {
    const sweep = setInterval(() => {
      setEdits((current) => {
        const now = Date.now();
        return dropSeeds(current, (edit) => now - edit.seededAt >= SEED_DURATION_MS) ?? current;
      });
    }, SWEEP_INTERVAL_MS);

    return () => clearInterval(sweep);
  }, []);

  const pendingCount = useMemo(() => {
    const rows = drafts.filter((draft) => !isBlankDraft(draft)).length;
    let values = 0;
    // A staged type, name or note change counts even with no new value: it is a
    // change the user made and the save bar has to admit to holding it, or
    // Discard would silently throw away something they cannot see.
    for (const [name, edit] of edits) {
      if (
        hasNewValue(edit) ||
        edit.valueType !== undefined ||
        wantsRename(name, edit) ||
        edit.note !== undefined
      ) {
        values += 1;
      }
    }
    return rows + values;
  }, [drafts, edits]);

  const save = useCallback(
    async (existingNames: ReadonlySet<string>): Promise<SaveOutcome> => {
      setSaving(true);

      const outcome: SaveOutcome = {
        created: 0,
        updated: 0,
        unchanged: 0,
        failed: 0,
        wrote: false,
      };
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
          const localProblem = draftProblem(draft, name, claimed);

          if (localProblem !== null) {
            survivingDrafts.push({ ...draft, error: localProblem });
            outcome.failed += 1;
            continue;
          }

          try {
            await api.post<SecretWriteResponse>(apiPath.secrets(orgSlug, projectSlug, envSlug), {
              name,
              value: draft.value,
              valueType: draft.valueType,
              ...(draft.note.trim().length === 0 ? {} : { note: draft.note.trim() }),
            });
            claimed.add(name);
            outcome.created += 1;
            outcome.wrote = true;
            // Not pushed to `survivingDrafts`, which is what drops the plaintext.
          } catch (cause) {
            survivingDrafts.push({ ...draft, error: describeWriteFailure(cause) });
            outcome.failed += 1;
          }
        }

        for (const [name, edit] of edits) {
          const rename = edit.name?.trim();
          const renaming = wantsRename(name, edit);
          const hasValue = hasNewValue(edit);
          const hasMeta = renaming || edit.note !== undefined;

          // An editor opened and left untouched is not a change. Closing it
          // silently is right: the user opened a row, thought better of it, and
          // does not need an error for having changed their mind.
          if (!hasValue && edit.valueType === undefined && !hasMeta) continue;

          // Checked here as well as on the server, so a bad new name or a value
          // of the wrong shape is reported against its own row instead of
          // costing a round trip and coming back as one failure in a batch of
          // thirty.
          if (renaming && rename !== undefined) {
            const check = checkSecretName(rename);
            const problem = !check.valid
              ? (check.message ?? 'That name cannot be used.')
              : claimed.has(rename)
                ? 'That name is already taken in this environment.'
                : null;
            if (problem !== null) {
              survivingEdits.set(name, { ...edit, error: problem });
              outcome.failed += 1;
              continue;
            }
          }
          // The value this row will hold once the save lands: the new one where
          // one was typed, and otherwise the stored one the editor was seeded
          // with. Asking `hasValue` alone stopped checking the seeded case the
          // moment `hasNewValue` started excluding "opened and unchanged" — so
          // opening a value, leaving it alone and changing only the type wrote a
          // row declared `integer` holding `abc`, under a field that was already
          // showing that in red. Still skipped where nothing was seeded: there
          // is no value here to check, and the server tolerates the mismatch on
          // purpose.
          const effectiveValue = hasValue ? edit.value : edit.baseline;
          if (edit.valueType !== undefined && effectiveValue !== undefined) {
            const shape = checkSecretValue(effectiveValue, edit.valueType);
            if (!shape.valid) {
              survivingEdits.set(name, {
                ...edit,
                error: shape.message ?? 'That value does not match its type.',
              });
              outcome.failed += 1;
              continue;
            }
          }

          // The new value first, addressed by the *current* name, then the
          // metadata — so a rename never strands the value write against a name
          // that no longer exists. A type change with no new value rides with
          // the metadata: both take the route that appends no version, because
          // neither is a rotation and the version number must not claim one.
          let changed = false;
          try {
            if (hasValue) {
              const result = await api.patch<SecretWriteResponse>(
                apiPath.secret(orgSlug, projectSlug, envSlug, name),
                {
                  value: edit.value,
                  ...(edit.valueType === undefined ? {} : { valueType: edit.valueType }),
                },
              );
              changed = changed || result.secret.status !== 'unchanged';
            }

            const typeOnly = !hasValue && edit.valueType !== undefined;
            if (hasMeta || typeOnly) {
              const note = edit.note?.trim();
              await api.put(apiPath.secret(orgSlug, projectSlug, envSlug, name), {
                ...(renaming ? { name: rename } : {}),
                ...(note === undefined ? {} : { note: note.length === 0 ? null : note }),
                ...(typeOnly ? { valueType: edit.valueType } : {}),
              });
              changed = true;
            }

            if (changed) {
              outcome.updated += 1;
              outcome.wrote = true;
            } else outcome.unchanged += 1;

            if (renaming && rename !== undefined) {
              claimed.delete(name);
              claimed.add(rename);
            }
          } catch (cause) {
            // The whole edit survives, including a value the PATCH may already
            // have applied — retrying it is answered `unchanged`, which is
            // cheaper than a row silently losing half of what it staged.
            survivingEdits.set(name, { ...edit, error: describeWriteFailure(cause).message });
            outcome.failed += 1;
            // The value write goes first, so a metadata failure lands on a row
            // whose value is already stored. The row reports only `failed`, and
            // without this the caller would keep a decrypted snapshot of an
            // environment it no longer describes.
            if (changed) outcome.wrote = true;
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
    seedEdit,
    setEdit,
    resetEditValue,
    setEditType,
    clearEditType,
    setEditMeta,
    closeEdit,
    discardAll,
    forgetSeeds,
    save,
  };
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { toSecretValueType } from '@xecret/core/validation';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Badge, ConfirmDialog } from '@/components/ui';
import type { SecretSummary } from './types';
import type { ComparedEnvironment } from './use-compared-secrets';
import { EnvironmentLabel, ValueField } from './value-field';

/**
 * The same key, as another environment holds it.
 *
 * ── Why this writes on its own ──
 * The table's staged changes belong to the environment on screen: one save
 * button, one batch, one `useStagedChanges` bound to one slug. A compared
 * environment has no seat in that batch, and inventing one would mean the save
 * bar quietly writing to production because a value was typed into a row the
 * user opened to *look* at. So this field saves itself, explicitly, with its own
 * Save button.
 *
 * ── And why a write to a compared production is confirmed ──
 * The two fields in this cell look identical, and Ctrl+Enter in the top one goes
 * to a batch behind the save bar — production-toned, counted, discardable —
 * while in this one it is a `PATCH` that lands immediately. The dialog restores
 * the beat the save bar would have given: it names the environment, and it is
 * the only thing standing between a value typed while comparing and production
 * having it. Non-production environments write straight through, as they do
 * everywhere else in the product.
 *
 * ── Creating, not only changing ──
 * A cell whose environment has no such key offers to write one, through the
 * same field and the same button. That is what makes this a view of several
 * environments rather than a report about them: the answer to "staging is
 * missing `STRIPE_KEY`" is almost always to give staging one, and the long way
 * round was to navigate there and add it by hand. The production confirmation
 * covers it too, and says "create" rather than "save" so the dialog describes
 * what the button will do.
 *
 * Deletion is not offered here at all. Working across environments is mostly a
 * reading act, and the environment you are *in* is the one you can destroy
 * things in.
 */
export function ComparedValue({
  environment,
  secretName,
  secret,
  revealed,
  disabled,
  onHistory,
  onSaved,
  onDirtyChange,
}: {
  environment: ComparedEnvironment;
  secretName: string;
  /** `null` when this environment has no secret by that name. */
  secret: SecretSummary | null;
  /**
   * Plaintext a "Reveal all" or a hover reveal has already fetched for *this*
   * environment, and had audited. Supplied by the table, which decides whether
   * anything is on screen; without it this cell would re-fetch its own value and
   * put a second record in the log for one act.
   */
  revealed?: string | undefined;
  disabled: boolean;
  onHistory: () => void;
  /** Refetches this environment's listing, so the version chip catches up. */
  onSaved: () => void;
  /**
   * Reports whether this field is holding work a save would write.
   *
   * This component owns its editor, and it is rendered inside a row the table
   * unmounts on a filter keystroke — so without telling anybody, a value typed
   * here and not yet saved was destroyed by typing in the search box, and the
   * unsaved-changes guard never knew it existed.
   */
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [baseline, setBaseline] = useState('');
  const [prefilling, setPrefilling] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Bumped when this field writes, so its own reveal is dropped at once.
   *
   * The refetched listing invalidates it too, by version — but not until it
   * lands, and until then the field still holds what was there before the
   * write. See the prop of the same name on `ValueField`.
   */
  const [forgetToken, setForgetToken] = useState(0);

  /**
   * The note this component has written but not yet seen come back.
   *
   * The listing is refetched after a write, and until it lands `secret.note` is
   * still the old value — so the panel would show "No note on this key" for a
   * second immediately after somebody wrote one. Cleared as soon as the server
   * agrees, during render rather than in an effect so the stale text is never
   * painted.
   */
  const [writtenNote, setWrittenNote] = useState<string | null | undefined>(undefined);
  if (writtenNote !== undefined && (secret?.note ?? null) === writtenNote) {
    setWrittenNote(undefined);
  }

  /** See the note on the same ref in `SecretRow`: a cancelled seed must not land. */
  const seedGeneration = useRef(0);

  // Latest-ref, because the caller passes a fresh closure every render and this
  // must not re-fire on each one.
  const reportDirty = useRef(onDirtyChange);
  useEffect(() => {
    reportDirty.current = onDirtyChange;
  });

  const dirty = editing && draft !== baseline;
  useEffect(() => {
    reportDirty.current?.(dirty);
    return () => reportDirty.current?.(false);
  }, [dirty]);

  /**
   * This row's value **in the compared environment**.
   *
   * `environment.io` and not the page's: a row of the same name in another
   * environment is a different secret with its own id, its own version and its
   * own key. Using the page's IO would decrypt one environment's ciphertext with
   * another's AAD, which fails — loudly, and for a reason nobody could read off
   * the screen.
   */
  const reveal = useCallback(async () => {
    if (environment.io === null || secret === null) {
      throw new Error('This environment’s key is not available.');
    }
    return environment.io.reveal({ id: secret.id, name: secretName, version: secret.version });
  }, [environment.io, secret, secretName]);

  async function beginEdit(cached?: string) {
    if (editing) return;

    const generation = seedGeneration.current + 1;
    seedGeneration.current = generation;

    // Whatever the table has already decrypted for this environment, if the
    // field did not hand it over itself. Both were audited when they happened,
    // and asking again would log a second read for one act.
    const known = cached ?? revealed;

    setError(null);
    setEditing(true);
    setDraft(known ?? '');
    setBaseline(known ?? '');
    if (known !== undefined) return;
    // Nothing stored here, so there is nothing to seed *from*: the editor opens
    // empty and its first save creates the secret. Asking the reveal endpoint for
    // a secret that does not exist would be a 404 under an empty box.
    if (secret === null) return;

    setPrefilling(true);
    try {
      const plaintext = await reveal();
      if (seedGeneration.current !== generation) return;
      setDraft(plaintext);
      setBaseline(plaintext);
    } catch (cause) {
      if (seedGeneration.current !== generation) return;
      setError(errorMessage(cause));
    } finally {
      if (seedGeneration.current === generation) setPrefilling(false);
    }
  }

  function cancel() {
    seedGeneration.current += 1;
    setEditing(false);
    setPrefilling(false);
    setDraft('');
    setBaseline('');
    setError(null);
  }

  function commit() {
    // Nothing typed is not a write. Without this, opening a compared value to
    // read it and pressing Save would append a version to production recording
    // no change at all — and on an absent value it would create an empty
    // secret, which `draft === baseline` catches because both are ''.
    if (draft === baseline) {
      cancel();
      return;
    }

    if (environment.isProduction) {
      setConfirming(true);
      return;
    }

    // Swallowed deliberately: `write` rethrows for the confirmation dialog,
    // which is not in this path, and the reason is already in `error` under the
    // field. Letting it escape here would be an unhandled rejection carrying a
    // request whose body was a credential.
    void write().catch(() => {});
  }

  async function write() {
    setSaving(true);
    setError(null);
    try {
      if (environment.io === null) {
        throw new Error('This environment’s key is not available.');
      }

      if (secret === null) {
        // `string`, the type every new secret starts as: it accepts anything, and
        // the row it joins can be declared something narrower afterwards from the
        // environment it now lives in. The type menu belongs to the key, and the
        // key here is somebody else's.
        await environment.io.create({ name: secretName, value: draft, valueType: 'string' });
      } else {
        await environment.io.update(
          { id: secret.id, name: secretName, version: secret.version },
          { value: draft },
        );
      }
      seedGeneration.current += 1;
      setEditing(false);
      setDraft('');
      setBaseline('');
      setForgetToken((token) => token + 1);
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
      // Rethrown so the confirmation stays open with the reason beside the
      // button that failed, which is where the user is looking.
      throw cause;
    } finally {
      setSaving(false);
    }
  }

  // A listing still in flight, or one that could not be read at all: both are
  // states where `secret` is null for a reason that is not "this environment
  // does not have that key", and saying the wrong one of those three things is
  // worse than saying nothing. A missing grant on production is the common
  // case, and it must not read as an empty environment.
  // ...unless there is an editor open on it. A refetch that fails — a rate
  // limit, a transient error, one triggered by saving a *different* environment
  // in the same row — would otherwise replace a field holding typed work with a
  // message, leaving the value staged in state with no field, no Save and no
  // Cancel, recoverable only by reloading the page.
  // ...and only while there is nothing to show. A refetch keeps the listing it
  // already had, so a reload triggered by saving one environment must not blank
  // every cell of another one the user never touched — nor flash "Reading …"
  // over values that are still on screen and still correct.
  if (
    (environment.loading || environment.error !== null) &&
    !editing &&
    environment.byName.size === 0
  ) {
    return (
      <div className="flex min-w-0 items-center gap-2">
        <EnvironmentLabel
          environment={{ name: environment.name, isProduction: environment.isProduction }}
        />
        <div
          className={cn(
            'border-line-subtle flex min-h-9 min-w-0 flex-1 items-center rounded-md border border-dashed px-2.5 py-1.5 text-sm leading-5',
            environment.error === null ? 'text-fg-subtle' : 'text-danger-text',
          )}
        >
          {environment.error ?? `Reading ${environment.name}…`}
        </div>
      </div>
    );
  }

  /**
   * The note on *this* environment's secret.
   *
   * Written immediately, like the value beside it and for the same reason: the
   * save bar speaks for the environment on screen and this is not it. A note is
   * metadata — the route it takes appends no version — so there is nothing here
   * to confirm even in production.
   */
  async function saveNote(next: string | null) {
    setNoteSaving(true);
    setNoteError(null);
    try {
      if (environment.io === null || secret === null) {
        throw new Error('This environment’s key is not available.');
      }

      await environment.io.patchMetadata(
        { id: secret.id, name: secretName, version: secret.version },
        { note: next },
      );
      setWrittenNote(next);
      onSaved();
    } catch (cause) {
      // Reported inside the panel that made the write, not under the value: a
      // note that would not save says nothing about the value beside it.
      setNoteError(errorMessage(cause));
      // Rethrown so the panel keeps its editor open on what was typed. It is the
      // only copy — reopening re-seeds from the *stored* note — and the panel
      // catches this, so nothing escapes as an unhandled rejection.
      throw cause;
    } finally {
      setNoteSaving(false);
    }
  }

  return (
    <>
      <ValueField
        secret={secret}
        secretName={secretName}
        valueType={toSecretValueType(secret?.valueType ?? 'string')}
        environment={{ name: environment.name, isProduction: environment.isProduction }}
        // Writable where there is genuinely nothing here and something could be
        // put: a listing read to the end, and a key this browser can encrypt
        // with. Past the first page "not set" is a horizon rather than a fact,
        // and offering to create over it would race a key that may already
        // exist — a 409 the reader could not have predicted.
        creatable={!environment.truncated && environment.io !== null}
        // This listing is one page deep. Past that, "not set" is a claim about
        // an environment only part of which has been read, and a confident wrong
        // answer about whether production holds a key is worse than an honest
        // "cannot say".
        missingLabel={
          environment.truncated
            ? `Not in the first ${environment.byName.size} keys of ${environment.name}`
            : `Not set in ${environment.name}`
        }
        disabled={disabled}
        {...(revealed === undefined ? {} : { revealed })}
        onReveal={reveal}
        editing={editing}
        draft={draft}
        forgetToken={forgetToken}
        dirty={draft !== baseline}
        prefilling={prefilling}
        error={error}
        onEditOpen={beginEdit}
        onDraftChange={setDraft}
        onEditCancel={cancel}
        onCommit={commit}
        note={writtenNote !== undefined ? writtenNote : (secret?.note ?? null)}
        onNoteChange={saveNote}
        noteSaving={noteSaving}
        noteError={noteError}
        saveLabel={
          secret === null
            ? `Create in ${environment.name}`
            : environment.isProduction
              ? `Save to ${environment.name}`
              : 'Save'
        }
        saving={saving}
        onHistory={onHistory}
      />

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={
          secret === null
            ? `Create ${secretName} in ${environment.name}?`
            : `Save ${secretName} to ${environment.name}?`
        }
        description={
          secret === null
            ? 'This writes immediately, creating the key in that environment. It is not part of the unsaved changes on this page.'
            : 'This writes immediately and appends a version. It is not part of the unsaved changes on this page.'
        }
        confirmLabel={
          secret === null ? `Create in ${environment.name}` : `Save to ${environment.name}`
        }
        confirmVariant="primary"
        onConfirm={async () => {
          await write();
          setConfirming(false);
        }}
      >
        <Badge tone="production">Production</Badge>
      </ConfirmDialog>
    </>
  );
}

'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { FocusEvent, KeyboardEvent, ReactNode } from 'react';

import { checkSecretValue } from '@xecret/core/validation';
import type { SecretValueType } from '@xecret/core/validation';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatAbsoluteTime, formatRelativeTime, toIsoString } from '@/lib/format';
import {
  Button,
  CheckIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  InfoIcon,
  PencilIcon,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Spinner,
  Textarea,
  Tooltip,
  TrashIcon,
} from '@/components/ui';
import { Actor } from './actor';
import type { SecretSummary } from './types';

/**
 * One secret's value: the field, and everything you can do to it.
 *
 * ── The field is the row ──
 * The value takes the full width of its cell and carries nothing at either end.
 * It is the thing this screen exists to show and the thing hardest to read in a
 * hurry — a 64-character token wrapped around a column of buttons tells you
 * nothing. So the buttons are not in the row at all: they float in a small bar
 * above the field, on hover, the way Doppler and Phase do it.
 *
 * ── Why the bar floats ──
 * Absolutely positioned, so it takes no space in the layout. That is what keeps
 * every row exactly one line high whether or not the pointer is on it: a bar
 * that occupied a line would make the table shudder as the pointer crossed it,
 * and reserving that line permanently would halve the number of secrets on
 * screen. It appears on `group-hover` for a pointer and on `group-focus-within`
 * for everything else — tabbing or tapping into any control in the row brings it
 * up, which is what keeps this from being a mouse-only feature.
 *
 * ── What the field does when clicked ──
 * It opens the editor on the *current* value. That is a decryption, and it is
 * the audited one — `GET …/secrets/{name}`, the same request the eye issues,
 * writing the same `secret.revealed` record. So clicking a value shows it and
 * makes it editable in one act, and the audit log records that act honestly as
 * a read. When this component is already holding that plaintext — from the eye,
 * or from a "Reveal all" — it hands it over instead, because one act should not
 * write two records.
 *
 * ── Clicking is not a mode ──
 * An editor nobody has typed into offers nothing to cancel: no Cancel button, no
 * Save, no visible state beyond a caret. Clicking away closes it again. Those
 * controls appear the moment the value differs from what was loaded, which is
 * the moment there is something to keep or throw away. Clicking a value to read
 * it should not feel like entering a form.
 *
 * ── An editor that has not been typed into is still just a read ──
 * While the draft matches what was loaded, this holds a decrypted credential the
 * user has not altered — so it closes when the reveal window ends and when the
 * tab is hidden, exactly as the masked field does. The moment anything is typed
 * that stops: the box then holds the user's own work, quite possibly pasted from
 * somewhere they cannot get it again, and no timer may throw that away.
 *
 * ── Copy still never renders ──
 * The copy button writes straight to the clipboard without putting the value on
 * screen or starting a reveal window. The common case is pasting into a
 * terminal, and displaying it on the way there is exposure that buys nothing.
 */

/**
 * The mask is a fixed length, deliberately unrelated to the real one — length
 * distinguishes a 16-character API key from a 64-character token and turns
 * "unknown credential" into "AWS access key, brute-forceable offline at this
 * cost". Same constant, same reasoning, as `SecretValue`.
 */
const MASK = '•'.repeat(18);

/** Matches `SecretValue` and `useRevealAll`, so everything masks at one pace. */
const REVEAL_DURATION_MS = 180_000;

const NOTE_MAX_LENGTH = 1024;

export interface ValueFieldProps {
  /** The secret this field shows. `null` where the environment has no such key. */
  secret: SecretSummary | null;
  secretName: string;
  valueType: SecretValueType;
  /**
   * Which environment this field belongs to, shown as a label on its left.
   *
   * Only set while the row is comparing environments: with one field there is
   * nothing to disambiguate, and a label repeating the page heading is noise.
   */
  environment?: { name: string; isProduction: boolean } | undefined;
  /**
   * What to say where there is no such secret. The default states a fact the
   * caller may not be able to support — see `ComparedValue`, which cannot say
   * "not set" about an environment it has read only the first page of.
   */
  missingLabel?: string | undefined;
  disabled: boolean;
  /** Plaintext a "Reveal all" or hover reveal already fetched and had audited. */
  revealed?: string | undefined;
  onReveal: () => Promise<string>;

  editing: boolean;
  /** What is in the editor. Seeded with the stored value by the caller. */
  draft: string;
  /**
   * Whether the draft differs from what was loaded into it.
   *
   * The caller owns this because only the caller knows the baseline. It decides
   * four things: whether Cancel and Save are on screen at all, whether Escape
   * may close the box, whether the reveal window may close it, and whether
   * hiding the tab may.
   */
  dirty: boolean;
  /** True while the seed is in flight. */
  prefilling: boolean;
  /** From the last write attempt, or from a failed seed. */
  error: string | null;
  /** Opens the editor. Given this field's plaintext when it already holds one. */
  onEditOpen: (cached?: string) => void;
  onDraftChange: (value: string) => void;
  onEditCancel: () => void;
  /** Ctrl/Cmd+Enter, and the Save button where this field owns its own write. */
  onCommit: () => void;
  /**
   * Renders Save beside Cancel, once there is something to save. Present only
   * for a field that writes on its own — a compared environment, which the save
   * bar does not speak for.
   */
  saveLabel?: string | undefined;
  saving?: boolean | undefined;

  /** The note in effect: the staged one where there is one, the stored one otherwise. */
  note?: string | null | undefined;
  /** Absent where notes cannot be changed from here. `null` clears the note. */
  onNoteChange?: ((note: string | null) => void) | undefined;
  noteSaving?: boolean | undefined;
  /**
   * Why the last note write failed. Reported inside the panel that made it,
   * rather than under the value field — a note that would not save has nothing
   * to do with the value, and saying so beside the value marks the value
   * invalid.
   */
  noteError?: string | null | undefined;

  onHistory: () => void;
  /** Absent on a compared environment: deletion stays in the one you are in. */
  onDelete?: (() => void) | undefined;
}

export function ValueField({
  secret,
  secretName,
  valueType,
  environment,
  missingLabel,
  disabled,
  revealed: external,
  onReveal,
  editing,
  draft,
  dirty,
  prefilling,
  error,
  onEditOpen,
  onDraftChange,
  onEditCancel,
  onCommit,
  saveLabel,
  saving = false,
  note,
  onNoteChange,
  noteSaving = false,
  noteError = null,
  onHistory,
  onDelete,
}: ValueFieldProps) {
  const [value, setValue] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [loading, setLoading] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied'>('idle');
  const [revealError, setRevealError] = useState<string | null>(null);

  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const displayRef = useRef<HTMLButtonElement>(null);
  /**
   * Everything that counts as "still in this field" — the label, its details
   * panel's trigger, the toolbar, and the box itself.
   *
   * Blur is measured against this. It used to be measured against the box and
   * the toolbar alone, so on a comparing row the details button beside the
   * environment name read as somewhere else entirely and closed the editor the
   * moment it was clicked.
   */
  const fieldRef = useRef<HTMLDivElement>(null);
  /** Set by Cancel, consumed once the display box is back. See the effect below. */
  const restoreFocus = useRef(false);

  const messageId = useId();

  /** Hide it, keep it: reversible for the rest of the window without a request. */
  const mask = useCallback(() => setShown(false), []);

  /**
   * Hide it and drop it. Only for a value that has become *wrong* — a write
   * landed and this copy describes the version before it. Time no longer calls
   * this; see the masking window below.
   */
  const forget = useCallback(() => {
    setShown(false);
    setValue(null);
  }, []);

  // A write to this secret makes everything cached here wrong. Without this the
  // row would keep showing the value it had before a save — beside a version
  // chip reading the new number — Copy would put the superseded credential on
  // the clipboard, and the editor would seed itself from the old value and write
  // it straight back over the new one. Compared during render rather than in an
  // effect, so the stale plaintext is never painted.
  const version = secret?.version ?? 0;
  const [renderedVersion, setRenderedVersion] = useState(version);
  if (renderedVersion !== version) {
    setRenderedVersion(version);
    if (value !== null) forget();
  }

  const reveal = useCallback(async () => {
    setRevealError(null);

    if (value !== null) {
      setShown(true);
      return;
    }

    setLoading(true);
    try {
      const plaintext = await onReveal();
      setValue(plaintext);
      setShown(true);
    } catch (cause) {
      setRevealError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [onReveal, value]);

  const copy = useCallback(async () => {
    setRevealError(null);
    setCopyState('copying');
    try {
      const plaintext = external ?? value ?? (await onReveal());
      await navigator.clipboard.writeText(plaintext);
      setCopyState('copied');
      copyResetTimer.current = setTimeout(() => setCopyState('idle'), 2000);
    } catch (cause) {
      setCopyState('idle');
      setRevealError(
        cause instanceof DOMException
          ? 'Your browser blocked clipboard access. Reveal the value and copy it manually.'
          : errorMessage(cause),
      );
    }
  }, [external, onReveal, value]);

  // The window takes the value off the screen; it does not throw the decryption
  // away. Those are two different acts and only the first is about what somebody
  // walking past a desk can read — see `usePlaintextCache`, which holds the
  // plaintext until something makes it *wrong*. Revealing again after the window
  // lapses is therefore free and writes no second audit record.
  //
  // Counted from the decryption rather than from the last time the value was on
  // screen: masking and unmasking must not extend how long a plaintext is
  // rendered.
  useEffect(() => {
    if (value === null || !shown) return;

    const maskAt = setTimeout(mask, REVEAL_DURATION_MS);
    return () => clearTimeout(maskAt);
  }, [value, shown, mask]);

  // The latest-ref pattern, so the effects below can depend on *what* happened
  // rather than on a callback whose identity changes every render — which would
  // restart the window on every keystroke elsewhere in the row.
  const cancelRef = useRef(onEditCancel);
  useEffect(() => {
    cancelRef.current = onEditCancel;
  });

  /**
   * Closing the editor without the user asking — the window lapsing, the tab
   * being hidden.
   *
   * Restores focus exactly as Cancel does: a keyboard user sitting in the box
   * when the window ends must not be dropped on `document.body` at the top of a
   * sixty-row table.
   */
  const closeUntouched = useCallback(() => {
    // Only pull the cursor back if it is in here to begin with. The window can
    // lapse while the user is typing in the filter box or reading the history
    // dialog, and yanking focus out of those, three minutes after they left this
    // row, is worse than the lost position it was meant to prevent.
    const active = document.activeElement;
    restoreFocus.current = active instanceof Node && fieldRef.current?.contains(active) === true;
    cancelRef.current();
  }, []);

  // An editor still holding exactly what was loaded into it is a reveal wearing
  // a different shape, and it forgets on the same schedule. Once `dirty`, the
  // box holds the user's own work and nothing here may discard it.
  useEffect(() => {
    if (!editing || dirty || prefilling) return;

    const closeAt = setTimeout(closeUntouched, REVEAL_DURATION_MS);
    return () => clearTimeout(closeAt);
  }, [editing, dirty, prefilling, closeUntouched]);

  // Hide the tab and an untouched editor closes with everything else on screen:
  // starting a screen share or taking a call must not leave a credential
  // rendered in a background tab that gets restored later. Only
  // `visibilitychange` — see the note in `SecretValue` about why `blur` is not
  // in this list.
  useEffect(() => {
    const untouchedEditor = editing && !dirty;
    if (!shown && !untouchedEditor) return;

    const onVisibility = () => {
      if (document.visibilityState !== 'hidden') return;
      mask();
      if (untouchedEditor) closeUntouched();
    };

    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [shown, editing, dirty, mask, closeUntouched]);

  // A seed that lands after the user has moved on. `handleBlur` cannot act
  // while the reveal is in flight — closing then would drop a request the user
  // asked for — so the check happens when it arrives instead. Without this, a
  // click on a value followed immediately by a click somewhere else leaves a
  // decrypted credential in an open editor nobody is looking at.
  useEffect(() => {
    if (!editing || prefilling || dirty) return;

    const active = document.activeElement;
    if (active instanceof Node && fieldRef.current?.contains(active)) return;
    // Not `closeUntouched`: focus is elsewhere by definition, and this must not
    // drag it back.
    cancelRef.current();
  }, [editing, prefilling, dirty]);

  // Cancelling puts the cursor back on the field it came from. Without it focus
  // falls to `document.body` and a keyboard user is returned to the top of a
  // sixty-row table. Only after a cancel: a save closes the editor too, and
  // there the focus belongs to the save bar the user just pressed.
  useEffect(() => {
    if (editing || !restoreFocus.current) return;
    restoreFocus.current = false;
    displayRef.current?.focus();
  }, [editing]);

  useEffect(
    () => () => {
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    },
    [],
  );

  // A value supplied from outside wins, so clearing "Reveal all" re-masks every
  // row at once rather than leaving behind the ones also revealed individually.
  const displayed = external ?? (shown ? value : null);
  const isRevealed = displayed !== null;
  /**
   * The plaintext this field is holding, whether or not it is on screen.
   *
   * What the editor is seeded from. It used to be seeded from `displayed`, which
   * is null while the value is masked — so revealing a secret, hiding it again
   * and then clicking it to edit issued a fresh decryption for a value sitting
   * two lines up in this very component. Masked is not the same as unknown.
   */
  const held = external ?? value;

  // Checked as you type, against the same module the server checks against on
  // write. This copy exists so the failure arrives while the value is still on
  // screen and fixable; the server's copy is the one that is load-bearing.
  const shape = checkSecretValue(draft, valueType);
  const shapeProblem = editing && !shape.valid ? (shape.message ?? null) : null;
  // The live shape check first: it describes what is in the box now, while
  // `error` describes the last attempt and may already be stale.
  const problem = shapeProblem ?? error;

  function cancel() {
    restoreFocus.current = true;
    onEditCancel();
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      // Enter saves. The value is the end of the row — there is nothing after it
      // to move on to — so the key that means "done" everywhere else in a form
      // means it here too. Ctrl/Cmd+Enter still does, from anywhere.
      //
      // Which leaves Shift+Enter to type an actual newline. Values that contain
      // one are real — a PEM block, a JSON document — but they are the small
      // minority, and they are pasted far more often than they are typed.
      event.preventDefault();
      onCommit();
      return;
    }
    // Escape closes an editor holding nothing of the user's own. Once something
    // has been typed, Escape would throw away an edit — or a credential pasted
    // from somewhere it cannot easily be got again — and Escape is pressed by
    // accident constantly.
    if (event.key === 'Escape' && !dirty && !prefilling) {
      event.preventDefault();
      cancel();
    }
  }

  /**
   * Clicking away from an untouched editor closes it.
   *
   * The other half of "clicking is not a mode": the box opened without
   * announcing itself and it leaves the same way, so a value read and abandoned
   * puts the row back exactly as it was — and drops the plaintext with it. A
   * dirty editor stays, because closing it would throw away work.
   */
  function handleBlur(event: FocusEvent<HTMLTextAreaElement>) {
    if (dirty || prefilling) return;

    const next = event.relatedTarget;
    if (next instanceof Node && fieldRef.current?.contains(next)) return;
    // Radix renders popovers and tooltips into a portal at the document root, so
    // a panel opened from this field's own controls is not a descendant of it.
    // Without this, opening the details panel closes the editor behind it.
    if (next instanceof Element && next.closest('[data-radix-popper-content-wrapper]') !== null) {
      return;
    }

    onEditCancel();
  }

  const details =
    secret !== null && onNoteChange !== undefined ? (
      <FieldDetails
        secret={secret}
        {...(environment === undefined ? {} : { environmentName: environment.name })}
        note={note ?? null}
        onNoteChange={onNoteChange}
        noteSaving={noteSaving}
        noteError={noteError}
        disabled={disabled}
      />
    ) : null;

  return (
    <div
      ref={fieldRef}
      className={cn(
        // The group is the *field*, not the row. With environments stacked in
        // one cell there is a bar per field, and keying them all off the row
        // would raise every one of them at once — each covering the field above
        // it. Hovering a value raises that value's bar and no other.
        'group/field flex min-w-0 flex-col gap-1',
        // Room for the bar to sit in, once it is pinned there by an unsaved
        // change. Floating over the field above is fine for a bar that comes and
        // goes under the pointer; one that stays would hide a value being
        // compared against for as long as the edit lasts. Not needed where the
        // bar is in the flow already — see the coarse-pointer note below.
        dirty && 'pointer-fine:pt-10',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {environment ? (
          // In a comparison the details sit beside the environment they are
          // about: dev and production can say different things about the same
          // key, and which one you are reading has to be unambiguous.
          <EnvironmentLabel environment={environment} details={details} />
        ) : null}

        <div className="relative min-w-0 flex-1">
          {secret === null && !(editing && dirty) ? null : (
            <div
              // Clicking a control here must not move focus out of the editor:
              // Safari and Firefox do not focus a button on click, so the blur
              // would arrive with no `relatedTarget` to recognise and the box
              // would close under the click. Keeping the caret where it is also
              // means Copy and Show do not interrupt what the user was typing.
              onMouseDown={(event) => event.preventDefault()}
              className={cn(
                // Floating, so it costs the row no height at all and the table
                // stays one line per secret.
                //
                // The gap between the bar and the field is this element's
                // padding rather than a margin, so the hoverable area runs
                // unbroken from one to the other. As a margin it was a four-pixel
                // dead zone that dropped the hover halfway to the button the
                // user was reaching for.
                'absolute bottom-full left-0 z-20 pb-1 transition-opacity',
                // On a coarse pointer there is no hover, and the only thing that
                // could raise a floating bar is focus — which on this field means
                // tapping the value, which decrypts it. That would leave a phone
                // with no way to *copy* a secret without first putting it on
                // screen, and would make every tap an audited read. So on touch
                // the bar is simply part of the row: always there, in the flow,
                // over nothing.
                'pointer-coarse:static pointer-coarse:z-auto pointer-coarse:mb-1 pointer-coarse:pb-0',
                'pointer-coarse:pointer-events-auto pointer-coarse:opacity-100',
                dirty
                  ? 'opacity-100'
                  : cn(
                      // Shown for a pointer on hover, and for everything else the
                      // moment focus lands in this field — which is what a tap
                      // does, so this is not a mouse-only affordance.
                      'pointer-events-none opacity-0',
                      'group-hover/field:pointer-events-auto group-hover/field:opacity-100',
                      'group-focus-within/field:pointer-events-auto group-focus-within/field:opacity-100',
                      // An open panel keeps its trigger on screen; anchoring a
                      // popover to something invisible is how a panel ends up
                      // floating in space.
                      'has-[[data-state=open]]:pointer-events-auto has-[[data-state=open]]:opacity-100',
                    ),
              )}
            >
              {/* `--line-strong`, not `--line`: this is a surface floating over
                  another surface of the same colour, and its edge is the only
                  thing saying where one ends and the other begins.

                  32px targets rather than 28px. The bar is transient — it
                  appears under the pointer and goes away again — so every pixel
                  of a control here is a pixel the pointer does not have to
                  travel back for, and Reveal, Copy and Delete sitting a few
                  pixels apart at 28px is how the wrong one gets pressed. Still
                  under the 36px the rest of the row uses: this floats over the
                  field above it and has to stay smaller than the thing it
                  covers. */}
              <div className="border-line-strong bg-surface shadow-overlay flex items-center gap-0.5 rounded-lg border p-0.5">
                {secret === null ? null : (
                  <>
                    <Tooltip content={isRevealed ? 'Hide' : 'Reveal'}>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-8"
                        onClick={isRevealed ? mask : reveal}
                        // An externally-supplied value is cleared by the control that
                        // supplied it, so this row's own toggle has nothing to do.
                        disabled={loading || external !== undefined}
                        // No `aria-pressed` beside a label that already toggles: it
                        // would be announced as "Hide the value of X, pressed", which
                        // states the same fact twice and in opposite directions.
                        aria-label={
                          isRevealed
                            ? `Hide the value of ${secretName}`
                            : `Reveal the value of ${secretName}`
                        }
                      >
                        {loading ? (
                          <Spinner className="size-4.5" label={null} />
                        ) : isRevealed ? (
                          <EyeOffIcon className="size-4.5" />
                        ) : (
                          <EyeIcon className="size-4.5" />
                        )}
                      </Button>
                    </Tooltip>

                    <Tooltip content={copyState === 'copied' ? 'Copied' : 'Copy'}>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-8"
                        onClick={copy}
                        disabled={copyState === 'copying'}
                        aria-label={`Copy the value of ${secretName} to the clipboard`}
                      >
                        {copyState === 'copied' ? (
                          <CheckIcon className="text-success-text size-4.5" />
                        ) : copyState === 'copying' ? (
                          <Spinner className="size-4.5" label={null} />
                        ) : (
                          <CopyIcon className="size-4.5" />
                        )}
                      </Button>
                    </Tooltip>

                    {editing ? null : (
                      <Tooltip content="Edit">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-8"
                          onClick={() => onEditOpen(held ?? undefined)}
                          disabled={disabled}
                          aria-label={`Edit the value of ${secretName}`}
                        >
                          <PencilIcon className="size-4.5" />
                        </Button>
                      </Tooltip>
                    )}

                    {/* The badge, made a door: the chip naming the current version is
                  what a person clicks to ask what the previous ones were. The
                  visible label opens the accessible name, so "click v3" works
                  for somebody driving this by voice. */}
                    <Tooltip content="Version history">
                      <button
                        type="button"
                        onClick={onHistory}
                        aria-label={`v${secret.version} — version history of ${secretName}`}
                        className={cn(
                          'border-line bg-canvas-inset text-fg-muted inline-flex h-7 cursor-pointer items-center rounded-full border px-2.5 text-sm font-medium transition-colors',
                          'hover:border-accent-line hover:bg-accent-tint hover:text-accent-text',
                        )}
                      >
                        v{secret.version}
                      </button>
                    </Tooltip>

                    {/* Only one of the two ever renders: with an environment label
                  present the details belong beside it, not out here. */}
                    {environment === undefined ? details : null}

                    {onDelete ? (
                      <Tooltip content="Delete">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-fg-muted hover:text-danger-text size-8"
                          disabled={disabled}
                          onClick={onDelete}
                          aria-label={`Delete ${secretName}`}
                        >
                          <TrashIcon className="size-4.5" />
                        </Button>
                      </Tooltip>
                    ) : null}
                  </>
                )}

                {/* Only once there is something to keep or throw away. An editor
                    nobody has typed into needs no exit: clicking away closes it.
                    Rendered even where the secret has gone — a listing that
                    reloaded without it, or failed — because an editor holding
                    typed work must always have a way out of it. */}
                {editing && dirty ? (
                  <>
                    {secret === null ? null : (
                      <span aria-hidden="true" className="bg-line mx-0.5 h-5 w-px" />
                    )}
                    {saveLabel !== undefined ? (
                      <Button
                        variant="primary"
                        size="sm"
                        className="h-8"
                        onClick={onCommit}
                        loading={saving}
                        disabled={disabled || prefilling || shapeProblem !== null}
                      >
                        {saveLabel}
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8"
                      onClick={cancel}
                      disabled={disabled || saving}
                      aria-label={`Discard the change to ${secretName}`}
                    >
                      Cancel
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
          )}

          {editing ? (
            <div className="relative">
              {/* Grows downwards to fit what is in it — `field-sizing-content`
                  where the browser has it — and never sideways. Capped, because
                  a 40-line JSON blob must not push the rest of the table off the
                  screen; past the cap it scrolls. The cap is also how far the
                  grabber in the corner can be dragged — `max-height` clamps a
                  dragged height as surely as a grown one — so it is set at about
                  a dozen lines rather than four: far enough to be worth
                  dragging, short enough to leave the table underneath. */}
              <Textarea
                value={draft}
                onChange={(event) => onDraftChange(event.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={handleBlur}
                disabled={disabled || saving}
                // Read-only rather than disabled while the seed is in flight: a
                // disabled control cannot hold focus, so `autoFocus` would be
                // dropped and the click that opened the editor would not put a
                // cursor in it. This way the caret is already there when the
                // value lands.
                readOnly={prefilling}
                rows={1}
                placeholder={prefilling ? 'Loading the current value…' : `Value for ${secretName}`}
                aria-label={`Value of ${secretName}`}
                // What the key beside this hands focus to when Enter is
                // pressed in it. See `goToValue` in `SecretRow`.
                data-value-editor=""
                aria-busy={prefilling || undefined}
                aria-invalid={problem !== null ? true : undefined}
                aria-describedby={problem !== null ? messageId : undefined}
                // Every assistant that could copy this value somewhere else is
                // off: autocomplete would offer it back on another form, and a
                // spell checker on some platforms sends its input to a service.
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                className={cn(
                  // `resize-y` is `Textarea`'s own default and is kept: the
                  // grabber in the bottom-right corner is how a value taller
                  // than the cap gets looked at all at once. Vertical only —
                  // dragging this wider would drag it over the key column.
                  //
                  // `w-full` and `break-all` together hold the width still: the
                  // box is as wide as the column and a long token wraps inside
                  // it rather than scrolling sideways under the cursor.
                  //
                  // `block` is load-bearing. A textarea is inline-block by
                  // default, so it sits on its parent's text baseline and the
                  // line box keeps room for descenders *under* it — four or five
                  // pixels of empty space that belong to no element and cannot
                  // be seen. The row is `h-14` against a 36px field and 20px of
                  // cell padding, exactly full, so those few pixels were enough
                  // to push every row taller the moment its value was clicked.
                  // The masked box never did it because `flex` is block-level.
                  //
                  // `py-[7px]`, not `py-1.5`: 20px of line in a 36px box with 1px
                  // borders leaves 14px to split, and 6px each would leave the
                  // box 34px and let `min-h-9` make up the difference at the
                  // bottom — a textarea top-aligns its text, so that lands as
                  // two pixels of text sat too high. Seven each is exact, and it
                  // keeps this box and the one it replaces the same height at
                  // every line count rather than only at one.
                  'block field-sizing-content max-h-64 min-h-9 w-full px-2.5 py-[7px] font-mono text-sm leading-5 break-all',
                  // Focus lands on the border this box already has, rather than
                  // on a ring drawn outside it. The app-wide `:focus-visible`
                  // outline is 2px with a 2px offset, which around a field sat
                  // directly under the pointer reads as the box jumping four
                  // pixels bigger on every side the instant it is clicked — and
                  // it draws a second line around a control whose own line is
                  // the only thing saying it is a control. `--accent` against
                  // `--line-control` is a large enough step to be unmistakable
                  // without adding anything to the layout.
                  'focus-visible:border-accent focus-visible:outline-none',
                  problem !== null && 'border-danger',
                )}
                autoFocus
              />
              {prefilling ? (
                <span className="absolute top-2 right-2.5">
                  <Spinner className="size-4.5" label={null} />
                </span>
              ) : null}
            </div>
          ) : secret === null ? (
            <div className="border-line-subtle bg-canvas-inset/60 text-fg-subtle flex h-9 w-full items-center rounded-md border border-dashed px-2.5 text-sm leading-5">
              <span className="truncate">
                {missingLabel ?? `Not set in ${environment?.name ?? 'this environment'}`}
              </span>
            </div>
          ) : (
            // The field itself is the edit affordance. Clicking a value is the
            // thing people try first, and a box that looks like an input and
            // does nothing when clicked is a bug report waiting to happen.
            //
            // No `aria-label`: it would become the button's whole accessible
            // name and the value inside it would never be announced, so a screen
            // reader user could reveal a secret and still have no way to read
            // it. The name is built from the content instead.
            <button
              ref={displayRef}
              type="button"
              onClick={() => onEditOpen(held ?? undefined)}
              disabled={disabled}
              className={cn(
                // `--line-control`, matching every other field on this screen:
                // the border is the only thing saying a box is here.
                //
                // `min-h-9`: a value too long for one line costs *height*. The
                // width is the column's, it is the same on every row, and no
                // state this field can be in changes it — see the `table-fixed`
                // note in `SecretTable` for the other half of that.
                'border-line-control bg-canvas-inset hover:border-fg-subtle flex min-h-9 w-full cursor-text items-center rounded-md border px-2.5 py-[7px] text-left transition-colors',
                'disabled:cursor-not-allowed disabled:opacity-60',
              )}
            >
              {isRevealed ? (
                <>
                  <span className="sr-only">Value of {secretName}, revealed. Click to edit: </span>
                  {/* `break-all`, because the thing being wrapped is a token:
                      there is no word boundary in a 64-character key, and
                      `break-word` would leave the whole of it on a line of its
                      own — overflowing sideways, which is the one thing this
                      field may never do. Capped at three lines; past that it is
                      not being read, and the editor is where a value that long
                      gets looked at properly. Newlines are kept, so a PEM block
                      reads as a PEM block and not as one run-on line. */}
                  <code className="text-fg line-clamp-3 min-w-0 flex-1 font-mono text-sm leading-5 break-all whitespace-pre-wrap">
                    {displayed}
                  </code>
                </>
              ) : (
                <>
                  <span
                    aria-hidden="true"
                    className="text-fg-subtle min-w-0 flex-1 truncate font-mono text-sm leading-5 tracking-[0.14em] select-none"
                  >
                    {MASK}
                  </span>
                  {/* The mask is decorative; this is what the value "is" until
                      revealed. Eighteen bullets read aloud tell nobody
                      anything. */}
                  <span className="sr-only">
                    Value of {secretName} is hidden. Click to reveal and edit it.
                  </span>
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {problem !== null ? (
        <p id={messageId} className="text-danger-text text-sm leading-5">
          {problem}
        </p>
      ) : null}

      {/* Announced, not printed: a line of text appearing under one row pushes
          the sixty below it down, and the button already turned into a tick. */}
      <span role="status" className="sr-only">
        {copyState === 'copied' ? `Value of ${secretName} copied to the clipboard` : ''}
      </span>

      {revealError !== null ? (
        <p role="alert" className="text-danger-text text-sm leading-5">
          {revealError}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Which environment a field belongs to, while the row is comparing several.
 *
 * A fixed width, so the fields beside them start on one vertical line — the
 * whole point of stacking environments is reading down them, and a ragged left
 * edge is what makes that hard.
 */
export function EnvironmentLabel({
  environment,
  details = null,
}: {
  environment: { name: string; isProduction: boolean };
  /** The details control, sat next to the name it is about. */
  details?: ReactNode;
}) {
  return (
    <span className="flex w-28 shrink-0 items-center gap-0.5">
      <span
        className={cn(
          'inline-flex min-w-0 items-center gap-1.5 text-sm font-medium',
          environment.isProduction ? 'text-production-text' : 'text-fg-muted',
        )}
        title={environment.name}
      >
        {environment.isProduction ? (
          <span aria-hidden="true" className="bg-production size-1.5 shrink-0 rounded-full" />
        ) : null}
        <span className="truncate">{environment.name}</span>
      </span>
      {details}
    </span>
  );
}

/**
 * Everything said *about* this value: its note, and where it came from.
 *
 * ── Why the note lives here ──
 * A note is an annotation on a key, read about as often as its author is — which
 * is to say rarely, and never while scanning. As a field under the name it cost
 * every row a second line whether or not it had one. So it is shown on hover
 * over the key, and written here, in the one panel that already answers "tell me
 * about this".
 *
 * A popover and not a dropdown menu, because none of this is a *command*:
 * Radix's menu would render `role="menu"` around a description list with no
 * items in it, install roving focus over nothing, and swallow printable keys for
 * typeahead. And no tooltip on the trigger — a tooltip trigger writes its own
 * `data-state` onto the same element and would overwrite the popover's, which is
 * what the toolbar reads to stay visible while this is open. The note is on the
 * trigger's `title` instead, which is the one hover hint that survives there.
 */
function FieldDetails({
  secret,
  environmentName,
  note,
  onNoteChange,
  noteSaving,
  noteError,
  disabled,
}: {
  secret: SecretSummary;
  environmentName?: string | undefined;
  note: string | null;
  onNoteChange: (note: string | null) => void;
  noteSaving: boolean;
  noteError: string | null;
  disabled: boolean;
}) {
  const [editingNote, setEditingNote] = useState(false);
  const [draft, setDraft] = useState('');

  const hasNote = note !== null && note.length > 0;

  function beginNote() {
    setDraft(note ?? '');
    setEditingNote(true);
  }

  function saveNote() {
    const next = draft.trim();
    onNoteChange(next.length === 0 ? null : next);
    setEditingNote(false);
  }

  return (
    <Popover onOpenChange={(open) => (open ? undefined : setEditingNote(false))}>
      <PopoverTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className={cn('size-8 shrink-0', hasNote && 'text-accent-text')}
          title={hasNote ? note : 'Details'}
          aria-label={
            environmentName === undefined
              ? `Details and note for ${secret.name}`
              : `Details and note for ${secret.name} in ${environmentName}`
          }
        >
          <InfoIcon className="size-4.5" />
        </Button>
      </PopoverTrigger>

      {/* Radix gives this `role="dialog"`, and a dialog without a name is
          announced as "dialog" and nothing else. */}
      <PopoverContent
        align="start"
        className="w-72"
        aria-label={`Details and note for ${secret.name}`}
      >
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-fg text-sm font-medium">Note</h3>
          {editingNote ? null : (
            <Button
              variant="ghost"
              size="sm"
              className="h-7"
              onClick={beginNote}
              disabled={disabled}
              loading={noteSaving}
            >
              <PencilIcon className="size-3.5" />
              {hasNote ? 'Edit' : 'Add'}
            </Button>
          )}
        </div>

        {editingNote ? (
          <div className="mt-1.5 flex flex-col gap-1.5">
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={3}
              maxLength={NOTE_MAX_LENGTH}
              placeholder="What this key is for, who owns it, when it rotates."
              aria-label={`Note for ${secret.name}`}
              autoComplete="off"
              className="text-sm"
              autoFocus
            />
            <div className="flex items-center gap-1.5">
              {/* Disabled with everything else while a batch save is in flight:
                  the save writes the staged map back from a snapshot taken
                  before this note existed, so a note accepted here mid-save
                  would vanish without a word. */}
              <Button
                variant="primary"
                size="sm"
                className="h-7"
                onClick={saveNote}
                disabled={disabled}
              >
                Save note
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7"
                onClick={() => setEditingNote(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <p className={cn('mt-1 text-sm leading-5', hasNote ? 'text-fg-muted' : 'text-fg-subtle')}>
            {hasNote ? note : 'No note on this key.'}
          </p>
        )}

        {noteError !== null ? (
          <p role="alert" className="text-danger-text mt-1.5 text-sm leading-5">
            {noteError}
          </p>
        ) : null}

        <dl className="border-line-subtle mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 border-t pt-3 text-sm">
          {environmentName !== undefined ? (
            <>
              <dt className="text-fg-subtle">Environment</dt>
              <dd className="text-fg-muted">{environmentName}</dd>
            </>
          ) : null}

          <dt className="text-fg-subtle">Created</dt>
          <dd className="text-fg-muted">
            <time
              dateTime={toIsoString(secret.createdAt)}
              title={formatAbsoluteTime(secret.createdAt)}
            >
              {formatRelativeTime(secret.createdAt)}
            </time>
          </dd>

          <dt className="text-fg-subtle">Updated</dt>
          <dd className="text-fg-muted">
            <time
              dateTime={toIsoString(secret.updatedAt)}
              title={formatAbsoluteTime(secret.updatedAt)}
            >
              {formatRelativeTime(secret.updatedAt)}
            </time>
          </dd>

          <dt className="text-fg-subtle">Author</dt>
          <dd>
            <Actor userId={secret.createdBy} serviceTokenId={secret.createdByServiceTokenId} />
          </dd>

          <dt className="text-fg-subtle">Version</dt>
          <dd className="text-fg-muted">v{secret.version}</dd>
        </dl>

        {/* Said here because the author used to sit in a column beside a
            timestamp that means something else, and everybody read the two as
            one fact. */}
        <p className="text-fg-subtle border-line-subtle mt-2 border-t pt-2 text-sm leading-5">
          The author is who created this secret. Who wrote the current value is in its version
          history.
        </p>
      </PopoverContent>
    </Popover>
  );
}

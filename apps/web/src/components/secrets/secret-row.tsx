'use client';

import { useCallback, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { checkSecretValue, toSecretValueType } from '@xecret/core/validation';
import type { SecretValueType } from '@xecret/core/validation';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatAbsoluteTime, formatRelativeTime, toIsoString } from '@/lib/format';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
import {
  Badge,
  Button,
  Checkbox,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  MoreHorizontalIcon,
  PencilIcon,
  SecretValue,
  Spinner,
  TableCell,
  TableRow,
  Textarea,
} from '@/components/ui';
import { Actor } from './actor';
import type { PendingEdit } from './staged-changes';
import type { RevealedSecret, SecretSummary } from './types';
import { ValueTypeMenu } from './value-type-menu';

export interface SecretRowProps {
  orgSlug: string;
  projectSlug: string;
  envSlug: string;
  secret: SecretSummary;
  selected: boolean;
  /** Present while this row's value is being rewritten. */
  edit: PendingEdit | undefined;
  disabled: boolean;
  /** Plaintext held by a "Reveal all", which this row displays instead of a mask. */
  revealed?: string | undefined;
  onSelectedChange: (checked: boolean) => void;
  onEditOpen: () => void;
  onEditChange: (value: string) => void;
  onEditClose: () => void;
  onTypeChange: (type: SecretValueType) => void;
  onHistory: () => void;
  onDelete: () => void;
  /** Ctrl/Cmd+Enter anywhere in the editor commits the whole batch. */
  onCommit: () => void;
}

/**
 * One stored secret.
 *
 * ── Three rules this row exists to hold ──
 *
 *  1. **A stored value is never on screen until somebody asks for it.** The row
 *     renders a fixed-length mask whose length is unrelated to the real one,
 *     because length distinguishes a 16-character API key from a 64-character
 *     token and turns "unknown credential" into "AWS access key,
 *     brute-forceable offline at this cost".
 *  2. **A reveal always goes through the audited endpoint.** `SecretValue` calls
 *     `onReveal` on every reveal and every copy, and the callback below always
 *     issues `GET …/secrets/{name}`, which decrypts and writes a
 *     `secret.revealed` record each time. Caching the plaintext after the first
 *     reveal would make the audit trail claim one read where six happened — and
 *     "who read this, and when" is the question this product exists to answer.
 *  3. **Copy never renders.** The copy button fetches its own plaintext and
 *     writes it straight to the clipboard; the common case is pasting into a
 *     terminal, and showing it on the way there is exposure that buys nothing.
 *
 * ── Row geometry ──
 * Every cell is `align-middle` and the row carries a minimum height, so the
 * checkbox, the name, the value field, the version chip, the timestamp and the
 * menu all sit on one optical line. They used to be `align-top`, which looked
 * right only while every cell was one line tall — a secret with a note, or a
 * two-line value editor, dragged its neighbours to the ceiling and left the row
 * looking broken. The editor is the one cell allowed to grow, and it grows
 * downward from a centred baseline.
 *
 * ── Editing in place ──
 * The editor opens *empty*, and says so. It is not a text box containing the
 * current value with the cursor at the end, because filling it would mean
 * decrypting a secret because somebody clicked a pencil. Amending rather than
 * retyping is still one click away — "Load current value" runs the same audited
 * reveal as the eye button, and is recorded exactly like one.
 *
 * The name is read-only: the API appends versions to a name and has no rename,
 * because renaming a secret is indistinguishable from deleting one and creating
 * another to everything downstream that reads it.
 */
export function SecretRow({
  orgSlug,
  projectSlug,
  envSlug,
  secret,
  selected,
  edit,
  disabled,
  revealed,
  onSelectedChange,
  onEditOpen,
  onEditChange,
  onEditClose,
  onTypeChange,
  onHistory,
  onDelete,
  onCommit,
}: SecretRowProps) {
  const reveal = useCallback(async () => {
    const response = await api.get<RevealedSecret>(
      apiPath.secret(orgSlug, projectSlug, envSlug, secret.name),
    );
    return response.secret.value;
  }, [orgSlug, projectSlug, envSlug, secret.name]);

  const editing = edit !== undefined;
  const staged = editing && edit.value.length > 0;
  const valueType = toSecretValueType(secret.valueType);

  return (
    <TableRow
      className={cn(
        'h-14',
        staged && 'bg-warning-tint/40 hover:bg-warning-tint/50',
        staged && '[&>td:first-child]:border-l-warning [&>td:first-child]:border-l-2',
        !staged && selected && 'bg-accent-tint/40',
      )}
    >
      <TableCell className="pr-0 align-middle">
        <Checkbox
          checked={selected}
          onCheckedChange={(checked) => onSelectedChange(checked === true)}
          aria-label={`Select ${secret.name}`}
        />
      </TableCell>

      <TableCell className="align-middle">
        <span className="text-fg block font-mono text-[0.8125rem] font-medium break-all">
          {secret.name}
        </span>
        {secret.note ? (
          <span className="text-fg-subtle mt-0.5 block text-xs leading-5">{secret.note}</span>
        ) : null}
        {staged ? (
          <Badge tone="warning" className="mt-1">
            Unsaved
          </Badge>
        ) : null}
      </TableCell>

      <TableCell className="align-middle">
        {editing ? (
          <ValueEditor
            secret={secret}
            valueType={valueType}
            edit={edit}
            disabled={disabled}
            onReveal={reveal}
            onChange={onEditChange}
            onClose={onEditClose}
            onCommit={onCommit}
          />
        ) : (
          <SecretValue
            name={secret.name}
            onReveal={reveal}
            // Handed the plaintext a "Reveal all" already fetched and audited.
            // Without this the button would either re-fetch every row — six
            // audit records for one click — or show nothing.
            {...(revealed === undefined ? {} : { revealed })}
            trailing={
              <Button
                size="icon"
                variant="ghost"
                onClick={onEditOpen}
                disabled={disabled}
                aria-label={`Set a new value for ${secret.name}`}
              >
                <PencilIcon className="size-4" />
              </Button>
            }
          />
        )}
      </TableCell>

      <TableCell className="align-middle">
        <ValueTypeMenu
          value={secret.valueType}
          onChange={onTypeChange}
          disabled={disabled}
          secretName={secret.name}
        />
      </TableCell>

      <TableCell className="align-middle">
        <Badge tone="neutral">v{secret.version}</Badge>
      </TableCell>

      <TableCell className="text-fg-muted align-middle text-[0.8125rem] whitespace-nowrap">
        <time dateTime={toIsoString(secret.updatedAt)} title={formatAbsoluteTime(secret.updatedAt)}>
          {formatRelativeTime(secret.updatedAt)}
        </time>
      </TableCell>

      <TableCell className="align-middle text-[0.8125rem] whitespace-nowrap">
        <Actor userId={secret.createdBy} serviceTokenId={secret.createdByServiceTokenId} />
      </TableCell>

      <TableCell className="align-middle">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              // Every row's menu would otherwise be called "Actions", which is
              // useless in a list of sixty.
              aria-label={`Actions for ${secret.name}`}
            >
              <MoreHorizontalIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={onEditOpen} disabled={editing}>
              Set a new value
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onHistory}>Version history…</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onSelect={onDelete}>
              Delete…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}

function ValueEditor({
  secret,
  valueType,
  edit,
  disabled,
  onReveal,
  onChange,
  onClose,
  onCommit,
}: {
  secret: SecretSummary;
  valueType: SecretValueType;
  edit: PendingEdit;
  disabled: boolean;
  onReveal: () => Promise<string>;
  onChange: (value: string) => void;
  onClose: () => void;
  onCommit: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Checked as you type, against the same module the server checks against on
  // write. This copy exists so the failure arrives while the value is still on
  // screen and fixable; the server's copy is the one that is load-bearing.
  const shape = checkSecretValue(edit.value, valueType);
  const shapeProblem = shape.valid ? null : (shape.message ?? null);

  async function loadCurrent() {
    setLoadError(null);
    setLoading(true);
    try {
      onChange(await onReveal());
      setLoaded(true);
    } catch (cause) {
      setLoadError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      onCommit();
      return;
    }
    // Escape closes an editor the user has not typed into. Once there is a
    // value in it, Escape would throw away a credential they may have pasted
    // from somewhere they cannot easily get it again.
    if (event.key === 'Escape' && edit.value.length === 0) {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <div className="flex flex-col gap-1.5 py-1">
      <Textarea
        value={edit.value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled || loading}
        rows={2}
        placeholder={`New value for ${secret.name}`}
        aria-label={`New value for ${secret.name}`}
        aria-invalid={edit.error !== null || shapeProblem !== null ? true : undefined}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        className={cn(
          'py-1.5 font-mono text-[0.8125rem] leading-5',
          shapeProblem !== null && 'border-danger focus:border-danger focus:ring-danger/30',
        )}
        autoFocus
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-fg-subtle text-xs">
          Saving appends v{secret.version + 1}. The current value stays in the history.
        </span>

        {loaded ? (
          <span className="text-fg-subtle text-xs">Current value loaded · read recorded</span>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-xs"
            disabled={disabled || loading}
            onClick={loadCurrent}
          >
            {loading ? <Spinner className="size-3.5" label={null} /> : null}
            Load current value
          </Button>
        )}

        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-xs"
          disabled={disabled}
          onClick={onClose}
        >
          Cancel
        </Button>
      </div>

      {/* The live shape check first: it describes what is in the box now, while
          `edit.error` describes the last save attempt and may already be stale. */}
      {shapeProblem !== null ? (
        <p className="text-danger-text text-xs leading-5">{shapeProblem}</p>
      ) : edit.error !== null ? (
        <p className="text-danger-text text-xs leading-5">{edit.error}</p>
      ) : null}

      {loadError !== null ? (
        <p role="alert" className="text-danger-text text-xs leading-5">
          {loadError}
        </p>
      ) : null}
    </div>
  );
}

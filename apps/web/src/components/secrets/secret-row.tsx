'use client';

import { useCallback, useState } from 'react';
import type { KeyboardEvent } from 'react';

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
  PencilIcon,
  SecretValue,
  SettingsIcon,
  Spinner,
  TableCell,
  TableRow,
  Textarea,
} from '@/components/ui';
import { Actor } from './actor';
import type { PendingEdit } from './staged-changes';
import type { RevealedSecret, SecretSummary } from './types';

export interface SecretRowProps {
  orgSlug: string;
  projectSlug: string;
  envSlug: string;
  secret: SecretSummary;
  selected: boolean;
  /** Present while this row's value is being rewritten. */
  edit: PendingEdit | undefined;
  disabled: boolean;
  onSelectedChange: (checked: boolean) => void;
  onEditOpen: () => void;
  onEditChange: (value: string) => void;
  onEditClose: () => void;
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
  onSelectedChange,
  onEditOpen,
  onEditChange,
  onEditClose,
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

  return (
    <TableRow
      className={cn(
        staged && 'bg-warning-tint/40 hover:bg-warning-tint/50',
        staged && '[&>td:first-child]:border-l-warning [&>td:first-child]:border-l-2',
        !staged && selected && 'bg-accent-tint/40',
      )}
    >
      <TableCell className="pr-0 align-top">
        <Checkbox
          checked={selected}
          onCheckedChange={(checked) => onSelectedChange(checked === true)}
          aria-label={`Select ${secret.name}`}
          className="mt-1.5"
        />
      </TableCell>

      <TableCell className="align-top">
        <span className="text-fg block font-mono text-[0.8125rem] font-medium break-all">
          {secret.name}
        </span>
        {secret.note ? (
          <span className="text-fg-subtle mt-0.5 block text-xs leading-5">{secret.note}</span>
        ) : null}
        {staged ? (
          <Badge tone="warning" className="mt-1.5">
            Unsaved
          </Badge>
        ) : null}
      </TableCell>

      <TableCell className="align-top">
        {editing ? (
          <ValueEditor
            secret={secret}
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

      <TableCell className="align-top">
        <Badge tone="neutral">v{secret.version}</Badge>
      </TableCell>

      <TableCell className="text-fg-muted align-top text-[0.8125rem] whitespace-nowrap">
        <time dateTime={toIsoString(secret.updatedAt)} title={formatAbsoluteTime(secret.updatedAt)}>
          {formatRelativeTime(secret.updatedAt)}
        </time>
      </TableCell>

      <TableCell className="align-top text-[0.8125rem] whitespace-nowrap">
        <Actor userId={secret.createdBy} />
      </TableCell>

      <TableCell className="align-top">
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
              <SettingsIcon className="size-4" />
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
  edit,
  disabled,
  onReveal,
  onChange,
  onClose,
  onCommit,
}: {
  secret: SecretSummary;
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
    <div className="flex flex-col gap-1.5">
      <Textarea
        value={edit.value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled || loading}
        rows={2}
        placeholder={`New value for ${secret.name}`}
        aria-label={`New value for ${secret.name}`}
        aria-invalid={edit.error !== null ? true : undefined}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        className="py-1.5 font-mono text-[0.8125rem] leading-5"
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

      {edit.error !== null ? (
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

'use client';

import { useId, useState } from 'react';
import type { ReactNode } from 'react';

import { errorMessage } from '@/lib/api';
import { Alert } from './alert';
import { Badge } from './badge';
import { Button } from './button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog';
import { Input } from './input';
import { Label } from './label';

interface ConfirmDialogBaseProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Defaults to `danger`. Use `primary` for consequential but non-destructive
   *  actions — rotating a key, transferring ownership. */
  confirmVariant?: 'primary' | 'danger';
  /** Rejecting keeps the dialog open and shows the error inside it. */
  onConfirm: () => Promise<void> | void;
  /** Extra context — what will be deleted, how many secrets it holds. */
  children?: ReactNode;
}

export type ConfirmDialogProps = ConfirmDialogBaseProps &
  (
    | {
        /** Confirm and cancel. For anything reversible or low-stakes. */
        strength?: 'normal';
      }
    | {
        /**
         * The confirm button stays disabled until the user types
         * `confirmPhrase` exactly.
         */
        strength: 'production';
        confirmPhrase: string;
      }
  );

/**
 * A confirmation with two strengths.
 *
 * ── Why the strong one makes you type the name ──
 * A confirmation dialog with a button under the pointer is not a decision
 * point; it is a speed bump that regular users learn to clear without reading.
 * Anyone who has deleted the wrong thing has done it through a dialog they
 * "confirmed" reflexively.
 *
 * Typing the resource's name defeats that, because it cannot be satisfied by
 * muscle memory. It forces the user to read the name in the dialog, compare it
 * to the name in their head, and reproduce it. When those two disagree — which
 * is exactly the situation this guards against, `payments-staging` versus
 * `payments-production` — the mismatch surfaces before anything is destroyed
 * rather than after.
 *
 * The cost is real friction, so it is reserved for production. Applying it
 * everywhere would train the same reflex it exists to break.
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  const {
    open,
    onOpenChange,
    title,
    description,
    confirmLabel,
    cancelLabel = 'Cancel',
    confirmVariant = 'danger',
    onConfirm,
    children,
  } = props;

  const isProduction = props.strength === 'production';
  const confirmPhrase = isProduction ? props.confirmPhrase : null;

  const inputId = useId();
  const [typed, setTyped] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reopening must start from scratch. Leaving the previous phrase in the box
  // would let a second, different deletion inherit the first one's approval.
  //
  // Done during render rather than in an effect: React restarts the render
  // with the new state before anything is committed, so the dialog is never
  // painted holding the last decision's typed confirmation.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) {
      setTyped('');
      setError(null);
      setSubmitting(false);
    }
  }

  const phraseMatches = confirmPhrase === null || typed === confirmPhrase;

  async function handleConfirm() {
    if (!phraseMatches || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (cause) {
      setError(errorMessage(cause));
      setSubmitting(false);
    }
  }

  return (
    // Dismissal is ignored while the confirmed action is in flight, so a
    // stray Escape cannot leave the user unsure whether it went through.
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next);
      }}
    >
      <DialogContent
        // The action is irreversible, so it is not dismissible by a stray click
        // on the backdrop. Escape and Cancel still work — a modal you cannot
        // leave by keyboard is a trap.
        onPointerDownOutside={(event) => event.preventDefault()}
        className="max-w-md"
      >
        <DialogHeader>
          {isProduction ? (
            <Badge tone="production" className="mb-1 self-start">
              Production
            </Badge>
          ) : null}
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {(children || confirmPhrase !== null || error) && (
          <DialogBody className="flex flex-col gap-4">
            {children}

            {confirmPhrase !== null ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={inputId}>
                  Type <span className="text-fg font-mono font-semibold">{confirmPhrase}</span> to
                  confirm
                </Label>
                <Input
                  id={inputId}
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  // Every assistant that could complete this for the user is
                  // turned off; the typing is the point.
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  className="font-mono"
                  aria-describedby={`${inputId}-hint`}
                />
                <p id={`${inputId}-hint`} className="text-fg-subtle text-xs">
                  Case-sensitive, and must match exactly.
                </p>
              </div>
            ) : null}

            {error ? <Alert tone="danger">{error}</Alert> : null}
          </DialogBody>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            {cancelLabel}
          </Button>
          <Button
            variant={confirmVariant}
            onClick={handleConfirm}
            loading={submitting}
            disabled={!phraseMatches}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

'use client';

import { createContext, use, useId } from 'react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';
import { Label } from './label';

/**
 * The wiring a labelled form control needs, published to whichever control is
 * rendered as this field's child.
 *
 * Passing it through context rather than cloning children means a control can
 * be wrapped, composed, or swapped without the field losing track of it — and
 * a control used outside a `Field` still works, it just receives nothing.
 */
interface FieldContextValue {
  controlId: string;
  describedBy: string | undefined;
  invalid: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

/**
 * Props a control should spread onto its own element.
 *
 * Controls call this so `aria-describedby` and `aria-invalid` are attached
 * exactly once, by the element that owns them. Building those attributes at
 * each call site is how a form ends up with an error message that is displayed
 * but never announced.
 */
export function useFieldControl(): Partial<{
  id: string;
  'aria-describedby': string;
  'aria-invalid': true;
}> {
  const field = use(FieldContext);
  if (!field) return {};

  const props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: true } = {
    id: field.controlId,
  };
  if (field.describedBy !== undefined) props['aria-describedby'] = field.describedBy;
  if (field.invalid) props['aria-invalid'] = true;
  return props;
}

export interface FieldProps {
  label: ReactNode;
  children: ReactNode;
  /** Guidance shown before the user has done anything wrong. */
  hint?: ReactNode;
  /** Present means invalid. The control is marked and the message announced. */
  error?: string | null | undefined;
  /**
   * Marks the field as optional rather than marking every other field as
   * required. Asterisks need a legend explaining them, and in these forms the
   * optional field is the exception — so it is the one worth labelling.
   */
  optional?: boolean;
  className?: string;
}

export function Field({ label, children, hint, error, optional, className }: FieldProps) {
  const reactId = useId();
  const controlId = `${reactId}-control`;
  const hintId = `${reactId}-hint`;
  const errorId = `${reactId}-error`;

  const hasError = typeof error === 'string' && error.length > 0;

  // The error is listed first so a screen reader reads the problem before the
  // guidance. Someone re-focusing a rejected field wants "must be unique",
  // not thirty words of help text ending in "must be unique".
  const describedBy =
    [hasError ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined;

  return (
    <FieldContext value={{ controlId, describedBy, invalid: hasError }}>
      <div className={cn('flex flex-col gap-1.5', className)}>
        <div className="flex items-baseline justify-between gap-3">
          <Label htmlFor={controlId}>{label}</Label>
          {optional ? <span className="text-fg-subtle text-sm">Optional</span> : null}
        </div>

        {children}

        {hasError ? (
          // Not `role="alert"`: validation errors normally appear on submit,
          // when focus is moved to the offending control anyway, and the
          // `aria-describedby` association reads them at that moment.
          // Interrupting for every field in a failed form is unusable.
          <p id={errorId} className="text-danger-text text-sm leading-5">
            {error}
          </p>
        ) : null}

        {hint ? (
          <p id={hintId} className="text-fg-subtle text-sm leading-5">
            {hint}
          </p>
        ) : null}
      </div>
    </FieldContext>
  );
}

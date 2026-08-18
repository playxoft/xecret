'use client';

import { Slot } from '@radix-ui/react-slot';
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';

import { cn } from '@/lib/cn';
import { Spinner } from './spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

const BASE =
  'relative inline-flex shrink-0 items-center justify-center gap-2 rounded-md border font-medium ' +
  'whitespace-nowrap transition-[background-color,border-color,color] duration-150 ' +
  'disabled:pointer-events-none disabled:opacity-55 ' +
  // No `outline-none` here, deliberately: Tailwind's utilities layer outranks
  // the `:focus-visible` rule in globals.css, so adding it would delete the
  // keyboard focus ring on every button in the product.
  'select-none';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'border-transparent bg-accent text-accent-fg hover:bg-accent-hover',
  secondary: 'border-line bg-surface text-fg hover:bg-surface-hover hover:border-line-strong',
  ghost: 'border-transparent bg-transparent text-fg-muted hover:bg-surface-hover hover:text-fg',
  danger: 'border-transparent bg-danger text-danger-fg hover:bg-danger-hover',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-sm',
  md: 'h-9 px-3.5 text-sm',
  lg: 'h-11 px-5 text-[0.9375rem]',
  icon: 'size-9 p-0 text-base',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /**
   * Replaces the label with a spinner while keeping the button's exact width,
   * and blocks further clicks. Widths are preserved because a button that
   * shrinks to "⟳" on submit drags the whole form up under the pointer, and
   * the next click lands on whatever moved into its place.
   */
  loading?: boolean;
  /** Renders the child element instead of a `<button>` — for link-shaped actions. */
  asChild?: boolean;
  ref?: Ref<HTMLButtonElement>;
  children?: ReactNode;
}

/**
 * React 19 passes `ref` as an ordinary prop to function components, so
 * `forwardRef` is no longer needed to forward one. The ref still reaches the
 * underlying `<button>`, which is what dialogs and tooltips need in order to
 * restore or anchor focus.
 */
export function Button({
  className,
  variant = 'secondary',
  size = 'md',
  loading = false,
  asChild = false,
  disabled,
  children,
  type,
  ref,
  ...props
}: ButtonProps) {
  const classes = cn(BASE, VARIANTS[variant], SIZES[size], className);

  if (asChild) {
    return (
      <Slot className={classes} ref={ref} {...props}>
        {children}
      </Slot>
    );
  }

  return (
    <button
      // Buttons inside a form default to `submit`, which turns every unlabelled
      // icon button in a form into an accidental submit.
      type={type ?? 'button'}
      className={classes}
      ref={ref}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {/* The label keeps its box while hidden, so the button cannot change size. */}
      <span className={cn('inline-flex items-center gap-2', loading && 'invisible')}>
        {children}
      </span>
      {loading ? (
        <span className="absolute inset-0 grid place-items-center">
          <Spinner className="size-[1.1em]" label={null} />
        </span>
      ) : null}
    </button>
  );
}

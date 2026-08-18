'use client';

import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';
import { AlertCircleIcon, AlertTriangleIcon, CheckCircleIcon, CloseIcon, InfoIcon } from './icons';

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

export interface ToastOptions {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** Milliseconds on screen. `0` keeps it until dismissed. */
  duration?: number;
}

interface ToastRecord extends ToastOptions {
  id: number;
  variant: ToastVariant;
  duration: number;
}

interface ToastApi {
  toast: (options: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Beyond this the stack stops being readable and starts being a wall. */
const MAX_VISIBLE = 4;
const DEFAULT_DURATION = 5000;
const ERROR_DURATION = 8000;

const VARIANTS: Record<ToastVariant, { icon: string; Icon: typeof InfoIcon }> = {
  info: { icon: 'text-fg-muted', Icon: InfoIcon },
  success: { icon: 'text-success-text', Icon: CheckCircleIcon },
  warning: { icon: 'text-warning-text', Icon: AlertTriangleIcon },
  error: { icon: 'text-danger-text', Icon: AlertCircleIcon },
};

/**
 * Transient notifications.
 *
 * Mount once at the root; `useToast()` reaches it from anywhere below.
 *
 * ── Why the region is `aria-live="polite"` and never `assertive` ──
 * An assertive live region interrupts whatever a screen reader is currently
 * reading. Toasts are, by construction, information the user can afford to
 * miss — they disappear on a timer. Something that genuinely must be heard now
 * ("this deletion failed") belongs in an inline `<Alert tone="danger">` beside
 * the control that failed, where it also stays on screen long enough to read.
 *
 * The region exists in the DOM from first render, empty. Assistive technology
 * only announces insertions into a live region it was already observing, so a
 * region created at the same moment as its first message is silent.
 */
export function Toaster({ children }: { children?: ReactNode }) {
  const [toasts, setToasts] = useState<readonly ToastRecord[]>([]);
  const nextId = useRef(1);
  const timers = useRef(
    new Map<number, { handle: ReturnType<typeof setTimeout>; endsAt: number }>(),
  );
  const remaining = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer.handle);
      timers.current.delete(id);
    }
    remaining.current.delete(id);
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const schedule = useCallback(
    (id: number, ms: number) => {
      if (ms <= 0) return;
      const handle = setTimeout(() => dismiss(id), ms);
      timers.current.set(id, { handle, endsAt: Date.now() + ms });
    },
    [dismiss],
  );

  const toast = useCallback(
    (options: ToastOptions): number => {
      const id = nextId.current++;
      const variant = options.variant ?? 'info';
      const record: ToastRecord = {
        ...options,
        id,
        variant,
        duration: options.duration ?? (variant === 'error' ? ERROR_DURATION : DEFAULT_DURATION),
      };

      setToasts((current) => [...current, record].slice(-MAX_VISIBLE));
      schedule(id, record.duration);
      return id;
    },
    [schedule],
  );

  // Hovering or focusing the stack freezes every countdown. Without this, a
  // toast carrying a request id vanishes while the user is still reading it.
  const pause = useCallback(() => {
    const now = Date.now();
    for (const [id, timer] of timers.current) {
      clearTimeout(timer.handle);
      remaining.current.set(id, Math.max(timer.endsAt - now, 250));
    }
    timers.current.clear();
  }, []);

  const resume = useCallback(() => {
    for (const [id, ms] of remaining.current) schedule(id, ms);
    remaining.current.clear();
  }, [schedule]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer.handle);
      pending.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext value={api}>
      {children}
      <div
        role="region"
        aria-label="Notifications"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:items-end"
        onMouseEnter={pause}
        onMouseLeave={resume}
        onFocusCapture={pause}
        onBlurCapture={resume}
      >
        {toasts.map((item) => {
          const { Icon, icon } = VARIANTS[item.variant];
          return (
            <div
              key={item.id}
              className={cn(
                'border-line bg-surface shadow-overlay pointer-events-auto flex w-full max-w-sm gap-3 rounded-lg border p-3',
                'animate-[toast-in_160ms_cubic-bezier(0.16,1,0.3,1)]',
              )}
            >
              <Icon className={cn('mt-px size-[1.15em] shrink-0', icon)} />
              <div className="min-w-0 flex-1">
                <p className="text-fg text-sm leading-5 font-medium">{item.title}</p>
                {item.description ? (
                  <p className="text-fg-muted mt-0.5 text-sm leading-5 break-words">
                    {item.description}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => dismiss(item.id)}
                aria-label={`Dismiss: ${item.title}`}
                className="text-fg-subtle hover:bg-surface-hover hover:text-fg -mt-0.5 -mr-0.5 grid size-6 shrink-0 place-items-center rounded-md transition-colors"
              >
                <CloseIcon className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext>
  );
}

/**
 * Throws outside a `Toaster` rather than silently doing nothing — a swallowed
 * "Secret updated" is a bug that only shows up in production.
 */
export function useToast(): ToastApi {
  const api = use(ToastContext);
  if (!api) throw new Error('useToast must be used inside <Toaster>.');
  return api;
}

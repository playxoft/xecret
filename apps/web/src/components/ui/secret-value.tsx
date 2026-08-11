'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/cn';
import { errorMessage } from '@/lib/api';
import { Button } from './button';
import { CheckIcon, CopyIcon, EyeIcon, EyeOffIcon } from './icons';
import { Spinner } from './spinner';

/**
 * A masked secret with an explicit reveal.
 *
 * Every behaviour below is a security decision, not a styling one. Changing
 * any of them changes what an over-the-shoulder observer, a screen recording,
 * or the audit log can see.
 */
export interface SecretValueProps {
  /** The secret's name. Used to build accessible labels for the controls. */
  name: string;
  /**
   * Resolves the plaintext.
   *
   * Called on **every** reveal and on **every** copy — never memoised here.
   * Each call is expected to hit `GET …/secrets/{name}`, which is the one
   * handler that decrypts and which writes a `secret.revealed` audit record
   * each time. Caching the value locally would make the audit trail claim one
   * decryption where the user performed six, and "who read this, and when" is
   * the question this product exists to answer.
   */
  onReveal: () => Promise<string>;
  /** How long a revealed value stays on screen. */
  revealDurationMs?: number;
  className?: string;
}

/**
 * The mask is a fixed length, deliberately unrelated to the real one.
 *
 * Rendering one dot per character leaks the secret's length to anyone who can
 * see the screen — and length is a genuine reduction in search space: it
 * distinguishes a 16-character API key from a 64-character token, tells an
 * attacker which service issued it, and turns "unknown credential" into
 * "AWS access key, brute-forceable offline at this cost".
 */
const MASK = '•'.repeat(18);

type RevealState = 'masked' | 'loading' | 'revealed';

export function SecretValue({
  name,
  onReveal,
  revealDurationMs = 30_000,
  className,
}: SecretValueProps) {
  const [state, setState] = useState<RevealState>('masked');
  const [value, setValue] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied'>('idle');
  const [error, setError] = useState<string | null>(null);

  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const remask = useCallback(() => {
    setState('masked');
    // Dropping the plaintext from state is the point: it must not survive in
    // a React fibre for the rest of the page's life, where the next error
    // boundary or dev-tools inspection would surface it.
    setValue(null);
    setSecondsLeft(0);
  }, []);

  const reveal = useCallback(async () => {
    setError(null);
    setState('loading');
    try {
      const plaintext = await onReveal();
      setValue(plaintext);
      setState('revealed');
      setSecondsLeft(Math.ceil(revealDurationMs / 1000));
    } catch (cause) {
      setState('masked');
      setError(errorMessage(cause));
    }
  }, [onReveal, revealDurationMs]);

  const copy = useCallback(async () => {
    setError(null);
    setCopyState('copying');
    try {
      // Copy fetches its own plaintext and writes it straight to the
      // clipboard. It never sets `value`, so copying a secret never puts it on
      // screen — the common case is pasting into a terminal, and displaying it
      // on the way there is pure additional exposure.
      const plaintext = await onReveal();
      await navigator.clipboard.writeText(plaintext);
      setCopyState('copied');
      copyResetTimer.current = setTimeout(() => setCopyState('idle'), 2000);
    } catch (cause) {
      setCopyState('idle');
      setError(
        cause instanceof DOMException
          ? 'Your browser blocked clipboard access. Reveal the value and copy it manually.'
          : errorMessage(cause),
      );
    }
  }, [onReveal]);

  // Auto-remask. A revealed secret left on screen is a secret in every
  // subsequent screenshot, screen share, and shoulder-surf.
  useEffect(() => {
    if (state !== 'revealed') return;

    // The remask is its own timeout rather than a side effect inside the
    // counter's updater: state updaters must stay pure, and hanging the
    // security-relevant behaviour off a once-per-second tick would let a
    // throttled background tab hold the value on screen indefinitely.
    const hideAt = setTimeout(remask, revealDurationMs);
    const tick = setInterval(() => setSecondsLeft((current) => Math.max(current - 1, 0)), 1000);

    return () => {
      clearTimeout(hideAt);
      clearInterval(tick);
    };
  }, [state, remask, revealDurationMs]);

  // Remask the moment the tab is hidden or the window loses focus: switching
  // to a call, or starting a screen share, must not leave the value visible in
  // a background tab that gets restored later.
  useEffect(() => {
    if (state !== 'revealed') return;

    const hide = () => remask();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') hide();
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', hide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', hide);
    };
  }, [state, remask]);

  useEffect(
    () => () => {
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    },
    [],
  );

  const revealed = state === 'revealed' && value !== null;

  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <div className="flex min-w-0 items-center gap-1.5">
        <div className="border-line bg-canvas-inset min-w-0 flex-1 rounded-md border px-2.5 py-1.5">
          {revealed ? (
            <code className="text-fg block font-mono text-[0.8125rem] leading-5 break-all">
              {value}
            </code>
          ) : (
            <>
              <span
                aria-hidden="true"
                className="text-fg-subtle block font-mono text-[0.8125rem] leading-5 tracking-[0.14em] select-none"
              >
                {MASK}
              </span>
              {/* The mask is decorative; this is what the value "is" until
                  revealed. Reading eighteen bullet characters aloud tells a
                  screen reader user nothing. */}
              <span className="sr-only">Value hidden</span>
            </>
          )}
        </div>

        <Button
          size="icon"
          variant="ghost"
          onClick={revealed ? remask : reveal}
          disabled={state === 'loading'}
          aria-pressed={revealed}
          aria-label={revealed ? `Hide the value of ${name}` : `Reveal the value of ${name}`}
        >
          {state === 'loading' ? (
            <Spinner className="size-4" label={null} />
          ) : revealed ? (
            <EyeOffIcon className="size-4" />
          ) : (
            <EyeIcon className="size-4" />
          )}
        </Button>

        <Button
          size="icon"
          variant="ghost"
          onClick={copy}
          disabled={copyState === 'copying'}
          aria-label={`Copy the value of ${name} to the clipboard`}
        >
          {copyState === 'copied' ? (
            <CheckIcon className="text-success-text size-4" />
          ) : copyState === 'copying' ? (
            <Spinner className="size-4" label={null} />
          ) : (
            <CopyIcon className="size-4" />
          )}
        </Button>
      </div>

      {revealed ? (
        <p className="text-fg-subtle text-xs">
          Hides in {secondsLeft}s · this read was recorded in the audit log
        </p>
      ) : null}

      {copyState === 'copied' ? (
        // Announced politely so the user knows the clipboard write succeeded
        // without the value itself ever being spoken.
        <p role="status" className="text-success-text text-xs">
          Copied to the clipboard
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-danger-text text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}

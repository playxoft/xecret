'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';
import { errorMessage } from '@/lib/api';
import { Button } from './button';
import { CheckIcon, CopyIcon, EyeIcon, EyeOffIcon } from './icons';
import { Spinner } from './spinner';

/**
 * A masked secret with an explicit reveal.
 *
 * ── Masking and forgetting are two different things ──
 * A reveal decrypts once and the plaintext is then held, in React state only,
 * for `revealDurationMs`. Inside that window the value can be masked and shown
 * again for free: hiding it is a *display* decision, and nothing about the eye
 * button or a backgrounded tab warrants a second decryption of the same secret.
 * When the window ends the plaintext is dropped outright, and the next reveal is
 * a fresh audited request.
 *
 * The consequence is deliberate and worth stating plainly: within the window,
 * re-revealing writes no new `secret.revealed` record. The audit log answers
 * "who decrypted this, and when", not "how many times did they look at their own
 * screen" — the second question was never answerable anyway, since a revealed
 * value can be read for as long as it is on screen.
 *
 * ── What still forces a round trip ──
 * The first reveal after mount, and every reveal after the window ends. Copy
 * fetches its own plaintext when the cache is empty, and never fills it: the
 * clipboard path is not a reveal, and should not quietly license one.
 */
export interface SecretValueProps {
  /** The secret's name. Used to build accessible labels for the controls. */
  name: string;
  /**
   * Resolves the plaintext.
   *
   * Expected to hit `GET …/secrets/{name}`, which is the one handler that
   * decrypts and which writes a `secret.revealed` audit record each time. It is
   * called on the first reveal and on any reveal after the cache window has
   * ended — see the header for what that window does and does not promise.
   */
  onReveal: () => Promise<string>;
  /** How long a decrypted value is held before it is dropped from state. */
  revealDurationMs?: number;
  /**
   * A plaintext the caller has *already* fetched and had audited.
   *
   * Set by "Reveal all" and by "Reveal on hover", both of which decrypt a whole
   * environment in one audited request. Without it those controls would have to
   * either re-fetch each row — turning one deliberate act into sixty audit
   * records — or bypass this component and render the value themselves, which
   * would put an unmasked secret on screen with none of the handling below.
   *
   * Clearing it returns the field to a mask.
   */
  revealed?: string;
  /**
   * Extra controls for this value, rendered in the same group as reveal and
   * copy — an edit button, usually.
   *
   * A slot rather than a sibling rendered by the caller, because the caller
   * cannot align to a group it is outside of: the reveal and copy buttons sit
   * on the first line of a component that also renders errors beneath them, so
   * anything appended from outside lands under the field instead of beside it.
   */
  trailing?: ReactNode;
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

export function SecretValue({
  name,
  onReveal,
  revealDurationMs = 180_000,
  revealed: external,
  trailing,
  className,
}: SecretValueProps) {
  const [value, setValue] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [loading, setLoading] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied'>('idle');
  const [error, setError] = useState<string | null>(null);

  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Hide it, keep it. Cheap, and reversible without another decryption. */
  const mask = useCallback(() => setShown(false), []);

  /**
   * Hide it and drop it. The plaintext must not survive in a React fibre for
   * the rest of the page's life, where the next error boundary or dev-tools
   * inspection would surface it.
   */
  const forget = useCallback(() => {
    setShown(false);
    setValue(null);
  }, []);

  const reveal = useCallback(async () => {
    setError(null);

    // Still inside the window: show what is already here rather than decrypting
    // the same secret a second time.
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
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [onReveal, value]);

  const copy = useCallback(async () => {
    setError(null);
    setCopyState('copying');
    try {
      // Copy writes straight to the clipboard and never sets `value`, so
      // copying a secret never puts it on screen and never starts a cache
      // window — the common case is pasting into a terminal, and displaying it
      // on the way there is pure additional exposure.
      const plaintext = value ?? (await onReveal());
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
  }, [onReveal, value]);

  // The end of the window, counted from the decryption rather than from the
  // last time the value happened to be on screen: masking and unmasking must
  // not be able to extend how long a plaintext lives in memory.
  useEffect(() => {
    if (value === null) return;

    const forgetAt = setTimeout(forget, revealDurationMs);
    return () => clearTimeout(forgetAt);
  }, [value, forget, revealDurationMs]);

  // Mask the moment the tab is hidden: starting a screen share or switching to
  // a call must not leave the value visible in a background tab that gets
  // restored later. Only `visibilitychange` — a `blur` listener also fires for
  // clicking into devtools, a second monitor, or another window, which is
  // ordinary work rather than a moment of exposure.
  useEffect(() => {
    if (!shown) return;

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') mask();
    };

    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [shown, mask]);

  useEffect(
    () => () => {
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    },
    [],
  );

  // A value supplied from outside wins over local state, so clearing "Reveal
  // all" re-masks every row at once rather than leaving behind whichever ones
  // had also been revealed individually.
  const displayed = external ?? (shown ? value : null);
  const isRevealed = displayed !== null;

  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <div className="flex min-w-0 items-center gap-1.5">
        <div className="border-line bg-canvas-inset min-w-0 flex-1 rounded-md border px-2.5 py-1.5">
          {isRevealed ? (
            <code className="text-fg block font-mono text-sm leading-5 break-all">{displayed}</code>
          ) : (
            <>
              <span
                aria-hidden="true"
                className="text-fg-subtle block font-mono text-sm leading-5 tracking-[0.14em] select-none"
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
          onClick={isRevealed ? mask : reveal}
          // An externally-supplied value is cleared by the control that supplied
          // it, so this row's own toggle has nothing to do.
          disabled={loading || external !== undefined}
          aria-pressed={isRevealed}
          aria-label={isRevealed ? `Hide the value of ${name}` : `Reveal the value of ${name}`}
        >
          {loading ? (
            <Spinner className="size-4" label={null} />
          ) : isRevealed ? (
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

        {trailing}
      </div>

      {copyState === 'copied' ? (
        // Announced politely so the user knows the clipboard write succeeded
        // without the value itself ever being spoken.
        <p role="status" className="text-success-text text-sm">
          Copied to the clipboard
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-danger-text text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}

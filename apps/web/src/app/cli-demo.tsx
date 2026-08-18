'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';

import { cn } from '@/lib/cn';
import { TerminalIcon } from '@/components/ui/icons';

/**
 * The landing page's CLI demo: the golden path, animated.
 *
 * Every non-child line below is the CLI's real output, copied from the
 * format strings in `cli/cmd/xecret` — when those change, this transcript
 * must change with them, because a demo that shows output the tool does not
 * produce is a small lie on the one page that must not contain any. The two
 * dimmed lines after `run` are the *child process* speaking (npm's own
 * banner), which is the point of the feature: the app runs untouched, secrets
 * already in its environment.
 *
 * Honest limitation, recorded here and in the phase report: this is a typed
 * re-enactment, not an asciinema recording — there is no deployed server to
 * record against yet. The animation types only; nothing here executes.
 *
 * Reduced motion is a first-class path, not a degradation: the full
 * transcript renders immediately, and the type-out never starts.
 */

type Line =
  | { kind: 'command'; text: string }
  | { kind: 'success'; text: string }
  | { kind: 'info'; text: string }
  | { kind: 'child'; text: string }
  | { kind: 'blank' };

const SCRIPT: readonly Line[] = [
  { kind: 'command', text: 'xecret login' },
  { kind: 'info', text: 'Opening your browser to approve this device…' },
  { kind: 'success', text: 'Signed in as dev@acme.dev (organisation acme)' },
  { kind: 'blank' },
  { kind: 'command', text: 'xecret init' },
  { kind: 'success', text: 'Wrote .xecret.yaml — project storefront, environment development.' },
  { kind: 'info', text: 'The file holds slugs only, never secrets; commit it.' },
  { kind: 'blank' },
  { kind: 'command', text: 'xecret run -- npm run dev' },
  { kind: 'child', text: '> storefront@0.4.2 dev' },
  { kind: 'child', text: 'ready — http://localhost:3000' },
];

const TICK_MS = 45;
/** Ticks a finished command or an output line stays current before the next. */
const DWELL_TICKS = 8;

interface Progress {
  /** Lines fully shown. */
  line: number;
  /** Ticks spent on the current line — characters typed, then dwell. */
  ticks: number;
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function subscribeReducedMotion(callback: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener('change', callback);
  return () => query.removeEventListener('change', callback);
}

export function CliDemo({ className }: { className?: string }) {
  // The server snapshot says "reduced", so prerendering — and any visitor
  // without JavaScript — gets the complete transcript rather than an empty
  // terminal waiting for an animation that will never run.
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => true,
  );
  const [progress, setProgress] = useState<Progress>({ line: 0, ticks: 0 });

  const animating = !reducedMotion;
  const finished = progress.line >= SCRIPT.length;

  useEffect(() => {
    if (!animating || finished) return;

    const timer = setInterval(() => {
      setProgress((current) => {
        const line = SCRIPT[current.line];
        if (line === undefined) return current;

        const lifetime =
          line.kind === 'command'
            ? line.text.length + DWELL_TICKS
            : line.kind === 'blank'
              ? 1
              : DWELL_TICKS;

        if (current.ticks < lifetime) {
          return { line: current.line, ticks: current.ticks + 1 };
        }
        return { line: current.line + 1, ticks: 0 };
      });
    }, TICK_MS);

    return () => clearInterval(timer);
  }, [animating, finished]);

  // Until the media query has answered, and whenever motion is reduced, the
  // whole transcript is shown — the animated version is the optional extra.
  const visibleCount = animating ? progress.line : SCRIPT.length;
  const done = visibleCount >= SCRIPT.length;

  return (
    // Placement is the caller's: this sits under the copy on a narrow screen
    // and beside it on a wide one, and a margin baked in here would be wrong
    // in one of those two.
    <div
      className={cn(
        'border-line bg-surface shadow-raised overflow-hidden rounded-xl border',
        className,
      )}
    >
      <div className="border-line-subtle bg-canvas-inset text-fg-subtle flex items-center gap-2 border-b px-3 py-2 text-sm">
        <TerminalIcon className="size-3.5" />
        the golden path
        <span className="text-fg-disabled ml-auto">typed from the CLI&apos;s real output</span>
      </div>

      <div
        aria-label="Terminal transcript: xecret login, xecret init, then xecret run"
        className="flex min-h-[16.5rem] flex-col gap-0.5 px-4 py-3.5 font-mono text-sm leading-6"
      >
        {SCRIPT.slice(0, visibleCount).map((line, index) => (
          <TranscriptLine key={index} line={line} partial={null} />
        ))}
        {animating && !done && SCRIPT[progress.line] !== undefined ? (
          <TranscriptLine line={SCRIPT[progress.line] as Line} partial={progress.ticks} />
        ) : null}
      </div>
    </div>
  );
}

function TranscriptLine({ line, partial }: { line: Line; partial: number | null }) {
  if (line.kind === 'blank') return <span aria-hidden="true">&nbsp;</span>;

  if (line.kind === 'command') {
    const text = partial === null ? line.text : line.text.slice(0, partial);
    return (
      <span className="text-fg break-all">
        <span className="text-fg-subtle select-none">$ </span>
        {text}
        {partial !== null ? (
          <span
            aria-hidden="true"
            className="bg-fg-muted ml-px inline-block h-[1.1em] w-[0.55em] translate-y-[0.2em]"
          />
        ) : null}
      </span>
    );
  }

  // Non-command lines appear whole once their dwell begins; a cursor mid-word
  // would claim they were typed by the user, which they were not.
  if (partial === 0) return null;

  if (line.kind === 'success') {
    return (
      <span className="text-fg-muted">
        <span className="text-success-text">✓ </span>
        {line.text}
      </span>
    );
  }
  if (line.kind === 'child') {
    return <span className="text-fg-subtle">{line.text}</span>;
  }
  return <span className="text-fg-muted">{line.text}</span>;
}

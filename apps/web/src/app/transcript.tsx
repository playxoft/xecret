'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';

import { cn } from '@/lib/cn';
import { CopyButton } from '@/components/ui/copy-button';

/**
 * The terminal transcript: the type-out engine and the line renderer, shared
 * by the hero's `CliDemo` and the landing page's `InstallGuide`.
 *
 * These were two copies of the same 150 lines — the same `Line` union, the
 * same `setInterval` reducer, the same cursor span down to its
 * `h-[1.1em] w-[0.55em]`, and the same off-by-a-line `min-h` arithmetic. Two
 * copies of a dwell model is two places to fix the next thing wrong with it,
 * and they had already drifted: one grew a copy gutter and two extra line
 * kinds, the other did not.
 *
 * ── The standing rule for callers ──
 * Every line that is not a command must be the real output of the thing being
 * demonstrated, copied from the source that prints it. A transcript showing
 * output the tool does not produce is a small lie on the pages whose whole
 * argument is that we tell you the truth. Only the values — an organisation, an
 * email, a version — are illustrative.
 */

export type Line =
  | { kind: 'command'; text: string }
  | { kind: 'success'; text: string }
  | { kind: 'info'; text: string }
  | { kind: 'comment'; text: string }
  /** The *child process* speaking — npm's own banner under `xecret run`. */
  | { kind: 'child'; text: string }
  /** A file being shown rather than a session — the Dockerfile. */
  | { kind: 'file'; text: string }
  | { kind: 'blank' };

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function subscribeReducedMotion(callback: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener('change', callback);
  return () => query.removeEventListener('change', callback);
}

/**
 * Does this reader want motion?
 *
 * The server snapshot says "reduced", so prerendering — and any visitor
 * without JavaScript — gets the complete transcript rather than an empty
 * terminal waiting for an animation that will never run.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => true,
  );
}

interface Progress {
  /** Lines fully shown. */
  line: number;
  /** Ticks spent on the current line — characters typed, then dwell. */
  ticks: number;
}

export interface TypeOutOptions {
  /** Milliseconds per typed character. */
  tickMs: number;
  /** Ticks a finished command or an output line stays current before the next. */
  dwellTicks: number;
  /**
   * Whether this run is a type-out at all. `false` prints the whole transcript
   * immediately, which is the answer for reduced motion and for any panel the
   * reader has already been shown in full.
   *
   * This is the flag that decides *what is on screen*, so it must be settled
   * by the first render after hydration and never flipped afterwards: going
   * `false → true` empties a transcript the reader is looking at, and
   * `true → false` fills one mid-type.
   */
  enabled: boolean;
  /**
   * Whether the clock is running. Separate from `enabled` because a panel far
   * down the page should render empty from hydration — so there is nothing to
   * wipe — and only *start typing* once it has been scrolled to. Defaults to
   * `enabled`.
   */
  running?: boolean;
}

export interface TypeOut {
  /** Lines to print whole. */
  visibleCount: number;
  /**
   * Ticks spent on the line at `visibleCount`, or `null` when nothing is
   * mid-type — either because the run is finished or because it never started.
   */
  partial: number | null;
}

/**
 * Advance a transcript one character at a time.
 *
 * Progress resets whenever `script` changes identity, which is what makes tab
 * switching replay from the top: the reader picked that tab to watch *this*
 * install happen, not to arrive at its last frame.
 */
export function useTypeOut(script: readonly Line[], options: TypeOutOptions): TypeOut {
  const { tickMs, dwellTicks, enabled } = options;
  const running = options.running ?? enabled;
  const [progress, setProgress] = useState<Progress>({ line: 0, ticks: 0 });

  // Keyed on the script so a caller does not have to remember to reset. The
  // state update during render is React's own documented way to derive state
  // from a changed prop, and it costs one extra render of this component
  // rather than an effect and a painted frame of the wrong transcript.
  const [seenScript, setSeenScript] = useState(script);
  if (seenScript !== script) {
    setSeenScript(script);
    setProgress({ line: 0, ticks: 0 });
  }

  const finished = progress.line >= script.length;

  useEffect(() => {
    if (!running || finished) return;

    const timer = setInterval(() => {
      setProgress((current) => {
        const line = script[current.line];
        if (line === undefined) return current;

        const lifetime =
          line.kind === 'command'
            ? line.text.length + dwellTicks
            : line.kind === 'blank'
              ? 1
              : dwellTicks;

        if (current.ticks < lifetime) {
          return { line: current.line, ticks: current.ticks + 1 };
        }
        return { line: current.line + 1, ticks: 0 };
      });
    }, tickMs);

    return () => clearInterval(timer);
  }, [running, finished, script, tickMs, dwellTicks]);

  if (!enabled) return { visibleCount: script.length, partial: null };
  return { visibleCount: progress.line, partial: finished ? null : progress.ticks };
}

/**
 * The height a transcript of `lines` occupies, as a CSS length.
 *
 * Computed rather than eyeballed: both callers had hand-written a `min-h-[…]`
 * roughly a line and a half short of their own longest script, which is the
 * difference between "the panel is a fixed size" and "the panel grows at the
 * end of every animation and shoves the page down". It is an inline style
 * because the value depends on the script — a Tailwind arbitrary value built
 * at runtime is a class the compiler never saw and never emitted.
 *
 * The arithmetic is `TRANSCRIPT_BODY`'s own: `leading-6` per line, `gap-0.5`
 * between them, `py-3.5` top and bottom.
 */
export function transcriptMinHeight(lines: number): string {
  return `${lines * 1.5 + Math.max(0, lines - 1) * 0.125 + 1.75}rem`;
}

/** The panel body every transcript shares — type, rhythm and padding. */
export const TRANSCRIPT_BODY = 'flex flex-col gap-0.5 px-4 py-3.5 font-mono text-sm leading-6';

export interface TranscriptProps {
  script: readonly Line[];
  typeOut: TypeOut;
  /**
   * Hold the panel at the height of a transcript this many lines long, so it
   * does not resize as lines arrive or as the reader switches between scripts.
   * Pass the longest script's length.
   */
  minLines?: number;
  /**
   * Give each finished command its own copy button, in a gutter at the right
   * edge. Off for the hero, whose transcript is a demonstration rather than a
   * set of lines to run.
   */
  copyable?: boolean;
  className?: string;
  style?: CSSProperties;
  id?: string;
  role?: string;
  tabIndex?: number;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}

/** The lines themselves, printed and typing. */
export function Transcript({
  script,
  typeOut,
  minLines,
  copyable = false,
  className,
  style,
  id,
  role,
  tabIndex,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
}: TranscriptProps) {
  const { visibleCount, partial } = typeOut;
  const typing = partial !== null && script[visibleCount] !== undefined;

  return (
    <div
      className={cn(TRANSCRIPT_BODY, className)}
      style={
        minLines === undefined ? style : { minHeight: transcriptMinHeight(minLines), ...style }
      }
      id={id}
      role={role}
      tabIndex={tabIndex}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
    >
      {script.slice(0, visibleCount).map((line, index) => (
        <TranscriptLine key={index} line={line} partial={null} copyable={copyable} />
      ))}
      {typing ? (
        <TranscriptLine line={script[visibleCount] as Line} partial={partial} copyable={copyable} />
      ) : null}
    </div>
  );
}

function TranscriptLine({
  line,
  partial,
  copyable,
}: {
  line: Line;
  partial: number | null;
  copyable: boolean;
}) {
  if (line.kind === 'blank') return <span aria-hidden="true">&nbsp;</span>;

  if (line.kind === 'command') {
    const text = partial === null ? line.text : line.text.slice(0, partial);

    if (!copyable) {
      return (
        <span className="text-fg break-all">
          <Prompt />
          {text}
          {partial !== null ? <Cursor /> : null}
        </span>
      );
    }

    // The copy control sits in a gutter at the right edge rather than trailing
    // each command, so the buttons line up in one column instead of stepping
    // in and out with the length of the line above.
    //
    // The gutter is reserved from the first character rather than appearing
    // when the line finishes. A button that arrives at the end takes its own
    // width plus the gap away from the text beside it at that exact moment,
    // which rewraps a long command and pushes every line below it down — a
    // reflow at the one instant the reader is most likely to be reading that
    // line. `size-6` matches `leading-6`, so it costs no vertical space
    // either.
    return (
      <span className="flex items-start gap-2">
        <span className="text-fg min-w-0 flex-1 break-all">
          <Prompt />
          {text}
          {partial !== null ? <Cursor /> : null}
        </span>
        <span className="size-6 shrink-0">
          {/* Only once the line has finished typing — a button beside half a
              command would copy the whole thing, which is not what it looks
              like it does. */}
          {partial === null ? (
            <CopyButton
              value={line.text}
              label={line.text}
              className="text-fg-disabled hover:text-fg-muted size-6"
            />
          ) : null}
        </span>
      </span>
    );
  }

  // Everything else appears whole once its dwell begins; a cursor mid-word
  // would claim it was typed by the user, which it was not.
  if (partial === 0) return null;

  if (line.kind === 'success') {
    return (
      <span className="text-fg-muted break-all">
        <span className="text-success-text">✓ </span>
        {line.text}
      </span>
    );
  }
  if (line.kind === 'comment' || line.kind === 'child') {
    return <span className="text-fg-subtle break-all">{line.text}</span>;
  }
  if (line.kind === 'file') {
    // `whitespace-pre-wrap` rather than the default: this is the only kind
    // whose leading space carries meaning — the continuation of a `RUN` is
    // indented under it — and HTML would otherwise collapse it away and print
    // a Dockerfile nobody writes.
    return <span className="text-fg break-all whitespace-pre-wrap">{line.text}</span>;
  }
  return <span className="text-fg-muted break-all">{line.text}</span>;
}

function Prompt() {
  return <span className="text-fg-subtle select-none">$ </span>;
}

function Cursor() {
  return (
    <span
      aria-hidden="true"
      className="bg-fg-muted ml-px inline-block h-[1.1em] w-[0.55em] translate-y-[0.2em]"
    />
  );
}

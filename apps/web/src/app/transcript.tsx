'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';

import { cn } from '@/lib/cn';
import { CopyButton } from '@/components/ui/copy-button';
import { lineLifetime, scriptSignature, transcriptMinHeight } from './transcript-model';
import type { Line } from './transcript-model';

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

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function subscribeReducedMotion(callback: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener('change', callback);
  return () => query.removeEventListener('change', callback);
}

/**
 * Does this reader want motion, asked once rather than subscribed to?
 *
 * For callers that must decide whether to animate exactly once and then hold
 * that decision — see `install-guide.tsx`. Subscribing there would let the
 * flag flip under a reader who is mid-panel, which is the one transition
 * `enabled` must never make.
 */
export function prefersReducedMotion(): boolean {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/**
 * Does this reader want motion?
 *
 * The server snapshot says "reduced", so prerendering — and any visitor
 * without JavaScript — gets the complete transcript rather than an empty
 * terminal waiting for an animation that will never run.
 *
 * This is a live subscription: turning the OS setting *on* mid-animation
 * correctly completes the transcript at once. Turning it *off* mid-read is the
 * hazard — that flips `enabled` false → true and wipes the panel — so a caller
 * that can be on screen when it happens should latch `prefersReducedMotion()`
 * instead of subscribing.
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
   * This is the flag that decides *what is on screen*, so flipping it while a
   * reader is looking at the panel is destructive: `false → true` empties a
   * transcript they were reading, and `true → false` fills one mid-type. A
   * caller that may be on screen at hydration must therefore settle it from
   * something that cannot change on its own — see `install-guide.tsx`, which
   * latches both the motion preference and the panel's position at mount.
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
 * Progress resets whenever the script's content changes, which is what makes
 * tab switching replay from the top: the reader picked that tab to watch
 * *this* install happen, not to arrive at its last frame.
 */
export function useTypeOut(script: readonly Line[], options: TypeOutOptions): TypeOut {
  const { tickMs, dwellTicks, enabled } = options;
  const running = options.running ?? enabled;
  const [progress, setProgress] = useState<Progress>({ line: 0, ticks: 0 });

  // Keyed on the script's *content*, not its identity, so a caller does not
  // have to remember to reset — and cannot bring the page down by forgetting
  // to memoise. Keying on identity would mean an inline array literal produced
  // a new script every render, so this branch would never settle and React
  // would throw "Too many re-renders". The join is a handful of short strings.
  //
  // The state update during render is React's own documented way to derive
  // state from a changed prop, and it costs one extra render of this hook's
  // owner rather than an effect and a painted frame of the wrong transcript.
  const signature = scriptSignature(script);
  const [seenSignature, setSeenSignature] = useState(signature);
  if (seenSignature !== signature) {
    setSeenSignature(signature);
    setProgress({ line: 0, ticks: 0 });
  }

  const finished = progress.line >= script.length;

  useEffect(() => {
    if (!running || finished) return;

    const timer = setInterval(() => {
      setProgress((current) => {
        const line = script[current.line];
        if (line === undefined) return current;

        const lifetime = lineLifetime(line, dwellTicks);

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

/** The panel body every transcript shares — type, rhythm and padding. */
const TRANSCRIPT_BODY = 'flex flex-col gap-0.5 px-4 py-3.5 font-mono text-sm leading-6';

export interface TranscriptProps {
  script: readonly Line[];
  typeOut: TypeOut;
  /**
   * Hold the panel at the height of a transcript this many lines long, so it
   * does not resize as lines arrive or as the reader switches between scripts.
   * Pass the longest script's length.
   *
   * A floor, not a fixed height: it holds while each entry occupies one line,
   * which is every width down to about 640px. Narrower than that — and at the
   * 320px reflow target especially — commands wrap and the rendered height
   * exceeds the floor by however many rows they take, so panels can still
   * differ in height from one another. Pinning that too would mean measuring
   * after layout, which costs a reflow on every resize to fix a jump nobody
   * has at a readable width.
   */
  minLines?: number;
  /**
   * Give each finished command its own copy button, in a gutter at the right
   * edge. Off for the hero, whose transcript is a demonstration rather than a
   * set of lines to run.
   */
  copyable?: boolean;
  className?: string;
  /**
   * Only `role`/`aria-label` are forwarded, and only because `CliDemo` labels
   * the transcript itself. `InstallGuide` puts `role="tabpanel"` on a wrapper
   * that also holds the footer, so it needs none of this — and a `tabIndex`
   * here would invite a caller to hand-roll a focus fix that belongs to
   * whichever element is actually the panel.
   */
  role?: string;
  'aria-label'?: string;
}

/** The lines themselves, printed and typing. */
export function Transcript({
  script,
  typeOut,
  minLines,
  copyable = false,
  className,
  role,
  'aria-label': ariaLabel,
}: TranscriptProps) {
  const { visibleCount, partial } = typeOut;
  const typing = partial !== null && script[visibleCount] !== undefined;

  return (
    <div
      className={cn(TRANSCRIPT_BODY, className)}
      style={minLines === undefined ? undefined : { minHeight: transcriptMinHeight(minLines) }}
      role={role}
      aria-label={ariaLabel}
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
              className="text-fg-subtle hover:text-fg size-6"
            />
          ) : null}
        </span>
      </span>
    );
  }

  // Everything else appears whole once its dwell begins; a cursor mid-word
  // would claim it was typed by the user, which it was not.
  if (partial === 0) return null;

  // ── Why these wrap differently from a command ──
  // `break-all` breaks between any two characters, which is right for a
  // command: it carries URLs and absolute paths with no spaces to break at,
  // and the alternative is a line that overflows its panel. Output lines are
  // prose — "Opening your browser to approve this device…" — and `break-all`
  // on prose breaks mid-word at whatever column the box ends, so a phone
  // renders "approve this d / evice…". `break-words` keeps to the spaces and
  // only splits a word that genuinely cannot fit.
  if (line.kind === 'success') {
    return (
      <span className="text-fg-muted break-words">
        <span className="text-success-text">✓ </span>
        {line.text}
      </span>
    );
  }
  if (line.kind === 'comment' || line.kind === 'child') {
    return <span className="text-fg-subtle break-words">{line.text}</span>;
  }
  if (line.kind === 'file') {
    // `whitespace-pre-wrap` rather than the default: a file is shown as
    // written, and HTML collapses leading space. No current snippet is
    // indented — the Dockerfile lost its `RUN` continuation when it became a
    // `COPY --from` — but the next one to need a nested `ENV` or a heredoc
    // body would silently print flush left, and a file panel that reformats
    // its file is worse than useless. `break-all` for the same reason as a
    // command: image references and paths have nowhere to break.
    return <span className="text-fg break-all whitespace-pre-wrap">{line.text}</span>;
  }
  return <span className="text-fg-muted break-words">{line.text}</span>;
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

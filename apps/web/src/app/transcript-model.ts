/**
 * The transcript's pure model: the arithmetic and the decisions, with no React
 * and no DOM in them.
 *
 * Split out of `transcript.tsx` and `install-guide.tsx` so it can be tested.
 * The vitest environment for this workspace is `node` — there is no jsdom and
 * no testing-library — so anything reachable only through a rendered component
 * is reachable only through reasoning. That was not a good trade for this
 * particular logic: the type-out gates and the tab arithmetic between them
 * produced a transcript that wiped itself on hydration, a tab set whose replay
 * silently stopped working, and a `Home` key that erased the panel. Every one
 * of those is a table of booleans, and a table of booleans should be a test.
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

/**
 * What a run intends to do with the transcript, settled once at mount.
 *
 *   - `print`   — render it whole and leave it alone. Reduced motion, and the
 *                 server's own answer, so it is the initial value.
 *   - `type`    — the panel is below the fold, so blanking it costs the reader
 *                 nothing and it may type once scrolled to.
 *   - `settled` — the panel was already on screen at hydration, so what the
 *                 server drew stays; the reader may still ask for an animation
 *                 by choosing a different tab.
 */
export type TranscriptPlan = 'print' | 'type' | 'settled';

export interface TranscriptGates {
  /** Whether this is a type-out at all, i.e. what is on screen. */
  enabled: boolean;
  /** Whether the clock is running. */
  running: boolean;
}

/**
 * Turn the three latched facts into the two flags `useTypeOut` takes.
 *
 * The invariants this encodes, in order of how much they cost to get wrong:
 *
 *  1. Under `print`, nothing ever animates. That is where reduced motion
 *     lands, and no amount of clicking may override a stated preference.
 *  2. Under `settled`, the server's transcript stays until the reader asks for
 *     something else. Flipping `enabled` on a panel somebody is reading empties
 *     it and retypes it in front of them.
 *  3. Under `type`, the panel is known to be off screen, so it renders empty
 *     from hydration — there is nothing to wipe — and starts when scrolled to.
 *  4. A reader who picked a tab does not then wait on the observer: they asked
 *     for this transcript, so it runs immediately.
 */
export function transcriptGates(
  plan: TranscriptPlan,
  interacted: boolean,
  started: boolean,
): TranscriptGates {
  const enabled = plan === 'type' || (plan === 'settled' && interacted);
  return { enabled, running: enabled && (started || interacted) };
}

/**
 * How many ticks a line occupies before the next one begins.
 *
 * A command is typed a character at a time and then dwells; everything else
 * appears whole and only dwells; a blank line is a beat. Note the reducer
 * spends `lifetime + 1` ticks per line in total, because `ticks` has to *reach*
 * `lifetime` before the line advances — which is the off-by-one that makes a
 * hand-counted duration wrong.
 */
export function lineLifetime(line: Line, dwellTicks: number): number {
  if (line.kind === 'command') return line.text.length + dwellTicks;
  if (line.kind === 'blank') return 1;
  return dwellTicks;
}

/**
 * How long a whole script takes to type, in milliseconds.
 *
 * Worth having as a function rather than a comment: WCAG SC 2.2.2 asks that
 * motion which starts by itself and runs past five seconds beside other
 * content be pausable, and the hero has no control, so its script has to come
 * in under that. A number in a comment stops being true the first time a line
 * is added; a test does not.
 *
 * This is the floor — `setInterval` guarantees *at least* `tickMs` between
 * callbacks, so a contended main thread only ever makes a run longer.
 */
export function scriptDurationMs(
  script: readonly Line[],
  tickMs: number,
  dwellTicks: number,
): number {
  const ticks = script.reduce((total, line) => total + lineLifetime(line, dwellTicks) + 1, 0);
  return ticks * tickMs;
}

/**
 * The height a transcript of `lines` occupies, as a CSS length.
 *
 * Computed rather than eyeballed: both callers had hand-written a `min-h-[…]`
 * short of their own longest script, which is the difference between "the
 * panel is a fixed size" and "the panel grows at the end of every animation and
 * shoves the page down". It is used as an inline style because the value
 * depends on the script — a Tailwind arbitrary value built at runtime is a
 * class the compiler never saw and never emitted.
 *
 * The arithmetic is `TRANSCRIPT_BODY`'s own: `leading-6` per line, `gap-0.5`
 * between them, `py-3.5` top and bottom.
 */
export function transcriptMinHeight(lines: number): string {
  return `${lines * 1.5 + Math.max(0, lines - 1) * 0.125 + 1.75}rem`;
}

/**
 * A script's identity for the purpose of "has this changed?".
 *
 * Content, not object identity, so a caller that builds its script inline
 * cannot put the page into a re-render loop — and so two renders of the same
 * script never replay it.
 *
 * NUL is the separator, and it has to be something a line cannot contain:
 * on a space, `['a b']` and `['a', 'b']` would agree, and a transcript is
 * mostly spaces.
 */
export function scriptSignature(script: readonly Line[]): string {
  return script.map((line) => (line.kind === 'blank' ? '' : line.text)).join('\u0000');
}

/**
 * Where an arrow key moves within a tab row, or `null` if this key does not
 * move at all.
 *
 * Wrapping at both ends, and `Home`/`End` to the ends, which is what the
 * WAI-ARIA tabs pattern specifies for a horizontal tablist.
 */
export function nextTabIndex(key: string, index: number, last: number): number | null {
  if (key === 'ArrowRight') return index === last ? 0 : index + 1;
  if (key === 'ArrowLeft') return index === 0 ? last : index - 1;
  if (key === 'Home') return 0;
  if (key === 'End') return last;
  return null;
}

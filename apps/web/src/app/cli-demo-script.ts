import type { Line } from './transcript-model';

/**
 * The hero transcript's content and pacing, kept out of `cli-demo.tsx`.
 *
 * Split out for one reason: this workspace's vitest has no JSX transform, so a
 * `.tsx` module cannot be imported by a test. The hero's run time is bounded
 * by WCAG SC 2.2.2 — motion that starts by itself, lasts over five seconds and
 * sits beside other content has to be pausable, and this page has no control —
 * so that bound wants a test, and a test that asserted against its own copy of
 * the script would go on passing after somebody added a line to the real one.
 *
 * Every non-child line is the CLI's real output, copied from the format
 * strings in `cli/cmd/xecret` — `login.go`, `init.go`. When those change this
 * changes with them, because a demo that shows output the tool does not
 * produce is a small lie on the one page that must not contain any. The two
 * dimmed lines after `run` are the *child process* speaking (npm's own
 * banner), which is the point of the feature: the app runs untouched, secrets
 * already in its environment.
 */
export const SCRIPT: readonly Line[] = [
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

/**
 * Milliseconds per typed character.
 *
 * 36, not the 45 this ran at, and the number is set by WCAG rather than by
 * taste — see `scriptDurationMs` and the test that holds it under five
 * seconds. At 45ms the run was 5985ms, just over; at 36ms it is 4788ms. The
 * rhythm between typing and dwell is unchanged, both being counted in ticks.
 *
 * The figure is a floor: `setInterval` guarantees *at least* this much between
 * callbacks, so a contended main thread only lengthens a run. If the margin
 * ever needs to be larger than this, the honest fix is a pause control rather
 * than a smaller number.
 */
export const TICK_MS = 36;
/** Ticks a finished command or an output line stays current before the next. */
export const DWELL_TICKS = 8;

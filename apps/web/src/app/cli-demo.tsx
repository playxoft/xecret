'use client';

import { cn } from '@/lib/cn';
import { TerminalIcon } from '@/components/ui/icons';
import { Transcript, useReducedMotion, useTypeOut } from './transcript';
import type { Line } from './transcript';

/**
 * The landing page's CLI demo: the golden path, animated.
 *
 * The type-out engine and the line renderer are in `transcript.tsx`, shared
 * with `InstallGuide`. What is here is the script and the window around it.
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

export function CliDemo({ className }: { className?: string }) {
  const reducedMotion = useReducedMotion();
  const typeOut = useTypeOut(SCRIPT, {
    tickMs: TICK_MS,
    dwellTicks: DWELL_TICKS,
    enabled: !reducedMotion,
  });

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

      <Transcript
        script={SCRIPT}
        typeOut={typeOut}
        // Held at its own full height, so the window does not grow line by line
        // and push the fold down as it types.
        minLines={SCRIPT.length}
        // `role="group"` so the label is actually announced: `aria-label` on a
        // plain `div` has no role to hang off and screen readers may drop it.
        role="group"
        aria-label="Terminal transcript: xecret login, xecret init, then xecret run"
      />
    </div>
  );
}

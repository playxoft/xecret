'use client';

import { cn } from '@/lib/cn';
import { TerminalIcon } from '@/components/ui/icons';
import { Transcript, useReducedMotion, useTypeOut } from './transcript';
import { DWELL_TICKS, SCRIPT, TICK_MS } from './cli-demo-script';

/**
 * The landing page's CLI demo: the golden path, animated.
 *
 * The type-out engine and the line renderer are in `transcript.tsx`, shared
 * with `InstallGuide`; the script and its pacing are in `cli-demo-script.ts`,
 * which is a plain module so that a test can hold its run time under the five
 * seconds SC 2.2.2 allows. What is left here is the window around it.
 *
 * Honest limitation, recorded here and in the phase report: this is a typed
 * re-enactment, not an asciinema recording — there is no deployed server to
 * record against yet. The animation types only; nothing here executes.
 *
 * Reduced motion is a first-class path, not a degradation: the full
 * transcript renders immediately, and the type-out never starts.
 */

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
        <span className="text-fg-subtle ml-auto">typed from the CLI&apos;s real output</span>
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

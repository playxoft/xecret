'use client';

import type { ReactNode } from 'react';

import { InfoIcon } from '@/components/ui/icons';
import { Tooltip, TooltipProvider } from '@/components/ui/tooltip';

/**
 * The explanation behind each row of the comparison table.
 *
 * ── Why the table needs one at all ──
 * Forty-nine rows, and half of them name something a reader outside this
 * product has no way to guess from the words alone: break-glass access,
 * per-environment grants, point-in-time restore, OIDC federation. A comparison
 * table that assumes the vocabulary is a table that only helps people who have
 * already decided. The alternative — a sentence under every row — triples the
 * height of the densest thing on the page, so the explanation is there for
 * whoever wants it and out of the way of whoever does not.
 *
 * ── Why a portalled tooltip and not a CSS one ──
 * The table scrolls horizontally inside its own box, and a box that scrolls on
 * one axis clips on both. A tooltip positioned by CSS inside that box would be
 * cut off by it — worst on the last rows, which is where the reader who has got
 * that far is. Radix renders into a portal at the document root and flips side
 * when it would collide with an edge, so the hint escapes the scroll container
 * instead of being trimmed by it.
 *
 * ── The accessible name ──
 * The icon is decorative and the button has no text, so it carries one built
 * from the row it belongs to. "More information" forty-nine times is a screen
 * reader reading out a list of identical buttons.
 */
export function RowHint({ label, hint }: { label: string; hint: string }) {
  return (
    <Tooltip content={hint} side="top">
      <button
        type="button"
        aria-label={`What ${label} means`}
        className="text-fg-subtle hover:text-fg focus-visible:text-fg inline-flex translate-y-[-1px] cursor-help rounded-full align-middle transition-colors"
      >
        <InfoIcon className="size-3.5" />
      </button>
    </Tooltip>
  );
}

/**
 * Mounted once around the table.
 *
 * Radix shares its "skip delay" timer through this, so running the pointer down
 * a column of info buttons shows each one immediately instead of waiting out the
 * open delay at every row — which on a table this tall is the difference between
 * a usable affordance and a flicker.
 */
export function RowHintProvider({ children }: { children: ReactNode }) {
  return <TooltipProvider delayDuration={200}>{children}</TooltipProvider>;
}

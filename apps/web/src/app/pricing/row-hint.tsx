'use client';

import type { ReactNode } from 'react';

import { InfoIcon } from '@/components/ui/icons';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/**
 * The explanation behind each row of the comparison table.
 *
 * ── Why the table needs one at all ──
 * Forty-seven rows, and half of them name something a reader outside this
 * product has no way to guess from the words alone: break-glass, per-environment
 * grants, point-in-time restore, OIDC federation. A comparison table that
 * assumes the vocabulary is a table that only helps people who have already
 * decided. The alternative — a sentence under every row — triples the height of
 * the densest thing on the page, so the explanation is there for whoever wants
 * it and out of the way of whoever does not.
 *
 * ── Why a popover and not a tooltip ──
 * Because a tooltip does not open on touch, and this was built as one. Radix
 * bails out of its tooltip when `pointerType === 'touch'`, and the button has no
 * other handler — so on a phone, tapping any of the forty-seven icons did
 * nothing at all, and the `aria-label` ("What X means") carried no content to
 * fall back on. `tooltip.tsx` states the rule this broke in its own header: a
 * tooltip is never the only place information lives.
 *
 * A popover opens on click, which is the same gesture on every input device, and
 * closes on Escape or an outside press. It is also the honest shape for the
 * control: an `i` button that must be *pressed* is an affordance; one that must
 * be hovered is a secret.
 *
 * ── Why it is portalled ──
 * The table scrolls horizontally inside its own box, and a box that scrolls on
 * one axis clips on both. Content positioned by CSS inside that box would be cut
 * off by it — worst on the last rows, which is where a reader who has got that
 * far is. Radix renders into a portal at the document root and flips side on
 * collision, so the hint escapes the scroll container instead of being trimmed.
 *
 * ── The accessible name ──
 * The icon is decorative and the button has no text, so it carries one built
 * from the row it belongs to. "More information" forty-seven times is a screen
 * reader reading out a list of identical buttons.
 */
export function RowHint({ label, hint }: { label: string; hint: string }) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`What ${label} means`}
        className="text-fg-subtle hover:text-fg focus-visible:text-fg data-[state=open]:text-fg inline-flex translate-y-[-1px] cursor-help rounded-full align-middle transition-colors"
      >
        <InfoIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent side="top" className="max-w-64 text-sm leading-5 font-normal">
        {hint}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Kept as a no-op wrapper.
 *
 * It existed to mount the tooltip provider's shared skip-delay timer, and a
 * popover needs no provider. The component stays so the page's markup does not
 * have to change shape for an implementation detail — and so that a future hint
 * that *does* need shared state has somewhere to put it.
 */
export function RowHintProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

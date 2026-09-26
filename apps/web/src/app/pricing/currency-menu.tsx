'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Dismissal behaviour for the currency menu, and nothing else.
 *
 * ── What this deliberately does not do ──
 * It does not own the currency. The selection lives in four radio inputs above
 * both sections, and every price on this page is revealed from `:checked` by CSS
 * — see `.x-price` in globals.css. That is what keeps the figures server-rendered
 * and final: a reader on a slow connection never watches $12 become $19 after a
 * bundle lands, which on the page somebody is deciding money on is the one thing
 * this design refuses to do.
 *
 * So this is a client component that manages one boolean on a `<details>`, and
 * the prices are untouched by it. If the script never arrives the menu still
 * opens, still selects, and still switches every price; it just keeps the native
 * behaviour of staying open until it is clicked again.
 *
 * ── Why it is needed at all ──
 * `<details>` has no light dismiss. There is no CSS for "close when the pointer
 * goes elsewhere", and the alternative that needs no JavaScript — the `popover`
 * attribute — degrades to a permanently visible panel on any browser that does
 * not know it, which is a worse failure than the one being fixed.
 *
 * Three ways out, matching what a menu is expected to do: a pointer press
 * outside it, Escape, and choosing an option.
 */
export function CurrencyMenu({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const details = ref.current;
    if (!details) return;

    const close = () => {
      details.open = false;
    };

    // `pointerdown`, not `click`: a press that starts outside should dismiss
    // before the click lands, which is what stops the menu swallowing the first
    // press on whatever the reader was actually reaching for.
    const onPointerDown = (event: PointerEvent) => {
      if (!details.open) return;
      const target = event.target;
      if (target instanceof Node && details.contains(target)) return;
      close();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !details.open) return;
      close();
      // Focus goes back to the control that opened it, so Escape does not drop a
      // keyboard user at the top of the document.
      details.querySelector('summary')?.focus();
    };

    // Choosing an option closes it. The `<label>` still checks its radio and CSS
    // still swaps the prices — this only puts the panel away afterwards, which
    // is what every other menu in the product does.
    const onSelect = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest('label')) close();
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    details.addEventListener('click', onSelect);

    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      details.removeEventListener('click', onSelect);
    };
  }, []);

  return (
    <details ref={ref} className={className}>
      {children}
    </details>
  );
}

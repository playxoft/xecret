import { ChevronDownIcon } from '@/components/ui/icons';
import { cn } from '@/lib/cn';

/**
 * The FAQ accordion, and the structured data that goes with it.
 *
 * ── Why `<details>` and not a React accordion ──
 * Because the browser already ships one. `<details>` opens with no JavaScript,
 * announces its expanded state to a screen reader without a line of ARIA,
 * responds to Enter and Space, and is found by the browser's own in-page
 * search — Chrome and Safari expand a closed `<details>` to show a match, which
 * no hand-rolled accordion does. A React implementation would be more code, one
 * more hydration island on a page that otherwise needs none, and worse.
 *
 * ── Compact by construction ──
 * Rows are divided by hairlines inside a single bordered card rather than being
 * eight separate cards with eight shadows. Twelve questions then read as one
 * list you can scan, which is the entire job of an FAQ.
 */

export interface FaqItem {
  readonly question: string;
  /**
   * Plain text, deliberately. The same string is published as the page's
   * `FAQPage` answer, and structured data that says something different from
   * what the page renders is the fastest route to a manual action from Google.
   * One string, rendered once and published once.
   */
  readonly answer: string;
}

export function Faq({ items, className }: { items: readonly FaqItem[]; className?: string }) {
  return (
    <div
      className={cn('x-faq border-line bg-surface overflow-hidden rounded-xl border', className)}
    >
      {items.map((item) => (
        <details
          key={item.question}
          // Not grouped by `name`: an exclusive accordion closes the answer a
          // reader is halfway through the moment they open the next one, and on
          // a page of related questions people genuinely do read two at once.
          className="border-line-subtle border-b last:border-b-0"
        >
          <summary className="text-fg hover:bg-surface-hover flex items-start gap-3 px-4 py-3.5 text-[0.9375rem] leading-6 font-medium transition-colors sm:px-5">
            <span className="flex-1">{item.question}</span>
            <ChevronDownIcon className="x-faq-chevron text-fg-subtle mt-0.5 size-4 shrink-0" />
          </summary>
          <p className="text-fg-muted px-4 pb-4 text-[0.9375rem] leading-7 sm:px-5 sm:pr-14">
            {item.answer}
          </p>
        </details>
      ))}
    </div>
  );
}

/**
 * `FAQPage` structured data for a set of questions.
 *
 * Emit this only on pages that actually render the same `items` — see the note
 * on `FaqItem.answer`. Google's guidance is that one page may carry one
 * `FAQPage`, so a page with two FAQ sections should concatenate them into a
 * single call rather than emitting the type twice.
 */
export function faqSchema(items: readonly FaqItem[]) {
  return {
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  };
}

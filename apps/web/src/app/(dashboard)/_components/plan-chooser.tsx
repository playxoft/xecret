'use client';

import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';
import { formatCount } from '@/components/plans/pricing-content';
import {
  Badge,
  CheckCircleIcon,
  CheckIcon,
  FileTextIcon,
  HistoryIcon,
  LockIcon,
  ShieldCheckIcon,
} from '@/components/ui';
import type { IconProps } from '@/components/ui';
import { Segmented } from './segmented';
import {
  FREE_PRICE,
  pastTheAllowance,
  RECOMMENDED_LABEL,
  savingLine,
  USD_PRICES,
  YEARLY_SAVING_UP_TO,
} from './upgrade-plans';
import type {
  BillingPeriod,
  OfferPlanId,
  PaidPlanId,
  PlanOffer,
  ReassuranceId,
  ReassuranceItem,
} from './upgrade-plans';

/**
 * The pieces of the plan chooser, drawn the same on the plans page
 * (`upgrade-screen.tsx`) and on the billing screen's "change plan" card
 * (`billing-screen.tsx`), so moving from one to the other is moving between
 * two views of one thing: the same period toggle, the same figure and saving
 * under a plan's name, the same short list of what changes, and the same
 * facts beside the button.
 *
 * Presentation only. Nothing here starts a checkout, previews a change, holds
 * an idempotency key or reads the billing status: each screen keeps that
 * wiring and hands these components what to show. And nothing here calls a
 * hook, so the plans page's checkout test, which replaces `useState` and
 * `useRef` with slots kept in call order, sees the same order with or
 * without them.
 *
 * The sentences are `upgrade-plans.ts`'s, where the note on each says what it
 * is checked against; what is written here is only how they are drawn.
 */

type Payments = { readonly taken: boolean; readonly overageRate: string };

/**
 * Monthly or yearly, with what yearly saves on the yearly option.
 *
 * The chip is `YEARLY_SAVING_UP_TO`, worked out from the two rates of each
 * plan, so it is left off rather than printed as nought should the rates ever
 * meet.
 */
export function PeriodToggle({
  value,
  onChange,
  className,
}: {
  value: BillingPeriod;
  onChange: (period: BillingPeriod) => void;
  className?: string;
}) {
  return (
    <Segmented
      label="Billing period"
      options={[
        { value: 'monthly', label: 'Monthly' },
        {
          value: 'yearly',
          label: (
            <>
              Yearly
              {/* A tint pill rather than bare green text, so it reads the same
                  on the selected and unselected segment. */}
              {YEARLY_SAVING_UP_TO > 0 ? (
                <span className="bg-success-tint text-success-text rounded-full px-1.5 py-0.5 text-xs font-normal">
                  Save up to {YEARLY_SAVING_UP_TO}%
                </span>
              ) : null}
            </>
          ),
        },
      ]}
      value={value}
      onChange={onChange}
      {...(className === undefined ? {} : { className })}
    />
  );
}

/**
 * A plan's figure for the period chosen, and the line under it.
 *
 * On yearly: the per-month rate, the plan's own saving beside it, and the
 * yearly total under it. On monthly: the monthly rate, and what yearly billing
 * would save, in the line the total takes on yearly, so pressing the toggle
 * changes the words and never the height. Free keeps the line's height empty.
 *
 * Spans laid out as blocks rather than paragraphs, so it can sit inside a
 * label as well as inside an article.
 */
export function PlanPrice({
  plan,
  period,
  size = 'lg',
}: {
  plan: OfferPlanId;
  period: BillingPeriod;
  size?: 'lg' | 'md';
}) {
  const figure = plan === 'free' ? null : USD_PRICES[plan][period];
  const saving = savingLine(plan, period);
  const third = period === 'yearly' ? (figure?.note ?? null) : saving;

  return (
    <span className="block">
      <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span
          className={cn(
            'text-fg font-semibold tracking-[-0.02em]',
            size === 'lg' ? 'text-3xl' : 'text-2xl',
          )}
        >
          {figure?.price ?? FREE_PRICE.price}
        </span>
        {period === 'yearly' && saving !== null ? (
          <span className="bg-success-tint text-success-text rounded-full px-1.5 py-0.5 text-xs font-medium">
            {saving}
          </span>
        ) : null}
      </span>
      <span className="text-fg-subtle mt-1 block text-sm">{figure?.unit ?? FREE_PRICE.unit}</span>
      {third !== null ? (
        <span
          className={cn(
            'mt-1 block text-xs leading-5',
            period === 'monthly' ? 'text-success-text font-medium' : 'text-fg-subtle',
          )}
        >
          {third}
        </span>
      ) : (
        <span aria-hidden="true" className="invisible mt-1 block text-xs leading-5">
          &nbsp;
        </span>
      )}
    </span>
  );
}

/**
 * What a plan changes, as a short list: "Everything in Pro, plus", then the
 * few differences a team decides on, then the fetch allowance with what
 * happens past it said beside the number. On a paid plan that is a charge,
 * and a charge is not small print.
 */
export function PlanFeatures({
  offer,
  payments,
  className,
}: {
  offer: PlanOffer;
  payments: Payments;
  className?: string;
}) {
  return (
    <div className={className}>
      {offer.lead !== null ? (
        <p className="text-fg-subtle mb-2.5 text-xs font-semibold tracking-[0.06em] uppercase">
          {offer.lead}
        </p>
      ) : null}
      <ul className="space-y-2.5">
        {offer.features.map((feature) => (
          <li key={feature} className="flex gap-2.5">
            <CheckIcon className="text-success-text mt-1 size-4 shrink-0" />
            <span className="text-fg-muted text-sm leading-6">{feature}</span>
          </li>
        ))}
        <li className="flex gap-2.5">
          <CheckIcon className="text-success-text mt-1 size-4 shrink-0" />
          <span className="text-fg-muted text-sm leading-6">
            {formatCount(offer.includedFetches)} secret fetches a month included
            <span className="text-fg-subtle block text-xs leading-5">
              {pastTheAllowance(offer.id, payments)}
            </span>
          </span>
        </li>
      </ul>
    </div>
  );
}

/** "Your current plan", where a button would otherwise be: a fact, not a control. */
export function CurrentPlanMarker() {
  return (
    <p className="border-line-subtle bg-canvas-inset text-fg-muted flex h-9 items-center justify-center gap-2 rounded-md border text-sm font-medium">
      <CheckIcon className="text-success-text size-4" />
      Your current plan
    </p>
  );
}

const REASSURANCE_ICON: Readonly<Record<ReassuranceId, (props: IconProps) => ReactNode>> = {
  provider: LockIcon,
  currency: FileTextIcon,
  cancel: HistoryIcon,
  confirm: CheckCircleIcon,
  kept: ShieldCheckIcon,
};

/**
 * The facts beside a purchase: who takes the payment, what the price is shown
 * in, and how leaving works (or, for a plan change, that nothing moves before
 * the confirm). A list, laid out in a column beside a button or across the
 * width under a row of cards.
 */
export function Reassurance({
  items,
  label,
  layout = 'column',
  className,
}: {
  items: readonly ReassuranceItem[];
  /** The list's accessible name: "About paying", "About changing plan". */
  label: string;
  layout?: 'column' | 'row';
  className?: string;
}) {
  return (
    <ul
      aria-label={label}
      className={cn(
        'grid gap-x-6 gap-y-2.5',
        layout === 'row' ? '@3xl:grid-cols-3' : 'grid-cols-1',
        className,
      )}
    >
      {items.map((item) => {
        const Icon = REASSURANCE_ICON[item.id];
        return (
          <li key={item.id} className="text-fg-muted flex gap-2.5 text-sm leading-5">
            <Icon className="text-fg-subtle mt-0.5 size-4 shrink-0" />
            <span>{item.text}</span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * One plan as a choice on the billing screen: a radio, drawn as a card with
 * the plan's figure and what it changes.
 *
 * A real `<input type="radio">`, so the group is one tab stop, the arrow keys
 * move the choice and a screen reader announces "radio button, 1 of 2" with
 * no script of ours. Its accessible name is the label, which is the plan's
 * name and its chip ("Current plan", or the recommendation); the figure and
 * the list are its description. The label
 * stretches over the whole card (its `::after`), so pressing anywhere on the
 * card chooses it, and the ring a keyboard user follows is drawn on the card
 * while the input inside it has focus.
 */
export function PlanOption({
  offer,
  group,
  period,
  selected,
  current,
  payments,
  onSelect,
}: {
  offer: PlanOffer & { readonly id: PaidPlanId };
  /** The radios' shared `name`, unique to the form. */
  group: string;
  period: BillingPeriod;
  selected: boolean;
  /** This is the organisation's plan now. */
  current: boolean;
  payments: Payments;
  onSelect: (plan: PaidPlanId) => void;
}) {
  const id = `${group}-${offer.id}`;

  return (
    <div
      className={cn(
        'bg-surface relative flex flex-col rounded-lg border p-4 transition-colors',
        'has-[:focus-visible]:outline-ring has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2',
        selected
          ? 'border-accent ring-accent shadow-raised ring-1'
          : 'border-line hover:border-line-strong',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <input
          type="radio"
          id={id}
          name={group}
          value={offer.id}
          checked={selected}
          onChange={() => onSelect(offer.id)}
          aria-describedby={`${id}-detail`}
          className="sr-only"
        />
        {/* The radio as it is drawn. The input itself is visually hidden and
            keeps the focus and the state; this only shows them. */}
        <span
          aria-hidden="true"
          className={cn(
            'grid size-4 shrink-0 place-items-center rounded-full border',
            selected ? 'border-accent bg-accent' : 'border-line-control bg-surface',
          )}
        >
          {selected ? <span className="bg-accent-fg size-1.5 rounded-full" /> : null}
        </span>
        <label
          htmlFor={id}
          className="text-fg flex cursor-pointer flex-wrap items-center gap-x-2.5 gap-y-1 text-base font-semibold after:absolute after:inset-0 after:rounded-lg"
        >
          {offer.name}
          {current ? (
            <Badge tone="success" className="text-xs">
              Current plan
            </Badge>
          ) : offer.recommended ? (
            <Badge tone="accent" className="text-xs">
              {RECOMMENDED_LABEL}
            </Badge>
          ) : null}
        </label>
      </div>

      {/* No seat floor here: the form says the chosen plan's under the cards,
          in a sentence of its own, and two of them would be one too many. */}
      <div id={`${id}-detail`} className="mt-3">
        <PlanPrice plan={offer.id} period={period} size="md" />
        <PlanFeatures
          offer={offer}
          payments={payments}
          className="border-line-subtle mt-3 border-t pt-3"
        />
      </div>
    </div>
  );
}

'use client';

import Link from 'next/link';

import { Alert } from '@/components/ui';
import { usePlanView } from './plan-entitlements';

const LINK =
  'text-fg decoration-line-strong hover:decoration-fg font-medium underline underline-offset-4';

/**
 * The one line every page of an organisation awaiting a paid plan opens with.
 *
 * An account's two oldest Free organisations work; a later one waits for a
 * plan, with every change refused until it has one and its secrets still
 * readable (`Entitlements.awaitingPaidPlan`). Each control that would change it
 * is drawn locked with a lock of its own; this says why once, at the top, so
 * nobody has to open a lock to learn what is going on. A newly created one is
 * opened straight on its plans page, where this is the banner the owner reads
 * above the plans, so there it offers no link to the page they are on.
 */
export function AwaitingPlanBanner({ onPlansPage }: { onPlansPage: boolean }) {
  const view = usePlanView();
  if (view?.entitlements?.awaitingPaidPlan !== true) return null;

  const upgrades = view.entitlements.upgrades;

  return (
    <Alert tone="warning" title="This organisation needs a paid plan to start" className="mb-6">
      <p>
        The account that created it already has two free organisations, so this one waits for a plan
        before it can be changed. Its secrets stay readable and nothing is deleted.
      </p>
      {upgrades && view.owner && !onPlansPage ? (
        <p className="mt-1.5">
          <Link href={view.plansHref} className={LINK}>
            Choose a plan
          </Link>
        </p>
      ) : null}
      {upgrades && view.owner && onPlansPage ? (
        <p className="mt-1.5">Choose one below to start using it.</p>
      ) : null}
      {upgrades && !view.owner ? <p className="mt-1.5">Ask an owner to choose a plan.</p> : null}
    </Alert>
  );
}

'use client';

import Link from 'next/link';

import { Alert } from '@/components/ui';
import { usePlanView } from './plan-entitlements';

const LINK =
  'text-fg decoration-line-strong hover:decoration-fg font-medium underline underline-offset-4';

/**
 * The one line every page of an organisation awaiting a paid plan opens with.
 *
 * It says what, never why. Why an organisation waits is a fact about the
 * account that created it (how many other Free organisations it holds), and a
 * member of this one has no business learning that about somebody else's
 * account. The owners are told why by email when it happens. Here every
 * member reads the state, and an owner reads the one thing to do about it: a
 * newly created organisation opens straight on its plans page, under this
 * banner, so there it points at the plans below rather than linking to the
 * page it is on. Each control that would change the organisation carries a
 * lock of its own.
 */
export function AwaitingPlanBanner({ onPlansPage }: { onPlansPage: boolean }) {
  const view = usePlanView();
  if (view?.entitlements?.awaitingPaidPlan !== true) return null;

  const upgrades = view.entitlements.upgrades;

  return (
    <Alert tone="warning" title="This organisation needs a paid plan to start." className="mb-6">
      {upgrades && view.owner && !onPlansPage ? (
        <p>
          <Link href={view.plansHref} className={LINK}>
            Choose a plan
          </Link>
        </p>
      ) : null}
      {upgrades && view.owner && onPlansPage ? <p>Choose one below to start using it.</p> : null}
      {upgrades && !view.owner ? <p>Ask an owner to choose a plan.</p> : null}
    </Alert>
  );
}

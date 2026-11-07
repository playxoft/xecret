'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { appPath, parseDashboardPath } from '@/app/(dashboard)/_lib/paths';
import { errorMessage, isApiError } from '@/lib/api';
import { Alert } from '@/components/ui';
import { planName, planRefusalOf, upgradeSentence, withoutReasonPrefix } from './plan-copy';

/**
 * Where "compare plans" goes when there is no organisation to compare them for.
 *
 * The public pricing page: every currency, the full matrix, and nothing that
 * needs a session. Inside an organisation `plansHref` sends the link to that
 * organisation's own plans page instead — see there.
 */
export const PLANS_HREF = '/pricing';

/**
 * Where "compare plans" goes from the page at `pathname`.
 *
 * The in-app plans page of the organisation the URL names, which is where
 * every caller of these notices actually is: a refusal or a locked control
 * inside `/app/{org}/…`. That page names the plan, shows the organisation's
 * current one to an owner and starts the checkout from the same screen —
 * where the public pricing page sent an owner out of the dashboard to find
 * the billing screen again on their own.
 *
 * Read from the path rather than taken as a prop, so the cards and dialogs that
 * draw these notices need not each thread a slug through. Anywhere without an
 * organisation in its path — the account area, or no router at all — falls
 * back to `PLANS_HREF`.
 */
export function plansHref(pathname: string | null): string {
  if (pathname === null) return PLANS_HREF;
  const { orgSlug } = parseDashboardPath(pathname);
  return orgSlug === null ? PLANS_HREF : appPath.upgrade(orgSlug);
}

function usePlansHref(): string {
  return plansHref(usePathname());
}

const LINK =
  'text-fg decoration-line-strong hover:decoration-fg font-medium underline underline-offset-4';

/**
 * A failed change, said in the right voice.
 *
 * ── Two failures that look alike on the wire ──
 * A `plan_limit` refusal and every other refusal are both 4xx answers carrying
 * a sentence, and rendering them the same way is the mistake `lib/api.ts`
 * describes: "you do not have permission" shown to an owner who plainly does.
 * So a plan refusal is an *info* alert — nothing went wrong, the organisation has
 * not bought this — naming the plan that would allow it, with the way to see
 * it. Everything else is the danger alert every settings form already shows,
 * with the request id a support ticket needs.
 *
 * Messages that carry a machine-readable prefix (`export_disabled: …`) are shown
 * without it: the prefix is for clients that branch on it, not for people.
 */
export function ChangeError({
  error,
  title = 'That change was not made',
  children,
}: {
  error: unknown;
  title?: string;
  /** Anything else the failure warrants — a retry, a link to the cause. */
  children?: ReactNode;
}) {
  const refusal = planRefusalOf(error);
  const comparePlans = usePlansHref();

  if (refusal !== null) {
    return (
      <Alert
        tone="info"
        title={
          refusal.upgradeTo === null
            ? 'Not part of this plan'
            : `Available on the ${planName(refusal.upgradeTo)} plan`
        }
      >
        <p>{withoutReasonPrefix(refusal.message)}</p>
        <p className="mt-1.5">
          <Link href={comparePlans} className={LINK}>
            Compare plans
          </Link>
        </p>
        {children}
      </Alert>
    );
  }

  return (
    <Alert tone="danger" title={title}>
      <p>{withoutReasonPrefix(errorMessage(error))}</p>
      {isApiError(error) && error.requestId ? (
        <p className="mt-1.5 text-sm">
          Request id: <code className="font-mono select-all">{error.requestId}</code>
        </p>
      ) : null}
      {children}
    </Alert>
  );
}

/**
 * The sentence beside a control this organisation's plan does not include.
 *
 * Shown instead of hiding the control. "Why is there no switch for this?" is a
 * question with an answer, and the answer is the plan — so the control is drawn,
 * locked, and this says which plan unlocks it. Never drawn under a control that
 * is already *on*: switching a paid control off never needs a plan, and a lock
 * beside a switch the organisation can still use would read as "you are stuck
 * with this".
 */
export function PlanLock({
  what,
  upgradeTo,
  id,
}: {
  /** The act, as a phrase that can start a sentence: "Requiring an IP allowlist". */
  what: string;
  upgradeTo: string | null;
  /** For `aria-describedby` on the control it explains. */
  id?: string;
}) {
  const comparePlans = usePlansHref();

  return (
    <p id={id} className="text-fg-subtle text-sm leading-5">
      {upgradeSentence(what, upgradeTo)}{' '}
      <Link href={comparePlans} className={LINK}>
        Compare plans
      </Link>
    </p>
  );
}

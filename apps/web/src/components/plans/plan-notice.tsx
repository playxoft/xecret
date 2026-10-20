'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

import { errorMessage, isApiError } from '@/lib/api';
import { Alert } from '@/components/ui';
import { planName, planRefusalOf, upgradeSentence, withoutReasonPrefix } from './plan-copy';

/**
 * Where "compare plans" goes.
 *
 * The public pricing page rather than a checkout: the dashboard has no billing
 * screen of its own yet, and a link that names the plan and lands on the table
 * that describes it is honest about what happens next. When a billing screen
 * exists, this one constant is what changes.
 */
export const PLANS_HREF = '/pricing';

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
          <Link href={PLANS_HREF} className={LINK}>
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
  return (
    <p id={id} className="text-fg-subtle text-sm leading-5">
      {upgradeSentence(what, upgradeTo)}{' '}
      <Link href={PLANS_HREF} className={LINK}>
        Compare plans
      </Link>
    </p>
  );
}

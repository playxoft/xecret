import Link from 'next/link';

import { formatAbsoluteTime } from '@/lib/format';
import { Alert } from '@/components/ui';
import type { BillingStatusPayload } from '@/server/schemas/billing';
import { planName } from './plan-copy';

/**
 * A complimentary plan, as its owner is told about it — on the billing screen
 * and on the plans page, in the same words.
 *
 * A grant is a paid plan with nothing behind it at the payment provider: an
 * admin gave it, or the owner redeemed a free-plan code. It replaces the
 * "Managed by xecret support" notice for that case, because "arranged with us
 * directly" is true of an Enterprise contract and only half the story of a
 * free month: what the owner needs is that it is free, and when it stops.
 *
 * Shown only when the billing answer carries `grant`; an Enterprise contract
 * without one keeps the support notice it always had.
 */

/** "until 1 Mar 2027, 00:00", or "with no end date". */
export function grantTerm(endsAt: string | null): string {
  return endsAt === null ? 'with no end date' : `until ${formatAbsoluteTime(endsAt)}`;
}

export function ComplimentaryPlanNotice({
  plan,
  grant,
}: {
  plan: BillingStatusPayload['plan'];
  grant: NonNullable<BillingStatusPayload['grant']>;
}) {
  return (
    <Alert tone="info" title={`Complimentary ${planName(plan)} plan`}>
      <p>
        From xecret, {grantTerm(grant.endsAt)} — there is nothing to pay.
        {grant.endsAt !== null
          ? ' When it ends the organisation moves to Free, and nothing is deleted.'
          : ''}{' '}
        <Link href="/contact" className="text-fg font-medium underline underline-offset-4">
          Contact us
        </Link>{' '}
        to change it.
      </p>
      {/* Where it came from, in the server's words — the code that was
          redeemed, or what the admin who gave it wrote. Plain text only. */}
      {grant.note !== null && grant.note.length > 0 ? <p className="mt-1.5">{grant.note}</p> : null}
    </Alert>
  );
}

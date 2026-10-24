import type { BillingReminderKind } from '@xecret/db/schema';
import type { MailMessage } from '../mail';
import { formatDay, formatMinor, OVERAGE_RATE_TEXT } from './money';

/**
 * The billing emails (P21's billing list, built with P12).
 *
 * Every one to the organisation's owners, and every one in the discipline the
 * invitation email set: what happened, what to do, a link into the dashboard,
 * and nothing else. **No secret, key name, token or vault fact ever appears in
 * one** (03-features §P21): they link to the billing screen, and the billing
 * screen needs a signed-in owner.
 *
 * And every one that is about a payment going wrong says the sentence the
 * product is built on, in so many words: **your builds are unaffected.** A
 * secret fetch is never refused for a billing reason (`isDataPlaneActive`), and
 * the email most likely to be read is the place that promise has to be made.
 *
 * Amounts are Dodo's, in the subscription's own currency and before tax; a
 * figure that cannot be shown honestly is left out rather than approximated.
 */

/** The sentence. Exported so a test can hold every payment email to it. */
export const BUILDS_UNAFFECTED =
  'Your builds are unaffected: xecret run, CI and every secret keep working exactly as before.';

export type BillingReminder =
  | { kind: 'trial_ending_3d' | 'trial_ending_1d'; plan: string; trialEndsAt: Date }
  | {
      kind: 'payment_failed';
      plan: string;
      /**
       * The payment was for a plan not yet held — a first checkout's — so
       * there is no subscription to speak of, and nothing of the plan is lost.
       */
      firstPayment: boolean;
    }
  | { kind: 'card_expiring'; expiresAfter: Date; renewsAt: Date | null }
  | {
      kind: 'renewal_upcoming';
      plan: string;
      renewsAt: Date;
      amountMinor: number | null;
      currency: string | null;
    }
  | {
      kind: 'seats_changed';
      seats: number;
      previousSeats: number;
      interval: 'monthly' | 'yearly';
      /** The new recurring charge, when known — Dodo's next snapshot is what knows it. */
      amountMinor?: number | null;
      currency?: string | null;
    }
  | { kind: 'usage_80' | 'usage_100'; used: number; included: number }
  | { kind: 'invoice_available' }
  | { kind: 'plan_ended_unpaid'; plan: string; days: number };

/** Every kind the database accepts has a template — the type and the CHECK agree. */
const KINDS: Readonly<Record<BillingReminderKind, true>> = {
  trial_ending_3d: true,
  trial_ending_1d: true,
  payment_failed: true,
  card_expiring: true,
  renewal_upcoming: true,
  seats_changed: true,
  usage_80: true,
  usage_100: true,
  invoice_available: true,
  plan_ended_unpaid: true,
};
export const REMINDER_KINDS = Object.keys(KINDS) as BillingReminderKind[];

interface Composed {
  subject: string;
  /** Paragraphs, plain text. The HTML is built from the same ones. */
  lines: readonly string[];
  action: string;
}

const planName = (plan: string) => plan.charAt(0).toUpperCase() + plan.slice(1);
const count = (value: number) => value.toLocaleString('en-GB');

function compose(reminder: BillingReminder, organization: string): Composed {
  switch (reminder.kind) {
    case 'trial_ending_3d':
    case 'trial_ending_1d': {
      const when = reminder.kind === 'trial_ending_1d' ? 'tomorrow' : 'in 3 days';
      return {
        subject: `Your ${planName(reminder.plan)} trial for ${organization} ends ${when}`,
        lines: [
          `The ${planName(reminder.plan)} trial for ${organization} ends ${when}, on ` +
            `${formatDay(reminder.trialEndsAt)}. When it does, the card on file is charged for ` +
            'the first billing period.',
          // What actually happens, in order: Dodo puts a subscription whose
          // first charge fails on hold; the plan keeps working while it is;
          // and after fourteen days on hold the hourly job moves the
          // organisation to Free (`jobs.ts`, HOLD_LIMIT_MS).
          'If there is no card on file, or the charge does not go through, the subscription is ' +
            'put on hold: the plan keeps working for 14 days while you add a card from the ' +
            'billing page, and after that the organisation moves to Free. Nothing is deleted ' +
            'either way.',
          BUILDS_UNAFFECTED,
        ],
        action: 'Open billing',
      };
    }
    case 'payment_failed':
      return reminder.firstPayment
        ? {
            subject: `A payment for ${organization} didn't go through`,
            lines: [
              `The payment for ${organization}'s new ${planName(reminder.plan)} plan was ` +
                `declined, so nothing was bought and nothing was charged. ${organization} stays ` +
                'on the plan it has now.',
              BUILDS_UNAFFECTED,
              'To try again, choose the plan from the billing page.',
            ],
            action: 'Open billing',
          }
        : {
            subject: `A payment for ${organization} didn't go through`,
            lines: [
              `A payment for ${organization}'s ${planName(reminder.plan)} subscription was ` +
                'declined.',
              BUILDS_UNAFFECTED,
              'Our payment provider will try again over the next few days. To fix it now, ' +
                'update the card from the billing page — "Manage billing" opens the customer ' +
                'portal. A subscription still unpaid after 14 days on hold ends, and the ' +
                'organisation moves to Free; nothing is deleted.',
            ],
            action: 'Update the card',
          };
    case 'plan_ended_unpaid':
      return {
        subject: `${organization} has moved to the Free plan`,
        lines: [
          `${organization}'s ${planName(reminder.plan)} subscription has been on hold for ` +
            `${count(reminder.days)} days without a successful payment, so the organisation is ` +
            'now on Free. Nothing was deleted: every secret is still there and still readable.',
          BUILDS_UNAFFECTED,
          `To return to ${planName(reminder.plan)}, update the card from the billing page — ` +
            '"Manage billing" opens the customer portal — or choose a plan again.',
        ],
        action: 'Open billing',
      };
    case 'card_expiring':
      return {
        subject: `The card for ${organization} expires soon`,
        lines: [
          `The card ${organization}'s subscription is paid with expires at the end of ` +
            `${new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(reminder.expiresAfter)}` +
            (reminder.renewsAt
              ? `, before the next renewal on ${formatDay(reminder.renewsAt)}.`
              : '.'),
          'Update it from the billing page — "Manage billing" opens the customer portal.',
          BUILDS_UNAFFECTED,
        ],
        action: 'Update the card',
      };
    case 'renewal_upcoming': {
      const amount = formatMinor(reminder.amountMinor, reminder.currency);
      return {
        subject: `${organization}'s yearly ${planName(reminder.plan)} subscription renews on ${formatDay(reminder.renewsAt)}`,
        lines: [
          `${organization}'s yearly ${planName(reminder.plan)} subscription renews on ` +
            `${formatDay(reminder.renewsAt)}` +
            (amount ? `, for ${amount} before tax.` : '.'),
          'Nothing to do if that is expected. To change the plan, the seats or cancel, use the ' +
            'billing page before then.',
        ],
        action: 'Review billing',
      };
    }
    case 'seats_changed': {
      const amount = formatMinor(reminder.amountMinor ?? null, reminder.currency ?? null);
      const period = reminder.interval === 'yearly' ? 'yearly' : 'monthly';
      return {
        subject: `${organization} is now billed for ${count(reminder.seats)} seats`,
        lines: [
          `${organization}'s membership changed, so it is now billed for ${count(reminder.seats)} ` +
            `seats (it was ${count(reminder.previousSeats)}).` +
            (amount ? ` The ${period} charge is now ${amount} before tax.` : ''),
          // Dodo's `prorated_immediately_keep_cycle`, the mode the seat sync
          // uses: the difference for the time left in the period, the period
          // itself unchanged; a negative difference goes to the Dodo customer's
          // wallet — one customer per organisation — which Dodo applies to
          // the next charges automatically and never refunds to the card
          // (https://docs.dodopayments.com/features/customer-wallet).
          'Adding a member charges the difference for the rest of the current period; removing ' +
            'one leaves the difference as credit on the organisation’s billing account, used ' +
            'against its next charges. A pending invitation is not billed until it is accepted.',
        ],
        action: 'Review billing',
      };
    }
    case 'usage_80':
    case 'usage_100': {
      const share = reminder.kind === 'usage_100' ? 'all' : '80%';
      return {
        // The allowance is monthly, and so is what it is counted over — a
        // yearly plan's month runs from its billing date (`USAGE_PERIOD_START`).
        subject: `${organization} has used ${share} of this month's secret fetches`,
        lines: [
          `${organization} has made ${count(reminder.used)} secret fetches this month, ` +
            `${share === 'all' ? 'all' : '80%'} of the ${count(reminder.included)} a month its ` +
            'plan includes.',
          `Nothing stops at the allowance. Fetches past it keep working and are billed at ` +
            `${OVERAGE_RATE_TEXT}, on the next invoice.`,
        ],
        action: 'See usage',
      };
    }
    case 'invoice_available':
      return {
        subject: `A receipt for ${organization} is ready`,
        lines: [
          `A payment for ${organization}'s subscription went through.`,
          'The invoice is in the customer portal: open the billing page and choose "Manage billing".',
        ],
        action: 'Open billing',
      };
  }
}

/** One billing email, to one owner. */
export function billingMail(
  reminder: BillingReminder,
  context: { to: string; toName: string | null; organizationName: string; billingUrl: string },
): MailMessage {
  const composed = compose(reminder, context.organizationName);

  const text = [
    'Hello,',
    '',
    ...composed.lines.flatMap((line) => [line, '']),
    `${composed.action}: ${context.billingUrl}`,
    '',
    'You are receiving this because you are an owner of this organisation on xecret.',
    '',
    '— xecret',
  ].join('\n');

  const paragraphs = composed.lines
    .map(
      (line) =>
        `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;">${escapeHtml(line)}</p>`,
    )
    .join('\n      ');

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1c1e21;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e3e5e8;border-radius:12px;padding:32px;">
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Hello,</p>
      ${paragraphs}
      <p style="margin:8px 0 24px;">
        <a href="${escapeHtml(context.billingUrl)}"
           style="display:inline-block;background:#1c1e21;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px;font-weight:500;">
          ${escapeHtml(composed.action)}
        </a>
      </p>
      <hr style="border:0;border-top:1px solid #e3e5e8;margin:0 0 24px;" />
      <p style="margin:0;font-size:13px;line-height:1.6;color:#6b7078;">
        You are receiving this because you are an owner of this organisation on xecret.
      </p>
    </div>
  </body>
</html>`;

  return {
    to: context.to,
    ...(context.toName ? { toName: context.toName } : {}),
    // The organisation's name is in it, and a name is never a header's line break.
    subject: composed.subject.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' '),
    text,
    html,
  };
}

/** The organisation name is user-chosen; every interpolation is escaped. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

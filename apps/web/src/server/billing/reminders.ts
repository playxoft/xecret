import {
  claimReminder,
  findBillingOrganization,
  listOwnerRecipients,
  reminderSentSince,
} from '@xecret/db/repositories';
import type { Database } from '@xecret/db';
import { publicOrigin } from '../bindings';
import type { Bindings } from '../bindings';
import { describeMailFailure, mailerFrom } from '../mail';
import type { Logger } from '../logging';
import { billingMail } from './mail';
import type { BillingReminder } from './mail';

/**
 * Sending one billing reminder, once (P12, with P21's billing list).
 *
 * ── Once, by construction ──
 * `billing_reminders`' primary key — organisation, kind, occasion — is the
 * deduplication, exactly as `billing_webhook_events` is for deliveries. The
 * reminder is claimed *before* the mail goes, so a webhook delivered three
 * times, or two hourly runs racing, produce one email. The trade is stated
 * plainly: a mail provider that is down at that moment costs this reminder
 * rather than duplicating it, and a missed "your card failed" still has the
 * dashboard banner and Dodo's own retries behind it — while five copies of it
 * is the mail bomb a reminder system must never become.
 *
 * ── Throttled, by kind ──
 * Payment failures repeat on Dodo's dunning schedule, and each retry is a new
 * payment with an occasion of its own. One email per organisation per
 * {@link PAYMENT_FAILED_THROTTLE_MS} is the most anybody needs to be told.
 *
 * ── Degrades to nothing but the dashboard ──
 * A deployment with no mail provider sends nothing and claims nothing; the
 * billing screen carries the same facts as banners (03-features §P21: every
 * notification degrades to an in-app item). An organisation whose owners are
 * all suspended or deleted is told nothing either — there is nobody to tell.
 */

export const PAYMENT_FAILED_THROTTLE_MS = 20 * 60 * 60 * 1000;

export type ReminderOutcome = 'sent' | 'duplicate' | 'throttled' | 'no-mailer' | 'no-recipients';

export interface ReminderServices {
  env: Bindings;
  db: Database;
  log: Logger;
}

export async function sendBillingReminder(
  services: ReminderServices,
  params: { orgId: string; occasion: string; reminder: BillingReminder },
): Promise<ReminderOutcome> {
  const { orgId, occasion, reminder } = params;
  const log = services.log.at('sendBillingReminder');

  const mailer = mailerFrom(services.env);
  if (mailer === null) return 'no-mailer';

  const organization = await findBillingOrganization(services.db, orgId);
  if (organization === null) return 'no-recipients';
  const recipients = await listOwnerRecipients(services.db, orgId);
  if (recipients.length === 0) return 'no-recipients';

  if (
    reminder.kind === 'payment_failed' &&
    (await reminderSentSince(
      services.db,
      orgId,
      'payment_failed',
      new Date(Date.now() - PAYMENT_FAILED_THROTTLE_MS),
    ))
  ) {
    return 'throttled';
  }

  if (!(await claimReminder(services.db, { orgId, kind: reminder.kind, occasion }))) {
    return 'duplicate';
  }

  const billingUrl = `${publicOrigin(services.env)}/app/${encodeURIComponent(organization.slug)}/settings/billing`;
  let delivered = 0;
  for (const recipient of recipients) {
    try {
      await mailer.send(
        billingMail(reminder, {
          to: recipient.email,
          toName: recipient.displayName,
          organizationName: organization.name,
          billingUrl,
        }),
      );
      delivered += 1;
    } catch (cause) {
      // The address is never logged; the provider's explanation is, scrubbed.
      log.warn(`A ${reminder.kind} billing email to an owner was not delivered`, {
        orgId,
        kind: reminder.kind,
        ...describeMailFailure(cause),
      });
    }
  }

  log.info(`Sent the ${reminder.kind} billing email to ${delivered} owner(s)`, {
    orgId,
    kind: reminder.kind,
    recipientCount: delivered,
  });
  return 'sent';
}

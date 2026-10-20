import { describe, expect, it } from 'vitest';
import { FETCHES_PER_METERED_UNIT } from '@xecret/core/entitlements';
import { BILLING_REMINDER_KINDS } from '@xecret/db/schema';
import { billingMail, BUILDS_UNAFFECTED, REMINDER_KINDS } from './mail';
import type { BillingReminder } from './mail';
import { formatMinor, OVERAGE_RATE_TEXT } from './money';

/**
 * The billing emails: what they say, and — as much — what they never say.
 */

const CONTEXT = {
  to: 'owner@example.com',
  toName: 'Owner',
  organizationName: 'Acme <script>',
  billingUrl: 'https://xecret.playxoft.com/app/acme/settings/billing',
};

type Example<K extends BillingReminder['kind']> = BillingReminder & { kind: K };

const EXAMPLES: { [K in BillingReminder['kind']]: Example<K> } = {
  trial_ending_3d: { kind: 'trial_ending_3d', plan: 'team', trialEndsAt: new Date('2026-11-03') },
  trial_ending_1d: { kind: 'trial_ending_1d', plan: 'team', trialEndsAt: new Date('2026-11-03') },
  payment_failed: { kind: 'payment_failed', plan: 'team' },
  card_expiring: {
    kind: 'card_expiring',
    expiresAfter: new Date('2026-11-30'),
    renewsAt: new Date('2026-12-02'),
  },
  renewal_upcoming: {
    kind: 'renewal_upcoming',
    plan: 'team',
    renewsAt: new Date('2026-11-20'),
    amountMinor: 1349700,
    currency: 'INR',
  },
  seats_changed: {
    kind: 'seats_changed',
    seats: 6,
    previousSeats: 5,
    interval: 'monthly',
    amountMinor: 11400,
    currency: 'USD',
  },
  usage_80: { kind: 'usage_80', used: 800_000, included: 1_000_000 },
  usage_100: { kind: 'usage_100', used: 1_000_000, included: 1_000_000 },
  invoice_available: { kind: 'invoice_available' },
};

describe('billingMail', () => {
  it('has a template for exactly the kinds the database accepts', () => {
    expect([...REMINDER_KINDS].sort()).toEqual([...BILLING_REMINDER_KINDS].sort());
  });

  it('says "your builds are unaffected" in every email about a payment going wrong', () => {
    for (const kind of [
      'payment_failed',
      'card_expiring',
      'trial_ending_3d',
      'trial_ending_1d',
    ] as const) {
      const mail = billingMail(EXAMPLES[kind], CONTEXT);
      expect(mail.text, kind).toContain(BUILDS_UNAFFECTED);
      expect(mail.html, kind).toContain(BUILDS_UNAFFECTED.replace(/'/g, '&#39;'));
    }
  });

  it('links to the billing screen, which needs a signed-in owner, and to nothing else', () => {
    for (const reminder of Object.values(EXAMPLES)) {
      const mail = billingMail(reminder, CONTEXT);
      const links = [...mail.html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
      expect(links, reminder.kind).toEqual([CONTEXT.billingUrl]);
      expect(mail.text).toContain(CONTEXT.billingUrl);
    }
  });

  it('escapes the organisation name, which its members chose', () => {
    const mail = billingMail(EXAMPLES.payment_failed, CONTEXT);
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('Acme &lt;script&gt;');
  });

  it('keeps a line break in a name out of the subject header', () => {
    const mail = billingMail(EXAMPLES.invoice_available, {
      ...CONTEXT,
      organizationName: 'Acme\r\nBcc: someone@example.com',
    });
    expect(mail.subject).not.toMatch(/[\r\n]/);
  });

  it('quotes Dodo’s amount in the subscription’s own currency, or no amount at all', () => {
    expect(billingMail(EXAMPLES.renewal_upcoming, CONTEXT).text).toContain('₹13,497.00 before tax');
    expect(billingMail(EXAMPLES.seats_changed, CONTEXT).text).toContain('$114.00 before tax');

    const unknown = billingMail({ ...EXAMPLES.renewal_upcoming, amountMinor: null }, CONTEXT);
    expect(unknown.text).not.toMatch(/before tax/);
  });

  it('states the overage rate on the usage emails, and that nothing stops', () => {
    const mail = billingMail(EXAMPLES.usage_100, CONTEXT);
    expect(mail.text).toContain(OVERAGE_RATE_TEXT);
    expect(mail.text).toContain('Nothing stops at the allowance');
  });

  it('never carries anything shaped like a credential or a provider identifier', () => {
    for (const reminder of Object.values(EXAMPLES)) {
      const mail = billingMail(reminder, CONTEXT);
      for (const body of [mail.text, mail.html, mail.subject]) {
        expect(body).not.toMatch(/\b(?:cus|sub|pay|pdt|whsec)_[A-Za-z0-9]{6,}/);
        expect(body).not.toMatch(/\bxct_|xst_/);
      }
    }
  });
});

describe('money', () => {
  it('formats the smallest unit by the currency’s own decimals', () => {
    expect(formatMinor(14400, 'USD')).toBe('$144.00');
    expect(formatMinor(15800, 'JPY')).toBe('¥15,800');
    expect(formatMinor(449900, 'INR')).toBe('₹4,499.00');
    expect(formatMinor(null, 'USD')).toBeNull();
    expect(formatMinor(100, 'usd')).toBeNull();
    expect(formatMinor(1.5, 'USD')).toBeNull();
  });

  it('states the rate the meter charges', () => {
    // One metered unit is a thousand fetches at a cent: the sentence holds.
    expect(FETCHES_PER_METERED_UNIT).toBe(1000);
    expect(OVERAGE_RATE_TEXT).toContain('$0.01 per 1,000');
    expect(OVERAGE_RATE_TEXT).toContain('$1 per 100,000');
  });
});

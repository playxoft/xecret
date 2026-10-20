/**
 * Money as this server shows it — in an email or on the billing screen — and
 * never as it decides anything. Every figure here came from Dodo; nothing is
 * computed into a price.
 */

/**
 * The overage rate, as pricing-plan §2 Idea 6 and Dodo's meter state it: one
 * metered unit is `FETCHES_PER_METERED_UNIT` fetches, priced at a cent.
 * `money.test.ts` holds the sentence to the constant.
 */
export const OVERAGE_RATE_TEXT =
  '$0.01 per 1,000 secret fetches past the allowance ($1 per 100,000)';

/** Decimal places a currency's smallest unit has — 0 for yen, 2 for most. */
function fractionDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/**
 * An amount in a currency's smallest unit, as a person reads it: `₹4,499.00`,
 * `¥15,800`, `$144.00`. `null` for an amount or a currency that cannot be
 * shown honestly — the caller then says nothing about money rather than
 * something wrong.
 */
export function formatMinor(amountMinor: number | null, currency: string | null): string | null {
  if (amountMinor === null || currency === null || !Number.isSafeInteger(amountMinor)) return null;
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  try {
    const digits = fractionDigits(currency);
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(amountMinor / 10 ** digits);
  } catch {
    return null;
  }
}

/** A date as a person reads it, in UTC: `20 November 2026`. */
export function formatDay(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

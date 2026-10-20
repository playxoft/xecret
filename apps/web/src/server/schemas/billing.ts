import * as z from 'zod/mini';

/**
 * The billing screen's API (P12): the two request bodies it sends, and the
 * status every billing route answers with.
 *
 * ── What the client may say ──
 * A plan and a billing period. Nothing else — not a price, not a seat count,
 * not a currency (overview §0, money rule 3). The seats are counted from the
 * membership, the currency follows the billing country Dodo records, and the
 * price is whatever the Dodo product says.
 */

const UNEXPECTED_FIELD = 'The request contains a field this endpoint does not accept.';

export const billingPlanSchema = z.enum(['pro', 'team'], {
  error: 'Choose Pro or Team. Enterprise is arranged with us directly.',
});
export const billingIntervalSchema = z.enum(['monthly', 'yearly'], {
  error: 'Choose monthly or yearly billing.',
});

/** `POST …/billing/checkout` and `POST …/billing/change`. */
export const billingSelectionSchema = z.strictObject(
  { plan: billingPlanSchema, interval: billingIntervalSchema },
  UNEXPECTED_FIELD,
);
export type BillingSelection = z.infer<typeof billingSelectionSchema>;

/** `GET …/billing/change?plan=&interval=` — the same selection, from the query. */
export const billingPreviewQuerySchema = z.object({
  plan: billingPlanSchema,
  interval: billingIntervalSchema,
});

/** A ceiling the organisation is near or past, for a warning banner. */
export interface BillingWarning {
  resource: 'seats' | 'projects' | 'serviceTokens';
  /** The ceiling, or `null` where only a fair-use ceiling applies. */
  limit: number | null;
  current: number;
  /** At or past the ceiling, rather than within 80% of it. */
  atLimit: boolean;
}

/** What every billing route answers with, under `billing`. */
export interface BillingStatusPayload {
  /** Whether this deployment takes payments at all. */
  enabled: boolean;
  /** Dodo's test or live mode, shown so nobody pays a test checkout believing it real. */
  mode: 'test_mode' | 'live_mode' | null;
  plan: 'free' | 'pro' | 'team' | 'enterprise';
  status: 'active' | 'trialing' | 'past_due' | 'on_hold' | 'cancelled' | 'expired';
  interval: 'monthly' | 'yearly' | null;
  /**
   * How the plan came to be: through checkout (`checkout`), set by xecret
   * support (`support` — an Enterprise contract, a grant), or never bought.
   */
  managedBy: 'checkout' | 'support' | 'none';
  seats: {
    /** What the subscription bills for. */
    billed: number;
    /** Members holding a seat, whatever their status. */
    seated: number;
    /** Open invitations — not billed until accepted. */
    pendingInvitations: number;
    /** The plan's billing floor. */
    minimum: number;
  };
  currency: string | null;
  /** The end of the paid period: the next renewal, or when a cancellation takes effect. */
  renewsAt: string | null;
  cancelAtPeriodEnd: boolean;
  trialEndsAt: string | null;
  /** The next renewal's charge before tax, formatted, or `null` when not known. */
  renewalAmount: string | null;
  /** While it holds, the country and currency checkout is pinned to (pricing-plan §4). */
  regionLock: { until: string; country: string | null; currency: string | null } | null;
  usage: {
    periodStart: string;
    secretFetches: number;
    includedFetches: number;
    /** Overage units already reported to Dodo this period (one per thousand fetches). */
    unitsReported: number;
    overageRate: string;
  };
  warnings: BillingWarning[];
  addons: { saml: boolean };
  /** What the owner can do from here, so the screen draws only what will work. */
  actions: { checkout: boolean; changePlan: boolean; portal: boolean };
}

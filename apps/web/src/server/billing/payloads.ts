import * as z from 'zod/mini';

/**
 * The parts of Dodo's objects this server reads, and nothing else.
 *
 * Every webhook payload and API response passes through one of these before
 * any field is used. Two reasons, and the second is the one that matters:
 *
 *  1. A malformed payload is refused in one place, with one answer, instead of
 *     surfacing as a `TypeError` three functions deep in a handler that had
 *     already changed half a row.
 *  2. **Unknown fields are dropped.** Dodo's objects carry customer names,
 *     addresses, card networks and the last four digits of cards. None of it is
 *     declared here, so none of it survives parsing — and what does not exist
 *     in a value cannot be spread into a log line or an audit record by
 *     accident.
 *
 * Shapes follow the published API (the `dodopayments` SDK's generated types,
 * read for reference — the SDK itself is not a dependency; see `client.ts`).
 */

const id = z.string().check(z.minLength(1), z.maxLength(255));
const isoDate = z.string().check(z.minLength(10), z.maxLength(64));
const optionalNullable = <T extends z.ZodMiniType>(schema: T) => z.optional(z.nullable(schema));

/** Dodo's subscription statuses. A value outside them is refused, not guessed at. */
export const dodoSubscriptionStatusSchema = z.enum([
  'pending',
  'active',
  'on_hold',
  'paused',
  'cancelled',
  'failed',
  'expired',
  'past_due',
]);
export type DodoSubscriptionStatus = z.infer<typeof dodoSubscriptionStatusSchema>;

/** Metadata values Dodo accepts: strings, numbers, booleans. */
const metadataSchema = z.optional(
  z.nullable(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))),
);

/** A subscription, as `GET /subscriptions/{id}` and every `subscription.*` webhook carry it. */
export const dodoSubscriptionSchema = z.object({
  subscription_id: id,
  status: dodoSubscriptionStatusSchema,
  product_id: id,
  quantity: z.number().check(z.int(), z.gte(0), z.lte(1_000_000)),
  currency: z.string().check(z.regex(/^[A-Z]{3}$/)),
  customer: z.object({ customer_id: id }),
  billing: z.object({ country: z.string().check(z.regex(/^[A-Z]{2}$/)) }),
  metadata: metadataSchema,
  next_billing_date: isoDate,
  previous_billing_date: isoDate,
  cancel_at_next_billing_date: z.boolean(),
  trial_period_days: z.number().check(z.int(), z.gte(0)),
  created_at: isoDate,
  recurring_pre_tax_amount: z.number().check(z.int(), z.gte(0)),
  addons: z.optional(
    z.nullable(z.array(z.object({ addon_id: id, quantity: z.number().check(z.int()) }))),
  ),
  expires_at: optionalNullable(isoDate),
  cancelled_at: optionalNullable(isoDate),
  payment_method_id: optionalNullable(id),
});
export type DodoSubscription = z.infer<typeof dodoSubscriptionSchema>;

/** A payment, as every `payment.*` webhook carries it. */
export const dodoPaymentSchema = z.object({
  payment_id: id,
  subscription_id: optionalNullable(id),
  checkout_session_id: optionalNullable(id),
  customer: z.object({ customer_id: id }),
  billing: z.object({ country: z.string().check(z.regex(/^[A-Z]{2}$/)) }),
  /** The card-issuing country, where the payment was by card. The PPP guardrail's other half. */
  card_issuing_country: optionalNullable(z.string().check(z.regex(/^[A-Z]{2}$/))),
  currency: z.string().check(z.regex(/^[A-Z]{3}$/)),
  metadata: metadataSchema,
  retry_attempt: z.optional(z.number().check(z.int(), z.gte(0))),
});
export type DodoPayment = z.infer<typeof dodoPaymentSchema>;

/** A refund (`refund.succeeded`). */
export const dodoRefundSchema = z.object({
  refund_id: id,
  payment_id: id,
  customer: z.optional(z.object({ customer_id: id })),
  is_partial: z.optional(z.boolean()),
});
export type DodoRefund = z.infer<typeof dodoRefundSchema>;

/** A dispute (`dispute.opened`). */
export const dodoDisputeSchema = z.object({
  dispute_id: id,
  payment_id: id,
});
export type DodoDispute = z.infer<typeof dodoDisputeSchema>;

/**
 * A licence key (`license_key.created`).
 *
 * **`key` is not declared**, so the licence key itself — which the payload does
 * carry — is dropped by the parse and never reaches anything this server keeps
 * or logs. Dodo emails it to the buyer; that is the only place it needs to be.
 */
export const dodoLicenseKeySchema = z.object({
  id,
  product_id: id,
  customer_id: optionalNullable(id),
  subscription_id: optionalNullable(id),
  payment_id: optionalNullable(id),
  activations_limit: optionalNullable(z.number().check(z.int(), z.gte(0))),
  expires_at: optionalNullable(isoDate),
  created_at: optionalNullable(isoDate),
});
export type DodoLicenseKey = z.infer<typeof dodoLicenseKeySchema>;

/** The envelope every webhook arrives in. `data` is parsed per type, by the handler. */
export const dodoWebhookEnvelopeSchema = z.object({
  type: z.string().check(z.minLength(1), z.maxLength(64), z.regex(/^[a-z_]+\.[a-z_]+$/)),
  timestamp: isoDate,
  data: z.unknown(),
});
export type DodoWebhookEnvelope = z.infer<typeof dodoWebhookEnvelopeSchema>;

/** `POST /checkouts`. */
export const dodoCheckoutSessionSchema = z.object({
  session_id: id,
  checkout_url: z.string().check(z.minLength(1), z.maxLength(2048)),
});

/** `POST /subscriptions/{id}/change-plan/preview`. */
export const dodoPlanPreviewSchema = z.object({
  immediate_charge: z.object({
    summary: z.object({
      currency: z.string().check(z.regex(/^[A-Z]{3}$/)),
      total_amount: z.number().check(z.int()),
    }),
  }),
});

/** `POST /customers/{id}/customer-portal/session`. */
export const dodoPortalSessionSchema = z.object({
  link: z.string().check(z.minLength(1), z.maxLength(2048)),
});

/** `GET /customers/{id}/payment-methods`, reduced to the expiry of cards. */
export const dodoPaymentMethodsSchema = z.object({
  items: z.array(
    z.object({
      payment_method_id: id,
      card: optionalNullable(
        z.object({
          expiry_month: optionalNullable(z.string()),
          expiry_year: optionalNullable(z.string()),
        }),
      ),
    }),
  ),
});

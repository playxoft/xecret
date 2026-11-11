import * as z from 'zod/mini';

/**
 * The admin page's API (`/api/admin/*`): the bodies it accepts and the shapes
 * it answers with — and the owner's side of a promo code, under
 * `/api/orgs/{orgSlug}/billing/promo-code`.
 *
 * Who may call the admin routes at all is `server/admin.ts`. Everything here
 * is still validated as if the caller were hostile, because the allow-list is
 * one environment variable and a mistake in it is the whole of the defence.
 */

const UNEXPECTED_FIELD = 'The request contains a field this endpoint does not accept.';

/** A promo code as Dodo accepts it: upper-case letters and digits, 3 to 16. */
export const PROMO_CODE_PATTERN = /^[A-Z0-9]{3,16}$/;

/** The longest a reason, a note or a description may be. */
export const ADMIN_TEXT_MAX_LENGTH = 200;

/** How far ahead a grant or a code's expiry may be set: ten years. */
export const ADMIN_MAX_DAYS = 3650;

/** At most this many addresses on one code's allow-list. */
export const PROMO_MAX_ALLOWED_EMAILS = 100;

const grantablePlanSchema = z.enum(['pro', 'team', 'enterprise'], {
  error: 'Choose Pro, Team or Enterprise.',
});
const checkoutPlanSchema = z.enum(['pro', 'team'], {
  error: 'A discount applies at checkout, which sells Pro and Team.',
});

const reasonSchema = z
  .string()
  .check(
    z.trim(),
    z.minLength(1, 'Say why — it goes in the organisation’s audit log.'),
    z.maxLength(ADMIN_TEXT_MAX_LENGTH, `At most ${ADMIN_TEXT_MAX_LENGTH} characters.`),
  );

/** An ISO-8601 instant, parsed; the route checks it is in the future. */
const instantSchema = z.string().check(
  z.refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'Give a date and time, e.g. 2027-03-01T00:00:00Z.',
  }),
);

const seatsSchema = z
  .int('Seats must be a whole number.')
  .check(z.gte(1, 'At least one seat.'), z.lte(100_000, 'At most 100,000 seats.'));

/** `POST /api/admin/organizations/{orgId}/grant`. */
export const adminGrantSchema = z.strictObject(
  {
    plan: grantablePlanSchema,
    /** The seat ceiling to set; `null` keeps what invitations are refused against now, or more. */
    seats: z.nullable(seatsSchema),
    /** When it ends; `null` for no end. */
    endsAt: z.nullable(instantSchema),
    reason: reasonSchema,
    /** Take an organisation Dodo bills off its subscription first. */
    overDodo: z.boolean(),
  },
  UNEXPECTED_FIELD,
);
export type AdminGrantBody = z.infer<typeof adminGrantSchema>;

/** `POST /api/admin/organizations/{orgId}/grant/end`. */
export const adminEndGrantSchema = z.strictObject({ reason: reasonSchema }, UNEXPECTED_FIELD);

/** `GET /api/admin/organizations?q=` — an email address or an organisation slug. */
export const adminSearchQuerySchema = z.object({
  q: z
    .string()
    .check(
      z.trim(),
      z.minLength(3, 'Search by an email address or an organisation’s slug.'),
      z.maxLength(320, 'That is longer than any address or slug.'),
    ),
});

/** Lower-cased, de-duplicated, every one shaped like an address. */
const allowedEmailsSchema = z.nullable(
  z
    .array(
      z
        .string()
        .check(
          z.trim(),
          z.toLowerCase(),
          z.maxLength(320, 'An address is at most 320 characters.'),
          z.regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'One of the addresses is not an email address.'),
        ),
    )
    .check(
      z.minLength(1, 'Leave the list empty to let anybody with the code use it.'),
      z.maxLength(
        PROMO_MAX_ALLOWED_EMAILS,
        `At most ${PROMO_MAX_ALLOWED_EMAILS} addresses per code.`,
      ),
    ),
);

const grantPartSchema = z.strictObject(
  {
    plan: grantablePlanSchema,
    /** Days a redemption lasts; `null` for good. */
    days: z.nullable(
      z
        .int('Days must be a whole number.')
        .check(z.gte(1, 'At least a day.'), z.lte(ADMIN_MAX_DAYS, 'At most ten years.')),
    ),
    seats: z.nullable(seatsSchema),
  },
  UNEXPECTED_FIELD,
);

const discountPartSchema = z.strictObject(
  {
    type: z.enum(['percentage', 'flat'], { error: 'Choose a percentage or a fixed amount off.' }),
    /**
     * A percentage, 0.01 to 100 — or, for a fixed amount, the amount in the
     * currency's major unit (`5` for $5). Converted to Dodo's basis points or
     * minor units by the route.
     */
    value: z.number('Give a number.').check(z.gt(0, 'More than nothing off.')),
    /** ISO-4217, for a fixed amount only. */
    currency: z.nullable(
      z
        .string()
        .check(z.trim(), z.toUpperCase(), z.regex(/^[A-Z]{3}$/, 'A three-letter currency.')),
    ),
    /** Billing cycles the discount lasts; `null` for every renewal. */
    cycles: z.nullable(
      z
        .int('Cycles must be a whole number.')
        .check(z.gte(1, 'At least one cycle.'), z.lte(120, 'At most 120 cycles.')),
    ),
    plans: z.array(checkoutPlanSchema).check(
      z.minLength(1, 'Choose at least one plan.'),
      z.maxLength(2, 'Each plan may be chosen once.'),
      z.refine((plans) => new Set(plans).size === plans.length, {
        message: 'Each plan may be chosen once.',
      }),
    ),
  },
  UNEXPECTED_FIELD,
);

/** `POST /api/admin/promo-codes`. Exactly one of `grant` or `discount`, matching `kind`. */
export const adminPromoCodeCreateSchema = z
  .strictObject(
    {
      /** Omitted for a random one. Upper-cased before it is checked. */
      code: z.optional(
        z
          .string()
          .check(
            z.trim(),
            z.toUpperCase(),
            z.regex(PROMO_CODE_PATTERN, 'A code is 3 to 16 letters and digits.'),
          ),
      ),
      kind: z.enum(['grant', 'discount']),
      description: z.nullable(
        z
          .string()
          .check(
            z.trim(),
            z.maxLength(ADMIN_TEXT_MAX_LENGTH, `At most ${ADMIN_TEXT_MAX_LENGTH} characters.`),
          ),
      ),
      allowedEmails: allowedEmailsSchema,
      maxRedemptions: z.nullable(
        z
          .int('A whole number of uses.')
          .check(z.gte(1, 'At least one use.'), z.lte(100_000, 'At most 100,000 uses.')),
      ),
      expiresAt: z.nullable(instantSchema),
      grant: z.optional(grantPartSchema),
      discount: z.optional(discountPartSchema),
    },
    UNEXPECTED_FIELD,
  )
  .check(
    z.refine(
      (body) =>
        body.kind === 'grant'
          ? body.grant !== undefined && body.discount === undefined
          : body.discount !== undefined && body.grant === undefined,
      { message: 'Describe the free plan for a grant code, or the discount for a discount code.' },
    ),
  );
export type AdminPromoCodeCreateBody = z.infer<typeof adminPromoCodeCreateSchema>;

/** `POST /api/orgs/{orgSlug}/billing/promo-code` and `…/promo-code/redeem`. */
export const promoCodeBodySchema = z.strictObject(
  {
    code: z
      .string()
      .check(
        z.trim(),
        z.toUpperCase(),
        z.regex(PROMO_CODE_PATTERN, 'That is not a code we issued. Check it and try again.'),
      ),
  },
  UNEXPECTED_FIELD,
);

/* ── what the routes answer with ───────────────────────────────────────────── */

/** An organisation, as the admin page shows it. */
export interface AdminOrganizationPayload {
  id: string;
  name: string;
  slug: string;
  /** The searched-for person's role in it; `null` for a search by slug. */
  role: string | null;
  createdAt: string;
  plan: 'free' | 'pro' | 'team' | 'enterprise';
  status: 'active' | 'trialing' | 'past_due' | 'on_hold' | 'cancelled' | 'expired';
  interval: 'monthly' | 'yearly' | null;
  /** As the billing screen says it: bought at checkout, set by an admin, or neither. */
  managedBy: 'checkout' | 'support' | 'none';
  seats: { billed: number; limit: number };
  /** The grant, when `managedBy` is `support`. */
  grant: { endsAt: string | null; note: string | null } | null;
  /** Whether a grant here needs `overDodo` — Dodo bills it, or a paid checkout is waiting. */
  billedByDodo: boolean;
  awaitingActivation: boolean;
}

/** One grant, as the admin page lists them. */
export interface AdminGrantPayload {
  orgId: string;
  orgName: string;
  orgSlug: string;
  plan: 'free' | 'pro' | 'team' | 'enterprise';
  seatLimit: number;
  endsAt: string | null;
  note: string | null;
}

export type PromoCodeState = 'active' | 'expired' | 'revoked' | 'used-up';

/** One promo code, as the admin page lists them. */
export interface AdminPromoCodePayload {
  id: string;
  code: string;
  kind: 'grant' | 'discount';
  /** One sentence: what the code gives, e.g. "Team free for 30 days". */
  summary: string;
  description: string | null;
  grant: { plan: 'pro' | 'team' | 'enterprise'; days: number | null; seats: number | null } | null;
  discount: {
    type: 'percentage' | 'flat';
    /** A percentage (`12.5`), or an amount in the currency's major unit (`5`). */
    value: number;
    currency: string | null;
    cycles: number | null;
    plans: ('pro' | 'team')[];
    /** Which Dodo the code was made in. A code of the other mode applies to nothing here. */
    mode: 'test_mode' | 'live_mode';
  } | null;
  allowedEmails: string[] | null;
  maxRedemptions: number | null;
  /** Grant redemptions. A discount's uses are Dodo's to count. */
  redemptions: number;
  /** Checkouts started with a discount code. */
  checkoutsStarted: number;
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  state: PromoCodeState;
}

/** What an owner is told a code does, before redeeming or checking out with it. */
export interface PromoCodePreviewPayload {
  code: string;
  kind: 'grant' | 'discount';
  /** One sentence, e.g. "Team free for 30 days" or "50% off Pro for 3 months". */
  summary: string;
  /** A grant code: the plan it gives. */
  plan: 'pro' | 'team' | 'enterprise' | null;
  /** A discount code: the plans checkout applies it to. */
  plans: ('pro' | 'team')[] | null;
}

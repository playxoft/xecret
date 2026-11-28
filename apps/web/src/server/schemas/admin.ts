import * as z from 'zod/mini';
import { fromBase64Url, toBase64Url } from '@xecret/core/crypto';
import type { AdminCursor } from '@xecret/db/repositories';
import { errors } from '../errors';
import { isUuid } from './ids';

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
    z.minLength(1, 'Say why. It goes in the organisation’s audit log.'),
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

/** How many rows a page of the organisations or users list holds, unless asked for fewer. */
export const ADMIN_PAGE_DEFAULT = 50;
/** The most a page may hold. */
export const ADMIN_PAGE_MAX = 100;

/**
 * The paging half of a list's query: an opaque cursor from the previous page,
 * and how many rows to answer with. Plain `z.object` around these, like every
 * query schema: an unknown parameter is ignored, not refused.
 */
const pageFields = {
  cursor: z.optional(
    z.string().check(z.maxLength(200, 'The cursor is not one this endpoint issued.')),
  ),
  limit: z._default(
    z.pipe(
      z.coerce.number(),
      z
        .int('A page size is a whole number.')
        .check(
          z.gte(1, 'A page holds at least one row.'),
          z.lte(ADMIN_PAGE_MAX, `A page holds at most ${ADMIN_PAGE_MAX} rows.`),
        ),
    ),
    ADMIN_PAGE_DEFAULT,
  ),
};

/**
 * `GET /api/admin/organizations` — every live organisation newest first, a
 * page at a time; or, with `?q=`, the search: the organisations of the person
 * with that email address, or the one with that id (or that legacy slug). A
 * search is not paged (it answers at most fifty), so the paging parameters are
 * ignored beside `q`.
 */
export const adminOrganizationsQuerySchema = z.object({
  q: z.optional(
    z
      .string()
      .check(
        z.trim(),
        z.minLength(3, 'Search by an email address or an organisation ID.'),
        z.maxLength(320, 'That is longer than any address or ID.'),
      ),
  ),
  ...pageFields,
});

/**
 * `GET /api/admin/users` — every live account newest first, a page at a time;
 * with `?q=`, only those whose address contains it, in any case. Matched as
 * typed: `%` and `_` are characters to find, not wildcards
 * (`containsPattern`).
 */
export const adminUsersQuerySchema = z.object({
  q: z.optional(
    z
      .string()
      .check(
        z.trim(),
        z.minLength(3, 'Type at least three characters of an address.'),
        z.maxLength(320, 'That is longer than any address.'),
      ),
  ),
  ...pageFields,
});

/**
 * A list's keyset cursor, as an opaque string: base64url over `at|id`, where
 * `at` is the last row's `created_at` to the microsecond (`AdminCursor`).
 * Encoded so a client cannot mistake it for something to do arithmetic on, and
 * decoded as strictly as it was written, because a client can still hand back
 * anything it likes: a malformed cursor is a 400, not a 500 from the database.
 */
export function encodeAdminCursor(cursor: AdminCursor): string {
  return toBase64Url(new TextEncoder().encode(`${cursor.at}|${cursor.id}`));
}

const CURSOR_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export function decodeAdminCursor(value: string): AdminCursor {
  const malformed = () => errors.badRequest('The cursor is not one this endpoint issued.');

  let packed: string;
  try {
    packed = new TextDecoder('utf-8', { fatal: true }).decode(fromBase64Url(value));
  } catch {
    throw malformed();
  }

  const [at, id, ...rest] = packed.split('|');
  if (at === undefined || id === undefined || rest.length > 0) throw malformed();
  if (!CURSOR_AT_PATTERN.test(at) || Number.isNaN(Date.parse(at)) || !isUuid(id)) {
    throw malformed();
  }
  return { at, id };
}

/**
 * Lower-cased, every one shaped like an address — and printable ASCII, checked
 * before the fold: a Unicode lower-casing would turn `Kelly@` (a Kelvin sign)
 * into `kelly@`, and the check that reads this list folds in ASCII only
 * (`asciiAddress`, `server/admin.ts`).
 */
const allowedEmailsSchema = z.nullable(
  z
    .array(
      z
        .string()
        .check(
          z.trim(),
          z.regex(/^[\x21-\x7e]+$/, 'Addresses here are plain ASCII, without spaces.'),
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

/**
 * `POST /api/admin/admins` — the address of the account to make an admin. It
 * must already exist and be verified: the person signs in to xecret once, and
 * then they can be added.
 */
export const adminAddSchema = z.strictObject(
  {
    email: z
      .string()
      .check(
        z.trim(),
        z.maxLength(320, 'An address is at most 320 characters.'),
        z.regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Enter the address they sign in to xecret with.'),
      ),
  },
  UNEXPECTED_FIELD,
);

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

/**
 * Every payload below that the monitoring routes answer with is an
 * **allowlist**: a zod schema, run over the object the service built before it
 * is sent (`allowlisted`). `z.object` keeps the keys it names and drops every
 * other, so a field added to a repository row — or a row spread into a payload
 * by mistake — never reaches the wire; it would have to be named here first,
 * where the review of this file is.
 *
 * ── What is never named here, by the owner's rule ──
 * The admin page is in an open-source repository, and nothing on it may break
 * a customer's trust. The privacy policy makes xecret the processor for what a
 * customer puts in and the controller only for the account, so:
 *
 *  - **Projects, environments and secrets are counts.** No name, slug, id,
 *    description, note, value or version of any of them.
 *  - **Accounts are the account data:** the address, the display name, when
 *    it signed up and last signed in, whether the address is verified, how its
 *    most recent session signed in, and how many organisations it is in.
 *  - **Never** an IP address, a user agent, a device or session id, a token, a
 *    key or any ciphertext, the audit log, an avatar, the address an
 *    invitation was sent to (a count is fine), or anything about a
 *    soft-deleted account or organisation.
 *
 * Reading any of it is not written to the customer's audit log — a staff
 * member looking is not something the customer did — but every read is a line
 * on the server's own log, naming the admin's user id and what they looked at.
 */

const planSchema = z.enum(['free', 'pro', 'team', 'enterprise']);
const roleSchema = z.enum(['owner', 'admin', 'developer', 'viewer']);
const countSchema = z.int().check(z.gte(0));

/** An organisation, as the admin page shows it — in the list, a search, its own page, or a grant's answer. */
export const adminOrganizationPayloadSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  /** The searched-for person's role in it; `null` for a search by id or slug, and in the list. */
  role: z.nullable(z.string()),
  createdAt: z.string(),
  plan: planSchema,
  status: z.enum(['active', 'trialing', 'past_due', 'on_hold', 'cancelled', 'expired']),
  interval: z.nullable(z.enum(['monthly', 'yearly'])),
  /** As the billing screen says it: bought at checkout, set by an admin, or neither. */
  managedBy: z.enum(['checkout', 'support', 'none']),
  seats: z.object({ billed: countSchema, limit: countSchema }),
  /** The grant, when `managedBy` is `support`. */
  grant: z.nullable(z.object({ endsAt: z.nullable(z.string()), note: z.nullable(z.string()) })),
  /** Whether a grant here needs `overDodo` — Dodo bills it, or a paid checkout is waiting. */
  billedByDodo: z.boolean(),
  awaitingActivation: z.boolean(),
  /** Its owners' addresses, the longest-standing first — at most ten (`ADMIN_OWNER_EMAILS_SHOWN`). */
  ownerEmails: z.array(z.string()),
  /**
   * How much is in it. Counts and nothing else: what a project, environment
   * or secret is called is the customer's, and is never sent.
   */
  counts: z.object({
    /** Members of any status, on live accounts. */
    members: countSchema,
    /** Open invitations — not accepted, revoked or expired. Never to whom. */
    pendingInvitations: countSchema,
    projects: countSchema,
    environments: countSchema,
    secrets: countSchema,
  }),
});
export type AdminOrganizationPayload = z.infer<typeof adminOrganizationPayloadSchema>;

/** A member, on an organisation's page. Links to the account's own page by `userId`. */
export const adminMemberPayloadSchema = z.object({
  userId: z.string(),
  email: z.string(),
  displayName: z.nullable(z.string()),
  /** The base role. A custom role's name is the customer's own wording, and is not sent. */
  role: roleSchema,
  joinedAt: z.string(),
});
export type AdminMemberPayload = z.infer<typeof adminMemberPayloadSchema>;

/** `GET /api/admin/organizations/{orgId}`. */
export const adminOrganizationDetailPayloadSchema = z.object({
  organization: adminOrganizationPayloadSchema,
  /** On live accounts, the longest-standing first; at most `ADMIN_MEMBERS_SHOWN`. */
  members: z.array(adminMemberPayloadSchema),
});
export type AdminOrganizationDetailPayload = z.infer<typeof adminOrganizationDetailPayloadSchema>;

/** `GET /api/admin/organizations`, listed or searched. */
export const adminOrganizationListPayloadSchema = z.object({
  organizations: z.array(adminOrganizationPayloadSchema),
  /** Hand back as `?cursor=` for the next page; `null` on the last, and always for a search. */
  nextCursor: z.nullable(z.string()),
});
export type AdminOrganizationListPayload = z.infer<typeof adminOrganizationListPayloadSchema>;

/** An account, as the Users tab lists it. */
export const adminAccountPayloadSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.nullable(z.string()),
  emailVerified: z.boolean(),
  /** `users.created_at`. */
  signedUpAt: z.string(),
  /** `users.last_login_at`; `null` for one that has never signed in since it was recorded. */
  lastSignInAt: z.nullable(z.string()),
  /** How its most recent session signed in — the method only, never the session. */
  lastSignInMethod: z.nullable(
    z.enum(['password', 'oauth', 'sso', 'magic_auth', 'passkey', 'other']),
  ),
  /** Live organisations it is a member of. */
  organizationCount: countSchema,
});
export type AdminAccountPayload = z.infer<typeof adminAccountPayloadSchema>;

/** `GET /api/admin/users`. */
export const adminAccountListPayloadSchema = z.object({
  users: z.array(adminAccountPayloadSchema),
  nextCursor: z.nullable(z.string()),
});
export type AdminAccountListPayload = z.infer<typeof adminAccountListPayloadSchema>;

/** One of an account's organisations, on its page. Links to the organisation's page by `id`. */
export const adminAccountMembershipPayloadSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  role: roleSchema,
  joinedAt: z.string(),
});
export type AdminAccountMembershipPayload = z.infer<typeof adminAccountMembershipPayloadSchema>;

/** `GET /api/admin/users/{userId}`. */
export const adminAccountDetailPayloadSchema = z.object({
  user: adminAccountPayloadSchema,
  /** Live organisations only, the earliest joined first. */
  organizations: z.array(adminAccountMembershipPayloadSchema),
});
export type AdminAccountDetailPayload = z.infer<typeof adminAccountDetailPayloadSchema>;

/** `GET /api/admin/overview`. Live rows only, each inside live parents. */
export const adminOverviewPayloadSchema = z.object({
  totals: z.object({
    users: countSchema,
    organizations: countSchema,
    projects: countSchema,
    environments: countSchema,
    secrets: countSchema,
  }),
  /** Live accounts created in the last seven and thirty days. */
  signups: z.object({ last7Days: countSchema, last30Days: countSchema }),
});
export type AdminOverviewPayload = z.infer<typeof adminOverviewPayloadSchema>;

/**
 * A payload, through its allowlist: the keys the schema names and no other.
 * One that does not fit — a new plan or status nobody added here — is a bug
 * in this server, and answered as one rather than sent half-checked.
 */
export function allowlisted<T>(schema: z.ZodMiniType<T>, value: T): T {
  const result = schema.safeParse(value);
  if (!result.success) throw errors.internal('an admin payload did not fit its allowlist');
  return result.data;
}

/** One of xecret's admins, as the Admins tab lists them. */
export interface AdminUserPayload {
  userId: string;
  email: string;
  displayName: string | null;
  addedAt: string;
  /** The admin who added this one; `null` for an operator at a shell, or one since deleted. */
  addedByEmail: string | null;
  /** Whether this is the admin looking at the list. */
  you: boolean;
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

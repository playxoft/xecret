import { resolvePlanId } from '@xecret/core/entitlements';
import {
  appendAuditEvents,
  applyPlanGrant,
  awaitingActivation,
  billedByDodo,
  createPromoCode,
  endPlanGrant,
  findOrganizationsForAdmin,
  findPromoCodeById,
  isUniqueViolation,
  listPlanGrants,
  listPromoCodes,
  operatorManaged,
  promoCodeExists,
  revokePromoCode,
} from '@xecret/db/repositories';
import type {
  AdminOrganization,
  GrantListing,
  PromoCodeListing,
  PromoCodeRecord,
} from '@xecret/db/repositories';
import type { Principal } from './actor';
import { ADMIN_ACTOR_LABEL, adminAudit } from './admin';
import { subscriptionResource } from './billing/audit';
import { billingProvider, DodoApiError } from './billing/client';
import { billingSetup, productFor } from './billing/config';
import type { BillingConfig } from './billing/config';
import { fractionDigits } from './billing/money';
import { promoCodeState, summarizePromoCode } from './billing/promo-codes';
import type { ServiceContext } from './context';
import { ApiError, errors } from './errors';
import { describeError } from './logging';
import {
  ADMIN_MAX_DAYS,
  type AdminGrantBody,
  type AdminGrantPayload,
  type AdminOrganizationPayload,
  type AdminPromoCodeCreateBody,
  type AdminPromoCodePayload,
} from './schemas/admin';

/**
 * The admin page's server side (`/api/admin/*`): finding an organisation,
 * giving it a complimentary plan or ending one, and the promo codes.
 *
 * Every function here assumes `requireAdmin` already ran — the routes open
 * with it — and takes the admin's principal only to name them in the record.
 * Every change to an organisation is audited in that organisation's own log as
 * `plan.changed`, by "xecret support", with the admin's reason in `reason`: the
 * customer can always see that support changed their plan, when, and why.
 * Which admin it was is ours to know, not the customer's — the admin's user id
 * goes on the server's log line for the change, never into a log every member
 * of that organisation can read (where a personal address would otherwise
 * end up).
 */

type UserPrincipal = Extract<Principal, { kind: 'user' }>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** How many organisations a search answers with, and how many grants and codes a list does. */
const SEARCH_LIMIT = 50;
const LIST_LIMIT = 200;

/* ── organisations ─────────────────────────────────────────────────────────── */

function toOrganizationPayload(org: AdminOrganization): AdminOrganizationPayload {
  const row = org.subscription;
  const support = operatorManaged(row);
  const live = row.dodoSubscriptionId !== null && row.dodoProductId !== null && row.plan !== 'free';
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    role: org.role,
    createdAt: org.createdAt.toISOString(),
    plan: resolvePlanId(row.plan),
    status: row.status,
    interval: row.billingInterval,
    managedBy: live ? 'checkout' : support ? 'support' : 'none',
    seats: { billed: row.seats, limit: org.seatLimit },
    grant: support ? { endsAt: row.grantEndsAt?.toISOString() ?? null, note: row.grantNote } : null,
    billedByDodo: billedByDodo(row) && !awaitingActivation(row),
    awaitingActivation: awaitingActivation(row),
  };
}

/** An address finds the organisations its person is in; anything else is a slug. */
export async function searchOrganizations(
  services: ServiceContext,
  query: string,
): Promise<AdminOrganizationPayload[]> {
  const found = await findOrganizationsForAdmin(
    services.db,
    query.includes('@') ? { email: query } : { slug: query.toLowerCase() },
    SEARCH_LIMIT,
  );
  return found.map(toOrganizationPayload);
}

async function organizationPayload(
  services: ServiceContext,
  orgId: string,
): Promise<AdminOrganizationPayload> {
  const [org] = await findOrganizationsForAdmin(services.db, { id: orgId }, 1);
  if (org === undefined) throw errors.notFound('organisation not found after a grant');
  return toOrganizationPayload(org);
}

/** "until 1 March 2027", or "with no end date". For the audit reason. */
function untilText(endsAt: Date | null): string {
  return endsAt === null ? 'with no end date' : `until ${endsAt.toISOString().slice(0, 10)}`;
}

/** An end date the admin gave: in the future, and within ten years. */
function endDate(raw: string | null, field: string): Date | null {
  if (raw === null) return null;
  const at = new Date(raw);
  const now = Date.now();
  if (at.getTime() <= now + 60_000) {
    throw errors.validation([{ field, message: 'Choose a moment in the future.' }]);
  }
  if (at.getTime() > now + ADMIN_MAX_DAYS * DAY_MS) {
    throw errors.validation([{ field, message: 'At most ten years ahead.' }]);
  }
  return at;
}

export interface GrantResult {
  organization: AdminOrganizationPayload;
  /** The Dodo subscription the organisation was taken off — still live at Dodo until cancelled there. */
  detachedSubscriptionId: string | null;
}

/**
 * Gives an organisation a complimentary plan — or replaces the one it has
 * (an extension, another plan). The rules for one Dodo bills are `plan:set`'s
 * own: refused unless `overDodo`, and then taken off its subscription first.
 */
export async function grantPlan(
  services: ServiceContext,
  admin: UserPrincipal,
  orgId: string,
  body: AdminGrantBody,
): Promise<GrantResult> {
  const endsAt = endDate(body.endsAt, 'endsAt');

  const detached = await services.db.transaction(async (tx) => {
    const outcome = await applyPlanGrant(tx, {
      orgId,
      plan: body.plan,
      seats: body.seats,
      endsAt,
      note: 'Granted by xecret support',
      overDodo: body.overDodo,
      onlyFromFree: false,
    });
    if (!outcome.ok) {
      switch (outcome.refusal) {
        case 'not-found':
          throw errors.notFound('no live organisation with that id');
        // A paid checkout still activating counts as billed by Dodo, as it does
        // for `plan:set`: refused unless `overDodo`, which takes the
        // organisation off that subscription too (its id is answered).
        case 'awaiting-activation':
        case 'billed-by-dodo':
        case 'already-granted':
        case 'already-subscribed':
          throw errors.grantBilledByDodo();
      }
    }

    await appendAuditEvents(tx, [
      adminAudit(services, orgId).success('plan.changed', subscriptionResource(orgId), {
        operator: ADMIN_ACTOR_LABEL,
        plan: body.plan,
        previousPlan: outcome.previous.plan,
        subscriptionStatus: 'active',
        previousSubscriptionStatus: outcome.previous.status,
        seatCount: outcome.seats.billed,
        previousSeatCount: outcome.previous.seats,
        reason:
          `complimentary ${body.plan} plan ${untilText(endsAt)}` +
          (outcome.detached !== null ? ', taken off its Dodo subscription' : '') +
          `: ${body.reason}`,
      }),
    ]);
    return outcome.detached;
  });

  services.log.at('grantPlan').info('An admin gave an organisation a complimentary plan', {
    orgId,
    adminUserId: admin.user.id,
    plan: body.plan,
    endsAt: endsAt?.toISOString() ?? null,
    detachedFromDodo: detached !== null,
  });
  return {
    organization: await organizationPayload(services, orgId),
    detachedSubscriptionId: detached?.dodoSubscriptionId ?? null,
  };
}

/** Ends a complimentary plan now: the organisation returns to Free. */
export async function endGrant(
  services: ServiceContext,
  admin: UserPrincipal,
  orgId: string,
  reason: string,
): Promise<AdminOrganizationPayload> {
  await services.db.transaction(async (tx) => {
    const ended = await endPlanGrant(tx, orgId);
    if (ended === null) {
      throw errors.conflict('This organisation has no complimentary plan to end.');
    }
    await appendAuditEvents(tx, [
      adminAudit(services, orgId).success('plan.changed', subscriptionResource(orgId), {
        operator: ADMIN_ACTOR_LABEL,
        plan: 'free',
        previousPlan: ended.previous.plan,
        subscriptionStatus: 'active',
        previousSubscriptionStatus: ended.previous.status,
        seatCount: 1,
        previousSeatCount: ended.previous.seats,
        reason: `complimentary plan ended by support: ${reason}`,
      }),
    ]);
  });
  services.log.at('endGrant').info('An admin ended an organisation’s complimentary plan', {
    orgId,
    adminUserId: admin.user.id,
  });
  return organizationPayload(services, orgId);
}

function toGrantPayload(grant: GrantListing): AdminGrantPayload {
  return {
    orgId: grant.orgId,
    orgName: grant.orgName,
    orgSlug: grant.orgSlug,
    plan: resolvePlanId(grant.plan),
    seatLimit: grant.seatLimit,
    endsAt: grant.grantEndsAt?.toISOString() ?? null,
    note: grant.grantNote,
  };
}

export async function listGrants(services: ServiceContext): Promise<AdminGrantPayload[]> {
  return (await listPlanGrants(services.db, LIST_LIMIT)).map(toGrantPayload);
}

/* ── promo codes ───────────────────────────────────────────────────────────── */

export function toPromoCodePayload(
  code: PromoCodeRecord & { checkoutsStarted?: number },
): AdminPromoCodePayload {
  const digits =
    code.discountType === 'flat' && code.discountCurrency !== null
      ? fractionDigits(code.discountCurrency)
      : 0;
  return {
    id: code.id,
    code: code.code,
    kind: code.kind,
    summary: summarizePromoCode(code),
    description: code.description,
    grant:
      code.kind === 'grant' && code.grantPlan !== null
        ? {
            plan: code.grantPlan as 'pro' | 'team' | 'enterprise',
            days: code.grantDays,
            seats: code.grantSeats,
          }
        : null,
    discount:
      code.kind === 'discount' &&
      code.discountType !== null &&
      code.discountAmount !== null &&
      code.dodoMode !== null
        ? {
            type: code.discountType,
            value:
              code.discountType === 'percentage'
                ? code.discountAmount / 100
                : code.discountAmount / 10 ** digits,
            currency: code.discountCurrency,
            cycles: code.discountCycles,
            plans: (code.discountPlans ?? []) as ('pro' | 'team')[],
            mode: code.dodoMode,
          }
        : null,
    allowedEmails: code.allowedEmails,
    maxRedemptions: code.maxRedemptions,
    redemptions: code.redemptions,
    checkoutsStarted: code.checkoutsStarted ?? 0,
    expiresAt: code.expiresAt?.toISOString() ?? null,
    createdAt: code.createdAt.toISOString(),
    revokedAt: code.revokedAt?.toISOString() ?? null,
    state: promoCodeState(code),
  };
}

/** The billing config when payments are on; `null` when off or half-configured. */
function billingConfigOrNull(services: ServiceContext): BillingConfig | null {
  try {
    const setup = billingSetup(services.env);
    return setup.state === 'enabled' ? setup.config : null;
  } catch {
    return null;
  }
}

export async function listCodes(services: ServiceContext): Promise<{
  codes: AdminPromoCodePayload[];
  billing: { enabled: boolean; mode: 'test_mode' | 'live_mode' | null };
}> {
  const config = billingConfigOrNull(services);
  const codes: PromoCodeListing[] = await listPromoCodes(services.db, LIST_LIMIT);
  return {
    codes: codes.map(toPromoCodePayload),
    billing: { enabled: config !== null, mode: config?.mode ?? null },
  };
}

/**
 * A random code: ten characters from an alphabet with nothing that reads as
 * something else (no 0/O, 1/I/L), from the platform's random source. About 48
 * bits — far past guessing at a rate-limited endpoint.
 */
export function randomPromoCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  // 256 is not a multiple of 31; the bias this leaves is a fraction of a
  // percent per character, irrelevant to a code nobody needs to be uniform.
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

/** A discount's value in Dodo's units: basis points, or the currency's minor unit. */
function dodoAmount(discount: NonNullable<AdminPromoCodeCreateBody['discount']>): {
  amount: number;
  currency: string | null;
} {
  if (discount.type === 'percentage') {
    if (discount.currency !== null) {
      throw errors.validation([
        { field: 'discount.currency', message: 'A percentage has no currency.' },
      ]);
    }
    const amount = Math.round(discount.value * 100);
    if (amount < 1 || amount > 10_000) {
      throw errors.validation([
        { field: 'discount.value', message: 'A percentage from 0.01 to 100.' },
      ]);
    }
    return { amount, currency: null };
  }
  if (discount.currency === null) {
    throw errors.validation([
      { field: 'discount.currency', message: 'Choose the currency the amount is in.' },
    ]);
  }
  const amount = Math.round(discount.value * 10 ** fractionDigits(discount.currency));
  if (amount < 1 || amount > 100_000_000) {
    throw errors.validation([{ field: 'discount.value', message: 'That amount is out of range.' }]);
  }
  return { amount, currency: discount.currency };
}

/**
 * Creates a promo code. A discount code is created at Dodo first — restricted
 * to this deployment's own products for the plans it names, every interval —
 * and then recorded; if recording it fails, the Dodo discount is deleted
 * again, so nothing exists there that this server would not apply.
 */
export async function createCode(
  services: ServiceContext,
  admin: UserPrincipal,
  body: AdminPromoCodeCreateBody,
): Promise<AdminPromoCodePayload> {
  const expiresAt = endDate(body.expiresAt, 'expiresAt');
  const code = body.code ?? randomPromoCode();
  if (await promoCodeExists(services.db, code)) throw errors.promoCodeTaken();

  const common = {
    code,
    description: body.description === '' ? null : body.description,
    allowedEmails:
      body.allowedEmails === null
        ? null
        : [...new Set(body.allowedEmails.map((a) => a.toLowerCase()))],
    maxRedemptions: body.maxRedemptions,
    expiresAt,
    createdBy: admin.user.id,
  };

  let created: PromoCodeRecord;
  if (body.kind === 'grant' && body.grant !== undefined) {
    created = await recordCode(() =>
      createPromoCode(services.db, {
        ...common,
        kind: 'grant',
        grantPlan: body.grant!.plan,
        grantDays: body.grant!.days,
        grantSeats: body.grant!.seats,
      }),
    );
  } else if (body.kind === 'discount' && body.discount !== undefined) {
    const discount = body.discount;
    const config = billingConfigOrNull(services);
    if (config === null) throw errors.promoDiscountNeedsBilling();
    const { amount, currency } = dodoAmount(discount);
    const productIds = discount.plans.flatMap((plan) => [
      productFor(config, plan, 'monthly'),
      productFor(config, plan, 'yearly'),
    ]);

    const provider = billingProvider(config);
    let discountId: string;
    try {
      ({ discountId } = await provider.createDiscount({
        code,
        name: `xecret: ${common.description ?? code}`.slice(0, 100),
        type: discount.type,
        amount,
        currency,
        cycles: discount.cycles,
        productIds,
        usageLimit: body.maxRedemptions,
        expiresAt,
      }));
    } catch (cause) {
      throw dodoFailure(services, cause, 'creating a discount code');
    }

    try {
      created = await recordCode(() =>
        createPromoCode(services.db, {
          ...common,
          kind: 'discount',
          discountType: discount.type,
          discountAmount: amount,
          discountCurrency: currency,
          discountCycles: discount.cycles,
          discountPlans: discount.plans,
          dodoDiscountId: discountId,
          dodoMode: config.mode,
        }),
      );
    } catch (cause) {
      // Nothing may stay at Dodo that this server has no row for.
      await provider.deleteDiscount(discountId).catch((deleteFailure: unknown) => {
        services.log
          .at('createCode')
          .error(
            'A Dodo discount was created and its code could not be recorded, and deleting it ' +
              'again failed too — delete it in the Dodo dashboard (the checkout code box is ' +
              'hidden, so nothing can apply it meanwhile)',
            { discountId, error: describeError(deleteFailure) },
          );
      });
      throw cause;
    }
  } else {
    throw errors.badRequest(
      'Describe the free plan for a grant code, or the discount for a discount code.',
    );
  }

  // The code itself is not logged: a free-plan code is as good as the plan.
  services.log.at('createCode').info('An admin created a promo code', {
    promoCodeId: created.id,
    adminUserId: admin.user.id,
    kind: created.kind,
  });
  return toPromoCodePayload(created);
}

/** The insert, with the one conflict that has a sentence: the code is taken. */
async function recordCode(insert: () => Promise<PromoCodeRecord>): Promise<PromoCodeRecord> {
  try {
    return await insert();
  } catch (cause) {
    if (isUniqueViolation(cause, 'promo_codes_code_unique')) throw errors.promoCodeTaken();
    throw cause;
  }
}

function dodoFailure(services: ServiceContext, cause: unknown, doing: string): ApiError {
  if (cause instanceof DodoApiError) {
    services.log.at('admin').warn(`Dodo did not complete ${doing}`, {
      category: cause.category,
      status: cause.status,
      code: cause.detail,
    });
    // A code that exists at Dodo already — perhaps another product's, on the
    // shared account. Nothing of ours was created.
    if (cause.category === 'conflict') return errors.promoCodeTaken();
    return cause.retryable
      ? errors.billingProviderUnavailable(`dodo ${cause.category} while ${doing}`)
      : errors.billingProviderRefused(`dodo ${cause.category} while ${doing}`);
  }
  services.log.at('admin').error(`Calling Dodo failed unexpectedly while ${doing}`, {
    error: describeError(cause),
  });
  return errors.billingProviderUnavailable(`unexpected failure while ${doing}`);
}

/**
 * Revokes a code: no redemption or checkout accepts it from now on. A discount
 * code is deleted at Dodo too — best effort, because the check here already
 * refuses it and Dodo's own code box is hidden; a failure is logged for a
 * human to finish in the Dodo dashboard. Grants already made with a code are
 * not touched: they end on their own dates.
 */
export async function revokeCode(
  services: ServiceContext,
  admin: UserPrincipal,
  id: string,
): Promise<AdminPromoCodePayload> {
  const revoked = await revokePromoCode(services.db, id, admin.user.id);
  if (revoked === null) {
    const existing = await findPromoCodeById(services.db, id);
    if (existing === null) throw errors.notFound('no such promo code');
    throw errors.conflict('That code was already revoked.');
  }

  if (revoked.kind === 'discount' && revoked.dodoDiscountId !== null) {
    const config = billingConfigOrNull(services);
    if (config !== null && config.mode === revoked.dodoMode) {
      await billingProvider(config)
        .deleteDiscount(revoked.dodoDiscountId)
        .catch((cause: unknown) => {
          services.log
            .at('revokeCode')
            .warn(
              'A revoked discount code could not be deleted at Dodo; nothing here applies it, ' +
                'but delete it in the Dodo dashboard',
              {
                promoCodeId: revoked.id,
                ...(cause instanceof DodoApiError
                  ? { category: cause.category }
                  : { error: describeError(cause) }),
              },
            );
        });
    }
  }

  services.log
    .at('revokeCode')
    .info('An admin revoked a promo code', { promoCodeId: revoked.id, adminUserId: admin.user.id });
  return toPromoCodePayload(revoked);
}

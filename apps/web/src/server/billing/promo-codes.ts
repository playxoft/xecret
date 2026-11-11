import type { AuditBuilder } from '@xecret/core/audit';
import type { PlanId } from '@xecret/core/entitlements';
import {
  appendAuditEvents,
  applyPlanGrant,
  findPromoCode,
  spendGrantRedemption,
} from '@xecret/db/repositories';
import type { PromoCodeRecord } from '@xecret/db/repositories';
import type { Principal } from '../actor';
import type { ServiceContext } from '../context';
import { errors } from '../errors';
import type { PromoCodePreviewPayload, PromoCodeState } from '../schemas/admin';
import type { OrgScope } from '../tenancy';
import { subscriptionResource } from './audit';
import { billingSetup } from './config';
import type { BillingConfig, PurchasablePlan } from './config';
import { formatMinor } from './money';

/**
 * Promo codes, from the owner's side (migration 0035): what a code does, and
 * spending it.
 *
 * ── Two kinds, two paths ──
 *  - A **grant** code is spent here, in one transaction with the plan it
 *    gives: the redemption is counted (`spendGrantRedemption` — once per
 *    organisation, once per person, never past the code's limit) and the grant
 *    written (`applyPlanGrant`, only from Free). Nothing at Dodo, no card.
 *  - A **discount** code is never spent here. Checkout checks it
 *    (`discountForCheckout`) and pre-applies it at Dodo, which counts its uses
 *    against the limit it was created with. Dodo's own code box is hidden
 *    (`client.ts`), so that check is the only way a code reaches a checkout.
 *
 * ── What every check asks ──
 * The code exists and was not revoked; it has not expired; its limit is not
 * spent; and, when it names the people it is for, the signed-in person's
 * verified address is one of them. A code that does not exist, was revoked or
 * is for somebody else gets one answer (`promoCodeInvalid`), so a guesser
 * learns nothing from which it was.
 */

type UserPrincipal = Extract<Principal, { kind: 'user' }>;

const DAY_MS = 24 * 60 * 60 * 1000;

const planName = (plan: string) => plan.charAt(0).toUpperCase() + plan.slice(1);

/** "Pro and Team", "Team". */
function planList(plans: readonly string[]): string {
  return plans.map(planName).join(' and ');
}

/** "30 days", "1 year", "6 months" — whichever a person would say. */
function describeDays(days: number): string {
  if (days % 365 === 0) return days === 365 ? '1 year' : `${days / 365} years`;
  if (days % 30 === 0 && days >= 60) return `${days / 30} months`;
  return days === 1 ? '1 day' : `${days} days`;
}

/** A discount's value as a person reads it: "50%", "$5.00". */
export function discountValueText(code: PromoCodeRecord): string {
  if (code.discountType === 'percentage') {
    const percent = (code.discountAmount ?? 0) / 100;
    return `${Number.isInteger(percent) ? percent : percent.toFixed(2)}%`;
  }
  return formatMinor(code.discountAmount, code.discountCurrency) ?? 'an amount';
}

/**
 * What a code gives, in one sentence: "Team free for 30 days", "Pro free, with
 * no end date", "50% off Pro and Team for 3 billing periods", "100% off Team
 * for every billing period".
 */
export function summarizePromoCode(code: PromoCodeRecord): string {
  if (code.kind === 'grant') {
    const plan = planName(code.grantPlan ?? 'pro');
    return code.grantDays === null
      ? `${plan} free, with no end date`
      : `${plan} free for ${describeDays(code.grantDays)}`;
  }
  const plans = planList(code.discountPlans ?? []);
  const cycles = code.discountCycles;
  const how =
    cycles === null
      ? 'every billing period'
      : cycles === 1
        ? 'the first billing period'
        : `the first ${cycles} billing periods`;
  return `${discountValueText(code)} off ${plans} for ${how}`;
}

/** Whether a code can still be used, as the admin page labels it. */
export function promoCodeState(code: PromoCodeRecord, now: Date = new Date()): PromoCodeState {
  if (code.revokedAt !== null) return 'revoked';
  if (code.expiresAt !== null && code.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (
    code.kind === 'grant' &&
    code.maxRedemptions !== null &&
    code.redemptions >= code.maxRedemptions
  ) {
    return 'used-up';
  }
  return 'active';
}

/**
 * The code, if this person may use it now — or the refusal that says why not.
 * Read-only: nothing is spent.
 */
async function usableCode(
  services: ServiceContext,
  principal: UserPrincipal,
  raw: string,
): Promise<PromoCodeRecord> {
  const code = await findPromoCode(services.db, raw);
  if (code === null) throw errors.promoCodeInvalid('no such code');
  if (code.allowedEmails !== null) {
    // Only a verified address is somebody's own. The list was lower-cased
    // when it was written; the address is `citext` and compared the same way.
    const address = principal.user.email.toLowerCase();
    if (!principal.user.emailVerified || !code.allowedEmails.includes(address)) {
      throw errors.promoCodeInvalid('code is for other addresses');
    }
  }
  const state = promoCodeState(code);
  if (state === 'revoked') throw errors.promoCodeInvalid('code revoked');
  if (state === 'expired') throw errors.promoCodeExpired();
  if (state === 'used-up') throw errors.promoCodeUsedUp();
  return code;
}

/**
 * A discount code's own checks against this deployment: it was made in the
 * Dodo this deployment talks to — a test-mode code means nothing to live
 * Dodo, and the reverse.
 */
function discountUsableHere(code: PromoCodeRecord, config: BillingConfig | null): void {
  if (config === null || code.dodoMode !== config.mode) {
    throw errors.promoCodeInvalid('discount code of another Dodo mode, or billing is off');
  }
}

function previewOf(code: PromoCodeRecord): PromoCodePreviewPayload {
  return {
    code: code.code,
    kind: code.kind,
    summary: summarizePromoCode(code),
    plan: code.kind === 'grant' ? (code.grantPlan as 'pro' | 'team' | 'enterprise') : null,
    plans: code.kind === 'discount' ? ((code.discountPlans ?? []) as ('pro' | 'team')[]) : null,
  };
}

/** The billing config when billing is on, `null` when it is off or half-configured. */
function billingConfigOrNull(services: ServiceContext): BillingConfig | null {
  try {
    const setup = billingSetup(services.env);
    return setup.state === 'enabled' ? setup.config : null;
  } catch {
    return null;
  }
}

/**
 * `POST …/billing/promo-code` — what a code would do for this organisation,
 * without doing it. The same checks as spending it, so an owner is told now
 * rather than at the button.
 */
export async function previewPromoCode(
  services: ServiceContext,
  principal: UserPrincipal,
  raw: string,
): Promise<PromoCodePreviewPayload> {
  const code = await usableCode(services, principal, raw);
  if (code.kind === 'discount') discountUsableHere(code, billingConfigOrNull(services));
  return previewOf(code);
}

/**
 * `POST …/billing/promo-code/redeem` — spends a grant code on this
 * organisation: the redemption and the free plan in one transaction, so a
 * plan that cannot be granted gives the redemption back. Audited as the plan
 * change it is, by the owner who redeemed it.
 */
export async function redeemGrantCode(
  services: ServiceContext,
  scope: OrgScope,
  principal: UserPrincipal,
  raw: string,
  audit: AuditBuilder,
): Promise<{ code: PromoCodeRecord; plan: PlanId; endsAt: Date | null }> {
  const code = await usableCode(services, principal, raw);
  if (code.kind !== 'grant' || code.grantPlan === null) throw errors.promoCodeNeedsCheckout();

  const orgId = scope.organization.id;
  const plan = code.grantPlan;
  const endsAt = code.grantDays === null ? null : new Date(Date.now() + code.grantDays * DAY_MS);

  await services.db.transaction(async (tx) => {
    const spent = await spendGrantRedemption(tx, {
      codeId: code.id,
      orgId,
      userId: principal.user.id,
    });
    if (!spent.ok) {
      if (spent.refusal === 'org-redeemed') throw errors.promoCodeAlreadyRedeemed('organisation');
      if (spent.refusal === 'user-redeemed') throw errors.promoCodeAlreadyRedeemed('person');
      // Revoked, expired or used up between the read above and the count.
      throw errors.promoCodeUsedUp();
    }

    const outcome = await applyPlanGrant(tx, {
      orgId,
      plan: plan as Exclude<PlanId, 'free'>,
      seats: code.grantSeats,
      endsAt,
      note: `Promo code ${code.code}`,
      overDodo: false,
      onlyFromFree: true,
    });
    // Thrown, so the transaction — the redemption counted above included —
    // rolls back with it.
    if (!outcome.ok) {
      switch (outcome.refusal) {
        case 'awaiting-activation':
          throw errors.billingCheckoutPending();
        case 'already-granted':
          throw errors.promoCodeHasPlan('grant');
        case 'already-subscribed':
        case 'billed-by-dodo':
          throw errors.promoCodeHasPlan('subscription');
        case 'not-found':
          throw errors.notFound('organisation vanished during a redemption');
      }
    }

    await appendAuditEvents(tx, [
      audit.success('plan.changed', subscriptionResource(orgId), {
        plan,
        previousPlan: outcome.previous.plan,
        subscriptionStatus: 'active',
        previousSubscriptionStatus: outcome.previous.status,
        seatCount: outcome.seats.billed,
        previousSeatCount: outcome.previous.seats,
        reason:
          `promo code ${code.code} redeemed: ${summarizePromoCode(code)}` +
          (endsAt === null ? '' : `, until ${endsAt.toISOString()}`),
      }),
    ]);
  });

  return { code, plan, endsAt };
}

/**
 * The discount a checkout for `plan` may carry, checked: a discount code, for
 * this plan, of this deployment's Dodo mode, usable by this person now.
 * Answers the code to send to Dodo and the row it came from.
 */
export async function discountForCheckout(
  services: ServiceContext,
  config: BillingConfig,
  principal: UserPrincipal,
  raw: string,
  plan: PurchasablePlan,
): Promise<{ id: string; code: string }> {
  const code = await usableCode(services, principal, raw);
  if (code.kind !== 'discount') throw errors.promoCodeIsFreePlan();
  discountUsableHere(code, config);
  const plans = code.discountPlans ?? [];
  if (!plans.includes(plan)) throw errors.promoCodeWrongPlan(plans);
  return { id: code.id, code: code.code };
}

import type { AuditAction, AuditBuilder, AuditRecord } from '@xecret/core/audit';
import { auditingDenials } from '@xecret/core/authz';
import {
  checkLimit,
  MINIMUM_SEATS,
  PLAN_RANK,
  providerSeats,
  resolvePlanId,
  UNCAPPED_SEAT_LIMIT,
  WARN_AT,
} from '@xecret/core/entitlements';
import type { BillingInterval } from '@xecret/core/entitlements';
import { toBase64Url } from '@xecret/core/crypto';
import {
  billingCounts,
  claimBillingRequest,
  completeBillingRequest,
  countOrgsWithDodoCustomer,
  currentUsage,
  findSubscription,
  recordCheckout,
  releaseBillingRequest,
  seatedMemberCount,
} from '@xecret/db/repositories';
import type { SubscriptionRecord } from '@xecret/db/repositories';
import type { Principal } from '../actor';
import { publicOrigin } from '../bindings';
import type { ServiceContext } from '../context';
import { errors } from '../errors';
import type { ApiError } from '../errors';
import { describeError } from '../logging';
import type { BillingStatusPayload, BillingWarning } from '../schemas/billing';
import { authorize } from '../tenancy';
import type { OrgScope } from '../tenancy';
import { billingProvider, DodoApiError } from './client';
import type { PlanChange, PlanChangePreview } from './client';
import { billingSetup, productFor } from './config';
import type { BillingConfig, PurchasablePlan } from './config';
import { subscriptionResource } from './audit';
import { formatMinor, OVERAGE_RATE_TEXT } from './money';

/**
 * The billing screen's server side (P12): the routes under
 * `/api/orgs/{orgSlug}/billing` share these.
 *
 * ── Who may ──
 * Every route, reading included:
 *
 *  1. **A browser session.** A bearer token may not start a purchase, change a
 *     plan or open the payment portal — the rule the CLI authorisation flow
 *     already applies to minting credentials, generalised to spending money.
 *     Asked before the organisation is resolved, so a token learns nothing.
 *  2. **`billing.manage`** — owners only, through the same `can()` every other
 *     organisation action goes through, and no custom role can carry it. A
 *     refused mutation files a `denied` record of what it attempted.
 *  3. **The vault unlocked**, which `authenticatedRoute` asks of every route
 *     that does not opt out — and none of these does.
 *
 * ── What the client never decides ──
 * The seats (counted from the membership: `providerSeats`), the currency
 * (Dodo's, from the billing country — pinned by the region lock once one is
 * set), the price (the Dodo product's), and whether anything was bought (only
 * the webhook says so; the return from checkout grants nothing).
 */

/** Step 1. */
export function requireBillingSession(principal: Principal): Extract<Principal, { kind: 'user' }> {
  if (principal.kind !== 'user') {
    throw errors.forbidden('Billing needs a signed-in browser session, not a token.');
  }
  return principal;
}

type AuditFile = { audit: AuditBuilder; record: (...events: AuditRecord[]) => void };

/** Step 2, filing a `denied` record of each action a refused request attempted. */
export function authorizeBilling(
  scope: OrgScope,
  file: AuditFile,
  attempted: readonly AuditAction[],
): void {
  const resource = subscriptionResource(scope.organization.id);
  auditingDenials(
    (decision) => {
      for (const attempt of attempted) file.record(file.audit.denied(attempt, resource, decision));
    },
    () => authorize(scope, 'billing.manage'),
  );
}

/** The shape `billing_requests` accepts: what `crypto.randomUUID()` produces, and similar. */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * The request's `Idempotency-Key`, or `null` when it sent none. A key of the
 * wrong shape is refused rather than ignored: a client that sent one meant to
 * be protected by it.
 */
export function idempotencyKeyOf(request: Request): string | null {
  const key = request.headers.get('idempotency-key');
  if (key === null || key === '') return null;
  if (!IDEMPOTENCY_KEY.test(key)) {
    throw errors.badRequest('Idempotency-Key must be 16 to 128 letters, digits, - or _.');
  }
  return key;
}

/** Billing on, or the 409 that says this installation takes no payments. */
export function requireBillingConfig(services: ServiceContext): BillingConfig {
  const setup = billingSetup(services.env);
  if (setup.state === 'disabled') throw errors.billingDisabled();
  return setup.config;
}

/** The row, as every organisation has one. */
async function subscriptionOf(
  services: ServiceContext,
  orgId: string,
): Promise<SubscriptionRecord> {
  const row = await findSubscription(services.db, orgId);
  if (row === null) throw errors.internal('organisation has no subscription row');
  return row;
}

/**
 * Whether the row follows a live Dodo subscription — the only kind a plan
 * change can act on. A snapshot always records the product; a paid row
 * without one was set by hand (see `managedBySupport`).
 */
function hasLiveSubscription(row: SubscriptionRecord): boolean {
  return row.dodoSubscriptionId !== null && row.dodoProductId !== null && row.plan !== 'free';
}

/**
 * A paid plan nobody bought through checkout: an operator's grant or an
 * Enterprise contract — including one written, before `plan:set` took such
 * rows off their ids, over the id of a subscription that had ended.
 */
function managedBySupport(row: SubscriptionRecord): boolean {
  return row.plan !== 'free' && (row.dodoSubscriptionId === null || row.dodoProductId === null);
}

/**
 * A checkout that has been paid — its payment linked the subscription to the
 * row — whose subscription has not been applied yet. A second checkout now
 * would be a second subscription. (A row on Free that *ended* a subscription
 * keeps its id too, but an applied snapshot left `dodo_event_at` behind.)
 */
function awaitingActivation(row: SubscriptionRecord): boolean {
  return row.plan === 'free' && row.dodoSubscriptionId !== null && row.dodoEventAt === null;
}

/** Whether the row's Dodo ids belong to the mode this deployment talks to. */
function sameMode(row: SubscriptionRecord, config: BillingConfig): boolean {
  return row.dodoMode === null || row.dodoMode === config.mode;
}

/** A fresh checkout nonce: 128 random bits, base64url. */
function checkoutNonce(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * Runs an owner's money-moving request at most once per idempotency key.
 *
 * The billing screen sends a fresh key with every checkout and plan change it
 * starts. The first request with a key runs; a repeat — a double click, a
 * browser retrying a request whose answer it never saw — is answered with the
 * first one's result, and never reaches Dodo a second time. A request that
 * failed lets go of its key, so trying again with it works. No key: the
 * request simply runs (a caller that wants no protection gets none).
 */
async function onceForKey<T extends Record<string, unknown>>(
  services: ServiceContext,
  request: { orgId: string; kind: 'checkout' | 'change'; key: string | null; fingerprint: string },
  run: () => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  if (request.key === null) return { result: await run(), replayed: false };
  const claim = await claimBillingRequest(services.db, {
    orgId: request.orgId,
    kind: request.kind,
    key: request.key,
    fingerprint: request.fingerprint,
  });
  if (claim.state === 'replay') return { result: claim.result as T, replayed: true };
  if (claim.state === 'in-flight') throw errors.billingRequestInFlight();
  if (claim.state === 'mismatch') throw errors.billingIdempotencyMismatch();

  let result: T;
  try {
    result = await run();
  } catch (cause) {
    await releaseBillingRequest(services.db, {
      orgId: request.orgId,
      kind: request.kind,
      key: request.key,
    });
    throw cause;
  }
  await completeBillingRequest(services.db, {
    orgId: request.orgId,
    kind: request.kind,
    key: request.key,
    result,
  });
  return { result, replayed: false };
}

/** Turns a Dodo failure into the API's answer, with a log line saying which call. */
function providerFailure(services: ServiceContext, cause: unknown, doing: string): ApiError {
  const log = services.log.at('billing');
  if (cause instanceof DodoApiError) {
    log.warn(`Dodo did not complete ${doing}`, {
      category: cause.category,
      status: cause.status,
      code: cause.detail,
    });
    if (cause.category === 'conflict') return errors.billingChangePending();
    return cause.retryable
      ? errors.billingProviderUnavailable(`dodo ${cause.category} while ${doing}`)
      : errors.billingProviderRefused(`dodo ${cause.category} while ${doing}`);
  }
  log.error(`Calling Dodo failed unexpectedly while ${doing}`, { error: describeError(cause) });
  return errors.billingProviderUnavailable(`unexpected failure while ${doing}`);
}

const billingPage = (services: ServiceContext, slug: string) =>
  `${publicOrigin(services.env)}/app/${encodeURIComponent(slug)}/settings/billing`;

/* ── status ────────────────────────────────────────────────────────────────── */

export async function billingStatus(
  services: ServiceContext,
  scope: OrgScope,
): Promise<BillingStatusPayload> {
  const orgId = scope.organization.id;
  const setup = billingSetup(services.env);
  const row = await subscriptionOf(services, orgId);
  const now = new Date();
  const [counts, usage] = await Promise.all([
    billingCounts(services.db, orgId, now),
    currentUsage(services.db, orgId),
  ]);

  const plan = resolvePlanId(row.plan);
  const { entitlements } = scope;
  const warnings: BillingWarning[] = [];
  // Seats against the ceiling invitations are actually refused at
  // (`organizations.seat_limit`), which is not the plan's published number on
  // Free — see `FREE_SEAT_LIMIT`. A per-seat plan has none to warn about.
  const seatLimit = scope.organization.seatLimit;
  const seatsUsed = counts.seatedMembers + counts.pendingInvitations;
  if (seatLimit < UNCAPPED_SEAT_LIMIT && seatLimit > 0 && seatsUsed / seatLimit >= WARN_AT) {
    warnings.push({
      resource: 'seats',
      limit: seatLimit,
      current: seatsUsed,
      atLimit: seatsUsed >= seatLimit,
    });
  }
  for (const [resource, current] of [
    ['projects', counts.projects],
    ['serviceTokens', counts.serviceTokens],
  ] as const) {
    // 80% of a plan ceiling, or past a fair-use one — the same three-way
    // verdict the control plane will refuse on, read here only to warn.
    const verdict = checkLimit(entitlements, resource, current);
    if (verdict.kind === 'ok') continue;
    warnings.push({
      resource,
      limit: verdict.limit,
      current,
      atLimit: verdict.kind === 'exceeded',
    });
  }

  const lockHolds = row.regionLockedUntil !== null && row.regionLockedUntil > now;
  const enabled = setup.state === 'enabled';
  const live = hasLiveSubscription(row);
  const ours = setup.state === 'enabled' && sameMode(row, setup.config);

  return {
    enabled,
    mode: setup.state === 'enabled' ? setup.config.mode : null,
    plan,
    status: row.status,
    interval: row.billingInterval,
    managedBy: live ? 'checkout' : managedBySupport(row) ? 'support' : 'none',
    seats: {
      billed: row.seats,
      seated: counts.seatedMembers,
      pendingInvitations: counts.pendingInvitations,
      minimum: MINIMUM_SEATS[plan],
    },
    currency: row.currency,
    renewsAt: row.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    trialEndsAt: row.trialEndsAt?.toISOString() ?? null,
    // In Dodo's own currency for the figure: the region lock can keep another
    // in `currency` while Dodo bills in the one it reported.
    renewalAmount: formatMinor(row.renewalAmountMinor, row.dodoCurrency ?? row.currency),
    regionLock: lockHolds
      ? {
          until: row.regionLockedUntil!.toISOString(),
          country: row.billingCountry,
          currency: row.currency,
        }
      : null,
    usage: {
      periodStart: usage.periodStart.toISOString(),
      secretFetches: usage.secretFetches,
      // What the month is billed past: the allowance it recorded when it
      // opened, or — before its first fetch is counted — the plan's own.
      includedFetches: usage.includedFetches ?? entitlements.limits.includedFetchesPerMonth,
      unitsReported: usage.meteredUnitsSent,
      overageRate: OVERAGE_RATE_TEXT,
    },
    warnings,
    addons: { saml: row.addonSaml },
    actions: {
      checkout: enabled && ours && !live && !managedBySupport(row) && !awaitingActivation(row),
      changePlan: enabled && live && ours,
      portal: enabled && ours && row.dodoCustomerId !== null,
    },
  };
}

/** 80% of the included fetches — the usage bar's warning line, and the email's. */
export const USAGE_WARN_AT = WARN_AT;

/* ── checkout ──────────────────────────────────────────────────────────────── */

/**
 * A hosted checkout for `plan` at `interval`, for an organisation not yet
 * subscribed. Returns the URL to send the browser to.
 *
 * Refused for an organisation that already has a subscription (a second
 * checkout would charge twice — the plan is changed instead), for one whose
 * paid checkout is still being applied, and for one whose plan support set by
 * hand. The checkout is recorded — with the random nonce its metadata carries —
 * before its URL is handed out, so the payment and the subscription that come
 * back can be placed, and nothing that did not come from this checkout can be.
 *
 * A repeat of the same request (the same `idempotencyKey`) is answered with
 * the first one's checkout instead of a second one; `replayed` says so.
 */
export async function startCheckout(
  services: ServiceContext,
  scope: OrgScope,
  principal: Extract<Principal, { kind: 'user' }>,
  selection: { plan: PurchasablePlan; interval: BillingInterval },
  idempotencyKey: string | null = null,
): Promise<{ url: string; seats: number; replayed: boolean }> {
  const config = requireBillingConfig(services);
  const orgId = scope.organization.id;

  const { result, replayed } = await onceForKey(
    services,
    {
      orgId,
      kind: 'checkout',
      key: idempotencyKey,
      fingerprint: `${selection.plan}:${selection.interval}`,
    },
    async () => {
      const row = await subscriptionOf(services, orgId);
      if (hasLiveSubscription(row)) throw errors.billingAlreadySubscribed();
      if (managedBySupport(row)) throw errors.billingManagedBySupport();
      if (awaitingActivation(row)) throw errors.billingCheckoutPending();
      // A Free row still carrying the other Dodo mode's ids: its payment would
      // be taken here and then refused by the webhook (`other-mode`), so the
      // owner would be charged for nothing. Refused before Dodo is asked.
      if (!sameMode(row, config)) throw errors.billingOtherMode();

      const seats = providerSeats(
        selection.plan,
        await seatedMemberCount(services.db, orgId),
      ).billed;
      const now = new Date();
      const lockHolds =
        row.regionLockedUntil !== null &&
        row.regionLockedUntil > now &&
        row.billingCountry !== null &&
        row.currency !== null;
      const nonce = checkoutNonce();

      let session: { sessionId: string; url: string };
      try {
        session = await billingProvider(config).createCheckoutSession({
          productId: productFor(config, selection.plan, selection.interval),
          quantity: seats,
          // The organisation's own customer, when it has one in this Dodo mode
          // — only ever created by a checkout of its own, never shared with
          // another organisation. Otherwise a new one, whatever Dodo already
          // has for the address.
          customer:
            row.dodoCustomerId !== null && sameMode(row, config)
              ? { customerId: row.dodoCustomerId }
              : { email: principal.user.email, name: principal.user.displayName },
          returnUrl: `${billingPage(services, scope.organization.slug)}?checkout=returned`,
          orgId,
          nonce,
          regionLock: lockHolds ? { country: row.billingCountry!, currency: row.currency! } : null,
        });
      } catch (cause) {
        throw providerFailure(services, cause, 'creating a checkout');
      }

      // A link we send a browser to: https and nothing else.
      if (!URL.canParse(session.url) || new URL(session.url).protocol !== 'https:') {
        throw errors.billingProviderRefused('dodo checkout url was not https');
      }

      await recordCheckout(services.db, {
        sessionId: session.sessionId,
        orgId,
        plan: selection.plan,
        billingInterval: selection.interval,
        quantity: seats,
        createdBy: principal.user.id,
        nonce,
      });
      return { url: session.url, seats };
    },
  );
  return { url: result.url, seats: result.seats, replayed };
}

/* ── plan change ───────────────────────────────────────────────────────────── */

export interface PlannedChange {
  change: PlanChange;
  subscriptionId: string;
  /** `now` for an upgrade, `renewal` for a downgrade — the pricing page's promise. */
  effective: 'now' | 'renewal';
  seats: number;
  previous: { plan: string; interval: BillingInterval | null };
}

/**
 * What moving to `selection` would ask Dodo for.
 *
 * Moving up — a higher plan, or monthly to yearly — takes effect at once:
 * Dodo's `prorated_immediately` credits the unused part of the current period
 * and charges a full period of the new plan, which starts that day. Moving
 * down waits for the end of the period already paid for (pricing FAQ, "Can I
 * move between plans?"), and nothing is deleted when it lands. Either way the
 * seats are counted, and floored at the new plan's minimum; and a change whose
 * charge fails is not applied.
 */
async function planChange(
  services: ServiceContext,
  scope: OrgScope,
  config: BillingConfig,
  selection: { plan: PurchasablePlan; interval: BillingInterval },
): Promise<PlannedChange> {
  const orgId = scope.organization.id;
  const row = await subscriptionOf(services, orgId);
  if (managedBySupport(row)) throw errors.billingManagedBySupport();
  if (!hasLiveSubscription(row) || row.dodoSubscriptionId === null) {
    throw errors.billingNoSubscription();
  }
  if (!sameMode(row, config)) throw errors.billingOtherMode();

  const current = resolvePlanId(row.plan);
  if (current === selection.plan && row.billingInterval === selection.interval) {
    throw errors.billingSamePlan();
  }

  const upgrade =
    PLAN_RANK[selection.plan] > PLAN_RANK[current] ||
    (PLAN_RANK[selection.plan] === PLAN_RANK[current] &&
      row.billingInterval === 'monthly' &&
      selection.interval === 'yearly');

  const seats = providerSeats(selection.plan, await seatedMemberCount(services.db, orgId)).billed;

  return {
    subscriptionId: row.dodoSubscriptionId,
    effective: upgrade ? 'now' : 'renewal',
    seats,
    previous: { plan: row.plan, interval: row.billingInterval },
    change: {
      productId: productFor(config, selection.plan, selection.interval),
      quantity: seats,
      proration: 'prorated_immediately',
      effectiveAt: upgrade ? 'immediately' : 'next_billing_date',
      onPaymentFailure: 'prevent_change',
    },
  };
}

/** What a change would charge now — shown before the owner confirms. */
export async function previewPlanChange(
  services: ServiceContext,
  scope: OrgScope,
  selection: { plan: PurchasablePlan; interval: BillingInterval },
): Promise<{
  effective: 'now' | 'renewal';
  seats: number;
  charge: string | null;
  preview: PlanChangePreview | null;
}> {
  const config = requireBillingConfig(services);
  const planned = await planChange(services, scope, config, selection);
  // A downgrade charges nothing now; there is nothing to preview.
  if (planned.effective === 'renewal') {
    return { effective: 'renewal', seats: planned.seats, charge: null, preview: null };
  }
  let preview: PlanChangePreview;
  try {
    preview = await billingProvider(config).previewPlanChange(
      planned.subscriptionId,
      planned.change,
    );
  } catch (cause) {
    throw providerFailure(services, cause, 'previewing a plan change');
  }
  return {
    effective: 'now',
    seats: planned.seats,
    charge: formatMinor(preview.amountMinor, preview.currency),
    preview,
  };
}

/** What a plan change request answered, as a replay of its key answers it too. */
export interface RequestedChange {
  effective: 'now' | 'renewal';
  seats: number;
  previous: { plan: string; interval: BillingInterval | null };
}

/**
 * Asks Dodo to move the subscription. **Grants nothing**: the plan changes
 * when Dodo's `subscription.plan_changed` arrives and the webhook applies it.
 *
 * A repeat of the same request (the same `idempotencyKey`) is answered with
 * the first one's answer and never reaches Dodo again — an upgrade asked twice
 * is one proration, not two.
 */
export async function requestPlanChange(
  services: ServiceContext,
  scope: OrgScope,
  selection: { plan: PurchasablePlan; interval: BillingInterval },
  idempotencyKey: string | null = null,
): Promise<RequestedChange & { replayed: boolean }> {
  const config = requireBillingConfig(services);
  const { result, replayed } = await onceForKey(
    services,
    {
      orgId: scope.organization.id,
      kind: 'change',
      key: idempotencyKey,
      fingerprint: `${selection.plan}:${selection.interval}`,
    },
    async () => {
      const planned = await planChange(services, scope, config, selection);
      try {
        await billingProvider(config).changePlan(planned.subscriptionId, planned.change);
      } catch (cause) {
        throw providerFailure(services, cause, 'changing a plan');
      }
      return { effective: planned.effective, seats: planned.seats, previous: planned.previous };
    },
  );
  return { ...result, replayed };
}

/* ── the customer portal ───────────────────────────────────────────────────── */

/**
 * A link into Dodo's customer portal — the card, the invoices, cancelling.
 * We build no card or invoice UI; this is one less place a card number could
 * go wrong. The link is a session at Dodo and is never stored or logged.
 */
export async function openPortal(services: ServiceContext, scope: OrgScope): Promise<string> {
  const config = requireBillingConfig(services);
  const row = await subscriptionOf(services, scope.organization.id);
  if (row.dodoCustomerId === null) throw errors.billingNoSubscription();
  if (!sameMode(row, config)) throw errors.billingOtherMode();
  // The portal shows a customer's every card and invoice. Opened only for a
  // customer this organisation alone holds: one shared with another
  // organisation — possible only for rows from before checkouts forced a
  // customer per organisation — is refused, and raised for a human to split.
  if ((await countOrgsWithDodoCustomer(services.db, row.dodoCustomerId)) !== 1) {
    services.log
      .at('billing')
      .error(
        'An organisation’s Dodo customer is held by another organisation too; its customer ' +
          'portal was not opened. Give each organisation its own customer in Dodo',
        { orgId: scope.organization.id },
      );
    throw errors.billingSharedCustomer();
  }

  let link: string;
  try {
    ({ link } = await billingProvider(config).createPortalSession(
      row.dodoCustomerId,
      billingPage(services, scope.organization.slug),
    ));
  } catch (cause) {
    throw providerFailure(services, cause, 'opening the customer portal');
  }
  if (!URL.canParse(link) || new URL(link).protocol !== 'https:') {
    throw errors.billingProviderRefused('dodo portal link was not https');
  }
  return link;
}

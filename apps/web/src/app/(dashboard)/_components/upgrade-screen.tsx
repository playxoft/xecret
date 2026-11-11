'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { api, errorMessage, isApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { PageHeader } from '@/components/layout';
import { ComplimentaryPlanNotice } from '@/components/plans/complimentary-plan';
import { ADDON_NOT_YET, formatCount, NOT_YET } from '@/components/plans/pricing-content';
import type { Cell } from '@/components/plans/pricing-content';
import { checkoutPromoCode, PromoCodeField } from '@/components/plans/promo-code-field';
import {
  Alert,
  ArrowRightIcon,
  Badge,
  Button,
  CheckIcon,
  ChevronDownIcon,
  HistoryIcon,
  MinusIcon,
  ShieldCheckIcon,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  TerminalIcon,
} from '@/components/ui';
import type { PromoCodePreviewPayload } from '@/server/schemas/admin';
import type { BillingStatusPayload } from '@/server/schemas/billing';
import { apiPath, appPath, withQuery } from '../_lib/paths';
import { useApiResource } from '../_lib/use-api-resource';
import { ErrorState } from './resource-states';
import { Segmented } from './segmented';
import { canAdminister, useOrganization } from './session';
import {
  billingTerm,
  COMPARISON_COLUMNS,
  comparisonFor,
  ENTERPRISE_CAVEAT,
  ENTERPRISE_PRICE,
  FREE_PRICE,
  nextCeiling,
  pastTheAllowance,
  PLAN_OFFERS,
  PURCHASE_FAQ,
  switchPlanHref,
  USD_PRICES,
  YEARLY_SAVING_UP_TO,
  yearlySaving,
} from './upgrade-plans';
import type {
  BillingPeriod,
  ComparisonPlanId,
  OfferPlanId,
  PaidPlanId,
  PlanOffer,
} from './upgrade-plans';

/**
 * The plans, inside the app — `/app/{org}/settings/plans`, where "Upgrade
 * plan" in the account menu and every "Compare plans" beside a locked control
 * lead.
 *
 * ── Who sees what ──
 * Every member sees the whole page: the three self-serve plans, the pricing
 * page's whole comparison table, what stays true on all of them, and — where
 * anything is sold — the pricing page's questions about the money. Somebody
 * who has just met a locked switch deserves the answer to "what would it
 * take?" whether or not they hold the card.
 *
 * ── The same table and questions as /pricing ──
 * The rows and the answers are the pricing page's, read from the module both
 * pages render (`components/plans/pricing-content.ts`), so the two cannot
 * drift apart; what is this page's is the markup, the four columns an
 * organisation on the hosted service can be on, and the purchase at the top
 * of each column. `upgrade-plans.ts` says what is left out where, and why.
 *
 * Only an owner is offered anything to press. `GET …/billing` and the checkout
 * are owner-only (`billing.manage`) and `/api/auth/me` carries no plan, so for
 * anybody else the organisation's current plan is simply unknowable — the page
 * says who can change it instead of drawing buttons that would be refused, and
 * marks no card as current rather than guessing. The session's authority
 * decides whether to ask at all, as the billing screen's does; a `forbidden`
 * answer from the server — a role changed since the session was read — lands
 * on the same calm sentence, never on an error card.
 *
 * ── An installation that sells nothing ──
 * The server component says whether this deployment can take a payment at all
 * (`payments.taken`). Where it cannot — a self-hoster, or this deployment
 * before a payment provider — the page still compares the plans, because the
 * plan still decides what the organisation can do, but it shows no price, no
 * saving, no button and no "ask an owner": there is nothing anybody here could
 * buy, and a price would be an offer nobody can take up.
 *
 * ── What it never does ──
 * Change a subscription. A checkout is started here, with the billing screen's
 * own request and its one-key-per-decision idempotency; anything that moves an
 * existing subscription — the proration preview, the confirm — stays on the
 * billing screen, and "Switch to …" opens it on the plan and period chosen
 * here. Coming back from checkout lands on the billing screen too, which is
 * where the wait for the payment is watched; a `?checkout=returned` that
 * reaches this page is pointed there rather than polled twice.
 *
 * ── A code from xecret ──
 * Under the cards, for an owner the billing read allows one
 * (`actions.promoCode`): the billing screen's "Have a code?", the same
 * component. A free-plan code is redeemed on the spot and the page re-reads
 * the plan; a discount code is held here and goes with an "Upgrade to …" for a
 * plan it covers — as part of the decision, so it is under the decision's key.
 */

type Billing = BillingStatusPayload;

/** What the server component knows about money here. */
export interface PaymentsHere {
  /** Whether a checkout can be started on this deployment — live or test mode. */
  readonly taken: boolean;
  /** `OVERAGE_RATE_TEXT`: what a fetch past a paid plan's allowance costs. */
  readonly overageRate: string;
}

const PLAN_NAME: Record<Billing['plan'], string> = {
  free: 'Free',
  pro: 'Pro',
  team: 'Team',
  enterprise: 'Enterprise',
};

const STATUS_LABEL: Partial<Record<Billing['status'], string>> = {
  trialing: 'Trial',
  past_due: 'Payment overdue',
  on_hold: 'Payment failed',
  cancelled: 'Cancelled',
  expired: 'Ended',
};

const RESOURCE_NAME: Record<Billing['warnings'][number]['resource'], string> = {
  seats: 'seats',
  projects: 'projects',
  serviceTokens: 'service tokens',
};

const count = (value: number) => value.toLocaleString('en-GB');

/** The server said this viewer may not manage billing — the only reading of a 403 here. */
function isNotOwner(error: unknown): boolean {
  return isApiError(error) && error.code === 'forbidden';
}

/** What a card offers at its foot. */
type Offer =
  | { kind: 'none' }
  | { kind: 'loading' }
  | { kind: 'current' }
  | { kind: 'checkout'; plan: PaidPlanId }
  | { kind: 'change'; plan: PaidPlanId };

export function UpgradeScreen({
  orgSlug,
  returnedFromCheckout,
  payments,
}: {
  orgSlug: string;
  returnedFromCheckout: boolean;
  payments: PaymentsHere;
}) {
  const membership = useOrganization(orgSlug);
  const mayManage = canAdminister(membership, 'billing.manage');
  const selling = payments.taken;
  // Nothing is asked where nothing is sold: the plan read only decides which
  // button to draw, and there are none to draw.
  const resource = useApiResource<{ billing: Billing }>(
    selling && mayManage ? apiPath.billing(orgSlug) : null,
  );
  const orgName = membership?.name ?? orgSlug;

  // A checkout refused as `forbidden` means the same as a refused read: the
  // session's idea of this viewer's role is out of date.
  const [refused, setRefused] = useState(false);
  const notOwner = !mayManage || refused || isNotOwner(resource.error);

  const billing = !selling || notOwner ? null : (resource.data?.billing ?? null);
  const loading = selling && !notOwner && resource.loading && billing === null;
  const loadFailed = selling && !notOwner && !loading && resource.error !== null;

  // Yearly first, as the pricing page opens: it is the rate most teams pick,
  // and the toggle says what monthly costs one click away.
  const [period, setPeriod] = useState<BillingPeriod>('yearly');

  // ── A discount code ──
  // Held here, because the checkout that carries it is started here, and read
  // through `actions.promoCode` so a code applied before the plan changed is
  // never sent with a checkout that no longer takes one.
  const [promo, setPromo] = useState<PromoCodePreviewPayload | null>(null);
  const appliedPromo = billing?.actions.promoCode === true ? promo : null;

  // ── The checkout ──
  // One idempotency key per decision — the plan, the period and the promo
  // code — kept for a retry of the same choice, so a double click or a retry
  // after an answer that never arrived is one checkout at Dodo, and replaced
  // when the choice changes. The billing screen's rule, for the same request;
  // the server fingerprints the key with the code, and refuses the same key
  // with another.
  const decision = useRef<{
    plan: PaidPlanId;
    period: BillingPeriod;
    code: string | null;
    key: string;
  } | null>(null);
  const [busy, setBusy] = useState<PaidPlanId | null>(null);
  // Where the button that failed was — a card, or the head of a table column —
  // so the sentence lands beside the button that was pressed rather than a
  // screen away from it. The key is the decision's, not the button's: either
  // button for one plan and period retries the same checkout.
  const [failure, setFailure] = useState<{
    plan: PaidPlanId;
    at: CheckoutButton;
    error: unknown;
  } | null>(null);

  async function checkout(plan: PaidPlanId, at: CheckoutButton) {
    // Only for a plan the discount covers; any other goes at the full price,
    // and its card says so.
    const code = checkoutPromoCode(appliedPromo, plan);
    const previous = decision.current;
    const key =
      previous !== null &&
      previous.plan === plan &&
      previous.period === period &&
      previous.code === code
        ? previous.key
        : crypto.randomUUID();
    decision.current = { plan, period, code, key };

    setBusy(plan);
    setFailure(null);
    try {
      const { url } = await api.post<{ url: string }>(
        apiPath.billingCheckout(orgSlug),
        { plan, interval: period, ...(code === null ? {} : { promoCode: code }) },
        { idempotencyKey: key },
      );
      // Left busy: the page is about to be replaced by Dodo's checkout.
      window.location.assign(url);
    } catch (cause) {
      if (isNotOwner(cause)) setRefused(true);
      else setFailure({ plan, at, error: cause });
      setBusy(null);
    }
  }

  function offerFor(id: OfferPlanId): Offer {
    if (!selling || notOwner || loadFailed) return { kind: 'none' };
    if (loading || billing === null) return { kind: 'loading' };
    if (billing.plan === id) return { kind: 'current' };
    // Down to Free is cancelling, which is the customer portal's — reached
    // from the billing screen, and not something this page sells.
    if (id === 'free') return { kind: 'none' };
    if (!billing.enabled || billing.managedBy === 'support') return { kind: 'none' };
    if (billing.actions.checkout) return { kind: 'checkout', plan: id };
    if (billing.actions.changePlan) return { kind: 'change', plan: id };
    return { kind: 'none' };
  }

  function footFor(offer: PlanOffer): ReactNode {
    const offered = offerFor(offer.id);
    switch (offered.kind) {
      case 'none':
        return null;
      case 'loading':
        return <Skeleton className="h-9 w-full" />;
      case 'current':
        return (
          <Button variant="secondary" className="w-full" disabled>
            Your current plan
          </Button>
        );
      case 'checkout':
        return (
          <div className="flex flex-col gap-2">
            <Button
              variant={offer.recommended ? 'primary' : 'secondary'}
              className="w-full"
              loading={busy === offered.plan}
              disabled={busy !== null && busy !== offered.plan}
              onClick={() => void checkout(offered.plan, 'card')}
            >
              Upgrade to {offer.name}
              <ArrowRightIcon className="size-4" />
            </Button>
            {appliedPromo !== null ? (
              <p className="text-fg-subtle text-center text-xs leading-5">
                {checkoutPromoCode(appliedPromo, offered.plan) !== null
                  ? `${appliedPromo.code} comes off at checkout.`
                  : `${appliedPromo.code} does not apply to ${offer.name}.`}
              </p>
            ) : null}
            {failure?.plan === offered.plan && failure.at === 'card' ? (
              <CheckoutFailure error={failure.error} />
            ) : null}
          </div>
        );
      case 'change':
        return (
          <div className="flex flex-col gap-2">
            <Button
              variant={offer.recommended ? 'primary' : 'secondary'}
              className="w-full"
              asChild
            >
              {/* The period showing on this page goes with the link, so the
                  billing screen opens on the choice that was made here. */}
              <Link href={switchPlanHref(orgSlug, offered.plan, period)}>
                Switch to {offer.name}
                <ArrowRightIcon className="size-4" />
              </Link>
            </Button>
            <p className="text-fg-subtle text-center text-xs leading-5">
              You review it on the billing screen before anything changes.
            </p>
          </div>
        );
    }
  }

  const currentPlan = billing?.plan ?? null;

  /**
   * What the head of a table column offers: the card's action, compact. The
   * same decision as `footFor` — `offerFor` makes it for both — so a column
   * can never offer what its card refuses. Enterprise has no checkout and
   * never will here: it is a conversation, offered wherever anything is sold.
   */
  function headFor(plan: ComparisonPlanId): ReactNode {
    if (plan === 'enterprise') {
      if (currentPlan === 'enterprise') return <CurrentPlanMark />;
      if (!selling) return null;
      return (
        <Button variant="secondary" size="sm" className="w-full" asChild>
          <Link href="/contact">Talk to us</Link>
        </Button>
      );
    }

    const offered = offerFor(plan);
    const name = PLAN_NAME[plan];
    // The card's emphasis, so the recommended plan's button is the loud one in
    // both places it appears.
    const variant = PLAN_OFFERS.some((offer) => offer.id === plan && offer.recommended)
      ? 'primary'
      : 'secondary';
    switch (offered.kind) {
      case 'none':
        return null;
      case 'loading':
        return <Skeleton className="h-8 w-full" />;
      case 'current':
        return <CurrentPlanMark />;
      case 'checkout':
        return (
          <div className="flex flex-col gap-2">
            <Button
              variant={variant}
              size="sm"
              className="w-full"
              loading={busy === offered.plan}
              disabled={busy !== null && busy !== offered.plan}
              onClick={() => void checkout(offered.plan, 'table')}
            >
              Upgrade to {name}
            </Button>
            {failure?.plan === offered.plan && failure.at === 'table' ? (
              <CheckoutFailure error={failure.error} compact />
            ) : null}
          </div>
        );
      case 'change':
        return (
          <Button variant={variant} size="sm" className="w-full" asChild>
            <Link href={switchPlanHref(orgSlug, offered.plan, period)}>Switch to {name}</Link>
          </Button>
        );
    }
  }

  const statusLabel =
    billing !== null && billing.plan !== 'free' ? (STATUS_LABEL[billing.status] ?? null) : null;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
      <PageHeader
        title={selling ? `Upgrade ${orgName}` : `Plans for ${orgName}`}
        description={
          selling
            ? 'Every paid plan is priced per member, with a lower yearly rate. Service tokens, CI runners and agents never take a seat, and a build never fails for a billing reason.'
            : 'What each plan includes.'
        }
        badge={
          billing !== null ? (
            <Badge tone="neutral">
              On {PLAN_NAME[billing.plan]}
              {statusLabel !== null ? ` · ${statusLabel}` : ''}
            </Badge>
          ) : null
        }
        actions={
          !selling || notOwner ? null : (
            <Button variant="ghost" asChild>
              <Link href={appPath.orgBilling(orgSlug)}>Billing</Link>
            </Button>
          )
        }
      />

      <Notices
        orgSlug={orgSlug}
        orgName={orgName}
        selling={selling}
        notOwner={notOwner}
        returnedFromCheckout={returnedFromCheckout}
        billing={billing}
        loadFailed={loadFailed ? resource.error : null}
        onRetry={() => void resource.reload()}
      />

      <section aria-labelledby="plans-heading" className="flex flex-col gap-5">
        <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-between">
          <h2 id="plans-heading" className="text-fg text-base font-semibold">
            {selling && !notOwner ? 'Choose a plan' : 'Compare plans'}
          </h2>
          {selling ? (
            <Segmented
              label="Billing period"
              options={[
                { value: 'monthly', label: 'Monthly' },
                {
                  value: 'yearly',
                  label: (
                    <>
                      Yearly
                      {/* A tint pill rather than bare green text, so it reads
                          the same on the selected and unselected segment. */}
                      <span className="bg-success-tint text-success-text rounded-full px-1.5 py-0.5 text-xs font-normal">
                        Save up to {YEARLY_SAVING_UP_TO}%
                      </span>
                    </>
                  ),
                },
              ]}
              value={period}
              onChange={(next) => {
                setPeriod(next);
                // A failure belongs to the choice that failed; a new period is
                // a new choice, with a new key when it is sent.
                setFailure(null);
              }}
            />
          ) : null}
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          {PLAN_OFFERS.map((offer) => (
            <PlanCard
              key={offer.id}
              offer={offer}
              period={period}
              payments={payments}
              current={currentPlan === offer.id}
              foot={footFor(offer)}
            />
          ))}
        </div>

        {/* Under the cards whose buttons it changes, and only where the
            billing read allows a code at all — which also means an owner. */}
        {billing !== null && billing.actions.promoCode ? (
          <PromoCodeField
            orgSlug={orgSlug}
            applied={appliedPromo}
            onApplied={(next) => {
              setPromo(next);
              // A failure belongs to the decision that failed; with or without
              // a code is a different one.
              setFailure(null);
            }}
            discounts={billing.actions.checkout}
            // The re-read is what shows it: the plan's badge in the header,
            // its card marked current, and the complimentary plan's notice.
            onRedeemed={() => void resource.reload()}
            className="max-w-md"
          />
        ) : null}

        <EnterpriseRow selling={selling} current={currentPlan === 'enterprise'} />

        {selling ? (
          <p className="text-fg-subtle text-center text-sm leading-6">
            Prices in US dollars. Checkout shows yours, in your billing currency, before you pay —
            every currency is on the{' '}
            <Link
              href="/pricing"
              className="text-fg decoration-line-strong hover:decoration-fg underline underline-offset-4"
            >
              pricing page
            </Link>
            .
          </p>
        ) : null}
      </section>

      <ComparisonTable selling={selling} period={period} headFor={headFor} />

      {/* About money, so only where money is taken. */}
      {selling ? <Promises overageRate={payments.overageRate} /> : null}
      {selling ? <PurchaseQuestions /> : null}
    </div>
  );
}

/** Which of the two buttons for one plan a checkout was started from. */
type CheckoutButton = 'card' | 'table';

/** Why a checkout did not start, beside the button that started it. */
function CheckoutFailure({ error, compact = false }: { error: unknown; compact?: boolean }) {
  return (
    <div
      role="alert"
      className={cn(
        'text-danger-text text-left',
        compact ? 'text-xs leading-5' : 'text-sm leading-5',
      )}
    >
      <p>Nothing was changed. {errorMessage(error)}</p>
      {isApiError(error) && error.requestId ? (
        <p className="text-fg-subtle mt-1">
          Request id: <code className="font-mono break-all select-all">{error.requestId}</code>
        </p>
      ) : null}
    </div>
  );
}

/** The current plan, at the head of its column, where a button would otherwise be. */
function CurrentPlanMark() {
  return (
    <span className="flex h-8 items-center justify-center">
      <Badge tone="success" className="text-xs">
        Current plan
      </Badge>
    </span>
  );
}

/* ── The notices above the plans ───────────────────────────────────────────── */

function Notices({
  orgSlug,
  orgName,
  selling,
  notOwner,
  returnedFromCheckout,
  billing,
  loadFailed,
  onRetry,
}: {
  orgSlug: string;
  orgName: string;
  selling: boolean;
  notOwner: boolean;
  returnedFromCheckout: boolean;
  billing: Billing | null;
  /** The failure, when the plan could not be read for any reason but "not an owner". */
  loadFailed: unknown;
  onRetry: () => void;
}) {
  // The one thing worth saying where nothing is sold — and it is said to
  // everybody, owner or not, because nobody here can buy anything.
  if (!selling) {
    return (
      <Alert tone="info" title="This installation does not take payments">
        <p>Plans here are set by whoever runs it. Below is what each one includes.</p>
      </Alert>
    );
  }

  const notices: ReactNode[] = [];

  if (notOwner) {
    // Info, not danger: nothing has gone wrong, and the remedy is a person.
    notices.push(
      <Alert key="owner" tone="info" title="Only an organisation owner can change the plan">
        <p>
          Ask an owner of {orgName} to upgrade it. The plan covers everybody in the organisation,
          and below is everything they will be choosing between.
        </p>
      </Alert>,
    );
  }

  if (!notOwner && returnedFromCheckout) {
    notices.push(
      <Alert key="returned" tone="info" title="Finishing your upgrade">
        <p>
          The plan changes as soon as our payment provider confirms the payment — usually within a
          minute.{' '}
          <Link
            href={withQuery(appPath.orgBilling(orgSlug), { checkout: 'returned' })}
            className="text-fg font-medium underline underline-offset-4"
          >
            Watch it on the billing screen
          </Link>
          .
        </p>
      </Alert>,
    );
  }

  if (loadFailed !== null && loadFailed !== undefined) {
    notices.push(
      <ErrorState
        key="failed"
        subject="this organisation’s plan"
        error={loadFailed}
        onRetry={onRetry}
      />,
    );
  }

  if (billing !== null) {
    if (billing.enabled && billing.mode === 'test_mode') {
      notices.push(
        <Alert key="test" tone="warning" title="Test mode">
          <p>This installation’s payments are in test mode: no real card is charged.</p>
        </Alert>,
      );
    }

    if (!billing.enabled) {
      // The server component said payments are on and the billing read says
      // they are not — a configuration changed between the two. Believe the
      // later answer.
      notices.push(
        <Alert key="disabled" tone="info" title="This installation does not take payments">
          <p>Plans here are set by whoever runs it.</p>
        </Alert>,
      );
    } else if (billing.managedBy === 'support' && billing.grant !== null) {
      notices.push(
        <ComplimentaryPlanNotice key="support" plan={billing.plan} grant={billing.grant} />,
      );
    } else if (billing.managedBy === 'support') {
      notices.push(
        <Alert key="support" tone="info" title="Managed by xecret support">
          <p>
            This organisation’s plan was arranged with us directly, so it is changed by us too.{' '}
            <Link href="/contact" className="text-fg font-medium underline underline-offset-4">
              Contact us
            </Link>{' '}
            to change it.
          </p>
        </Alert>,
      );
    } else if (!billing.actions.checkout && !billing.actions.changePlan) {
      notices.push(
        <Alert key="elsewhere" tone="info" title="Plan changes are on the billing screen">
          <p>
            This organisation’s subscription cannot be changed from here right now.{' '}
            <Link
              href={appPath.orgBilling(orgSlug)}
              className="text-fg font-medium underline underline-offset-4"
            >
              Open billing
            </Link>{' '}
            for the details.
          </p>
        </Alert>,
      );
    }

    if (billing.warnings.length > 0) {
      notices.push(
        <Alert key="limits" tone="warning" title={`${orgName} is close to a limit`}>
          <ul className="list-disc pl-5">
            {billing.warnings.map((warning) => {
              // Measured against the ceiling the server warned at — which may
              // be one support raised — never the plan's default.
              const next =
                warning.limit === null
                  ? null
                  : nextCeiling(billing.plan, warning.resource, warning.limit);
              return (
                <li key={warning.resource}>
                  {count(warning.current)} {RESOURCE_NAME[warning.resource]}
                  {warning.limit === null
                    ? ' — past the fair-use level we check in about. Nothing is blocked.'
                    : ` of ${count(warning.limit)}.`}
                  {next !== null ? ` ${next.sentence}` : ''}
                </li>
              );
            })}
          </ul>
        </Alert>,
      );
    }
  }

  if (notices.length === 0) return null;
  return <div className="flex flex-col gap-3">{notices}</div>;
}

/* ── The cards ─────────────────────────────────────────────────────────────── */

function PlanCard({
  offer,
  period,
  payments,
  current,
  foot,
}: {
  offer: PlanOffer;
  period: BillingPeriod;
  payments: PaymentsHere;
  current: boolean;
  foot: ReactNode;
}) {
  return (
    <article
      aria-labelledby={`plan-${offer.id}`}
      className={cn(
        'bg-surface shadow-raised flex h-full flex-col rounded-xl border p-5',
        // The pricing page's treatment: an accent edge on the recommended plan,
        // and nothing louder. The current plan is said in words, not colour.
        offer.recommended ? 'border-accent' : 'border-line',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`plan-${offer.id}`} className="text-fg text-base font-semibold">
          {offer.name}
        </h3>
        {current ? (
          <Badge tone="success" className="text-xs">
            Current plan
          </Badge>
        ) : offer.recommended && payments.taken ? (
          <Badge tone="accent" className="text-xs">
            Recommended
          </Badge>
        ) : null}
      </div>

      {/* The price and the seat floor under it are both terms of a sale, so
          neither is shown where there is no sale to make. */}
      {payments.taken ? (
        <>
          <Price plan={offer.id} period={period} />
          {offer.caveat !== null ? (
            <p className="text-fg-subtle mt-2 text-xs leading-5">{offer.caveat}</p>
          ) : null}
        </>
      ) : null}

      <p className="text-fg-muted border-line-subtle mt-4 border-t pt-4 text-sm leading-6">
        {offer.audience}
      </p>

      <ul className="mt-4 space-y-2.5">
        {offer.features.map((feature) => (
          <li key={feature} className="flex gap-2.5">
            <CheckIcon className="text-success-text mt-1 size-4 shrink-0" />
            <span className="text-fg-muted text-sm leading-6">{feature}</span>
          </li>
        ))}
        {/* The allowance, with what happens past it said beside the number —
            on a paid plan that is a charge, and a charge is not small print. */}
        <li className="flex gap-2.5">
          <CheckIcon className="text-success-text mt-1 size-4 shrink-0" />
          <span className="text-fg-muted text-sm leading-6">
            {formatCount(offer.includedFetches)} secret fetches a month included
            <span className="text-fg-subtle block text-xs leading-5">
              {pastTheAllowance(offer.id, payments)}
            </span>
          </span>
        </li>
      </ul>

      {foot !== null ? <div className="mt-auto pt-6">{foot}</div> : null}
    </article>
  );
}

function Price({ plan, period }: { plan: OfferPlanId; period: BillingPeriod }) {
  const figure = plan === 'free' ? null : USD_PRICES[plan][period];

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <p className="text-fg text-3xl font-semibold tracking-[-0.02em]">
          {figure?.price ?? FREE_PRICE.price}
        </p>
        {plan !== 'free' && period === 'yearly' ? (
          <span className="bg-success-tint text-success-text rounded-full px-1.5 py-0.5 text-xs font-medium">
            Save {yearlySaving(plan)}% on monthly
          </span>
        ) : null}
      </div>
      <p className="text-fg-subtle mt-1 text-sm">{figure?.unit ?? FREE_PRICE.unit}</p>
      {/* Every card keeps the third line's height, shown or not, so pressing
          the toggle never moves a card's list or its button. */}
      {figure?.note ? (
        <p className="text-fg-subtle mt-1 text-xs leading-5">{figure.note}</p>
      ) : (
        <p aria-hidden="true" className="invisible mt-1 text-xs leading-5">
          &nbsp;
        </p>
      )}
    </div>
  );
}

/**
 * Enterprise, slim: there is no price to show and nothing to check out.
 *
 * Its sentence names only what the pricing page's Enterprise card names
 * without a "Coming soon" chip — the comparison table below is that page's,
 * and a sentence here claiming more than the table would be the page arguing
 * with itself. Custom roles are among them: built, gated to this plan by
 * `requireFeature(…, 'customRoles')`, and ticked at Enterprise in the shared
 * table since 2026-11-08 (the note at the top of `upgrade-plans.ts`). What is
 * marked "Coming soon" and is in fact unbuilt (SAML, SCIM, residency, a
 * customer-held root key, SIEM) is left out.
 */
function EnterpriseRow({ selling, current }: { selling: boolean; current: boolean }) {
  return (
    <article
      aria-labelledby="plan-enterprise"
      className="border-line bg-surface shadow-raised flex flex-col gap-4 rounded-xl border p-5 sm:flex-row sm:items-center sm:justify-between sm:gap-8"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h3 id="plan-enterprise" className="text-fg text-base font-semibold">
            Enterprise
          </h3>
          {selling ? (
            <span className="text-fg-subtle text-sm">Custom, invoiced with an SLA</span>
          ) : null}
          {current ? (
            <Badge tone="success" className="text-xs">
              Current plan
            </Badge>
          ) : null}
        </div>
        <p className="text-fg-muted mt-1.5 text-sm leading-6">
          Everything in Team, custom roles, no ceiling on projects, environments, secrets or tokens,
          custom audit retention, a commercial self-hosting licence, and a contractual SLA with a
          named contact.
          {selling && ENTERPRISE_CAVEAT !== null ? ` ${ENTERPRISE_CAVEAT}.` : ''}
        </p>
      </div>
      {selling ? (
        <Button variant="secondary" asChild className="shrink-0">
          <Link href="/contact">
            Talk to us
            <ArrowRightIcon className="size-4" />
          </Link>
        </Button>
      ) : null}
    </article>
  );
}

/* ── What each plan unlocks ────────────────────────────────────────────────── */

/**
 * The pricing page's comparison table — every group and every row of the
 * shared `PLAN_COMPARISON` — in the dashboard's own table, with what can be
 * done about each plan at the head of its column.
 *
 * ── The header ──
 * It used to be one 36px row with the plan's name and a "Current" squeezed in
 * under it: the most cramped thing on the page. Each column now has a line for
 * the name, the figure for the period chosen above, what the figure is per,
 * the term it is billed on, and the column's action, with room above and below
 * — and every column keeps the same lines in the same order, a missing one held
 * open, so the figures and the buttons sit level across the row.
 *
 * ── Who is offered what ──
 * The cards' rules exactly, through `headFor` and the same `offerFor`: an owner
 * gets a checkout or a switch at the head of a column they have just read
 * down, everybody else gets the figures and no button, and Enterprise is a
 * conversation wherever anything is sold. Where nothing is, there is no figure
 * either — and no row that is a term of a sale or a fact about the hosted
 * service, which a self-hoster's installation is not (`comparisonFor`).
 *
 * ── The cells ──
 * Read from the shared rows, never restated here. A tick and a dash each carry
 * the word a screen reader needs, and "Coming soon" wears the same outlined
 * chip as on the pricing page's cards: named on the plan, not built.
 */
function ComparisonTable({
  selling,
  period,
  headFor,
}: {
  selling: boolean;
  period: BillingPeriod;
  headFor: (plan: ComparisonPlanId) => ReactNode;
}) {
  const groups = comparisonFor(selling);
  const heads = COMPARISON_COLUMNS.map((column) => ({ ...column, action: headFor(column.id) }));
  const anyAction = heads.some((head) => head.action !== null);

  return (
    <section aria-labelledby="unlocks-heading" className="flex flex-col gap-3">
      <div>
        <h2 id="unlocks-heading" className="text-fg text-base font-semibold">
          What each plan unlocks
        </h2>
        <p className="text-fg-muted mt-1 text-sm leading-6">
          Every plan compared, including the limits
          {/* Only where it is true: where nothing is sold the terms of a sale
              and the hosted service's rows are left out, and the table is no
              longer the pricing page's. */}
          {selling ? (
            <>
              {' '}
              — the same table as the{' '}
              <Link
                href="/pricing#compare"
                className="text-fg decoration-line-strong hover:decoration-fg underline underline-offset-4"
              >
                pricing page
              </Link>
            </>
          ) : null}
          . Where a plan does not have something the row says so, and where nobody has it yet the
          row says that too.
        </p>
      </div>

      {/* `relative`, so the scroll box contains its own `sr-only` words. They
          are absolutely positioned, and without a positioned ancestor the ones
          in cells past the right edge escape the box and scroll the page
          sideways on a phone. */}
      <TableContainer aria-label="Plan comparison" className="shadow-raised relative">
        {/* Fixed layout, so the four plan columns are one width whatever their
            cells say and the capability column takes the rest. Wider than a
            phone, deliberately: it scrolls inside its own box. */}
        <Table className="min-w-[52rem] table-fixed">
          <caption className="sr-only">
            Every plan compared, capability by capability, in {groups.length} groups.
            {selling
              ? ' Each column’s header shows the plan’s price for the billing period chosen above the plans.'
              : ''}
          </caption>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-auto px-4 py-5 align-bottom">
                <span className="sr-only">Capability</span>
              </TableHead>
              {heads.map((head) => (
                <TableHead
                  key={head.id}
                  className="h-auto w-40 px-3 pt-5 pb-4 text-center align-top tracking-normal whitespace-normal"
                >
                  <span className="text-fg block text-sm leading-6 font-semibold">{head.name}</span>
                  {selling ? <HeadPrice plan={head.id} period={period} /> : null}
                  {anyAction ? (
                    // Held open in a column with nothing to offer, so the row
                    // of buttons is level wherever one is missing. A `div`:
                    // an action can be a block of its own (a button and the
                    // sentence saying why it failed), and a block may not sit
                    // inside a `span`.
                    <div className="mt-4 min-h-8">{head.action}</div>
                  ) : null}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          {groups.map((group) => (
            <TableBody key={group.title}>
              <tr className="bg-canvas-inset border-line-subtle border-t">
                {/* `rowgroup`: it heads the rows of its own `<tbody>`, and is
                    read out before each of them. Not `colgroup`, which names
                    a `<colgroup>` this table does not have. (/pricing's matrix
                    has the same `colgroup` mistake — left for a pass over the
                    marketing markup.) */}
                <th
                  scope="rowgroup"
                  colSpan={COMPARISON_COLUMNS.length + 1}
                  className="text-fg-subtle px-4 pt-4 pb-2 text-left text-xs font-semibold tracking-[0.08em] uppercase"
                >
                  {group.title}
                </th>
              </tr>
              {group.rows.map((row) => (
                <TableRow key={row.label}>
                  <th scope="row" className="px-4 py-3 text-left align-top font-normal">
                    <span className="text-fg block text-sm font-medium">{row.label}</span>
                    <span className="text-fg-subtle mt-0.5 block text-sm leading-5">
                      {row.hint}
                    </span>
                  </th>
                  {COMPARISON_COLUMNS.map((column) => (
                    <TableCell key={column.id} className="px-3 py-3 text-center">
                      <ComparisonCell value={row.values[column.id]} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          ))}
        </Table>
      </TableContainer>
    </section>
  );
}

/** One plan's figure in its column header, for the period chosen above. */
function HeadPrice({ plan, period }: { plan: ComparisonPlanId; period: BillingPeriod }) {
  const figure =
    plan === 'free'
      ? FREE_PRICE
      : plan === 'enterprise'
        ? ENTERPRISE_PRICE
        : USD_PRICES[plan][period];
  const term = billingTerm(plan, period);

  return (
    <span className="mt-3 block font-normal">
      <span className="text-fg block text-xl leading-7 font-semibold tracking-[-0.02em]">
        {figure.price}
      </span>
      <span className="text-fg-subtle block text-xs leading-5">{figure.unit}</span>
      {/* Every column keeps this line, shown or not, so pressing the toggle —
          or a column without a term — never moves the buttons under it. */}
      {term !== null ? (
        <span className="text-fg-subtle block text-xs leading-5">{term}</span>
      ) : (
        <span aria-hidden="true" className="invisible block text-xs leading-5">
          &nbsp;
        </span>
      )}
    </span>
  );
}

/** A single comparison cell: a tick, a dash, "Coming soon", or what the row says. */
function ComparisonCell({ value }: { value: Cell }) {
  if (value === true) {
    return (
      <>
        <CheckIcon className="text-success-text inline size-4" />
        <span className="sr-only">Included</span>
      </>
    );
  }
  if (value === false) {
    return (
      <>
        <MinusIcon className="text-fg-subtle inline size-4" />
        <span className="sr-only">Not included</span>
      </>
    );
  }
  // Compared against the constants rather than the words, so a reworded chip
  // cannot lose its treatment.
  if (value === NOT_YET || value === ADDON_NOT_YET) {
    return (
      <span className="border-line text-fg-subtle inline-block rounded-full border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap">
        {value}
      </span>
    );
  }
  return <span className="text-fg-muted text-sm leading-5">{value}</span>;
}

/* ── Questions before buying ───────────────────────────────────────────────── */

/**
 * The pricing page's questions about the money — all of them, from the module
 * both pages render — in the order somebody about to buy asks them
 * (`PURCHASE_FAQ`). Shown only where the installation sells: the answers quote
 * prices and describe a checkout.
 *
 * `<details>`, as on the pricing page: it opens without script, says whether it
 * is open to a screen reader by itself, and the browser's find-in-page opens a
 * closed one to show a match. None is grouped by `name`, so opening a second
 * answer never closes the one being read.
 */
function PurchaseQuestions() {
  return (
    <section aria-labelledby="questions-heading" className="flex flex-col gap-3">
      <div>
        <h2 id="questions-heading" className="text-fg text-base font-semibold">
          Questions before you buy
        </h2>
        <p className="text-fg-muted mt-1 text-sm leading-6">
          The {PURCHASE_FAQ.length} the pricing page answers about the money, asked in the order
          they come up when you are about to choose.
        </p>
      </div>
      <div className="border-line bg-surface shadow-raised divide-line-subtle divide-y overflow-hidden rounded-xl border">
        {PURCHASE_FAQ.map((item) => (
          <details key={item.id} className="group">
            {/* The ring is drawn inside: the list clips to its rounded border. */}
            <summary className="text-fg hover:bg-surface-hover flex cursor-pointer list-none items-start gap-3 px-5 py-3.5 text-sm leading-6 font-medium transition-colors focus-visible:-outline-offset-2 [&::-webkit-details-marker]:hidden">
              <span className="flex-1">{item.question}</span>
              <ChevronDownIcon className="text-fg-subtle mt-1 size-4 shrink-0 transition-transform group-open:rotate-180" />
            </summary>
            <p className="text-fg-muted px-5 pb-4 text-sm leading-6 sm:pr-12">{item.answer}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

/* ── What stays true on every plan ─────────────────────────────────────────── */

/**
 * The three things a buyer is most afraid of, answered from what the product
 * already does — and precisely: machines never take a seat, but the fetches
 * they make do count toward the allowance, and past it a paid plan is billed.
 * Reassurance that left the charge out would be the one sentence on the page
 * an invoice could contradict.
 */
function promises(
  overageRate: string,
): readonly { icon: ReactNode; title: string; body: string }[] {
  return [
    {
      icon: <TerminalIcon className="size-4" />,
      title: 'Machines never take a seat',
      body: 'Service tokens, CI runners and agents are not members, and a paid plan is priced per member. The secret fetches they make count toward the monthly allowance.',
    },
    {
      icon: <ShieldCheckIcon className="size-4" />,
      title: 'Builds never stop for billing',
      body: `A fetch past the allowance is never refused — on a paid plan it is billed at ${overageRate} — and a declined card never stops a build.`,
    },
    {
      icon: <HistoryIcon className="size-4" />,
      title: 'Nothing is deleted if you leave',
      body: 'Cancel from the customer portal and the plan runs to the end of the period you paid for, then moves to Free.',
    },
  ];
}

function Promises({ overageRate }: { overageRate: string }) {
  return (
    <section aria-labelledby="promises-heading" className="flex flex-col gap-3">
      <h2 id="promises-heading" className="text-fg text-base font-semibold">
        What stays true on every plan
      </h2>
      <ul className="grid gap-4 sm:grid-cols-3">
        {promises(overageRate).map((promise) => (
          <li
            key={promise.title}
            className="border-line bg-surface shadow-raised rounded-xl border p-5"
          >
            <span
              aria-hidden="true"
              className="bg-accent-tint text-accent-text grid size-8 place-items-center rounded-lg"
            >
              {promise.icon}
            </span>
            <p className="text-fg mt-3 text-sm font-semibold">{promise.title}</p>
            <p className="text-fg-muted mt-1 text-sm leading-6">{promise.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

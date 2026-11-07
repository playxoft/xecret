'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { api, errorMessage, isApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { PageHeader } from '@/components/layout';
import {
  Alert,
  ArrowRightIcon,
  Badge,
  Button,
  CheckIcon,
  HistoryIcon,
  MinusIcon,
  ShieldCheckIcon,
  Skeleton,
  TerminalIcon,
} from '@/components/ui';
import type { BillingStatusPayload } from '@/server/schemas/billing';
import { apiPath, appPath, withQuery } from '../_lib/paths';
import { useApiResource } from '../_lib/use-api-resource';
import { ErrorState } from './resource-states';
import { Segmented } from './segmented';
import { canAdminister, useOrganization } from './session';
import {
  CAPABILITY_ROWS,
  ENTERPRISE_CAVEAT,
  FREE_PRICE,
  nextCeiling,
  PLAN_OFFERS,
  USD_PRICES,
  YEARLY_SAVING_UP_TO,
  yearlySaving,
} from './upgrade-plans';
import type { BillingPeriod, OfferPlanId, PaidPlanId, PlanOffer } from './upgrade-plans';

/**
 * The plans, inside the app — where "Upgrade plan" in the account menu and
 * every "Compare plans" beside a locked control lead.
 *
 * ── Who sees what ──
 * Every member sees the whole page: the three self-serve plans, what each one
 * unlocks, and what stays true on all of them. Somebody who has just met a
 * locked switch deserves the answer to "what would it take?" whether or not
 * they hold the card.
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
 * ── What it never does ──
 * Change a subscription. A checkout is started here, with the billing screen's
 * own request and its one-key-per-decision idempotency; anything that moves an
 * existing subscription — the proration preview, the confirm — stays on the
 * billing screen, and this page links there rather than repeating it. Coming
 * back from checkout lands on the billing screen too, which is where the wait
 * for the payment is watched; a `?checkout=returned` that reaches this page is
 * pointed there rather than polled twice.
 */

type Billing = BillingStatusPayload;

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
  | { kind: 'change' };

export function UpgradeScreen({
  orgSlug,
  returnedFromCheckout,
}: {
  orgSlug: string;
  returnedFromCheckout: boolean;
}) {
  const membership = useOrganization(orgSlug);
  const mayManage = canAdminister(membership, 'billing.manage');
  const resource = useApiResource<{ billing: Billing }>(
    mayManage ? apiPath.billing(orgSlug) : null,
  );
  const orgName = membership?.name ?? orgSlug;

  // A checkout refused as `forbidden` means the same as a refused read: the
  // session's idea of this viewer's role is out of date.
  const [refused, setRefused] = useState(false);
  const notOwner = !mayManage || refused || isNotOwner(resource.error);

  const billing = notOwner ? null : (resource.data?.billing ?? null);
  const loading = !notOwner && resource.loading && billing === null;
  const loadFailed = !notOwner && !loading && resource.error !== null;

  // Yearly first, as the pricing page opens: it is the rate most teams pick,
  // and the toggle says what monthly costs one click away.
  const [period, setPeriod] = useState<BillingPeriod>('yearly');

  // ── The checkout ──
  // One idempotency key per decision — the plan and the period — kept for a
  // retry of the same choice, so a double click or a retry after an answer that
  // never arrived is one checkout at Dodo, and replaced when the choice
  // changes. The billing screen's rule, for the same request.
  const decision = useRef<{ plan: PaidPlanId; period: BillingPeriod; key: string } | null>(null);
  const [busy, setBusy] = useState<PaidPlanId | null>(null);
  const [failure, setFailure] = useState<{ plan: PaidPlanId; error: unknown } | null>(null);

  async function checkout(plan: PaidPlanId) {
    const previous = decision.current;
    const key =
      previous !== null && previous.plan === plan && previous.period === period
        ? previous.key
        : crypto.randomUUID();
    decision.current = { plan, period, key };

    setBusy(plan);
    setFailure(null);
    try {
      const { url } = await api.post<{ url: string }>(
        apiPath.billingCheckout(orgSlug),
        { plan, interval: period },
        { idempotencyKey: key },
      );
      // Left busy: the page is about to be replaced by Dodo's checkout.
      window.location.assign(url);
    } catch (cause) {
      if (isNotOwner(cause)) setRefused(true);
      else setFailure({ plan, error: cause });
      setBusy(null);
    }
  }

  function offerFor(id: OfferPlanId): Offer {
    if (notOwner || loadFailed) return { kind: 'none' };
    if (loading || billing === null) return { kind: 'loading' };
    if (billing.plan === id) return { kind: 'current' };
    // Down to Free is cancelling, which is the customer portal's — reached
    // from the billing screen, and not something this page sells.
    if (id === 'free') return { kind: 'none' };
    if (!billing.enabled || billing.managedBy === 'support') return { kind: 'none' };
    if (billing.actions.checkout) return { kind: 'checkout', plan: id };
    if (billing.actions.changePlan) return { kind: 'change' };
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
              onClick={() => void checkout(offered.plan)}
            >
              Upgrade to {offer.name}
              <ArrowRightIcon className="size-4" />
            </Button>
            {failure?.plan === offered.plan ? (
              <div role="alert" className="text-danger-text text-sm leading-5">
                <p>Nothing was changed. {errorMessage(failure.error)}</p>
                {isApiError(failure.error) && failure.error.requestId ? (
                  <p className="text-fg-subtle mt-1">
                    Request id:{' '}
                    <code className="font-mono select-all">{failure.error.requestId}</code>
                  </p>
                ) : null}
              </div>
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
              <Link href={appPath.orgBilling(orgSlug)}>
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
  const statusLabel =
    billing !== null && billing.plan !== 'free' ? (STATUS_LABEL[billing.status] ?? null) : null;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
      <PageHeader
        title={`Upgrade ${orgName}`}
        description="Every paid plan is per member, with a lower yearly rate. Service tokens and CI never cost anything, and a build never fails for a billing reason."
        badge={
          billing !== null ? (
            <Badge tone="neutral">
              On {PLAN_NAME[billing.plan]}
              {statusLabel !== null ? ` · ${statusLabel}` : ''}
            </Badge>
          ) : null
        }
        actions={
          notOwner ? null : (
            <Button variant="ghost" asChild>
              <Link href={appPath.orgBilling(orgSlug)}>Billing</Link>
            </Button>
          )
        }
      />

      <Notices
        orgSlug={orgSlug}
        orgName={orgName}
        notOwner={notOwner}
        returnedFromCheckout={returnedFromCheckout}
        billing={billing}
        loadFailed={loadFailed ? resource.error : null}
        onRetry={() => void resource.reload()}
      />

      <section aria-labelledby="plans-heading" className="flex flex-col gap-5">
        <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-between">
          <h2 id="plans-heading" className="text-fg text-base font-semibold">
            {notOwner ? 'Compare plans' : 'Choose a plan'}
          </h2>
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
              // A failure belongs to the choice that failed; a new period is a
              // new choice, with a new key when it is sent.
              setFailure(null);
            }}
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          {PLAN_OFFERS.map((offer) => (
            <PlanCard
              key={offer.id}
              offer={offer}
              period={period}
              current={currentPlan === offer.id}
              foot={footFor(offer)}
            />
          ))}
        </div>

        <EnterpriseRow current={currentPlan === 'enterprise'} />

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
      </section>

      <CapabilityTable current={currentPlan} />

      <Promises />
    </div>
  );
}

/* ── The notices above the plans ───────────────────────────────────────────── */

function Notices({
  orgSlug,
  orgName,
  notOwner,
  returnedFromCheckout,
  billing,
  loadFailed,
  onRetry,
}: {
  orgSlug: string;
  orgName: string;
  notOwner: boolean;
  returnedFromCheckout: boolean;
  billing: Billing | null;
  /** The failure, when the plan could not be read for any reason but "not an owner". */
  loadFailed: unknown;
  onRetry: () => void;
}) {
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
      notices.push(
        <Alert key="disabled" tone="info" title="This installation does not take payments">
          <p>Plans here are set by whoever runs it.</p>
        </Alert>,
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
              const next =
                warning.limit === null ? null : nextCeiling(billing.plan, warning.resource);
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
  current,
  foot,
}: {
  offer: PlanOffer;
  period: BillingPeriod;
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
        ) : offer.recommended ? (
          <Badge tone="accent" className="text-xs">
            Recommended
          </Badge>
        ) : null}
      </div>

      <Price plan={offer.id} period={period} />
      {offer.caveat !== null ? (
        <p className="text-fg-subtle mt-2 text-xs leading-5">{offer.caveat}</p>
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
 * Its sentence names only what the pricing page publishes as available today —
 * the ceilings, the retention, the licence and the SLA — and leaves out the
 * capabilities that card marks "Coming soon".
 */
function EnterpriseRow({ current }: { current: boolean }) {
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
          <span className="text-fg-subtle text-sm">Custom, invoiced with an SLA</span>
          {current ? (
            <Badge tone="success" className="text-xs">
              Current plan
            </Badge>
          ) : null}
        </div>
        <p className="text-fg-muted mt-1.5 text-sm leading-6">
          No ceiling on projects, environments, secrets or tokens, custom audit retention, a
          commercial self-hosting licence, and a contractual SLA with a named contact.
          {ENTERPRISE_CAVEAT !== null ? ` ${ENTERPRISE_CAVEAT}.` : ''}
        </p>
      </div>
      <Button variant="secondary" asChild className="shrink-0">
        <Link href="/contact">
          Talk to us
          <ArrowRightIcon className="size-4" />
        </Link>
      </Button>
    </article>
  );
}

/* ── What each plan unlocks ────────────────────────────────────────────────── */

const COLUMNS: readonly { id: OfferPlanId; name: string }[] = PLAN_OFFERS.map((offer) => ({
  id: offer.id,
  name: offer.name,
}));

function CapabilityTable({ current }: { current: Billing['plan'] | null }) {
  return (
    <section aria-labelledby="unlocks-heading" className="flex flex-col gap-3">
      <div>
        <h2 id="unlocks-heading" className="text-fg text-base font-semibold">
          What each plan unlocks
        </h2>
        <p className="text-fg-muted mt-1 text-sm">
          Every plan, Free included, has zero-knowledge encryption, version history and rollback,
          the CLI with <code className="font-mono">xecret run</code>, and the HTTP API.
        </p>
      </div>

      <div className="border-line bg-surface shadow-raised overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="bg-canvas-inset border-line-subtle border-b">
            <tr>
              <th scope="col" className="text-fg-subtle h-9 px-4 text-left font-medium">
                <span className="sr-only">Capability</span>
              </th>
              {COLUMNS.map((column) => (
                <th
                  key={column.id}
                  scope="col"
                  className="text-fg-subtle h-9 w-20 px-3 text-center font-medium whitespace-nowrap sm:w-28"
                >
                  {column.name}
                  {current === column.id ? (
                    <span className="text-success-text block text-xs font-normal">Current</span>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-line-subtle divide-y">
            {CAPABILITY_ROWS.map((row) => (
              <tr key={row.label}>
                <th scope="row" className="px-4 py-3 text-left font-normal">
                  <span className="text-fg block font-medium">{row.label}</span>
                  <span className="text-fg-subtle mt-0.5 block text-sm leading-5">{row.hint}</span>
                </th>
                {COLUMNS.map((column) => (
                  <td key={column.id} className="px-3 py-3 text-center align-middle">
                    {row.on[column.id] ? (
                      <>
                        <CheckIcon className="text-success-text inline size-4" />
                        <span className="sr-only">Included</span>
                      </>
                    ) : (
                      <>
                        <MinusIcon className="text-fg-subtle inline size-4" />
                        <span className="sr-only">Not included</span>
                      </>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ── What stays true on every plan ─────────────────────────────────────────── */

/**
 * The three things a buyer is most afraid of, answered from what the product
 * already does — each sentence is one the billing screen or the pricing page
 * already states.
 */
const PROMISES: readonly { icon: ReactNode; title: string; body: string }[] = [
  {
    icon: <TerminalIcon className="size-4" />,
    title: 'Machines are free',
    body: 'Service tokens, CI runners and agents never add to the bill. A paid plan counts members, and only members.',
  },
  {
    icon: <ShieldCheckIcon className="size-4" />,
    title: 'Builds never stop for billing',
    body: 'A secret fetch is never refused over the allowance, and a declined card never stops a build.',
  },
  {
    icon: <HistoryIcon className="size-4" />,
    title: 'Nothing is deleted if you leave',
    body: 'Cancel from the customer portal and the plan runs to the end of the period you paid for, then moves to Free.',
  },
];

function Promises() {
  return (
    <section aria-labelledby="promises-heading" className="flex flex-col gap-3">
      <h2 id="promises-heading" className="text-fg text-base font-semibold">
        What stays true on every plan
      </h2>
      <ul className="grid gap-4 sm:grid-cols-3">
        {PROMISES.map((promise) => (
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

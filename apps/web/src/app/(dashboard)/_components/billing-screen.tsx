'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

import { api, errorMessage, isApiError } from '@/lib/api';
import { formatAbsoluteTime } from '@/lib/format';
import { PageHeader } from '@/components/layout';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  useToast,
} from '@/components/ui';
import type { BillingStatusPayload } from '@/server/schemas/billing';
import { apiPath, appPath, withQuery } from '../_lib/paths';
import { useApiResource } from '../_lib/use-api-resource';
import { ErrorState, FormSkeleton } from './resource-states';
import { canAdminister, useOrganization } from './session';

/**
 * The billing screen (P12): the plan, the seats, the renewal, this period's
 * fetches, and the three things an owner does here — subscribe, change plan,
 * and open Dodo's customer portal for the card and the invoices.
 *
 * ── What this screen never does ──
 * Hold a card, show an invoice, or decide a price. Checkout and the portal are
 * Dodo's pages; this one only sends the browser there. The price is whatever
 * the Dodo product says in the buyer's currency — the pricing page publishes
 * every one — and a plan change shows Dodo's own proration before it is
 * confirmed. And it grants nothing: coming back from checkout says "waiting for
 * the payment to be confirmed" until the signed webhook has changed the plan.
 *
 * Owners only. The server refuses everybody else (`billing.manage`); the
 * screen says so rather than drawing controls that would be refused.
 */

type Billing = BillingStatusPayload;
type Plan = 'pro' | 'team';
type Interval = 'monthly' | 'yearly';

const PLAN_NAME: Record<Billing['plan'], string> = {
  free: 'Free',
  pro: 'Pro',
  team: 'Team',
  enterprise: 'Enterprise',
};

const STATUS: Record<
  Billing['status'],
  { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }
> = {
  active: { label: 'Active', tone: 'success' },
  trialing: { label: 'Trial', tone: 'success' },
  past_due: { label: 'Payment overdue', tone: 'warning' },
  on_hold: { label: 'Payment failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  expired: { label: 'Ended', tone: 'neutral' },
};

const RESOURCE_NAME: Record<Billing['warnings'][number]['resource'], string> = {
  seats: 'seats',
  projects: 'projects',
  serviceTokens: 'service tokens',
};

const count = (value: number) => value.toLocaleString('en-GB');

/** How long, after coming back from checkout, the screen keeps asking whether the plan changed. */
const CONFIRMATION_POLL_MS = 3_000;
const CONFIRMATION_POLLS = 20;

export function BillingScreen({
  orgSlug,
  returnedFromCheckout,
}: {
  orgSlug: string;
  returnedFromCheckout: boolean;
}) {
  const membership = useOrganization(orgSlug);
  const isOwner = canAdminister(membership, 'billing.manage');
  const resource = useApiResource<{ billing: Billing }>(isOwner ? apiPath.billing(orgSlug) : null);
  const billing = resource.data?.billing ?? null;

  // Back from checkout and still on Free: the webhook has not landed yet. Ask
  // again for a minute, then leave the sentence that says it is on its way.
  const [polls, setPolls] = useState(0);
  const waitingForPayment = returnedFromCheckout && billing !== null && billing.plan === 'free';
  const { reload } = resource;
  useEffect(() => {
    if (!waitingForPayment || polls >= CONFIRMATION_POLLS) return;
    const timer = setTimeout(() => {
      setPolls((value) => value + 1);
      void reload();
    }, CONFIRMATION_POLL_MS);
    return () => clearTimeout(timer);
  }, [waitingForPayment, polls, reload]);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <PageHeader
        title="Billing"
        description="The plan, the seats it is billed for, and the card that pays for it."
        actions={
          <Button variant="ghost" asChild>
            <Link href={appPath.orgSettings(orgSlug)}>Organisation settings</Link>
          </Button>
        }
      />

      {!isOwner ? (
        <Alert tone="info" title="Only an owner manages billing">
          <p>Ask an owner of this organisation to change its plan or its payment details.</p>
        </Alert>
      ) : resource.loading && billing === null ? (
        <FormSkeleton />
      ) : resource.error !== null ? (
        <ErrorState subject="billing" error={resource.error} onRetry={resource.reload} />
      ) : billing ? (
        <BillingDetails
          orgSlug={orgSlug}
          billing={billing}
          waitingForPayment={waitingForPayment}
          onChanged={() => void resource.reload()}
        />
      ) : null}
    </div>
  );
}

function BillingDetails({
  orgSlug,
  billing,
  waitingForPayment,
  onChanged,
}: {
  orgSlug: string;
  billing: Billing;
  waitingForPayment: boolean;
  onChanged: () => void;
}) {
  const failing = billing.status === 'past_due' || billing.status === 'on_hold';

  return (
    <div className="flex flex-col gap-6">
      {failing ? (
        <Alert tone="danger" title="Your builds are unaffected.">
          <p>
            Your card was declined. Every secret, every <code>xecret run</code> and every CI job
            keeps working; update the card from the customer portal to keep the plan. A subscription
            still unpaid after 14 days on hold ends, and the organisation moves to Free — nothing is
            deleted.
          </p>
          {billing.actions.portal ? (
            <div className="mt-3">
              <PortalButton orgSlug={orgSlug} label="Update the card" />
            </div>
          ) : null}
        </Alert>
      ) : null}

      {waitingForPayment ? (
        <Alert tone="info" title="Waiting for the payment to be confirmed">
          <p>
            Your plan changes as soon as our payment provider confirms the payment — usually within
            a minute. Nothing more to do here; this page updates on its own.
          </p>
        </Alert>
      ) : null}

      {billing.enabled && billing.mode === 'test_mode' ? (
        <Alert tone="warning" title="Test mode">
          <p>This installation’s payments are in test mode: no real card is charged.</p>
        </Alert>
      ) : null}

      {!billing.enabled ? (
        <Alert tone="info" title="This installation does not take payments">
          <p>Plans here are set by whoever runs it. Everything else on this page still applies.</p>
        </Alert>
      ) : null}

      <CurrentPlan billing={billing} />
      <Usage billing={billing} />

      {billing.warnings.length > 0 ? (
        <Alert tone="warning" title="Close to a limit">
          <ul className="list-disc pl-5">
            {billing.warnings.map((warning) => (
              <li key={warning.resource}>
                {count(warning.current)} {RESOURCE_NAME[warning.resource]}
                {warning.limit === null
                  ? ' — past the fair-use level we check in about. Nothing is blocked.'
                  : warning.atLimit
                    ? ` — at the limit of ${count(warning.limit)}.`
                    : ` of ${count(warning.limit)}.`}
              </li>
            ))}
          </ul>
          <p className="mt-2">
            A secret fetch is never refused over a limit. <Link href="/pricing">Compare plans</Link>
            .
          </p>
        </Alert>
      ) : null}

      {billing.managedBy === 'support' ? (
        <Alert tone="info" title="Managed by xecret support">
          <p>
            This organisation’s plan was arranged with us directly, so it is changed by us too.{' '}
            <Link href="/contact">Contact us</Link> to change it.
          </p>
        </Alert>
      ) : billing.actions.checkout || billing.actions.changePlan ? (
        <ChoosePlan orgSlug={orgSlug} billing={billing} onChanged={onChanged} />
      ) : null}

      {billing.actions.portal ? (
        <Card>
          <CardHeader>
            <CardTitle>Payment details and invoices</CardTitle>
            <CardDescription>
              The card, the billing address, every invoice, and cancelling are in the customer
              portal of our payment provider, Dodo Payments. We never see the card.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PortalButton orgSlug={orgSlug} label="Manage billing" />
          </CardContent>
        </Card>
      ) : null}

      <AddOns billing={billing} />
    </div>
  );
}

function CurrentPlan({ billing }: { billing: Billing }) {
  const status = STATUS[billing.status];
  const rows: [string, React.ReactNode][] = [
    [
      'Plan',
      <span key="plan" className="inline-flex items-center gap-2">
        {PLAN_NAME[billing.plan]}
        {billing.interval ? (
          <span className="text-fg-muted">· billed {billing.interval}</span>
        ) : null}
        {billing.plan !== 'free' ? <Badge tone={status.tone}>{status.label}</Badge> : null}
      </span>,
    ],
    [
      'Seats',
      <span key="seats">
        {count(billing.seats.seated)} in use
        {billing.plan !== 'free' ? ` · ${count(billing.seats.billed)} billed` : ''}
        {billing.seats.pendingInvitations > 0
          ? ` · ${count(billing.seats.pendingInvitations)} invited, billed once they join`
          : ''}
      </span>,
    ],
  ];
  if (billing.plan !== 'free' && billing.seats.minimum > 1) {
    rows.push(['Billing floor', `${count(billing.seats.minimum)} seats`]);
  }
  if (billing.trialEndsAt && billing.status === 'trialing') {
    rows.push(['Trial ends', formatAbsoluteTime(billing.trialEndsAt)]);
  }
  if (billing.renewsAt) {
    rows.push([
      billing.cancelAtPeriodEnd ? 'Ends' : 'Renews',
      `${formatAbsoluteTime(billing.renewsAt)}${
        !billing.cancelAtPeriodEnd && billing.renewalAmount
          ? ` · ${billing.renewalAmount} before tax`
          : ''
      }`,
    ]);
  }
  if (billing.currency) rows.push(['Currency', billing.currency]);
  if (billing.regionLock) {
    rows.push([
      'Region',
      `Priced for ${billing.regionLock.country ?? 'your billing country'} until ${formatAbsoluteTime(
        billing.regionLock.until,
      )}`,
    ]);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Current plan</CardTitle>
        {billing.cancelAtPeriodEnd ? (
          <CardDescription>
            Cancelled — the plan stays until the end of the period already paid for, then the
            organisation moves to Free. Nothing is deleted.
          </CardDescription>
        ) : null}
      </CardHeader>
      <CardContent>
        <dl className="text-sm">
          {rows.map(([label, value], index) => (
            <div
              key={label}
              className={`flex justify-between gap-4 py-2 ${
                index < rows.length - 1 ? 'border-line-subtle border-b' : ''
              }`}
            >
              <dt className="text-fg-muted">{label}</dt>
              <dd className="text-fg text-right">{value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function Usage({ billing }: { billing: Billing }) {
  const { secretFetches, includedFetches } = billing.usage;
  const share = includedFetches > 0 ? Math.min(secretFetches / includedFetches, 1) : 0;
  const over = Math.max(0, secretFetches - includedFetches);
  const tone = share >= 0.8 ? 'bg-warning' : 'bg-accent';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Secret fetches this period</CardTitle>
        <CardDescription>
          Since {formatAbsoluteTime(billing.usage.periodStart)}. Reads across everything — the CLI,
          CI and the API. Counted within a minute or so.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div
          className="bg-canvas-inset h-2 w-full overflow-hidden rounded-full"
          role="progressbar"
          aria-label="Secret fetches used of the included allowance"
          aria-valuemin={0}
          aria-valuemax={includedFetches}
          aria-valuenow={Math.min(secretFetches, includedFetches)}
        >
          <div className={`h-full ${tone}`} style={{ width: `${Math.round(share * 100)}%` }} />
        </div>
        <p className="text-sm">
          {count(secretFetches)} of {count(includedFetches)} included
          {over > 0 ? ` · ${count(over)} past the allowance` : ''}
        </p>
        <p className="text-fg-subtle text-sm">
          Nothing stops at the allowance: fetches past it keep working
          {billing.plan === 'free'
            ? '. On Free they are not billed; a paid plan includes far more.'
            : ` and are billed at ${billing.usage.overageRate}, on the next invoice.`}
        </p>
      </CardContent>
    </Card>
  );
}

function PortalButton({ orgSlug, label }: { orgSlug: string; label: string }) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function open() {
    setOpening(true);
    setError(null);
    try {
      const { link } = await api.post<{ link: string }>(apiPath.billingPortal(orgSlug));
      window.location.assign(link);
    } catch (cause) {
      setError(cause);
      setOpening(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button variant="secondary" loading={opening} onClick={() => void open()}>
          {label}
        </Button>
      </div>
      {error !== null ? <p className="text-danger-text text-sm">{errorMessage(error)}</p> : null}
    </div>
  );
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="border-line bg-canvas-inset inline-flex rounded-full border p-1"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
          className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
            option.value === value ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ChoosePlan({
  orgSlug,
  billing,
  onChanged,
}: {
  orgSlug: string;
  billing: Billing;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const subscribed = billing.actions.changePlan;
  // Opens on the next rung up for a subscriber, and on Team, yearly — the
  // pricing page's own default — for everybody else.
  const [plan, setPlan] = useState<Plan>(billing.plan === 'team' ? 'pro' : 'team');
  const [interval, setBillingInterval] = useState<Interval>(billing.interval ?? 'yearly');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [preview, setPreview] = useState<{
    effective: 'now' | 'renewal';
    seats: number;
    charge: string | null;
  } | null>(null);

  const same = billing.plan === plan && billing.interval === interval;
  // One key per decision: kept for a retry of the same choice — so a double
  // click, or a retry after an answer that never arrived, is one checkout or
  // one change at Dodo — and replaced when the choice changes or succeeds.
  const [decisionKey, setDecisionKey] = useState(() => crypto.randomUUID());
  const choose =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setPreview(null);
      setDecisionKey(crypto.randomUUID());
    };

  async function subscribe() {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api.post<{ url: string }>(
        apiPath.billingCheckout(orgSlug),
        { plan, interval },
        { idempotencyKey: decisionKey },
      );
      window.location.assign(url);
    } catch (cause) {
      setError(cause);
      setBusy(false);
    }
  }

  async function previewChange() {
    setBusy(true);
    setError(null);
    try {
      const answer = await api.get<{ preview: NonNullable<typeof preview> }>(
        withQuery(apiPath.billingChange(orgSlug), { plan, interval }),
      );
      setPreview(answer.preview);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  async function confirmChange() {
    setBusy(true);
    setError(null);
    try {
      const answer = await api.post<{ effective: 'now' | 'renewal' }>(
        apiPath.billingChange(orgSlug),
        { plan, interval },
        { idempotencyKey: decisionKey },
      );
      toast({
        variant: 'success',
        title:
          answer.effective === 'now'
            ? 'Plan change requested — it shows here once the payment is confirmed'
            : 'Plan change scheduled for the end of this billing period',
      });
      setPreview(null);
      setDecisionKey(crypto.randomUUID());
      onChanged();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{subscribed ? 'Change plan' : 'Choose a plan'}</CardTitle>
        <CardDescription>
          Per member, with a lower yearly rate. Service tokens and CI never cost anything. Prices in
          every currency are on the <Link href="/pricing">pricing page</Link>; checkout shows yours
          before you pay. Enterprise is <Link href="/contact">arranged with us</Link>.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-3">
          <Segmented
            label="Plan"
            options={[
              { value: 'pro', label: 'Pro' },
              { value: 'team', label: 'Team' },
            ]}
            value={plan}
            onChange={choose(setPlan)}
          />
          <Segmented
            label="Billing period"
            options={[
              { value: 'monthly', label: 'Monthly' },
              { value: 'yearly', label: 'Yearly' },
            ]}
            value={interval}
            onChange={choose(setBillingInterval)}
          />
        </div>

        {plan === 'team' ? (
          <p className="text-fg-subtle text-sm">
            Team adds roles and per-environment access, and is billed from 3 members up.
          </p>
        ) : (
          <p className="text-fg-subtle text-sm">
            On Pro every member can read every environment, production included.
          </p>
        )}

        {preview ? (
          <Alert tone="info" title="Before you confirm">
            <p>
              {preview.effective === 'now'
                ? `This takes effect now, for ${count(preview.seats)} seats${
                    preview.charge
                      ? `, and charges ${preview.charge} today: the unused part of this period is credited, and a new period on the new plan starts today`
                      : ''
                  }.`
                : `This takes effect at the end of the period you have already paid for, for ${count(
                    preview.seats,
                  )} seats. Nothing is charged today and nothing is deleted.`}
            </p>
          </Alert>
        ) : null}

        {error !== null ? (
          <Alert tone="danger" title="Nothing was changed">
            <p>{errorMessage(error)}</p>
            {isApiError(error) && error.requestId ? (
              <p className="mt-1.5 text-sm">
                Request id: <code className="font-mono select-all">{error.requestId}</code>
              </p>
            ) : null}
          </Alert>
        ) : null}

        <div>
          {!subscribed ? (
            <Button variant="primary" loading={busy} onClick={() => void subscribe()}>
              Continue to checkout
            </Button>
          ) : preview ? (
            <Button variant="primary" loading={busy} onClick={() => void confirmChange()}>
              Confirm the change
            </Button>
          ) : (
            <Button
              variant="primary"
              loading={busy}
              disabled={same}
              onClick={() => void previewChange()}
            >
              {same ? 'This is your current plan' : 'Review the change'}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function AddOns({ billing }: { billing: Billing }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Add-ons</CardTitle>
        <CardDescription>
          Bought per connection rather than by moving plan, and switched on by us rather than
          instantly: each is a connection we set up with you.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="text-sm">
          <div className="flex items-start justify-between gap-4 py-2">
            <dt>
              <span className="text-fg">SAML single sign-on</span>
              <span className="text-fg-subtle block">
                $199 per connection a month, from Team; included with Enterprise.
              </span>
            </dt>
            <dd>
              {billing.addons.saml ? (
                <Badge tone="success">On</Badge>
              ) : (
                <Button variant="secondary" size="sm" asChild>
                  <Link href="/contact">Request it</Link>
                </Button>
              )}
            </dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

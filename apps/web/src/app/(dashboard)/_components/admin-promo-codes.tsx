'use client';

import { useState } from 'react';

import { api, isApiError } from '@/lib/api';
import { formatAbsoluteTime, pluralize } from '@/lib/format';
import { planName } from '@/components/plans/plan-copy';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  CopyButton,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  KeyIcon,
  Label,
  PlusIcon,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  useToast,
} from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import type { AdminPromoCodePayload, PromoCodeState } from '@/server/schemas/admin';
import { apiPath } from '../_lib/paths';
import { useApiResource } from '../_lib/use-api-resource';
import { ADMIN_TEXT_MAX_LENGTH, normaliseCode, promoCodeRequest } from './admin-forms';
import type { CheckoutPlan, PromoCodeForm, PromoCodeProblems } from './admin-forms';
import { AdminFailure, EndPicker, GRANTABLE_PLANS, useDialogTarget } from './admin-grant-dialogs';
import { ErrorState } from './resource-states';
import { Segmented } from './segmented';

/**
 * The Promo codes tab: the codes issued, and making and revoking them.
 *
 * ── Two kinds ──
 * A **free-plan code** (`grant`) is redeemed by an owner in the app, and the
 * organisation is on the plan at once — for so many days, or for good — with
 * no card and nothing at the payment provider. A **checkout discount**
 * (`discount`) is a Dodo discount code: an owner checks out with it, Dodo
 * collects the card and takes the amount off. A 100% discount is how "free,
 * but with a card on file" is done.
 *
 * ── A discount lives in one Dodo mode ──
 * A discount is created at Dodo, in the mode this deployment is in — test or
 * live — and exists only there. One made in test mode applies to nothing once
 * the deployment is live, and the list says so beside it rather than letting
 * it sit there looking usable. Where payments are not configured at all, only
 * free-plan codes can be made.
 */

type PaymentsHere = { enabled: boolean; mode: 'test_mode' | 'live_mode' | null };

const STATE: Record<PromoCodeState, { label: string; tone: BadgeTone }> = {
  active: { label: 'Active', tone: 'success' },
  expired: { label: 'Expired', tone: 'neutral' },
  revoked: { label: 'Revoked', tone: 'danger' },
  'used-up': { label: 'Used up', tone: 'warning' },
};

const MODE_NAME: Record<'test_mode' | 'live_mode', string> = {
  test_mode: 'Test mode',
  live_mode: 'Live',
};

const count = (value: number) => value.toLocaleString('en-GB');

/**
 * Why a discount applies to nothing here, or `null` when it applies. A code is
 * Dodo's in one mode only, and a deployment talks to one mode at a time.
 */
export function discountMismatch(
  code: AdminPromoCodePayload,
  payments: PaymentsHere,
): string | null {
  if (code.discount === null) return null;
  if (!payments.enabled || payments.mode === null) {
    return 'Payments are not configured here, so it applies to nothing.';
  }
  if (code.discount.mode === payments.mode) return null;
  return code.discount.mode === 'test_mode'
    ? 'Made in Dodo’s test mode; this deployment is live, so it applies to nothing.'
    : 'Made in Dodo’s live mode; this deployment is in test mode, so it applies to nothing here.';
}

export function PromoCodesTab() {
  const resource = useApiResource<{ codes: AdminPromoCodePayload[]; billing: PaymentsHere }>(
    apiPath.adminPromoCodes(),
  );
  const { toast } = useToast();
  const [creating, setCreating] = useState(false);
  const revoking = useDialogTarget<AdminPromoCodePayload>();
  const reload = () => void resource.reload();

  const codes = resource.data?.codes ?? null;
  const payments = resource.data?.billing ?? null;

  async function revoke(code: AdminPromoCodePayload) {
    await api.post<{ code: AdminPromoCodePayload }>(apiPath.adminPromoCodeRevoke(code.id));
    toast({ variant: 'success', title: `${code.code} is revoked` });
    reload();
  }

  return (
    <div className="flex flex-col gap-4">
      {payments !== null ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-fg-muted flex flex-wrap items-center gap-2 text-sm">
            Payments on this deployment:
            {payments.enabled && payments.mode !== null ? (
              <Badge tone={payments.mode === 'live_mode' ? 'success' : 'warning'}>
                {MODE_NAME[payments.mode]}
              </Badge>
            ) : (
              <Badge tone="neutral">Not configured</Badge>
            )}
          </p>
          <Button variant="primary" onClick={() => setCreating(true)}>
            <PlusIcon className="size-4" />
            New code
          </Button>
        </div>
      ) : null}

      {resource.error !== null ? (
        <ErrorState subject="the promo codes" error={resource.error} onRetry={reload} />
      ) : codes === null || payments === null ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : codes.length === 0 ? (
        <EmptyState
          icon={<KeyIcon />}
          title="No promo codes yet"
          description="A free-plan code puts an organisation on a plan the moment an owner redeems it. A checkout discount comes off at Dodo’s checkout."
          action={
            <Button variant="primary" onClick={() => setCreating(true)}>
              New code
            </Button>
          }
        />
      ) : (
        <TableContainer aria-label="Promo codes">
          <Table className="min-w-[48rem]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-52">Code</TableHead>
                <TableHead>What it gives</TableHead>
                <TableHead className="w-52">Who, and until when</TableHead>
                <TableHead className="w-32">Used</TableHead>
                <TableHead className="w-24">State</TableHead>
                <TableHead className="w-24">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {codes.map((code) => (
                <CodeRow
                  key={code.id}
                  code={code}
                  payments={payments}
                  onRevoke={() => revoking.show(code)}
                />
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {payments !== null ? (
        <CreatePromoCodeDialog
          open={creating}
          onOpenChange={setCreating}
          payments={payments}
          onCreated={reload}
        />
      ) : null}

      <ConfirmDialog
        open={revoking.open}
        onOpenChange={revoking.onOpenChange}
        title={revoking.target === null ? 'Revoke the code?' : `Revoke ${revoking.target.code}?`}
        description={
          revoking.target?.kind === 'discount'
            ? 'No checkout can use it from now on. A subscription already bought with it keeps whatever Dodo took off.'
            : 'Nobody can redeem it from now on. Organisations that already did keep their free plan until it ends — end one from the Grants tab.'
        }
        confirmLabel="Revoke"
        onConfirm={async () => {
          if (revoking.target !== null) await revoke(revoking.target);
        }}
      />
    </div>
  );
}

function CodeRow({
  code,
  payments,
  onRevoke,
}: {
  code: AdminPromoCodePayload;
  payments: PaymentsHere;
  onRevoke: () => void;
}) {
  const state = STATE[code.state];
  const mismatch = discountMismatch(code, payments);
  const emails = code.allowedEmails;

  return (
    <TableRow>
      <TableCell className="align-top">
        <div className="flex items-center gap-1">
          <code className="text-fg font-mono text-sm font-semibold">{code.code}</code>
          <CopyButton value={code.code} label={`the code ${code.code}`} />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <span className="text-fg-subtle text-sm">
            {code.kind === 'grant' ? 'Free plan' : 'Checkout discount'}
          </span>
          {code.discount !== null ? (
            <Badge
              tone={mismatch !== null ? 'warning' : 'neutral'}
              className="text-xs"
              title={mismatch ?? undefined}
            >
              {MODE_NAME[code.discount.mode]}
            </Badge>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="align-top text-sm">
        <p className="text-fg">{code.summary}</p>
        {code.description ? <p className="text-fg-muted mt-0.5">{code.description}</p> : null}
        {mismatch !== null && code.state === 'active' ? (
          <p className="text-warning-text mt-1">{mismatch}</p>
        ) : null}
      </TableCell>
      <TableCell className="text-fg-muted align-top text-sm">
        <p title={emails === null ? undefined : emails.join('\n')}>
          {emails === null
            ? 'Anybody with the code'
            : emails.length === 1
              ? `Only ${emails[0]}`
              : `Only ${emails[0]} and ${pluralize(emails.length - 1, 'other')}`}
        </p>
        <p className="mt-0.5">
          {code.expiresAt === null ? 'No expiry' : `Until ${formatAbsoluteTime(code.expiresAt)}`}
        </p>
      </TableCell>
      <TableCell className="text-fg-muted align-top text-sm">
        {code.kind === 'grant' ? (
          code.maxRedemptions === null ? (
            `${count(code.redemptions)} redeemed`
          ) : (
            `${count(code.redemptions)} of ${count(code.maxRedemptions)}`
          )
        ) : (
          // Dodo counts a discount's uses; what this side knows is how many
          // checkouts set out with it, paid or not.
          <span title="Dodo counts the uses; this is the checkouts started with it.">
            {pluralize(code.checkoutsStarted, 'checkout')} started
            {code.maxRedemptions !== null ? ` · at most ${count(code.maxRedemptions)} uses` : ''}
          </span>
        )}
      </TableCell>
      <TableCell className="align-top">
        <Badge tone={state.tone}>{state.label}</Badge>
      </TableCell>
      <TableCell className="align-top">
        {code.state === 'active' ? (
          <Button
            variant="danger-outline"
            size="sm"
            aria-label={`Revoke ${code.code}`}
            onClick={onRevoke}
          >
            Revoke
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

/* ── A new code ────────────────────────────────────────────────────────────── */

export function CreatePromoCodeDialog({
  open,
  onOpenChange,
  payments,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  payments: PaymentsHere;
  onCreated: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent className="max-w-xl">
        {/* Inside the content, which unmounts on close: every new code starts
            from an empty form rather than the last one's leftovers. */}
        <CreatePromoCodeFlow
          payments={payments}
          onBusyChange={setBusy}
          onClose={() => onOpenChange(false)}
          onCreated={onCreated}
        />
      </DialogContent>
    </Dialog>
  );
}

const EMPTY_FORM: PromoCodeForm = {
  kind: 'grant',
  code: '',
  description: '',
  allowedEmails: '',
  maxRedemptions: '',
  expires: { kind: 'never', date: '' },
  plan: 'pro',
  lasts: 'days',
  days: '30',
  seats: '',
  discountType: 'percentage',
  value: '',
  currency: 'USD',
  cycles: 'count',
  cycleCount: '3',
  plans: ['pro', 'team'],
};

function CreatePromoCodeFlow({
  payments,
  onBusyChange,
  onClose,
  onCreated,
}: {
  payments: PaymentsHere;
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
  onCreated: () => void;
}) {
  const discountsHere = payments.enabled && payments.mode !== null;
  const [form, setForm] = useState<PromoCodeForm>(EMPTY_FORM);
  const [problems, setProblems] = useState<PromoCodeProblems>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<AdminPromoCodePayload | null>(null);

  function update(patch: Partial<PromoCodeForm>) {
    setForm((current) => ({ ...current, ...patch }));
    setProblems({});
  }

  function togglePlan(plan: CheckoutPlan, on: boolean) {
    update({
      plans: on ? [...new Set([...form.plans, plan])] : form.plans.filter((p) => p !== plan),
    });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    // A discount cannot be made where there is no Dodo to make it in, whatever
    // the form was left on.
    const request = promoCodeRequest(discountsHere ? form : { ...form, kind: 'grant' }, {
      now: Date.now(),
    });
    if (!request.ok) {
      setProblems(request.problems);
      return;
    }

    setSubmitting(true);
    onBusyChange(true);
    setError(null);
    try {
      const { code } = await api.post<{ code: AdminPromoCodePayload }>(
        apiPath.adminPromoCodes(),
        request.body,
      );
      setCreated(code);
      onCreated();
    } catch (cause) {
      setError(cause);
      if (isApiError(cause)) {
        const fields = cause.fieldErrors();
        if (fields['code'] !== undefined) setProblems({ code: fields['code'] });
      }
    } finally {
      setSubmitting(false);
      onBusyChange(false);
    }
  }

  if (created !== null) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{created.code} is ready</DialogTitle>
          <DialogDescription>{created.summary}.</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <div className="border-line bg-canvas-inset flex items-center gap-2 rounded-lg border px-3 py-2">
            <code className="text-fg min-w-0 flex-1 font-mono text-lg font-semibold tracking-wide select-all">
              {created.code}
            </code>
            <CopyButton value={created.code} label={`the code ${created.code}`} />
          </div>
          <p className="text-fg-subtle text-sm">
            {created.kind === 'grant'
              ? 'An owner enters it under “Have a code?” on their billing or plans page.'
              : 'An owner enters it under “Have a code?” before checking out; Dodo takes it off at checkout.'}
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </>
    );
  }

  const kind = discountsHere ? form.kind : 'grant';

  return (
    <form onSubmit={submit} noValidate>
      <DialogHeader>
        <DialogTitle>New promo code</DialogTitle>
        <DialogDescription>
          {kind === 'grant'
            ? 'An owner redeems it in the app, and the organisation is on the plan at once — no card, and nothing at the payment provider.'
            : 'Taken off at Dodo’s checkout when an owner subscribes with it. The card is still collected, so 100% off is a free plan with a card on file.'}
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-5">
        {discountsHere ? (
          <Segmented
            label="Kind of code"
            options={[
              { value: 'grant', label: 'Free plan' },
              { value: 'discount', label: 'Checkout discount' },
            ]}
            value={form.kind}
            onChange={(next) => update({ kind: next })}
            className="self-start"
          />
        ) : (
          <Alert tone="info" title="Free-plan codes only">
            <p>
              Payments are not configured on this deployment, so there is no checkout for a discount
              to come off.
            </p>
          </Alert>
        )}

        <Field
          label="Code"
          optional
          error={problems.code}
          hint="3 to 16 letters and digits. Leave it empty for a random one."
        >
          <Input
            value={form.code}
            onChange={(event) => update({ code: normaliseCode(event.target.value) })}
            maxLength={16}
            placeholder="LAUNCH50"
            autoComplete="off"
            spellCheck={false}
            disabled={submitting}
            className="max-w-56 font-mono uppercase"
          />
        </Field>

        {kind === 'grant' ? (
          <GrantFields form={form} problems={problems} update={update} disabled={submitting} />
        ) : (
          <DiscountFields
            form={form}
            problems={problems}
            update={update}
            togglePlan={togglePlan}
            disabled={submitting}
            mode={payments.mode}
          />
        )}

        <Field
          label="Who may use it"
          optional
          error={problems.allowedEmails}
          hint="One address per line, or separated by commas. Leave it empty to let anybody with the code use it."
        >
          <Textarea
            rows={3}
            value={form.allowedEmails}
            onChange={(event) => update({ allowedEmails: event.target.value })}
            placeholder="ada@example.com"
            spellCheck={false}
            disabled={submitting}
          />
        </Field>

        <Field
          label="Most uses"
          optional
          error={problems.maxRedemptions}
          hint={
            kind === 'grant'
              ? 'How many organisations may redeem it in all. Empty for no limit.'
              : 'How many checkouts Dodo lets use it in all. Empty for no limit.'
          }
        >
          <Input
            inputMode="numeric"
            value={form.maxRedemptions}
            onChange={(event) => update({ maxRedemptions: event.target.value })}
            disabled={submitting}
            className="max-w-32"
          />
        </Field>

        <EndPicker
          legend="Expires"
          value={form.expires}
          onChange={(expires) => update({ expires })}
          error={problems.expires}
          never="Never expires"
          on="Expires on…"
          disabled={submitting}
        />

        <Field
          label="Note"
          optional
          error={problems.description}
          hint="For admins: who it is for, and why. Owners never see it."
        >
          <Input
            value={form.description}
            onChange={(event) => update({ description: event.target.value })}
            maxLength={ADMIN_TEXT_MAX_LENGTH}
            placeholder="Product Hunt launch"
            disabled={submitting}
            autoComplete="off"
          />
        </Field>

        {error !== null ? <AdminFailure error={error} title="No code was made" /> : null}
      </DialogBody>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={submitting}>
          Create code
        </Button>
      </DialogFooter>
    </form>
  );
}

type FieldsProps = {
  form: PromoCodeForm;
  problems: PromoCodeProblems;
  update: (patch: Partial<PromoCodeForm>) => void;
  disabled: boolean;
};

function GrantFields({ form, problems, update, disabled }: FieldsProps) {
  return (
    <>
      <fieldset className="flex flex-col gap-1.5" disabled={disabled}>
        <legend className="text-fg mb-1.5 text-sm font-medium">Plan</legend>
        <Segmented
          label="Plan"
          options={GRANTABLE_PLANS}
          value={form.plan}
          onChange={(plan) => update({ plan })}
          className="self-start"
        />
      </fieldset>

      <fieldset className="flex flex-col gap-2" disabled={disabled}>
        <legend className="text-fg mb-1.5 text-sm font-medium">For how long</legend>
        <Segmented
          label="For how long"
          options={[
            { value: 'days', label: 'A number of days' },
            { value: 'forever', label: 'For good' },
          ]}
          value={form.lasts}
          onChange={(lasts) => update({ lasts })}
          className="self-start"
        />
        {form.lasts === 'days' ? (
          <div className="flex items-center gap-2">
            <Input
              inputMode="numeric"
              aria-label="Days"
              value={form.days}
              onChange={(event) => update({ days: event.target.value })}
              aria-invalid={problems.days ? true : undefined}
              className="max-w-24"
            />
            <span className="text-fg-muted text-sm">days from when it is redeemed</span>
          </div>
        ) : null}
        {problems.days ? (
          <p className="text-danger-text text-sm leading-5">{problems.days}</p>
        ) : null}
      </fieldset>

      <Field
        label="Seat ceiling"
        optional
        error={problems.seats}
        hint={`The most members the organisation may have on ${planName(form.plan)}. Empty lets the plan decide.`}
      >
        <Input
          inputMode="numeric"
          value={form.seats}
          onChange={(event) => update({ seats: event.target.value })}
          disabled={disabled}
          className="max-w-32"
        />
      </Field>
    </>
  );
}

function DiscountFields({
  form,
  problems,
  update,
  togglePlan,
  disabled,
  mode,
}: FieldsProps & {
  togglePlan: (plan: CheckoutPlan, on: boolean) => void;
  mode: PaymentsHere['mode'];
}) {
  const percentage = form.discountType === 'percentage';
  return (
    <>
      {mode === 'test_mode' ? (
        <Alert tone="warning" title="Made in Dodo’s test mode">
          <p>
            This deployment’s payments are in test mode, so the discount is made there — and applies
            to nothing once the deployment goes live.
          </p>
        </Alert>
      ) : null}

      <fieldset className="flex flex-col gap-2" disabled={disabled}>
        <legend className="text-fg mb-1.5 text-sm font-medium">Off</legend>
        <Segmented
          label="Kind of discount"
          options={[
            { value: 'percentage', label: 'A percentage' },
            { value: 'flat', label: 'A fixed amount' },
          ]}
          value={form.discountType}
          onChange={(discountType) => update({ discountType })}
          className="self-start"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Input
            inputMode="decimal"
            aria-label={percentage ? 'Percentage off' : 'Amount off'}
            value={form.value}
            onChange={(event) => update({ value: event.target.value })}
            placeholder={percentage ? '50' : '5'}
            aria-invalid={problems.value ? true : undefined}
            className="max-w-28"
          />
          {percentage ? (
            <span className="text-fg-muted text-sm">% off</span>
          ) : (
            <Input
              aria-label="Currency"
              value={form.currency}
              onChange={(event) => update({ currency: event.target.value.toUpperCase() })}
              maxLength={3}
              aria-invalid={problems.currency ? true : undefined}
              className="max-w-20 font-mono uppercase"
            />
          )}
        </div>
        {problems.value ? (
          <p className="text-danger-text text-sm leading-5">{problems.value}</p>
        ) : null}
        {problems.currency ? (
          <p className="text-danger-text text-sm leading-5">{problems.currency}</p>
        ) : null}
        {!percentage ? (
          <p className="text-fg-subtle text-sm leading-5">
            In the currency’s whole units — 5 for $5. Dodo applies it only to a checkout in that
            currency.
          </p>
        ) : null}
      </fieldset>

      <fieldset className="flex flex-col gap-2" disabled={disabled}>
        <legend className="text-fg mb-1.5 text-sm font-medium">On</legend>
        <div className="flex flex-wrap gap-5">
          {(['pro', 'team'] as const).map((plan) => (
            <div key={plan} className="flex items-center gap-2">
              <Checkbox
                id={`promo-plan-${plan}`}
                checked={form.plans.includes(plan)}
                onCheckedChange={(next) => togglePlan(plan, next === true)}
              />
              <Label htmlFor={`promo-plan-${plan}`} className="font-normal">
                {planName(plan)}
              </Label>
            </div>
          ))}
        </div>
        {problems.plans ? (
          <p className="text-danger-text text-sm leading-5">{problems.plans}</p>
        ) : (
          <p className="text-fg-subtle text-sm leading-5">
            Checkout sells Pro and Team; Enterprise is arranged with us.
          </p>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-2" disabled={disabled}>
        <legend className="text-fg mb-1.5 text-sm font-medium">For how long</legend>
        <Segmented
          label="For how long"
          options={[
            { value: 'count', label: 'A number of billing cycles' },
            { value: 'forever', label: 'Every renewal' },
          ]}
          value={form.cycles}
          onChange={(cycles) => update({ cycles })}
          className="self-start"
        />
        {form.cycles === 'count' ? (
          <div className="flex items-center gap-2">
            <Input
              inputMode="numeric"
              aria-label="Billing cycles"
              value={form.cycleCount}
              onChange={(event) => update({ cycleCount: event.target.value })}
              aria-invalid={problems.cycleCount ? true : undefined}
              className="max-w-24"
            />
            <span className="text-fg-muted text-sm">
              billing cycles — months on a monthly plan, years on a yearly one
            </span>
          </div>
        ) : null}
        {problems.cycleCount ? (
          <p className="text-danger-text text-sm leading-5">{problems.cycleCount}</p>
        ) : null}
      </fieldset>
    </>
  );
}

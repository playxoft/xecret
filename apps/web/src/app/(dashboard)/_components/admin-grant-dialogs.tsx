'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';

import { api, errorMessage, isApiError } from '@/lib/api';
import { formatAbsoluteTime } from '@/lib/format';
import { grantTerm } from '@/components/plans/complimentary-plan';
import { planName } from '@/components/plans/plan-copy';
import {
  Alert,
  Button,
  Checkbox,
  CopyButton,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Label,
  useToast,
} from '@/components/ui';
import type { AdminOrganizationPayload } from '@/server/schemas/admin';
import { apiPath } from '../_lib/paths';
import {
  ADMIN_TEXT_MAX_LENGTH,
  dateInputAfter,
  dateInputToIso,
  grantRequest,
  toDateInput,
} from './admin-forms';
import type { EndChoice, GrantablePlan, GrantForm, GrantProblems } from './admin-forms';
import { Segmented } from './segmented';

/**
 * Giving one organisation a free plan, and ending one — from a search result
 * on the Organisations tab or a row on the Grants tab, so both are written once.
 *
 * ── What a grant is ──
 * A paid plan with nothing behind it at the payment provider, which can end
 * (`packages/db/src/repositories/plan-grants.ts`). The organisation's owners
 * see it on their billing screen as a complimentary plan, with its end, and
 * the change lands in their audit log as "xecret support", with the reason
 * asked for here — written for the customer to read.
 *
 * ── An organisation Dodo bills ──
 * Granting over a live subscription takes the organisation off it, and
 * nothing more: the subscription itself keeps charging the card at Dodo until
 * somebody cancels it there. So that is never done by default. The dialog
 * asks for it with a tick of its own, beside a sentence saying exactly that,
 * and afterwards shows the subscription's id to cancel — the step this page
 * cannot take for the admin.
 */

/** Whom a grant dialog acts on — a search result, or a row of the grants list. */
export interface GrantTarget {
  id: string;
  name: string;
  slug: string;
  plan: AdminOrganizationPayload['plan'];
  /** What invitations are refused against now. */
  seatLimit: number;
  grant: { endsAt: string | null; note: string | null } | null;
  /** Dodo bills it, or a paid checkout is on its way: a grant needs `overDodo`. */
  billedByDodo: boolean;
  awaitingActivation: boolean;
}

/**
 * Which row a dialog is open on, and whether it is open — two things, so a
 * dialog that is closing keeps showing the row it was about for the length of
 * its exit animation, instead of emptying under the admin's eyes as it fades.
 */
export function useDialogTarget<T>() {
  const [state, setState] = useState<{ target: T | null; open: boolean }>({
    target: null,
    open: false,
  });
  return {
    target: state.target,
    open: state.open,
    show: (target: T) => setState({ target, open: true }),
    onOpenChange: (open: boolean) => setState((current) => ({ ...current, open })),
  };
}

export function grantTargetOf(organization: AdminOrganizationPayload): GrantTarget {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    plan: organization.plan,
    seatLimit: organization.seats.limit,
    grant: organization.grant,
    billedByDodo: organization.billedByDodo,
    awaitingActivation: organization.awaitingActivation,
  };
}

export const GRANTABLE_PLANS: readonly { value: GrantablePlan; label: string }[] = [
  { value: 'pro', label: 'Pro' },
  { value: 'team', label: 'Team' },
  { value: 'enterprise', label: 'Enterprise' },
];

/** The quick picks beside a date: counted from today, not from the date already chosen. */
const QUICK_PICKS: readonly { label: string; days: number }[] = [
  { label: 'In 30 days', days: 30 },
  { label: 'In 90 days', days: 90 },
  { label: 'In a year', days: 365 },
];

const LINK_BUTTON =
  'text-fg-muted hover:text-fg decoration-line-strong hover:decoration-fg text-sm underline underline-offset-4 disabled:opacity-55';

/**
 * "No end date" or "Ends on…", with the quick picks and the exact instant the
 * date means printed back under it — the start of that day in the admin's own
 * time zone (`dateInputToIso`), said so nobody has to guess which end of the
 * day was meant.
 */
export function EndPicker({
  legend,
  value,
  onChange,
  error,
  never,
  on,
  disabled = false,
}: {
  legend: string;
  value: EndChoice;
  onChange: (next: EndChoice) => void;
  error?: string | undefined;
  /** "No end date", "Never expires". */
  never: string;
  /** "Ends on…", "Expires on…". */
  on: string;
  disabled?: boolean;
}) {
  // The picker's floor, read once: tomorrow, because the server refuses an end
  // that is already past and today began before now.
  const [tomorrow] = useState(() => dateInputAfter(new Date(), 1));
  const iso = value.kind === 'on' ? dateInputToIso(value.date) : null;

  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="text-fg mb-1.5 text-sm font-medium">{legend}</legend>
      <Segmented
        label={legend}
        options={[
          { value: 'never', label: never },
          { value: 'on', label: on },
        ]}
        value={value.kind}
        onChange={(kind) =>
          onChange({
            kind,
            // Opens on a month from today rather than on an empty picker: the
            // commonest answer, one click from any other.
            date: kind === 'on' && value.date === '' ? dateInputAfter(new Date(), 30) : value.date,
          })
        }
        className="self-start"
      />
      {value.kind === 'on' ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Input
              type="date"
              aria-label={on.replace('…', '')}
              value={value.date}
              min={tomorrow}
              onChange={(event) => onChange({ kind: 'on', date: event.target.value })}
              aria-invalid={error ? true : undefined}
              className="max-w-44"
            />
            {QUICK_PICKS.map((pick) => (
              <button
                key={pick.days}
                type="button"
                className={LINK_BUTTON}
                onClick={() =>
                  onChange({ kind: 'on', date: dateInputAfter(new Date(), pick.days) })
                }
              >
                {pick.label}
              </button>
            ))}
          </div>
          {error ? (
            <p className="text-danger-text text-sm leading-5">{error}</p>
          ) : iso !== null ? (
            <p className="text-fg-subtle text-sm leading-5">
              At {formatAbsoluteTime(iso)}, your time.
            </p>
          ) : null}
        </div>
      ) : error ? (
        <p className="text-danger-text text-sm leading-5">{error}</p>
      ) : null}
    </fieldset>
  );
}

/** A request's failure, as the admin needs it: the server's sentence, and the id to look it up by. */
export function AdminFailure({ error, title }: { error: unknown; title: string }) {
  return (
    <Alert tone="danger" title={title}>
      <p>{errorMessage(error)}</p>
      {isApiError(error) && error.requestId ? (
        <p className="mt-1.5 text-sm">
          Request id: <code className="font-mono select-all">{error.requestId}</code>
        </p>
      ) : null}
    </Alert>
  );
}

/* ── Giving a free plan ────────────────────────────────────────────────────── */

export function GrantDialog({
  target,
  open,
  onOpenChange,
  onGranted,
}: {
  target: GrantTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The organisation as it now stands, for the list it was chosen from to re-read. */
  onGranted: (organization: AdminOrganizationPayload) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    // Not dismissed while the request is in flight: a stray Escape must not
    // leave the admin unsure whether the plan changed.
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent>
        {/* The form lives inside the content, which Radix unmounts on close,
            so every opening starts from the organisation it was opened on. */}
        {target !== null ? (
          <GrantFlow
            target={target}
            onBusyChange={setBusy}
            onClose={() => onOpenChange(false)}
            onGranted={onGranted}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function GrantFlow({
  target,
  onBusyChange,
  onClose,
  onGranted,
}: {
  target: GrantTarget;
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
  onGranted: (organization: AdminOrganizationPayload) => void;
}) {
  const { toast } = useToast();
  const needsOverDodo = target.billedByDodo || target.awaitingActivation;
  const replacing = target.grant !== null;
  // A paid plan that is neither a grant nor Dodo's: an Enterprise contract or
  // another arrangement support made by hand. A grant replaces it like any
  // other, and the admin should know that is what they are doing.
  const arranged = target.plan !== 'free' && !replacing && !needsOverDodo;

  // A grant being changed opens on what it is; a new one on Pro — the lowest
  // plan anything is given at — with no end, which is the commonest ask.
  const [form, setForm] = useState<GrantForm>(() => ({
    plan: target.plan === 'free' ? 'pro' : target.plan,
    ends:
      target.grant !== null && target.grant.endsAt !== null
        ? { kind: 'on', date: toDateInput(new Date(target.grant.endsAt)) }
        : { kind: 'never', date: '' },
    seats: '',
    reason: '',
    overDodo: false,
  }));
  const [problems, setProblems] = useState<GrantProblems>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  /** Set once a grant took the organisation off Dodo: what is left to do there. */
  const [detached, setDetached] = useState<{ subscriptionId: string | null } | null>(null);

  function update(patch: Partial<GrantForm>) {
    setForm((current) => ({ ...current, ...patch }));
    setProblems({});
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    const request = grantRequest(form, { needsOverDodo, now: Date.now() });
    if (!request.ok) {
      setProblems(request.problems);
      return;
    }

    setSubmitting(true);
    onBusyChange(true);
    setError(null);
    try {
      const answer = await api.post<{
        organization: AdminOrganizationPayload;
        detachedSubscriptionId: string | null;
      }>(apiPath.adminGrant(target.id), request.body);
      onGranted(answer.organization);
      toast({
        variant: 'success',
        title: `${target.name} is on ${planName(request.body.plan)}, free ${grantTerm(request.body.endsAt)}`,
      });
      // Taken off Dodo: the dialog stays open on what is left to do there.
      if (request.body.overDodo) setDetached({ subscriptionId: answer.detachedSubscriptionId });
      else onClose();
    } catch (cause) {
      setError(cause);
      if (isApiError(cause)) setProblems(serverProblems(cause));
    } finally {
      setSubmitting(false);
      onBusyChange(false);
    }
  }

  if (detached !== null) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Now cancel the subscription in Dodo</DialogTitle>
          <DialogDescription>
            {target.name} is on {planName(form.plan)}, free. Its Dodo subscription was not
            cancelled: it keeps charging the card until somebody cancels it in Dodo’s dashboard.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          {detached.subscriptionId !== null ? (
            <>
              <p className="text-fg text-sm font-medium">The subscription to cancel</p>
              <div className="border-line bg-canvas-inset flex items-center gap-2 rounded-lg border px-3 py-2">
                <code className="text-fg min-w-0 flex-1 font-mono text-sm break-all select-all">
                  {detached.subscriptionId}
                </code>
                <CopyButton value={detached.subscriptionId} label="the Dodo subscription id" />
              </div>
            </>
          ) : (
            <Alert tone="warning" title="No subscription id was on record">
              <p>
                Look {target.name} up in Dodo’s dashboard — by its owner’s address — and cancel any
                subscription you find for it there.
              </p>
            </Alert>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="primary" onClick={onClose}>
            I will cancel it in Dodo
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <form onSubmit={submit} noValidate>
      <DialogHeader>
        <DialogTitle>
          {replacing ? `Change ${target.name}’s free plan` : `Give ${target.name} a free plan`}
        </DialogTitle>
        <DialogDescription>
          A paid plan with nothing to pay and no card. Its owners see it on their billing screen,
          with its end, and the change goes in the organisation’s audit log as xecret support, with
          your reason.
          {replacing ? ' This replaces the free plan it has now.' : ''}
          {arranged
            ? ` This replaces the ${planName(target.plan)} plan support arranged for it.`
            : ''}
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-5">
        <fieldset className="flex flex-col gap-1.5" disabled={submitting}>
          <legend className="text-fg mb-1.5 text-sm font-medium">Plan</legend>
          <Segmented
            label="Plan"
            options={GRANTABLE_PLANS}
            value={form.plan}
            onChange={(plan) => update({ plan })}
            className="self-start"
          />
        </fieldset>

        <EndPicker
          legend="Ends"
          value={form.ends}
          onChange={(ends) => update({ ends })}
          error={problems.ends}
          never="No end date"
          on="Ends on…"
          disabled={submitting}
        />
        <p className="text-fg-subtle -mt-3 text-sm leading-5">
          When it ends the organisation returns to Free. Nothing is deleted and nobody is removed.
        </p>

        <Field
          label="Seat ceiling"
          optional
          error={problems.seats}
          hint={`The most members it may have. Empty lets the plan decide — never fewer than the ${target.seatLimit.toLocaleString('en-GB')} it allows now.`}
        >
          <Input
            inputMode="numeric"
            value={form.seats}
            onChange={(event) => update({ seats: event.target.value })}
            placeholder={String(target.seatLimit)}
            disabled={submitting}
            className="max-w-32"
          />
        </Field>

        <Field
          label="Reason"
          error={problems.reason}
          hint="Written to the organisation’s audit log, where its owners can read it."
        >
          <Input
            value={form.reason}
            onChange={(event) => update({ reason: event.target.value })}
            maxLength={ADMIN_TEXT_MAX_LENGTH}
            placeholder="Launch partner — three months on us"
            disabled={submitting}
            autoComplete="off"
          />
        </Field>

        {needsOverDodo ? (
          <OverDodo
            target={target}
            checked={form.overDodo}
            onCheckedChange={(overDodo) => update({ overDodo })}
            error={problems.overDodo}
            disabled={submitting}
          />
        ) : null}

        {error !== null ? <AdminFailure error={error} title="Nothing was changed" /> : null}
      </DialogBody>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={submitting}
          disabled={needsOverDodo && !form.overDodo}
        >
          {replacing ? 'Change the free plan' : `Give ${planName(form.plan)} free`}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * The one decision in the grant dialog that leaves work behind at Dodo, asked
 * for on its own and never by default.
 */
function OverDodo({
  target,
  checked,
  onCheckedChange,
  error,
  disabled,
}: {
  target: GrantTarget;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  error: string | undefined;
  disabled: boolean;
}) {
  const id = `over-dodo-${target.id}`;
  return (
    <div className="flex flex-col gap-3">
      <Alert
        tone="warning"
        title={
          target.billedByDodo
            ? `${target.name} pays through Dodo`
            : `A checkout ${target.name} paid for is waiting to activate`
        }
      >
        <p>
          A free plan takes it off its subscription, and that is all it does: the subscription keeps
          billing the card at Dodo until somebody cancels it there. You will be shown its id to
          cancel once this is done.
        </p>
      </Alert>
      <div className="flex items-start gap-2.5">
        <Checkbox
          id={id}
          checked={checked}
          onCheckedChange={(next) => onCheckedChange(next === true)}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          className="mt-0.5"
        />
        <Label htmlFor={id} className="leading-5 font-normal">
          Take {target.name} off its Dodo subscription, and I will cancel that subscription in Dodo
        </Label>
      </div>
      {error ? <p className="text-danger-text text-sm leading-5">{error}</p> : null}
    </div>
  );
}

/** The server's field problems, attached to the fields this form draws. */
function serverProblems(error: { fieldErrors(): Record<string, string> }): GrantProblems {
  const fields = error.fieldErrors();
  const problems: GrantProblems = {};
  if (fields['reason'] !== undefined) problems.reason = fields['reason'];
  if (fields['seats'] !== undefined) problems.seats = fields['seats'];
  if (fields['endsAt'] !== undefined) problems.ends = fields['endsAt'];
  if (fields['overDodo'] !== undefined) problems.overDodo = fields['overDodo'];
  return problems;
}

/* ── Ending one ────────────────────────────────────────────────────────────── */

export function EndGrantDialog({
  target,
  open,
  onOpenChange,
  onEnded,
}: {
  target: GrantTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEnded: (organization: AdminOrganizationPayload) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      {/* Not dismissed by a stray click on the backdrop: this takes a plan
          away from a customer, now. Escape and Cancel still close it. */}
      <DialogContent className="max-w-md" onPointerDownOutside={(event) => event.preventDefault()}>
        {target !== null ? (
          <EndGrantFlow
            target={target}
            onBusyChange={setBusy}
            onClose={() => onOpenChange(false)}
            onEnded={onEnded}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function EndGrantFlow({
  target,
  onBusyChange,
  onClose,
  onEnded,
}: {
  target: GrantTarget;
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
  onEnded: (organization: AdminOrganizationPayload) => void;
}) {
  const { toast } = useToast();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      setProblem('Say why — it goes in the organisation’s audit log.');
      return;
    }

    setSubmitting(true);
    onBusyChange(true);
    setError(null);
    try {
      const { organization } = await api.post<{ organization: AdminOrganizationPayload }>(
        apiPath.adminGrantEnd(target.id),
        { reason: trimmed },
      );
      onEnded(organization);
      toast({ variant: 'success', title: `${target.name} is back on Free` });
      onClose();
    } catch (cause) {
      setError(cause);
      if (isApiError(cause)) setProblem(cause.fieldErrors()['reason'] ?? null);
    } finally {
      setSubmitting(false);
      onBusyChange(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <DialogHeader>
        <DialogTitle>End {target.name}’s free plan?</DialogTitle>
        <DialogDescription>
          {target.name} returns to Free now, not when the plan was due to end
          {target.grant !== null && target.grant.endsAt !== null
            ? ` (${formatAbsoluteTime(target.grant.endsAt)})`
            : ''}
          . Nothing is deleted and nobody already in it is removed, but it is held to Free’s limits
          from here on.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-4">
        <Field
          label="Reason"
          error={problem}
          hint="Written to the organisation’s audit log, where its owners can read it."
        >
          <Input
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              setProblem(null);
            }}
            maxLength={ADMIN_TEXT_MAX_LENGTH}
            disabled={submitting}
            autoComplete="off"
            autoFocus
          />
        </Field>
        {error !== null ? <AdminFailure error={error} title="The plan was not ended" /> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant="danger" loading={submitting}>
          End the free plan
        </Button>
      </DialogFooter>
    </form>
  );
}

/** A plan's name and, for a grant, its term — one line for a list. */
export function grantSummary(
  plan: AdminOrganizationPayload['plan'],
  grant: { endsAt: string | null } | null,
): ReactNode {
  if (grant === null) return planName(plan);
  return (
    <>
      {planName(plan)}
      <span className="text-fg-muted"> · free {grantTerm(grant.endsAt)}</span>
    </>
  );
}

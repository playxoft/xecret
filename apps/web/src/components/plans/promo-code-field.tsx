'use client';

import { useState } from 'react';

import { apiPath } from '@/app/(dashboard)/_lib/paths';
import { api, errorMessage, isApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Alert, Button, CheckIcon, Field, Input } from '@/components/ui';
import type { BillingStatusPayload } from '@/server/schemas/billing';
import type { PromoCodePreviewPayload } from '@/server/schemas/admin';
import { planName } from './plan-copy';

/**
 * "Have a code?" — where an owner enters a promo code xecret issued, on the
 * billing screen and on the plans page alike.
 *
 * ── Two kinds of code, two outcomes ──
 * A **free-plan** code is a plan, now: the field checks it, says what it gives,
 * and "Activate {Plan} free" applies it on the spot — no card, nothing at the
 * payment provider. A **discount** code is a price, later: checking it changes
 * nothing, it is held by the screen that starts the checkout and travels in
 * that request, and Dodo's checkout is where the amount comes off. So this
 * component holds the discount only as long as it takes to hand it up
 * (`onApplied`); the screen owns it, because the screen is what sends it.
 *
 * ── What checking a code does ──
 * Nothing but answer. `POST …/promo-code` reads the code and says what it
 * would do for this organisation and this person — or why it would not — and
 * changes nothing, so a mistyped code costs a retry and no state anywhere.
 *
 * ── Shown only where the server says a code can be used ──
 * `billing.actions.promoCode`: an organisation on Free with nothing waiting to
 * activate, and an owner reading it. The caller asks; this component does not
 * second-guess it.
 */

/**
 * The pattern xecret's codes follow — restated from `server/schemas/admin.ts`
 * (`PROMO_CODE_PATTERN`) because a client component may import only types from
 * the server's modules. Checked here so a code with a space in it is answered
 * without a round trip; the server checks again, and its answer is the one
 * that counts.
 */
const CODE_PATTERN = /^[A-Z0-9]{3,16}$/;

/** The server's own sentence for a code that cannot be one of ours. */
const NOT_A_CODE = 'That is not a code we issued. Check it and try again.';

/** A code as typed, as the server will read it: trimmed, upper-cased, no inner spaces. */
export function normalisePromoCode(typed: string): string {
  return typed.replace(/\s+/g, '').toUpperCase();
}

/**
 * The code a checkout for `plan` should carry: the applied discount's, when it
 * is for that plan, and nothing otherwise.
 *
 * A discount names the plans it takes money off (`plans`). Sending it with a
 * checkout for another plan would only be refused, and refused after the owner
 * pressed "Upgrade" — so the checkout for that plan goes without it, and the
 * screen says the code does not apply there.
 */
export function checkoutPromoCode(
  promo: PromoCodePreviewPayload | null,
  plan: 'pro' | 'team',
): string | null {
  if (promo === null || promo.kind !== 'discount') return null;
  return promo.plans?.includes(plan) === true ? promo.code : null;
}

export interface PromoCodeFieldProps {
  orgSlug: string;
  /** The discount the screen will carry into checkout, or `null`. */
  applied: PromoCodePreviewPayload | null;
  /** Hands a checked discount code up to the screen — or `null`, to remove it. */
  onApplied: (promo: PromoCodePreviewPayload | null) => void;
  /**
   * A free-plan code was redeemed: the organisation is on its plan now. The
   * screen re-reads its billing, which is what shows the change.
   */
  onRedeemed: (billing: BillingStatusPayload, promo: PromoCodePreviewPayload) => void;
  /**
   * Whether a discount code can go anywhere from here — whether this screen
   * can start a checkout at all. Where it cannot, a discount code is checked
   * and then said to have nowhere to apply, rather than held for a checkout
   * that will never be offered.
   */
  discounts: boolean;
  className?: string;
}

export function PromoCodeField({
  orgSlug,
  applied,
  onApplied,
  onRedeemed,
  discounts,
  className,
}: PromoCodeFieldProps) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [checking, setChecking] = useState(false);
  const [redeeming, setRedeeming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A free-plan code that has been checked, waiting for "Activate". */
  const [offer, setOffer] = useState<PromoCodePreviewPayload | null>(null);

  function reset() {
    setOpen(false);
    setTyped('');
    setError(null);
    setOffer(null);
  }

  async function check(event: React.FormEvent) {
    event.preventDefault();
    if (checking) return;
    const code = normalisePromoCode(typed);
    if (!CODE_PATTERN.test(code)) {
      setError(code.length === 0 ? 'Enter the code.' : NOT_A_CODE);
      return;
    }

    setChecking(true);
    setError(null);
    setOffer(null);
    try {
      const { promo } = await api.post<{ promo: PromoCodePreviewPayload }>(
        apiPath.billingPromoCode(orgSlug),
        { code },
      );
      if (promo.kind === 'grant') {
        setOffer(promo);
      } else if (!discounts) {
        setError(
          `${promo.code} takes money off a paid plan at checkout, and no checkout can be started for this organisation here.`,
        );
      } else {
        onApplied(promo);
        reset();
      }
    } catch (cause) {
      setError(failure(cause));
    } finally {
      setChecking(false);
    }
  }

  async function redeem() {
    if (offer === null || redeeming) return;
    setRedeeming(true);
    setError(null);
    try {
      const { billing } = await api.post<{ billing: BillingStatusPayload }>(
        apiPath.billingPromoCodeRedeem(orgSlug),
        { code: offer.code },
      );
      const redeemed = offer;
      reset();
      onRedeemed(billing, redeemed);
    } catch (cause) {
      setError(failure(cause));
    } finally {
      setRedeeming(false);
    }
  }

  // ── A discount, held for checkout ──
  if (applied !== null) {
    return (
      <div
        role="status"
        className={cn(
          'border-success-line bg-success-tint flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2 text-sm',
          className,
        )}
      >
        <CheckIcon className="text-success-text size-4 shrink-0" />
        <p className="text-fg min-w-0 flex-1 leading-5">
          <code className="font-mono font-semibold">{applied.code}</code> — {applied.summary}.{' '}
          <span className="text-fg-muted">Applied at checkout.</span>
        </p>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Remove the code ${applied.code}`}
          onClick={() => onApplied(null)}
        >
          Remove
        </Button>
      </div>
    );
  }

  // ── Collapsed: a link, so the page is not built around a field most never use ──
  if (!open) {
    return (
      <div className={className}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-fg-muted hover:text-fg decoration-line-strong hover:decoration-fg text-sm underline underline-offset-4"
        >
          Have a code?
        </button>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <form onSubmit={check} noValidate className="flex flex-col gap-1.5">
        <Field label="Promo code" error={error}>
          <div className="flex flex-wrap gap-2">
            <Input
              value={typed}
              onChange={(event) => {
                setTyped(event.target.value);
                setError(null);
                // A different code is a different question: the answer to the
                // last one no longer stands.
                setOffer(null);
              }}
              placeholder="LAUNCH50"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={24}
              autoFocus
              className="min-w-40 flex-1 font-mono uppercase"
            />
            <Button type="submit" variant="secondary" loading={checking} disabled={redeeming}>
              Apply
            </Button>
            <Button variant="ghost" onClick={reset} disabled={checking || redeeming}>
              Cancel
            </Button>
          </div>
        </Field>
      </form>

      {offer !== null ? <FreePlanOffer offer={offer} busy={redeeming} onActivate={redeem} /> : null}
    </div>
  );
}

/**
 * What a checked free-plan code gives, and the one button that takes it. Said
 * before it is pressed, because pressing it changes the organisation's plan
 * at once — there is no checkout after it to change one's mind in.
 */
function FreePlanOffer({
  offer,
  busy,
  onActivate,
}: {
  offer: PromoCodePreviewPayload;
  busy: boolean;
  onActivate: () => Promise<void>;
}) {
  const plan = offer.plan === null ? 'the plan' : planName(offer.plan);
  return (
    <Alert tone="success" title={offer.summary}>
      <p>
        {plan} applies at once, at no charge, and no card is asked for. If it has an end date, the
        organisation returns to Free then — nothing is deleted.
      </p>
      <div className="mt-3">
        <Button variant="primary" size="sm" loading={busy} onClick={() => void onActivate()}>
          Activate {plan} free
        </Button>
      </div>
    </Alert>
  );
}

/**
 * Why a code was not taken, said beside the field. The server's sentence where
 * it sent one; the request id only where something went wrong on our side,
 * because "that code has expired" is not a support ticket.
 */
function failure(cause: unknown): string {
  const message = errorMessage(cause);
  if (!isApiError(cause) || cause.requestId === null) return message;
  return cause.status >= 500 ? `${message} (Request id: ${cause.requestId})` : message;
}

import type { AdminGrantBody, AdminPromoCodeCreateBody } from '@/server/schemas/admin';

/**
 * The admin page's two forms — a free plan for one organisation, and a promo
 * code — as pure functions from what was typed to what is sent.
 *
 * ── Why these check anything at all ──
 * The server validates every field as though the caller were hostile
 * (`server/schemas/admin.ts`), and its answer is the one that counts. These
 * checks exist for the person at the form: a seat count of "ten" or an end date
 * in the past is answered beside the field it is wrong in, before a round trip
 * that would come back with the same sentence a screen further away.
 *
 * The limits are restated from that schema rather than imported, because a
 * client component may import only its types. Each is named after the
 * constant it mirrors; a server that tightens one still refuses, and says why.
 */

export type GrantablePlan = 'pro' | 'team' | 'enterprise';
export type CheckoutPlan = 'pro' | 'team';

/** `PROMO_CODE_PATTERN`: upper-case letters and digits, 3 to 16 — what Dodo accepts. */
export const PROMO_CODE_PATTERN = /^[A-Z0-9]{3,16}$/;
/** `ADMIN_TEXT_MAX_LENGTH`: a reason, a note or a description. */
export const ADMIN_TEXT_MAX_LENGTH = 200;
/** `ADMIN_MAX_DAYS`: ten years. */
export const ADMIN_MAX_DAYS = 3650;
/** `PROMO_MAX_ALLOWED_EMAILS`. */
export const PROMO_MAX_ALLOWED_EMAILS = 100;
const SEATS_MAX = 100_000;
const USES_MAX = 100_000;
const CYCLES_MAX = 120;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ── Dates ─────────────────────────────────────────────────────────────────── */

const pad = (value: number) => String(value).padStart(2, '0');

/** `YYYY-MM-DD` in the browser's own zone — what `<input type="date">` speaks. */
export function toDateInput(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The date `days` after `from`, as the date picker shows it — the quick picks. */
export function dateInputAfter(from: Date, days: number): string {
  return toDateInput(new Date(from.getFullYear(), from.getMonth(), from.getDate() + days));
}

/**
 * The instant a date chosen in the picker means: the start of that day, in the
 * browser's own zone — "ends on 1 March" is over as 1 March begins. The form
 * prints the instant back under the picker, so nobody has to guess which end
 * of the day was meant.
 *
 * `null` for anything that is not a real calendar date, including one the
 * `Date` constructor would quietly roll over (31 February is 3 March to it).
 */
export function dateInputToIso(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  const [, year, month, day] = match.map(Number) as [number, number, number, number];
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date.toISOString();
}

/** An end the forms offer: none, or the start of a chosen day. */
export interface EndChoice {
  kind: 'never' | 'on';
  /** `YYYY-MM-DD`; read only when `kind` is `on`. */
  date: string;
}

/**
 * An end date as the API takes it, or why not. In the future, and no more
 * than ten years off — the server's own bounds.
 */
export function endInstant(
  choice: EndChoice,
  now: number,
): { ok: true; iso: string | null } | { ok: false; problem: string } {
  if (choice.kind === 'never') return { ok: true, iso: null };
  const iso = dateInputToIso(choice.date);
  if (iso === null) return { ok: false, problem: 'Choose a date.' };
  const at = Date.parse(iso);
  if (at <= now) return { ok: false, problem: 'Choose a date after today.' };
  if (at > now + ADMIN_MAX_DAYS * 86_400_000) {
    return { ok: false, problem: 'At most ten years from now.' };
  }
  return { ok: true, iso };
}

/* ── Numbers and lists ─────────────────────────────────────────────────────── */

/**
 * A whole number typed into a field that may be left empty: `null` for empty,
 * the number when it is one within `[min, max]`, and `undefined` when it is
 * neither — so the caller can tell "no ceiling" from "not a number".
 */
export function optionalWhole(text: string, min: number, max: number): number | null | undefined {
  const trimmed = text.trim().replace(/[,_\s]/g, '');
  if (trimmed === '') return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value >= min && value <= max ? value : undefined;
}

/**
 * The allowed-emails box: one address per line, or separated by commas,
 * semicolons or spaces — however a list was pasted. Lower-cased and
 * de-duplicated, as the server stores them. `null` for an empty box, which is
 * how the API spells "anybody with the code".
 */
export function parseEmailList(text: string): string[] | null {
  const addresses = [
    ...new Set(
      text
        .split(/[\s,;]+/)
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0),
    ),
  ];
  return addresses.length === 0 ? null : addresses;
}

/** A code as typed, as the server will read it. Empty is "make one up". */
export function normaliseCode(typed: string): string {
  return typed.replace(/\s+/g, '').toUpperCase();
}

/* ── A free plan for one organisation ──────────────────────────────────────── */

export interface GrantForm {
  plan: GrantablePlan;
  ends: EndChoice;
  /** The seat ceiling; empty keeps what the organisation allows now, or the plan's own if higher. */
  seats: string;
  reason: string;
  /** Take an organisation Dodo bills off its subscription. Asked only when it is one. */
  overDodo: boolean;
}

export type GrantProblems = Partial<Record<'ends' | 'seats' | 'reason' | 'overDodo', string>>;

export function grantRequest(
  form: GrantForm,
  { needsOverDodo, now }: { needsOverDodo: boolean; now: number },
): { ok: true; body: AdminGrantBody } | { ok: false; problems: GrantProblems } {
  const problems: GrantProblems = {};

  const ends = endInstant(form.ends, now);
  if (!ends.ok) problems.ends = ends.problem;

  const seats = optionalWhole(form.seats, 1, SEATS_MAX);
  if (seats === undefined) problems.seats = 'A whole number of seats, from 1 to 100,000.';

  const reason = form.reason.trim();
  if (reason.length === 0) problems.reason = 'Say why — it goes in the organisation’s audit log.';
  else if (reason.length > ADMIN_TEXT_MAX_LENGTH) {
    problems.reason = `At most ${ADMIN_TEXT_MAX_LENGTH} characters.`;
  }

  // Never sent as `true` unless it was asked and ticked: an organisation Dodo
  // does not bill has nothing to be taken off, and a stale tick from another
  // organisation's dialog must not travel.
  const overDodo = needsOverDodo && form.overDodo;
  if (needsOverDodo && !overDodo) {
    problems.overDodo = 'Tick this to take the organisation off its subscription.';
  }

  if (Object.keys(problems).length > 0 || !ends.ok || seats === undefined) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    body: { plan: form.plan, seats, endsAt: ends.iso, reason, overDodo },
  };
}

/* ── A promo code ──────────────────────────────────────────────────────────── */

export interface PromoCodeForm {
  kind: 'grant' | 'discount';
  /** Empty for a random one. */
  code: string;
  description: string;
  /** The box as typed; see `parseEmailList`. */
  allowedEmails: string;
  maxRedemptions: string;
  expires: EndChoice;

  // A free-plan code.
  plan: GrantablePlan;
  /** `forever`, or for `days` days from each redemption. */
  lasts: 'days' | 'forever';
  days: string;
  seats: string;

  // A checkout discount.
  discountType: 'percentage' | 'flat';
  value: string;
  currency: string;
  /** `forever`, or for `cycleCount` billing cycles. */
  cycles: 'count' | 'forever';
  cycleCount: string;
  plans: readonly CheckoutPlan[];
}

export type PromoCodeProblems = Partial<
  Record<
    | 'code'
    | 'description'
    | 'allowedEmails'
    | 'maxRedemptions'
    | 'expires'
    | 'days'
    | 'seats'
    | 'value'
    | 'currency'
    | 'cycleCount'
    | 'plans',
    string
  >
>;

/** A decimal with at most two places — "12.5", "5", "0.01". */
function decimal(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return undefined;
  return Number(trimmed);
}

export function promoCodeRequest(
  form: PromoCodeForm,
  { now }: { now: number },
): { ok: true; body: AdminPromoCodeCreateBody } | { ok: false; problems: PromoCodeProblems } {
  const problems: PromoCodeProblems = {};

  const code = normaliseCode(form.code);
  if (code !== '' && !PROMO_CODE_PATTERN.test(code)) {
    problems.code = 'A code is 3 to 16 letters and digits.';
  }

  const description = form.description.trim();
  if (description.length > ADMIN_TEXT_MAX_LENGTH) {
    problems.description = `At most ${ADMIN_TEXT_MAX_LENGTH} characters.`;
  }

  const allowedEmails = parseEmailList(form.allowedEmails);
  const notAnAddress = allowedEmails?.find((address) => !EMAIL.test(address));
  if (notAnAddress !== undefined) {
    problems.allowedEmails = `“${notAnAddress}” is not an email address.`;
  } else if (allowedEmails !== null && allowedEmails.length > PROMO_MAX_ALLOWED_EMAILS) {
    problems.allowedEmails = `At most ${PROMO_MAX_ALLOWED_EMAILS} addresses per code.`;
  }

  const maxRedemptions = optionalWhole(form.maxRedemptions, 1, USES_MAX);
  if (maxRedemptions === undefined) {
    problems.maxRedemptions = 'A whole number of uses, from 1 to 100,000.';
  }

  const expires = endInstant(form.expires, now);
  if (!expires.ok) problems.expires = expires.problem;

  let grant: AdminPromoCodeCreateBody['grant'];
  let discount: AdminPromoCodeCreateBody['discount'];

  if (form.kind === 'grant') {
    const days = form.lasts === 'forever' ? null : optionalWhole(form.days, 1, ADMIN_MAX_DAYS);
    if (form.lasts === 'days' && (days === null || days === undefined)) {
      problems.days = 'A whole number of days, from 1 to 3,650.';
    }
    const seats = optionalWhole(form.seats, 1, SEATS_MAX);
    if (seats === undefined) problems.seats = 'A whole number of seats, from 1 to 100,000.';
    if (days !== undefined && seats !== undefined) grant = { plan: form.plan, days, seats };
  } else {
    const value = decimal(form.value);
    if (form.discountType === 'percentage') {
      if (value === undefined || value < 0.01 || value > 100) {
        problems.value = 'A percentage from 0.01 to 100.';
      }
    } else if (value === undefined || value <= 0) {
      problems.value = 'An amount more than nothing, e.g. 5 or 12.50.';
    }

    const currency = form.currency.trim().toUpperCase();
    if (form.discountType === 'flat' && !/^[A-Z]{3}$/.test(currency)) {
      problems.currency = 'A three-letter currency, e.g. USD.';
    }

    const cycles = form.cycles === 'forever' ? null : optionalWhole(form.cycleCount, 1, CYCLES_MAX);
    if (form.cycles === 'count' && (cycles === null || cycles === undefined)) {
      problems.cycleCount = 'A whole number of billing cycles, from 1 to 120.';
    }

    // In the order the pricing page lists them, whatever order they were ticked in.
    const plans = (['pro', 'team'] as const).filter((plan) => form.plans.includes(plan));
    if (plans.length === 0) problems.plans = 'Choose at least one plan.';

    if (value !== undefined && cycles !== undefined) {
      discount = {
        type: form.discountType,
        value,
        currency: form.discountType === 'flat' ? currency : null,
        cycles,
        plans,
      };
    }
  }

  if (
    Object.keys(problems).length > 0 ||
    maxRedemptions === undefined ||
    !expires.ok ||
    (grant === undefined && discount === undefined)
  ) {
    return { ok: false, problems };
  }

  return {
    ok: true,
    body: {
      ...(code === '' ? {} : { code }),
      kind: form.kind,
      description: description === '' ? null : description,
      allowedEmails,
      maxRedemptions,
      expiresAt: expires.iso,
      ...(grant === undefined ? {} : { grant }),
      ...(discount === undefined ? {} : { discount }),
    },
  };
}

import { PLANS } from '@xecret/core/entitlements';
import type { PlanId } from '@xecret/core/entitlements';
import { isApiError } from '@/lib/api';
import type { PlanProblem } from '@/lib/api';

/**
 * How the dashboard talks about plans, in one place.
 *
 * ── Why the dashboard never decides what a plan includes ──
 * Every paid control in P19 is gated by the server, and the server's answer is
 * the only one that counts: an organisation's entitlements carry support
 * overrides and add-ons that the plan table does not, so a screen that read
 * `PLANS` to decide "you cannot do this" would refuse somebody whose ceiling was
 * raised for them. What a screen *can* know is what the server already said —
 * a `plan_limit` refusal, or a `{ enabled, upgradeTo }` block on a listing — and
 * this module turns those into sentences.
 *
 * The one thing read from the plan table is a plan's *name*, because "pro" is
 * an identifier and "Pro" is what the pricing page calls it.
 */

/** A plan's name as the pricing page says it — `team` → "Team". */
export function planName(id: string): string {
  return Object.hasOwn(PLANS, id) ? PLANS[id as PlanId].name : id;
}

/** What a `plan_limit` refusal carried, or `null` for any other failure. */
export interface PlanRefusal {
  /** The server's sentence, which names the limit and usually the plan that lifts it. */
  message: string;
  /** The parsed `plan` block, when the server sent one this client could read. */
  plan: PlanProblem | null;
  /** The cheapest plan that would allow it, or `null` when none would. */
  upgradeTo: string | null;
}

/**
 * Reads a thrown value as a plan refusal.
 *
 * Keyed on the code, not on the block: `lib/api.ts` discards a `plan` block it
 * cannot validate, and a refusal without one is still a refusal — the sentence
 * is enough to render, the block only adds the button.
 */
export function planRefusalOf(error: unknown): PlanRefusal | null {
  if (!isApiError(error) || error.code !== 'plan_limit') return null;
  return { message: error.message, plan: error.plan, upgradeTo: error.plan?.upgradeTo ?? null };
}

/**
 * The sentence under a control the plan does not include.
 *
 * `what` is the act, as a gerund phrase that can start a sentence: "Setting a
 * parent", "Disabling plaintext export". The answer names the plan that would
 * allow it when the server said which, and says plainly that none does when it
 * said none — an offer to upgrade to nothing is worse than no offer.
 */
export function upgradeSentence(what: string, upgradeTo: string | null): string {
  return upgradeTo === null
    ? `${what} is not part of this organisation’s plan.`
    : `${what} needs the ${planName(upgradeTo)} plan.`;
}

/**
 * A refusal whose message starts with a stable machine-readable prefix —
 * `export_disabled: …`, `e2ee_required: …`, `resolution_unsupported: …` — read
 * as the sentence after it, capitalised.
 *
 * The server writes these for clients that branch on the prefix; a person
 * should read the prose. Only a lower-case snake prefix followed by `": "` is
 * stripped, so a message that merely contains a colon is left exactly as it is.
 */
export function withoutReasonPrefix(message: string): string {
  const match = /^[a-z][a-z0-9_]*: (.+)$/s.exec(message);
  if (match === null) return message;
  const rest = match[1] ?? '';
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** The prefix itself — `export_disabled` — or `null` when the message carries none. */
export function reasonPrefixOf(message: string): string | null {
  const match = /^([a-z][a-z0-9_]*): /.exec(message);
  return match === null ? null : (match[1] ?? null);
}

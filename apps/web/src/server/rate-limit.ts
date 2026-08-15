import type { Bindings } from './bindings';
import { errors } from './errors';

/**
 * Rate limiting via Cloudflare's rate-limit binding.
 *
 * A binding rather than Redis or a database counter, because both alternatives
 * cost a network round trip on every request — and a Worker invocation is
 * allowed six outgoing connections total. Spending one to decide whether to
 * serve a request is the wrong trade. The binding's counter lives in the edge
 * runtime and costs nothing from that budget.
 *
 * The honest limitation: Cloudflare's counters are per-colo, not global. A
 * distributed attacker hitting many data centres gets roughly `limit × colos`.
 * That is acceptable for abuse control — which is what this is — and is not a
 * substitute for the controls that actually protect a secret: authentication,
 * authorization, and the audit trail. Anything that must be globally exact
 * belongs in the database with a transaction around it.
 */

export type RateLimitBucket =
  'RL_LOGIN' | 'RL_CLI_TOKEN' | 'RL_INVITE' | 'RL_SECRET_READ' | 'RL_SERVICE' | 'RL_MUTATION';

export interface RateLimitDecision {
  allowed: boolean;
  /** False when no binding was configured, so callers can log the gap. */
  enforced: boolean;
}

/**
 * Consumes one unit from a bucket.
 *
 * When the binding is absent — local development, or before the resource is
 * created — the request is allowed and `enforced` is false. Failing open is the
 * deliberate choice for *this* control: a missing rate limiter must not make the
 * product unusable, and everything it guards is separately authenticated. It
 * would be the wrong choice for an authorization check, which is why that one
 * has no equivalent escape hatch.
 */
export async function consume(
  env: Bindings,
  bucket: RateLimitBucket,
  key: string,
): Promise<RateLimitDecision> {
  const limiter = env[bucket];
  if (!limiter) return { allowed: true, enforced: false };

  const { success } = await limiter.limit({ key });
  return { allowed: success, enforced: true };
}

/** Consumes one unit and throws `rate_limited` when the bucket is exhausted. */
export async function enforce(
  env: Bindings,
  bucket: RateLimitBucket,
  key: string,
): Promise<RateLimitDecision> {
  const decision = await consume(env, bucket, key);
  if (!decision.allowed) throw errors.rateLimited();
  return decision;
}

/**
 * Builds a bucket key.
 *
 * Keys are namespaced by bucket so two limits never share a counter, and the
 * discriminating value is hashed-in as-is rather than concatenated with a
 * separator that could appear inside it — `login|a|b` and `login|a|b` must not
 * be reachable from two different inputs.
 */
export function rateLimitKey(parts: readonly (string | null)[]): string {
  return parts.map((part) => encodeURIComponent(part ?? '-')).join(':');
}

/**
 * The key for an unauthenticated attempt.
 *
 * IP alone is too coarse behind a corporate NAT and too fine against a botnet,
 * so credential-adjacent endpoints combine it with the subject being attempted:
 * one attacker cannot lock every user out by hammering a shared address, and one
 * account cannot be brute-forced from many addresses without also tripping the
 * per-account limit.
 *
 * Only for *guessing* surfaces. Where the thing being spent belongs to the
 * subject rather than to us — mail to somebody's address is the case here — the
 * IP has no business in the key: it hands an attacker a fresh allowance per
 * proxy, and the per-subject counter it is combined with would have bounded the
 * same traffic on its own. Those use `rateLimitKey([prefix, subject])`.
 */
export function attemptKey(ip: string | null, subject: string | null): string {
  return rateLimitKey([ip, subject === null ? null : subject.toLowerCase()]);
}

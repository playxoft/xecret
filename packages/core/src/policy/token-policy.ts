/**
 * The organisation's token policy (P19 §6, `tokenIpAllowlist`, Pro and above).
 *
 * Service tokens have carried an optional IP allowlist and an optional expiry
 * since Phase 8. This promotes both to rules an organisation can *require*:
 *
 *  - **require an allowlist** — a new service token is refused unless it names
 *    the addresses it may be used from;
 *  - **cap the lifetime** — a new service token must expire, no later than the
 *    cap, and a CLI device login is issued with an expiry no later than it.
 *
 * ── The entitlement gates the policy, never the per-token field ──
 * Setting a per-token allowlist or expiry stays available on every plan, as it
 * always was. What the plan buys is the organisation-wide *requirement*, and a
 * downgrade does not switch a requirement off: "never remove a security control
 * someone already relies on because they downgraded" (P19 §6). An organisation
 * that falls back to Free keeps enforcing the policy it set, and may loosen it
 * — it simply cannot tighten it again until it is back on a plan that includes
 * it.
 *
 * ── Creation, not use ──
 * The rules are checked when a token is minted. A token issued before the
 * policy existed keeps working; the token list marks it as outside the policy so
 * somebody can rotate it deliberately. Enforcing at use would break every CI
 * pipeline in the organisation the moment the switch was flipped, which is a
 * worse outcome than the risk the switch exists to reduce.
 */

export interface TokenPolicy {
  readonly requireIpAllowlist: boolean;
  /** Whole days, or `null` for no cap. */
  readonly maxLifetimeDays: number | null;
}

export const DEFAULT_TOKEN_POLICY: TokenPolicy = Object.freeze({
  requireIpAllowlist: false,
  maxLifetimeDays: null,
});

/** Ten years — beyond it, a "cap" is not a cap anybody means. */
export const MAX_TOKEN_LIFETIME_DAYS = 3650;

const DAY_MS = 86_400_000;

/** Whether this policy asks anything of anybody. */
export function tokenPolicyIsActive(policy: TokenPolicy): boolean {
  return policy.requireIpAllowlist || policy.maxLifetimeDays !== null;
}

/**
 * Whether `next` is at least as strict as `previous` in every respect, and
 * stricter in one. Only a tightening needs the entitlement; see the header.
 */
export function tokenPolicyTightens(previous: TokenPolicy, next: TokenPolicy): boolean {
  if (next.requireIpAllowlist && !previous.requireIpAllowlist) return true;
  if (next.maxLifetimeDays === null) return false;
  return previous.maxLifetimeDays === null || next.maxLifetimeDays < previous.maxLifetimeDays;
}

export interface TokenPolicyViolation {
  readonly field: 'ipAllowlist' | 'expiresAt';
  readonly message: string;
}

/** The rules a new service token is held to. */
export function checkServiceTokenAgainstPolicy(
  policy: TokenPolicy,
  token: { ipAllowlist: readonly string[] | null; expiresAt: Date | null },
  now: Date,
): TokenPolicyViolation[] {
  const violations: TokenPolicyViolation[] = [];

  if (policy.requireIpAllowlist && (token.ipAllowlist === null || token.ipAllowlist.length === 0)) {
    violations.push({
      field: 'ipAllowlist',
      message:
        "This organisation's token policy requires every service token to name the IP addresses " +
        'it may be used from. An owner or admin can change the policy in organisation settings.',
    });
  }

  if (policy.maxLifetimeDays !== null) {
    const latest = now.getTime() + policy.maxLifetimeDays * DAY_MS;
    if (token.expiresAt === null || token.expiresAt.getTime() > latest) {
      violations.push({
        field: 'expiresAt',
        message:
          `This organisation's token policy requires every service token to expire within ` +
          `${policy.maxLifetimeDays} days. An owner or admin can change the policy in ` +
          'organisation settings.',
      });
    }
  }

  return violations;
}

/**
 * The expiry a CLI device login is issued with: the requested one, capped.
 *
 * A CLI login is not refused for having no expiry — a person running `xecret
 * login` has no field to fill in — it is given one.
 */
export function capTokenExpiry(
  policy: TokenPolicy,
  requested: Date | null,
  now: Date,
): Date | null {
  if (policy.maxLifetimeDays === null) return requested;
  const latest = new Date(now.getTime() + policy.maxLifetimeDays * DAY_MS);
  if (requested === null || requested.getTime() > latest.getTime()) return latest;
  return requested;
}

/** Whether an existing token would pass the policy if minted now — for the list's marker. */
export function tokenMeetsPolicy(
  policy: TokenPolicy,
  token: { ipAllowlist: readonly string[] | null; expiresAt: Date | null; createdAt: Date },
): boolean {
  if (policy.requireIpAllowlist && (token.ipAllowlist === null || token.ipAllowlist.length === 0)) {
    return false;
  }
  if (policy.maxLifetimeDays !== null) {
    if (token.expiresAt === null) return false;
    const lifetime = token.expiresAt.getTime() - token.createdAt.getTime();
    if (lifetime > policy.maxLifetimeDays * DAY_MS) return false;
  }
  return true;
}

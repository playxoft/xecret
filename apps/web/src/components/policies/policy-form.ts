import {
  checkServiceTokenAgainstPolicy,
  DEFAULT_SECRET_POLICY,
  MAX_TOKEN_LIFETIME_DAYS,
  SECRET_POLICY_LIMITS,
  SecretPolicyError,
  tokenPolicyTightens,
  validateSecretPolicy,
} from '@xecret/core/policy';
import type { SecretPolicy, SecretPolicyScope, TokenPolicy } from '@xecret/core/policy';
import type { FieldProblem } from '@/lib/api';
import { pluralize } from '@/lib/format';
import type { FeatureStatus } from './types';

/**
 * The organisation-policy forms, as pure functions (P19 §6, §8).
 *
 * Everything a policy card or the token dialog *decides* lives here: turning
 * what is in a text box into a policy, whether a change needs a plan, which
 * field a refusal belongs under. The components are left holding state and
 * markup, and these are tested without rendering anything.
 *
 * ── The plan rules, mirrored rather than invented ──
 * The server is the authority on both, and refuses with a `plan_limit` that the
 * cards render. The copies here exist so a locked control is drawn locked —
 * "Save" disabled with the reason beside it — instead of offered and then
 * refused. They are the same two functions the server asks: `tokenPolicyTightens`
 * comes from `@xecret/core/policy` itself, and `secretPolicyChangeNeedsPlan` is
 * the server's rule restated (its module is server-only). If the copies ever
 * drift, the server's refusal still arrives, in the server's words.
 */

const DAY_MS = 86_400_000;

// ── Token policy ──────────────────────────────────────────────────────────────

/** What the token-policy form holds: the switch, and the cap as typed. */
export interface TokenPolicyDraft {
  requireIpAllowlist: boolean;
  capLifetime: boolean;
  /** The cap as typed — a string, so a half-typed number is not coerced to `NaN`. */
  maxLifetimeDays: string;
}

/** The form, seeded from what is stored. An uncapped policy offers 90 days to start from. */
export function tokenPolicyDraftOf(policy: TokenPolicy): TokenPolicyDraft {
  return {
    requireIpAllowlist: policy.requireIpAllowlist,
    capLifetime: policy.maxLifetimeDays !== null,
    maxLifetimeDays: String(policy.maxLifetimeDays ?? 90),
  };
}

export type TokenPolicyParse =
  { ok: true; policy: TokenPolicy } | { ok: false; field: 'maxLifetimeDays'; message: string };

/**
 * The form as a policy, or why it is not one yet.
 *
 * Whole days, from 1 to `MAX_TOKEN_LIFETIME_DAYS` — the bounds the server's
 * schema holds it to, said in the same words.
 */
export function parseTokenPolicyDraft(draft: TokenPolicyDraft): TokenPolicyParse {
  if (!draft.capLifetime) {
    return {
      ok: true,
      policy: { requireIpAllowlist: draft.requireIpAllowlist, maxLifetimeDays: null },
    };
  }

  const text = draft.maxLifetimeDays.trim();
  const days = /^\d+$/.test(text) ? Number.parseInt(text, 10) : Number.NaN;
  if (!Number.isInteger(days) || days < 1 || days > MAX_TOKEN_LIFETIME_DAYS) {
    return {
      ok: false,
      field: 'maxLifetimeDays',
      message: `A lifetime cap is a whole number of days from 1 to ${MAX_TOKEN_LIFETIME_DAYS}.`,
    };
  }
  return {
    ok: true,
    policy: { requireIpAllowlist: draft.requireIpAllowlist, maxLifetimeDays: days },
  };
}

export function sameTokenPolicy(a: TokenPolicy, b: TokenPolicy): boolean {
  return a.requireIpAllowlist === b.requireIpAllowlist && a.maxLifetimeDays === b.maxLifetimeDays;
}

/**
 * Whether storing `next` is refused for the plan.
 *
 * Only a *tightening* needs the feature, and only when the plan lacks it: an
 * organisation that downgraded keeps the policy it set, enforced, and may
 * loosen it or switch it off at any time — it cannot tighten it again until it
 * is back on a plan that includes it.
 */
export function tokenPolicyBlocked(
  stored: TokenPolicy,
  next: TokenPolicy,
  feature: FeatureStatus,
): boolean {
  return !feature.enabled && tokenPolicyTightens(stored, next);
}

// ── Secret policy ─────────────────────────────────────────────────────────────

/**
 * What the secret-policy form holds.
 *
 * Each optional rule is a checkbox *and* its value, so unticking "require a
 * name pattern" does not throw away the pattern that was typed — ticking it
 * again brings it back, which is what anybody who unticked it to see what
 * happens expects.
 */
export interface SecretPolicyDraft {
  enabled: boolean;
  scope: SecretPolicyScope;
  useNamePattern: boolean;
  namePattern: string;
  useEntropy: boolean;
  minValueEntropyBits: string;
  /** One entry per line. */
  entropyAppliesTo: string;
  /** One entry per line. */
  forbiddenSubstrings: string;
}

/** The fields a secret-policy refusal can belong to — `SecretPolicyError.field`. */
export type SecretPolicyField = keyof SecretPolicy;

export function secretPolicyDraftOf(policy: SecretPolicy): SecretPolicyDraft {
  return {
    enabled: policy.enabled,
    scope: policy.scope,
    useNamePattern: policy.namePattern !== null,
    // A pattern that is switched off still offers the default to start from,
    // rather than an empty box nobody knows how to fill.
    namePattern: policy.namePattern ?? DEFAULT_SECRET_POLICY.namePattern ?? '',
    useEntropy: policy.minValueEntropyBits !== null,
    minValueEntropyBits: String(
      policy.minValueEntropyBits ?? DEFAULT_SECRET_POLICY.minValueEntropyBits ?? 64,
    ),
    entropyAppliesTo: policy.entropyAppliesTo.join('\n'),
    forbiddenSubstrings: policy.forbiddenSubstrings.join('\n'),
  };
}

/**
 * "Use the defaults": every rule from `DEFAULT_SECRET_POLICY`, keeping whether
 * the policy is on and where it applies.
 *
 * The defaults ship switched off, and taking that half of them too would turn a
 * button labelled "use the default rules" into one that also switches the
 * policy off — which is not what anybody pressing it meant.
 */
export function withDefaultRules(draft: SecretPolicyDraft): SecretPolicyDraft {
  const defaults = secretPolicyDraftOf({ ...DEFAULT_SECRET_POLICY, enabled: draft.enabled });
  return { ...defaults, enabled: draft.enabled, scope: draft.scope };
}

/**
 * A list as a textarea holds it: one entry per line, trimmed, blank lines
 * dropped, each entry once.
 *
 * Lines rather than commas, because a forbidden word may legitimately contain
 * a comma, and a list whose separator can appear inside an entry is a list
 * nobody can write reliably.
 */
export function parseList(text: string): string[] {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const entry = line.trim();
    if (entry.length === 0 || seen.has(entry)) continue;
    seen.add(entry);
    entries.push(entry);
  }
  return entries;
}

export type SecretPolicyParse =
  { ok: true; policy: SecretPolicy } | { ok: false; field: SecretPolicyField; message: string };

/**
 * The form as a policy, held to `validateSecretPolicy` — the same check the
 * server runs before it stores one, so a policy this accepts is one the server
 * stores, and a pattern that does not compile or could backtrack is refused
 * here, under its own field.
 */
export function parseSecretPolicyDraft(draft: SecretPolicyDraft): SecretPolicyParse {
  let minValueEntropyBits: number | null = null;
  if (draft.useEntropy) {
    const text = draft.minValueEntropyBits.trim();
    const bits = /^\d+$/.test(text) ? Number.parseInt(text, 10) : Number.NaN;
    if (!Number.isInteger(bits)) {
      return {
        ok: false,
        field: 'minValueEntropyBits',
        message: `Minimum entropy is a whole number of bits from 1 to ${SECRET_POLICY_LIMITS.maxEntropyBits}.`,
      };
    }
    minValueEntropyBits = bits;
  }

  const policy: SecretPolicy = {
    enabled: draft.enabled,
    scope: draft.scope,
    namePattern: draft.useNamePattern ? draft.namePattern.trim() : null,
    minValueEntropyBits,
    entropyAppliesTo: parseList(draft.entropyAppliesTo),
    forbiddenSubstrings: parseList(draft.forbiddenSubstrings),
  };

  try {
    return { ok: true, policy: validateSecretPolicy(policy) };
  } catch (cause) {
    if (cause instanceof SecretPolicyError) {
      return { ok: false, field: cause.field, message: cause.message };
    }
    // `validateSecretPolicy` throws nothing else; a fixed sentence rather than
    // an arbitrary exception's message, for the reason `errorMessage` gives.
    return { ok: false, field: 'namePattern', message: 'This policy could not be checked.' };
  }
}

/**
 * Whether a stored policy fails today's checks — a pattern written by a newer
 * engine, or edited by hand. The server's name check skips a pattern that does
 * not compile rather than refusing every write over it, so the settings screen
 * is the one place that can say so.
 */
export function storedSecretPolicyProblem(policy: SecretPolicy): string | null {
  try {
    validateSecretPolicy(policy);
    return null;
  } catch (cause) {
    return cause instanceof SecretPolicyError ? cause.message : 'The stored policy is not valid.';
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

export function sameSecretPolicy(a: SecretPolicy, b: SecretPolicy): boolean {
  return (
    a.enabled === b.enabled &&
    a.scope === b.scope &&
    a.namePattern === b.namePattern &&
    a.minValueEntropyBits === b.minValueEntropyBits &&
    sameList(a.entropyAppliesTo, b.entropyAppliesTo) &&
    sameList(a.forbiddenSubstrings, b.forbiddenSubstrings)
  );
}

/**
 * Whether storing `next` in place of `current` needs the `secretPolicy`
 * feature: any change that leaves the policy switched on. Switching it off, or
 * editing a policy that stays off, does not.
 *
 * The server's `secretPolicyChangeNeedsPlan`, restated — see the header.
 */
export function secretPolicyChangeNeedsPlan(current: SecretPolicy, next: SecretPolicy): boolean {
  if (!next.enabled) return false;
  return !current.enabled || !sameSecretPolicy(current, next);
}

export function secretPolicyBlocked(
  stored: SecretPolicy,
  next: SecretPolicy,
  feature: FeatureStatus,
): boolean {
  return !feature.enabled && secretPolicyChangeNeedsPlan(stored, next);
}

/**
 * A 422's field problems under one prefix, keyed by what follows it.
 *
 * The policy route names a refused field `secrets.namePattern`; a token mint
 * names `ipAllowlist`, or `ipAllowlist.3` for one entry of it. Both collapse to
 * the field the form draws, and the first message for each wins — a list where
 * three entries are wrong the same way says so once.
 */
export function fieldProblemsUnder(
  fields: readonly FieldProblem[],
  prefix: string,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const problem of fields) {
    const rest =
      prefix === ''
        ? problem.field
        : problem.field.startsWith(`${prefix}.`)
          ? problem.field.slice(prefix.length + 1)
          : null;
    if (rest === null) continue;
    const key = rest.split('.')[0] ?? rest;
    if (!(key in map)) map[key] = problem.message;
  }
  return map;
}

// ── Service tokens ────────────────────────────────────────────────────────────

/** The most addresses one token may carry: the server's own bound. */
export const IP_ALLOWLIST_MAX_ENTRIES = 32;

const ALLOWLIST_ENTRY = /^[0-9a-fA-F:.]+(?:\/\d{1,3})?$/;

export type AllowlistParse = { ok: true; entries: string[] } | { ok: false; message: string };

/**
 * An allowlist as typed: addresses or CIDR ranges, separated by commas, spaces
 * or new lines, each once.
 *
 * Shape only, as on the server: `isIpAllowed` decides what an entry means at
 * authentication time. What this refuses is what the server's schema would —
 * a hostname, a stray character, a list past its bound — and it says which
 * entry, because "one of these is wrong" in a list of twelve is a search.
 */
export function parseIpAllowlist(text: string): AllowlistParse {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const piece of text.split(/[\s,]+/)) {
    const entry = piece.trim();
    if (entry.length === 0 || seen.has(entry)) continue;
    if (entry.length > 64 || !ALLOWLIST_ENTRY.test(entry)) {
      return {
        ok: false,
        message: `“${entry.length > 64 ? `${entry.slice(0, 61)}…` : entry}” is not an IP address or CIDR range.`,
      };
    }
    seen.add(entry);
    entries.push(entry);
  }
  if (entries.length > IP_ALLOWLIST_MAX_ENTRIES) {
    return {
      ok: false,
      message: `A token may name at most ${IP_ALLOWLIST_MAX_ENTRIES} addresses or ranges.`,
    };
  }
  return { ok: true, entries };
}

/**
 * When a token minted now with a lifetime of `days` expires.
 *
 * At the policy's cap it is a minute short of it. The server compares the
 * expiry with *its* clock at the moment the request lands, and a browser whose
 * clock runs a few seconds ahead would otherwise be refused for asking for
 * exactly what the form offered it.
 */
export function expiryAfterDays(days: number, now: Date, cap: number | null): Date {
  const margin = cap !== null && days >= cap ? 60_000 : 0;
  return new Date(now.getTime() + days * DAY_MS - margin);
}

/** What the token dialog's two policy fields hold. */
export interface TokenScopeDraft {
  ipAllowlist: string;
  expires: boolean;
  /** As typed. */
  expiresInDays: string;
}

/** The dialog's starting point: the cap pre-filled where the policy has one. */
export function tokenScopeDraftFor(policy: TokenPolicy | null): TokenScopeDraft {
  const cap = policy?.maxLifetimeDays ?? null;
  return {
    ipAllowlist: '',
    expires: cap !== null,
    expiresInDays: String(cap ?? 90),
  };
}

export interface TokenScope {
  ipAllowlist: string[];
  /** ISO 8601, or `null` for a token that does not expire. */
  expiresAt: string | null;
}

export type TokenScopeParse =
  | { ok: true; scope: TokenScope }
  | { ok: false; errors: Partial<Record<'ipAllowlist' | 'expiresAt', string>> };

/**
 * The two fields as the mint request carries them, held to the organisation's
 * token policy before anything is minted.
 *
 * The policy is checked with `checkServiceTokenAgainstPolicy`, the function the
 * server refuses with, so the sentences match the ones a 422 would bring back
 * — but here they arrive under the field, before a token exists. A token
 * cannot be un-minted, which is reason enough to ask first.
 */
export function parseTokenScope(
  draft: TokenScopeDraft,
  policy: TokenPolicy | null,
  now: Date,
): TokenScopeParse {
  const errors: Partial<Record<'ipAllowlist' | 'expiresAt', string>> = {};
  const cap = policy?.maxLifetimeDays ?? null;

  const allowlist = parseIpAllowlist(draft.ipAllowlist);
  if (!allowlist.ok) errors.ipAllowlist = allowlist.message;

  let expiresAt: Date | null = null;
  if (draft.expires) {
    const text = draft.expiresInDays.trim();
    const days = /^\d+$/.test(text) ? Number.parseInt(text, 10) : Number.NaN;
    if (!Number.isInteger(days) || days < 1 || days > MAX_TOKEN_LIFETIME_DAYS) {
      errors.expiresAt = `Enter a whole number of days from 1 to ${MAX_TOKEN_LIFETIME_DAYS}.`;
    } else if (cap !== null && days > cap) {
      errors.expiresAt = `This organisation’s token policy caps a service token’s life at ${pluralize(cap, 'day')}.`;
    } else {
      expiresAt = expiryAfterDays(days, now, cap);
    }
  }

  if (policy !== null && errors.ipAllowlist === undefined && errors.expiresAt === undefined) {
    const violations = checkServiceTokenAgainstPolicy(
      policy,
      { ipAllowlist: allowlist.ok ? allowlist.entries : null, expiresAt },
      now,
    );
    for (const violation of violations) errors[violation.field] ??= violation.message;
  }

  if (errors.ipAllowlist !== undefined || errors.expiresAt !== undefined) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    scope: {
      ipAllowlist: allowlist.ok ? allowlist.entries : [],
      expiresAt: expiresAt === null ? null : expiresAt.toISOString(),
    },
  };
}

/**
 * Which rules of the token policy an existing token falls outside, as phrases
 * — "has no IP allowlist", "never expires" — for the marker on the token list.
 *
 * The server decides `meetsPolicy`; this says *why*, from the same token and
 * the same policy the listing carried. Measured as the server measures it: a
 * lifetime is from creation to expiry, not from now.
 */
export function tokenPolicyGaps(
  policy: TokenPolicy,
  token: { ipAllowlist: readonly string[] | null; expiresAt: string | null; createdAt: string },
): string[] {
  const gaps: string[] = [];
  if (policy.requireIpAllowlist && (token.ipAllowlist === null || token.ipAllowlist.length === 0)) {
    gaps.push('has no IP allowlist');
  }
  if (policy.maxLifetimeDays !== null) {
    if (token.expiresAt === null) {
      gaps.push('never expires');
    } else {
      const lifetime = Date.parse(token.expiresAt) - Date.parse(token.createdAt);
      if (lifetime > policy.maxLifetimeDays * DAY_MS) {
        gaps.push(`lives longer than ${pluralize(policy.maxLifetimeDays, 'day')}`);
      }
    }
  }
  return gaps;
}

/** The sentence a token outside the policy carries. */
export function outsidePolicySentence(gaps: readonly string[]): string {
  const reason = gaps.length === 0 ? 'falls outside the token policy' : gaps.join(' and ');
  return (
    `This token ${reason}. It was minted before the policy and keeps working; ` +
    'replace it with a new token to bring it inside the policy.'
  );
}

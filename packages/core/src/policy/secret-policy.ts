/**
 * The secret naming and strength policy (P19 §8, `secretPolicy`, Team and above).
 *
 * ── Who enforces which rule, stated plainly ──
 * Names are plaintext (ADR 0009, trade-off 1), so the **name** rule is enforced
 * by the server on every write that introduces a name: a create, a rename, an
 * import, a promotion. No client can get past it.
 *
 * Values are not. The server never sees one, so the **value** rules — minimum
 * entropy, forbidden substrings — are enforced by the clients that hold the
 * plaintext: the dashboard as you type, and the CLI before it encrypts. A client
 * someone has modified can skip them, and nothing on the server can tell. That
 * is the same concession every value-shape check makes under end-to-end
 * encryption (see `prepareClientWrite` in the web app), and the documentation
 * says so in those words rather than implying an enforcement that does not exist.
 *
 * Both halves come from this one module, so the dashboard, the CLI's rules and
 * the server's name check cannot disagree about what the policy means.
 *
 * ── What a violation may say ──
 * The rule, never the value. Every message below is assembled from fixed
 * strings and the policy's own numbers; none of them echoes the value, and the
 * forbidden-substring rule does not even name *which* word matched — the word is
 * a fragment of the value, and an error message is the easiest place in a
 * system for a credential to escape into a log.
 *
 * ── Enforced at write, warned on existing, never on a read ──
 * Nothing here is consulted on the fetch path. A policy turned on today does not
 * make yesterday's secrets unreadable; the dashboard marks them, and the next
 * write of each one is held to the rule.
 */

export type SecretPolicyScope = 'all' | 'production';

export interface SecretPolicy {
  /** Off until an administrator turns it on; the default ruleset ships disabled. */
  readonly enabled: boolean;
  /** Every environment, or only those marked production. */
  readonly scope: SecretPolicyScope;
  /**
   * A regular expression the **whole** name must match, or `null` for none.
   *
   * Anchored by the evaluator (`^(?:…)$`), so `[A-Z_]+` means "only these",
   * not "contains one of these". Evaluated on the server, in JavaScript.
   */
  readonly namePattern: string | null;
  /** Minimum estimated entropy of a value, in bits, or `null` for none. */
  readonly minValueEntropyBits: number | null;
  /**
   * Which names the entropy rule applies to: any name containing one of these,
   * case-insensitively. Empty means every name.
   *
   * Substrings rather than a second regular expression because this rule runs
   * in the Go CLI as well as here, and two regular-expression dialects are two
   * answers to the same question.
   */
  readonly entropyAppliesTo: readonly string[];
  /** Values may not contain any of these, case-insensitively. */
  readonly forbiddenSubstrings: readonly string[];
}

/**
 * The ruleset an organisation starts from: sensible, and switched off.
 *
 * Upper-case snake names; 64 bits of entropy for anything whose name says it is
 * a credential, and none demanded of `PORT` or `NODE_ENV`; and the handful of
 * placeholder values that end up in production more often than anyone admits.
 */
export const DEFAULT_SECRET_POLICY: SecretPolicy = Object.freeze({
  enabled: false,
  scope: 'all',
  namePattern: '[A-Z][A-Z0-9_]*',
  minValueEntropyBits: 64,
  entropyAppliesTo: Object.freeze([
    'SECRET',
    'PASSWORD',
    'PASSWD',
    'TOKEN',
    'PRIVATE_KEY',
    'API_KEY',
  ]),
  forbiddenSubstrings: Object.freeze(['changeme', 'password', 'letmein', 'default', '123456']),
});

export const SECRET_POLICY_LIMITS = Object.freeze({
  namePatternMaxLength: 200,
  maxEntropyBits: 512,
  maxListEntries: 50,
  maxListEntryLength: 100,
});

/** One broken rule. `rule` is stable for a client to branch on; `message` is for people. */
export interface PolicyViolation {
  readonly rule: 'namePattern' | 'minValueEntropyBits' | 'forbiddenSubstrings';
  readonly message: string;
}

/** Why a policy could not be stored. Safe to show: built from the policy's own fields. */
export class SecretPolicyError extends Error {
  constructor(
    readonly field: keyof SecretPolicy,
    message: string,
  ) {
    super(message);
    this.name = 'SecretPolicyError';
  }
}

/**
 * A group that is itself repeated and holds a quantifier or an alternation —
 * `(a+)+`, `(a|ab)*`, `(x{2,})+` — the shapes that backtrack exponentially in a
 * JavaScript engine.
 *
 * A heuristic, and a deliberately coarse one: it refuses some patterns that are
 * harmless, and an administrator who wants one can usually write it without the
 * repeated group. What it buys is that a name rule, evaluated on the server on
 * every create, cannot be the thing that pins a Worker's CPU. Names are at most
 * 256 characters, which bounds the rest.
 */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*(?:[+*|]|\{\d)(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d)/;

/** Checks a policy's shape before it is stored, throwing a `SecretPolicyError`. */
export function validateSecretPolicy(policy: SecretPolicy): SecretPolicy {
  if (policy.scope !== 'all' && policy.scope !== 'production') {
    throw new SecretPolicyError(
      'scope',
      'The policy applies to all environments or to production.',
    );
  }

  if (policy.namePattern !== null) {
    const pattern = policy.namePattern;
    if (pattern.length === 0 || pattern.length > SECRET_POLICY_LIMITS.namePatternMaxLength) {
      throw new SecretPolicyError(
        'namePattern',
        `A name pattern is 1 to ${SECRET_POLICY_LIMITS.namePatternMaxLength} characters.`,
      );
    }
    if (NESTED_QUANTIFIER.test(pattern)) {
      throw new SecretPolicyError(
        'namePattern',
        'A name pattern may not repeat a group that itself repeats or alternates, e.g. (A+)+ — ' +
          'rewrite it without the repeated group.',
      );
    }
    try {
      new RegExp(anchored(pattern));
    } catch {
      throw new SecretPolicyError(
        'namePattern',
        'The name pattern is not a valid regular expression.',
      );
    }
  }

  if (policy.minValueEntropyBits !== null) {
    const bits = policy.minValueEntropyBits;
    if (!Number.isInteger(bits) || bits < 1 || bits > SECRET_POLICY_LIMITS.maxEntropyBits) {
      throw new SecretPolicyError(
        'minValueEntropyBits',
        `Minimum entropy is a whole number of bits from 1 to ${SECRET_POLICY_LIMITS.maxEntropyBits}.`,
      );
    }
  }

  for (const field of ['entropyAppliesTo', 'forbiddenSubstrings'] as const) {
    const list = policy[field];
    if (list.length > SECRET_POLICY_LIMITS.maxListEntries) {
      throw new SecretPolicyError(field, `At most ${SECRET_POLICY_LIMITS.maxListEntries} entries.`);
    }
    for (const entry of list) {
      if (entry.length === 0 || entry.length > SECRET_POLICY_LIMITS.maxListEntryLength) {
        throw new SecretPolicyError(
          field,
          `Each entry is 1 to ${SECRET_POLICY_LIMITS.maxListEntryLength} characters.`,
        );
      }
    }
  }

  return policy;
}

function anchored(pattern: string): string {
  return `^(?:${pattern})$`;
}

/** Whether a policy governs an environment at all. */
export function policyApplies(policy: SecretPolicy, isProduction: boolean): boolean {
  return policy.enabled && (policy.scope === 'all' || isProduction);
}

/**
 * The name rule. Run by the server on every write that introduces a name, and
 * by the dashboard as you type.
 */
export function checkNameAgainstPolicy(
  policy: SecretPolicy,
  name: string,
  isProduction: boolean,
): PolicyViolation[] {
  if (!policyApplies(policy, isProduction) || policy.namePattern === null) return [];

  let matcher: RegExp;
  try {
    matcher = new RegExp(anchored(policy.namePattern));
  } catch {
    // A stored pattern that no longer compiles — written by a newer engine, or
    // edited by hand. Refusing every write over it would be the policy breaking
    // the product; the settings screen reports it instead.
    return [];
  }

  if (matcher.test(name)) return [];
  return [
    {
      rule: 'namePattern',
      message: `This organisation requires secret names to match ${policy.namePattern}.`,
    },
  ];
}

/**
 * The value rules. Run by the clients — the server cannot — before a value is
 * encrypted. See the header for why that is a concession and not a guarantee.
 */
export function checkValueAgainstPolicy(
  policy: SecretPolicy,
  name: string,
  value: string,
  isProduction: boolean,
): PolicyViolation[] {
  if (!policyApplies(policy, isProduction)) return [];
  const violations: PolicyViolation[] = [];

  if (policy.minValueEntropyBits !== null && entropyRuleApplies(policy, name)) {
    if (estimateEntropyBits(value) < policy.minValueEntropyBits) {
      violations.push({
        rule: 'minValueEntropyBits',
        message:
          `This organisation requires values of secrets like ${name} to carry at least ` +
          `${policy.minValueEntropyBits} bits of entropy. Generate a longer, more random value.`,
      });
    }
  }

  const lowered = value.toLowerCase();
  if (policy.forbiddenSubstrings.some((entry) => lowered.includes(entry.toLowerCase()))) {
    violations.push({
      rule: 'forbiddenSubstrings',
      message: "This value contains one of the organisation's forbidden words.",
    });
  }

  return violations;
}

function entropyRuleApplies(policy: SecretPolicy, name: string): boolean {
  if (policy.entropyAppliesTo.length === 0) return true;
  const upper = name.toUpperCase();
  return policy.entropyAppliesTo.some((entry) => upper.includes(entry.toUpperCase()));
}

/**
 * An estimate of a value's entropy, in bits: its length times the Shannon
 * entropy of its own character distribution.
 *
 * An estimate, and a conservative one for random strings — a 32-character
 * base64 token scores about 150 bits, `password1` about 28 — which is the
 * direction a strength rule should err in. It does not know about dictionaries
 * or keyboard walks; the forbidden-substring rule is the tool for those.
 */
export function estimateEntropyBits(value: string): number {
  const characters = [...value];
  if (characters.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const character of characters) counts.set(character, (counts.get(character) ?? 0) + 1);

  let perCharacter = 0;
  for (const count of counts.values()) {
    const probability = count / characters.length;
    perCharacter -= probability * Math.log2(probability);
  }
  return Math.round(perCharacter * characters.length);
}

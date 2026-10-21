import { describe, expect, it } from 'vitest';
import {
  capTokenExpiry,
  checkNameAgainstPolicy,
  checkServiceTokenAgainstPolicy,
  checkValueAgainstPolicy,
  DEFAULT_SECRET_POLICY,
  DEFAULT_TOKEN_POLICY,
  estimateEntropyBits,
  policyApplies,
  SECRET_POLICY_LIMITS,
  SecretPolicyError,
  tokenMeetsPolicy,
  tokenPolicyIsActive,
  tokenPolicyTightens,
  validateSecretPolicy,
  longestRepeatRun,
} from './index';
import type { SecretPolicy } from './index';

const ON: SecretPolicy = { ...DEFAULT_SECRET_POLICY, enabled: true };

describe('the default secret policy', () => {
  it('ships switched off', () => {
    expect(DEFAULT_SECRET_POLICY.enabled).toBe(false);
    expect(checkNameAgainstPolicy(DEFAULT_SECRET_POLICY, 'lowercase', true)).toEqual([]);
    expect(checkValueAgainstPolicy(DEFAULT_SECRET_POLICY, 'API_KEY', 'x', true)).toEqual([]);
  });

  it('is itself a valid policy', () => {
    expect(validateSecretPolicy(ON)).toBe(ON);
  });
});

describe('scope', () => {
  it('applies everywhere, or only to production', () => {
    expect(policyApplies(ON, false)).toBe(true);
    expect(policyApplies({ ...ON, scope: 'production' }, false)).toBe(false);
    expect(policyApplies({ ...ON, scope: 'production' }, true)).toBe(true);
    expect(checkNameAgainstPolicy({ ...ON, scope: 'production' }, 'bad-name', false)).toEqual([]);
  });
});

describe('the name rule', () => {
  it('matches the whole name, not a substring', () => {
    expect(checkNameAgainstPolicy(ON, 'DATABASE_URL', false)).toEqual([]);
    const [violation] = checkNameAgainstPolicy(ON, 'database_URL', false);
    expect(violation?.rule).toBe('namePattern');
    // `[A-Z][A-Z0-9_]*` would match "URL" inside "database_URL" if it were not
    // anchored. It must not.
    expect(checkNameAgainstPolicy({ ...ON, namePattern: '[A-Z]+' }, 'xURL', false)).toHaveLength(1);
  });

  it('is skipped when no pattern is set', () => {
    expect(checkNameAgainstPolicy({ ...ON, namePattern: null }, 'anything', false)).toEqual([]);
  });

  it('degrades a stored pattern that no longer compiles to no rule, rather than refusing every write', () => {
    expect(checkNameAgainstPolicy({ ...ON, namePattern: '([' }, 'X', false)).toEqual([]);
  });
});

describe('the value rules', () => {
  it('demands entropy only of names that say they are credentials', () => {
    expect(checkValueAgainstPolicy(ON, 'PORT', '5432', false)).toEqual([]);
    const violations = checkValueAgainstPolicy(ON, 'STRIPE_API_KEY', 'short', false);
    expect(violations.map((violation) => violation.rule)).toEqual(['minValueEntropyBits']);
  });

  it('demands entropy of every name when the list is empty', () => {
    const everywhere = { ...ON, entropyAppliesTo: [] };
    expect(checkValueAgainstPolicy(everywhere, 'PORT', '5432', false)).toHaveLength(1);
  });

  it('accepts a long random value', () => {
    const value = 'q8Z2xL0vR9sT4bW7nY1cK6mP3dF5gH0j';
    expect(checkValueAgainstPolicy(ON, 'API_TOKEN', value, false)).toEqual([]);
  });

  it('refuses a forbidden substring in any case, and never says which one', () => {
    const [violation] = checkValueAgainstPolicy(ON, 'NOTE', 'please ChangeMe later', false);
    expect(violation?.rule).toBe('forbiddenSubstrings');
    expect(violation?.message.toLowerCase()).not.toContain('changeme');
  });

  it('never echoes the value in any message', () => {
    const value = 'password-hunter2';
    for (const violation of checkValueAgainstPolicy(ON, 'DB_PASSWORD', value, false)) {
      expect(violation.message).not.toContain(value);
      expect(violation.message).not.toContain('hunter2');
    }
  });
});

describe('estimateEntropyBits', () => {
  it('scores nothing for nothing, and little for repetition', () => {
    expect(estimateEntropyBits('')).toBe(0);
    expect(estimateEntropyBits('aaaaaaaaaaaaaaaa')).toBe(0);
    expect(estimateEntropyBits('ab')).toBe(2);
  });

  it('scores a random token well above a dictionary word', () => {
    expect(estimateEntropyBits('password1')).toBeLessThan(40);
    expect(estimateEntropyBits('q8Z2xL0vR9sT4bW7nY1cK6mP3dF5gH0j')).toBeGreaterThan(140);
  });

  it('counts code points, not UTF-16 units', () => {
    expect(estimateEntropyBits('🔑🔑')).toBe(0);
  });
});

describe('validateSecretPolicy', () => {
  const refused = (policy: SecretPolicy): string => {
    try {
      validateSecretPolicy(policy);
    } catch (error) {
      if (error instanceof SecretPolicyError) return error.field;
      throw error;
    }
    throw new Error('expected a refusal');
  };

  it.each([['(A+)+'], ['(A|AB)*'], ['([A-Z]{2,})+'], ['(?:X*)*']])(
    'refuses the backtracking shape %s',
    (pattern) => {
      expect(refused({ ...ON, namePattern: pattern })).toBe('namePattern');
    },
  );

  // Review round 1, L12: no repeated group, so the nested check let these
  // through, and each backtracks polynomially in the name's length.
  it.each([
    ['A*A*A*A*A*A*A*A*A*A*A*A*!'],
    ['\\w*\\w*\\w*X'],
    ['[A-Z]*[A-Z]*[A-Z]*'],
    ['A*?A*?A*?'],
    ['A{1,}A{2,9}A+'],
    ['(?:AB)*(?:AB)*(?:AB)*'],
    ['A*B?A*B?A*'],
    ['PREFIX_(X*X*X*)'],
  ])('refuses three or more repeated parts in a row: %s', (pattern) => {
    expect(refused({ ...ON, namePattern: pattern })).toBe('namePattern');
  });

  // Review round 2, F2: a group with no quantifier of its own, a zero-width
  // escape, an empty group and a lookaround each reset the run instead of
  // letting it pass through, so these backtrack exactly like `A*A*A*` and
  // must be refused the same way.
  it.each([
    ['(?:[A-Z_]*)(?:[A-Z_]*)(?:[A-Z_]*)'],
    ['[A-Z_]*\\B[A-Z_]*\\B[A-Z_]*'],
    ['A*()A*()A*'],
    ['A*(?=)A*(?=)A*'],
  ])('refuses the repeated-run bypass %s', (pattern) => {
    expect(longestRepeatRun(pattern)).toBeGreaterThan(2);
    expect(refused({ ...ON, namePattern: pattern })).toBe('namePattern');
  });

  it('passes the run through rather than amplifying it: two is still two', () => {
    expect(longestRepeatRun('(?:[A-Z_]*)[A-Z_]*')).toBe(2);
    expect(longestRepeatRun('A*\\BA*')).toBe(2);
    expect(longestRepeatRun('A*()A*')).toBe(2);
    expect(longestRepeatRun('A*(?=)A*')).toBe(2);
    // A group's own quantifier is unaffected: this path already worked.
    expect(longestRepeatRun('(?:AB)*(?:AB)*')).toBe(2);
    // A disambiguating lookaround with real content still breaks the run,
    // the same way a literal does.
    expect(longestRepeatRun('A*(?=B)A*(?=B)A*')).toBe(1);
  });

  it('counts a run on one level, broken by any part that does not repeat', () => {
    expect(longestRepeatRun('[A-Z][A-Z0-9_]*')).toBe(1);
    expect(longestRepeatRun('[A-Z]+_[A-Z]+_[A-Z0-9]+')).toBe(1);
    expect(longestRepeatRun('A*B*')).toBe(2);
    expect(longestRepeatRun('A{3}B{3}C{3}')).toBe(0);
    expect(longestRepeatRun('A*|B*|C*')).toBe(1);
    expect(longestRepeatRun('[*+]*[{]*')).toBe(2);
    expect(longestRepeatRun('\\u{41}*\\p{Lu}*')).toBe(2);
  });

  it('accepts ordinary patterns, including an unrepeated alternation', () => {
    for (const pattern of [
      '[A-Z][A-Z0-9_]*',
      '(APP|SVC)_[A-Z0-9_]+',
      'NEXT_PUBLIC_.*',
      '[A-Z]+_[A-Z]+_[A-Z0-9]+',
      '[A-Z]*[0-9]*',
    ]) {
      expect(() => validateSecretPolicy({ ...ON, namePattern: pattern })).not.toThrow();
    }
  });

  it('refuses a pattern that does not compile, an empty one, and an overlong one', () => {
    expect(refused({ ...ON, namePattern: '([' })).toBe('namePattern');
    expect(refused({ ...ON, namePattern: '' })).toBe('namePattern');
    expect(
      refused({ ...ON, namePattern: 'A'.repeat(SECRET_POLICY_LIMITS.namePatternMaxLength + 1) }),
    ).toBe('namePattern');
  });

  it('bounds the entropy requirement to whole bits in range', () => {
    expect(refused({ ...ON, minValueEntropyBits: 0 })).toBe('minValueEntropyBits');
    expect(refused({ ...ON, minValueEntropyBits: 1.5 })).toBe('minValueEntropyBits');
    expect(refused({ ...ON, minValueEntropyBits: SECRET_POLICY_LIMITS.maxEntropyBits + 1 })).toBe(
      'minValueEntropyBits',
    );
  });

  it('bounds both lists', () => {
    const many = Array.from({ length: SECRET_POLICY_LIMITS.maxListEntries + 1 }, (_, i) => `w${i}`);
    expect(refused({ ...ON, forbiddenSubstrings: many })).toBe('forbiddenSubstrings');
    expect(refused({ ...ON, entropyAppliesTo: [''] })).toBe('entropyAppliesTo');
    expect(
      refused({
        ...ON,
        forbiddenSubstrings: ['x'.repeat(SECRET_POLICY_LIMITS.maxListEntryLength + 1)],
      }),
    ).toBe('forbiddenSubstrings');
  });

  it('refuses an unknown scope', () => {
    expect(refused({ ...ON, scope: 'staging' as never })).toBe('scope');
  });
});

/* ── tokens ──────────────────────────────────────────────────────────────── */

const NOW = new Date('2026-10-20T12:00:00.000Z');
const days = (count: number): Date => new Date(NOW.getTime() + count * 86_400_000);

describe('the token policy', () => {
  it('asks nothing by default', () => {
    expect(tokenPolicyIsActive(DEFAULT_TOKEN_POLICY)).toBe(false);
    expect(
      checkServiceTokenAgainstPolicy(
        DEFAULT_TOKEN_POLICY,
        { ipAllowlist: null, expiresAt: null },
        NOW,
      ),
    ).toEqual([]);
  });

  it('requires an allowlist when told to, and an empty one does not count', () => {
    const policy = { requireIpAllowlist: true, maxLifetimeDays: null };
    expect(
      checkServiceTokenAgainstPolicy(policy, { ipAllowlist: [], expiresAt: null }, NOW).map(
        (violation) => violation.field,
      ),
    ).toEqual(['ipAllowlist']);
    expect(
      checkServiceTokenAgainstPolicy(
        policy,
        { ipAllowlist: ['203.0.113.0/24'], expiresAt: null },
        NOW,
      ),
    ).toEqual([]);
  });

  it('requires an expiry within the cap', () => {
    const policy = { requireIpAllowlist: false, maxLifetimeDays: 30 };
    const fields = (expiresAt: Date | null) =>
      checkServiceTokenAgainstPolicy(policy, { ipAllowlist: null, expiresAt }, NOW).map(
        (violation) => violation.field,
      );
    expect(fields(null)).toEqual(['expiresAt']);
    expect(fields(days(31))).toEqual(['expiresAt']);
    expect(fields(days(30))).toEqual([]);
  });

  it('caps a CLI login rather than refusing it', () => {
    const policy = { requireIpAllowlist: false, maxLifetimeDays: 7 };
    expect(capTokenExpiry(policy, null, NOW)).toEqual(days(7));
    expect(capTokenExpiry(policy, days(30), NOW)).toEqual(days(7));
    expect(capTokenExpiry(policy, days(3), NOW)).toEqual(days(3));
    expect(capTokenExpiry(DEFAULT_TOKEN_POLICY, null, NOW)).toBeNull();
  });

  it('knows a tightening from a loosening', () => {
    const off = DEFAULT_TOKEN_POLICY;
    expect(tokenPolicyTightens(off, { requireIpAllowlist: true, maxLifetimeDays: null })).toBe(
      true,
    );
    expect(tokenPolicyTightens(off, { requireIpAllowlist: false, maxLifetimeDays: 90 })).toBe(true);
    expect(
      tokenPolicyTightens(
        { requireIpAllowlist: false, maxLifetimeDays: 90 },
        { requireIpAllowlist: false, maxLifetimeDays: 30 },
      ),
    ).toBe(true);
    expect(
      tokenPolicyTightens(
        { requireIpAllowlist: true, maxLifetimeDays: 30 },
        { requireIpAllowlist: false, maxLifetimeDays: 90 },
      ),
    ).toBe(false);
    expect(tokenPolicyTightens({ requireIpAllowlist: true, maxLifetimeDays: 30 }, off)).toBe(false);
  });

  it('marks an existing token that the policy would not mint today', () => {
    const policy = { requireIpAllowlist: true, maxLifetimeDays: 30 };
    expect(
      tokenMeetsPolicy(policy, { ipAllowlist: ['10.0.0.1'], expiresAt: days(10), createdAt: NOW }),
    ).toBe(true);
    expect(
      tokenMeetsPolicy(policy, { ipAllowlist: null, expiresAt: days(10), createdAt: NOW }),
    ).toBe(false);
    expect(
      tokenMeetsPolicy(policy, { ipAllowlist: ['10.0.0.1'], expiresAt: null, createdAt: NOW }),
    ).toBe(false);
    expect(
      tokenMeetsPolicy(policy, { ipAllowlist: ['10.0.0.1'], expiresAt: days(40), createdAt: NOW }),
    ).toBe(false);
  });
});

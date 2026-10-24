import { describe, expect, it } from 'vitest';
import {
  checkValueAgainstPolicy,
  DEFAULT_SECRET_POLICY,
  estimateEntropyBits,
  SecretPolicyError,
  validateSecretPolicy,
} from '../index';
import type { SecretPolicy } from '../index';
import fixtures from './policy-fixtures.json';

/**
 * The value rules as both clients must apply them — this suite and the Go CLI
 * read the same file, so a value the dashboard accepts is a value `xecret
 * secrets set` accepts.
 *
 * `namePatterns` is read here too, but not for the same reason: the name rule
 * itself stays the server's alone (TypeScript only). It exists so the Go
 * port of the backtracking guard — kept only for cross-language parity,
 * review round 2, F2 — can be checked against the exact patterns this suite
 * already refuses, without the two ever being asked to agree on anything
 * this suite does not also assert.
 */

interface ValueCase {
  name: string;
  policy: SecretPolicy;
  secretName: string;
  value: string;
  /** The type the secret will hold; absent means a plain value. */
  valueType?: string;
  isProduction: boolean;
  violations: string[];
}

interface NamePatternCase {
  name: string;
  pattern: string;
  safe: boolean;
}

describe('the shared policy fixtures', () => {
  it.each(fixtures.entropy)('estimates $value at $bits bits', ({ value, bits }) => {
    expect(estimateEntropyBits(value)).toBe(bits);
  });

  it.each(fixtures.values as ValueCase[])('$name', (testCase) => {
    expect(
      checkValueAgainstPolicy(
        testCase.policy,
        testCase.secretName,
        testCase.value,
        testCase.isProduction,
        testCase.valueType,
      ).map((violation) => violation.rule),
    ).toEqual(testCase.violations);
  });

  it.each(fixtures.namePatterns as NamePatternCase[])('$name', ({ pattern, safe }) => {
    const policy: SecretPolicy = { ...DEFAULT_SECRET_POLICY, enabled: true, namePattern: pattern };
    if (safe) {
      expect(() => validateSecretPolicy(policy)).not.toThrow();
    } else {
      expect(() => validateSecretPolicy(policy)).toThrow(SecretPolicyError);
    }
  });
});

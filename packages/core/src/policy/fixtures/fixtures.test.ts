import { describe, expect, it } from 'vitest';
import { checkValueAgainstPolicy, estimateEntropyBits } from '../index';
import type { SecretPolicy } from '../index';
import fixtures from './policy-fixtures.json';

/**
 * The value rules as both clients must apply them — this suite and the Go CLI
 * read the same file, so a value the dashboard accepts is a value `xecret
 * secrets set` accepts.
 */

interface ValueCase {
  name: string;
  policy: SecretPolicy;
  secretName: string;
  value: string;
  isProduction: boolean;
  violations: string[];
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
      ).map((violation) => violation.rule),
    ).toEqual(testCase.violations);
  });
});

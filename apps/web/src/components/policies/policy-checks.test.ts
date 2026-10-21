import { describe, expect, it } from 'vitest';

import { DEFAULT_SECRET_POLICY } from '@xecret/core/policy';
import type { SecretPolicy } from '@xecret/core/policy';
import { errorMessage } from '@/lib/api';
import {
  nameWarning,
  PENDING_SECRET_POLICY,
  POLICY_PENDING_MESSAGE,
  POLICY_UNREADABLE_MESSAGE,
  policyProblem,
  policyRefusal,
  policyViolations,
  secretPolicyFrom,
  UNREADABLE_SECRET_POLICY,
  valueWarning,
  violationField,
} from './policy-checks';

/**
 * The organisation's secret policy as the dashboard applies it: refusing its
 * own writes before it encrypts them, and warning — never refusing — about
 * secrets that predate the rule.
 *
 * Every message is asserted not to contain the value: the forbidden-word rule
 * in particular is the one place a fragment of a credential could slip into an
 * error, and the core module is written so it cannot.
 */

const ON: SecretPolicy = { ...DEFAULT_SECRET_POLICY, enabled: true };
const STRONG = 'Zq8#kL2!xV9@mN4$pR7&tW5^yB3*';

describe('policyViolations — the write check', () => {
  it('asks nothing of a policy that is off, absent, or scoped elsewhere', () => {
    const write = { name: 'lower', newName: true, value: 'changeme', isProduction: false };
    expect(policyViolations(DEFAULT_SECRET_POLICY, write)).toEqual([]);
    expect(policyViolations(null, write)).toEqual([]);
    expect(policyViolations({ ...ON, scope: 'production' }, write)).toEqual([]);
    expect(
      policyViolations({ ...ON, scope: 'production' }, { ...write, isProduction: true }),
    ).not.toEqual([]);
  });

  it('holds a new name to the naming rule, and an existing one to nothing', () => {
    expect(
      policyViolations(ON, { name: 'lower_case', newName: true, isProduction: false }).map(
        (violation) => violation.rule,
      ),
    ).toEqual(['namePattern']);
    expect(
      policyViolations(ON, { name: 'lower_case', newName: false, isProduction: false }),
    ).toEqual([]);
  });

  it('holds a value to the entropy and forbidden-word rules', () => {
    const rules = policyViolations(ON, {
      name: 'API_TOKEN',
      newName: false,
      value: 'changeme',
      isProduction: false,
    }).map((violation) => violation.rule);
    expect(rules).toEqual(['minValueEntropyBits', 'forbiddenSubstrings']);

    expect(
      policyViolations(ON, {
        name: 'API_TOKEN',
        newName: false,
        value: STRONG,
        isProduction: false,
      }),
    ).toEqual([]);
  });

  it('does not ask the entropy rule of a template, nor the word rule of its references', () => {
    // `${DB_PASSWORD}` would fail both rules read as text: it is short and
    // predictable, and it contains "password". It is neither — it is a name.
    expect(
      policyViolations(ON, {
        name: 'DB_PASSWORD_URL',
        newName: false,
        value: 'postgres://app:${DB_PASSWORD}@db',
        valueType: 'template',
        isProduction: false,
      }),
    ).toEqual([]);
    // The literal text is still asked about the words it holds.
    expect(
      policyViolations(ON, {
        name: 'DSN',
        newName: false,
        value: 'postgres://app:changeme@${DB_HOST}',
        valueType: 'template',
        isProduction: false,
      }).map((violation) => violation.rule),
    ).toEqual(['forbiddenSubstrings']);
  });

  it('files each broken rule under the field it is about', () => {
    const violations = policyViolations(ON, {
      name: 'bad_name',
      newName: true,
      value: 'password1',
      isProduction: false,
    });
    expect(violations.map(violationField)).toEqual(['name', 'value']);
  });

  it('joins every broken rule into one sentence, and never quotes the value', () => {
    const problem = policyProblem(ON, {
      name: 'API_TOKEN',
      newName: false,
      value: 'my-changeme-token',
      isProduction: true,
    });
    expect(problem).toMatch(/entropy/);
    expect(problem).toMatch(/forbidden words/);
    expect(problem).not.toContain('changeme');
    expect(policyProblem(ON, { name: 'X', newName: false, value: 'ok', isProduction: false })).toBe(
      null,
    );
  });
});

describe('a policy the screen does not have (review round 1, M5)', () => {
  const value = { name: 'API_TOKEN', newName: false, value: STRONG, isProduction: false };

  it('is the organisation’s once it lands, and a stand-in until then or when it fails', () => {
    expect(secretPolicyFrom({ data: { secrets: ON }, error: null })).toBe(ON);
    expect(secretPolicyFrom({ data: null, error: null })).toBe(PENDING_SECRET_POLICY);
    expect(secretPolicyFrom({ data: null, error: new Error('down') })).toBe(
      UNREADABLE_SECRET_POLICY,
    );
  });

  it('refuses a value — even one every rule would accept — saying why', () => {
    expect(policyProblem(UNREADABLE_SECRET_POLICY, value)).toBe(POLICY_UNREADABLE_MESSAGE);
    expect(policyProblem(PENDING_SECRET_POLICY, value)).toBe(POLICY_PENDING_MESSAGE);
    expect(
      policyViolations(UNREADABLE_SECRET_POLICY, { ...value, newName: true }).map(violationField),
    ).toEqual(['value']);
  });

  it('lets a write that carries no value through: the server asks the name rule itself', () => {
    expect(
      policyViolations(UNREADABLE_SECRET_POLICY, {
        name: 'renamed',
        newName: true,
        isProduction: true,
      }),
    ).toEqual([]);
  });

  it('warns about nothing, because it describes no rule', () => {
    expect(nameWarning(UNREADABLE_SECRET_POLICY, 'legacy-name', false)).toBeNull();
    expect(
      valueWarning(UNREADABLE_SECRET_POLICY, { name: 'API_TOKEN', value: 'x', isProduction: true }),
    ).toBeNull();
  });
});

describe('the warnings beside existing secrets', () => {
  it('marks a name that predates the naming rule, without refusing anything', () => {
    expect(nameWarning(ON, 'legacy-name', false)).toMatch(/predates/);
    expect(nameWarning(ON, 'GOOD_NAME', false)).toBeNull();
    expect(nameWarning(null, 'legacy-name', false)).toBeNull();
  });

  it('marks a revealed value the value rules would refuse today', () => {
    const warning = valueWarning(ON, { name: 'API_TOKEN', value: 'letmein', isProduction: false });
    expect(warning).toMatch(/entropy/);
    expect(warning).toMatch(/forbidden words/);
    expect(warning).not.toContain('letmein');
    expect(valueWarning(ON, { name: 'API_TOKEN', value: STRONG, isProduction: false })).toBeNull();
    expect(
      valueWarning(
        { ...ON, scope: 'production' },
        {
          name: 'API_TOKEN',
          value: 'letmein',
          isProduction: false,
        },
      ),
    ).toBeNull();
  });
});

describe('policyRefusal', () => {
  it('reaches the person through the ordinary error path, each line naming its key', () => {
    const refusal = policyRefusal([
      { field: 'API_TOKEN', message: 'API_TOKEN: too weak.' },
      { field: 'DB_PASSWORD', message: 'DB_PASSWORD: too weak.' },
    ]);
    expect(refusal.code).toBe('validation_failed');
    expect(errorMessage(refusal)).toBe('API_TOKEN: too weak. DB_PASSWORD: too weak.');
    expect(refusal.fieldErrors()).toEqual({
      API_TOKEN: 'API_TOKEN: too weak.',
      DB_PASSWORD: 'DB_PASSWORD: too weak.',
    });
  });
});

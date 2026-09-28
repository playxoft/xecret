import { describe, expect, it } from 'vitest';
import {
  CUSTOM_ROLE_NAME_MAX_LENGTH,
  customRoleNameProblem,
  normalizeCustomRoleName,
} from './role-name';

/**
 * What an organisation may call a custom role. The refused names below are the
 * ones a review found accepted: invisible, reversed, NUL-bearing, or a
 * built-in role's own name.
 *
 * Every non-ASCII character is built from its code point, so this file holds
 * no invisible character of its own and shows exactly what it tests.
 */
const cp = (...points: number[]) => String.fromCodePoint(...points);

const NUL = cp(0x0000);
const RLO = cp(0x202e); // right-to-left override
const PDF = cp(0x202c); // pop directional formatting
const ZWSP = cp(0x200b); // zero-width space
const LINE_SEPARATOR = cp(0x2028);
const BOM = cp(0xfeff);
const IDEOGRAPHIC_SPACE = cp(0x3000);
const NBSP = cp(0x00a0);
const CYRILLIC_IE = cp(0x0435);
const COMBINING_ACUTE = cp(0x0301);
const E_ACUTE = cp(0x00e9);
const EM_DASH = cp(0x2014);

describe('custom role names', () => {
  const check = (raw: string) => customRoleNameProblem(normalizeCustomRoleName(raw));

  it('accepts an ordinary job title, in any script', () => {
    const names = [
      'Deployer',
      'Release manager',
      'Contractor (read-only)',
      `D${E_ACUTE}veloppeur`,
      cp(0x904b, 0x7528, 0x62c5, 0x5f53),
      `SRE ${EM_DASH} on call`,
    ];
    for (const name of names) expect(check(name), name).toBeNull();
  });

  it('refuses control and format characters — NUL, newlines, bidi overrides, zero-width', () => {
    const names = [
      `a${NUL}b`,
      'Line\nbreak',
      `${RLO}nwo${PDF}`,
      `Dep${ZWSP}loyer`,
      ZWSP,
      `a${LINE_SEPARATOR}b`,
      `B${BOM}OM`,
    ];
    for (const name of names) {
      expect(check(name), JSON.stringify(name)).toMatch(/control or invisible/);
    }
  });

  it('wants something visible', () => {
    expect(check('   ')).toBe('A role needs a name.');
    expect(check(IDEOGRAPHIC_SPACE)).toBe('A role needs a name.');
    expect(check(`${NBSP}.`)).toBeNull();
  });

  it('refuses the built-in role names in any case', () => {
    for (const name of ['owner', 'Owner', 'ADMIN', 'Developer', ' viewer ']) {
      expect(check(name), name).toMatch(/built-in role/);
    }
    // A lookalike (Cyrillic "ie") is a different name, and not the built-in one.
    expect(check(`Own${CYRILLIC_IE}r`)).toBeNull();
  });

  it('normalises to NFC, so one name has one spelling', () => {
    expect(normalizeCustomRoleName(`Cafe${COMBINING_ACUTE}`)).toBe(`Caf${E_ACUTE}`);
    expect(normalizeCustomRoleName('  Deployer  ')).toBe('Deployer');
  });

  it('bounds the length', () => {
    expect(check('x'.repeat(CUSTOM_ROLE_NAME_MAX_LENGTH))).toBeNull();
    expect(check('x'.repeat(CUSTOM_ROLE_NAME_MAX_LENGTH + 1))).toMatch(/at most/);
  });
});

import { describe, expect, it } from 'vitest';
import {
  CUSTOM_ROLE_NAME_MAX_LENGTH,
  customRoleNameProblem,
  customRoleNameSkeleton,
  normalizeCustomRoleName,
} from './role-name';

/**
 * What an organisation may call a custom role. The refused names below are the
 * ones two reviews found accepted: invisible, reversed, NUL-bearing, a
 * built-in role's own name, or one of those dressed in lookalike letters,
 * variation selectors, fillers or odd spaces.
 *
 * Every non-ASCII character is built from its code point, so this file holds
 * no invisible or lookalike character of its own and shows exactly what it
 * tests.
 */
const cp = (...points: number[]) => String.fromCodePoint(...points);

const NUL = cp(0x0000);
const RLO = cp(0x202e); // right-to-left override
const PDF = cp(0x202c); // pop directional formatting
const ZWSP = cp(0x200b); // zero-width space
const SOFT_HYPHEN = cp(0x00ad);
const LINE_SEPARATOR = cp(0x2028);
const BOM = cp(0xfeff);
const IDEOGRAPHIC_SPACE = cp(0x3000);
const NBSP = cp(0x00a0);
const CGJ = cp(0x034f); // combining grapheme joiner
const HANGUL_FILLER = cp(0x3164);
const HANGUL_CHOSEONG_FILLER = cp(0x115f);
const HALFWIDTH_HANGUL_FILLER = cp(0xffa0);
const KHMER_INHERENT_AQ = cp(0x17b4);
const BRAILLE_BLANK = cp(0x2800);
const VS1 = cp(0xfe00);
const VS16 = cp(0xfe0f); // emoji presentation
const VS17 = cp(0xe0100);
const MONGOLIAN_FVS1 = cp(0x180b);
const HEART = cp(0x2764);
const CYRILLIC_CAPITAL_O = cp(0x041e);
const CYRILLIC_SMALL_IE = cp(0x0435);
const GREEK_CAPITAL_ALPHA = cp(0x0391);
const TURKISH_DOTTED_CAPITAL_I = cp(0x0130);
const LATIN_DOTLESS_I = cp(0x0131);
const COMBINING_LONG_STROKE = cp(0x0336);
const COMBINING_ACUTE = cp(0x0301);
const E_ACUTE = cp(0x00e9);
const EM_DASH = cp(0x2014);
const HYPHEN = cp(0x2010);

/** "Admin" in the full-width forms East Asian keyboards type. */
const FULLWIDTH_ADMIN = cp(0xff21, 0xff44, 0xff4d, 0xff49, 0xff4e);
/** "Admin" in mathematical bold, which renders as bold Latin letters. */
const MATH_BOLD_ADMIN = cp(0x1d400, 0x1d41d, 0x1d426, 0x1d422, 0x1d427);
/** "Deployer" in full-width forms. */
const FULLWIDTH_DEPLOYER = cp(0xff24, 0xff45, 0xff50, 0xff4c, 0xff4f, 0xff59, 0xff45, 0xff52);
/** "ACE" spelled wholly in Cyrillic capitals — no Latin letter in it. */
const CYRILLIC_ACE = cp(0x0410, 0x0421, 0x0415);
/** Two Devanagari words that differ only by a vowel sign (a combining mark). */
const DEVANAGARI_DEV = cp(0x0926, 0x0947, 0x0935);
const DEVANAGARI_DV = cp(0x0926, 0x0935);

describe('custom role names', () => {
  const check = (raw: string) => customRoleNameProblem(normalizeCustomRoleName(raw));

  it('accepts an ordinary job title, in any one script', () => {
    const names = [
      'Deployer',
      'Release manager',
      'Contractor (read-only)',
      `D${E_ACUTE}veloppeur`,
      cp(0x904b, 0x7528, 0x62c5, 0x5f53),
      `SRE ${EM_DASH} on call`,
      // Latin beside a script that shares no letters with it is not a disguise.
      `SRE ${cp(0x904b, 0x7528)}`,
      // Wholly Cyrillic, and wholly Greek.
      cp(0x0420, 0x0430, 0x0437, 0x0440, 0x0430, 0x0431, 0x043e, 0x0442, 0x0447, 0x0438, 0x043a),
      cp(0x03a0, 0x03c1, 0x03bf, 0x03b3, 0x03c1, 0x03b1, 0x03bc, 0x03bc, 0x03b1, 0x03c4, 0x03b9),
      DEVANAGARI_DEV,
      // An emoji, with or without the selector that asks for colour.
      `${HEART}${VS16} Support`,
    ];
    for (const name of names) expect(check(name), JSON.stringify(name)).toBeNull();
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
      `Own${SOFT_HYPHEN}er`,
      `Own${ZWSP}er`,
    ];
    for (const name of names) {
      expect(check(name), JSON.stringify(name)).toMatch(/control, formatting or invisible/);
    }
  });

  it('refuses characters that render as nothing — joiners, fillers, the Braille blank', () => {
    const names = [
      `Ow${CGJ}ner`,
      HANGUL_FILLER,
      HANGUL_CHOSEONG_FILLER,
      HALFWIDTH_HANGUL_FILLER,
      BRAILLE_BLANK,
      `Owner${HANGUL_FILLER}`,
      `Admin${BRAILLE_BLANK}`,
      `Owner${KHMER_INHERENT_AQ}`,
      `Deploy${CGJ}er`,
    ];
    for (const name of names) {
      expect(check(name), JSON.stringify(name)).toMatch(/control, formatting or invisible/);
    }
  });

  it('wants something visible', () => {
    expect(check('   ')).toBe('A role needs a name.');
    expect(check(IDEOGRAPHIC_SPACE)).toBe('A role needs a name.');
    expect(check(COMBINING_ACUTE)).toBe('A role name needs at least one visible character.');
    expect(check(`${NBSP}.`)).toBeNull();
  });

  it('refuses the built-in role names in any case', () => {
    for (const name of ['owner', 'Owner', 'ADMIN', 'Developer', ' viewer ']) {
      expect(check(name), name).toMatch(/built-in role/);
    }
  });

  it('refuses a built-in name behind a selector, a lookalike letter or another width', () => {
    const names = [
      `Owner${VS16}`,
      `Ad${VS1}min`,
      `Admin${VS17}`,
      `Owner${MONGOLIAN_FVS1}`,
      `${CYRILLIC_CAPITAL_O}wner`,
      `${GREEK_CAPITAL_ALPHA}dmin`,
      MATH_BOLD_ADMIN,
      FULLWIDTH_ADMIN,
      `ADM${TURKISH_DOTTED_CAPITAL_I}N`,
      `adm${LATIN_DOTLESS_I}n`,
      Array.from('Admin', (letter) => `${letter}${COMBINING_LONG_STROKE}`).join(''),
      `Vi${E_ACUTE}wer`,
      `${IDEOGRAPHIC_SPACE}Owner${NBSP}`,
    ];
    for (const name of names) {
      expect(check(name), JSON.stringify(name)).toMatch(/built-in role/);
    }
  });

  it('refuses a name mixing Latin letters with Cyrillic or Greek ones', () => {
    expect(check(`D${CYRILLIC_SMALL_IE}ployer`)).toMatch(/cannot mix Latin/);
    expect(check(`Rel${cp(0x03b5)}ase`)).toMatch(/cannot mix Latin/);
  });

  it('normalises to one spelling: NFC, no selectors, one ordinary space', () => {
    expect(normalizeCustomRoleName(`Cafe${COMBINING_ACUTE}`)).toBe(`Caf${E_ACUTE}`);
    expect(normalizeCustomRoleName('  Deployer  ')).toBe('Deployer');
    expect(normalizeCustomRoleName(`Deployer${VS16}`)).toBe('Deployer');
    expect(normalizeCustomRoleName(`Release${NBSP}manager`)).toBe('Release manager');
    expect(normalizeCustomRoleName(`Release${IDEOGRAPHIC_SPACE}manager`)).toBe('Release manager');
    expect(normalizeCustomRoleName('Release   manager')).toBe('Release manager');
    expect(normalizeCustomRoleName(`${HEART}${VS16}`)).toBe(HEART);
  });

  it('bounds the length', () => {
    expect(check('x'.repeat(CUSTOM_ROLE_NAME_MAX_LENGTH))).toBeNull();
    expect(check('x'.repeat(CUSTOM_ROLE_NAME_MAX_LENGTH + 1))).toMatch(/at most/);
  });
});

describe('customRoleNameSkeleton — what makes two names one', () => {
  const same = (a: string, b: string) => customRoleNameSkeleton(a) === customRoleNameSkeleton(b);

  it('is one name for spellings a reader cannot tell apart', () => {
    const pairs: [string, string][] = [
      ['Deployer', 'deployer'],
      ['Deployer', 'DEPLOYER'],
      ['Deployer', `Deployer${VS16}`],
      ['Deployer', FULLWIDTH_DEPLOYER],
      ['Release manager', `Release${NBSP}manager`],
      ['Release manager', `Release${IDEOGRAPHIC_SPACE}manager`],
      ['Release manager', 'Release  manager'],
      ['ACE', CYRILLIC_ACE],
      [`D${E_ACUTE}veloppeur`, 'Developpeur'],
      [`D${E_ACUTE}veloppeur`, `De${COMBINING_ACUTE}veloppeur`],
      ['on-call', `on${HYPHEN}call`],
    ];
    for (const [a, b] of pairs)
      expect(same(a, b), `${JSON.stringify(a)} ~ ${JSON.stringify(b)}`).toBe(true);
  });

  it('keeps apart names a reader can tell apart', () => {
    const pairs: [string, string][] = [
      ['Deployer', 'Deployers'],
      ['Release manager', 'Releasemanager'],
      // A vowel sign is part of a Devanagari letter, not an accent on it.
      [DEVANAGARI_DEV, DEVANAGARI_DV],
    ];
    for (const [a, b] of pairs)
      expect(same(a, b), `${JSON.stringify(a)} ~ ${JSON.stringify(b)}`).toBe(false);
  });

  it('reduces every built-in imitation above to the built-in name', () => {
    expect(customRoleNameSkeleton(`${CYRILLIC_CAPITAL_O}wner`)).toBe('owner');
    expect(customRoleNameSkeleton(MATH_BOLD_ADMIN)).toBe('admin');
    expect(customRoleNameSkeleton(FULLWIDTH_ADMIN)).toBe('admin');
    expect(customRoleNameSkeleton(`ADM${TURKISH_DOTTED_CAPITAL_I}N`)).toBe('admin');
  });
});

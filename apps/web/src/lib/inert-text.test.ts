import { describe, expect, it } from 'vitest';

import { hasNonAsciiCharacters, inertText, REPLACED } from './inert-text';

/**
 * What the sign-in confirmation may show of a name somebody else chose — the
 * account's address, an organisation's name (review round 2). Each case is a
 * way to make a reader see something other than what the string is.
 *
 * Every special character is built from its code point: this file must not
 * contain the invisible characters it tests, or it would be its own exploit.
 */

const at = (...points: number[]) => String.fromCodePoint(...points);

/** Every code point the cases below plant, none of which may survive. */
const PLANTED = [
  0x202a, 0x202e, 0x2066, 0x2067, 0x2069, 0x200b, 0x200d, 0xfeff, 0x00ad, 0x0085, 0x0000, 0x2028,
  0x2029, 0xe000, 0x3164, 0x115f, 0x1160, 0xffa0, 0x2800,
];

describe('inertText', () => {
  it('leaves an ordinary name or address alone', () => {
    expect(inertText('Acme Corp', 80)).toBe('Acme Corp');
    expect(inertText(`pat.o${at(0x2019)}brien@example.com`, 120)).toBe(
      `pat.o${at(0x2019)}brien@example.com`,
    );
    expect(inertText(`Soci${at(0xe9)}t${at(0xe9)}`, 80)).toBe(`Soci${at(0xe9)}t${at(0xe9)}`);
    expect(inertText(at(0x682a, 0x5f0f, 0x4f1a, 0x793e), 80)).toBe(
      at(0x682a, 0x5f0f, 0x4f1a, 0x793e),
    );
  });

  it.each([
    ['a right-to-left override', `${at(0x202e)}moc.elpmaxe@ecila`],
    ['a left-to-right embedding', `a${at(0x202a)}b`],
    ['a direction isolate', `a${at(0x2067)}b${at(0x2069)}`],
    ['a zero-width space', `Acme${at(0x200b)}`],
    ['a zero-width joiner', `Ac${at(0x200d)}me`],
    ['a byte-order mark', `${at(0xfeff)}Acme`],
    ['a soft hyphen', `Ac${at(0x00ad)}me`],
    ['a C1 control', `Acme${at(0x0085)}`],
    ['a NUL', `Acme${at(0x0000)}`],
    ['a line separator', `Acme${at(0x2028)}Corp`],
    ['a paragraph separator', `Acme${at(0x2029)}Corp`],
    ['a private-use character', `Acme${at(0xe000)}`],
    ['a lone surrogate', `Acme${String.fromCharCode(0xd800)}`],
    // Review round 3: blanks that Unicode classes as letters or symbols, so
    // no general-category test catches them.
    ['a HANGUL FILLER', `Acme${at(0x3164)}`],
    ['a HANGUL CHOSEONG FILLER', `Ac${at(0x115f)}me`],
    ['a HANGUL JUNGSEONG FILLER', `Ac${at(0x1160)}me`],
    ['a HALFWIDTH HANGUL FILLER', `${at(0xffa0)}Acme`],
    ['a BRAILLE PATTERN BLANK', `Acme${at(0x2800)}Corp`],
  ])('shows %s as a replacement character, never invisibly', (_label, value) => {
    const shown = inertText(value, 80);
    expect(shown).toContain(REPLACED);
    for (const point of PLANTED) expect(shown).not.toContain(at(point));
    expect(shown).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('turns other whitespace into one plain space', () => {
    expect(inertText(`Acme${at(0xa0, 0x3000)}\t  Corp`, 80)).toBe('Acme Corp');
    expect(inertText('  Acme\n', 80)).toBe('Acme');
  });

  it('keeps at most two combining marks on a character, so nothing towers over the page', () => {
    const marks = at(0x301, 0x302, 0x303, 0x304, 0x305);
    const shown = inertText(`A${marks.repeat(20)}cme`, 80);
    expect(shown).toBe(`A${at(0x301, 0x302)}cme`);
    // An ordinary accent survives, decomposed or not.
    expect(inertText(`e${at(0x301)}`, 80)).toBe(`e${at(0x301)}`);
  });

  it('cuts to the length asked for, with an ellipsis, counting characters rather than code units', () => {
    expect(inertText('a'.repeat(200), 40)).toHaveLength(40);
    expect(inertText('a'.repeat(200), 40).endsWith(at(0x2026))).toBe(true);
    const emoji = inertText(at(0x1f600).repeat(100), 10);
    expect([...emoji]).toHaveLength(10);
    expect(emoji.startsWith(at(0x1f600))).toBe(true);
    expect(inertText('short', 40)).toBe('short');
  });
});

describe('hasNonAsciiCharacters', () => {
  it('flags an address a reader might misread', () => {
    expect(hasNonAsciiCharacters('alice@example.com')).toBe(false);
    // A Cyrillic "a" in place of the Latin one.
    expect(hasNonAsciiCharacters(`${at(0x430)}lice@example.com`)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { randomBytes } from '../encoding';
import { fromHex, toHex } from './bytes';
import {
  CROCKFORD_ALPHABET,
  deriveRecoveryKey,
  encodeInviteFragment,
  encodeRecoveryCode,
  generateInviteFragment,
  generateRecoveryCode,
  generateRecoveryCodes,
  INVITE_FRAGMENT_DATA_CHARS,
  isValidLuhnMod32,
  luhnMod32,
  normalizeCrockford,
  parseInviteFragment,
  parseRecoveryCode,
  RECOVERY_CODE_BYTES,
  RECOVERY_CODE_DATA_CHARS,
  RecoveryCodeError,
  recoveryLookupHash,
} from './recovery';

/**
 * Every character both implementations must strip from a typed code.
 *
 * The spec says "all hyphens and Unicode whitespace", and the two sides have to
 * mean the same thing by it or a kit that parses in the browser fails in the
 * CLI. The set is Unicode's White_Space property plus U+FEFF, and neither
 * platform's own primitive covers it: JavaScript's `\s` matches U+FEFF but not
 * U+0085, Go's `unicode.IsSpace` matches U+0085 but not U+FEFF. Each side adds
 * the one its primitive misses, which is why this list is mirrored character for
 * character in cli/internal/e2ee/recovery_test.go.
 *
 * U+2007 earns its place by being the one a printed kit is likeliest to carry —
 * a figure space is what a typesetter puts between digit groups — and by being
 * invisible to whoever pastes it.
 */
const UNICODE_SPACES = [
  '\u0009',
  '\u000a',
  '\u000b',
  '\u000c',
  '\u000d',
  '\u0020',
  '\u0085',
  '\u00a0',
  '\u1680',
  '\u2000',
  '\u2001',
  '\u2002',
  '\u2003',
  '\u2004',
  '\u2005',
  '\u2006',
  '\u2007',
  '\u2008',
  '\u2009',
  '\u200a',
  '\u2028',
  '\u2029',
  '\u202f',
  '\u205f',
  '\u3000',
  '\ufeff',
];

describe('the alphabet', () => {
  it('is Crockford base32 without I, L, O, or U', () => {
    expect(CROCKFORD_ALPHABET).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ');
    expect(CROCKFORD_ALPHABET).toHaveLength(32);
    for (const excluded of ['I', 'L', 'O', 'U']) {
      expect(CROCKFORD_ALPHABET).not.toContain(excluded);
    }
  });
});

describe('normalisation', () => {
  it('strips hyphens and whitespace, upper-cases, and aliases I, L, and O', () => {
    expect(normalizeCrockford('abc-def')).toBe('ABCDEF');
    expect(normalizeCrockford(' a b\tc\n')).toBe('ABC');
    expect(normalizeCrockford('iIlLoO')).toBe('111100');
  });

  it('strips every Unicode space a pasted code can carry', () => {
    for (const space of UNICODE_SPACES) {
      expect(normalizeCrockford(`AB${space}CD`)).toBe('ABCD');
      expect(normalizeCrockford(`${space}ab${space}${space}-${space}cd${space}`)).toBe('ABCD');
    }
  });

  it('parses a code whose groups are joined by a figure space, a NEL, or a BOM', () => {
    const code = generateRecoveryCode();

    for (const space of ['\u2007', '\u0085', '\ufeff']) {
      expect(parseRecoveryCode(code.displayForm.replace(/-/gu, space)).displayForm).toBe(
        code.displayForm,
      );
    }
  });

  // U is excluded because it is confusable with V, and Crockford reserves it for
  // a mod-37 check-symbol set this specification does not use. It has no meaning
  // here at all, so it is rejected rather than aliased.
  it('leaves U alone, so it fails as a symbol later', () => {
    expect(normalizeCrockford('u')).toBe('U');
  });
});

describe('Luhn mod 32', () => {
  it('accepts the check character it computes', () => {
    for (let i = 0; i < 50; i += 1) {
      const code = generateRecoveryCode();
      expect(isValidLuhnMod32(code.dataChars + code.checkChar)).toBe(true);
    }
  });

  /** Luhn mod N detects every single-character substitution. */
  it('catches every single-character substitution', () => {
    const code = generateRecoveryCode();
    const full = code.dataChars + code.checkChar;

    for (let position = 0; position < full.length; position += 1) {
      for (const replacement of CROCKFORD_ALPHABET) {
        if (replacement === full[position]) continue;
        const mutated = full.slice(0, position) + replacement + full.slice(position + 1);
        expect(isValidLuhnMod32(mutated)).toBe(false);
      }
    }
  });

  /**
   * "The large majority", not all: mod 32 is not prime, so a transposition of
   * two symbols whose values differ by 16 survives. The claim in the spec is
   * exactly what is asserted here — no more.
   */
  it('catches the large majority of adjacent transpositions', () => {
    const code = generateRecoveryCode();
    const full = code.dataChars + code.checkChar;

    let caught = 0;
    let total = 0;
    for (let i = 0; i < full.length - 1; i += 1) {
      if (full[i] === full[i + 1]) continue;
      total += 1;
      const swapped = full.slice(0, i) + full[i + 1]! + full[i]! + full.slice(i + 2);
      if (!isValidLuhnMod32(swapped)) caught += 1;
    }

    expect(caught).toBeGreaterThan(total * 0.7);
  });

  it('rejects characters outside the alphabet', () => {
    expect(isValidLuhnMod32('UUUU')).toBe(false);
    expect(isValidLuhnMod32('abc')).toBe(false);
  });

  it('refuses to compute over characters outside the alphabet', () => {
    expect(() => luhnMod32('ABCU')).toThrow(RecoveryCodeError);
  });
});

describe('recovery codes', () => {
  it('are 125 bits with the top three bits cleared', () => {
    for (let i = 0; i < 50; i += 1) {
      const { codeBytes } = generateRecoveryCode();
      expect(codeBytes).toHaveLength(RECOVERY_CODE_BYTES);
      expect(codeBytes[0]! & 0xe0).toBe(0);
    }
  });

  it('render as five groups of five plus a check character', () => {
    const code = generateRecoveryCode();

    expect(code.dataChars).toHaveLength(RECOVERY_CODE_DATA_CHARS);
    expect(code.checkChar).toHaveLength(1);
    expect(code.displayForm).toMatch(/^([0-9A-HJKMNP-TV-Z]{5}-){5}[0-9A-HJKMNP-TV-Z]$/);
    expect(code.displayForm).toHaveLength(31);
  });

  it('are unpredictable', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) seen.add(generateRecoveryCode().displayForm);
    expect(seen.size).toBe(200);
  });

  it('issues five at a time', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(5);
    expect(new Set(codes.map((code) => code.displayForm)).size).toBe(5);
  });

  it('round-trips through its display form', () => {
    for (let i = 0; i < 50; i += 1) {
      const code = generateRecoveryCode();
      const parsed = parseRecoveryCode(code.displayForm);

      expect(parsed.codeBytes).toEqual(code.codeBytes);
      expect(parsed.displayForm).toBe(code.displayForm);
    }
  });

  // A small value must be left-padded to 25 characters rather than shortened:
  // the number of characters is part of the format.
  it('left-pads a small value', () => {
    const code = encodeRecoveryCode(fromHex('00000000000000000000000000000001'));

    expect(code.dataChars).toBe('0'.repeat(24) + '1');
    expect(parseRecoveryCode(code.displayForm).codeBytes).toEqual(code.codeBytes);
  });

  it('encodes the largest 125-bit value', () => {
    const code = encodeRecoveryCode(fromHex('1f' + 'ff'.repeat(15)));

    expect(code.dataChars).toBe('Z'.repeat(25));
    expect(parseRecoveryCode(code.displayForm).codeBytes).toEqual(code.codeBytes);
  });

  it('accepts what a human actually types', () => {
    const code = encodeRecoveryCode(fromHex('0102030405060708090a0b0c0d0e0f10'));
    const typed = code.displayForm.replace(/-/g, '').toLowerCase().replace(/0/g, 'o');

    expect(parseRecoveryCode(typed).codeBytes).toEqual(code.codeBytes);
    expect(parseRecoveryCode(`  ${code.displayForm}  `).codeBytes).toEqual(code.codeBytes);
    expect(parseRecoveryCode(code.dataChars + code.checkChar).codeBytes).toEqual(code.codeBytes);
  });

  /**
   * The check character's entire job: "that code has a typo" rather than
   * "invalid recovery code". Distinguishing the two is safe because it is a
   * usability control — a code that passes is still verified by the lookup hash
   * and then by GCM authentication.
   */
  it('reports a typo as a typo', () => {
    const code = generateRecoveryCode();
    const wrongCheck =
      code.dataChars + CROCKFORD_ALPHABET[(CROCKFORD_ALPHABET.indexOf(code.checkChar) + 1) % 32]!;

    try {
      parseRecoveryCode(wrongCheck);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(RecoveryCodeError);
      expect((error as RecoveryCodeError).reason).toBe('checksum');
    }
  });

  it('rejects the wrong length, U, and non-strings as format errors', () => {
    const code = generateRecoveryCode();

    for (const input of [
      '',
      code.dataChars,
      `${code.dataChars + code.checkChar}Z`,
      `U${code.dataChars.slice(1)}${code.checkChar}`,
      undefined as unknown as string,
    ]) {
      try {
        parseRecoveryCode(input);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(RecoveryCodeError);
      }
    }
  });

  it('refuses to encode bytes that are not a 125-bit value', () => {
    expect(() => encodeRecoveryCode(randomBytes(15))).toThrow(TypeError);
    expect(() => encodeRecoveryCode(fromHex('ff' + '00'.repeat(15)))).toThrow(TypeError);
  });
});

describe('lookup hash and RCK', () => {
  const code = generateRecoveryCode();

  it('are deterministic and 32 bytes', async () => {
    expect(await recoveryLookupHash(code.codeBytes)).toHaveLength(32);
    expect(toHex(await recoveryLookupHash(code.codeBytes))).toBe(
      toHex(await recoveryLookupHash(code.codeBytes)),
    );
    expect(await deriveRecoveryKey(code.codeBytes)).toHaveLength(32);
  });

  // The domain-separation prefix ensures the digest can never collide with
  // another SHA-256 use over the same bytes, and the RCK is a different branch
  // again: the server holds the lookup hash and must learn nothing from it.
  it('are different values from each other and from a bare digest', async () => {
    const lookup = toHex(await recoveryLookupHash(code.codeBytes));
    const rck = toHex(await deriveRecoveryKey(code.codeBytes));
    const bare = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', code.codeBytes)));

    expect(new Set([lookup, rck, bare]).size).toBe(3);
  });

  it('separate codes', async () => {
    const other = generateRecoveryCode();
    expect(toHex(await recoveryLookupHash(code.codeBytes))).not.toBe(
      toHex(await recoveryLookupHash(other.codeBytes)),
    );
    expect(toHex(await deriveRecoveryKey(code.codeBytes))).not.toBe(
      toHex(await deriveRecoveryKey(other.codeBytes)),
    );
  });

  it('reject input that is not a code', async () => {
    await expect(recoveryLookupHash(randomBytes(32))).rejects.toThrow(TypeError);
    await expect(deriveRecoveryKey(randomBytes(32))).rejects.toThrow(TypeError);
  });
});

describe('invite key fragments', () => {
  it('carry all 128 bits in 26 characters plus a check', () => {
    const fragment = generateInviteFragment();

    expect(fragment.seed).toHaveLength(16);
    expect(fragment.dataChars).toHaveLength(INVITE_FRAGMENT_DATA_CHARS);
    expect(fragment.displayForm).toMatch(/^([0-9A-HJKMNP-TV-Z]{5}-){5}[0-9A-HJKMNP-TV-Z]{2}$/);
  });

  it('round-trip through the display form and through typed input', () => {
    for (let i = 0; i < 25; i += 1) {
      const fragment = generateInviteFragment();
      expect(parseInviteFragment(fragment.displayForm).seed).toEqual(fragment.seed);
      expect(
        parseInviteFragment(fragment.displayForm.replace(/-/g, '').toLowerCase()).seed,
      ).toEqual(fragment.seed);
    }
  });

  it('use the same check character and the same rejections as a recovery code', () => {
    const fragment = generateInviteFragment();
    const wrongCheck =
      fragment.dataChars +
      CROCKFORD_ALPHABET[(CROCKFORD_ALPHABET.indexOf(fragment.checkChar) + 1) % 32]!;

    expect(() => parseInviteFragment(wrongCheck)).toThrow(RecoveryCodeError);
    expect(() => parseInviteFragment(fragment.dataChars)).toThrow(RecoveryCodeError);
    expect(() => parseInviteFragment(undefined as unknown as string)).toThrow(RecoveryCodeError);
  });

  // 26 base32 characters can carry 130 bits while a seed holds 128. Truncating
  // the extra ones would accept two different strings as one seed.
  it('rejects a string whose leading characters overflow 16 bytes', () => {
    const dataChars = `Z${'0'.repeat(25)}`;
    expect(() => parseInviteFragment(dataChars + luhnMod32(dataChars))).toThrow(RecoveryCodeError);
  });

  it('refuses to encode a seed that is not 16 bytes', () => {
    expect(() => encodeInviteFragment(randomBytes(8))).toThrow(TypeError);
  });
});

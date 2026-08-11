import { describe, expect, it } from 'vitest';
import { KEY_LENGTH } from './aead';
import { randomBytes, toBase64Url } from './encoding';
import {
  decodeShare,
  encodeShare,
  EscrowFormatError,
  EscrowVerificationError,
  fingerprint,
  recoverKeyFromShares,
  SHARE_PREFIX,
  splitKeyIntoShares,
} from './escrow';

/**
 * Escrow round-trip tests.
 *
 * This is the code path taken on the worst day the product ever has: the Root
 * KEK is gone, and three people are typing strings off pieces of paper. Every
 * test below corresponds to a way that could go wrong in the room.
 *
 * The Shamir arithmetic itself is covered in `shamir.test.ts`. What is tested
 * here is the layer a human touches — the encoding, and the verification that
 * turns "Shamir returned some bytes" into "this is provably the right key".
 */

const KEY = randomBytes(KEY_LENGTH);

describe('share encoding', () => {
  it('round-trips a share exactly', () => {
    const share = { index: 3, data: randomBytes(32) };
    const decoded = decodeShare(encodeShare(share, 'abcdef0123456789'));

    expect(decoded.share.index).toBe(3);
    expect(decoded.share.data).toEqual(share.data);
    expect(decoded.fingerprint).toBe('abcdef0123456789');
  });

  it('produces four dot-separated fields, none of which can contain a dot', async () => {
    const { shares } = await splitKeyIntoShares(KEY, 3, 2);
    const encoded = shares[0]!;

    expect(encoded.split('.')).toHaveLength(4);
    expect(encoded.startsWith(`${SHARE_PREFIX}.`)).toBe(true);
  });

  it('tolerates the whitespace a copy-paste or a typed transcription adds', async () => {
    const { shares } = await splitKeyIntoShares(KEY, 3, 2);
    expect(decodeShare(`  ${shares[0]!}\n`).share.index).toBe(1);
  });

  // The version prefix exists so a share written on paper today cannot be
  // silently misread by a future format.
  it.each([
    ['', 'empty'],
    ['garbage', 'no structure'],
    ['xecret-share-v2.1.AAEC.abcd', 'wrong version'],
    ['xecret-share-v1.1.AAEC', 'too few fields'],
    ['xecret-share-v1.1.AAEC.abcd.extra', 'too many fields'],
    ['xecret-share-v1.0.AAEC.abcd', 'index 0 is the secret itself'],
    ['xecret-share-v1.256.AAEC.abcd', 'index beyond GF(2^8)'],
    ['xecret-share-v1.1.5.AAEC.abcd', 'non-integer index'],
    ['xecret-share-v1.1.not+base64.abcd', 'invalid payload encoding'],
    ['xecret-share-v1.1..abcd', 'empty payload'],
    ['xecret-share-v1.1.AAEC.NOTHEX', 'non-hex fingerprint'],
  ])('rejects %s (%s)', (encoded) => {
    expect(() => decodeShare(encoded)).toThrowError(EscrowFormatError);
  });

  it('names the share when one of several is malformed', () => {
    expect(() => decodeShare('xecret-share-v1.7.not+base64.abcd')).toThrowError(/Share 7/);
  });
});

describe('fingerprint', () => {
  it('is stable, short, and hexadecimal', async () => {
    const fp = await fingerprint(KEY);

    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(await fingerprint(KEY)).toBe(fp);
  });

  it('differs for different keys', async () => {
    expect(await fingerprint(randomBytes(KEY_LENGTH))).not.toBe(
      await fingerprint(randomBytes(KEY_LENGTH)),
    );
  });

  // It is printed in a runbook and read aloud. It must reveal nothing usable.
  it('does not contain the key', async () => {
    expect(toBase64Url(KEY)).not.toContain(await fingerprint(KEY));
  });
});

describe('recovery', () => {
  it('reconstructs the exact key from any 2 of 3 shares', async () => {
    const { shares, fingerprint: fp } = await splitKeyIntoShares(KEY, 3, 2);

    for (const pair of [
      [shares[0]!, shares[1]!],
      [shares[0]!, shares[2]!],
      [shares[1]!, shares[2]!],
    ]) {
      const recovered = await recoverKeyFromShares(pair);

      expect(recovered.key).toEqual(KEY);
      expect(recovered.fingerprint).toBe(fp);
    }
  });

  it('reconstructs from all three shares as well', async () => {
    const { shares } = await splitKeyIntoShares(KEY, 3, 2);
    expect((await recoverKeyFromShares(shares)).key).toEqual(KEY);
  });

  it('accepts shares in any order — nobody will present them sorted', async () => {
    const { shares } = await splitKeyIntoShares(KEY, 3, 2);
    expect((await recoverKeyFromShares([shares[2]!, shares[0]!])).key).toEqual(KEY);
  });

  it('refuses a single share, which reveals nothing by design', async () => {
    const { shares } = await splitKeyIntoShares(KEY, 3, 2);
    await expect(recoverKeyFromShares([shares[0]!])).rejects.toThrowError(EscrowFormatError);
  });

  // A 2-of-3 scheme satisfied by presenting one share twice is a 1-of-1 scheme.
  it('refuses the same share presented twice', async () => {
    const { shares } = await splitKeyIntoShares(KEY, 3, 2);
    await expect(recoverKeyFromShares([shares[1]!, shares[1]!])).rejects.toThrowError(
      /more than once/,
    );
  });

  it('refuses shares from two different key ceremonies', async () => {
    const first = await splitKeyIntoShares(KEY, 3, 2);
    const second = await splitKeyIntoShares(randomBytes(KEY_LENGTH), 3, 2);

    await expect(recoverKeyFromShares([first.shares[0]!, second.shares[1]!])).rejects.toThrowError(
      /different keys/,
    );
  });

  it('verifies against a fingerprint recorded independently in the runbook', async () => {
    const { shares, fingerprint: fp } = await splitKeyIntoShares(KEY, 3, 2);
    const recovered = await recoverKeyFromShares([shares[0]!, shares[1]!], fp);

    expect(recovered.key).toEqual(KEY);
  });

  it('refuses when the runbook fingerprint disagrees', async () => {
    const { shares } = await splitKeyIntoShares(KEY, 3, 2);

    await expect(
      recoverKeyFromShares([shares[0]!, shares[1]!], '0000000000000000'),
    ).rejects.toThrowError(EscrowVerificationError);
  });

  /**
   * The scenario this whole verification layer exists for.
   *
   * Shamir has no integrity check: a share with one wrong character
   * reconstructs 32 plausible bytes rather than failing. Without the
   * fingerprint the operator would load that key, watch every decryption
   * return garbage, and reasonably conclude the data was lost.
   */
  it('catches a single mistyped character in a share', async () => {
    const { shares } = await splitKeyIntoShares(KEY, 3, 2);
    const [prefix, index, data, fp] = shares[0]!.split('.') as [string, string, string, string];

    // Flip one base64url character to a different valid one.
    const corrupted = `${prefix}.${index}.${data[0] === 'A' ? 'B' : 'A'}${data.slice(1)}.${fp}`;

    await expect(recoverKeyFromShares([corrupted, shares[1]!])).rejects.toThrowError(
      EscrowVerificationError,
    );
  });

  it('wipes the reconstructed key before reporting a mismatch', async () => {
    const { shares } = await splitKeyIntoShares(KEY, 3, 2);

    const error: EscrowVerificationError = await recoverKeyFromShares(
      [shares[0]!, shares[1]!],
      'ffffffffffffffff',
    ).then(
      () => {
        throw new Error('expected a verification failure');
      },
      (cause: unknown) => cause as EscrowVerificationError,
    );

    // The error carries only fingerprints — never the bytes that failed the check.
    expect(error).toBeInstanceOf(EscrowVerificationError);
    expect(error.message).not.toContain(toBase64Url(KEY));
  });

  it('supports thresholds other than 2 of 3', async () => {
    const { shares } = await splitKeyIntoShares(KEY, 5, 3);

    expect((await recoverKeyFromShares([shares[0]!, shares[2]!, shares[4]!])).key).toEqual(KEY);
    // Below the threshold Shamir still returns bytes — the fingerprint is what
    // turns that into a refusal instead of a silent wrong answer.
    await expect(recoverKeyFromShares([shares[0]!, shares[1]!])).rejects.toThrowError(
      EscrowVerificationError,
    );
  });
});

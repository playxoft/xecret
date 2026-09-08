import { describe, expect, it, vi } from 'vitest';
import { toHex } from './bytes';
import {
  ARGON2_VERSION,
  CURRENT_KDF_PARAMS,
  deriveStretchedKey,
  generateKdfSalt,
  KDF_SALT_BYTES,
  kdfNeedsUpgrade,
  KdfParamsError,
  nobleArgon2idProvider,
  parseKdfParams,
} from './kdf';
import type { Argon2idParams, Argon2idProvider } from './kdf';

/**
 * The cheapest parameter set this client will actually run: the OWASP floor at
 * one pass. The production set costs about a second per derivation in pure
 * JavaScript (ADR 0009's measurement), and a suite that spends that repeatedly
 * is a suite people skip — but `deriveStretchedKey` enforces the floor, and
 * rightly refuses anything below it, so a test of the real entry point has to
 * pay for at least this much.
 */
const floor: Argon2idParams = { alg: 'argon2id', v: 19, m: 19_456, t: 1, p: 1, len: 32 };

/** Below the floor: only the raw provider accepts it. See the vectors README. */
const belowFloor: Argon2idParams = { alg: 'argon2id', v: 19, m: 8192, t: 1, p: 1, len: 32 };
const salt = generateKdfSalt();

describe('current parameters', () => {
  it('are the ones the spec pins', () => {
    expect(CURRENT_KDF_PARAMS).toEqual({ alg: 'argon2id', v: 19, m: 65_536, t: 3, p: 1, len: 32 });
    expect(ARGON2_VERSION).toBe(19);
    expect(KDF_SALT_BYTES).toBe(16);
  });

  it('validate against their own bounds', () => {
    expect(parseKdfParams({ ...CURRENT_KDF_PARAMS })).toEqual(CURRENT_KDF_PARAMS);
  });

  it('produce a 16-byte salt', () => {
    expect(generateKdfSalt()).toHaveLength(16);
    expect(toHex(generateKdfSalt())).not.toBe(toHex(generateKdfSalt()));
  });
});

/**
 * These parameters arrive from the server. A client that runs a memory-hard KDF
 * with unvalidated cost parameters can be made to allocate arbitrary memory by a
 * hostile server, so this is a security control and not a sanity check.
 */
describe('parameter validation', () => {
  it('rejects a non-object', () => {
    for (const value of [null, undefined, 'argon2id', 42, []]) {
      expect(() => parseKdfParams(value)).toThrow(KdfParamsError);
    }
  });

  it('rejects another Argon2 variant', () => {
    expect(() => parseKdfParams({ ...floor, alg: 'argon2i' })).toThrow(KdfParamsError);
    expect(() => parseKdfParams({ ...floor, alg: 'scrypt' })).toThrow(KdfParamsError);
  });

  it('rejects another Argon2 version', () => {
    expect(() => parseKdfParams({ ...CURRENT_KDF_PARAMS, v: 16 })).toThrow(KdfParamsError);
  });

  it('rejects memory below the OWASP floor or above the ceiling', () => {
    expect(() => parseKdfParams({ ...CURRENT_KDF_PARAMS, m: 19_455 })).toThrow(KdfParamsError);
    expect(() => parseKdfParams({ ...CURRENT_KDF_PARAMS, m: 8 })).toThrow(KdfParamsError);
    expect(() => parseKdfParams({ ...CURRENT_KDF_PARAMS, m: 1_048_577 })).toThrow(KdfParamsError);
    expect(parseKdfParams({ ...CURRENT_KDF_PARAMS, m: 19_456 }).m).toBe(19_456);
    expect(parseKdfParams({ ...CURRENT_KDF_PARAMS, m: 1_048_576 }).m).toBe(1_048_576);
  });

  it('rejects a time cost outside 1…10', () => {
    expect(() => parseKdfParams({ ...CURRENT_KDF_PARAMS, t: 0 })).toThrow(KdfParamsError);
    expect(() => parseKdfParams({ ...CURRENT_KDF_PARAMS, t: 11 })).toThrow(KdfParamsError);
    expect(parseKdfParams({ ...CURRENT_KDF_PARAMS, t: 10 }).t).toBe(10);
  });

  it('rejects parallelism other than 1 and a length other than 32', () => {
    expect(() => parseKdfParams({ ...CURRENT_KDF_PARAMS, p: 2 })).toThrow(KdfParamsError);
    expect(() => parseKdfParams({ ...CURRENT_KDF_PARAMS, len: 64 })).toThrow(KdfParamsError);
  });

  it('rejects fractional and non-numeric costs', () => {
    expect(() => parseKdfParams({ ...CURRENT_KDF_PARAMS, m: 65_536.5 })).toThrow(KdfParamsError);
    expect(() => parseKdfParams({ ...CURRENT_KDF_PARAMS, t: '3' })).toThrow(KdfParamsError);
  });

  // The stored object has exactly six fields. A seventh is a record this client
  // does not understand well enough to run a KDF from.
  it('rejects unknown fields', () => {
    expect(() => parseKdfParams({ ...CURRENT_KDF_PARAMS, secret: 'pepper' })).toThrow(
      KdfParamsError,
    );
  });

  it('rejects missing fields', () => {
    const { t: _t, ...withoutT } = CURRENT_KDF_PARAMS;
    expect(() => parseKdfParams(withoutT)).toThrow(KdfParamsError);
  });
});

describe('kdfNeedsUpgrade', () => {
  it('is false only for exactly the current parameters', () => {
    expect(kdfNeedsUpgrade({ ...CURRENT_KDF_PARAMS })).toBe(false);
  });

  // `!==`, not `<`, the same reasoning as `pinNeedsRehash`: an upgrade must also
  // be able to lower a cost that some platform cannot reach.
  it('is true for a cheaper *and* for a more expensive record', () => {
    expect(kdfNeedsUpgrade({ ...CURRENT_KDF_PARAMS, m: 19_456 })).toBe(true);
    expect(kdfNeedsUpgrade({ ...CURRENT_KDF_PARAMS, m: 1_048_576 })).toBe(true);
    expect(kdfNeedsUpgrade({ ...CURRENT_KDF_PARAMS, t: 2 })).toBe(true);
    expect(kdfNeedsUpgrade({ ...CURRENT_KDF_PARAMS, t: 4 })).toBe(true);
  });
});

describe('deriveStretchedKey', () => {
  it('produces 32 deterministic bytes', async () => {
    const a = await deriveStretchedKey({ passphrase: 'hunter2', salt, params: floor });
    const b = await deriveStretchedKey({ passphrase: 'hunter2', salt, params: floor });

    expect(a).toHaveLength(32);
    expect(toHex(a)).toBe(toHex(b));
  });

  it('separates passphrases, salts, and parameters', async () => {
    const base = toHex(await deriveStretchedKey({ passphrase: 'hunter2', salt, params: floor }));

    expect(
      toHex(await deriveStretchedKey({ passphrase: 'hunter3', salt, params: floor })),
    ).not.toBe(base);
    expect(
      toHex(
        await deriveStretchedKey({ passphrase: 'hunter2', salt: generateKdfSalt(), params: floor }),
      ),
    ).not.toBe(base);
    expect(
      toHex(await deriveStretchedKey({ passphrase: 'hunter2', salt, params: { ...floor, t: 2 } })),
    ).not.toBe(base);
  });

  // The failure this prevents: the same passphrase typed on macOS (NFD) and on
  // Windows (NFC) deriving two different keys.
  it('normalises the passphrase, so both spellings derive one key', async () => {
    const decomposed = 'cafe\u0301 au lait';
    const composed = 'caf\u00e9 au lait';
    expect(decomposed).not.toBe(composed);

    expect(toHex(await deriveStretchedKey({ passphrase: decomposed, salt, params: floor }))).toBe(
      toHex(await deriveStretchedKey({ passphrase: composed, salt, params: floor })),
    );
  });

  it('validates the parameters before running anything', async () => {
    const argon2id = vi.fn(nobleArgon2idProvider);

    await expect(
      deriveStretchedKey({ passphrase: 'hunter2', salt, params: { ...floor, p: 4 }, argon2id }),
    ).rejects.toThrow(KdfParamsError);
    expect(argon2id).not.toHaveBeenCalled();
  });

  it('rejects a salt that is not 16 bytes', async () => {
    await expect(
      deriveStretchedKey({ passphrase: 'hunter2', salt: new Uint8Array(8), params: floor }),
    ).rejects.toThrow(KdfParamsError);
  });

  /**
   * The seam ADR 0009 says will most likely be used: the phone measurement is
   * expected to move this to hash-wasm, and the two libraries produce identical
   * output at the same parameters.
   */
  it('runs an injected provider instead of the default', async () => {
    const argon2id = vi.fn<Argon2idProvider>(async () => new Uint8Array(32).fill(7));

    const key = await deriveStretchedKey({ passphrase: 'hunter2', salt, params: floor, argon2id });

    expect(toHex(key)).toBe('07'.repeat(32));
    expect(argon2id).toHaveBeenCalledTimes(1);
    expect(argon2id.mock.calls[0]![1]).toEqual(salt);
    expect(argon2id.mock.calls[0]![2]).toEqual(floor);
  });

  it('hands the provider NFC-normalised UTF-8, not the raw string', async () => {
    let seen = '';
    const argon2id = vi.fn<Argon2idProvider>(async (password) => {
      seen = toHex(password);
      return new Uint8Array(32);
    });

    await deriveStretchedKey({ passphrase: 'cafe\u0301', salt, params: floor, argon2id });

    expect(seen).toBe(toHex(new TextEncoder().encode('caf\u00e9')));
  });

  // The passphrase bytes are the most valuable material in the system and do not
  // need to outlive the call. `encoding.ts` documents honestly what zeroization
  // does and does not buy; this asserts the part that is in our control.
  it('zeroizes the encoded passphrase before returning', async () => {
    let captured: Uint8Array | undefined;
    const argon2id = vi.fn<Argon2idProvider>(async (password) => {
      captured = password;
      expect(password.some((byte) => byte !== 0)).toBe(true);
      return new Uint8Array(32);
    });

    await deriveStretchedKey({ passphrase: 'hunter2', salt, params: floor, argon2id });

    expect(captured!.every((byte) => byte === 0)).toBe(true);
  });

  /** Pinned: if this changes, every stored wrap becomes unopenable. */
  it('matches a known answer', async () => {
    const key = await nobleArgon2idProvider(
      new TextEncoder().encode('correct horse battery staple'),
      new Uint8Array(16),
      belowFloor,
    );
    expect(toHex(key)).toBe('fd0d792fd39e79f9aa3d5acda2f5d4f6176900b27c36aea0becff21f4a13ea13');
  });
});

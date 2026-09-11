import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../../ids/uuid-v7';
import { randomBytes } from '../encoding';
import { DecryptionError } from '../types';
import type { Bytes } from '../types';
import { BlobFormatError, parseGcmBlob } from './blob';
import { toHex } from './bytes';
import { HKDF_INFO, isRegisteredInfo } from './hkdf';
import { DEVICE_PIN_KDF_PARAMS } from './kdf';
import type { Argon2idProvider } from './kdf';
import {
  DEVICE_PIN_LENGTH,
  DEVICE_PIN_PEPPER_BYTES,
  derivePinKey,
  derivePinVerifier,
  derivePinWrapKey,
  generatePinPepper,
  isDevicePin,
  unwrapUserKeyWithPin,
  wrapUserKeyWithPin,
} from './pin-wrap';
import { generateUserKey } from './wraps';

/**
 * The device PIN, at the byte level.
 *
 * ── What these prove ──
 * That the two halves of the wrap key are genuinely both required, that the
 * verifier branch is a sibling of the wrap branch rather than a parent of it,
 * and that the AAD binds a wrap to one account *and* one browser. Everything
 * except the Argon2id stretch runs for real — real HKDF, real AES-GCM, real blob
 * parsing — because those are the parts where a mistake is silent.
 *
 * ── The stretch is stubbed, and that is not a gap ──
 * Argon2id's contribution here is cost, not structure: it is tested in
 * `kdf.test.ts` and its parameters are asserted below. Paying a real derivation
 * per assertion would buy nothing and make this file too slow to run often.
 */

const userId = uuidv7();
const deviceId = uuidv7();
const otherUserId = uuidv7();
const otherDeviceId = uuidv7();

/**
 * A stand-in for Argon2id: fast, deterministic, and dependent on every input.
 *
 * Not a hash of any cryptographic worth, and it does not need to be. What the
 * tests need from it is that a different PIN or a different salt produces
 * different bytes, which is exactly the property that makes the assertions below
 * mean what they say.
 */
const stubArgon2id: Argon2idProvider = (password, salt, params) => {
  const out = new Uint8Array(params.len);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = (password[i % password.length]! * 31 + salt[i % salt.length]! * 17 + i) % 256;
  }
  return Promise.resolve(out);
};

const salt = randomBytes(16);

function pinKeyFor(pin: string, withSalt: Bytes = salt): Promise<Bytes> {
  return derivePinKey({ pin, salt: withSalt, argon2id: stubArgon2id });
}

describe('what counts as a device PIN', () => {
  it('takes exactly six ASCII digits', () => {
    expect(DEVICE_PIN_LENGTH).toBe(6);
    expect(isDevicePin('012345')).toBe(true);

    for (const candidate of ['12345', '1234567', '', '12345a', '12 345', '  1234']) {
      expect(isDevicePin(candidate), candidate).toBe(false);
    }
  });

  it('refuses non-ASCII digits rather than normalising them', () => {
    // `\d` in a Unicode-aware context also matches these. A PIN typed on one
    // keyboard and re-typed on another would derive a different key, and the
    // failure would read as a forgotten PIN rather than as an encoding
    // difference.
    expect(isDevicePin('١٢٣٤٥٦')).toBe(false);
    expect(isDevicePin('１２３４５６')).toBe(false);
  });

  it('refuses to derive anything from a malformed PIN', async () => {
    await expect(pinKeyFor('12345')).rejects.toThrow(TypeError);
  });
});

describe('the two branches of a PIN key', () => {
  it('stretches at the light preset, not the passphrase cost', async () => {
    // The parameters are the honest answer to a credential that cannot be made
    // strong by cost: 10^6 candidates is enumerable at any price, so the budget
    // goes on the pepper and the attempt counter instead.
    let seen: unknown = null;
    await derivePinKey({
      pin: '123456',
      salt,
      argon2id: (password, usedSalt, params) => {
        seen = params;
        return stubArgon2id(password, usedSalt, params);
      },
    });

    expect(seen).toEqual(DEVICE_PIN_KDF_PARAMS);
    expect(DEVICE_PIN_KDF_PARAMS.m).toBe(19_456);
    expect(DEVICE_PIN_KDF_PARAMS.t).toBe(2);
  });

  it('makes the verifier a sibling of the wrap key, not a parent', async () => {
    // The verifier is handed to the server, which also holds the pepper. If the
    // wrap key were derivable from it, the server would hold both halves of
    // every wrap key on its own.
    const pinKey = await pinKeyFor('123456');
    const pepper = generatePinPepper();

    const verifier = await derivePinVerifier(pinKey);
    const wrapKey = await derivePinWrapKey(pinKey, pepper);

    expect(toHex(verifier)).not.toBe(toHex(wrapKey));
    expect(toHex(verifier)).not.toBe(toHex(pinKey));
    expect(toHex(wrapKey)).not.toBe(toHex(pinKey));
  });

  it('registers both info strings, so neither can be a typo', async () => {
    expect(HKDF_INFO.pinVerifier).toBe('xecret.v2.pin-verifier');
    expect(HKDF_INFO.pinWrap).toBe('xecret.v2.pin-wrap');
    expect(isRegisteredInfo(HKDF_INFO.pinVerifier)).toBe(true);
    expect(isRegisteredInfo(HKDF_INFO.pinWrap)).toBe(true);
  });

  it('holds the pepper to its length, in both directions', async () => {
    const pinKey = await pinKeyFor('123456');

    expect(DEVICE_PIN_PEPPER_BYTES).toBe(32);
    await expect(derivePinWrapKey(pinKey, randomBytes(31))).rejects.toThrow(TypeError);
    await expect(derivePinWrapKey(pinKey, randomBytes(33))).rejects.toThrow(TypeError);
    // A truncated pepper would be a wrap key with less entropy than the design
    // claims, and the failure would show up as a successful enrolment.
    await expect(derivePinWrapKey(randomBytes(31), generatePinPepper())).rejects.toThrow(TypeError);
  });

  it('mixes the pepper in, so the same PIN on two enrolments is two keys', async () => {
    const pinKey = await pinKeyFor('123456');

    expect(toHex(await derivePinWrapKey(pinKey, generatePinPepper()))).not.toBe(
      toHex(await derivePinWrapKey(pinKey, generatePinPepper())),
    );
  });
});

describe('wrapping the User Key under a PIN', () => {
  const context = { userId, deviceId };

  async function wrapFor(pin: string, pepper: Bytes, userKey: Bytes) {
    return wrapUserKeyWithPin({ pinKey: await pinKeyFor(pin), pepper, userKey, context });
  }

  it('round-trips the User Key', async () => {
    const userKey = generateUserKey();
    const pepper = generatePinPepper();
    const blob = await wrapFor('123456', pepper, userKey);

    const opened = await unwrapUserKeyWithPin({
      pinKey: await pinKeyFor('123456'),
      pepper,
      blob,
      context,
    });

    expect(toHex(opened)).toBe(toHex(userKey));
  });

  it('produces a versioned xk2.gcm blob and nothing looser', async () => {
    const blob = await wrapFor('123456', generatePinPepper(), generateUserKey());

    expect(blob.startsWith('xk2.gcm.')).toBe(true);
    // iv(12) ‖ ciphertext(32) ‖ tag(16).
    expect(parseGcmBlob(blob).iv).toHaveLength(12);
    expect(parseGcmBlob(blob).ciphertext).toHaveLength(48);
  });

  it('refuses a blob of another version or construction, rather than guessing', async () => {
    const pinKey = await pinKeyFor('123456');
    const pepper = generatePinPepper();

    for (const blob of [
      'xk1.gcm.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'xk2.x25519.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'xk2.gcm.',
      'not-a-blob',
    ]) {
      await expect(
        unwrapUserKeyWithPin({ pinKey, pepper, blob, context }),
        blob,
      ).rejects.toBeInstanceOf(BlobFormatError);
    }
  });

  it('refuses the wrong PIN', async () => {
    const pepper = generatePinPepper();
    const blob = await wrapFor('123456', pepper, generateUserKey());

    await expect(
      unwrapUserKeyWithPin({ pinKey: await pinKeyFor('123457'), pepper, blob, context }),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it('refuses the wrong pepper — which is what makes the wrap safe at rest', async () => {
    // The whole argument for storing this blob in `localStorage`: whoever copies
    // the browser profile holds a ciphertext with nothing to attack, because the
    // other half of its key is a row on a server behind an attempt counter.
    const blob = await wrapFor('123456', generatePinPepper(), generateUserKey());

    await expect(
      unwrapUserKeyWithPin({
        pinKey: await pinKeyFor('123456'),
        pepper: generatePinPepper(),
        blob,
        context,
      }),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it('refuses a wrap presented for another account or another browser', async () => {
    // The AAD binding. `userId` stops a wrap opening as somebody else's;
    // `deviceId` stops one being copied between two enrolments of the *same*
    // account, where the PIN may well be identical.
    const pinKey = await pinKeyFor('123456');
    const pepper = generatePinPepper();
    const blob = await wrapUserKeyWithPin({
      pinKey,
      pepper,
      userKey: generateUserKey(),
      context,
    });

    for (const tampered of [
      { userId: otherUserId, deviceId },
      { userId, deviceId: otherDeviceId },
      { userId: otherUserId, deviceId: otherDeviceId },
    ]) {
      await expect(
        unwrapUserKeyWithPin({ pinKey, pepper, blob, context: tampered }),
        JSON.stringify(tampered),
      ).rejects.toBeInstanceOf(DecryptionError);
    }
  });

  it('refuses to wrap anything that is not a 32-byte User Key', async () => {
    await expect(wrapFor('123456', generatePinPepper(), randomBytes(16))).rejects.toThrow(
      TypeError,
    );
  });

  it('binds a salt per browser, so one PIN on two devices is two keys', async () => {
    const userKey = generateUserKey();
    const pepper = generatePinPepper();

    const blob = await wrapUserKeyWithPin({
      pinKey: await pinKeyFor('123456'),
      pepper,
      userKey,
      context,
    });

    await expect(
      unwrapUserKeyWithPin({
        pinKey: await pinKeyFor('123456', randomBytes(16)),
        pepper,
        blob,
        context,
      }),
    ).rejects.toBeInstanceOf(DecryptionError);
  });
});

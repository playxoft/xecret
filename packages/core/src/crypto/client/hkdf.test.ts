import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../../ids/uuid-v7';
import { edkGrantAad } from '../aad';
import { randomBytes } from '../encoding';
import { toHex } from './bytes';
import { deriveKey, HKDF_INFO, HKDF_OUTPUT_BYTES, isRegisteredInfo } from './hkdf';

const ikm = randomBytes(32);

describe('the info registry', () => {
  // The table in spec §3.3 is exhaustive. Adding a string is a spec change, and
  // this test is what makes that true rather than aspirational.
  it('holds exactly the six fixed info strings', () => {
    expect(Object.values(HKDF_INFO).sort()).toEqual(
      [
        'xecret.v2.invite-key',
        'xecret.v2.prf-wrap',
        'xecret.v2.recovery-wrap',
        'xecret.v2.uk-wrap',
        'xecret.v2.unlock-verifier',
        'xecret.v2.value-hmac',
      ].sort(),
    );
  });

  it('also accepts a v2 AAD, which is what a sealed box derives under', () => {
    const aad = edkGrantAad({
      environmentId: uuidv7(),
      edkVersion: 1,
      recipientKind: 'member',
      recipientId: uuidv7(),
    });
    expect(isRegisteredInfo(aad)).toBe(true);
  });

  it('rejects everything else', () => {
    for (const info of [
      '',
      'xecret.v2.uk-wrap ',
      'xecret.v2.ukwrap',
      'xecret.v1.uk-wrap',
      'xecret.hkdf.v1.value-hmac|abc',
      'uk-wrap',
    ]) {
      expect(isRegisteredInfo(info)).toBe(false);
    }
  });

  // A typo in an info string does not fail loudly on its own: it derives a
  // different, perfectly valid-looking key, and the failure surfaces later as an
  // undecryptable blob.
  it('refuses to derive under an unregistered string', async () => {
    await expect(deriveKey({ ikm, info: 'xecret.v2.uk-wrapp' })).rejects.toThrow(TypeError);
    await expect(deriveKey({ ikm, info: '' })).rejects.toThrow(TypeError);
  });
});

describe('deriveKey', () => {
  it('produces 32 bytes', async () => {
    expect(await deriveKey({ ikm, info: HKDF_INFO.ukWrap })).toHaveLength(HKDF_OUTPUT_BYTES);
  });

  it('is deterministic', async () => {
    const a = await deriveKey({ ikm, info: HKDF_INFO.ukWrap });
    const b = await deriveKey({ ikm, info: HKDF_INFO.ukWrap });
    expect(toHex(a)).toBe(toHex(b));
  });

  // The property the whole hierarchy rests on: the verifier is handed to the
  // server, and it must reveal nothing about the wrap key derived beside it.
  it('separates branches — one info string reveals nothing about another', async () => {
    const derived = await Promise.all(
      Object.values(HKDF_INFO).map(async (info) => toHex(await deriveKey({ ikm, info }))),
    );
    expect(new Set(derived).size).toBe(derived.length);
  });

  it('separates inputs', async () => {
    const a = await deriveKey({ ikm, info: HKDF_INFO.ukWrap });
    const b = await deriveKey({ ikm: randomBytes(32), info: HKDF_INFO.ukWrap });
    expect(toHex(a)).not.toBe(toHex(b));
  });

  it('separates salts', async () => {
    const none = await deriveKey({ ikm, info: HKDF_INFO.ukWrap });
    const salted = await deriveKey({ ikm, info: HKDF_INFO.ukWrap, salt: randomBytes(64) });
    expect(toHex(none)).not.toBe(toHex(salted));
  });

  it('treats an omitted salt as an empty one', async () => {
    const omitted = await deriveKey({ ikm, info: HKDF_INFO.ukWrap });
    const empty = await deriveKey({ ikm, info: HKDF_INFO.ukWrap, salt: new Uint8Array(0) });
    expect(toHex(omitted)).toBe(toHex(empty));
  });

  it('rejects empty input keying material', async () => {
    await expect(deriveKey({ ikm: new Uint8Array(0), info: HKDF_INFO.ukWrap })).rejects.toThrow(
      TypeError,
    );
  });

  /**
   * A second, independent HKDF.
   *
   * Web Crypto and `@noble/hashes` are two implementations of RFC 5869, and the
   * Go side will be a third. If this module ever wired the salt and the info the
   * wrong way round — the classic HKDF mistake, and one that is invisible while
   * only one implementation is looking — the two would disagree here.
   */
  it('agrees with @noble/hashes for the same inputs', async () => {
    const { hkdf } = await import('@noble/hashes/hkdf.js');
    const { sha256 } = await import('@noble/hashes/sha2.js');

    const salt = randomBytes(64);
    const info = new TextEncoder().encode(HKDF_INFO.valueHmac);

    expect(toHex(await deriveKey({ ikm, info: HKDF_INFO.valueHmac, salt }))).toBe(
      toHex(new Uint8Array(hkdf(sha256, ikm, salt, info, 32))),
    );
  });
});

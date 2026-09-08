import { describe, expect, it } from 'vitest';
import { randomBytes, toBase64Url } from '../encoding';
import { toHex } from './bytes';
import {
  decodePublicKey,
  deriveInviteKeyPair,
  encodePublicKey,
  encryptionPublicKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  PRIVATE_KEY_BYTES,
  PUBLIC_KEY_BYTES,
  SIGNATURE_BYTES,
  signingPublicKey,
} from './keypair';

describe('sizes', () => {
  it('are the ones the spec pins', () => {
    expect(PUBLIC_KEY_BYTES).toBe(32);
    expect(PRIVATE_KEY_BYTES).toBe(32);
    expect(SIGNATURE_BYTES).toBe(64);
  });
});

describe('key generation', () => {
  it('produces 32-byte halves for both curves', () => {
    for (const pair of [generateEncryptionKeyPair(), generateSigningKeyPair()]) {
      expect(pair.privateKey).toHaveLength(32);
      expect(pair.publicKey).toHaveLength(32);
    }
  });

  it('never repeats', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) seen.add(toHex(generateEncryptionKeyPair().privateKey));
    expect(seen.size).toBe(100);
  });

  it('derives a public key deterministically from a private one', () => {
    const pair = generateEncryptionKeyPair();
    expect(toHex(encryptionPublicKey(pair.privateKey))).toBe(toHex(pair.publicKey));

    const signing = generateSigningKeyPair();
    expect(toHex(signingPublicKey(signing.privateKey))).toBe(toHex(signing.publicKey));
  });

  // The two curves take the same 32 bytes and mean different things by them.
  // Confusing the two is a real class of bug, so this pins that they differ.
  it('derives different public keys from the same 32 bytes on each curve', () => {
    const material = randomBytes(32);
    expect(toHex(encryptionPublicKey(material))).not.toBe(toHex(signingPublicKey(material)));
  });

  it('rejects private material of the wrong length', () => {
    expect(() => encryptionPublicKey(randomBytes(31))).toThrow(TypeError);
    expect(() => signingPublicKey(randomBytes(33))).toThrow(TypeError);
  });
});

describe('public key transport encoding', () => {
  it('round-trips', () => {
    const { publicKey } = generateEncryptionKeyPair();
    expect(decodePublicKey(encodePublicKey(publicKey))).toEqual(publicKey);
  });

  it('is unpadded base64url', () => {
    const encoded = encodePublicKey(generateEncryptionKeyPair().publicKey);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).toHaveLength(43);
  });

  it('rejects a key that is not exactly 32 bytes', () => {
    expect(() => encodePublicKey(randomBytes(31))).toThrow(TypeError);
    expect(() => decodePublicKey(toBase64Url(randomBytes(31)))).toThrow(TypeError);
    expect(() => decodePublicKey(toBase64Url(randomBytes(33)))).toThrow(TypeError);
  });

  it('rejects anything that is not base64url', () => {
    expect(() => decodePublicKey('not base64url!')).toThrow(TypeError);
    expect(() => decodePublicKey(`${toBase64Url(randomBytes(32))}=`)).toThrow(TypeError);
  });
});

describe('invite keypair derivation', () => {
  const seed = randomBytes(16);

  it('is deterministic — the invitee re-derives what the inviter sealed to', async () => {
    const a = await deriveInviteKeyPair(seed);
    const b = await deriveInviteKeyPair(seed);

    expect(toHex(a.privateKey)).toBe(toHex(b.privateKey));
    expect(toHex(a.publicKey)).toBe(toHex(b.publicKey));
  });

  it('separates seeds', async () => {
    const a = await deriveInviteKeyPair(seed);
    const b = await deriveInviteKeyPair(randomBytes(16));
    expect(toHex(a.publicKey)).not.toBe(toHex(b.publicKey));
  });

  it('produces a usable X25519 pair', async () => {
    const pair = await deriveInviteKeyPair(seed);
    expect(toHex(encryptionPublicKey(pair.privateKey))).toBe(toHex(pair.publicKey));
  });

  it('rejects a seed that is not 16 bytes', async () => {
    await expect(deriveInviteKeyPair(randomBytes(32))).rejects.toThrow(TypeError);
  });
});

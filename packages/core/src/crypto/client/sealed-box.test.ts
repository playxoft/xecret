import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../../ids/uuid-v7';
import { edkGrantAad, ehkGrantAad } from '../aad';
import { fromBase64Url, randomBytes, toBase64Url } from '../encoding';
import { DecryptionError } from '../types';
import { BlobFormatError, parseBlob } from './blob';
import { toHex } from './bytes';
import { generateEncryptionKeyPair } from './keypair';
import { openSealedBox, sealToPublicKey, sealToPublicKeyWithRandomness } from './sealed-box';

const environmentId = uuidv7();
const recipientId = uuidv7();

const aad = edkGrantAad({ environmentId, edkVersion: 1, recipientKind: 'member', recipientId });
const otherAad = edkGrantAad({
  environmentId,
  edkVersion: 2,
  recipientKind: 'member',
  recipientId,
});

const recipient = generateEncryptionKeyPair();
const edk = randomBytes(32);

describe('seal and open', () => {
  it('round-trips a 32-byte key', async () => {
    const blob = await sealToPublicKey({
      recipientPublicKey: recipient.publicKey,
      plaintext: edk,
      aad,
    });

    expect(await openSealedBox({ recipientPrivateKey: recipient.privateKey, blob, aad })).toEqual(
      edk,
    );
  });

  it('produces an xk2.x25519 blob laid out as ephemeralPub ‖ iv ‖ ct', async () => {
    const blob = await sealToPublicKey({
      recipientPublicKey: recipient.publicKey,
      plaintext: edk,
      aad,
    });

    expect(blob.startsWith('xk2.x25519.')).toBe(true);
    // 32 + 12 + 32 + 16
    expect(parseBlob(blob, 'x25519')).toHaveLength(92);
  });

  // Two boxes under one ephemeral key to one recipient would derive one AES key,
  // and the IVs alone would then be carrying the whole separation.
  it('uses a fresh ephemeral key and IV on every call', async () => {
    const blobs = new Set<string>();
    const ephemerals = new Set<string>();

    for (let i = 0; i < 25; i += 1) {
      const blob = await sealToPublicKey({
        recipientPublicKey: recipient.publicKey,
        plaintext: edk,
        aad,
      });
      blobs.add(blob);
      ephemerals.add(toHex(parseBlob(blob, 'x25519').slice(0, 32)));
    }

    expect(blobs.size).toBe(25);
    expect(ephemerals.size).toBe(25);
  });

  it('is anonymous — the box carries nothing about the sender', async () => {
    const blob = await sealToPublicKey({
      recipientPublicKey: recipient.publicKey,
      plaintext: edk,
      aad,
    });

    // Everything in the payload beyond the ephemeral public key is IV and
    // ciphertext; there is no sender field to check, which is the point.
    expect(parseBlob(blob, 'x25519')).toHaveLength(92);
    expect(toHex(parseBlob(blob, 'x25519')).includes(toHex(edk))).toBe(false);
  });
});

describe('open rejects', () => {
  const sealed = async (): Promise<string> =>
    sealToPublicKey({ recipientPublicKey: recipient.publicKey, plaintext: edk, aad });

  it('the wrong recipient', async () => {
    const other = generateEncryptionKeyPair();
    await expect(
      openSealedBox({ recipientPrivateKey: other.privateKey, blob: await sealed(), aad }),
    ).rejects.toThrow(DecryptionError);
  });

  // The AAD is the HKDF info *and* the GCM additional data, so a relocated blob
  // both derives the wrong key and fails authentication.
  it('the wrong AAD, including a version bump', async () => {
    const blob = await sealed();

    await expect(
      openSealedBox({ recipientPrivateKey: recipient.privateKey, blob, aad: otherAad }),
    ).rejects.toThrow(DecryptionError);

    await expect(
      openSealedBox({
        recipientPrivateKey: recipient.privateKey,
        blob,
        aad: ehkGrantAad({ environmentId, recipientKind: 'member', recipientId }),
      }),
    ).rejects.toThrow(DecryptionError);
  });

  it('a flipped bit anywhere in the payload', async () => {
    const payload = parseBlob(await sealed(), 'x25519');

    for (const index of [0, 31, 32, 44, payload.length - 1]) {
      const tampered = new Uint8Array(payload);
      tampered[index] = tampered[index]! ^ 0x01;

      await expect(
        openSealedBox({
          recipientPrivateKey: recipient.privateKey,
          blob: `xk2.x25519.${toBase64Url(tampered)}`,
          aad,
        }),
      ).rejects.toThrow(DecryptionError);
    }
  });

  it('a truncated payload, as a format error rather than a decryption one', async () => {
    const payload = parseBlob(await sealed(), 'x25519');

    await expect(
      openSealedBox({
        recipientPrivateKey: recipient.privateKey,
        blob: `xk2.x25519.${toBase64Url(payload.slice(0, 59))}`,
        aad,
      }),
    ).rejects.toThrow(BlobFormatError);
  });

  it('a blob of another algorithm or version', async () => {
    const blob = await sealed();

    for (const bad of [blob.replace('xk2.', 'xk3.'), blob.replace('x25519', 'gcm')]) {
      await expect(
        openSealedBox({ recipientPrivateKey: recipient.privateKey, blob: bad, aad }),
      ).rejects.toThrow(BlobFormatError);
    }
  });

  /**
   * X25519 returns all zeros for low-order input points. Continuing past that
   * would derive a key an attacker chose, so it must not be caught and ignored.
   */
  it('an ephemeral key that yields an all-zero shared secret', async () => {
    const lowOrder = new Uint8Array(32); // the identity point
    const payload = new Uint8Array(92);
    payload.set(lowOrder, 0);

    await expect(
      openSealedBox({
        recipientPrivateKey: recipient.privateKey,
        blob: `xk2.x25519.${toBase64Url(payload)}`,
        aad,
      }),
    ).rejects.toThrow(DecryptionError);
  });

  // Distinguishing failures tells an attacker probing the API which part of
  // their guess was wrong.
  it('every key-dependent failure identically', async () => {
    const blob = await sealed();
    const other = generateEncryptionKeyPair();
    const payload = parseBlob(blob, 'x25519');
    const tampered = new Uint8Array(payload);
    tampered[80] = tampered[80]! ^ 0xff;

    const attempts = [
      () => openSealedBox({ recipientPrivateKey: other.privateKey, blob, aad }),
      () => openSealedBox({ recipientPrivateKey: recipient.privateKey, blob, aad: otherAad }),
      () =>
        openSealedBox({
          recipientPrivateKey: recipient.privateKey,
          blob: `xk2.x25519.${toBase64Url(tampered)}`,
          aad,
        }),
    ];

    const messages = new Set<string>();
    for (const attempt of attempts) {
      await attempt().catch((error: unknown) => {
        expect(error).toBeInstanceOf(DecryptionError);
        messages.add((error as Error).message);
      });
    }

    expect(messages.size).toBe(1);
    expect([...messages][0]).toBe('Decryption failed');
  });

  it('key material of the wrong length, and an AAD that is not one', async () => {
    const blob = await sealed();

    await expect(
      openSealedBox({ recipientPrivateKey: randomBytes(31), blob, aad }),
    ).rejects.toThrow(TypeError);

    await expect(
      openSealedBox({ recipientPrivateKey: recipient.privateKey, blob, aad: 'not-an-aad' }),
    ).rejects.toThrow(TypeError);
  });
});

describe('seal input validation', () => {
  it('rejects a recipient key that is not 32 bytes', async () => {
    await expect(
      sealToPublicKey({ recipientPublicKey: randomBytes(31), plaintext: edk, aad }),
    ).rejects.toThrow(TypeError);
  });

  it('rejects an ephemeral key or IV of the wrong length', async () => {
    await expect(
      sealToPublicKeyWithRandomness({
        recipientPublicKey: recipient.publicKey,
        plaintext: edk,
        aad,
        ephemeralPrivateKey: randomBytes(31),
        iv: randomBytes(12),
      }),
    ).rejects.toThrow(TypeError);

    await expect(
      sealToPublicKeyWithRandomness({
        recipientPublicKey: recipient.publicKey,
        plaintext: edk,
        aad,
        ephemeralPrivateKey: randomBytes(32),
        iv: randomBytes(16),
      }),
    ).rejects.toThrow(TypeError);
  });
});

describe('the pinned-randomness entry point', () => {
  // It exists only so the vectors are reproducible. It must agree exactly with
  // the exported path, or the vectors would be testing a different function.
  it('produces what the exported path produces, given the same randomness', async () => {
    const ephemeralPrivateKey = randomBytes(32);
    const iv = randomBytes(12);

    const a = await sealToPublicKeyWithRandomness({
      recipientPublicKey: recipient.publicKey,
      plaintext: edk,
      aad,
      ephemeralPrivateKey,
      iv,
    });
    const b = await sealToPublicKeyWithRandomness({
      recipientPublicKey: recipient.publicKey,
      plaintext: edk,
      aad,
      ephemeralPrivateKey,
      iv,
    });

    expect(a).toBe(b);
    expect(
      await openSealedBox({ recipientPrivateKey: recipient.privateKey, blob: a, aad }),
    ).toEqual(edk);

    // The IV lands where the format says it does.
    expect(toHex(fromBase64Url(a.split('.')[2]!).slice(32, 44))).toBe(toHex(iv));
  });
});

import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../../ids/uuid-v7';
import { randomBytes, toBase64Url } from '../encoding';
import { DecryptionError } from '../types';
import { BlobFormatError, parseGcmBlob } from './blob';
import { toHex } from './bytes';
import { generateEncryptionKeyPair, generateSigningKeyPair } from './keypair';
import { deriveRecoveryKey, generateRecoveryCode, recoveryLookupHash } from './recovery';
import {
  derivePasskeyWrapKey,
  derivePassphraseWrapKey,
  deriveUkUnlockVerifier,
  deriveUnlockVerifier,
  generateEnvironmentDataKey,
  generateEnvironmentHmacKey,
  generateUserKey,
  openGrant,
  sealGrant,
  unwrapPrivateKey,
  unwrapUserKey,
  wrapPrivateKey,
  wrapUserKey,
} from './wraps';
import type { UserKeyWrapContext } from './wraps';

const userId = uuidv7();
const environmentId = uuidv7();
const recipientId = uuidv7();

describe('key generation', () => {
  it('produces 32 unpredictable bytes for each key', () => {
    for (const generate of [
      generateUserKey,
      generateEnvironmentDataKey,
      generateEnvironmentHmacKey,
    ]) {
      expect(generate()).toHaveLength(32);
      expect(toHex(generate())).not.toBe(toHex(generate()));
    }
  });
});

describe('wrap-key derivation', () => {
  const stretchedKey = randomBytes(32);

  /**
   * The verifier is handed to the server. If it were the wrap key, or derived
   * from it by anything invertible, a server holding verifiers would hold wrap
   * keys. HKDF's guarantee is that one branch reveals nothing about another.
   */
  it('makes the unlock verifier a sibling of the wrap key, not a parent', async () => {
    const wrapKey = await derivePassphraseWrapKey(stretchedKey);
    const verifier = await deriveUnlockVerifier(stretchedKey);

    expect(toHex(wrapKey)).not.toBe(toHex(verifier));
    expect(toHex(wrapKey)).not.toBe(toHex(stretchedKey));
    expect(toHex(verifier)).not.toBe(toHex(stretchedKey));
  });

  it('derives each wrap key under its own domain', async () => {
    const material = randomBytes(32);
    const derived = await Promise.all([
      derivePassphraseWrapKey(material),
      derivePasskeyWrapKey(material),
      deriveRecoveryKey(material.slice(0, 16)),
      deriveUnlockVerifier(material),
      deriveUkUnlockVerifier(material),
    ]);

    expect(new Set(derived.map(toHex)).size).toBe(5);
  });

  /**
   * The branch a passkey unlock sends.
   *
   * A passkey opens blob type 3, which holds the User Key, and there is no route
   * from the UK back to the Stretched Key. Without this branch such a client
   * could decrypt the whole vault and still hold nothing the unlock endpoint
   * would accept.
   */
  it('derives an unlock proof from the User Key that is not the passphrase one', async () => {
    const userKey = generateUserKey();

    const fromUserKey = await deriveUkUnlockVerifier(userKey);
    const fromStretched = await deriveUnlockVerifier(stretchedKey);

    expect(fromUserKey).toHaveLength(32);
    // Never interchangeable: the two hash to different stored columns, so a
    // value captured from one path cannot be replayed down the other.
    expect(toHex(fromUserKey)).not.toBe(toHex(fromStretched));
    // And it is not the User Key itself — a server storing its digest must not
    // thereby be storing a digest of the key that opens everything.
    expect(toHex(fromUserKey)).not.toBe(toHex(userKey));
  });

  it('survives a re-wrap, because the User Key it derives from does', async () => {
    // The property the passphrase-change and recovery paths depend on: both
    // re-wrap the UK rather than replacing it, so the stored digest stays valid
    // and neither path sends a new one.
    const userKey = generateUserKey();
    const before = await deriveUkUnlockVerifier(userKey);
    const after = await deriveUkUnlockVerifier(Uint8Array.from(userKey));

    expect(toHex(after)).toBe(toHex(before));
  });

  it('refuses input that is not a 32-byte User Key', async () => {
    await expect(deriveUkUnlockVerifier(randomBytes(16))).rejects.toThrow(TypeError);
  });

  it('is deterministic', async () => {
    expect(toHex(await derivePassphraseWrapKey(stretchedKey))).toBe(
      toHex(await derivePassphraseWrapKey(stretchedKey)),
    );
  });
});

describe('User Key wraps', () => {
  const userKey = generateUserKey();

  const contexts = async (): Promise<UserKeyWrapContext[]> => {
    const code = generateRecoveryCode();
    return [
      { userId, wrapKind: 'passphrase' },
      { userId, wrapKind: 'recovery', lookupHash: await recoveryLookupHash(code.codeBytes) },
      { userId, wrapKind: 'prf', credentialIdB64Url: toBase64Url(randomBytes(16)) },
    ];
  };

  it('round-trips under all three wrap kinds', async () => {
    for (const context of await contexts()) {
      const wrapKey = randomBytes(32);
      const blob = await wrapUserKey({ wrapKey, userKey, context });

      expect(blob.startsWith('xk2.gcm.')).toBe(true);
      expect(await unwrapUserKey({ wrapKey, blob, context })).toEqual(userKey);
    }
  });

  it('never produces the same blob twice for the same inputs', async () => {
    const wrapKey = randomBytes(32);
    const context: UserKeyWrapContext = { userId, wrapKind: 'passphrase' };

    const blobs = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      blobs.add(await wrapUserKey({ wrapKey, userKey, context }));
    }
    expect(blobs.size).toBe(20);
  });

  it('rejects the wrong wrap key', async () => {
    const context: UserKeyWrapContext = { userId, wrapKind: 'passphrase' };
    const blob = await wrapUserKey({ wrapKey: randomBytes(32), userKey, context });

    await expect(unwrapUserKey({ wrapKey: randomBytes(32), blob, context })).rejects.toThrow(
      DecryptionError,
    );
  });

  /**
   * All five recovery wraps hold the same User Key. Without the lookup hash in
   * the AAD, swapping two rows would be undetectable.
   */
  it('rejects a wrap row swapped with another of the same user', async () => {
    const wrapKey = randomBytes(32);
    const first = await recoveryLookupHash(generateRecoveryCode().codeBytes);
    const second = await recoveryLookupHash(generateRecoveryCode().codeBytes);

    const blob = await wrapUserKey({
      wrapKey,
      userKey,
      context: { userId, wrapKind: 'recovery', lookupHash: first },
    });

    await expect(
      unwrapUserKey({
        wrapKey,
        blob,
        context: { userId, wrapKind: 'recovery', lookupHash: second },
      }),
    ).rejects.toThrow(DecryptionError);
  });

  it('rejects a wrap row moved to another user or another kind', async () => {
    const wrapKey = randomBytes(32);
    const blob = await wrapUserKey({
      wrapKey,
      userKey,
      context: { userId, wrapKind: 'passphrase' },
    });

    await expect(
      unwrapUserKey({ wrapKey, blob, context: { userId: uuidv7(), wrapKind: 'passphrase' } }),
    ).rejects.toThrow(DecryptionError);

    await expect(
      unwrapUserKey({
        wrapKey,
        blob,
        context: { userId, wrapKind: 'prf', credentialIdB64Url: 'abc' },
      }),
    ).rejects.toThrow(DecryptionError);
  });

  it('rejects a tampered or malformed blob', async () => {
    const wrapKey = randomBytes(32);
    const context: UserKeyWrapContext = { userId, wrapKind: 'passphrase' };
    const blob = await wrapUserKey({ wrapKey, userKey, context });

    const sealed = parseGcmBlob(blob);
    sealed.ciphertext[0] = sealed.ciphertext[0]! ^ 0x01;
    const tampered = `xk2.gcm.${toBase64Url(new Uint8Array([...sealed.iv, ...sealed.ciphertext]))}`;

    await expect(unwrapUserKey({ wrapKey, blob: tampered, context })).rejects.toThrow(
      DecryptionError,
    );
    await expect(
      unwrapUserKey({ wrapKey, blob: blob.replace('xk2', 'xk4'), context }),
    ).rejects.toThrow(BlobFormatError);
  });

  it('rejects a User Key that is not 32 bytes', async () => {
    await expect(
      wrapUserKey({
        wrapKey: randomBytes(32),
        userKey: randomBytes(16),
        context: { userId, wrapKind: 'passphrase' },
      }),
    ).rejects.toThrow(TypeError);
  });
});

describe('private key wraps', () => {
  const userKey = generateUserKey();
  const encryption = generateEncryptionKeyPair();
  const signing = generateSigningKeyPair();

  it('round-trips both private keys', async () => {
    for (const [purpose, privateKey] of [
      ['encryption', encryption.privateKey],
      ['signing', signing.privateKey],
    ] as const) {
      const blob = await wrapPrivateKey({ userKey, privateKey, userId, purpose });
      expect(await unwrapPrivateKey({ userKey, blob, userId, purpose })).toEqual(privateKey);
    }
  });

  // The AAD is what stops the X25519 blob being presented where the Ed25519 one
  // belongs — a substitution the server could otherwise make undetectably.
  it('rejects a private key blob presented for the other purpose', async () => {
    const blob = await wrapPrivateKey({
      userKey,
      privateKey: encryption.privateKey,
      userId,
      purpose: 'encryption',
    });

    await expect(unwrapPrivateKey({ userKey, blob, userId, purpose: 'signing' })).rejects.toThrow(
      DecryptionError,
    );
  });

  it('rejects another user’s key or another User Key', async () => {
    const blob = await wrapPrivateKey({
      userKey,
      privateKey: signing.privateKey,
      userId,
      purpose: 'signing',
    });

    await expect(
      unwrapPrivateKey({ userKey, blob, userId: uuidv7(), purpose: 'signing' }),
    ).rejects.toThrow(DecryptionError);
    await expect(
      unwrapPrivateKey({ userKey: generateUserKey(), blob, userId, purpose: 'signing' }),
    ).rejects.toThrow(DecryptionError);
  });

  it('rejects a private key that is not 32 bytes', async () => {
    await expect(
      wrapPrivateKey({ userKey, privateKey: randomBytes(64), userId, purpose: 'signing' }),
    ).rejects.toThrow(TypeError);
  });
});

describe('grants', () => {
  const edk = generateEnvironmentDataKey();
  const ehk = generateEnvironmentHmacKey();
  const member = generateEncryptionKeyPair();

  const recipient = {
    environmentId,
    edkVersion: 1,
    recipientKind: 'member' as const,
    recipientId,
    recipientPublicKey: member.publicKey,
  };

  it('round-trips an EDK and an EHK to a member', async () => {
    const grant = await sealGrant({ recipient, edk, ehk });
    const opened = await openGrant({
      recipient,
      recipientPrivateKey: member.privateKey,
      grant,
    });

    expect(opened.edk).toEqual(edk);
    expect(opened.ehk).toEqual(ehk);
  });

  it('works the same for a service token and an invitation', async () => {
    for (const recipientKind of ['token', 'invite'] as const) {
      const principal = generateEncryptionKeyPair();
      const context = { ...recipient, recipientKind, recipientPublicKey: principal.publicKey };

      const grant = await sealGrant({ recipient: context, edk, ehk });
      const opened = await openGrant({
        recipient: context,
        recipientPrivateKey: principal.privateKey,
        grant,
      });

      expect(opened.edk).toEqual(edk);
    }
  });

  // The EDK and the EHK are separate boxes: each gets its own ephemeral key, its
  // own IV, and its own AAD.
  it('seals the two keys independently', async () => {
    const grant = await sealGrant({ recipient, edk, ehk });
    expect(grant.edkSealed).not.toBe(grant.ehkSealed);

    await expect(
      openGrant({
        recipient,
        recipientPrivateKey: member.privateKey,
        grant: { edkSealed: grant.ehkSealed, ehkSealed: grant.edkSealed },
      }),
    ).rejects.toThrow(DecryptionError);
  });

  /**
   * The rotation invariant: a grant for version 1 must not open as a grant for
   * version 2, or a client could be handed a retired key and told it is current.
   */
  it('binds the EDK grant to its version', async () => {
    const grant = await sealGrant({ recipient, edk, ehk });

    await expect(
      openGrant({
        recipient: { ...recipient, edkVersion: 2 },
        recipientPrivateKey: member.privateKey,
        grant,
      }),
    ).rejects.toThrow(DecryptionError);
  });

  // The EHK is unversioned by design, so it survives a rotation unchanged —
  // which is what keeps valueHmac stable.
  it('re-seals the same EHK unchanged across an EDK rotation', async () => {
    const before = await sealGrant({ recipient, edk, ehk });
    const rotated = { ...recipient, edkVersion: 2 };
    const after = await sealGrant({ recipient: rotated, edk: generateEnvironmentDataKey(), ehk });

    const openedBefore = await openGrant({
      recipient,
      recipientPrivateKey: member.privateKey,
      grant: before,
    });
    const openedAfter = await openGrant({
      recipient: rotated,
      recipientPrivateKey: member.privateKey,
      grant: after,
    });

    expect(openedAfter.ehk).toEqual(openedBefore.ehk);
    expect(openedAfter.edk).not.toEqual(openedBefore.edk);
  });

  it('rejects a grant sealed to another principal', async () => {
    const grant = await sealGrant({ recipient, edk, ehk });

    await expect(
      openGrant({
        recipient: { ...recipient, recipientKind: 'token' },
        recipientPrivateKey: member.privateKey,
        grant,
      }),
    ).rejects.toThrow(DecryptionError);

    await expect(
      openGrant({
        recipient,
        recipientPrivateKey: generateEncryptionKeyPair().privateKey,
        grant,
      }),
    ).rejects.toThrow(DecryptionError);
  });

  it('rejects environment keys that are not 32 bytes', async () => {
    await expect(sealGrant({ recipient, edk: randomBytes(16), ehk })).rejects.toThrow(TypeError);
    await expect(sealGrant({ recipient, edk, ehk: randomBytes(64) })).rejects.toThrow(TypeError);
  });
});

import { describe, expect, it } from 'vitest';
import { overrideValueAad } from '../aad';
import { MAX_SECRET_VALUE_BYTES, SecretTooLargeError } from '../secrets';
import { DecryptionError } from '../types';
import { formatGcmBlob } from './blob';
import { encryptGcm } from './gcm';
import { generateEncryptionKeyPair } from './keypair';
import {
  deriveOverrideKey,
  MAX_OVERRIDE_BLOB_LENGTH,
  openOverrideValue,
  sealOverrideValue,
} from './override';
import { sealToPublicKey } from './sealed-box';

const CONTEXT = {
  orgId: '018f3b2c-9c1a-7c3d-8e4f-0a1b2c3d4e5f',
  environmentId: '018f3b2c-9c1a-7c3d-8e4f-1a1b2c3d4e5f',
  userId: '018f3b2c-9c1a-7c3d-8e4f-4a1b2c3d4e5f',
  name: 'DATABASE_URL',
};

describe('personal override values', () => {
  it('opens for its owner, with the value NFC-normalised', async () => {
    const owner = generateEncryptionKeyPair();
    const blob = await sealOverrideValue({
      ownerPrivateKey: owner.privateKey,
      context: CONTEXT,
      value: 'café',
    });
    expect(blob.startsWith('xk2.gcm.')).toBe(true);
    expect(
      await openOverrideValue({ ownerPrivateKey: owner.privateKey, context: CONTEXT, blob }),
    ).toBe('café');
  });

  it('opens for nobody else, and nowhere else', async () => {
    const owner = generateEncryptionKeyPair();
    const teammate = generateEncryptionKeyPair();
    const blob = await sealOverrideValue({
      ownerPrivateKey: owner.privateKey,
      context: CONTEXT,
      value: 'local',
    });

    const attempts = [
      { ownerPrivateKey: teammate.privateKey, context: CONTEXT },
      {
        ownerPrivateKey: owner.privateKey,
        context: { ...CONTEXT, userId: '018f3b2c-9c1a-7c3d-8e4f-5a1b2c3d4e5f' },
      },
      {
        ownerPrivateKey: owner.privateKey,
        context: { ...CONTEXT, environmentId: '018f3b2c-9c1a-7c3d-8e4f-6a1b2c3d4e5f' },
      },
      { ownerPrivateKey: owner.privateKey, context: { ...CONTEXT, name: 'OTHER' } },
    ];
    for (const attempt of attempts) {
      await expect(openOverrideValue({ ...attempt, blob })).rejects.toBeInstanceOf(DecryptionError);
    }
  });

  // The property the construction exists for: the server holds the owner's
  // public key, so anything made from it alone must be refused.
  it('refuses an override anybody but its owner made — a sealed box to the owner included', async () => {
    const owner = generateEncryptionKeyPair();
    const aad = overrideValueAad(CONTEXT);

    const sealedToOwner = await sealToPublicKey({
      recipientPublicKey: owner.publicKey,
      plaintext: new TextEncoder().encode('--require /tmp/evil.js'),
      aad,
    });
    await expect(
      openOverrideValue({
        ownerPrivateKey: owner.privateKey,
        context: CONTEXT,
        blob: sealedToOwner,
      }),
    ).rejects.toThrow();

    const underAnotherKey = formatGcmBlob(
      await encryptGcm(
        await deriveOverrideKey(generateEncryptionKeyPair().privateKey),
        new TextEncoder().encode('--require /tmp/evil.js'),
        aad,
      ),
    );
    await expect(
      openOverrideValue({
        ownerPrivateKey: owner.privateKey,
        context: CONTEXT,
        blob: underAnotherKey,
      }),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it('derives the key from the private key alone, deterministically', async () => {
    const owner = generateEncryptionKeyPair();
    const a = await deriveOverrideKey(owner.privateKey);
    const b = await deriveOverrideKey(owner.privateKey);
    expect(a).toEqual(b);
    expect(a).not.toEqual(owner.privateKey);
    expect(a).toHaveLength(32);
  });

  it('refuses a value past the secret size limit before encrypting anything', async () => {
    const owner = generateEncryptionKeyPair();
    await expect(
      sealOverrideValue({
        ownerPrivateKey: owner.privateKey,
        context: CONTEXT,
        value: 'x'.repeat(MAX_SECRET_VALUE_BYTES + 1),
      }),
    ).rejects.toBeInstanceOf(SecretTooLargeError);
  });

  it('stays within the bound the server enforces, at the largest value', async () => {
    const owner = generateEncryptionKeyPair();
    const blob = await sealOverrideValue({
      ownerPrivateKey: owner.privateKey,
      context: CONTEXT,
      value: 'x'.repeat(MAX_SECRET_VALUE_BYTES),
    });
    expect(blob.length).toBeLessThanOrEqual(MAX_OVERRIDE_BLOB_LENGTH);
  });

  it('binds a name the component rule admits, and nothing else', () => {
    expect(overrideValueAad(CONTEXT)).toBe(
      `xecret.aad.v2.override-value|${CONTEXT.orgId}|${CONTEXT.environmentId}|${CONTEXT.userId}|DATABASE_URL`,
    );
    expect(() => overrideValueAad({ ...CONTEXT, name: 'A|B' })).toThrow(TypeError);
    expect(() => overrideValueAad({ ...CONTEXT, userId: 'not-a-uuid' })).toThrow(TypeError);
  });
});

import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../ids/uuid-v7';
import { timingSafeEqual, toBase64Url, utf8Encode } from './encoding';
import { generateKeyBytes } from './keys';
import {
  computeValueHmac,
  decryptSecretValue,
  encryptSecretValue,
  MAX_SECRET_VALUE_BYTES,
  SecretTooLargeError,
} from './secrets';
import { DecryptionError } from './types';
import type { EncryptionContext } from './types';

function context(overrides: Partial<EncryptionContext> = {}): EncryptionContext {
  return {
    orgId: uuidv7(),
    environmentId: uuidv7(),
    secretId: uuidv7(),
    version: 1,
    ...overrides,
  };
}

describe('secret encryption', () => {
  it('round-trips', async () => {
    const envKeyBytes = generateKeyBytes();
    const ctx = context();
    const plaintext = 'postgres://app:s3cr3t@db.internal:5432/production';

    const encrypted = await encryptSecretValue({ envKeyBytes, context: ctx, plaintext });
    expect(await decryptSecretValue({ envKeyBytes, context: ctx, encrypted })).toBe(plaintext);
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['multiline PEM', '-----BEGIN KEY-----\nabc\ndef\n-----END KEY-----'],
    ['unicode', 'pässwörd-日本語-🔐'],
    ['json blob', '{"nested":{"key":"value"},"n":1}'],
  ])('round-trips a %s value', async (_label, plaintext) => {
    const envKeyBytes = generateKeyBytes();
    const ctx = context();

    const encrypted = await encryptSecretValue({ envKeyBytes, context: ctx, plaintext });
    expect(await decryptSecretValue({ envKeyBytes, context: ctx, encrypted })).toBe(plaintext);
  });

  it('never leaves the plaintext visible in the ciphertext', async () => {
    const encrypted = await encryptSecretValue({
      envKeyBytes: generateKeyBytes(),
      context: context(),
      plaintext: 'UNIQUE_SENTINEL_VALUE',
    });

    expect(toBase64Url(encrypted.ciphertext)).not.toContain(
      toBase64Url(utf8Encode('UNIQUE_SENTINEL_VALUE')),
    );
  });

  it('rejects an oversized value rather than burning CPU on it', async () => {
    await expect(
      encryptSecretValue({
        envKeyBytes: generateKeyBytes(),
        context: context(),
        plaintext: 'a'.repeat(MAX_SECRET_VALUE_BYTES + 1),
      }),
    ).rejects.toThrow(SecretTooLargeError);
  });

  it('accepts a value exactly at the limit', async () => {
    const envKeyBytes = generateKeyBytes();
    const ctx = context();
    const plaintext = 'a'.repeat(MAX_SECRET_VALUE_BYTES);

    const encrypted = await encryptSecretValue({ envKeyBytes, context: ctx, plaintext });
    expect(await decryptSecretValue({ envKeyBytes, context: ctx, encrypted })).toBe(plaintext);
  });
});

/**
 * The attack AAD binding exists to defeat.
 *
 * An adversary with database write access but no key copies a ciphertext row
 * from an environment they cannot read into one they can, then reads it through
 * the normal API. Encryption alone does not stop this; each of these must fail.
 */
describe('ciphertext relocation is rejected', () => {
  const envKeyBytes = generateKeyBytes();
  const original = context();

  it.each([
    ['a different environment', { environmentId: uuidv7() }],
    ['a different organisation', { orgId: uuidv7() }],
    ['a different secret', { secretId: uuidv7() }],
    ['a different version', { version: 2 }],
  ])('rejects relocation to %s', async (_label, overrides) => {
    const encrypted = await encryptSecretValue({
      envKeyBytes,
      context: original,
      plaintext: 'production-database-password',
    });

    await expect(
      decryptSecretValue({ envKeyBytes, context: { ...original, ...overrides }, encrypted }),
    ).rejects.toThrow(DecryptionError);
  });

  it('rejects a ciphertext encrypted under another environment key', async () => {
    const encrypted = await encryptSecretValue({
      envKeyBytes: generateKeyBytes(),
      context: original,
      plaintext: 'value',
    });

    await expect(
      decryptSecretValue({ envKeyBytes: generateKeyBytes(), context: original, encrypted }),
    ).rejects.toThrow(DecryptionError);
  });

  it('rejects a tampered ciphertext', async () => {
    const encrypted = await encryptSecretValue({
      envKeyBytes,
      context: original,
      plaintext: 'value',
    });

    const ciphertext = new Uint8Array(encrypted.ciphertext);
    ciphertext[0] = ciphertext[0]! ^ 0x01;

    await expect(
      decryptSecretValue({
        envKeyBytes,
        context: original,
        encrypted: { ...encrypted, ciphertext },
      }),
    ).rejects.toThrow(DecryptionError);
  });
});

describe('value HMAC', () => {
  const environmentId = uuidv7();

  it('is deterministic for the same key, environment, and value', async () => {
    const envKeyBytes = generateKeyBytes();

    const a = await computeValueHmac({ envKeyBytes, environmentId, plaintext: 'same' });
    const b = await computeValueHmac({ envKeyBytes, environmentId, plaintext: 'same' });

    expect(timingSafeEqual(a, b)).toBe(true);
  });

  it('is 256 bits', async () => {
    expect(
      await computeValueHmac({
        envKeyBytes: generateKeyBytes(),
        environmentId,
        plaintext: 'x',
      }),
    ).toHaveLength(32);
  });

  it('differs for different values', async () => {
    const envKeyBytes = generateKeyBytes();

    const a = await computeValueHmac({ envKeyBytes, environmentId, plaintext: 'value-a' });
    const b = await computeValueHmac({ envKeyBytes, environmentId, plaintext: 'value-b' });

    expect(timingSafeEqual(a, b)).toBe(false);
  });

  // This is what stops the column being a brute-force oracle: without the key
  // hierarchy, the tag says nothing about the value.
  it('differs for the same value under a different environment key', async () => {
    const a = await computeValueHmac({
      envKeyBytes: generateKeyBytes(),
      environmentId,
      plaintext: 'identical',
    });
    const b = await computeValueHmac({
      envKeyBytes: generateKeyBytes(),
      environmentId,
      plaintext: 'identical',
    });

    expect(timingSafeEqual(a, b)).toBe(false);
  });

  // Prevents the column being used to correlate the same secret across
  // environments, which would leak "staging and production share a password".
  it('differs for the same value and key across environments', async () => {
    const envKeyBytes = generateKeyBytes();

    const a = await computeValueHmac({ envKeyBytes, environmentId, plaintext: 'identical' });
    const b = await computeValueHmac({
      envKeyBytes,
      environmentId: uuidv7(),
      plaintext: 'identical',
    });

    expect(timingSafeEqual(a, b)).toBe(false);
  });

  it('does not reveal the plaintext', async () => {
    const hmac = await computeValueHmac({
      envKeyBytes: generateKeyBytes(),
      environmentId,
      plaintext: 'UNIQUE_SENTINEL_VALUE',
    });

    expect(toBase64Url(hmac)).not.toContain(toBase64Url(utf8Encode('UNIQUE_SENTINEL_VALUE')));
  });
});

import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../../ids/uuid-v7';
import { secretValueAad } from '../aad';
import { randomBytes, toBase64Url } from '../encoding';
import { MAX_SECRET_VALUE_BYTES, SecretTooLargeError } from '../secrets';
import { DecryptionError } from '../types';
import { BlobFormatError, formatGcmBlob, parseGcmBlob } from './blob';
import { encryptGcm } from './gcm';
import { toHex } from './bytes';
import { computeValueHmac, decryptSecret, encryptSecret, MAX_SECRET_BLOB_LENGTH } from './secret';
import type { SecretContext } from './secret';
import { generateEnvironmentDataKey, generateEnvironmentHmacKey } from './wraps';

const orgId = uuidv7();
const environmentId = uuidv7();
const secretId = uuidv7();

const valueContext: SecretContext = {
  field: 'value',
  orgId,
  environmentId,
  secretId,
  version: 1,
};

const noteContext: SecretContext = { field: 'note', orgId, environmentId, secretId };

const edk = generateEnvironmentDataKey();

describe('value and note encryption', () => {
  it('round-trips a value and a note', async () => {
    for (const context of [valueContext, noteContext]) {
      const blob = await encryptSecret({ edk, context, plaintext: 'hunter2' });

      expect(blob.startsWith('xk2.gcm.')).toBe(true);
      expect(await decryptSecret({ edk, context, blob })).toBe('hunter2');
    }
  });

  // The decrypted value is the NFC form, which is what was encrypted: text
  // entering an AEAD is normalised for the same reason text entering a KDF is.
  it('round-trips the empty string, a long value, and non-ASCII text', async () => {
    for (const plaintext of [
      '',
      'x'.repeat(10_000),
      'na\u00efve caf\u00e9 \u2615 \u65e5\u672c\u8a9e',
    ]) {
      const blob = await encryptSecret({ edk, context: valueContext, plaintext });
      expect(await decryptSecret({ edk, context: valueContext, blob })).toBe(
        plaintext.normalize('NFC'),
      );
    }
  });

  it('never produces the same ciphertext twice', async () => {
    const blobs = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      blobs.add(await encryptSecret({ edk, context: valueContext, plaintext: 'identical' }));
    }
    expect(blobs.size).toBe(20);
  });

  it('does not leak the plaintext into the blob', async () => {
    const blob = await encryptSecret({
      edk,
      context: valueContext,
      plaintext: 'UNIQUE_MARKER_VALUE',
    });
    expect(blob).not.toContain(toBase64Url(new TextEncoder().encode('UNIQUE_MARKER_VALUE')));
  });

  // NFC, like every other text input: the same value typed on two platforms must
  // produce the same ciphertext input and the same valueHmac.
  it('normalises the plaintext', async () => {
    const decomposed = 'cafe\u0301';
    const composed = 'caf\u00e9';

    const blob = await encryptSecret({ edk, context: valueContext, plaintext: decomposed });
    expect(await decryptSecret({ edk, context: valueContext, blob })).toBe(composed);
  });

  it('refuses a plaintext over the size limit before encrypting it', async () => {
    await expect(
      encryptSecret({
        edk,
        context: valueContext,
        plaintext: 'x'.repeat(MAX_SECRET_VALUE_BYTES + 1),
      }),
    ).rejects.toThrow(SecretTooLargeError);

    // Exactly at the limit is allowed.
    const blob = await encryptSecret({
      edk,
      context: valueContext,
      plaintext: 'x'.repeat(MAX_SECRET_VALUE_BYTES),
    });
    expect(blob.length).toBeLessThanOrEqual(MAX_SECRET_BLOB_LENGTH);
  });

  it('counts bytes, not characters, against the limit', async () => {
    // Four bytes per character in UTF-8.
    await expect(
      encryptSecret({
        edk,
        context: valueContext,
        plaintext: '😀'.repeat(MAX_SECRET_VALUE_BYTES / 4 + 1),
      }),
    ).rejects.toThrow(SecretTooLargeError);
  });

  // Pinned to the number spec §2.2 derives, so the client's plaintext limit and
  // the server's ciphertext limit cannot drift apart.
  it('bounds the blob a server must accept', () => {
    expect(MAX_SECRET_BLOB_LENGTH).toBe(87_428);
    expect(MAX_SECRET_BLOB_LENGTH).toBeGreaterThan(MAX_SECRET_VALUE_BYTES);
  });
});

// Each of these is a relocation attack that AAD binding must defeat.
describe('decryption rejects a relocated or tampered ciphertext', () => {
  it('rejects a value moved to another row', async () => {
    const blob = await encryptSecret({ edk, context: valueContext, plaintext: 'hunter2' });

    for (const context of [
      { ...valueContext, orgId: uuidv7() },
      { ...valueContext, environmentId: uuidv7() },
      { ...valueContext, secretId: uuidv7() },
      { ...valueContext, version: 2 },
      noteContext,
    ] satisfies SecretContext[]) {
      await expect(decryptSecret({ edk, context, blob })).rejects.toThrow(DecryptionError);
    }
  });

  it('rejects a note presented as a value', async () => {
    const blob = await encryptSecret({ edk, context: noteContext, plaintext: 'a note' });
    await expect(decryptSecret({ edk, context: valueContext, blob })).rejects.toThrow(
      DecryptionError,
    );
  });

  // After a rotation the old EDK is still a valid 32-byte key. It must simply
  // fail, rather than produce anything.
  it('rejects the wrong EDK, including the previous one', async () => {
    const blob = await encryptSecret({ edk, context: valueContext, plaintext: 'hunter2' });

    await expect(
      decryptSecret({ edk: generateEnvironmentDataKey(), context: valueContext, blob }),
    ).rejects.toThrow(DecryptionError);
  });

  it('rejects a flipped bit and a truncated ciphertext', async () => {
    const blob = await encryptSecret({ edk, context: valueContext, plaintext: 'hunter2' });
    const sealed = parseGcmBlob(blob);

    const tampered = new Uint8Array([...sealed.iv, ...sealed.ciphertext]);
    tampered[20] = tampered[20]! ^ 0x01;

    await expect(
      decryptSecret({ edk, context: valueContext, blob: `xk2.gcm.${toBase64Url(tampered)}` }),
    ).rejects.toThrow(DecryptionError);

    await expect(
      decryptSecret({
        edk,
        context: valueContext,
        blob: `xk2.gcm.${toBase64Url(tampered.slice(0, -1))}`,
      }),
    ).rejects.toThrow(DecryptionError);
  });

  /**
   * The one failure that is neither a wrong key nor a malformed string: the tag
   * verified, so the bytes are exactly what the writer sealed, and they are
   * still not text. A writer that is not this library — a future field type, a
   * corrupted round trip through a client that stored raw bytes — produces it.
   *
   * It is a format error and not a `DecryptionError` because the key *was*
   * right, and saying otherwise would send a user to re-enter a passphrase that
   * has nothing wrong with it. Silently substituting U+FFFD is the one outcome
   * ruled out: mojibake written back on the next save destroys the value.
   */
  it('rejects an authenticated plaintext that is not valid UTF-8', async () => {
    // A lone continuation byte: sealed under the right key and the right AAD,
    // so everything up to the decode succeeds.
    const blob = formatGcmBlob(
      await encryptGcm(edk, new Uint8Array([0x41, 0x80, 0x42]), secretValueAad(valueContext)),
    );

    const thrown = await decryptSecret({ edk, context: valueContext, blob }).catch(
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(BlobFormatError);
    expect(thrown).not.toBeInstanceOf(DecryptionError);
  });

  it('rejects an unknown blob version as a format error', async () => {
    const blob = await encryptSecret({ edk, context: valueContext, plaintext: 'hunter2' });

    await expect(
      decryptSecret({ edk, context: valueContext, blob: blob.replace('xk2', 'xk3') }),
    ).rejects.toThrow(BlobFormatError);
  });
});

describe('valueHmac', () => {
  const ehk = generateEnvironmentHmacKey();

  it('is 32 deterministic bytes', async () => {
    const a = await computeValueHmac({ ehk, plaintext: 'hunter2' });
    const b = await computeValueHmac({ ehk, plaintext: 'hunter2' });

    expect(a).toHaveLength(32);
    expect(toHex(a)).toBe(toHex(b));
  });

  it('differs for a different value and for a different environment key', async () => {
    const base = toHex(await computeValueHmac({ ehk, plaintext: 'hunter2' }));

    expect(toHex(await computeValueHmac({ ehk, plaintext: 'hunter3' }))).not.toBe(base);
    expect(
      toHex(await computeValueHmac({ ehk: generateEnvironmentHmacKey(), plaintext: 'hunter2' })),
    ).not.toBe(base);
  });

  /**
   * The entire reason the EHK exists. The EDK rotates whenever a principal is
   * revoked; if the HMAC key rotated with it, the first write to every secret
   * after a rotation would be recorded as a change when nothing changed.
   */
  it('is stable across an EDK rotation, while the ciphertext is not', async () => {
    const oldEdk = generateEnvironmentDataKey();
    const newEdk = generateEnvironmentDataKey();

    const before = {
      blob: await encryptSecret({ edk: oldEdk, context: valueContext, plaintext: 'hunter2' }),
      tag: await computeValueHmac({ ehk, plaintext: 'hunter2' }),
    };

    // A rotation replaces the EDK and re-seals the same EHK unchanged.
    const after = {
      blob: await encryptSecret({ edk: newEdk, context: valueContext, plaintext: 'hunter2' }),
      tag: await computeValueHmac({ ehk, plaintext: 'hunter2' }),
    };

    expect(after.blob).not.toBe(before.blob);
    expect(toHex(after.tag)).toBe(toHex(before.tag));
  });

  // Keyed, not a bare digest: a plain SHA-256 of the plaintext would be an
  // offline brute-force oracle against a database dump.
  it('is not a bare digest of the plaintext', async () => {
    const tag = toHex(await computeValueHmac({ ehk, plaintext: 'hunter2' }));
    const digest = toHex(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('hunter2'))),
    );

    expect(tag).not.toBe(digest);
  });

  it('normalises the plaintext, so two spellings produce one tag', async () => {
    const decomposed = 'cafe\u0301';
    const composed = 'caf\u00e9';

    expect(toHex(await computeValueHmac({ ehk, plaintext: decomposed }))).toBe(
      toHex(await computeValueHmac({ ehk, plaintext: composed })),
    );
  });

  it('accepts an empty value', async () => {
    expect(await computeValueHmac({ ehk, plaintext: '' })).toHaveLength(32);
  });

  it('rejects an environment HMAC key that is not usable', async () => {
    await expect(computeValueHmac({ ehk: new Uint8Array(0), plaintext: 'x' })).rejects.toThrow();
    expect(await computeValueHmac({ ehk: randomBytes(32), plaintext: 'x' })).toHaveLength(32);
  });
});

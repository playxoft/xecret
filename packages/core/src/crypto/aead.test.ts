import { describe, expect, it } from 'vitest';
import { importAesKey, IV_LENGTH, KEY_LENGTH, open, seal } from './aead';
import { fromBase64Url, randomBytes, toBase64Url, utf8Decode, utf8Encode } from './encoding';
import { DecryptionError } from './types';

const aad = utf8Encode('test-aad');

async function freshKey(): Promise<CryptoKey> {
  return importAesKey(randomBytes(KEY_LENGTH));
}

describe('importAesKey', () => {
  it('rejects key material of the wrong length', async () => {
    await expect(importAesKey(randomBytes(16))).rejects.toThrow(TypeError);
    await expect(importAesKey(randomBytes(31))).rejects.toThrow(TypeError);
    await expect(importAesKey(randomBytes(33))).rejects.toThrow(TypeError);
  });

  // Narrows what an attacker with code execution in the Worker can exfiltrate.
  it('produces a non-extractable key', async () => {
    const key = await freshKey();
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });
});

describe('seal and open', () => {
  it('round-trips', async () => {
    const key = await freshKey();
    const plaintext = utf8Encode('postgres://user:hunter2@db.example.com/app');

    const sealed = await seal(key, plaintext, aad);
    expect(utf8Decode(await open(key, sealed, aad))).toBe(
      'postgres://user:hunter2@db.example.com/app',
    );
  });

  it('round-trips empty and large plaintexts', async () => {
    const key = await freshKey();

    for (const size of [0, 1, 4096, 65_536]) {
      const plaintext = size === 0 ? new Uint8Array(0) : randomBytes(size);
      expect(await open(key, await seal(key, plaintext, aad), aad)).toEqual(plaintext);
    }
  });

  it('produces ciphertext that does not contain the plaintext', async () => {
    const key = await freshKey();
    const marker = 'UNIQUE_MARKER_VALUE';
    const sealed = await seal(key, utf8Encode(marker), aad);

    expect(toBase64Url(sealed.ciphertext)).not.toContain(toBase64Url(utf8Encode(marker)));
  });

  it('appends a 128-bit authentication tag', async () => {
    const key = await freshKey();
    const plaintext = randomBytes(100);
    const sealed = await seal(key, plaintext, aad);

    expect(sealed.ciphertext.length).toBe(plaintext.length + 16);
  });
});

describe('IV handling', () => {
  it('uses a 96-bit IV', async () => {
    const key = await freshKey();
    expect((await seal(key, randomBytes(10), aad)).iv).toHaveLength(IV_LENGTH);
  });

  // IV reuse under one key is catastrophic for GCM: it leaks the XOR of the two
  // plaintexts and enables forgery. There is deliberately no API to supply one.
  it('never reuses an IV across calls', async () => {
    const key = await freshKey();
    const ivs = new Set<string>();

    for (let i = 0; i < 2000; i += 1) {
      ivs.add(toBase64Url((await seal(key, utf8Encode('same plaintext'), aad)).iv));
    }
    expect(ivs.size).toBe(2000);
  });

  it('produces different ciphertext for identical plaintext', async () => {
    const key = await freshKey();
    const plaintext = utf8Encode('identical');

    const a = await seal(key, plaintext, aad);
    const b = await seal(key, plaintext, aad);

    expect(toBase64Url(a.ciphertext)).not.toBe(toBase64Url(b.ciphertext));
  });
});

describe('open rejects tampering', () => {
  it('rejects a flipped bit anywhere in the ciphertext', async () => {
    const key = await freshKey();
    const sealed = await seal(key, randomBytes(64), aad);

    for (const index of [0, 1, 32, sealed.ciphertext.length - 1]) {
      const tampered = new Uint8Array(sealed.ciphertext);
      tampered[index] = tampered[index]! ^ 0x01;
      await expect(open(key, { ...sealed, ciphertext: tampered }, aad)).rejects.toThrow(
        DecryptionError,
      );
    }
  });

  it('rejects a modified authentication tag', async () => {
    const key = await freshKey();
    const sealed = await seal(key, randomBytes(64), aad);

    const tampered = new Uint8Array(sealed.ciphertext);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    await expect(open(key, { ...sealed, ciphertext: tampered }, aad)).rejects.toThrow(
      DecryptionError,
    );
  });

  it('rejects a modified IV', async () => {
    const key = await freshKey();
    const sealed = await seal(key, randomBytes(64), aad);

    const iv = new Uint8Array(sealed.iv);
    iv[0] = iv[0]! ^ 0x01;
    await expect(open(key, { ...sealed, iv }, aad)).rejects.toThrow(DecryptionError);
  });

  it('rejects an IV of the wrong length', async () => {
    const key = await freshKey();
    const sealed = await seal(key, randomBytes(64), aad);

    await expect(open(key, { ...sealed, iv: randomBytes(8) }, aad)).rejects.toThrow(
      DecryptionError,
    );
    await expect(open(key, { ...sealed, iv: randomBytes(16) }, aad)).rejects.toThrow(
      DecryptionError,
    );
  });

  it('rejects truncated ciphertext', async () => {
    const key = await freshKey();
    const sealed = await seal(key, randomBytes(64), aad);

    await expect(
      open(key, { ...sealed, ciphertext: sealed.ciphertext.slice(0, -1) }, aad),
    ).rejects.toThrow(DecryptionError);
  });

  it('rejects the wrong key', async () => {
    const sealed = await seal(await freshKey(), randomBytes(64), aad);
    await expect(open(await freshKey(), sealed, aad)).rejects.toThrow(DecryptionError);
  });

  it('rejects the wrong AAD', async () => {
    const key = await freshKey();
    const sealed = await seal(key, randomBytes(64), aad);

    await expect(open(key, sealed, utf8Encode('different-aad'))).rejects.toThrow(DecryptionError);
    await expect(open(key, sealed, new Uint8Array(0))).rejects.toThrow(DecryptionError);
  });

  // Distinguishing failure modes would tell an attacker which part of a guess
  // was wrong. Every path must be indistinguishable.
  it('reports every failure identically', async () => {
    const key = await freshKey();
    const sealed = await seal(key, randomBytes(64), aad);
    const messages = new Set<string>();

    const failures = [
      open(key, sealed, utf8Encode('wrong-aad')),
      open(await freshKey(), sealed, aad),
      open(key, { ...sealed, iv: randomBytes(IV_LENGTH) }, aad),
      open(key, { ...sealed, ciphertext: sealed.ciphertext.slice(0, -1) }, aad),
    ];

    for (const attempt of failures) {
      await attempt.catch((error: unknown) => {
        expect(error).toBeInstanceOf(DecryptionError);
        messages.add((error as Error).message);
      });
    }

    expect(messages.size).toBe(1);
    expect([...messages][0]).toBe('Decryption failed');
  });
});

describe('known-answer vector', () => {
  // Pinned so a future refactor of parameters — tag length, IV length, AAD
  // handling — cannot silently change the wire format and orphan stored data.
  it('decrypts a ciphertext produced by this implementation', async () => {
    const key = await importAesKey(fromBase64Url('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'));
    const sealed = {
      // AES-256-GCM of 'xecret-kat' under the key above, IV below, AAD
      // 'xecret.kat.v1'. Includes the 16-byte tag.
      ciphertext: fromBase64Url('P2e1aaCR73DsNcebJoTrScSTRkShOHT9ht8'),
      iv: fromBase64Url('AAECAwQFBgcICQoL'),
    };

    // If this fails after a crypto change, the format changed and every stored
    // ciphertext is unreadable. Do not "fix" it by regenerating the vector.
    const plaintext = await open(key, sealed, utf8Encode('xecret.kat.v1'));
    expect(utf8Decode(plaintext)).toBe('xecret-kat');
  });
});

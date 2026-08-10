import { secretAad } from './aad';
import { importAesKey, open, seal } from './aead';
import { utf8Decode, utf8Encode } from './encoding';
import { DEFAULT_ALGORITHM } from './types';
import type { EncryptedValue, EncryptionContext } from './types';
import type { Bytes } from './types';

/**
 * Encrypting and decrypting secret values, and detecting unchanged values
 * without decrypting them.
 */

/** Guards against a client sending a multi-megabyte "secret" to exhaust CPU. */
export const MAX_SECRET_VALUE_BYTES = 64 * 1024;

export class SecretTooLargeError extends Error {
  constructor(readonly byteLength: number) {
    super(`Secret value exceeds ${MAX_SECRET_VALUE_BYTES} bytes`);
    this.name = 'SecretTooLargeError';
  }
}

/** Encrypts a secret value, binding it to the row that will store it. */
export async function encryptSecretValue(params: {
  envKeyBytes: Bytes;
  context: EncryptionContext;
  plaintext: string;
}): Promise<EncryptedValue> {
  const plaintextBytes = utf8Encode(params.plaintext);

  if (plaintextBytes.length > MAX_SECRET_VALUE_BYTES) {
    throw new SecretTooLargeError(plaintextBytes.length);
  }

  const key = await importAesKey(params.envKeyBytes, ['encrypt']);

  try {
    const sealed = await seal(key, plaintextBytes, secretAad(params.context));
    return { ...sealed, algorithm: DEFAULT_ALGORITHM };
  } finally {
    plaintextBytes.fill(0);
  }
}

/**
 * Decrypts a secret value.
 *
 * Throws `DecryptionError` if the ciphertext has been tampered with, or if the
 * supplied context does not match the one used at encryption time — which is
 * what stops a ciphertext row being relocated into an environment the caller is
 * allowed to read.
 */
export async function decryptSecretValue(params: {
  envKeyBytes: Bytes;
  context: EncryptionContext;
  encrypted: EncryptedValue;
}): Promise<string> {
  const key = await importAesKey(params.envKeyBytes, ['decrypt']);
  const plaintextBytes = await open(key, params.encrypted, secretAad(params.context));

  try {
    return utf8Decode(plaintextBytes);
  } finally {
    plaintextBytes.fill(0);
  }
}

/**
 * Computes the change-detection tag stored in `secret_versions.value_hmac`.
 *
 * Deliberately an HMAC, not a hash. A plain SHA-256 of the plaintext would be a
 * brute-force oracle: most secrets are low-entropy enough — short API keys,
 * connection strings with dictionary passwords — that an attacker holding a
 * database dump could confirm guesses offline at high speed. Keying the digest
 * with material derived from the environment's data key makes the tag useless
 * without the key hierarchy, while still letting the server answer "is this the
 * same value?" without decrypting anything.
 *
 * The HMAC key is derived via HKDF rather than reusing the data key directly, so
 * that using a key for two purposes cannot create an interaction between them.
 */
export async function computeValueHmac(params: {
  envKeyBytes: Bytes;
  environmentId: string;
  plaintext: string;
}): Promise<Bytes> {
  const hmacKey = await deriveValueHmacKey(params.envKeyBytes, params.environmentId);
  const plaintextBytes = utf8Encode(params.plaintext);

  try {
    const signature = await crypto.subtle.sign('HMAC', hmacKey, plaintextBytes);
    return new Uint8Array(signature);
  } finally {
    plaintextBytes.fill(0);
  }
}

async function deriveValueHmacKey(envKeyBytes: Bytes, environmentId: string): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey('raw', envKeyBytes, 'HKDF', false, ['deriveKey']);

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      // An empty salt is correct here: the input keying material is already a
      // uniformly random 256-bit key, not a password or a low-entropy secret.
      salt: new Uint8Array(0),
      // Domain separation. Binding the environment id means the same value in two
      // environments produces different tags, so the column cannot be used to
      // correlate secrets across environments.
      info: utf8Encode(`xecret.hkdf.v1.value-hmac|${environmentId}`),
    },
    baseKey,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
}

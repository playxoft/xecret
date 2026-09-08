import { describe, expect, it } from 'vitest';
import { randomBytes, toBase64Url } from '../encoding';
import {
  BLOB_ALGORITHMS,
  BLOB_VERSION,
  BlobFormatError,
  formatBlob,
  formatGcmBlob,
  parseBlob,
  parseGcmBlob,
} from './blob';

const gcmPayload = randomBytes(40);
const sealedPayload = randomBytes(80);
const signaturePayload = randomBytes(64);

describe('blob format', () => {
  it('renders three dot-separated fields', () => {
    const blob = formatBlob('gcm', gcmPayload);
    expect(blob.split('.')).toHaveLength(3);
    expect(blob.startsWith(`${BLOB_VERSION}.gcm.`)).toBe(true);
  });

  it('round-trips every algorithm in the registry', () => {
    expect(parseBlob(formatBlob('gcm', gcmPayload), 'gcm')).toEqual(gcmPayload);
    expect(parseBlob(formatBlob('x25519', sealedPayload), 'x25519')).toEqual(sealedPayload);
    expect(parseBlob(formatBlob('ed25519', signaturePayload), 'ed25519')).toEqual(signaturePayload);
  });

  it('knows exactly three algorithms', () => {
    expect([...BLOB_ALGORITHMS]).toEqual(['gcm', 'x25519', 'ed25519']);
  });

  it('refuses to render a payload shorter than its algorithm allows', () => {
    expect(() => formatBlob('gcm', randomBytes(27))).toThrow(BlobFormatError);
    expect(() => formatBlob('x25519', randomBytes(59))).toThrow(BlobFormatError);
    expect(() => formatBlob('ed25519', randomBytes(63))).toThrow(BlobFormatError);
  });
});

// ADR 0009's definition of done: every parser refuses every version it does not
// know. A blob written by a future version must fail rather than be misread.
describe('parseBlob rejects what it does not recognise', () => {
  const blob = formatBlob('gcm', gcmPayload);

  it('rejects an unknown version', () => {
    expect(() => parseBlob(blob.replace('xk2.', 'xk3.'), 'gcm')).toThrow(BlobFormatError);
    expect(() => parseBlob(blob.replace('xk2.', 'xk1.'), 'gcm')).toThrow(BlobFormatError);
    expect(() => parseBlob(blob.replace('xk2.', ''), 'gcm')).toThrow(BlobFormatError);
  });

  it('rejects an unknown algorithm tag', () => {
    expect(() => parseBlob(blob.replace('.gcm.', '.chacha20poly1305.'), 'gcm')).toThrow(
      BlobFormatError,
    );
  });

  it('rejects a blob of a known but unexpected algorithm', () => {
    expect(() => parseBlob(formatBlob('x25519', sealedPayload), 'gcm')).toThrow(BlobFormatError);
    expect(() => parseBlob(blob, 'x25519')).toThrow(BlobFormatError);
  });

  it('rejects the wrong number of fields', () => {
    expect(() => parseBlob('xk2.gcm', 'gcm')).toThrow(BlobFormatError);
    expect(() => parseBlob(`${blob}.extra`, 'gcm')).toThrow(BlobFormatError);
    expect(() => parseBlob('', 'gcm')).toThrow(BlobFormatError);
  });

  it('rejects payloads that are not unpadded base64url', () => {
    expect(() => parseBlob('xk2.gcm.AAAA====', 'gcm')).toThrow(BlobFormatError);
    expect(() => parseBlob('xk2.gcm.not+base64url/', 'gcm')).toThrow(BlobFormatError);
  });

  it('rejects a payload below the minimum for its algorithm', () => {
    expect(() => parseBlob(`xk2.gcm.${toBase64Url(randomBytes(27))}`, 'gcm')).toThrow(
      BlobFormatError,
    );
    expect(() => parseBlob(`xk2.x25519.${toBase64Url(randomBytes(59))}`, 'x25519')).toThrow(
      BlobFormatError,
    );
  });

  // A signature is exactly 64 bytes; longer is not a signature with something
  // appended, it is a different thing.
  it('rejects a signature that is not exactly 64 bytes', () => {
    expect(() => parseBlob(`xk2.ed25519.${toBase64Url(randomBytes(65))}`, 'ed25519')).toThrow(
      BlobFormatError,
    );
  });

  it('rejects a non-string', () => {
    expect(() => parseBlob(undefined as unknown as string, 'gcm')).toThrow(BlobFormatError);
    expect(() => parseBlob(42 as unknown as string, 'gcm')).toThrow(BlobFormatError);
  });

  // Blobs are key material and error messages reach logs.
  it('never echoes the payload into the error message', () => {
    try {
      parseBlob(`xk2.gcm.${toBase64Url(randomBytes(27))}`, 'gcm');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toMatch(/[A-Za-z0-9_-]{20,}/);
    }
  });
});

describe('gcm blob', () => {
  it('round-trips an IV and ciphertext', () => {
    const sealed = { iv: randomBytes(12), ciphertext: randomBytes(48) };
    expect(parseGcmBlob(formatGcmBlob(sealed))).toEqual(sealed);
  });

  it('refuses an IV that is not 12 bytes', () => {
    expect(() => formatGcmBlob({ iv: randomBytes(16), ciphertext: randomBytes(48) })).toThrow(
      BlobFormatError,
    );
  });
});

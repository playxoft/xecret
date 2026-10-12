import { describe, expect, it } from 'vitest';
import {
  decodeBase64,
  FIREBASE_SCRYPT_ENV,
  FIREBASE_SCRYPT_PUBLISHED_EXAMPLE as EXAMPLE,
  firebaseScryptHash,
  firebaseScryptPhc,
  matchesPublishedExample,
  parseFirebaseScryptParams,
  phcB64,
} from './firebase-scrypt';

const exampleEnv = {
  [FIREBASE_SCRYPT_ENV.signerKey]: EXAMPLE.signerKey,
  [FIREBASE_SCRYPT_ENV.saltSeparator]: EXAMPLE.saltSeparator,
  [FIREBASE_SCRYPT_ENV.rounds]: String(EXAMPLE.rounds),
  [FIREBASE_SCRYPT_ENV.memCost]: String(EXAMPLE.memCost),
};

const params = parseFirebaseScryptParams(exampleEnv);
const salt = decodeBase64(EXAMPLE.salt, 'salt');
const hash = decodeBase64(EXAMPLE.hash, 'hash');

describe('firebaseScryptHash', () => {
  it("reproduces Firebase's published example byte for byte", () => {
    expect(phcB64(firebaseScryptHash(EXAMPLE.password, salt, params))).toBe(phcB64(hash));
    expect(matchesPublishedExample()).toBe(true);
  });

  it('depends on the password, the salt and every project parameter', () => {
    const reference = phcB64(firebaseScryptHash(EXAMPLE.password, salt, params));
    const variants = [
      firebaseScryptHash('user1passworD', salt, params),
      firebaseScryptHash(EXAMPLE.password, new Uint8Array([...salt, 0]), params),
      firebaseScryptHash(EXAMPLE.password, salt, { ...params, saltSeparator: new Uint8Array([8]) }),
      firebaseScryptHash(EXAMPLE.password, salt, { ...params, rounds: 7 }),
      firebaseScryptHash(EXAMPLE.password, salt, { ...params, memCost: 13 }),
      firebaseScryptHash(EXAMPLE.password, salt, {
        ...params,
        signerKey: params.signerKey.map((b, i) => (i === 0 ? b ^ 1 : b)),
      }),
    ];
    for (const variant of variants) expect(phcB64(variant)).not.toBe(reference);
  });
});

describe('firebaseScryptPhc', () => {
  it("builds WorkOS's documented firebase-scrypt PHC string", () => {
    const strip = (s: string) => s.replace(/=+$/, '');
    expect(firebaseScryptPhc(hash, salt, params)).toBe(
      `$firebase-scrypt$v=1$r=8,m=14,ss=${strip(EXAMPLE.saltSeparator)},sk=${strip(EXAMPLE.signerKey)}` +
        `$${strip(EXAMPLE.salt)}$${strip(EXAMPLE.hash)}`,
    );
  });

  it('carries no base64 padding anywhere (PHC B64)', () => {
    expect(firebaseScryptPhc(hash, salt, params)).not.toContain('=$');
    expect(firebaseScryptPhc(hash, salt, params).split('$').at(-1)).not.toMatch(/=$/);
  });

  it('refuses a hash whose length is not the signer key length (wrong project)', () => {
    expect(() => firebaseScryptPhc(hash.slice(0, 32), salt, params)).toThrow(/different projects/);
  });

  it('refuses an empty salt', () => {
    expect(() => firebaseScryptPhc(hash, new Uint8Array(), params)).toThrow(/salt/);
  });
});

describe('decodeBase64', () => {
  it('accepts standard and URL-safe alphabets, padded or not', () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf, 0x01]);
    for (const encoded of ['+/+/AQ==', '+/+/AQ', '-_-_AQ==', '-_-_AQ']) {
      expect(decodeBase64(encoded, 'x')).toEqual(bytes);
    }
  });

  it('refuses what Node would silently mangle, without echoing it', () => {
    for (const bad of ['', '====', 'abc!def', 'a b c d', 'abcde']) {
      expect(() => decodeBase64(bad, 'FIELD')).toThrow('FIELD is not valid base64.');
    }
  });
});

describe('parseFirebaseScryptParams', () => {
  it('decodes the four parameters', () => {
    expect(params.signerKey).toHaveLength(64);
    expect(params.saltSeparator).toEqual(new Uint8Array([7]));
    expect(params.rounds).toBe(8);
    expect(params.memCost).toBe(14);
  });

  it.each([
    [FIREBASE_SCRYPT_ENV.signerKey, undefined, /FIREBASE_SCRYPT_SIGNER_KEY is not set/],
    [FIREBASE_SCRYPT_ENV.saltSeparator, '', /FIREBASE_SCRYPT_SALT_SEPARATOR is not set/],
    [FIREBASE_SCRYPT_ENV.rounds, undefined, /FIREBASE_SCRYPT_ROUNDS is not set/],
    [FIREBASE_SCRYPT_ENV.rounds, '8.5', /FIREBASE_SCRYPT_ROUNDS must be an integer/],
    [FIREBASE_SCRYPT_ENV.rounds, '0', /between 1 and 8/],
    [FIREBASE_SCRYPT_ENV.memCost, '15', /between 1 and 14/],
    [
      FIREBASE_SCRYPT_ENV.signerKey,
      'not base64!',
      /FIREBASE_SCRYPT_SIGNER_KEY is not valid base64/,
    ],
  ])('names %s when it is %s', (name, value, message) => {
    expect(() => parseFirebaseScryptParams({ ...exampleEnv, [name]: value })).toThrow(message);
  });

  it('never puts a value in an error', () => {
    const secretish = 'c2VjcmV0LXNpZ25lci1rZXktdmFsdWU!';
    try {
      parseFirebaseScryptParams({ ...exampleEnv, [FIREBASE_SCRYPT_ENV.signerKey]: secretish });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain(secretish);
      expect(String(error)).not.toContain('c2VjcmV0');
    }
  });
});

import { describe, expect, it } from 'vitest';
import { parseFirebaseExport } from './firebase-export';

/**
 * Records shaped like `firebase auth:export --format=json` writes them. The
 * hash and salt are counting bytes, encoded here rather than written out: a
 * base64 literal next to `passwordHash` is exactly what the secret scan is for.
 * `HASH` includes 0xfb/0xff so its base64 uses both `+` and `/`.
 */
const HASH = Uint8Array.from([0xfb, 0xff, 0xbf, ...Array.from({ length: 13 }, (_, i) => i)]);
const SALT = Uint8Array.from({ length: 8 }, (_, i) => 16 + i);
const standard = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const urlSafeUnpadded = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

const passwordUser = {
  localId: 'uidPassword0000000000000001',
  email: 'ada@example.com',
  emailVerified: true,
  passwordHash: standard(HASH),
  salt: standard(SALT),
  displayName: 'Ada Lovelace',
  createdAt: '1700000000000',
  providerUserInfo: [
    { providerId: 'password', rawId: 'ada@example.com', email: 'ada@example.com' },
  ],
};

const googleUser = {
  localId: 'uidGoogle00000000000000002',
  email: 'grace@example.com',
  emailVerified: true,
  providerUserInfo: [
    {
      providerId: 'google.com',
      rawId: '1234',
      displayName: 'Grace Hopper',
      email: 'grace@example.com',
    },
  ],
};

describe('parseFirebaseExport', () => {
  it('reads a password user and a Google user', () => {
    const [ada, grace] = parseFirebaseExport({ users: [passwordUser, googleUser] });
    expect(ada).toMatchObject({
      uid: passwordUser.localId,
      email: 'ada@example.com',
      emailVerified: true,
      disabled: false,
      displayName: 'Ada Lovelace',
      mfaEnrolled: false,
      providers: [{ providerId: 'password', displayName: null }],
    });
    expect(ada?.password).toEqual({ hash: HASH, salt: SALT });
    expect(grace).toMatchObject({
      uid: googleUser.localId,
      password: null,
      displayName: null,
      providers: [{ providerId: 'google.com', displayName: 'Grace Hopper' }],
    });
  });

  it('decodes URL-safe or unpadded hashes the same as standard base64', () => {
    expect(standard(HASH)).toMatch(/[+/]/);
    const [user] = parseFirebaseExport({
      users: [
        { ...passwordUser, passwordHash: urlSafeUnpadded(HASH), salt: urlSafeUnpadded(SALT) },
      ],
    });
    expect(user?.password).toEqual({ hash: HASH, salt: SALT });
  });

  it('marks a password that will not decode, or half a password, as malformed — without throwing', () => {
    const users = parseFirebaseExport({
      users: [
        { ...passwordUser, localId: 'a', passwordHash: 'not*base64' },
        { ...passwordUser, localId: 'b', salt: undefined },
        { ...passwordUser, localId: 'c', passwordHash: '' },
      ],
    });
    expect(users.map((u) => u.password)).toEqual(['malformed', 'malformed', 'malformed']);
  });

  it('treats absent flags as false, and reads disabled and MFA', () => {
    const [user] = parseFirebaseExport({
      users: [{ localId: 'x', disabled: true, mfaInfo: [{ phoneInfo: '+1555' }] }],
    });
    expect(user).toMatchObject({
      email: null,
      emailVerified: false,
      disabled: true,
      mfaEnrolled: true,
    });
  });

  it.each([
    [null, /expected an object with a "users" array/],
    [{ users: {} }, /expected an object with a "users" array/],
    [{ users: [42] }, /users\[0\] is not an object/],
    [{ users: [{ email: 'a@b.c' }] }, /users\[0\]: "localId" is missing/],
    [{ users: [{ localId: 'x' }, { localId: 'x' }] }, /users\[1\]: uid x appears more than once/],
    [{ users: [{ localId: 'x', emailVerified: 'yes' }] }, /"emailVerified" is not a boolean/],
    [{ users: [{ localId: 'x', email: 7 }] }, /"email" is not a string/],
    [{ users: [{ localId: 'x', providerUserInfo: {} }] }, /"providerUserInfo" is not an array/],
    [{ users: [{ localId: 'x', providerUserInfo: [{}] }] }, /"providerId" is missing/],
  ])('refuses structural damage: %j', (json, message) => {
    expect(() => parseFirebaseExport(json)).toThrow(message);
  });

  it('never echoes a password field in an error', () => {
    const hash = standard(new TextEncoder().encode('a hash that must not be echoed'));
    let message = '';
    try {
      parseFirebaseExport({ users: [{ ...passwordUser, passwordHash: hash }, { email: 'x' }] });
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/users\[1\]: "localId" is missing/);
    expect(message).not.toContain(hash);
  });
});

import { describe, expect, it } from 'vitest';
import type { FirebaseExportUser } from './firebase-export';
import {
  buildCreateUserInput,
  classifyFirebaseUser,
  decideImport,
  sameAddress,
  splitDisplayName,
} from './import-plan';
import type { ImportCandidate } from './import-plan';
import type { WorkosUserSummary } from './workos-api';

const password = { hash: new Uint8Array([1, 2, 3]), salt: new Uint8Array([4, 5]) };

function firebaseUser(over: Partial<FirebaseExportUser> = {}): FirebaseExportUser {
  return {
    uid: 'fbUid0000000000000000000001',
    email: 'ada@example.com',
    emailVerified: true,
    disabled: false,
    displayName: 'Ada Lovelace',
    password,
    providers: [{ providerId: 'password', displayName: null }],
    mfaEnrolled: false,
    ...over,
  };
}

const google = { providerId: 'google.com', displayName: 'Grace Brewster Hopper' };

describe('classifyFirebaseUser', () => {
  it('imports a verified password user with its hash', () => {
    expect(classifyFirebaseUser(firebaseUser())).toEqual({
      action: 'import',
      candidate: {
        uid: 'fbUid0000000000000000000001',
        email: 'ada@example.com',
        kind: 'password',
        firstName: 'Ada',
        lastName: 'Lovelace',
        password,
      },
    });
  });

  it('imports a Google-only user without a password, named from Google when Firebase has no name', () => {
    const result = classifyFirebaseUser(
      firebaseUser({ password: null, displayName: null, providers: [google] }),
    );
    expect(result).toMatchObject({
      action: 'import',
      candidate: {
        kind: 'google-only',
        password: null,
        firstName: 'Grace',
        lastName: 'Brewster Hopper',
      },
    });
  });

  it('prefers the Firebase display name over the provider one', () => {
    const result = classifyFirebaseUser(firebaseUser({ password: null, providers: [google] }));
    expect(result).toMatchObject({ candidate: { firstName: 'Ada', lastName: 'Lovelace' } });
  });

  it('a user with both a password and Google is a password user', () => {
    const result = classifyFirebaseUser(
      firebaseUser({ providers: [google, { providerId: 'password', displayName: null }] }),
    );
    expect(result).toMatchObject({ candidate: { kind: 'password', password } });
  });

  it('imports a user of some other provider without a password', () => {
    const result = classifyFirebaseUser(
      firebaseUser({
        password: null,
        providers: [{ providerId: 'github.com', displayName: null }],
      }),
    );
    expect(result).toMatchObject({ candidate: { kind: 'other-provider-only', password: null } });
  });

  // The pre-account-takeover rule (PR #100 note 12): an unverified address is
  // never imported — not with its password, and not without one.
  it('skips an unverified user, password or not', () => {
    expect(classifyFirebaseUser(firebaseUser({ emailVerified: false }))).toEqual({
      action: 'skip',
      uid: 'fbUid0000000000000000000001',
      reason: 'email-unverified',
    });
    expect(
      classifyFirebaseUser(
        firebaseUser({ emailVerified: false, password: null, providers: [google] }),
      ),
    ).toMatchObject({ action: 'skip', reason: 'email-unverified' });
  });

  it('skips a disabled user even when verified, ahead of every other rule', () => {
    expect(classifyFirebaseUser(firebaseUser({ disabled: true }))).toMatchObject({
      action: 'skip',
      reason: 'disabled',
    });
    expect(
      classifyFirebaseUser(firebaseUser({ disabled: true, emailVerified: false })),
    ).toMatchObject({
      reason: 'disabled',
    });
  });

  it('skips a user with no address', () => {
    expect(classifyFirebaseUser(firebaseUser({ email: null, disabled: true }))).toMatchObject({
      action: 'skip',
      reason: 'no-email',
    });
  });

  it('skips a malformed password rather than importing the user without it', () => {
    expect(classifyFirebaseUser(firebaseUser({ password: 'malformed' }))).toMatchObject({
      action: 'skip',
      reason: 'malformed-password',
    });
  });
});

describe('splitDisplayName', () => {
  it.each([
    ['Ada Lovelace', { firstName: 'Ada', lastName: 'Lovelace' }],
    ['  Ada   King  Lovelace ', { firstName: 'Ada', lastName: 'King Lovelace' }],
    ['Cher', { firstName: 'Cher' }],
    ['', {}],
    ['   ', {}],
    [null, {}],
    [undefined, {}],
    ['Ada\nLovelace\u0007', { firstName: 'Ada', lastName: 'Lovelace' }],
    ['José Ñúñez', { firstName: 'José', lastName: 'Ñúñez' }],
  ])('%j', (input, expected) => {
    expect(splitDisplayName(input)).toEqual(expected);
  });
});

describe('sameAddress', () => {
  it('folds ASCII case', () => {
    expect(sameAddress('Ada@Example.COM', 'ada@example.com')).toBe(true);
  });

  it('does not fold non-ASCII: the Kelvin sign is not a k', () => {
    expect(sameAddress('Kim@example.com', 'kim@example.com')).toBe(false);
    expect(sameAddress('Kim@example.com', 'Kim@example.com')).toBe(true);
  });

  it('differs on anything else', () => {
    expect(sameAddress('ada@example.com', 'ada@example.co')).toBe(false);
    expect(sameAddress(' ada@example.com', 'ada@example.com')).toBe(false);
  });
});

describe('decideImport', () => {
  const candidate = { uid: 'fbUid1', email: 'ada@example.com' };
  const workos = (over: Partial<WorkosUserSummary> = {}): WorkosUserSummary => ({
    id: 'user_01ABC',
    email: 'ada@example.com',
    emailVerified: true,
    externalId: 'fbUid1',
    ...over,
  });

  it('creates when WorkOS has neither the uid nor the address', () => {
    expect(decideImport(candidate, null, null)).toEqual({ action: 'create' });
  });

  it('is idempotent: a user found by external id was imported already', () => {
    expect(decideImport(candidate, workos(), null)).toEqual({
      action: 'already-imported',
      workosUserId: 'user_01ABC',
    });
    expect(decideImport(candidate, workos({ email: 'ADA@example.com' }), null)).toMatchObject({
      action: 'already-imported',
    });
  });

  it('the external id wins over a different user holding the address', () => {
    expect(
      decideImport(candidate, workos(), workos({ id: 'user_02', externalId: null })),
    ).toMatchObject({ action: 'already-imported', workosUserId: 'user_01ABC' });
  });

  it('reports, does not reuse, an imported user whose address has since changed', () => {
    expect(decideImport(candidate, workos({ email: 'other@example.com' }), null)).toEqual({
      action: 'conflict',
      reason: 'external-id-email-mismatch',
      workosUserId: 'user_01ABC',
    });
  });

  it('reports an imported user that is no longer verified', () => {
    expect(decideImport(candidate, workos({ emailVerified: false }), null)).toMatchObject({
      action: 'conflict',
      reason: 'imported-user-unverified',
    });
  });

  it('reuses a verified WorkOS user holding the address that nobody imported', () => {
    expect(decideImport(candidate, null, workos({ externalId: null }))).toEqual({
      action: 'reuse-existing',
      workosUserId: 'user_01ABC',
    });
  });

  it('treats an address lookup that carries this uid as the imported user', () => {
    expect(decideImport(candidate, null, workos())).toMatchObject({ action: 'already-imported' });
  });

  it('never takes over an address held by another identity', () => {
    expect(decideImport(candidate, null, workos({ externalId: 'someone-else' }))).toEqual({
      action: 'conflict',
      reason: 'email-held-by-other-identity',
      workosUserId: 'user_01ABC',
    });
  });

  // The mirror of the unverified-skip rule: an unverified WorkOS user may carry
  // a password somebody else chose. Mapping it would hand them the account.
  it('never maps onto an unverified WorkOS user holding the address', () => {
    expect(
      decideImport(candidate, null, workos({ externalId: null, emailVerified: false })),
    ).toEqual({
      action: 'conflict',
      reason: 'email-held-by-unverified-user',
      workosUserId: 'user_01ABC',
    });
  });
});

describe('buildCreateUserInput', () => {
  const base: ImportCandidate = {
    uid: 'fbUid1',
    email: 'ada@example.com',
    kind: 'password',
    firstName: 'Ada',
    lastName: 'Lovelace',
    password,
  };

  it('sends a password user verified, named, keyed by uid, with its hash', () => {
    expect(buildCreateUserInput(base, '$firebase-scrypt$v=1$…')).toEqual({
      email: 'ada@example.com',
      emailVerified: true,
      firstName: 'Ada',
      lastName: 'Lovelace',
      externalId: 'fbUid1',
      firebaseScryptHash: '$firebase-scrypt$v=1$…',
    });
  });

  it('sends a Google-only user without any password field, and omits absent names', () => {
    const input = buildCreateUserInput(
      { uid: 'fbUid2', email: 'g@example.com', kind: 'google-only', password: null },
      null,
    );
    expect(input).toEqual({ email: 'g@example.com', emailVerified: true, externalId: 'fbUid2' });
  });

  it('omits an external id longer than WorkOS allows', () => {
    const input = buildCreateUserInput({ ...base, uid: 'u'.repeat(65) }, 'h');
    expect(input).not.toHaveProperty('externalId');
    expect(buildCreateUserInput({ ...base, uid: 'u'.repeat(64) }, 'h')).toHaveProperty(
      'externalId',
    );
  });

  it('refuses a hash for a non-password user, and a password user without one', () => {
    expect(() => buildCreateUserInput(base, null)).toThrow(TypeError);
    expect(() =>
      buildCreateUserInput({ ...base, kind: 'google-only', password: null }, 'h'),
    ).toThrow(TypeError);
  });
});

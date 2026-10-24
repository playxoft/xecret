import { describe, expect, it } from 'vitest';
import { deriveOAuthStateKey } from './oauth-state';
import {
  deriveLastAccountKey,
  LAST_ACCOUNT_COOKIE_NAME,
  lastAccountCookie,
  openLastAccount,
  sealLastAccount,
} from './last-account';

/**
 * "The last account on this browser" (review round 2): what lets a returning
 * person past the reused-session confirmation, and only them — so it must name
 * exactly the account it was written for, and nothing this module did not
 * write may name one at all.
 */

const SECRET = 'a-perfectly-random-thirty-two-plus-character-secret';
const ACCOUNT = '0198c0de-0000-7000-8000-00000000000a';

async function key() {
  return deriveLastAccountKey(SECRET);
}

describe('the last-account cookie', () => {
  it('opens to the account it was sealed for', async () => {
    const sealed = await sealLastAccount(await key(), ACCOUNT);
    expect(await openLastAccount(await key(), sealed)).toBe(ACCOUNT);
  });

  it('names nobody once its account id is changed — a planted session is always somebody else', async () => {
    const sealed = await sealLastAccount(await key(), ACCOUNT);
    const [version, , mac] = sealed.split('.');
    expect(
      await openLastAccount(await key(), `${version}.0198c0de-0000-7000-8000-00000000000b.${mac}`),
    ).toBeNull();
  });

  it('names nobody under another cookie’s key', async () => {
    const sealed = await sealLastAccount(await deriveOAuthStateKey(SECRET), ACCOUNT);
    expect(await openLastAccount(await key(), sealed)).toBeNull();
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['the wrong shape', 'a1.only-two'],
    ['the wrong version', `a0.${ACCOUNT}.AAAA`],
    ['not an account id', 'a1.admin.AAAA'],
    ['over-long', `a1.${'a'.repeat(400)}`],
  ])('names nobody when %s', async (_label, cookie) => {
    expect(await openLastAccount(await key(), cookie)).toBeNull();
  });

  it('is __Host-, HttpOnly, Secure, Lax and long-lived', async () => {
    const header = lastAccountCookie(await sealLastAccount(await key(), ACCOUNT));
    expect(LAST_ACCOUNT_COOKIE_NAME.startsWith('__Host-')).toBe(true);
    for (const attribute of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']) {
      expect(header.split('; ')).toContain(attribute);
    }
    const maxAge = Number(/Max-Age=(\d+)/.exec(header)?.[1]);
    expect(maxAge).toBeGreaterThanOrEqual(30 * 24 * 60 * 60);
  });

  it('is never sealed for something that is not an account id', async () => {
    await expect(sealLastAccount(await key(), 'admin')).rejects.toBeInstanceOf(RangeError);
  });
});

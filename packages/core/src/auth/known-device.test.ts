import { describe, expect, it } from 'vitest';
import { toBase64Url, utf8Encode } from '../crypto/encoding';
import { deriveEmailVerificationKey } from './email-verification';
import {
  deriveKnownDeviceKey,
  deriveSignInThrottleKey,
  foldAddress,
  generateDeviceId,
  KNOWN_DEVICE_COOKIE_NAME,
  KNOWN_DEVICE_TTL_SECONDS,
  knownDeviceCookie,
  openKnownDevice,
  sealKnownDevice,
} from './known-device';

/**
 * The known-device cookie: a browser some account signed in on, which the
 * sign-in throttle budgets apart from everybody else. Pinned here: it comes
 * back exactly as sealed, and anything this module did not write — another
 * key, an edit, an age past ninety days — reads as no device at all.
 */

const SECRET = 'a-perfectly-random-thirty-two-plus-character-secret';
const NOW = new Date('2026-11-08T10:00:00Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

function device(over: Partial<{ deviceId: string; email: string; issuedAt: number }> = {}) {
  return { deviceId: generateDeviceId(), email: 'Pat@Example.com', issuedAt: NOW_SECONDS, ...over };
}

describe('the known-device cookie', () => {
  it('names a device and an address, and gives them back', async () => {
    const key = await deriveKnownDeviceKey(SECRET);
    const value = device();

    expect(await openKnownDevice(key, await sealKnownDevice(key, value), NOW)).toEqual(value);
  });

  it('mints a fresh 256-bit id each time', () => {
    const ids = new Set(Array.from({ length: 50 }, generateDeviceId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('reads nothing sealed under another cookie’s key', async () => {
    const sealed = await sealKnownDevice(await deriveEmailVerificationKey(SECRET), device());
    expect(await openKnownDevice(await deriveKnownDeviceKey(SECRET), sealed, NOW)).toBeNull();
  });

  it('reads nothing whose address was swapped after sealing', async () => {
    const key = await deriveKnownDeviceKey(SECRET);
    const value = device();
    const [version, , mac] = (await sealKnownDevice(key, value)).split('.');
    const forged = toBase64Url(
      utf8Encode(JSON.stringify({ d: value.deviceId, e: 'victim@example.com', t: NOW_SECONDS })),
    );
    expect(await openKnownDevice(key, `${version}.${forged}.${mac}`, NOW)).toBeNull();
  });

  it('reads nothing past its ninety days, or dated in the future', async () => {
    const key = await deriveKnownDeviceKey(SECRET);
    const old = await sealKnownDevice(
      key,
      device({ issuedAt: NOW_SECONDS - KNOWN_DEVICE_TTL_SECONDS - 1 }),
    );
    const ahead = await sealKnownDevice(key, device({ issuedAt: NOW_SECONDS + 600 }));
    expect(await openKnownDevice(key, old, NOW)).toBeNull();
    expect(await openKnownDevice(key, ahead, NOW)).toBeNull();
  });

  it.each([undefined, null, '', 'd1.a', 'd2.a.b', 'd1.e30.AAAA', `d1.${'A'.repeat(2000)}.AAAA`])(
    'reads %j as no device',
    async (cookie) => {
      expect(await openKnownDevice(await deriveKnownDeviceKey(SECRET), cookie, NOW)).toBeNull();
    },
  );

  it('refuses to seal what it would not read back', async () => {
    const key = await deriveKnownDeviceKey(SECRET);
    for (const value of [
      device({ deviceId: 'short' }),
      device({ email: 'no-at-sign' }),
      device({ email: 'line\nbreak@example.com' }),
      device({ issuedAt: 0 }),
    ]) {
      await expect(sealKnownDevice(key, value)).rejects.toBeInstanceOf(RangeError);
    }
  });

  it('is HttpOnly, Secure, SameSite=Strict, __Host- and ninety days', () => {
    const set = knownDeviceCookie('d1.a.b');
    expect(set.startsWith(`${KNOWN_DEVICE_COOKIE_NAME}=d1.a.b;`)).toBe(true);
    expect(KNOWN_DEVICE_COOKIE_NAME.startsWith('__Host-')).toBe(true);
    for (const part of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict']) {
      expect(set).toContain(part);
    }
    expect(set).toContain(`Max-Age=${KNOWN_DEVICE_TTL_SECONDS}`);
    expect(KNOWN_DEVICE_TTL_SECONDS).toBe(90 * 24 * 60 * 60);
  });
});

describe('the sign-in throttle key', () => {
  it('is an HMAC key of its own: same secret, different label, different digest', async () => {
    const throttle = await deriveSignInThrottleKey(SECRET);
    const cookie = await deriveKnownDeviceKey(SECRET);
    const data = utf8Encode('address:pat@example.com');
    const a = new Uint8Array(await crypto.subtle.sign('HMAC', throttle, data));
    const b = new Uint8Array(await crypto.subtle.sign('HMAC', cookie, data));
    expect(a).toHaveLength(32);
    expect(toBase64Url(a)).not.toBe(toBase64Url(b));
  });
});

describe('foldAddress', () => {
  it('folds spaces and ASCII capitals, and nothing else', () => {
    expect(foldAddress(' Pat@Example.COM ')).toBe('pat@example.com');
    expect(foldAddress('pаt@example.com')).toBe('pаt@example.com');
  });
});

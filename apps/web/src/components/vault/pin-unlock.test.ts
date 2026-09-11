import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toBase64Url, wrapPrivateKey, wrapUserKeyWithPin } from '@xecret/core/crypto/client';
import type { Argon2idProvider, Bytes } from '@xecret/core/crypto/client';
import { uuidv7 } from '@xecret/core/ids';

/**
 * The PIN unlock, on the far side of a successful attempt.
 *
 * ── Why this is the half worth testing ──
 * Everything before the attempt is ordinary: six digits, a verifier, a request.
 * What is unusual about this credential is the *order* — the server marks the
 * session unlocked and releases the pepper in one answer, and only then does the
 * browser find out whether it can use either. So between the response arriving
 * and the keys being held, there is a window in which a throw leaves a session
 * the API considers open and a browser that holds nothing: the dashboard renders
 * with no lock screen and nothing on it decrypts.
 *
 * These pin the recovery from that window, and the fact that it covers the
 * *whole* of it rather than only the unwrap.
 */

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: apiMock,
}));

const { ApiError } = await import('@/lib/api');
const { describePinUnlockFailure, unlockWithPin } = await import('./vault-client');
const { readVaultKeys, releaseVaultKeys } = await import('./key-store');
const { DEVICE_PIN_WRAP_KEY, DEVICE_PIN_WRAP_VERSION } = await import('./device-pin');

const USER_ID = uuidv7();
const DEVICE_ID = uuidv7();
const PIN = '246813';

/** What the server hands back for the *next* wrap, on every success. */
const NEXT_PEPPER = new Uint8Array(32).fill(77);

/** Deterministic and instant. The KDF is not what these tests are about. */
const fakeArgon2id: Argon2idProvider = (_password, _salt, params) =>
  Promise.resolve(new Uint8Array(params.len).fill(9));

/** A `Storage` that can be inspected. These tests run without a DOM. */
function fakeStorage(): Storage & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    length: 0,
    key: () => null,
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  } as unknown as Storage & { entries: Map<string, string> };
}

let local: ReturnType<typeof fakeStorage>;

/** A wrap this browser really could open, given the pepper the server holds. */
async function enrolLocally(pepper: Bytes, userKey: Bytes): Promise<void> {
  const salt = new Uint8Array(16).fill(3);
  const pinKey = await fakeArgon2id(new Uint8Array(), salt, {
    alg: 'argon2id',
    v: 19,
    m: 19_456,
    t: 2,
    p: 1,
    len: 32,
  });

  local.setItem(
    DEVICE_PIN_WRAP_KEY,
    JSON.stringify({
      version: DEVICE_PIN_WRAP_VERSION,
      deviceId: DEVICE_ID,
      salt: toBase64Url(salt),
      wrap: await wrapUserKeyWithPin({
        pinKey,
        pepper,
        userKey,
        context: { userId: USER_ID, deviceId: DEVICE_ID },
      }),
    }),
  );
}

/** Material whose private-key wraps no User Key will ever open. */
function brokenMaterial() {
  const junk = `xk2.gcm.${toBase64Url(new Uint8Array(60).fill(1))}`;
  return {
    kdfSalt: toBase64Url(new Uint8Array(16)),
    kdfParams: { alg: 'argon2id', v: 19, m: 19_456, t: 2, p: 1, len: 32 },
    userKeyWrap: junk,
    encPrivateKeyEnc: junk,
    signPrivateKeyEnc: junk,
    encPublicKey: toBase64Url(new Uint8Array(32).fill(2)),
    signPublicKey: toBase64Url(new Uint8Array(32).fill(3)),
    recoveryCodesRemaining: 5,
    passkeys: [],
  } as unknown as Parameters<typeof unlockWithPin>[0]['material'];
}

/** Material this User Key really does open, for the success path. */
async function workingMaterial(userKey: Bytes) {
  const encPrivateKey = new Uint8Array(32).fill(21);
  const signPrivateKey = new Uint8Array(32).fill(22);

  return {
    kdfSalt: toBase64Url(new Uint8Array(16)),
    kdfParams: { alg: 'argon2id', v: 19, m: 19_456, t: 2, p: 1, len: 32 },
    userKeyWrap: `xk2.gcm.${toBase64Url(new Uint8Array(60).fill(1))}`,
    encPrivateKeyEnc: await wrapPrivateKey({
      userKey,
      privateKey: encPrivateKey,
      userId: USER_ID,
      purpose: 'encryption',
    }),
    signPrivateKeyEnc: await wrapPrivateKey({
      userKey,
      privateKey: signPrivateKey,
      userId: USER_ID,
      purpose: 'signing',
    }),
    encPublicKey: toBase64Url(new Uint8Array(32).fill(2)),
    signPublicKey: toBase64Url(new Uint8Array(32).fill(3)),
    recoveryCodesRemaining: 5,
    passkeys: [],
  } as unknown as Parameters<typeof unlockWithPin>[0]['material'];
}

beforeEach(() => {
  vi.clearAllMocks();
  local = fakeStorage();
  Object.defineProperty(globalThis, 'window', {
    value: { localStorage: local, sessionStorage: fakeStorage() },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  releaseVaultKeys();
  Reflect.deleteProperty(globalThis, 'window');
});

describe('the pepper a successful attempt spends', () => {
  it('replaces the stored wrap with one under the pepper for next time', async () => {
    // A pepper crosses the wire on every unlock, so one that never changes only
    // has to be intercepted once: with a copy of this browser's
    // `localStorage`, the pair opens the User Key for ever and needs no server
    // — which is why revoking the enrolment afterwards would not take it back.
    // The server rotates on the way out, and this is the client's half of it.
    const pepper = new Uint8Array(32).fill(5);
    const userKey = new Uint8Array(32).fill(8);
    await enrolLocally(pepper, userKey);
    const before = local.getItem(DEVICE_PIN_WRAP_KEY) as string;

    apiMock.post.mockResolvedValue({
      pin: {
        outcome: 'unlocked',
        pepper: toBase64Url(pepper),
        nextPepper: toBase64Url(NEXT_PEPPER),
        unlockedUntil: new Date().toISOString(),
      },
      vault: { configured: true, unlocked: true, unlockedUntil: null, autoLockMinutes: 60 },
    });

    const result = await unlockWithPin({
      userId: USER_ID,
      pin: PIN,
      material: await workingMaterial(userKey),
      argon2id: fakeArgon2id,
    });

    expect(result.outcome).toBe('unlocked');
    expect(readVaultKeys()?.userId).toBe(USER_ID);

    const after = JSON.parse(local.getItem(DEVICE_PIN_WRAP_KEY) as string) as {
      deviceId: string;
      salt: string;
      wrap: string;
    };
    const previous = JSON.parse(before) as { deviceId: string; salt: string; wrap: string };

    // A new ciphertext, under the same PIN and the same salt: nothing the user
    // types changes, and the device keeps its identity on the server.
    expect(after.wrap).not.toBe(previous.wrap);
    expect(after.salt).toBe(previous.salt);
    expect(after.deviceId).toBe(previous.deviceId);
  });

  it('clears the record rather than keeping a wrap the new pepper does not match', async () => {
    // The old pepper is already dead by the time the re-wrap runs, so a failure
    // here leaves a record that can only ever fail. Better to ask for a fresh
    // enrolment than to leave a PIN box on the lock screen that opens nothing.
    const pepper = new Uint8Array(32).fill(5);
    const userKey = new Uint8Array(32).fill(8);
    await enrolLocally(pepper, userKey);

    // The storage refuses the write, which is what a browser in private mode or
    // over quota does.
    local.setItem = () => {
      throw new Error('quota exceeded');
    };

    apiMock.post.mockResolvedValue({
      pin: {
        outcome: 'unlocked',
        pepper: toBase64Url(pepper),
        nextPepper: toBase64Url(NEXT_PEPPER),
        unlockedUntil: new Date().toISOString(),
      },
      vault: { configured: true, unlocked: true, unlockedUntil: null, autoLockMinutes: 60 },
    });

    const result = await unlockWithPin({
      userId: USER_ID,
      pin: PIN,
      material: await workingMaterial(userKey),
      argon2id: fakeArgon2id,
    });

    // The unlock itself still succeeds — the keys are in hand, and failing it
    // would ask for a passphrase this browser has just proved it does not need.
    expect(result.outcome).toBe('unlocked');
    expect(local.entries.has(DEVICE_PIN_WRAP_KEY)).toBe(false);
  });
});

describe('a PIN attempt the server accepted', () => {
  it('locks the session and clears the wrap when the keys cannot be opened', async () => {
    // The regression. The unwrap succeeds — the pepper and the wrap really are
    // a pair — and `openPrivateKeys` then fails on material belonging to a
    // vault this User Key no longer opens. That used to throw straight out of
    // `unlockWithPin`, past the mismatch handling, leaving the session marked
    // unlocked on the server with no key material in the browser at all.
    const pepper = new Uint8Array(32).fill(5);
    await enrolLocally(pepper, new Uint8Array(32).fill(8));

    const posted: string[] = [];
    apiMock.post.mockImplementation(async (path: string) => {
      posted.push(path);
      if (path === '/api/auth/vault/pin/attempt') {
        return {
          pin: {
            outcome: 'unlocked',
            pepper: toBase64Url(pepper),
            nextPepper: toBase64Url(NEXT_PEPPER),
            unlockedUntil: new Date().toISOString(),
          },
          vault: { configured: true, unlocked: true, unlockedUntil: null, autoLockMinutes: 60 },
        };
      }
      return { locked: 1 };
    });

    const result = await unlockWithPin({
      userId: USER_ID,
      pin: PIN,
      material: brokenMaterial(),
      argon2id: fakeArgon2id,
    });

    expect(result).toEqual({ outcome: 'mismatch' });
    // The session the attempt opened is closed again, through the same endpoint
    // the Lock button uses.
    expect(posted).toContain('/api/auth/vault/lock');
    // And the local record is gone, so the next lock screen offers the
    // passphrase rather than an entry box that can only fail.
    expect(local.entries.has(DEVICE_PIN_WRAP_KEY)).toBe(false);
    expect(readVaultKeys()).toBeNull();
  });

  it('locks and clears when the wrap and the pepper belong to different enrolments', async () => {
    // The case that was already handled, kept so the widened `catch` does not
    // quietly change it: a wrap copied from another profile, or left behind by
    // a vault that has since been reset.
    await enrolLocally(new Uint8Array(32).fill(5), new Uint8Array(32).fill(8));

    const posted: string[] = [];
    apiMock.post.mockImplementation(async (path: string) => {
      posted.push(path);
      if (path === '/api/auth/vault/pin/attempt') {
        return {
          pin: {
            outcome: 'unlocked',
            // A different pepper: the verifier matched, the wrap will not open.
            pepper: toBase64Url(new Uint8Array(32).fill(6)),
            nextPepper: toBase64Url(NEXT_PEPPER),
            unlockedUntil: new Date().toISOString(),
          },
          vault: { configured: true, unlocked: true, unlockedUntil: null, autoLockMinutes: 60 },
        };
      }
      return { locked: 1 };
    });

    const result = await unlockWithPin({
      userId: USER_ID,
      pin: PIN,
      material: brokenMaterial(),
      argon2id: fakeArgon2id,
    });

    expect(result).toEqual({ outcome: 'mismatch' });
    expect(posted).toContain('/api/auth/vault/lock');
    expect(local.entries.has(DEVICE_PIN_WRAP_KEY)).toBe(false);
  });

  it('keeps a wrap the server merely counted a miss against', async () => {
    // The one failure that is not fatal to the enrolment, and the reason a
    // burn and a miss are separate answers.
    await enrolLocally(new Uint8Array(32).fill(5), new Uint8Array(32).fill(8));
    apiMock.post.mockResolvedValue({
      pin: { outcome: 'wrong', attemptsRemaining: 3 },
      vault: { configured: true, unlocked: false, unlockedUntil: null, autoLockMinutes: 60 },
    });

    expect(
      await unlockWithPin({
        userId: USER_ID,
        pin: PIN,
        material: brokenMaterial(),
        argon2id: fakeArgon2id,
      }),
    ).toEqual({ outcome: 'wrong', attemptsRemaining: 3 });

    expect(local.entries.has(DEVICE_PIN_WRAP_KEY)).toBe(true);
  });
});

describe('what a failed PIN attempt is called on screen', () => {
  it('never talks about a passphrase', () => {
    // The alert around this message is titled about a PIN. Telling somebody who
    // has just typed six digits that their passphrase is case-sensitive is the
    // passphrase path's sentence rendered under the wrong heading.
    for (const cause of [new Error('boom'), null, undefined, 'nope']) {
      expect(describePinUnlockFailure(cause).toLowerCase()).not.toContain('passphrase did not');
    }
  });

  it('passes the server’s own words through, including a backoff it computed', () => {
    const rateLimited = new ApiError({
      code: 'rate_limited',
      message: 'Too many attempts. Try again in 4 minutes.',
      status: 429,
      requestId: null,
    });

    expect(describePinUnlockFailure(rateLimited)).toBe(
      'Too many attempts. Try again in 4 minutes.',
    );
  });

  it('says the attempt did not happen when the network is what failed', () => {
    const offline = new ApiError({
      code: 'network_error',
      message: 'fetch failed',
      status: 0,
      requestId: null,
    });
    const message = describePinUnlockFailure(offline);

    expect(message).toContain('not unlocked');
    expect(message).not.toBe('fetch failed');
  });
});

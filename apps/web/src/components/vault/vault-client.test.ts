import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DecryptionError,
  derivePassphraseWrapKey,
  deriveStretchedKey,
  fromBase64Url,
  unwrapUserKey,
} from '@xecret/core/crypto/client';
import type { Argon2idProvider, Bytes } from '@xecret/core/crypto/client';

import { ApiError } from '@/lib/api';
import { readVaultKeys, releaseVaultKeys } from './key-store';
import {
  beginRecovery,
  buildRecoveryKit,
  buildVaultCreate,
  completeRecovery,
  describeUnlockFailure,
  openRecoveryWrap,
  readRecoveryCode,
  unlockWithPassphrase,
} from './vault-client';
import type { VaultMaterial, VaultStatus } from './vault-client';

/**
 * The compositions, against real cryptography.
 *
 * ── Why this is not a mock of the crypto layer ──
 * Because the thing that can go wrong here is not "did we call the right
 * function", it is "does what we uploaded actually open". A wrap built with the
 * wrong AAD, a lookup hash computed over the display form instead of the bytes,
 * a recovery that reissued four codes: every one of those passes a mocked test
 * and produces a vault nobody can get back into. So HKDF, AES-GCM and the
 * recovery codec all run for real, and the assertions are unwraps.
 *
 * Only two things are substituted. Argon2id, through the seam `packages/core`
 * defines, because a second per assertion buys nothing the real function proves
 * — the passphrase-to-key mapping is `deriveStretchedKey`'s own tested contract,
 * and what matters here is that the *same* passphrase reaches the *same* wrap.
 * And the HTTP client, because the endpoints are Phase 2a's and are tested in
 * `server/vault.test.ts`; what is under test here is the shape of the body.
 */

/**
 * A cheap, deterministic stand-in for Argon2id.
 *
 * Deterministic in the passphrase *and* the salt, which is what makes the tests
 * below meaningful: a change of salt must produce a different stretched key, or
 * "the passphrase change re-derived at a fresh salt" would be unfalsifiable.
 */
const fakeArgon2id: Argon2idProvider = async (password, salt) => {
  const input = new Uint8Array(password.length + salt.length);
  input.set(password, 0);
  input.set(salt, password.length);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input));
};

const USER_ID = '018f3f6a-0000-7000-8000-000000000001';

const posted: { path: string; body: unknown }[] = [];
let nextResponse: unknown = null;

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      get: vi.fn(),
      post: vi.fn((path: string, body: unknown) => {
        posted.push({ path, body });
        return Promise.resolve(nextResponse);
      }),
      put: vi.fn((path: string, body: unknown) => {
        posted.push({ path, body });
        return Promise.resolve(nextResponse);
      }),
      patch: vi.fn(),
      delete: vi.fn(),
    },
  };
});

const STATUS: VaultStatus = {
  configured: true,
  unlocked: true,
  unlockedUntil: '2026-09-08T20:00:00.000Z',
  autoLockMinutes: 15,
};

/** The material the server would serve back for a body it has just stored. */
function materialFor(body: Record<string, unknown>): VaultMaterial {
  return {
    encAlgorithm: 'X25519',
    encPublicKey: body['encPublicKey'] as string,
    encPrivateKeyEnc: body['encPrivateKeyEnc'] as string,
    signAlgorithm: 'Ed25519',
    signPublicKey: body['signPublicKey'] as string,
    signPrivateKeyEnc: body['signPrivateKeyEnc'] as string,
    kdfSalt: body['kdfSalt'] as string,
    kdfParams: body['kdfParams'],
    passphraseWrap: body['passphraseWrap'] as string,
    recoveryCodesRemaining: 5,
    passkeys: [],
  };
}

/** Re-derives the passphrase wrap key the way an unlock would. */
async function passphraseWrapKey(passphrase: string, material: VaultMaterial): Promise<Bytes> {
  return derivePassphraseWrapKey(
    await deriveStretchedKey({
      passphrase,
      salt: fromBase64Url(material.kdfSalt),
      params: material.kdfParams,
      argon2id: fakeArgon2id,
    }),
  );
}

const PASSPHRASE = 'correct horse battery staple';

beforeEach(() => {
  posted.length = 0;
  nextResponse = null;
});

afterEach(() => {
  releaseVaultKeys();
});

describe('buildVaultCreate', () => {
  it('produces a passphrase wrap that the same passphrase opens', async () => {
    const built = await buildVaultCreate({
      userId: USER_ID,
      passphrase: PASSPHRASE,
      argon2id: fakeArgon2id,
    });
    const body = built.body as Record<string, unknown>;
    const material = materialFor(body);

    const userKey = await unwrapUserKey({
      wrapKey: await passphraseWrapKey(PASSPHRASE, material),
      blob: material.passphraseWrap,
      context: { userId: USER_ID, wrapKind: 'passphrase' },
    });

    expect([...userKey]).toEqual([...built.keys.userKey]);
  });

  it('produces a wrap a different passphrase cannot open', async () => {
    const built = await buildVaultCreate({
      userId: USER_ID,
      passphrase: PASSPHRASE,
      argon2id: fakeArgon2id,
    });
    const material = materialFor(built.body as Record<string, unknown>);

    await expect(
      unwrapUserKey({
        wrapKey: await passphraseWrapKey('a completely different phrase', material),
        blob: material.passphraseWrap,
        context: { userId: USER_ID, wrapKind: 'passphrase' },
      }),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it('issues exactly five recovery wraps, each opened by its own code', async () => {
    const built = await buildVaultCreate({
      userId: USER_ID,
      passphrase: PASSPHRASE,
      argon2id: fakeArgon2id,
    });
    const body = built.body as Record<string, unknown>;
    const wraps = body['recoveryWraps'] as { lookupHash: string; wrap: string }[];

    expect(built.codes).toHaveLength(5);
    expect(wraps).toHaveLength(5);

    for (const [index, code] of built.codes.entries()) {
      const opened = await openRecoveryWrap({
        userId: USER_ID,
        code,
        lookupHash: fromBase64Url(wraps[index]!.lookupHash),
        wrap: wraps[index]!.wrap,
      });
      // All five hold the same User Key — which is exactly why redeeming one
      // has to invalidate the other four.
      expect([...opened]).toEqual([...built.keys.userKey]);
    }
  });

  it('binds each recovery wrap to its own row', async () => {
    const built = await buildVaultCreate({
      userId: USER_ID,
      passphrase: PASSPHRASE,
      argon2id: fakeArgon2id,
    });
    const body = built.body as Record<string, unknown>;
    const wraps = body['recoveryWraps'] as { lookupHash: string; wrap: string }[];

    // The lookup hash is in the AAD, so a wrap presented under another code's
    // hash fails to open — which is what makes swapping two rows detectable.
    await expect(
      openRecoveryWrap({
        userId: USER_ID,
        code: built.codes[0]!,
        lookupHash: fromBase64Url(wraps[1]!.lookupHash),
        wrap: wraps[0]!.wrap,
      }),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it('uploads the current KDF parameters and a 16-byte salt', async () => {
    const built = await buildVaultCreate({
      userId: USER_ID,
      passphrase: PASSPHRASE,
      argon2id: fakeArgon2id,
    });
    const body = built.body as Record<string, unknown>;

    expect(body['kdfParams']).toMatchObject({ alg: 'argon2id', v: 19, p: 1, len: 32 });
    expect(fromBase64Url(body['kdfSalt'] as string)).toHaveLength(16);
    expect(fromBase64Url(body['unlockVerifier'] as string)).toHaveLength(32);
  });
});

describe('buildRecoveryKit', () => {
  it('gives every code its own lookup hash', async () => {
    const userKey = crypto.getRandomValues(new Uint8Array(32));
    const kit = await buildRecoveryKit({ userId: USER_ID, userKey });

    const hashes = new Set(kit.wraps.map((wrap) => wrap.lookupHash));
    expect(hashes.size).toBe(5);
  });
});

describe('unlockWithPassphrase', () => {
  async function setUp() {
    const built = await buildVaultCreate({
      userId: USER_ID,
      passphrase: PASSPHRASE,
      argon2id: fakeArgon2id,
    });
    return { built, material: materialFor(built.body as Record<string, unknown>) };
  }

  it('holds the keys and reports the new status', async () => {
    const { built, material } = await setUp();
    nextResponse = { vault: STATUS };

    const status = await unlockWithPassphrase({
      userId: USER_ID,
      passphrase: PASSPHRASE,
      material,
      argon2id: fakeArgon2id,
    });

    expect(status).toEqual(STATUS);
    expect([...(readVaultKeys()?.userKey ?? [])]).toEqual([...built.keys.userKey]);
  });

  it('sends the verifier and nothing that could open a wrap', async () => {
    const { material } = await setUp();
    nextResponse = { vault: STATUS };

    await unlockWithPassphrase({
      userId: USER_ID,
      passphrase: PASSPHRASE,
      material,
      argon2id: fakeArgon2id,
    });

    const [call] = posted;
    expect(call?.path).toBe('/api/auth/vault/unlock');
    expect(Object.keys(call?.body as object)).toEqual(['unlockVerifier']);
  });

  it('fails in the browser before it spends an attempt on the server', async () => {
    const { material } = await setUp();

    // No `nextResponse`: if this reached the endpoint, the assertion below would
    // be about the wrong thing entirely. The unwrap has to fail first, so that a
    // wrong passphrase costs the account nothing from its lockout budget.
    await expect(
      unlockWithPassphrase({
        userId: USER_ID,
        passphrase: 'not the passphrase at all',
        material,
        argon2id: fakeArgon2id,
      }),
    ).rejects.toBeInstanceOf(DecryptionError);

    expect(posted).toHaveLength(0);
    expect(readVaultKeys()).toBeNull();
  });
});

describe('the recovery flow', () => {
  it('resolves a code to its wrap and opens the User Key with it', async () => {
    const built = await buildVaultCreate({
      userId: USER_ID,
      passphrase: PASSPHRASE,
      argon2id: fakeArgon2id,
    });
    const body = built.body as Record<string, unknown>;
    const wraps = body['recoveryWraps'] as { lookupHash: string; wrap: string }[];
    const material = materialFor(body);

    nextResponse = { wrap: wraps[3]!.wrap, material };
    const begun = await beginRecovery(built.codes[3]!);

    expect(posted[0]?.path).toBe('/api/auth/vault/recovery');
    expect(Object.keys(posted[0]?.body as object)).toEqual(['lookupHash']);

    const userKey = await openRecoveryWrap({
      userId: USER_ID,
      code: built.codes[3]!,
      lookupHash: begun.lookupHash,
      wrap: begun.wrap,
    });
    expect([...userKey]).toEqual([...built.keys.userKey]);
  });

  it('forces a new passphrase and a whole new kit in one request', async () => {
    const built = await buildVaultCreate({
      userId: USER_ID,
      passphrase: PASSPHRASE,
      argon2id: fakeArgon2id,
    });
    const original = materialFor(built.body as Record<string, unknown>);
    const wraps = (built.body as Record<string, unknown>)['recoveryWraps'] as {
      lookupHash: string;
    }[];

    // The server echoes the material back, built from what it was sent — which
    // is what the real route does, and what lets the client replace its cached
    // copy without a second round trip.
    let sent: Record<string, unknown> | null = null;
    nextResponse = null;
    const { api } = await import('@/lib/api');
    vi.mocked(api.post).mockImplementationOnce((path: string, body?: unknown) => {
      posted.push({ path, body });
      sent = body as Record<string, unknown>;
      return Promise.resolve({
        vault: STATUS,
        material: { ...original, ...sent, recoveryCodesRemaining: 5 },
      });
    });

    const result = await completeRecovery({
      userId: USER_ID,
      userKey: built.keys.userKey,
      lookupHash: fromBase64Url(wraps[0]!.lookupHash),
      newPassphrase: 'an entirely new passphrase',
      argon2id: fakeArgon2id,
    });

    expect(posted[0]?.path).toBe('/api/auth/vault/recovery/complete');

    const body = sent as unknown as Record<string, unknown>;
    // Both halves, in one body. A recovery that set a passphrase without
    // reissuing would leave four live codes on a sheet its owner has already
    // proved they mishandled.
    expect(body['recoveryWraps']).toHaveLength(5);
    expect(body['passphraseWrap']).toBeTypeOf('string');
    expect(body['kdfSalt']).not.toBe(original.kdfSalt);
    expect(result.codes).toHaveLength(5);

    // The reissued kit is genuinely new.
    const reissued = new Set(
      (body['recoveryWraps'] as { lookupHash: string }[]).map((w) => w.lookupHash),
    );
    expect(reissued.has(wraps[0]!.lookupHash)).toBe(false);
  });

  it('leaves the User Key unchanged, so nothing sealed to the account is lost', async () => {
    const built = await buildVaultCreate({
      userId: USER_ID,
      passphrase: PASSPHRASE,
      argon2id: fakeArgon2id,
    });
    const original = materialFor(built.body as Record<string, unknown>);
    const before = [...built.keys.userKey];

    const { api } = await import('@/lib/api');
    vi.mocked(api.post).mockImplementationOnce((path: string, body?: unknown) => {
      posted.push({ path, body });
      return Promise.resolve({
        vault: STATUS,
        material: { ...original, ...(body as object), recoveryCodesRemaining: 5 },
      });
    });

    await completeRecovery({
      userId: USER_ID,
      userKey: built.keys.userKey,
      lookupHash: crypto.getRandomValues(new Uint8Array(32)),
      newPassphrase: 'an entirely new passphrase',
      argon2id: fakeArgon2id,
    });

    // Held, and identical: a recovery re-wraps the key, it does not replace it.
    expect([...(readVaultKeys()?.userKey ?? [])]).toEqual(before);
  });
});

describe('readRecoveryCode', () => {
  it('accepts a code typed without hyphens, in lower case', async () => {
    const built = await buildVaultCreate({
      userId: USER_ID,
      passphrase: PASSPHRASE,
      argon2id: fakeArgon2id,
    });
    const typed = built.codes[0]!.displayForm.replaceAll('-', '').toLowerCase();

    const parsed = readRecoveryCode(typed);
    expect('code' in parsed && parsed.code.displayForm).toBe(built.codes[0]!.displayForm);
  });

  it('says a code has a typo rather than that it is invalid', () => {
    // The check character's whole purpose: "retype one character" instead of
    // "your kit is worthless".
    const parsed = readRecoveryCode('23456-789AB-CDEFG-HJKMN-PQRST-0');
    expect('problem' in parsed && parsed.problem).toMatch(/typo/i);
  });

  it('rejects something that is not a code at all', () => {
    const parsed = readRecoveryCode('hello');
    expect('problem' in parsed && parsed.problem).toMatch(/not a valid code/i);
  });
});

describe('describeUnlockFailure', () => {
  it('gives one honest sentence for a failed unwrap', () => {
    // A wrong passphrase, a swapped row and a corrupt record are one
    // indistinguishable outcome here. Inventing a distinction would be a guess
    // presented as a diagnosis.
    expect(describeUnlockFailure(new DecryptionError())).toMatch(/did not open your vault/i);
  });

  it('passes the server’s backoff message through verbatim', () => {
    const message = 'Too many failed attempts. Try again in 3 minutes.';
    const surfaced = describeUnlockFailure(
      new ApiError({ code: 'rate_limited', message, status: 429, requestId: null }),
    );

    // Computed from the account's real lockout state. Paraphrasing it here would
    // either drop the wait or invent a different one.
    expect(surfaced).toBe(message);
  });

  it('never reports how many attempts are left', () => {
    const surfaced = describeUnlockFailure(new DecryptionError());
    expect(surfaced).not.toMatch(/attempt|remaining|tries|left/i);
  });

  it('says the vault was not unlocked when the request never arrived', () => {
    const surfaced = describeUnlockFailure(
      new ApiError({
        code: 'network_error',
        message: 'Could not reach xecret.',
        status: 0,
        requestId: null,
      }),
    );
    expect(surfaced).toMatch(/was not unlocked/i);
  });

  it('collapses an unrecognised throw rather than reading its message', () => {
    // An arbitrary exception's message may have been built from a request
    // payload, which in this product may be a secret value.
    expect(describeUnlockFailure(new Error('postgres://user:hunter2@host'))).not.toContain(
      'hunter2',
    );
  });
});

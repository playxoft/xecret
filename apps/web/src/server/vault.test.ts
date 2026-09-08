import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZodMiniType } from 'zod/mini';
import { VAULT_FREE_ATTEMPTS, VAULT_LOCKOUT_BASE_MS, hashUnlockVerifier } from '@xecret/core/auth';
import { randomBytes, toBase64Url } from '@xecret/core/crypto';
import { uuidv7 } from '@xecret/core/ids';
import type { Bytes } from '@xecret/core/crypto';
import type { ApiError } from './errors';

/**
 * The vault layer: the request schemas, the response serialisers, and the order
 * of operations in `vault-service.ts`.
 *
 * ── What these prove ──
 * Everything a vault request is judged by before a row moves, and everything the
 * service does with the answer. The schemas are pure and exercised for real. The
 * service is exercised against a stubbed repository, which is a deliberate
 * choice rather than the usual compromise: what is under test here is
 * *sequencing* — that the lockout is consulted before the comparison, that a
 * failure is counted before the response, that a wrong verifier writes nothing —
 * and sequencing is a property of this module, not of the database.
 *
 * ── What they cannot prove, and what integration coverage must ──
 * That the transactions in `packages/db/src/repositories/vault.ts` are actually
 * atomic, that the partial unique index really does refuse a second live
 * passphrase wrap, and that `used_at IS NULL` really does serialise two
 * redemptions of one code. Those are properties of PostgreSQL, and a fake
 * database would prove only that the fake agrees with the test — the standing
 * caveat that `members.test.ts` and `routes.test.ts` record.
 */

const repo = vi.hoisted(() => ({
  findVaultKeys: vi.fn(),
  loadVault: vi.fn(),
  createVault: vi.fn(),
  changePassphrase: vi.fn(),
  completeRecovery: vi.fn(),
  findRecoveryWrap: vi.fn(),
  regenerateRecoveryCodes: vi.fn(),
  enrollPasskey: vi.fn(),
  listPasskeys: vi.fn(),
  removePasskey: vi.fn(),
  recordUnlockAttempt: vi.fn(),
  recordRecoveryAttempt: vi.fn(),
  markSessionUnlocked: vi.fn(),
  lockSessions: vi.fn(),
  setAutoLockMinutes: vi.fn(),
  listOrganizationsForUser: vi.fn(),
}));

/**
 * Only the query functions are replaced.
 *
 * `RepositoryError` and `toBytes` come through from the real module, because the
 * service's error mapping is *about* `RepositoryError` — a stubbed one would
 * make every `instanceof` assertion below a statement about the fixture.
 */
vi.mock('@xecret/db/repositories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xecret/db/repositories')>()),
  ...repo,
}));

const { RepositoryError } = await import('@xecret/db/repositories');
const { ApiError: ApiErrorClass } = await import('./errors');
const { isUnlocked } = await import('./actor');
const service = await import('./vault-service');
const {
  autoLockSchema,
  encodeBlob,
  decodeBlob,
  passkeyEnrollSchema,
  RECOVERY_CODE_COUNT,
  recoveryCompleteSchema,
  toVaultMaterial,
  vaultCreateSchema,
  vaultPassphraseSchema,
  vaultUnlockSchema,
} = await import('./schemas/vault');
const { parseWith } = await import('./http');

const USER_ID = uuidv7();
const SESSION_ID = uuidv7();

/** A syntactically valid `xk2.gcm.` blob of `n` payload bytes. */
function gcmBlob(payloadBytes = 60): string {
  return `xk2.gcm.${toBase64Url(randomBytes(payloadBytes))}`;
}

function b64(bytes: number): string {
  return toBase64Url(randomBytes(bytes));
}

const KDF_PARAMS = { alg: 'argon2id', v: 19, m: 65_536, t: 3, p: 1, len: 32 } as const;

function recoveryKit(count = RECOVERY_CODE_COUNT) {
  return Array.from({ length: count }, () => ({ lookupHash: b64(32), wrap: gcmBlob() }));
}

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    encPublicKey: b64(32),
    encPrivateKeyEnc: gcmBlob(),
    signPublicKey: b64(32),
    signPrivateKeyEnc: gcmBlob(),
    kdfSalt: b64(16),
    kdfParams: KDF_PARAMS,
    unlockVerifier: b64(32),
    passphraseWrap: gcmBlob(),
    recoveryWraps: recoveryKit(),
    ...overrides,
  };
}

function rejected<T>(schema: ZodMiniType<T>, value: unknown): ApiError {
  let thrown: unknown;
  try {
    parseWith(schema, value);
  } catch (cause) {
    thrown = cause;
  }

  expect(thrown, 'the schema must refuse this body').toBeInstanceOf(ApiErrorClass);
  return thrown as ApiError;
}

describe('the vault setup schema', () => {
  it('accepts a complete, well-formed ceremony upload', () => {
    const body = createBody();
    expect(parseWith(vaultCreateSchema, body)).toEqual(body);
  });

  it('refuses a blob that is not an xk2.gcm one', () => {
    // Each of these is a real way a client could go wrong, and each must be
    // refused at the boundary rather than stored for a future reader to choke
    // on. The version prefix in particular: a blob written by a future format
    // must fail loudly rather than be misread as this one.
    for (const wrap of [
      'xk1.gcm.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'xk2.x25519.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'xk2.gcm.',
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      // Padded base64, which `toBase64Url` never emits — two spellings of one
      // value would make a bytea equality lookup miss one of them.
      `xk2.gcm.${'A'.repeat(78)}==`,
      // A `+`/`/` alphabet rather than base64url.
      `xk2.gcm.${'A'.repeat(60)}+/`,
    ]) {
      const fields = (rejected(vaultCreateSchema, createBody({ passphraseWrap: wrap })).fields ??
        []) as Array<{ field: string }>;
      expect(new Set(fields.map((problem) => problem.field)), wrap).toEqual(
        new Set(['passphraseWrap']),
      );
    }
  });

  it('refuses a blob below the format minimum and one past the ceiling', () => {
    // The floor is `iv(12) ‖ tag(16)`, an empty plaintext; a shorter payload is
    // truncated rather than merely unusual.
    expect(rejected(vaultCreateSchema, createBody({ passphraseWrap: gcmBlob(20) })).code).toBe(
      'validation_failed',
    );
    expect(rejected(vaultCreateSchema, createBody({ passphraseWrap: gcmBlob(4096) })).code).toBe(
      'validation_failed',
    );
  });

  it('holds every fixed-width value to its exact byte length', () => {
    const cases: Array<[string, string]> = [
      ['encPublicKey', b64(31)],
      ['signPublicKey', b64(33)],
      ['kdfSalt', b64(32)],
      ['unlockVerifier', b64(16)],
    ];

    for (const [field, value] of cases) {
      const fields = (rejected(vaultCreateSchema, createBody({ [field]: value })).fields ??
        []) as Array<{ field: string }>;
      expect(new Set(fields.map((problem) => problem.field)), field).toEqual(new Set([field]));
    }
  });

  it('requires exactly five recovery wraps', () => {
    // Four leaves its owner one code short of the kit they printed; fifty turns
    // a lookup table into a place to store data.
    for (const count of [0, 1, 4, 6, 50]) {
      expect(
        rejected(vaultCreateSchema, createBody({ recoveryWraps: recoveryKit(count) })).code,
      ).toBe('validation_failed');
    }
    expect(RECOVERY_CODE_COUNT).toBe(5);
  });

  it('bounds the Argon2id cost a client may write', () => {
    // These arrive from a client and are handed back to that same account's
    // future sessions, so an unbounded `m` written once is a denial of service
    // against the one person who can never work around it.
    for (const params of [
      { ...KDF_PARAMS, m: 1024 },
      { ...KDF_PARAMS, m: 2_097_152 },
      { ...KDF_PARAMS, t: 0 },
      { ...KDF_PARAMS, t: 99 },
      { ...KDF_PARAMS, p: 4 },
      { ...KDF_PARAMS, len: 64 },
      { ...KDF_PARAMS, v: 16 },
      { ...KDF_PARAMS, alg: 'argon2i' },
      { ...KDF_PARAMS, extra: 1 },
    ]) {
      expect(rejected(vaultCreateSchema, createBody({ kdfParams: params })).code).toBe(
        'validation_failed',
      );
    }
  });

  it('refuses a field this endpoint does not accept', () => {
    // `strictObject`, like every other body schema: a field the server ignores
    // is a field a client believes it sent.
    expect(rejected(vaultCreateSchema, createBody({ userKey: b64(32) })).code).toBe(
      'validation_failed',
    );
  });
});

describe('the remaining request schemas', () => {
  it('takes a verifier and nothing else on unlock', () => {
    const verifier = b64(32);
    expect(parseWith(vaultUnlockSchema, { unlockVerifier: verifier })).toEqual({
      unlockVerifier: verifier,
    });
    expect(rejected(vaultUnlockSchema, { unlockVerifier: verifier, userKey: b64(32) }).code).toBe(
      'validation_failed',
    );
  });

  it('requires the current verifier alongside the new one on a passphrase change', () => {
    // The sudo-mode re-authentication. Without it, an unattended desk is a
    // passphrase change — the exact scenario the lock exists for.
    const body = {
      currentUnlockVerifier: b64(32),
      unlockVerifier: b64(32),
      kdfSalt: b64(16),
      kdfParams: KDF_PARAMS,
      passphraseWrap: gcmBlob(),
    };

    expect(parseWith(vaultPassphraseSchema, body)).toEqual(body);

    const withoutCurrent: Record<string, unknown> = { ...body };
    delete withoutCurrent['currentUnlockVerifier'];
    expect(rejected(vaultPassphraseSchema, withoutCurrent).code).toBe('validation_failed');
  });

  it('makes completing a recovery carry a whole new kit', () => {
    // Inseparable by design: all five wraps hold the same User Key, so a kit
    // with one code spent is a kit four other pieces of paper still open.
    const body = {
      lookupHash: b64(32),
      unlockVerifier: b64(32),
      kdfSalt: b64(16),
      kdfParams: KDF_PARAMS,
      passphraseWrap: gcmBlob(),
      recoveryWraps: recoveryKit(),
    };

    expect(parseWith(recoveryCompleteSchema, body)).toEqual(body);
    expect(rejected(recoveryCompleteSchema, { ...body, recoveryWraps: [] }).code).toBe(
      'validation_failed',
    );
  });

  it('bounds a passkey credential id at the WebAuthn ceiling', () => {
    const body = { credentialId: b64(64), label: 'Laptop', wrap: gcmBlob() };
    expect(parseWith(passkeyEnrollSchema, body)).toEqual(body);

    expect(rejected(passkeyEnrollSchema, { ...body, credentialId: b64(8) }).code).toBe(
      'validation_failed',
    );
    expect(rejected(passkeyEnrollSchema, { ...body, credentialId: b64(2048) }).code).toBe(
      'validation_failed',
    );
    expect(rejected(passkeyEnrollSchema, { ...body, label: '' }).code).toBe('validation_failed');
    expect(
      rejected(passkeyEnrollSchema, { ...body, transports: ['usb', 'NOT A TRANSPORT'] }).code,
    ).toBe('validation_failed');
  });

  it('restricts auto-lock to the menu the settings screen offers', () => {
    expect(parseWith(autoLockSchema, { autoLockMinutes: 0 })).toEqual({ autoLockMinutes: 0 });
    for (const minutes of [1, 43, 61, -5]) {
      expect(rejected(autoLockSchema, { autoLockMinutes: minutes }).code).toBe('validation_failed');
    }
  });
});

describe('the vault material serialiser', () => {
  const vault = {
    keys: {
      userId: USER_ID,
      encAlgorithm: 'X25519',
      encPublicKey: randomBytes(32),
      encPrivateKeyEnc: encodeBlob('xk2.gcm.privenc'),
      signAlgorithm: 'Ed25519',
      signPublicKey: randomBytes(32),
      signPrivateKeyEnc: encodeBlob('xk2.gcm.privsign'),
      kdfSalt: randomBytes(16),
      kdfParams: KDF_PARAMS,
      unlockVerifierHash: randomBytes(32),
      failedAttempts: 3,
      lockedUntil: null,
      recoveryFailedAttempts: 1,
      recoveryLockedUntil: null,
      autoLockMinutes: 10,
      createdAt: new Date(0),
      rotatedAt: null,
    },
    passphraseWrap: encodeBlob('xk2.gcm.passphrase'),
    passkeys: [
      {
        id: uuidv7(),
        credentialId: randomBytes(32),
        label: 'Laptop',
        transports: ['internal'],
        createdAt: new Date(0),
        lastUsedAt: null,
        wrap: encodeBlob('xk2.gcm.prf'),
      },
    ],
    recoveryCodesRemaining: 4,
  };

  it('returns blobs as the ASCII strings the client parses', () => {
    const material = toVaultMaterial(vault);
    expect(material.passphraseWrap).toBe('xk2.gcm.passphrase');
    expect(material.encPrivateKeyEnc).toBe('xk2.gcm.privenc');
    expect(material.passkeys[0]?.wrap).toBe('xk2.gcm.prf');
  });

  it('never carries a recovery wrap, a lookup hash, or the verifier digest', () => {
    // The count, and nothing else. A recovery wrap handed out unasked would let
    // a stolen session enumerate the kit offline; the verifier digest is what
    // gates the API and has no business in a response.
    const serialised = JSON.stringify(toVaultMaterial(vault));

    expect(serialised).not.toContain('lookupHash');
    expect(serialised).not.toContain('unlockVerifier');
    expect(serialised).not.toContain(toBase64Url(vault.keys.unlockVerifierHash));
    expect(toVaultMaterial(vault).recoveryCodesRemaining).toBe(4);
  });

  it('round-trips a blob through the bytea encoding it is stored in', () => {
    const blob = gcmBlob();
    expect(decodeBlob(encodeBlob(blob))).toBe(blob);
  });
});

describe('the lock gate', () => {
  const now = new Date('2026-09-08T12:00:00.000Z');

  it('reads the session’s vault unlock, not merely its existence', () => {
    expect(isUnlocked(userPrincipal({ vaultUnlockedAt: null }), now)).toBe(false);
    expect(
      isUnlocked(userPrincipal({ vaultUnlockedAt: new Date(now.getTime() - 1000) }), now),
    ).toBe(true);
    // Past the eight-hour window.
    expect(
      isUnlocked(
        userPrincipal({ vaultUnlockedAt: new Date(now.getTime() - 9 * 60 * 60 * 1000) }),
        now,
      ),
    ).toBe(false);
  });

  it('lets a token principal through, whatever the clock says', () => {
    // A build agent has nobody present to type a passphrase, and demanding one
    // would break `xecret run` in CI while protecting nothing.
    for (const principal of [
      { kind: 'cliToken', tokenId: uuidv7(), tokenName: 'ci', userId: USER_ID, orgId: uuidv7() },
      {
        kind: 'serviceToken',
        tokenId: uuidv7(),
        tokenName: 'deploy',
        orgId: uuidv7(),
        projectId: uuidv7(),
        environmentId: uuidv7(),
        accessLevel: 'read',
      },
    ] as const) {
      expect(isUnlocked(principal, now)).toBe(true);
    }
  });
});

describe('the vault service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repo.listOrganizationsForUser.mockResolvedValue([]);
    repo.markSessionUnlocked.mockResolvedValue(undefined);
    repo.recordUnlockAttempt.mockResolvedValue(undefined);
    repo.recordRecoveryAttempt.mockResolvedValue(undefined);
  });

  it('refuses a token principal outright — a vault belongs to a session', () => {
    expect(() =>
      service.requireUserPrincipal({
        kind: 'cliToken',
        tokenId: uuidv7(),
        tokenName: 'ci',
        userId: USER_ID,
        orgId: uuidv7(),
      }),
    ).toThrow(ApiErrorClass);
  });

  describe('creating a vault', () => {
    it('writes the keys and then unlocks the session that created them', async () => {
      repo.createVault.mockResolvedValue(undefined);
      const body = parseWith(vaultCreateSchema, createBody());

      await service.createVault(services(), userPrincipal(), body);

      expect(repo.createVault).toHaveBeenCalledOnce();
      // The verifier is stored as a digest, never verbatim: a column holding it
      // would let a database dump replay an unlock.
      const written = repo.createVault.mock.calls[0]?.[1] as { unlockVerifierHash: Uint8Array };
      expect([...written.unlockVerifierHash]).toEqual([
        ...(await hashUnlockVerifier(fromB64(body.unlockVerifier))),
      ]);
      expect(repo.markSessionUnlocked).toHaveBeenCalledOnce();
    });

    it('answers 409 on a second ceremony, and unlocks nothing', async () => {
      // Not an overwrite. The account's existing public key has environment keys
      // sealed to it, and replacing it silently would revoke access to every one
      // of them while reporting success.
      repo.createVault.mockRejectedValue(
        new RepositoryError('conflict', 'This account already has a vault.'),
      );

      await expect(
        service.createVault(
          services(),
          userPrincipal(),
          parseWith(vaultCreateSchema, createBody()),
        ),
      ).rejects.toMatchObject({ code: 'conflict', status: 409 });

      expect(repo.markSessionUnlocked).not.toHaveBeenCalled();
    });
  });

  describe('unlocking', () => {
    it('unlocks the session when the verifier matches, and clears the counter', async () => {
      const verifier = randomBytes(32);
      repo.findVaultKeys.mockResolvedValue(await vaultKeys({ verifier, failedAttempts: 2 }));

      const result = await service.unlockVault(services(), userPrincipal(), toBase64Url(verifier));

      expect(result.unlockedUntil).toMatch(/^\d{4}-/);
      expect(repo.markSessionUnlocked).toHaveBeenCalledOnce();
      expect(repo.recordUnlockAttempt).toHaveBeenCalledWith(expect.anything(), USER_ID, {
        failedAttempts: 0,
        lockedUntil: null,
      });
    });

    it('leaves an already-clean counter alone rather than writing a no-op', async () => {
      const verifier = randomBytes(32);
      repo.findVaultKeys.mockResolvedValue(await vaultKeys({ verifier }));

      await service.unlockVault(services(), userPrincipal(), toBase64Url(verifier));

      expect(repo.recordUnlockAttempt).not.toHaveBeenCalled();
    });

    it('refuses a wrong verifier, counts it durably, and unlocks nothing', async () => {
      repo.findVaultKeys.mockResolvedValue(await vaultKeys({ verifier: randomBytes(32) }));

      await expect(
        service.unlockVault(services(), userPrincipal(), toBase64Url(randomBytes(32))),
      ).rejects.toMatchObject({ code: 'unauthenticated' });

      // Awaited, not deferred: a failure recorded after the response is one a
      // client can avoid paying for by hanging up.
      expect(repo.recordUnlockAttempt).toHaveBeenCalledWith(expect.anything(), USER_ID, {
        failedAttempts: 1,
        lockedUntil: null,
      });
      expect(repo.markSessionUnlocked).not.toHaveBeenCalled();
    });

    it('escalates: five free attempts, then a minute, then doubling', async () => {
      const stored = await vaultKeys({ verifier: randomBytes(32) });
      const delays: (number | null)[] = [];

      for (let attempt = 0; attempt < VAULT_FREE_ATTEMPTS + 3; attempt += 1) {
        repo.findVaultKeys.mockResolvedValue({ ...stored, failedAttempts: attempt });
        await expect(
          service.unlockVault(services(), userPrincipal(), toBase64Url(randomBytes(32))),
        ).rejects.toThrow(ApiErrorClass);

        const [, , state] = repo.recordUnlockAttempt.mock.calls.at(-1) as [
          unknown,
          string,
          { failedAttempts: number; lockedUntil: Date | null },
        ];
        delays.push(state.lockedUntil === null ? null : state.lockedUntil.getTime() - Date.now());
      }

      expect(delays.slice(0, VAULT_FREE_ATTEMPTS)).toEqual(
        Array.from({ length: VAULT_FREE_ATTEMPTS }, () => null),
      );
      // Whole seconds of slack: `Date.now()` moves between the service's clock
      // and the assertion's.
      expect(delays[VAULT_FREE_ATTEMPTS]).toBeCloseTo(VAULT_LOCKOUT_BASE_MS, -3);
      expect(delays[VAULT_FREE_ATTEMPTS + 1]).toBeCloseTo(VAULT_LOCKOUT_BASE_MS * 2, -3);
      expect(delays[VAULT_FREE_ATTEMPTS + 2]).toBeCloseTo(VAULT_LOCKOUT_BASE_MS * 4, -3);
    });

    it('refuses during a lockout before comparing anything', async () => {
      // Comparing first would let an attacker keep guessing through a lockout
      // and simply ignore the response.
      const verifier = randomBytes(32);
      repo.findVaultKeys.mockResolvedValue(
        await vaultKeys({
          verifier,
          failedAttempts: 9,
          lockedUntil: new Date(Date.now() + 60_000),
        }),
      );

      // Even the *correct* verifier is refused while the lockout stands.
      await expect(
        service.unlockVault(services(), userPrincipal(), toBase64Url(verifier)),
      ).rejects.toMatchObject({ code: 'rate_limited' });

      expect(repo.markSessionUnlocked).not.toHaveBeenCalled();
      expect(repo.recordUnlockAttempt).not.toHaveBeenCalled();
    });

    it('tells an account with no vault to set one up', async () => {
      repo.findVaultKeys.mockResolvedValue(null);

      await expect(
        service.unlockVault(services(), userPrincipal(), toBase64Url(randomBytes(32))),
      ).rejects.toMatchObject({ code: 'bad_request' });
    });
  });

  describe('locking', () => {
    it('locks this session, or every session on request', async () => {
      repo.lockSessions.mockResolvedValue(3);

      await service.lockVault(services(), userPrincipal(), false);
      expect(repo.lockSessions).toHaveBeenCalledWith(expect.anything(), {
        sessionId: SESSION_ID,
      });

      await service.lockVault(services(), userPrincipal(), true);
      expect(repo.lockSessions).toHaveBeenLastCalledWith(expect.anything(), { userId: USER_ID });
    });
  });

  describe('changing the passphrase', () => {
    const body = {
      currentUnlockVerifier: '',
      unlockVerifier: toBase64Url(randomBytes(32)),
      kdfSalt: b64(16),
      kdfParams: KDF_PARAMS,
      passphraseWrap: gcmBlob(),
    };

    it('re-wraps and re-verifies in one call once the current passphrase is proved', async () => {
      const verifier = randomBytes(32);
      repo.findVaultKeys.mockResolvedValue(await vaultKeys({ verifier }));
      repo.changePassphrase.mockResolvedValue(undefined);

      await service.changePassphrase(services(), userPrincipal(), {
        ...body,
        currentUnlockVerifier: toBase64Url(verifier),
      });

      // One repository call, so the wrap and the verifier cannot land apart: a
      // wrap without its verifier is an account that decrypts but cannot unlock,
      // and the reverse is one that unlocks and then cannot decrypt.
      expect(repo.changePassphrase).toHaveBeenCalledOnce();
      const written = repo.changePassphrase.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(Object.keys(written).sort()).toEqual(
        ['kdfParams', 'kdfSalt', 'passphraseWrap', 'unlockVerifierHash', 'userId'].sort(),
      );
    });

    it('writes nothing when the current passphrase is wrong', async () => {
      repo.findVaultKeys.mockResolvedValue(await vaultKeys({ verifier: randomBytes(32) }));

      await expect(
        service.changePassphrase(services(), userPrincipal(), {
          ...body,
          currentUnlockVerifier: toBase64Url(randomBytes(32)),
        }),
      ).rejects.toMatchObject({ code: 'unauthenticated' });

      expect(repo.changePassphrase).not.toHaveBeenCalled();
      // Metered like an unlock. A change form that was not would be an unmetered
      // oracle for guessing the current passphrase.
      expect(repo.recordUnlockAttempt).toHaveBeenCalledOnce();
    });

    it('reports a lost race as a conflict rather than a 500', async () => {
      const verifier = randomBytes(32);
      repo.findVaultKeys.mockResolvedValue(await vaultKeys({ verifier }));
      repo.changePassphrase.mockRejectedValue(
        new RepositoryError('conflict', 'The passphrase was changed by another request.'),
      );

      await expect(
        service.changePassphrase(services(), userPrincipal(), {
          ...body,
          currentUnlockVerifier: toBase64Url(verifier),
        }),
      ).rejects.toMatchObject({ code: 'conflict', status: 409 });
    });
  });

  describe('recovery', () => {
    const completeBody = {
      lookupHash: b64(32),
      unlockVerifier: b64(32),
      kdfSalt: b64(16),
      kdfParams: KDF_PARAMS,
      passphraseWrap: gcmBlob(),
      recoveryWraps: recoveryKit(),
    };

    it('hands back the wrap a valid code addresses', async () => {
      repo.findVaultKeys.mockResolvedValue(await vaultKeys({ verifier: randomBytes(32) }));
      repo.findRecoveryWrap.mockResolvedValue({
        wrapId: uuidv7(),
        userId: USER_ID,
        wrap: encodeBlob('xk2.gcm.recovery'),
      });
      repo.loadVault.mockResolvedValue(await wholeVault());

      const result = await service.beginRecovery(services(), userPrincipal(), b64(32));

      expect(result.wrap).toBe('xk2.gcm.recovery');
      // Not yet cleared: a lookup that resolves and is then abandoned has proved
      // nothing about whether its holder can open the wrap.
      expect(repo.recordRecoveryAttempt).not.toHaveBeenCalled();
    });

    it('gives one indistinguishable answer to an unknown code, a used one, and another account’s', async () => {
      repo.findVaultKeys.mockResolvedValue(await vaultKeys({ verifier: randomBytes(32) }));

      const answers: string[] = [];
      for (const match of [
        null,
        // `findRecoveryWrap` already excludes used rows, so a redeemed code
        // arrives here as `null` — the same shape as one that never existed.
        null,
        { wrapId: uuidv7(), userId: uuidv7(), wrap: encodeBlob('xk2.gcm.other') },
      ]) {
        repo.findRecoveryWrap.mockResolvedValue(match);
        try {
          await service.beginRecovery(services(), userPrincipal(), b64(32));
          expect.unreachable('every one of these must be refused');
        } catch (cause) {
          expect(cause).toBeInstanceOf(ApiErrorClass);
          answers.push((cause as ApiError).message);
        }
      }

      // One message for all three. Distinguishing them would tell somebody
      // probing the endpoint which part of their guess was right — and, because
      // a lookup is not scoped by user in the database, would turn a
      // "no such code" into an oracle for whether an account exists.
      expect(new Set(answers).size).toBe(1);
      // Each attempt counted, against the recovery counter rather than the
      // passphrase one.
      expect(repo.recordRecoveryAttempt).toHaveBeenCalledTimes(3);
      expect(repo.recordUnlockAttempt).not.toHaveBeenCalled();
    });

    it('redeems, resets the passphrase, reissues the kit, and unlocks — in one call', async () => {
      const wrapId = uuidv7();
      repo.findVaultKeys.mockResolvedValue(await vaultKeys({ verifier: randomBytes(32) }));
      repo.findRecoveryWrap.mockResolvedValue({
        wrapId,
        userId: USER_ID,
        wrap: encodeBlob('xk2.gcm.recovery'),
      });
      repo.completeRecovery.mockResolvedValue(undefined);

      await service.completeRecovery(services(), userPrincipal(), completeBody);

      const written = repo.completeRecovery.mock.calls[0]?.[1] as {
        wrapId: string;
        recoveryWraps: unknown[];
        passphraseWrap: Uint8Array;
      };
      expect(written.wrapId).toBe(wrapId);
      // The forced reissue: all five wraps hold the same User Key, so a kit with
      // one code spent is a kit four other pieces of paper still open.
      expect(written.recoveryWraps).toHaveLength(RECOVERY_CODE_COUNT);
      expect(written.passphraseWrap).toBeInstanceOf(Uint8Array);
      expect(repo.markSessionUnlocked).toHaveBeenCalledOnce();
    });

    it('refuses a code redeemed between the two steps, and unlocks nothing', async () => {
      // The `used_at IS NULL` guard inside the transaction is the real
      // boundary; this is the answer it produces at the API.
      repo.findVaultKeys.mockResolvedValue(await vaultKeys({ verifier: randomBytes(32) }));
      repo.findRecoveryWrap.mockResolvedValue({
        wrapId: uuidv7(),
        userId: USER_ID,
        wrap: encodeBlob('xk2.gcm.recovery'),
      });
      repo.completeRecovery.mockRejectedValue(
        new RepositoryError('conflict', 'That recovery code has already been used.'),
      );

      await expect(
        service.completeRecovery(services(), userPrincipal(), completeBody),
      ).rejects.toMatchObject({ code: 'conflict', status: 409 });

      expect(repo.markSessionUnlocked).not.toHaveBeenCalled();
    });

    it('refuses during the recovery lockout, without touching the code', async () => {
      repo.findVaultKeys.mockResolvedValue(
        await vaultKeys({
          verifier: randomBytes(32),
          recoveryFailedAttempts: 8,
          recoveryLockedUntil: new Date(Date.now() + 60_000),
        }),
      );

      await expect(
        service.beginRecovery(services(), userPrincipal(), b64(32)),
      ).rejects.toMatchObject({ code: 'rate_limited' });

      expect(repo.findRecoveryWrap).not.toHaveBeenCalled();
    });

    it('reissues the kit only once the passphrase is re-entered', async () => {
      const verifier = randomBytes(32);
      repo.findVaultKeys.mockResolvedValue(await vaultKeys({ verifier }));
      repo.regenerateRecoveryCodes.mockResolvedValue(RECOVERY_CODE_COUNT);

      await expect(
        service.regenerateRecoveryCodes(services(), userPrincipal(), {
          unlockVerifier: toBase64Url(randomBytes(32)),
          recoveryWraps: recoveryKit(),
        }),
      ).rejects.toMatchObject({ code: 'unauthenticated' });
      expect(repo.regenerateRecoveryCodes).not.toHaveBeenCalled();

      const issued = await service.regenerateRecoveryCodes(services(), userPrincipal(), {
        unlockVerifier: toBase64Url(verifier),
        recoveryWraps: recoveryKit(),
      });

      expect(issued).toBe(RECOVERY_CODE_COUNT);
      // Every live code replaced in one call, so no window exists in which an
      // account holds two valid kits.
      expect(repo.regenerateRecoveryCodes).toHaveBeenCalledOnce();
      expect(repo.regenerateRecoveryCodes.mock.calls[0]?.[2]).toHaveLength(RECOVERY_CODE_COUNT);
    });
  });

  describe('passkeys', () => {
    it('refuses to enrol against an account with no vault', async () => {
      repo.findVaultKeys.mockResolvedValue(null);

      await expect(
        service.enrollPasskey(services(), userPrincipal(), {
          credentialId: b64(32),
          label: 'Laptop',
          wrap: gcmBlob(),
        }),
      ).rejects.toMatchObject({ code: 'bad_request' });

      expect(repo.enrollPasskey).not.toHaveBeenCalled();
    });

    it('enrols a credential and returns it without its raw bytes', async () => {
      const credentialId = randomBytes(32);
      repo.findVaultKeys.mockResolvedValue(await vaultKeys({ verifier: randomBytes(32) }));
      repo.enrollPasskey.mockResolvedValue({
        id: uuidv7(),
        credentialId,
        label: 'Laptop',
        transports: null,
        createdAt: new Date(0),
        lastUsedAt: null,
        wrap: encodeBlob('xk2.gcm.prf'),
      });

      const passkey = await service.enrollPasskey(services(), userPrincipal(), {
        credentialId: toBase64Url(credentialId),
        label: 'Laptop',
        wrap: gcmBlob(),
      });

      expect(passkey.credentialId).toBe(toBase64Url(credentialId));
      expect(passkey.wrap).toBe('xk2.gcm.prf');
    });

    it('answers 404 for a passkey that is not this account’s', async () => {
      // The repository scopes its `WHERE` by user, so an id belonging to
      // somebody else and one belonging to nobody are indistinguishable here by
      // construction (threat T2).
      repo.removePasskey.mockResolvedValue(false);

      await expect(
        service.removePasskey(services(), userPrincipal(), uuidv7()),
      ).rejects.toMatchObject({ code: 'not_found' });
    });

    it('removes one that is', async () => {
      repo.removePasskey.mockResolvedValue(true);
      await expect(
        service.removePasskey(services(), userPrincipal(), uuidv7()),
      ).resolves.toBeUndefined();
    });
  });

  describe('the auto-lock interval', () => {
    it('refuses to invent a vault to hang a preference on', async () => {
      repo.setAutoLockMinutes.mockResolvedValue(null);

      await expect(service.setAutoLock(services(), userPrincipal(), 30)).rejects.toMatchObject({
        code: 'bad_request',
      });
    });
  });

  describe('the reported status', () => {
    it('reports a token principal as configured and unlocked, with no idle timer', async () => {
      // A token has no vault to set up and no screen to lock; reporting
      // `configured: false` would send the CLI into a ceremony it cannot run.
      const status = await service.vaultStatus(services(), {
        kind: 'cliToken',
        tokenId: uuidv7(),
        tokenName: 'ci',
        userId: USER_ID,
        orgId: uuidv7(),
      });

      expect(status).toEqual({
        configured: true,
        unlocked: true,
        unlockedUntil: null,
        autoLockMinutes: 0,
      });
      expect(repo.findVaultKeys).not.toHaveBeenCalled();
    });

    it('never reports a session as unlocked into a vault that does not exist', async () => {
      // Without the conjunction, a stale `vault_unlocked_at` from a vault that
      // has since been deleted would skip the setup ceremony entirely.
      repo.findVaultKeys.mockResolvedValue(null);

      const status = await service.vaultStatus(
        services(),
        userPrincipal({ vaultUnlockedAt: new Date() }),
      );

      expect(status.configured).toBe(false);
      expect(status.unlocked).toBe(false);
    });
  });
});

function fromB64(value: string): Bytes {
  const raw = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

async function vaultKeys(overrides: {
  verifier: Bytes;
  failedAttempts?: number;
  lockedUntil?: Date | null;
  recoveryFailedAttempts?: number;
  recoveryLockedUntil?: Date | null;
}) {
  return {
    userId: USER_ID,
    encAlgorithm: 'X25519',
    encPublicKey: randomBytes(32),
    encPrivateKeyEnc: encodeBlob(gcmBlob()),
    signAlgorithm: 'Ed25519',
    signPublicKey: randomBytes(32),
    signPrivateKeyEnc: encodeBlob(gcmBlob()),
    kdfSalt: randomBytes(16),
    kdfParams: KDF_PARAMS,
    unlockVerifierHash: await hashUnlockVerifier(overrides.verifier),
    failedAttempts: overrides.failedAttempts ?? 0,
    lockedUntil: overrides.lockedUntil ?? null,
    recoveryFailedAttempts: overrides.recoveryFailedAttempts ?? 0,
    recoveryLockedUntil: overrides.recoveryLockedUntil ?? null,
    autoLockMinutes: 10,
    createdAt: new Date(0),
    rotatedAt: null,
  };
}

async function wholeVault() {
  return {
    keys: await vaultKeys({ verifier: randomBytes(32) }),
    passphraseWrap: encodeBlob(gcmBlob()),
    passkeys: [],
    recoveryCodesRemaining: 5,
  };
}

function userPrincipal(overrides: { vaultUnlockedAt?: Date | null } = {}) {
  return {
    kind: 'user' as const,
    sessionId: SESSION_ID,
    vaultUnlockedAt:
      'vaultUnlockedAt' in overrides ? (overrides.vaultUnlockedAt ?? null) : new Date(),
    user: {
      id: USER_ID,
      email: 'nitheesh@playxoft.com',
      emailVerified: true,
      displayName: null,
      avatarUrl: null,
    },
  };
}

/** Only the fields the vault service actually reaches for. */
function services() {
  return {
    db: {},
    log: { at: () => ({ warn: () => undefined, error: () => undefined }) },
    env: {},
    meta: { ipAddress: null, userAgent: null, requestId: 'req' },
    waitUntil: () => undefined,
  } as unknown as Parameters<typeof service.vaultStatus>[0];
}

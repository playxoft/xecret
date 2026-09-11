import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZodMiniType } from 'zod/mini';
import {
  DEFAULT_AUTO_LOCK_MINUTES,
  IdentityVerificationError,
  MAX_AUTO_LOCK_MINUTES,
  MIN_AUTO_LOCK_MINUTES,
  VAULT_FREE_ATTEMPTS,
  VAULT_LOCKOUT_BASE_MS,
  hashUnlockVerifier,
} from '@xecret/core/auth';
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
  resetVault: vi.fn(),
  mintPinPepper: vi.fn(),
  attemptPinUnlock: vi.fn(),
  disablePinPepper: vi.fn(),
  listPinPeppers: vi.fn(),
  revokeAllPinPeppers: vi.fn(),
  recordUnlockAttempt: vi.fn(),
  recordRecoveryAttempt: vi.fn(),
  markSessionUnlocked: vi.fn(),
  lockSessions: vi.fn(),
  setAutoLockMinutes: vi.fn(),
  listOrganizationsForUser: vi.fn(),
  // The reset's re-queue reaches these: it asks what the account may still read
  // and records a debt for each environment.
  listEnvironmentsForOrganization: vi.fn(),
  loadAuthorizationContext: vi.fn(),
  queuePendingKeyGrant: vi.fn(),
  findUserByFirebaseUid: vi.fn(),
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

/**
 * Only the token verifier is replaced.
 *
 * The reset's re-authentication gate is *about* the identity provider, and what
 * is under test is what the service does with a verified claim set — whose token
 * it is and how recently its holder actually authenticated. Verifying a real
 * Firebase signature is `firebase-auth-cloudflare-workers`' job and is exercised
 * against a stubbed verifier in `server.test.ts`.
 */
const firebase = vi.hoisted(() => ({ verify: vi.fn() }));

vi.mock('./firebase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./firebase')>()),
  firebaseIdentityProvider: () => ({ verify: firebase.verify }),
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
  pinAttemptSchema,
  pinEnrollSchema,
  RECOVERY_CODE_COUNT,
  toPinDevice,
  recoveryCompleteSchema,
  toVaultMaterial,
  vaultCreateSchema,
  vaultPassphraseSchema,
  VAULT_RESET_CONFIRMATION,
  vaultResetSchema,
  vaultUnlockSchema,
} = await import('./schemas/vault');
const { parseWith } = await import('./http');

const USER_ID = uuidv7();
const SESSION_ID = uuidv7();
const ORG_ID = uuidv7();
const PROJECT_ID = uuidv7();
const ENVIRONMENT_ID = uuidv7();

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
    ukUnlockVerifier: b64(32),
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
  it('takes exactly one verifier on unlock, of either kind', () => {
    // A passphrase unlock derives SK and sends the first; a passkey unlock opens
    // the User Key directly, never derives SK, and sends the second.
    const verifier = b64(32);
    expect(parseWith(vaultUnlockSchema, { unlockVerifier: verifier })).toEqual({
      unlockVerifier: verifier,
    });
    expect(parseWith(vaultUnlockSchema, { ukUnlockVerifier: verifier })).toEqual({
      ukUnlockVerifier: verifier,
    });
  });

  it('refuses a body carrying both verifiers, or neither', () => {
    // The two states an optional-either-way object would have admitted, and both
    // are wrong in a way that would be silent. Neither present is a body
    // claiming an unlock it never proved; both present is a caller asking the
    // server to decide which proof counts, and the obliging reading — "accept if
    // either matches" — turns two independent verifiers into one weaker one.
    expect(
      rejected(vaultUnlockSchema, { unlockVerifier: b64(32), ukUnlockVerifier: b64(32) }).code,
    ).toBe('validation_failed');
    expect(rejected(vaultUnlockSchema, {}).code).toBe('validation_failed');
  });

  it('still refuses an unknown field on either branch', () => {
    const verifier = b64(32);
    expect(rejected(vaultUnlockSchema, { unlockVerifier: verifier, userKey: b64(32) }).code).toBe(
      'validation_failed',
    );
    expect(rejected(vaultUnlockSchema, { ukUnlockVerifier: verifier, userKey: b64(32) }).code).toBe(
      'validation_failed',
    );
  });

  it('requires both verifiers at setup, so either path works from the start', () => {
    const withoutUk: Record<string, unknown> = { ...createBody() };
    delete withoutUk['ukUnlockVerifier'];
    expect(rejected(vaultCreateSchema, withoutUk).code).toBe('validation_failed');
  });

  it('takes a typed confirmation and a re-authentication token on reset, and nothing else', () => {
    const body = { confirm: VAULT_RESET_CONFIRMATION, idToken: 'a-fresh-id-token' };
    expect(parseWith(vaultResetSchema, body)).toEqual(body);

    expect(rejected(vaultResetSchema, {}).code).toBe('validation_failed');
    expect(rejected(vaultResetSchema, { confirm: 'x'.repeat(200) }).code).toBe('validation_failed');
  });

  it('refuses a reset carrying only the phrase, which is printed on the screen', () => {
    // The phrase guards against a mistake, not against an attacker: anybody who
    // can reach the route can read it off the form. Since the route is
    // necessarily `allowLocked`, the phrase alone left the one irreversible act
    // in the product available to a stolen session cookie.
    expect(rejected(vaultResetSchema, { confirm: VAULT_RESET_CONFIRMATION }).code).toBe(
      'validation_failed',
    );
  });

  it('bounds the token at the same 8192 the session route applies', () => {
    expect(
      rejected(vaultResetSchema, {
        confirm: VAULT_RESET_CONFIRMATION,
        idToken: 'x'.repeat(8193),
      }).code,
    ).toBe('validation_failed');
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

  it('accepts any plausible auto-lock interval, and null for “use the default”', () => {
    // Deliberately not restricted to the four on the menu. The bounds are the
    // security decision and `clampAutoLockMinutes` is what a value is held to;
    // refusing an off-menu number would turn "lock me after five minutes" — an
    // unmistakable, *safer* intention — into a 422 that leaves the looser
    // setting in place.
    expect(parseWith(autoLockSchema, { autoLockMinutes: 15 })).toEqual({ autoLockMinutes: 15 });
    expect(parseWith(autoLockSchema, { autoLockMinutes: 5 })).toEqual({ autoLockMinutes: 5 });
    expect(parseWith(autoLockSchema, { autoLockMinutes: null })).toEqual({ autoLockMinutes: null });
  });

  it('refuses an auto-lock value that is not a plain count of minutes', () => {
    for (const minutes of [-5, 0.5, 1_000_000, '30', true]) {
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
      ukUnlockVerifierHash: randomBytes(32),
      failedAttempts: 3,
      lockedUntil: null,
      recoveryFailedAttempts: 1,
      recoveryLockedUntil: null,
      autoLockMinutes: null,
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

  const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

  it('reads the session’s vault unlock, not merely its existence', () => {
    expect(isUnlocked(userPrincipal({ vaultUnlockedAt: null }), now)).toBe(false);
    expect(
      isUnlocked(userPrincipal({ vaultUnlockedAt: new Date(now.getTime() - 1000) }), now),
    ).toBe(true);
    // Past the eight-hour ceiling, which no preference can lift.
    expect(
      isUnlocked(userPrincipal({ vaultUnlockedAt: minutesAgo(9 * 60), lastSeenAt: now }), now),
    ).toBe(false);
  });

  it('measures the idle window against the account’s own preference', () => {
    // The point of carrying `vaultAutoLockMinutes` on the principal at all: the
    // browser's timer and this gate are the same number, so a tight setting is
    // tight on both sides. Before this, the gate counted a fixed eight hours and
    // a client that never ran its timer kept a session the server still
    // considered unlocked for the rest of the day.
    const idleTwoHours = { vaultUnlockedAt: minutesAgo(120), lastSeenAt: minutesAgo(120) };

    expect(isUnlocked(userPrincipal({ ...idleTwoHours, vaultAutoLockMinutes: 15 }), now)).toBe(
      false,
    );
    expect(isUnlocked(userPrincipal({ ...idleTwoHours, vaultAutoLockMinutes: 240 }), now)).toBe(
      true,
    );
  });

  it('resolves “no preference” to the default rather than to “forever”', () => {
    expect(
      isUnlocked(
        userPrincipal({
          vaultUnlockedAt: minutesAgo(DEFAULT_AUTO_LOCK_MINUTES + 1),
          lastSeenAt: minutesAgo(DEFAULT_AUTO_LOCK_MINUTES + 1),
          vaultAutoLockMinutes: null,
        }),
        now,
      ),
    ).toBe(false);
  });

  it('does not lock a session that is being used, however tight the preference', () => {
    // An absolute timer wearing an idle timer's name would throw somebody who
    // chose fifteen minutes back to the lock screen four times an hour while
    // they were typing.
    expect(
      isUnlocked(
        userPrincipal({
          vaultUnlockedAt: minutesAgo(180),
          lastSeenAt: minutesAgo(1),
          vaultAutoLockMinutes: 15,
        }),
        now,
      ),
    ).toBe(true);
  });

  it('clamps a preference that is outside the range the gate assumes', () => {
    // A hand-edited row must not buy an unlock longer than the ceiling.
    expect(
      isUnlocked(
        userPrincipal({
          vaultUnlockedAt: minutesAgo(9 * 60),
          lastSeenAt: now,
          vaultAutoLockMinutes: 100_000,
        }),
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

      const result = await service.unlockVault(services(), userPrincipal(), {
        unlockVerifier: toBase64Url(verifier),
      });

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

      await service.unlockVault(services(), userPrincipal(), {
        unlockVerifier: toBase64Url(verifier),
      });

      expect(repo.recordUnlockAttempt).not.toHaveBeenCalled();
    });

    it('refuses a wrong verifier, counts it durably, and unlocks nothing', async () => {
      repo.findVaultKeys.mockResolvedValue(await vaultKeys({ verifier: randomBytes(32) }));

      await expect(
        service.unlockVault(services(), userPrincipal(), {
          unlockVerifier: toBase64Url(randomBytes(32)),
        }),
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
          service.unlockVault(services(), userPrincipal(), {
            unlockVerifier: toBase64Url(randomBytes(32)),
          }),
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
        service.unlockVault(services(), userPrincipal(), {
          unlockVerifier: toBase64Url(verifier),
        }),
      ).rejects.toMatchObject({ code: 'rate_limited' });

      expect(repo.markSessionUnlocked).not.toHaveBeenCalled();
      expect(repo.recordUnlockAttempt).not.toHaveBeenCalled();
    });

    it('tells an account with no vault to set one up', async () => {
      repo.findVaultKeys.mockResolvedValue(null);

      await expect(
        service.unlockVault(services(), userPrincipal(), {
          unlockVerifier: toBase64Url(randomBytes(32)),
        }),
      ).rejects.toMatchObject({ code: 'bad_request' });
    });
  });

  describe('unlocking with a passkey', () => {
    // The gap this closes: a passkey opens blob type 3, which holds the User
    // Key, and there is no derivation from the User Key back to the Stretched
    // Key. Such a client can decrypt the whole vault and, before this branch
    // existed, held nothing the unlock endpoint would accept.
    it('accepts the User Key branch and reports the method it was unlocked by', async () => {
      const ukVerifier = randomBytes(32);
      repo.findVaultKeys.mockResolvedValue(
        await vaultKeys({ verifier: randomBytes(32), ukVerifier }),
      );

      const result = await service.unlockVault(services(), userPrincipal(), {
        ukUnlockVerifier: toBase64Url(ukVerifier),
      });

      expect(result.method).toBe('passkey');
      expect(repo.markSessionUnlocked).toHaveBeenCalledOnce();
    });

    it('compares each verifier against its own digest, so neither replays for the other', async () => {
      // The reason the two branches have separate info strings and separate
      // columns. A value captured from one path must be worthless on the other.
      const verifier = randomBytes(32);
      const ukVerifier = randomBytes(32);
      const keys = await vaultKeys({ verifier, ukVerifier });

      repo.findVaultKeys.mockResolvedValue(keys);
      await expect(
        service.unlockVault(services(), userPrincipal(), {
          ukUnlockVerifier: toBase64Url(verifier),
        }),
      ).rejects.toMatchObject({ code: 'unauthenticated' });

      repo.findVaultKeys.mockResolvedValue(keys);
      await expect(
        service.unlockVault(services(), userPrincipal(), {
          unlockVerifier: toBase64Url(ukVerifier),
        }),
      ).rejects.toMatchObject({ code: 'unauthenticated' });
    });

    it('spends the same lockout budget as a passphrase attempt', async () => {
      // Both attest to the same thing — this client can open this vault — so one
      // counter covers both. Separate counters would hand an attacker two
      // budgets against one gate.
      repo.findVaultKeys.mockResolvedValue(
        await vaultKeys({ verifier: randomBytes(32), ukVerifier: randomBytes(32) }),
      );

      await expect(
        service.unlockVault(services(), userPrincipal(), {
          ukUnlockVerifier: toBase64Url(randomBytes(32)),
        }),
      ).rejects.toMatchObject({ code: 'unauthenticated' });

      // `recordUnlockAttempt`, not `recordRecoveryAttempt`: the passphrase
      // counter, which is the one the gate reads.
      expect(repo.recordUnlockAttempt).toHaveBeenCalledWith(expect.anything(), USER_ID, {
        failedAttempts: 1,
        lockedUntil: null,
      });
      expect(repo.recordRecoveryAttempt).not.toHaveBeenCalled();
    });

    it('is refused during a lockout the passphrase path earned', async () => {
      const ukVerifier = randomBytes(32);
      repo.findVaultKeys.mockResolvedValue(
        await vaultKeys({
          verifier: randomBytes(32),
          ukVerifier,
          failedAttempts: 9,
          lockedUntil: new Date(Date.now() + 60_000),
        }),
      );

      // Even the correct UK verifier. One gate, one lockout — a passkey is not a
      // way around a lockout a passphrase attacker triggered.
      await expect(
        service.unlockVault(services(), userPrincipal(), {
          ukUnlockVerifier: toBase64Url(ukVerifier),
        }),
      ).rejects.toMatchObject({ code: 'rate_limited' });

      expect(repo.markSessionUnlocked).not.toHaveBeenCalled();
    });

    it('records both digests at setup, and only at setup', async () => {
      repo.createVault.mockResolvedValue(undefined);
      const body = parseWith(vaultCreateSchema, createBody());

      await service.createVault(services(), userPrincipal(), body);

      const written = repo.createVault.mock.calls[0]?.[1] as {
        unlockVerifierHash: Uint8Array;
        ukUnlockVerifierHash: Uint8Array;
      };
      expect([...written.ukUnlockVerifierHash]).toEqual([
        ...(await hashUnlockVerifier(fromB64(body.ukUnlockVerifier))),
      ]);
      // Distinct columns from distinct branches, never one value serving both.
      expect([...written.ukUnlockVerifierHash]).not.toEqual([...written.unlockVerifierHash]);
    });

    it('leaves the User Key digest alone on a passphrase change and a recovery', async () => {
      // Both re-wrap the User Key rather than replacing it, so the digest of the
      // branch derived from it stays correct — which is what keeps an enrolled
      // passkey working across either.
      const verifier = randomBytes(32);
      repo.findVaultKeys.mockResolvedValue(await vaultKeys({ verifier }));
      repo.changePassphrase.mockResolvedValue(undefined);

      await service.changePassphrase(services(), userPrincipal(), {
        currentUnlockVerifier: toBase64Url(verifier),
        unlockVerifier: b64(32),
        kdfSalt: b64(16),
        kdfParams: KDF_PARAMS,
        passphraseWrap: gcmBlob(),
      });

      expect(repo.changePassphrase.mock.calls[0]?.[1]).not.toHaveProperty('ukUnlockVerifierHash');

      repo.findVaultKeys.mockResolvedValue(await vaultKeys({ verifier }));
      repo.findRecoveryWrap.mockResolvedValue({
        wrapId: uuidv7(),
        userId: USER_ID,
        wrap: encodeBlob('xk2.gcm.recovery'),
      });
      repo.completeRecovery.mockResolvedValue(undefined);

      await service.completeRecovery(services(), userPrincipal(), {
        lookupHash: b64(32),
        unlockVerifier: b64(32),
        kdfSalt: b64(16),
        kdfParams: KDF_PARAMS,
        passphraseWrap: gcmBlob(),
        recoveryWraps: recoveryKit(),
      });

      expect(repo.completeRecovery.mock.calls[0]?.[1]).not.toHaveProperty('ukUnlockVerifierHash');
    });
  });

  describe('resetting the vault', () => {
    it('destroys it and reports that it did', async () => {
      repo.resetVault.mockResolvedValue(true);

      await expect(service.resetVault(services(), userPrincipal())).resolves.toBe(true);
      expect(repo.resetVault).toHaveBeenCalledWith(
        expect.anything(),
        USER_ID,
        // The third argument carries the re-queue that runs inside the reset's
        // transaction — see the test below for what it is for.
        expect.objectContaining({ requeue: expect.any(Function) }),
      );
    });

    it('re-records the key debts the reset destroys, inside the same transaction', async () => {
      // The gap this closes: a reset deletes the account's grants *and* every
      // queued share, so the person came out entitled to environments, holding
      // no key for any of them, and named in no banner anywhere. The reset UI's
      // promise that "a teammate can share those environments with you again"
      // depended on somebody remembering unaided.
      repo.resetVault.mockImplementation(
        async (_db: unknown, _userId: string, options: { requeue: (tx: unknown) => unknown }) => {
          await options.requeue({});
          return true;
        },
      );
      repo.listOrganizationsForUser.mockResolvedValue([
        { organization: { id: ORG_ID, name: 'Acme', slug: 'acme' }, role: 'developer' },
      ]);
      repo.listEnvironmentsForOrganization.mockResolvedValue([
        {
          id: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          isProduction: false,
          encryptionMode: 'e2ee',
        },
      ]);
      repo.loadAuthorizationContext.mockResolvedValue({
        orgId: ORG_ID,
        userId: USER_ID,
        memberId: USER_ID,
        role: 'developer',
        status: 'active',
        grants: [],
      });
      repo.queuePendingKeyGrant.mockResolvedValue(true);

      await service.resetVault(services(), userPrincipal());

      expect(repo.queuePendingKeyGrant).toHaveBeenCalledWith(expect.anything(), {
        environmentId: ENVIRONMENT_ID,
        targetUserId: USER_ID,
        // Themselves: nobody else changed anything, and attributing the request
        // to whoever last touched their access would name somebody who had
        // nothing to do with it.
        requestedBy: USER_ID,
      });
    });

    it('re-records nothing for an environment the account may not read', async () => {
      repo.resetVault.mockImplementation(
        async (_db: unknown, _userId: string, options: { requeue: (tx: unknown) => unknown }) => {
          await options.requeue({});
          return true;
        },
      );
      repo.listOrganizationsForUser.mockResolvedValue([
        { organization: { id: ORG_ID, name: 'Acme', slug: 'acme' }, role: 'developer' },
      ]);
      // Production, which is deny-by-default for a developer — the single most
      // important row in `ROLE_ACCESS_DEFAULTS`. A reset must not hand somebody
      // a standing claim on a key they were never entitled to.
      repo.listEnvironmentsForOrganization.mockResolvedValue([
        {
          id: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          isProduction: true,
          encryptionMode: 'e2ee',
        },
      ]);
      repo.loadAuthorizationContext.mockResolvedValue({
        orgId: ORG_ID,
        userId: USER_ID,
        memberId: USER_ID,
        role: 'developer',
        status: 'active',
        grants: [],
      });

      await service.resetVault(services(), userPrincipal());

      expect(repo.queuePendingKeyGrant).not.toHaveBeenCalled();
    });

    it('reports an account with no vault rather than claiming a destruction', async () => {
      // The route turns this into a 404. A destructive call that reports success
      // without destroying anything teaches a client the call worked, and the
      // next screen it draws is wrong.
      repo.resetVault.mockResolvedValue(false);

      await expect(service.resetVault(services(), userPrincipal())).resolves.toBe(false);
    });

    /**
     * The second credential the reset now demands.
     *
     * ── The finding ──
     * The route is `allowLocked` by necessity — every caller of it is locked out
     * by definition — so the vault lock that stands in front of every other
     * destructive act cannot stand in front of this one. What was left was a
     * typed phrase that is printed on the screen above the field. Against a
     * mistake that is exactly right; against somebody holding a stolen session
     * cookie it is worth nothing, and what they could reach with it was the one
     * irreversible, unrecoverable act in the product.
     */
    describe('the re-authentication gate', () => {
      const NOW = new Date('2026-03-01T12:00:00Z');
      const authTime = (secondsAgo: number) => Math.floor(NOW.getTime() / 1000) - secondsAgo;

      function verifies(identity: Record<string, unknown>) {
        firebase.verify.mockResolvedValue({
          subject: 'firebase-uid-1',
          email: 'nitheesh@playxoft.com',
          emailVerified: true,
          authTime: authTime(30),
          ...identity,
        });
      }

      async function refusal(idToken = 'a-token'): Promise<ApiError> {
        let thrown: unknown;
        try {
          await service.assertRecentAccountOwner(services(), userPrincipal(), idToken, NOW);
        } catch (cause) {
          thrown = cause;
        }
        expect(thrown).toBeInstanceOf(ApiErrorClass);
        return thrown as ApiError;
      }

      it('accepts a token for this account, minted moments ago', async () => {
        verifies({});
        repo.findUserByFirebaseUid.mockResolvedValue({ id: USER_ID });

        await expect(
          service.assertRecentAccountOwner(services(), userPrincipal(), 'a-token', NOW),
        ).resolves.toBeUndefined();
      });

      it('refuses a token that belongs to another account', async () => {
        // Resolved through `firebase_uid`, not through the email: an address can
        // be changed at the provider and two accounts can share one over time,
        // whereas the uid is the identity this system is keyed by.
        verifies({});
        repo.findUserByFirebaseUid.mockResolvedValue({ id: uuidv7() });

        expect((await refusal()).code).toBe('unauthenticated');
      });

      it('refuses a token whose subject resolves to no account at all', async () => {
        verifies({});
        repo.findUserByFirebaseUid.mockResolvedValue(null);

        expect((await refusal()).code).toBe('unauthenticated');
      });

      it('refuses a token whose holder authenticated too long ago', async () => {
        // The claim checked is `auth_time`, not `iat`. A refresh token mints a
        // fresh ID token every hour with nobody at the keyboard, so an `iat`
        // check would be satisfied by exactly the idle browser an attacker stole.
        verifies({ authTime: authTime(6 * 60) });
        repo.findUserByFirebaseUid.mockResolvedValue({ id: USER_ID });

        expect((await refusal()).code).toBe('unauthenticated');
      });

      it('refuses a token with no auth_time, which fails closed as the distant past', async () => {
        verifies({ authTime: 0 });
        repo.findUserByFirebaseUid.mockResolvedValue({ id: USER_ID });

        expect((await refusal()).code).toBe('unauthenticated');
      });

      it('refuses a token dated in the future beyond the tolerated skew', async () => {
        verifies({ authTime: authTime(-3600) });
        repo.findUserByFirebaseUid.mockResolvedValue({ id: USER_ID });

        expect((await refusal()).code).toBe('unauthenticated');
      });

      it('refuses a token the provider would not verify', async () => {
        firebase.verify.mockRejectedValue(new IdentityVerificationError('token-expired'));

        expect((await refusal()).code).toBe('unauthenticated');
      });

      it('gives the same message whatever failed', async () => {
        // Naming which part was wrong tells an attacker which part of a forged
        // token to fix next — the rule `POST /api/auth/session` already keeps.
        verifies({});
        repo.findUserByFirebaseUid.mockResolvedValue({ id: uuidv7() });
        const wrongAccount = await refusal();

        verifies({ authTime: 0 });
        repo.findUserByFirebaseUid.mockResolvedValue({ id: USER_ID });
        const tooOld = await refusal();

        expect(tooOld.message).toBe(wrongAccount.message);
      });

      it('never reaches the database when the token does not verify', async () => {
        firebase.verify.mockRejectedValue(new IdentityVerificationError('invalid-token'));

        await refusal();

        expect(repo.findUserByFirebaseUid).not.toHaveBeenCalled();
      });
    });

    it('needs no verifier, which is the entire point', async () => {
      // Every caller of this path has lost their passphrase and every recovery
      // code. Requiring a proof of possession would make it unreachable by
      // exactly the people it exists for.
      repo.resetVault.mockResolvedValue(true);

      await service.resetVault(services(), userPrincipal());

      expect(repo.findVaultKeys).not.toHaveBeenCalled();
      expect(repo.recordUnlockAttempt).not.toHaveBeenCalled();
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
    const stored = () => repo.setAutoLockMinutes.mock.calls[0]?.[2];

    it('refuses to invent a vault to hang a preference on', async () => {
      repo.setAutoLockMinutes.mockResolvedValue(null);

      await expect(service.setAutoLock(services(), userPrincipal(), 30)).rejects.toMatchObject({
        code: 'bad_request',
      });
    });

    it('stores a value inside the range the gate assumes, whatever was asked for', async () => {
      // The gate reads this column on every request. A row outside the range
      // would be a window nothing else in the system believes in.
      repo.setAutoLockMinutes.mockImplementation(
        async (_db: unknown, _userId: string, minutes: number | null) =>
          await vaultKeys({ verifier: randomBytes(32), autoLockMinutes: minutes }),
      );

      await expect(service.setAutoLock(services(), userPrincipal(), 1)).resolves.toBe(
        MIN_AUTO_LOCK_MINUTES,
      );
      expect(stored()).toBe(MIN_AUTO_LOCK_MINUTES);

      repo.setAutoLockMinutes.mockClear();
      await expect(service.setAutoLock(services(), userPrincipal(), 100_000)).resolves.toBe(
        MAX_AUTO_LOCK_MINUTES,
      );
      expect(stored()).toBe(MAX_AUTO_LOCK_MINUTES);
    });

    it('clears the preference on null rather than pinning today’s default into the row', async () => {
      // "Never chose" and "chose an hour" are different facts, and only the
      // first follows the default if it is ever reconsidered.
      repo.setAutoLockMinutes.mockResolvedValue(
        await vaultKeys({ verifier: randomBytes(32), autoLockMinutes: null }),
      );

      await expect(service.setAutoLock(services(), userPrincipal(), null)).resolves.toBe(
        DEFAULT_AUTO_LOCK_MINUTES,
      );
      expect(stored()).toBeNull();
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

  describe('the device PIN', () => {
    const DEVICE_ID = uuidv7();

    beforeEach(() => {
      repo.findVaultKeys.mockResolvedValue({ userId: USER_ID, autoLockMinutes: null });
      repo.mintPinPepper.mockImplementation(
        async (_exec: unknown, params: { deviceId: string }) => ({
          deviceId: params.deviceId,
          createdAt: new Date('2026-09-10T09:00:00.000Z'),
          lastUsedAt: null,
          attempts: 0,
        }),
      );
    });

    it('mints a 32-byte pepper the browser has no way of deriving', async () => {
      const result = await service.enrolDevicePin(services(), userPrincipal(), {
        deviceId: DEVICE_ID,
        verifier: b64(32),
      });

      const stored = repo.mintPinPepper.mock.calls[0]?.[1] as { pepper: Bytes };
      expect(stored.pepper).toHaveLength(32);
      // Handed over once, here, and never persisted by the client. Every later
      // use goes back through the attempt endpoint and its counter.
      expect(result.pepper).toBe(toBase64Url(stored.pepper));
    });

    it('stores the digest of the verifier, never the verifier', async () => {
      const verifier = b64(32);
      await service.enrolDevicePin(services(), userPrincipal(), {
        deviceId: DEVICE_ID,
        verifier,
      });

      const stored = repo.mintPinPepper.mock.calls[0]?.[1] as { verifierHash: Uint8Array };
      expect([...stored.verifierHash]).toEqual([...(await hashUnlockVerifier(fromB64(verifier)))]);
    });

    it('refuses to enrol against a vault that does not exist', async () => {
      repo.findVaultKeys.mockResolvedValue(null);

      await expect(
        service.enrolDevicePin(services(), userPrincipal(), {
          deviceId: DEVICE_ID,
          verifier: b64(32),
        }),
      ).rejects.toMatchObject({ code: 'bad_request' });

      expect(repo.mintPinPepper).not.toHaveBeenCalled();
    });

    it('releases the pepper and unlocks the session on a match', async () => {
      const pepper = randomBytes(32);
      repo.attemptPinUnlock.mockResolvedValue({ status: 'ok', pepper });

      const result = await service.attemptDevicePin(services(), userPrincipal(), {
        deviceId: DEVICE_ID,
        verifier: b64(32),
      });

      expect(result).toMatchObject({ outcome: 'unlocked', pepper: toBase64Url(pepper) });
      expect(repo.markSessionUnlocked).toHaveBeenCalledOnce();
    });

    it('unlocks nothing on any outcome that is not a match', async () => {
      for (const outcome of [
        { status: 'wrong', attemptsRemaining: 2 },
        { status: 'burned' },
        { status: 'unknown' },
      ]) {
        vi.clearAllMocks();
        repo.findVaultKeys.mockResolvedValue({ userId: USER_ID, autoLockMinutes: null });
        repo.attemptPinUnlock.mockResolvedValue(outcome);

        const result = await service.attemptDevicePin(services(), userPrincipal(), {
          deviceId: DEVICE_ID,
          verifier: b64(32),
        });

        expect(result.outcome, outcome.status).not.toBe('unlocked');
        expect(repo.markSessionUnlocked, outcome.status).not.toHaveBeenCalled();
      }
    });

    it('hands the comparison to the repository, so it runs inside the row lock', async () => {
      // Read-then-write would let two concurrent attempts both see four
      // failures, and a scripted attacker would get as many guesses per round
      // trip as they cared to open connections.
      const presented = randomBytes(32);
      let matched: boolean | null = null;

      repo.attemptPinUnlock.mockImplementation(
        async (_exec: unknown, params: { matches: (hash: Uint8Array) => Promise<boolean> }) => {
          matched = await params.matches(await hashUnlockVerifier(presented));
          return { status: 'wrong', attemptsRemaining: 4 };
        },
      );

      await service.attemptDevicePin(services(), userPrincipal(), {
        deviceId: DEVICE_ID,
        verifier: toBase64Url(presented),
      });

      expect(matched).toBe(true);
    });

    it('answers 404 when a device belongs to somebody else, or to nobody', async () => {
      // Indistinguishable by construction: the repository scopes by user, so
      // this service never learns which of the two it was (threat T2).
      repo.disablePinPepper.mockResolvedValue(false);

      await expect(
        service.disableDevicePin(services(), userPrincipal(), DEVICE_ID),
      ).rejects.toMatchObject({ code: 'not_found' });
    });

    it('serves a device list with no pepper, no digest, and no attempt counter', () => {
      expect(
        toPinDevice({
          deviceId: DEVICE_ID,
          createdAt: new Date('2026-09-01T10:00:00.000Z'),
          lastUsedAt: new Date('2026-09-09T10:00:00.000Z'),
          attempts: 3,
        }),
      ).toEqual({
        deviceId: DEVICE_ID,
        createdAt: '2026-09-01T10:00:00.000Z',
        lastUsedAt: '2026-09-09T10:00:00.000Z',
      });
    });
  });
});

describe('the device-PIN schemas', () => {
  const DEVICE_ID = uuidv7();

  it('takes a device uuid and a 32-byte verifier, and nothing else', () => {
    const body = { deviceId: DEVICE_ID, verifier: b64(32) };

    for (const schema of [pinEnrollSchema, pinAttemptSchema]) {
      expect(parseWith(schema, body)).toEqual(body);
    }
  });

  it('refuses a device id that is not a canonical uuid', () => {
    // It reaches a `uuid` column. Without this the driver raises `22P02` and
    // the route wrapper turns a malformed body into a 500 — see `schemas/ids.ts`.
    for (const deviceId of ['not-a-uuid', DEVICE_ID.toUpperCase(), `{${DEVICE_ID}}`, '']) {
      expect(rejected(pinEnrollSchema, { deviceId, verifier: b64(32) }).code, deviceId).toBe(
        'validation_failed',
      );
    }
  });

  it('holds the verifier to exactly 32 bytes', () => {
    for (const bytes of [16, 31, 33, 64]) {
      expect(
        rejected(pinAttemptSchema, { deviceId: DEVICE_ID, verifier: b64(bytes) }).code,
        String(bytes),
      ).toBe('validation_failed');
    }
  });

  it('refuses a body carrying the salt, which the server must never hold', () => {
    // The salt lives beside the wrap in the browser. A server holding it would
    // hold one more piece of an offline attack on six digits than it needs to,
    // and `strictObject` is what stops a client volunteering it.
    expect(
      rejected(pinEnrollSchema, {
        deviceId: DEVICE_ID,
        verifier: b64(32),
        salt: b64(16),
      }).code,
    ).toBe('validation_failed');
  });

  it('refuses a body carrying a wrap', () => {
    // The wrap never reaches this server, by design. A schema that accepted one
    // would be the first line of the code path that ends the zero-knowledge
    // property for this feature.
    expect(
      rejected(pinEnrollSchema, {
        deviceId: DEVICE_ID,
        verifier: b64(32),
        wrap: gcmBlob(),
      }).code,
    ).toBe('validation_failed');
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
  /** The UK branch's preimage. Defaults to 32 zero bytes — a value no test sends. */
  ukVerifier?: Bytes;
  failedAttempts?: number;
  lockedUntil?: Date | null;
  recoveryFailedAttempts?: number;
  recoveryLockedUntil?: Date | null;
  /** `null` — no preference — is the shape the column actually defaults to. */
  autoLockMinutes?: number | null;
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
    ukUnlockVerifierHash: await hashUnlockVerifier(
      overrides.ukVerifier ?? new Uint8Array(new ArrayBuffer(32)),
    ),
    failedAttempts: overrides.failedAttempts ?? 0,
    lockedUntil: overrides.lockedUntil ?? null,
    recoveryFailedAttempts: overrides.recoveryFailedAttempts ?? 0,
    recoveryLockedUntil: overrides.recoveryLockedUntil ?? null,
    autoLockMinutes: overrides.autoLockMinutes ?? null,
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

function userPrincipal(
  overrides: {
    vaultUnlockedAt?: Date | null;
    lastSeenAt?: Date;
    vaultAutoLockMinutes?: number | null;
  } = {},
) {
  const unlockedAt =
    'vaultUnlockedAt' in overrides ? (overrides.vaultUnlockedAt ?? null) : new Date();

  return {
    kind: 'user' as const,
    sessionId: SESSION_ID,
    vaultUnlockedAt: unlockedAt,
    // Defaults to the unlock itself, so a fixture that says nothing about
    // activity describes a session that has made no request since it unlocked —
    // the case where the idle window is measured from `vaultUnlockedAt`.
    lastSeenAt: overrides.lastSeenAt ?? unlockedAt ?? new Date(),
    vaultAutoLockMinutes: overrides.vaultAutoLockMinutes ?? null,
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

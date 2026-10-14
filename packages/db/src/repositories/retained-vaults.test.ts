import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '../testing/pglite';
import type { TestDatabase } from '../testing/pglite';
import {
  countRetainedRecoveryFailure,
  findRetainedRecoveryWrap,
  listRetainedVaults,
  loadRetainedVault,
  purgeExpiredRetainedVaults,
  restoreRetainedGrants,
} from './retained-vaults';
import type { RestoreTarget } from './retained-vaults';
import { createVault, deleteVault, findVaultKeys, resetVault } from './vault';
import type { CreateVaultParams } from './vault';
import { RepositoryError } from './shared';

/**
 * The seven-day window, against real rows and real triggers.
 *
 * Most of what matters here is a property of the database rather than of the
 * code calling it — "nobody can delete a retained vault early" is enforced by
 * migration 0020's triggers by the database's own clock — so it is tested the
 * way it is enforced: by issuing the statements a buggy or hostile caller would
 * issue and watching them fail.
 *
 * Time is injected the way the application injects it: the reset takes `now`,
 * so "eight days ago" is a reset whose `now` was eight days ago, and the purge
 * then runs at the real present. The triggers compare against the database's
 * clock, which is the real present too — so a test cannot make the database
 * believe a window has ended when it has not, which is the point.
 */

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

const DAY = 24 * 60 * 60 * 1000;
const ascii = (value: string) => new TextEncoder().encode(value);
const filled = (length: number, value: number) => new Uint8Array(length).fill(value);
const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

async function account(): Promise<string> {
  const userId = randomUUID();
  await t.pg.query(
    `insert into users (id, workos_user_id, email, email_verified) values ($1, $2, $3, true)`,
    [userId, `user_${userId.slice(0, 8)}`, `retained-${userId.slice(0, 8)}@example.com`],
  );
  return userId;
}

function vault(userId: string, seed: number): CreateVaultParams {
  return {
    userId,
    encAlgorithm: 'X25519',
    encPublicKey: filled(32, seed),
    encPrivateKeyEnc: ascii(`xk2.gcm.enc-${seed}`),
    signAlgorithm: 'Ed25519',
    signPublicKey: filled(32, seed),
    signPrivateKeyEnc: ascii(`xk2.gcm.sign-${seed}`),
    kdfSalt: filled(16, seed),
    kdfParams: { alg: 'argon2id', v: 19, m: 65536, t: 3, p: 1, len: 32 },
    unlockVerifierHash: filled(32, seed),
    ukUnlockVerifierHash: filled(32, seed + 50),
    passphraseWrap: ascii(`xk2.gcm.passphrase-${seed}`),
    // Random, because the lookup index is unique across every account and a
    // fixture reused by several tests would otherwise collide with itself.
    recoveryWraps: [
      { lookupHash: new Uint8Array(randomBytes(32)), wrap: ascii(`xk2.gcm.recovery-a-${seed}`) },
      { lookupHash: new Uint8Array(randomBytes(32)), wrap: ascii(`xk2.gcm.recovery-b-${seed}`) },
    ],
  };
}

/** The first recovery code's lookup hash, as `vault()` minted it. */
function firstCode(params: CreateVaultParams): Uint8Array {
  return params.recoveryWraps[0]!.lookupHash;
}

interface Environment {
  orgId: string;
  projectId: string;
  environmentId: string;
  edkV1: string;
  edkV2: string;
}

/** An org the account owns, with one e2ee environment rotated once (v1 retired, v2 active). */
async function environmentFor(userId: string): Promise<Environment> {
  const orgId = randomUUID();
  const projectId = randomUUID();
  const environmentId = randomUUID();
  const edkV1 = randomUUID();
  const edkV2 = randomUUID();
  await t.pg.query(
    `insert into organizations (id, name, slug, created_by) values ($1, 'Acme', $2, $3)`,
    [orgId, `acme-${orgId.slice(0, 8)}`, userId],
  );
  await t.pg.query(
    `insert into org_members (id, org_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), orgId, userId],
  );
  await t.pg.query(
    `insert into projects (id, org_id, name, slug, created_by) values ($1, $2, 'API', 'api', $3)`,
    [projectId, orgId, userId],
  );
  await t.pg.query(
    `insert into environments (id, project_id, name, slug, encryption_mode) values ($1, $2, 'Production', 'production', 'e2ee')`,
    [environmentId, projectId],
  );
  await t.pg.query(
    `insert into env_data_keys (id, environment_id, version, status, created_by) values ($1, $2, 1, 'retired', $3), ($4, $2, 2, 'active', $3)`,
    [edkV1, environmentId, userId, edkV2],
  );
  return { orgId, projectId, environmentId, edkV1, edkV2 };
}

async function grant(envDataKeyId: string, userId: string, publicKey: Uint8Array): Promise<void> {
  await t.pg.query(
    `insert into env_key_grants (id, env_data_key_id, member_user_id, edk_sealed, ehk_sealed, recipient_public_key, signature, signed_by_user_id)
     values ($1, $2, $3, $4, $5, $6, $7, $3)`,
    [
      randomUUID(),
      envDataKeyId,
      userId,
      ascii(`xk2.x25519.edk-${envDataKeyId}`),
      ascii(`xk2.x25519.ehk-${envDataKeyId}`),
      publicKey,
      ascii('xk2.ed25519.sig'),
    ],
  );
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const result = await t.pg.query<{ n: number }>(`select count(*)::int as n from ${sql}`, params);
  return result.rows[0]!.n;
}

/** Runs a statement as the database's owner would, and returns its error message, or null. */
async function attempt(sql: string, params: unknown[]): Promise<string | null> {
  try {
    await t.pg.query(sql, params);
    return null;
  } catch (cause) {
    return (cause as Error).message;
  }
}

const allowAll = (_tx: unknown, targets: readonly RestoreTarget[]) =>
  Promise.resolve(new Set(targets.map((target) => target.environmentId)));

describe('a reset retains the vault', () => {
  it('copies the key row, the live wraps and every member grant, and empties the live tables', async () => {
    const userId = await account();
    const env = await environmentFor(userId);
    await createVault(t.db, vault(userId, 1));
    await grant(env.edkV1, userId, filled(32, 1));
    await grant(env.edkV2, userId, filled(32, 1));

    const now = new Date();
    const receipt = await resetVault(t.db, userId, { now });

    expect(receipt).toMatchObject({ grantCount: 2, retainedAt: now });
    expect(receipt!.purgeAfter.getTime() - now.getTime()).toBe(7 * DAY);
    expect(await findVaultKeys(t.db, userId)).toBeNull();
    expect(await count('env_key_grants where member_user_id = $1', [userId])).toBe(0);

    const material = await loadRetainedVault(t.db, userId, receipt!.id, now);
    // Two key versions of one environment: two grants, one environment.
    expect(material).toMatchObject({
      userId,
      grantCount: 2,
      environmentCount: 1,
      recoveryCodesRemaining: 2,
      kdfParams: { m: 65536 },
    });
    expect(new TextDecoder().decode(material!.passphraseWrap)).toBe('xk2.gcm.passphrase-1');
    expect(material!.encPublicKey).toEqual(filled(32, 1));
    expect(material!.ukUnlockVerifierHash).toEqual(filled(32, 51));
    expect(material!.grants.map((each) => [each.edkVersion, each.edkStatus])).toEqual([
      [1, 'retired'],
      [2, 'active'],
    ]);
    expect(await listRetainedVaults(t.db, userId, now)).toMatchObject([
      { grantCount: 2, environmentCount: 1 },
    ]);
  });

  it('keeps neither redeemed codes nor superseded passphrase wraps', async () => {
    const userId = await account();
    const params = vault(userId, 2);
    await createVault(t.db, params);
    await t.pg.query(
      `update user_key_wraps set used_at = now() where user_id = $1 and lookup_hash = $2`,
      [userId, firstCode(params)],
    );

    const receipt = await resetVault(t.db, userId);

    const kinds = await t.pg.query<{ kind: string }>(
      `select kind from retained_vault_wraps where retained_vault_id = $1 order by kind`,
      [receipt!.id],
    );
    expect(kinds.rows.map((row) => row.kind)).toEqual(['passphrase', 'recovery']);
  });

  it('retains nothing, and answers null, when there is no vault', async () => {
    const userId = await account();
    await expect(resetVault(t.db, userId)).resolves.toBeNull();
    expect(await count('retained_vaults where user_id = $1', [userId])).toBe(0);
  });
});

describe('a second reset inside the window', () => {
  it('retains the second vault beside the first, and changes nothing about the first', async () => {
    const userId = await account();
    await createVault(t.db, vault(userId, 3));
    const first = await resetVault(t.db, userId, { now: daysAgo(3) });
    await createVault(t.db, vault(userId, 4));
    const second = await resetVault(t.db, userId);

    const listed = await listRetainedVaults(t.db, userId, new Date());
    expect(listed.map((each) => each.id)).toEqual([second!.id, first!.id]);
    // The first window still ends seven days after the first reset, not the second.
    expect(listed[1]!.purgeAfter.getTime()).toBe(first!.purgeAfter.getTime());
  });
});

describe('the window', () => {
  it('is invisible to every read the moment it ends, before any purge has run', async () => {
    const userId = await account();
    const params = vault(userId, 5);
    await createVault(t.db, params);
    const receipt = await resetVault(t.db, userId, { now: daysAgo(8) });

    expect(await listRetainedVaults(t.db, userId, new Date())).toEqual([]);
    expect(await loadRetainedVault(t.db, userId, receipt!.id, new Date())).toBeNull();
    expect(
      await findRetainedRecoveryWrap(t.db, {
        userId,
        retainedVaultId: receipt!.id,
        lookupHash: firstCode(params),
        now: new Date(),
      }),
    ).toBeNull();
    // …while the row itself is still there, waiting for the purge.
    expect(await count('retained_vaults where id = $1', [receipt!.id])).toBe(1);
  });

  it('serves a retained vault to its owner only', async () => {
    const owner = await account();
    const stranger = await account();
    const params = vault(owner, 6);
    await createVault(t.db, params);
    const receipt = await resetVault(t.db, owner);

    expect(await loadRetainedVault(t.db, stranger, receipt!.id, new Date())).toBeNull();
    expect(
      await findRetainedRecoveryWrap(t.db, {
        userId: stranger,
        retainedVaultId: receipt!.id,
        lookupHash: firstCode(params),
        now: new Date(),
      }),
    ).toBeNull();
    expect(
      await findRetainedRecoveryWrap(t.db, {
        userId: owner,
        retainedVaultId: receipt!.id,
        lookupHash: firstCode(params),
        now: new Date(),
      }),
    ).toEqual(ascii('xk2.gcm.recovery-a-6'));
  });

  it('survives the account deleting its new vault', async () => {
    const userId = await account();
    await createVault(t.db, vault(userId, 7));
    const receipt = await resetVault(t.db, userId);
    await createVault(t.db, vault(userId, 8));

    await deleteVault(t.db, userId);

    expect(await count('retained_vaults where id = $1', [receipt!.id])).toBe(1);
  });
});

describe('nobody can delete a retained vault inside its window', () => {
  async function retained(): Promise<{ id: string; userId: string }> {
    const userId = await account();
    const env = await environmentFor(userId);
    await createVault(t.db, vault(userId, 9));
    await grant(env.edkV2, userId, filled(32, 9));
    const receipt = await resetVault(t.db, userId);
    return { id: receipt!.id, userId };
  }

  it('refuses a direct DELETE of the vault', async () => {
    const { id } = await retained();
    expect(await attempt(`delete from retained_vaults where id = $1`, [id])).toMatch(
      /inside its seven-day window/,
    );
    expect(await count('retained_vaults where id = $1', [id])).toBe(1);
  });

  it('refuses hollowing it out row by row', async () => {
    const { id } = await retained();
    expect(
      await attempt(`delete from retained_vault_wraps where retained_vault_id = $1`, [id]),
    ).toMatch(/inside its seven-day window/);
    expect(
      await attempt(`delete from retained_vault_grants where retained_vault_id = $1`, [id]),
    ).toMatch(/inside its seven-day window/);
  });

  it('refuses moving the window, and any change to the key material', async () => {
    const { id } = await retained();
    for (const statement of [
      `update retained_vaults set purge_after = now(), retained_at = now() - interval '168 hours' where id = $1`,
      `update retained_vaults set enc_public_key = enc_public_key || '\\x00'::bytea where id = $1`,
      `update retained_vaults set user_id = (select id from users limit 1) where id = $1`,
      `update retained_vault_wraps set wrap = wrap where retained_vault_id = $1`,
      `update retained_vault_grants set edk_sealed = edk_sealed where retained_vault_id = $1`,
    ]) {
      expect(await attempt(statement, [id]), statement).toMatch(/immutable/);
    }
  });

  it('allows the recovery bookkeeping to change', async () => {
    const { id } = await retained();
    expect(
      await attempt(
        `update retained_vaults set recovered_at = now(), recovery_failed_attempts = 3 where id = $1`,
        [id],
      ),
    ).toBeNull();
  });

  it('refuses a window that is not exactly seven days', async () => {
    const { userId } = await retained();
    const error = await attempt(
      `insert into retained_vaults (id, user_id, enc_algorithm, enc_public_key, enc_private_key_enc, sign_algorithm, sign_public_key, sign_private_key_enc, kdf_salt, kdf_params, unlock_verifier_hash, uk_unlock_verifier_hash, vault_created_at, retained_at, purge_after)
       select $1, user_id, enc_algorithm, enc_public_key, enc_private_key_enc, sign_algorithm, sign_public_key, sign_private_key_enc, kdf_salt, kdf_params, unlock_verifier_hash, uk_unlock_verifier_hash, vault_created_at, now(), now() + interval '1 hour'
       from retained_vaults where user_id = $2 limit 1`,
      [randomUUID(), userId],
    );
    expect(error).toMatch(/retained_vaults_window_check/);
  });

  it('refuses even a cascade from deleting the account outright', async () => {
    // An account with no organisation and no grants, so no other foreign key
    // stands in the way and the cascade reaches the retained vault.
    const userId = await account();
    await createVault(t.db, vault(userId, 16));
    await resetVault(t.db, userId);
    expect(await attempt(`delete from users where id = $1`, [userId])).toMatch(
      /inside its seven-day window/,
    );
  });
});

describe('the purge', () => {
  it('removes a vault whose seven days have passed, with its wraps and grants', async () => {
    const userId = await account();
    const env = await environmentFor(userId);
    await createVault(t.db, vault(userId, 10));
    await grant(env.edkV2, userId, filled(32, 10));
    const receipt = await resetVault(t.db, userId, { now: daysAgo(8) });

    const purged = await purgeExpiredRetainedVaults(t.db, 100);

    expect(purged.find((each) => each.id === receipt!.id)).toMatchObject({ userId, grantCount: 1 });
    expect(await count('retained_vaults where id = $1', [receipt!.id])).toBe(0);
    expect(await count('retained_vault_wraps where retained_vault_id = $1', [receipt!.id])).toBe(0);
    expect(await count('retained_vault_grants where retained_vault_id = $1', [receipt!.id])).toBe(
      0,
    );
  });

  it('leaves a vault inside its window alone', async () => {
    const userId = await account();
    await createVault(t.db, vault(userId, 11));
    const receipt = await resetVault(t.db, userId, { now: daysAgo(6) });

    const purged = await purgeExpiredRetainedVaults(t.db, 100);

    expect(purged.map((each) => each.id)).not.toContain(receipt!.id);
    expect(await count('retained_vaults where id = $1', [receipt!.id])).toBe(1);
  });

  it('chooses by the database clock: an application clock has no say', async () => {
    // The purge asks the database which vaults are past their window; a vault
    // six days into it is not chosen however the caller's clock is set.
    const userId = await account();
    await createVault(t.db, vault(userId, 12));
    const receipt = await resetVault(t.db, userId, { now: daysAgo(6) });

    expect((await purgeExpiredRetainedVaults(t.db, 100)).map((each) => each.id)).not.toContain(
      receipt!.id,
    );
    expect(await count('retained_vaults where id = $1', [receipt!.id])).toBe(1);
  });

  it('records each purge in its own transaction: a failed record purges nothing', async () => {
    const userId = await account();
    await createVault(t.db, vault(userId, 17));
    const receipt = await resetVault(t.db, userId, { now: daysAgo(8) });

    await expect(
      purgeExpiredRetainedVaults(t.db, 100, () => Promise.reject(new Error('audit down'))),
    ).rejects.toThrow('audit down');
    expect(await count('retained_vaults where id = $1', [receipt!.id])).toBe(1);

    const recorded: string[] = [];
    await purgeExpiredRetainedVaults(t.db, 100, async (_tx, purged) => {
      recorded.push(...purged.map((each) => each.id));
    });
    expect(recorded).toContain(receipt!.id);
    expect(await count('retained_vaults where id = $1', [receipt!.id])).toBe(0);
  });

  it('takes at most `limit` vaults per call', async () => {
    for (const seed of [13, 14, 15]) {
      const userId = await account();
      await createVault(t.db, vault(userId, seed));
      await resetVault(t.db, userId, { now: daysAgo(9) });
    }
    expect(await purgeExpiredRetainedVaults(t.db, 1)).toHaveLength(1);
  });
});

describe('a reset bound to the vault its archive was built from', () => {
  it('refuses to retain a different vault, and changes nothing', async () => {
    const userId = await account();
    await createVault(t.db, vault(userId, 40));

    const failure = await resetVault(t.db, userId, { expectedEncPublicKey: filled(32, 41) }).catch(
      (cause: unknown) => cause,
    );

    expect(failure).toBeInstanceOf(RepositoryError);
    expect((failure as RepositoryError).code).toBe('conflict');
    expect(await findVaultKeys(t.db, userId)).not.toBeNull();
    expect(await count('retained_vaults where user_id = $1', [userId])).toBe(0);
  });

  it('retains the vault it names', async () => {
    const userId = await account();
    await createVault(t.db, vault(userId, 42));
    await expect(
      resetVault(t.db, userId, { expectedEncPublicKey: filled(32, 42) }),
    ).resolves.toMatchObject({ grantCount: 0 });
  });
});

describe('counting failed recovery proofs', () => {
  it('adds one per failure in SQL, and only ever lengthens the lockout', async () => {
    const userId = await account();
    await createVault(t.db, vault(userId, 43));
    const receipt = await resetVault(t.db, userId);
    const soon = new Date(Date.now() + 60_000);
    const later = new Date(Date.now() + 3_600_000);

    await countRetainedRecoveryFailure(t.db, receipt!.id, () => null);
    await countRetainedRecoveryFailure(t.db, receipt!.id, () => later);
    const state = await countRetainedRecoveryFailure(t.db, receipt!.id, () => soon);

    expect(state.failedAttempts).toBe(3);
    // The shorter lockout the third failure earned does not shorten the second's.
    expect(state.lockedUntil?.getTime()).toBe(later.getTime());
  });

  it('never locks past the purge', async () => {
    const userId = await account();
    await createVault(t.db, vault(userId, 49));
    const receipt = await resetVault(t.db, userId);

    const state = await countRetainedRecoveryFailure(
      t.db,
      receipt!.id,
      () => new Date(Date.now() + 30 * DAY),
    );

    expect(state.lockedUntil?.getTime()).toBe(receipt!.purgeAfter.getTime());
  });
});

describe('the window cannot be bypassed by shadowing', () => {
  it('ignores a temporary table named retained_vaults', async () => {
    const userId = await account();
    await createVault(t.db, vault(userId, 44));
    const receipt = await resetVault(t.db, userId);

    await t.pg.exec(`create temp table retained_vaults (id uuid, purge_after timestamptz)`);
    // Any role may do this, and without it a plan cached from an earlier call
    // would hide whether the function resolves the name afresh.
    await t.pg.exec(`discard plans`);
    try {
      expect(
        await attempt(`delete from public.retained_vault_wraps where retained_vault_id = $1`, [
          receipt!.id,
        ]),
      ).toMatch(/inside its seven-day window/);
      expect(
        await attempt(`delete from public.retained_vaults where id = $1`, [receipt!.id]),
      ).toMatch(/inside its seven-day window/);
    } finally {
      await t.pg.exec(`drop table pg_temp.retained_vaults`);
    }
    expect(await count('retained_vault_wraps where retained_vault_id = $1', [receipt!.id])).toBe(3);
  });

  it('ignores a now() of the caller’s own making', async () => {
    const userId = await account();
    await createVault(t.db, vault(userId, 45));
    const receipt = await resetVault(t.db, userId);

    await t.pg.exec(
      `create function public.now() returns timestamptz language sql as $$ select timestamptz '2999-01-01' $$`,
    );
    try {
      expect(
        await attempt(`delete from public.retained_vaults where id = $1`, [receipt!.id]),
      ).toMatch(/inside its seven-day window/);
    } finally {
      await t.pg.exec(`drop function public.now()`);
    }
  });
});

describe('the application role', () => {
  /** Runs `sql` as xecret_app_permissions, the role production runs as. */
  async function asApp(sql: string, params: unknown[]): Promise<string | null> {
    await t.pg.exec('set role xecret_app_permissions');
    try {
      return await attempt(sql, params);
    } finally {
      await t.pg.exec('reset role');
    }
  }

  it('may purge an expired vault, the wraps and grants going by cascade', async () => {
    const userId = await account();
    const env = await environmentFor(userId);
    await createVault(t.db, vault(userId, 46));
    await grant(env.edkV2, userId, filled(32, 46));
    const receipt = await resetVault(t.db, userId, { now: daysAgo(8) });

    expect(
      await asApp(`delete from public.retained_vaults where id = $1 and purge_after <= now()`, [
        receipt!.id,
      ]),
    ).toBeNull();
    expect(await count('retained_vault_wraps where retained_vault_id = $1', [receipt!.id])).toBe(0);
    expect(await count('retained_vault_grants where retained_vault_id = $1', [receipt!.id])).toBe(
      0,
    );
  });

  it('may not touch a wrap or a grant, or the key material or the window, at all', async () => {
    const userId = await account();
    await createVault(t.db, vault(userId, 47));
    const receipt = await resetVault(t.db, userId);

    for (const statement of [
      `delete from public.retained_vault_wraps where retained_vault_id = $1`,
      `update public.retained_vault_wraps set wrap = wrap where retained_vault_id = $1`,
      `delete from public.retained_vault_grants where retained_vault_id = $1`,
      `update public.retained_vaults set purge_after = purge_after where id = $1`,
      `update public.retained_vaults set enc_public_key = enc_public_key where id = $1`,
    ]) {
      expect(await asApp(statement, [receipt!.id]), statement).toMatch(/permission denied/);
    }
  });

  it('may update the recovery bookkeeping', async () => {
    const userId = await account();
    await createVault(t.db, vault(userId, 48));
    const receipt = await resetVault(t.db, userId);

    expect(
      await asApp(
        `update public.retained_vaults set recovered_at = now(), recovery_failed_attempts = 1, recovery_locked_until = null where id = $1`,
        [receipt!.id],
      ),
    ).toBeNull();
  });

  it('may not lock recovery past the purge', async () => {
    const userId = await account();
    await createVault(t.db, vault(userId, 50));
    const receipt = await resetVault(t.db, userId);

    expect(
      await asApp(
        `update public.retained_vaults set recovery_locked_until = purge_after + interval '1 second' where id = $1`,
        [receipt!.id],
      ),
    ).toMatch(/retained_vaults_lock_check/);
    expect(
      await asApp(
        `update public.retained_vaults set recovery_locked_until = purge_after where id = $1`,
        [receipt!.id],
      ),
    ).toBeNull();
  });
});

describe('restoring a retained vault into the current one', () => {
  async function scenario() {
    const userId = await account();
    const env = await environmentFor(userId);
    await createVault(t.db, vault(userId, 20));
    await grant(env.edkV1, userId, filled(32, 20));
    await grant(env.edkV2, userId, filled(32, 20));
    const receipt = await resetVault(t.db, userId, {
      requeue: async (tx) => {
        await tx.execute(
          `insert into pending_key_grants (id, environment_id, target_user_id, requested_by) values ('${randomUUID()}', '${env.environmentId}', '${userId}', '${userId}')` as never,
        );
      },
    });
    await createVault(t.db, vault(userId, 21));
    const seed = (envDataKeyId: string, publicKeySeed = 21) => ({
      envDataKeyId,
      recipientPublicKey: filled(32, publicKeySeed),
      edkSealed: ascii(`xk2.x25519.re-edk-${envDataKeyId}`),
      ehkSealed: ascii(`xk2.x25519.re-ehk-${envDataKeyId}`),
      signature: ascii('xk2.ed25519.re-sig'),
    });
    return { userId, env, retainedVaultId: receipt!.id, seed };
  }

  it('writes the keys as grants to the current vault and settles the pending share', async () => {
    const { userId, env, retainedVaultId, seed } = await scenario();
    expect(await count('pending_key_grants where target_user_id = $1', [userId])).toBe(1);

    const result = await restoreRetainedGrants(t.db, {
      userId,
      retainedVaultId,
      grants: [seed(env.edkV1), seed(env.edkV2)],
      now: new Date(),
      authorize: allowAll,
    });

    expect(result.restored.map((each) => each.envDataKeyId).sort()).toEqual(
      [env.edkV1, env.edkV2].sort(),
    );
    expect(result.skipped).toEqual([]);
    const rows = await t.pg.query<{ recipient_public_key: Uint8Array }>(
      `select recipient_public_key from env_key_grants where member_user_id = $1`,
      [userId],
    );
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows)
      expect(new Uint8Array(row.recipient_public_key)).toEqual(filled(32, 21));
    expect(await count('pending_key_grants where target_user_id = $1', [userId])).toBe(0);
    expect(
      await count('retained_vaults where id = $1 and recovered_at is not null', [retainedVaultId]),
    ).toBe(1);
  });

  it('skips a key the account already holds again — a teammate re-shared it in the window', async () => {
    const { userId, env, retainedVaultId, seed } = await scenario();
    await grant(env.edkV2, userId, filled(32, 21));

    const result = await restoreRetainedGrants(t.db, {
      userId,
      retainedVaultId,
      grants: [seed(env.edkV2)],
      now: new Date(),
      authorize: allowAll,
    });

    expect(result).toEqual({
      restored: [],
      skipped: [{ envDataKeyId: env.edkV2, reason: 'already-held' }],
    });
  });

  it('skips an environment the account may no longer read', async () => {
    const { userId, env, retainedVaultId, seed } = await scenario();

    const result = await restoreRetainedGrants(t.db, {
      userId,
      retainedVaultId,
      grants: [seed(env.edkV2)],
      now: new Date(),
      authorize: () => Promise.resolve(new Set()),
    });

    expect(result.skipped).toEqual([{ envDataKeyId: env.edkV2, reason: 'no-access' }]);
    expect(await count('env_key_grants where member_user_id = $1', [userId])).toBe(0);
  });

  it('skips an environment deleted since the reset', async () => {
    const { userId, env, retainedVaultId, seed } = await scenario();
    await t.pg.query(`update environments set deleted_at = now() where id = $1`, [
      env.environmentId,
    ]);

    const result = await restoreRetainedGrants(t.db, {
      userId,
      retainedVaultId,
      grants: [seed(env.edkV2)],
      now: new Date(),
      authorize: allowAll,
    });

    expect(result.skipped).toEqual([{ envDataKeyId: env.edkV2, reason: 'environment-gone' }]);
  });

  const refusals: [
    string,
    (s: Awaited<ReturnType<typeof scenario>>) => Parameters<typeof restoreRetainedGrants>[1],
    RepositoryError['code'],
    RegExp,
  ][] = [
    [
      'a grant sealed to some other key',
      (s) => ({
        userId: s.userId,
        retainedVaultId: s.retainedVaultId,
        grants: [s.seed(s.env.edkV2, 99)],
        now: new Date(),
        authorize: allowAll,
      }),
      'invalid',
      /not sealed to this account's current vault/,
    ],
    [
      'a key the retained vault never held',
      (s) => ({
        userId: s.userId,
        retainedVaultId: s.retainedVaultId,
        grants: [s.seed(randomUUID())],
        now: new Date(),
        authorize: allowAll,
      }),
      'invalid',
      /never held/,
    ],
    [
      'the same key twice',
      (s) => ({
        userId: s.userId,
        retainedVaultId: s.retainedVaultId,
        grants: [s.seed(s.env.edkV2), s.seed(s.env.edkV2)],
        now: new Date(),
        authorize: allowAll,
      }),
      'invalid',
      /twice/,
    ],
    [
      'a vault past its window',
      (s) => ({
        userId: s.userId,
        retainedVaultId: s.retainedVaultId,
        grants: [s.seed(s.env.edkV2)],
        now: new Date(Date.now() + 8 * DAY),
        authorize: allowAll,
      }),
      'notFound',
      /No such retained vault/,
    ],
  ];

  it.each(refusals)('refuses %s', async (_label, build, code, message) => {
    const s = await scenario();
    const failure = await restoreRetainedGrants(t.db, build(s)).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(RepositoryError);
    expect((failure as RepositoryError).code).toBe(code);
    expect((failure as Error).message).toMatch(message);
    expect(await count('env_key_grants where member_user_id = $1', [s.userId])).toBe(0);
  });

  it("refuses another account's retained vault, as if it did not exist", async () => {
    const s = await scenario();
    const stranger = await account();
    await createVault(t.db, vault(stranger, 30));
    const failure = await restoreRetainedGrants(t.db, {
      userId: stranger,
      retainedVaultId: s.retainedVaultId,
      grants: [],
      now: new Date(),
      authorize: allowAll,
    }).catch((cause: unknown) => cause);
    expect((failure as RepositoryError).code).toBe('notFound');
  });

  it('refuses when there is no current vault to restore into', async () => {
    const userId = await account();
    await createVault(t.db, vault(userId, 31));
    const receipt = await resetVault(t.db, userId);
    const failure = await restoreRetainedGrants(t.db, {
      userId,
      retainedVaultId: receipt!.id,
      grants: [],
      now: new Date(),
      authorize: allowAll,
    }).catch((cause: unknown) => cause);
    expect((failure as RepositoryError).code).toBe('conflict');
  });
});

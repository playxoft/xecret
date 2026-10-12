import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '../testing/pglite';
import type { TestDatabase } from '../testing/pglite';
import {
  createVault,
  deleteVault,
  enrollPasskey,
  findRecoveryWrap,
  loadVault,
  resetVault,
} from './vault';
import type { CreateVaultParams } from './vault';

/**
 * Destroying a vault leaves nothing behind that the next vault collides with.
 *
 * Against real rows, because the defect this pins was invisible to every test
 * that inspected SQL: `deleteVault` issued a perfectly good `DELETE FROM
 * user_keys`, and the wraps survived because the cascade the code relied on
 * does not exist — `user_key_wraps` references `users`. The consequence was an
 * account that could never set up a vault again after a reset.
 */

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

const ascii = (value: string) => new TextEncoder().encode(value);
const filled = (length: number, value: number) => new Uint8Array(length).fill(value);

async function account(): Promise<string> {
  const userId = randomUUID();
  await t.pg.query(
    `insert into users (id, workos_user_id, email, email_verified) values ($1, $2, $3, true)`,
    [userId, `user_${userId.slice(0, 8)}`, `reset-${userId.slice(0, 8)}@example.com`],
  );
  return userId;
}

/** A vault whose bytes are recognisable by `seed`, with one recovery code. */
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
    ukUnlockVerifierHash: filled(32, seed),
    passphraseWrap: ascii(`xk2.gcm.passphrase-${seed}`),
    recoveryWraps: [{ lookupHash: filled(32, seed + 100), wrap: ascii(`xk2.gcm.recovery-${seed}`) }],
  };
}

async function wrapsOf(userId: string): Promise<string[]> {
  const result = await t.pg.query<{ kind: string }>(
    `select kind from user_key_wraps where user_id = $1 order by kind`,
    [userId],
  );
  return result.rows.map((row) => row.kind);
}

describe('a vault reset', () => {
  it('lets the account set up a new vault afterwards', async () => {
    const userId = await account();
    await createVault(t.db, vault(userId, 1));

    await expect(resetVault(t.db, userId)).resolves.toBe(true);

    // The setup ceremony a reset exists to reach. It used to be refused with
    // "this account already has a vault", by the old live passphrase wrap.
    await expect(createVault(t.db, vault(userId, 2))).resolves.toBeUndefined();

    const loaded = await loadVault(t.db, userId);
    expect(new TextDecoder().decode(loaded?.passphraseWrap)).toBe('xk2.gcm.passphrase-2');
    expect(loaded?.recoveryCodesRemaining).toBe(1);
  });

  it('leaves no wrap and no passkey of the destroyed User Key', async () => {
    const userId = await account();
    await createVault(t.db, vault(userId, 3));
    await enrollPasskey(t.db, {
      userId,
      credentialId: filled(16, 3),
      label: 'Laptop',
      transports: null,
      wrap: ascii('xk2.gcm.prf-3'),
    });
    expect(await wrapsOf(userId)).toEqual(['passphrase', 'prf', 'recovery']);

    await resetVault(t.db, userId);

    expect(await wrapsOf(userId)).toEqual([]);
    const passkeys = await t.pg.query(`select 1 from user_passkeys where user_id = $1`, [userId]);
    expect(passkeys.rows).toEqual([]);
  });

  it('retires the old recovery codes rather than leaving them redeemable', async () => {
    const userId = await account();
    await createVault(t.db, vault(userId, 4));
    expect(await findRecoveryWrap(t.db, filled(32, 104))).not.toBeNull();

    await resetVault(t.db, userId);

    // A code for a key whose private keys are gone used to resolve here, and
    // `completeRecovery` would have re-wrapped that dead key under a new
    // passphrase — a vault that unlocks and then decrypts nothing.
    expect(await findRecoveryWrap(t.db, filled(32, 104))).toBeNull();
  });
});

describe('deleting a vault for account deletion', () => {
  it('takes every wrap with it', async () => {
    const userId = await account();
    await createVault(t.db, vault(userId, 5));

    await expect(deleteVault(t.db, userId)).resolves.toBe(true);

    expect(await wrapsOf(userId)).toEqual([]);
    expect(await findRecoveryWrap(t.db, filled(32, 105))).toBeNull();
  });

  it('reports that there was nothing to delete, and deletes nothing of anybody else', async () => {
    const owner = await account();
    const bystander = await account();
    await createVault(t.db, vault(bystander, 6));

    await expect(deleteVault(t.db, owner)).resolves.toBe(false);

    expect(await wrapsOf(bystander)).toEqual(['passphrase', 'recovery']);
  });
});

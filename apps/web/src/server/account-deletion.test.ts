import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { generateToken } from '@xecret/core/auth';
import { createSession, createVault, enrollPasskey, mintPinPepper } from '@xecret/db/repositories';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '@xecret/db/testing';
import type { TestDatabase } from '@xecret/db/testing';
import { deleteAccount } from './account-service';
import type { ServiceContext } from './context';

/**
 * Account deletion against a real database: what `planAccountDeletion` decides
 * is tested beside it, purely; this is what the transaction then leaves
 * behind. The `users` row survives a soft delete, so nothing that hangs off it
 * is removed by a cascade — every vault table has to be emptied by name, and
 * a deletion that skipped one would leave a wrap of the User Key on the server
 * for an account that no longer exists.
 */

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

beforeEach(() => {
  t.reset();
});

const ascii = (value: string) => new TextEncoder().encode(value);
const bytes = (length: number) => new Uint8Array(randomBytes(length));

async function count(table: string, userId: string): Promise<number> {
  const result = await t.pg.query<{ n: number }>(
    `select count(*)::int as n from ${table} where user_id = $1`,
    [userId],
  );
  return result.rows[0]!.n;
}

describe('deleting an account', () => {
  it('leaves no vault, wrap, passkey or device PIN behind', async () => {
    const userId = randomUUID();
    await t.pg.query(
      `insert into users (id, workos_user_id, email, email_verified) values ($1, $2, $3, true)`,
      [userId, `user_01${userId.replaceAll('-', '').slice(0, 20)}`, `gone-${userId}@example.com`],
    );
    const { token } = await generateToken('session');
    await createSession(t.db, { userId, token, ipAddress: null, userAgent: null });

    await createVault(t.db, {
      userId,
      encAlgorithm: 'X25519',
      encPublicKey: bytes(32),
      encPrivateKeyEnc: ascii('xk2.gcm.enc'),
      signAlgorithm: 'Ed25519',
      signPublicKey: bytes(32),
      signPrivateKeyEnc: ascii('xk2.gcm.sign'),
      kdfSalt: bytes(16),
      kdfParams: { alg: 'argon2id', v: 19, m: 65536, t: 3, p: 1, len: 32 },
      unlockVerifierHash: bytes(32),
      ukUnlockVerifierHash: bytes(32),
      passphraseWrap: ascii('xk2.gcm.passphrase'),
      recoveryWraps: [{ lookupHash: bytes(32), wrap: ascii('xk2.gcm.recovery') }],
    });
    await enrollPasskey(t.db, {
      userId,
      credentialId: bytes(16),
      label: 'Laptop',
      transports: null,
      wrap: ascii('xk2.gcm.prf'),
    });
    await mintPinPepper(t.db, {
      userId,
      deviceId: randomUUID(),
      pepper: bytes(32),
      verifierHash: bytes(32),
    });

    // Everything is there before.
    expect(await count('user_keys', userId)).toBe(1);
    expect(await count('user_key_wraps', userId)).toBe(3);
    expect(await count('user_passkeys', userId)).toBe(1);
    expect(await count('vault_pin_peppers', userId)).toBe(1);

    await deleteAccount({ db: t.db } as unknown as ServiceContext, userId);

    expect(await count('user_keys', userId)).toBe(0);
    expect(await count('user_key_wraps', userId)).toBe(0);
    expect(await count('user_passkeys', userId)).toBe(0);
    expect(await count('vault_pin_peppers', userId)).toBe(0);
    // The account itself is soft-deleted, which is why none of that cascaded.
    const user = await t.pg.query<{ deleted_at: Date | null }>(
      `select deleted_at from users where id = $1`,
      [userId],
    );
    expect(user.rows[0]!.deleted_at).toBeInstanceOf(Date);
  });
});

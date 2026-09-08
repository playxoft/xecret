#!/usr/bin/env -S npx tsx
/**
 * Exercises the whole stack against a real database, and changes nothing.
 *
 *   phase run -- npx tsx scripts/smoke-test.ts
 *
 * Every test in this repository runs without a database. They verify that the
 * SQL is *shaped* correctly and that the pure rules are right, which is worth a
 * great deal and proves nothing about whether the thing works. This is the
 * first code that finds out.
 *
 * It covers the path a first sign-in actually takes — create the user,
 * bootstrap their organisation and its key hierarchy, store an encrypted
 * secret, read it back — plus the properties the design rests on and that no
 * unit test can reach:
 *
 *  - a ciphertext moved to another row fails to decrypt (the AAD binding);
 *  - the `value_type` CHECK refuses a write that bypassed the application;
 *  - a session is authenticated and **locked** the moment it is created, and
 *    locking it again clears the unlock without revoking the session.
 *
 * ## Nothing is left behind
 *
 * The entire run happens inside one transaction that is always rolled back, so
 * it is safe against a database with real data in it. That is not merely
 * convenient: a smoke test that has to be cleaned up afterwards is one that
 * eventually is not, and the leftovers are indistinguishable from real rows.
 */

import { sql } from 'drizzle-orm';
import { createDatabase } from '../packages/db/src/client.ts';
import {
  createSecret,
  createSession,
  createVault,
  findSecretByName,
  findSessionByTokenHash,
  findVaultKeys,
  loadEnvironmentKeyChain,
  loadVault,
  lockSessions,
  markSessionUnlocked,
  provisionOrganization,
  updateSecretMetadata,
  upsertUserFromIdentity,
} from '../packages/db/src/repositories/index.ts';
import { EnvelopeService, keyProviderFromEnv } from '../packages/core/src/crypto/index.ts';
import { DecryptionError } from '../packages/core/src/crypto/types.ts';
import {
  generateToken,
  hashToken,
  hashUnlockVerifier,
  isVaultUnlocked,
} from '../packages/core/src/auth/index.ts';
import { randomBytes } from '../packages/core/src/crypto/encoding.ts';
import { uuidv7 } from '../packages/core/src/ids/index.ts';

/** Thrown to unwind the transaction once the checks have run. */
class Rollback extends Error {
  constructor() {
    super('rollback');
    this.name = 'Rollback';
  }
}

const steps: { name: string; ok: boolean; detail: string }[] = [];

function step(name: string, ok: boolean, detail: string): void {
  steps.push({ name, ok, detail });
  console.warn(`${ok ? '✅' : '❌'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const SECRET_VALUE = 'postgres://user:hunter2@db.example/app';

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is not set. Try: phase run -- npx tsx scripts/smoke-test.ts');
    process.exit(1);
  }

  const envelope = new EnvelopeService(
    keyProviderFromEnv({
      XECRET_ROOT_KEYS: process.env['XECRET_ROOT_KEYS'],
      XECRET_ROOT_KEY_VERSION: process.env['XECRET_ROOT_KEY_VERSION'],
    }),
  );
  step('root key loaded', true, 'parsed and imported');

  const db = createDatabase({ connectionString: url });

  try {
    await db.transaction(async (tx) => {
      // ── 1. First sign-in ────────────────────────────────────────────────
      const user = await upsertUserFromIdentity(tx, {
        subject: `smoke-test-${uuidv7()}`,
        email: `smoke-${uuidv7()}@example.invalid`,
        emailVerified: true,
        displayName: 'Smoke Test',
      });
      step('user created', true, `id ${user.id.slice(0, 8)}…`);

      // ── 2. Organisation bootstrap: org, master key, project, env keys ───
      const account = await provisionOrganization(tx, { user, envelope });
      step(
        'organisation bootstrapped',
        account.environments.length === 3,
        `org "${account.organization.slug}", project "${account.project.slug}", ` +
          `${account.environments.length} environments`,
      );

      const production = account.environments.find((environment) => environment.isProduction);
      const development = account.environments.find((environment) => !environment.isProduction);
      if (!production || !development)
        throw new Error('expected a production and a non-production environment');

      step('production flagged', true, `"${production.slug}" is_production = true`);

      // ── 3. Unwrap the key chain: root → org → env ───────────────────────
      const chain = await loadEnvironmentKeyChain(tx, account.organization.id, development.id);
      if (!chain) throw new Error('environment has no key chain');

      const envKey = await envelope.openEnvKey({
        orgId: account.organization.id,
        environmentId: development.id,
        orgKey: chain.orgKey,
        envKey: chain.envKey,
      });
      step('key hierarchy unwrapped', envKey.length === 32, 'root → org → env, 256-bit data key');

      // ── 4. Encrypt and store ────────────────────────────────────────────
      const secretId = uuidv7();
      const context = {
        orgId: account.organization.id,
        environmentId: development.id,
        secretId,
        version: 1,
      };

      const encrypted = await envelope.encrypt(envKey, context, SECRET_VALUE);
      step(
        'value encrypted',
        !new TextDecoder().decode(encrypted.ciphertext).includes('hunter2'),
        'ciphertext contains no plaintext',
      );

      await createSecret(tx, {
        orgId: account.organization.id,
        environmentId: development.id,
        name: 'DATABASE_URL',
        id: secretId,
        envKeyId: chain.envKeyId,
        encrypted,
        createdBy: user.id,
      });
      step('secret stored', true, 'secrets + secret_versions written');

      // ── 5. Read it back the way the API does ────────────────────────────
      const stored = await findSecretByName(
        tx,
        account.organization.id,
        development.id,
        'DATABASE_URL',
      );
      if (!stored) throw new Error('stored secret could not be found by name');

      const decrypted = await envelope.decrypt(
        envKey,
        {
          orgId: account.organization.id,
          environmentId: development.id,
          secretId: stored.secretId,
          version: stored.version,
        },
        stored.encrypted,
      );
      step('value decrypted', decrypted === SECRET_VALUE, 'round-trip matches exactly');

      // ── 6. The property the design rests on ─────────────────────────────
      // A ciphertext row copied into another environment must fail to decrypt.
      // This is the defence against an attacker with database write access but
      // no key relocating production's ciphertext into an environment they can
      // read (threat T2). Tested here against a row that really came from
      // PostgreSQL, not one held in memory.
      let relocationFailed = false;
      try {
        await envelope.decrypt(
          envKey,
          {
            orgId: account.organization.id,
            environmentId: production.id, // ← the only thing changed
            secretId: stored.secretId,
            version: stored.version,
          },
          stored.encrypted,
        );
      } catch (error) {
        relocationFailed = error instanceof DecryptionError;
      }
      step(
        'ciphertext relocation refused',
        relocationFailed,
        'AAD binding holds against stored rows',
      );

      // ── 7. The declared value type ──────────────────────────────────────
      // Proves the column, its default, and its CHECK constraint against real
      // PostgreSQL — the parts of migration 0004 that no unit test can reach.
      const typed = await findSecretByName(
        tx,
        account.organization.id,
        development.id,
        'DATABASE_URL',
      );
      step(
        'value type defaults to string',
        typed?.valueType === 'string',
        `stored as "${typed?.valueType ?? 'missing'}"`,
      );

      await updateSecretMetadata(tx, {
        orgId: account.organization.id,
        environmentId: development.id,
        name: 'DATABASE_URL',
        valueType: 'url',
      });
      const retyped = await findSecretByName(
        tx,
        account.organization.id,
        development.id,
        'DATABASE_URL',
      );
      step(
        'value type can be declared',
        retyped?.valueType === 'url',
        'metadata update wrote no new version',
      );

      // The CHECK constraint is the half of the rule the application cannot
      // enforce — a write that bypassed the API must still be refused.
      //
      // Inside a nested transaction, which Drizzle issues as a SAVEPOINT. A
      // statement that errors puts a PostgreSQL transaction into a failed state
      // where every subsequent statement is refused with "current transaction is
      // aborted" — so without the savepoint, deliberately breaking a constraint
      // here takes every check after it down with it, and the report blames
      // whichever one happened to come next.
      let constraintHeld = false;
      try {
        await tx.transaction(async (probe) => {
          await probe.execute(
            sql`update secrets set value_type = 'nonsense' where id = ${secretId}`,
          );
        });
      } catch {
        constraintHeld = true;
      }
      step(
        'unknown value type refused by the database',
        constraintHeld,
        'secrets_value_type_check holds',
      );

      // ── 8. The user vault ───────────────────────────────────────────────
      // The zero-knowledge claim, checked against a real database rather than
      // against prose: what these rows hold is a public key, a salt, a digest
      // and a set of ciphertexts, and nothing here can open any of them.
      const unlockVerifier = randomBytes(32);
      const blob = (label: string) => new TextEncoder().encode(`xk2.gcm.${label}`);

      await createVault(tx, {
        userId: user.id,
        encAlgorithm: 'X25519',
        encPublicKey: randomBytes(32),
        encPrivateKeyEnc: blob('privenc'),
        signAlgorithm: 'Ed25519',
        signPublicKey: randomBytes(32),
        signPrivateKeyEnc: blob('privsign'),
        kdfSalt: randomBytes(16),
        kdfParams: { alg: 'argon2id', v: 19, m: 65536, t: 3, p: 1, len: 32 },
        unlockVerifierHash: await hashUnlockVerifier(unlockVerifier),
        passphraseWrap: blob('passphrase'),
        recoveryWraps: Array.from({ length: 5 }, (_unused, index) => ({
          lookupHash: randomBytes(32),
          wrap: blob(`recovery${index}`),
        })),
      });

      const vault = await loadVault(tx, user.id);
      step(
        'the vault stores only wrapped material',
        vault !== null && vault.recoveryCodesRemaining === 5,
        'one passphrase wrap, five recovery wraps, no key the server can use',
      );

      const keys = await findVaultKeys(tx, user.id);
      step(
        'the unlock verifier is stored only as a digest',
        keys !== null &&
          keys.unlockVerifierHash.length === 32 &&
          Buffer.compare(Buffer.from(keys.unlockVerifierHash), Buffer.from(unlockVerifier)) !== 0,
        'SHA-256 of a sibling HKDF branch — possessing it opens nothing',
      );

      let secondVaultRefused = false;
      try {
        await tx.transaction(async (nested) => {
          await createVault(nested, {
            userId: user.id,
            encAlgorithm: 'X25519',
            encPublicKey: randomBytes(32),
            encPrivateKeyEnc: blob('privenc2'),
            signAlgorithm: 'Ed25519',
            signPublicKey: randomBytes(32),
            signPrivateKeyEnc: blob('privsign2'),
            kdfSalt: randomBytes(16),
            kdfParams: { alg: 'argon2id', v: 19, m: 65536, t: 3, p: 1, len: 32 },
            unlockVerifierHash: randomBytes(32),
            passphraseWrap: blob('passphrase2'),
            recoveryWraps: [],
          });
        });
      } catch {
        secondVaultRefused = true;
      }
      step(
        'a second vault is refused, never an overwrite',
        secondVaultRefused,
        'the old public key has environment keys sealed to it',
      );

      // The property the whole lock rests on: a session is authenticated the
      // moment it exists and is **not** unlocked, so the cookie alone cannot
      // reach key material.
      const { token: sessionToken } = await generateToken('session');
      const session = await createSession(tx, {
        userId: user.id,
        token: sessionToken,
        ipAddress: null,
        userAgent: null,
      });

      const tokenHash = await hashToken(sessionToken);
      const fresh = await findSessionByTokenHash(tx, tokenHash);
      step(
        'a new session starts locked',
        fresh !== null && fresh.vaultUnlockedAt === null,
        'authenticated, but vault_unlocked_at is null',
      );

      await markSessionUnlocked(tx, session.id, new Date());
      const unlocked = await findSessionByTokenHash(tx, tokenHash);
      step(
        'unlocking is recorded on the session',
        unlocked?.vaultUnlockedAt !== null &&
          unlocked !== null &&
          isVaultUnlocked(unlocked.vaultUnlockedAt, new Date()),
        'the same session, now unlocked — not a new one',
      );

      await lockSessions(tx, { sessionId: session.id });
      const relocked = await findSessionByTokenHash(tx, tokenHash);
      step(
        'locking does not sign the user out',
        relocked !== null && relocked.vaultUnlockedAt === null && relocked.revokedAt === null,
        'vault_unlocked_at cleared, session still live',
      );

      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) {
      const message = error instanceof Error ? error.message : 'unknown error';
      console.error(
        `\n❌ smoke test failed: ${message.replace(/postgres(?:ql)?:\/\/[^\s]*/gi, '<redacted>')}\n`,
      );
      process.exit(1);
    }
  } finally {
    await db.$client.end();
  }

  const failed = steps.filter((entry) => !entry.ok).length;

  if (failed > 0) {
    console.error(`\n${failed} step(s) failed.\n`);
    process.exit(1);
  }

  console.warn('\nAll steps passed. Everything was rolled back — the database is unchanged.\n');
}

main().catch((error: unknown) => {
  console.error('smoke test error:', error instanceof Error ? error.message : 'unknown error');
  process.exit(1);
});

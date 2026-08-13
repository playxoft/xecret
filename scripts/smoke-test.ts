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
 * secret, read it back — plus the property the whole design rests on: that a
 * ciphertext moved to another row fails to decrypt.
 *
 * ## Nothing is left behind
 *
 * The entire run happens inside one transaction that is always rolled back, so
 * it is safe against a database with real data in it. That is not merely
 * convenient: a smoke test that has to be cleaned up afterwards is one that
 * eventually is not, and the leftovers are indistinguishable from real rows.
 */

import { createDatabase } from '../packages/db/src/client.ts';
import {
  bootstrapPersonalOrganization,
  createSecret,
  findSecretByName,
  loadEnvironmentKeyChain,
  upsertUserFromIdentity,
} from '../packages/db/src/repositories/index.ts';
import { EnvelopeService, keyProviderFromEnv } from '../packages/core/src/crypto/index.ts';
import { DecryptionError } from '../packages/core/src/crypto/types.ts';
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
      const account = await bootstrapPersonalOrganization(tx, { user, envelope });
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

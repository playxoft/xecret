import { beforeEach, describe, expect, it, vi } from 'vitest';

import { generateEncryptionKeyPair, generateSigningKeyPair } from '@xecret/core/crypto/client';

import { parseWith } from '@/server/http';
import { overrideBodySchema } from '@/server/schemas/overrides';
import { holdVaultKeys, releaseVaultKeys, VaultLockedError } from '@/components/vault/key-store';
import type { VaultKeyMaterial } from '@/components/vault/key-store';

import {
  listOverrides,
  openOverride,
  overrideFailureMessage,
  OverrideNameError,
  OverrideUnreadableError,
  removeOverride,
  sealOverride,
  setOverride,
} from './override-crypto';

/**
 * Personal overrides from the dashboard, against real cryptography.
 *
 * Not mocked, for the reason `env-keys.test.ts` gives: what goes wrong here is
 * never "did we call the sealer" but "does the blob we uploaded open on the
 * owner's machine, and on nobody else's". So X25519 key material, HKDF and
 * AES-GCM all run for real, and the assertions are opens and refusals.
 *
 * HTTP is the one thing substituted, and the body is pinned by running the
 * server's own schema over it.
 */

const ORG_ID = '018f3f6a-0000-7000-8000-0000000000a1';
const OTHER_ORG_ID = '018f3f6a-0000-7000-8000-0000000000a2';
const ENVIRONMENT_ID = '018f3f6a-0000-7000-8000-0000000000b1';
const OTHER_ENVIRONMENT_ID = '018f3f6a-0000-7000-8000-0000000000b2';
const USER_ID = '018f3f6a-0000-7000-8000-0000000000d1';
const OTHER_USER_ID = '018f3f6a-0000-7000-8000-0000000000d2';

const TARGET = { orgSlug: 'acme', projectSlug: 'api', envSlug: 'dev' };
const BASE = '/api/orgs/acme/projects/api/environments/dev/overrides';

const calls: { method: string; path: string; body: unknown }[] = [];
const responses = new Map<string, unknown>();

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  const recorder = (method: string) => (path: string, body?: unknown) => {
    calls.push({ method, path, body });
    return Promise.resolve(responses.get(`${method} ${path}`) ?? {});
  };
  return {
    ...actual,
    api: {
      get: vi.fn((path: string) => recorder('GET')(path)),
      post: vi.fn(recorder('POST')),
      put: vi.fn(recorder('PUT')),
      patch: vi.fn(recorder('PATCH')),
      delete: vi.fn(recorder('DELETE')),
    },
  };
});

/** A vault, as an unlocked browser holds one. Real key pairs, not fixtures. */
function vaultFor(userId: string): VaultKeyMaterial {
  const enc = generateEncryptionKeyPair();
  const sign = generateSigningKeyPair();
  return {
    userId,
    userKey: new Uint8Array(32),
    encPrivateKey: enc.privateKey,
    encPublicKey: enc.publicKey,
    signPrivateKey: sign.privateKey,
    signPublicKey: sign.publicKey,
  };
}

const VALUE = 'postgres://me:hunter2@localhost:5432/scratch';

beforeEach(() => {
  calls.length = 0;
  responses.clear();
  // `withVaultKeys` refuses material the store is not holding, so every test
  // starts locked and unlocks the vault it means to use.
  releaseVaultKeys();
});

describe('setting an override', () => {
  it('puts a ciphertext and nothing else, and it opens for its owner', async () => {
    const vault = vaultFor(USER_ID);
    holdVaultKeys(vault);
    responses.set(`PUT ${BASE}/DATABASE_URL`, {
      override: { name: 'DATABASE_URL', updatedAt: '2026-10-20T10:00:00.000Z', created: true },
    });

    const answer = await setOverride({
      target: TARGET,
      vault,
      orgId: ORG_ID,
      environmentId: ENVIRONMENT_ID,
      name: 'DATABASE_URL',
      value: VALUE,
    });
    expect(answer.override.created).toBe(true);

    const [call] = calls;
    expect(call?.method).toBe('PUT');
    expect(call?.path).toBe(`${BASE}/DATABASE_URL`);

    // The server's own schema: strict, so a stray field — a plaintext riding
    // along beside the blob — would be refused here as it would be there.
    const body = parseWith(overrideBodySchema, call?.body);
    expect(Object.keys(call?.body as object)).toEqual(['ciphertext']);
    expect(body.ciphertext.startsWith('xk2.gcm.')).toBe(true);

    // Nowhere in what crossed the network: not the body, not the path.
    expect(JSON.stringify(call)).not.toContain('hunter2');
    expect(call?.path).not.toContain('hunter2');

    await expect(
      openOverride({
        vault,
        orgId: ORG_ID,
        environmentId: ENVIRONMENT_ID,
        override: { name: 'DATABASE_URL', ciphertext: body.ciphertext },
      }),
    ).resolves.toBe(VALUE);
  });

  it('refuses a name the grammar refuses, before anything is sealed or sent', async () => {
    const vault = vaultFor(USER_ID);
    holdVaultKeys(vault);

    await expect(
      setOverride({
        target: TARGET,
        vault,
        orgId: ORG_ID,
        environmentId: ENVIRONMENT_ID,
        name: 'LD_PRELOAD',
        value: VALUE,
      }),
    ).rejects.toBeInstanceOf(OverrideNameError);
    await expect(
      sealOverride({
        vault,
        orgId: ORG_ID,
        environmentId: ENVIRONMENT_ID,
        name: 'not a name',
        value: VALUE,
      }),
    ).rejects.toBeInstanceOf(OverrideNameError);
    expect(calls).toHaveLength(0);
  });

  it('refuses a locked vault, with nothing sent', async () => {
    // Never held: the store answers "locked", and the lease refuses.
    const vault = vaultFor(USER_ID);

    await expect(
      setOverride({
        target: TARGET,
        vault,
        orgId: ORG_ID,
        environmentId: ENVIRONMENT_ID,
        name: 'DATABASE_URL',
        value: VALUE,
      }),
    ).rejects.toBeInstanceOf(VaultLockedError);
    expect(calls).toHaveLength(0);
  });
});

describe('opening an override', () => {
  async function sealedBy(vault: VaultKeyMaterial): Promise<string> {
    return sealOverride({
      vault,
      orgId: ORG_ID,
      environmentId: ENVIRONMENT_ID,
      name: 'API_KEY',
      value: VALUE,
    });
  }

  it("does not open under a teammate's key", async () => {
    const owner = vaultFor(USER_ID);
    holdVaultKeys(owner);
    const ciphertext = await sealedBy(owner);

    // A different person, holding their own unlocked vault — the case a
    // teammate with the environment's key is in.
    const teammate = vaultFor(OTHER_USER_ID);
    holdVaultKeys(teammate);
    await expect(
      openOverride({
        vault: teammate,
        orgId: ORG_ID,
        environmentId: ENVIRONMENT_ID,
        override: { name: 'API_KEY', ciphertext },
      }),
    ).rejects.toBeInstanceOf(OverrideUnreadableError);
  });

  it('does not open after a vault reset gave the same account a new key pair', async () => {
    const before = vaultFor(USER_ID);
    holdVaultKeys(before);
    const ciphertext = await sealedBy(before);

    const after = vaultFor(USER_ID);
    holdVaultKeys(after);
    const failure = await openOverride({
      vault: after,
      orgId: ORG_ID,
      environmentId: ENVIRONMENT_ID,
      override: { name: 'API_KEY', ciphertext },
    }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(OverrideUnreadableError);
    // Explained, and safe to show: the name, never the value.
    const message = overrideFailureMessage(failure);
    expect(message).toMatch(/no longer has/);
    expect(message).toContain('API_KEY');
    expect(message).not.toContain('hunter2');
  });

  it('does not open as another name, another environment or another organisation', async () => {
    const owner = vaultFor(USER_ID);
    holdVaultKeys(owner);
    const ciphertext = await sealedBy(owner);

    // Each AAD component, moved one at a time — the blob a server relocated
    // to another row, which must fail exactly as a tampered one does.
    const attempts = [
      { orgId: ORG_ID, environmentId: ENVIRONMENT_ID, name: 'OTHER_KEY' },
      { orgId: ORG_ID, environmentId: OTHER_ENVIRONMENT_ID, name: 'API_KEY' },
      { orgId: OTHER_ORG_ID, environmentId: ENVIRONMENT_ID, name: 'API_KEY' },
    ];
    for (const attempt of attempts) {
      await expect(
        openOverride({
          vault: owner,
          orgId: attempt.orgId,
          environmentId: attempt.environmentId,
          override: { name: attempt.name, ciphertext },
        }),
      ).rejects.toBeInstanceOf(OverrideUnreadableError);
    }

    // And the original row still opens, so the refusals above are about the
    // row, not about a broken blob.
    await expect(
      openOverride({
        vault: owner,
        orgId: ORG_ID,
        environmentId: ENVIRONMENT_ID,
        override: { name: 'API_KEY', ciphertext },
      }),
    ).resolves.toBe(VALUE);
  });

  it('refuses a tampered blob as unreadable', async () => {
    const owner = vaultFor(USER_ID);
    holdVaultKeys(owner);
    const ciphertext = await sealedBy(owner);
    // A character in the middle, where all six of its bits are payload — the
    // last character of base64url can carry padding bits a flip would not touch.
    const at = Math.floor(ciphertext.length / 2);
    const flipped = `${ciphertext.slice(0, at)}${ciphertext[at] === 'A' ? 'B' : 'A'}${ciphertext.slice(at + 1)}`;

    await expect(
      openOverride({
        vault: owner,
        orgId: ORG_ID,
        environmentId: ENVIRONMENT_ID,
        override: { name: 'API_KEY', ciphertext: flipped },
      }),
    ).rejects.toBeInstanceOf(OverrideUnreadableError);
  });
});

describe('the routes', () => {
  it('lists from the environment’s overrides path', async () => {
    responses.set(`GET ${BASE}`, { overrides: [], canSet: false, upgradeTo: 'pro' });

    const listed = await listOverrides(TARGET);

    expect(calls[0]).toMatchObject({ method: 'GET', path: BASE });
    expect(listed).toEqual({ overrides: [], canSet: false, upgradeTo: 'pro' });
  });

  it('removes by name, with no body and no key', async () => {
    responses.set(`DELETE ${BASE}/API_KEY`, { override: { name: 'API_KEY', deleted: true } });

    const removed = await removeOverride(TARGET, 'API_KEY');

    expect(calls[0]).toMatchObject({ method: 'DELETE', path: `${BASE}/API_KEY`, body: undefined });
    expect(removed.override.deleted).toBe(true);
  });

  it('leaves an API error for the caller to render', () => {
    expect(overrideFailureMessage(new Error('anything'))).toBeNull();
  });
});

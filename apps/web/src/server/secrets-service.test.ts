import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EnvelopeService,
  InMemoryKeyProvider,
  MAX_SECRET_VALUE_BYTES,
  computeValueHmac,
  generateKeyBytes,
  parseRootKeyMaterial,
  toBase64Url,
} from '@xecret/core/crypto';
import type { Bytes, EncryptedValue } from '@xecret/core/crypto';
import type {
  AddSecretVersionParams,
  CreateSecretParams,
  EnvironmentKeyChain,
  EnvironmentRecord,
  Organization,
  ProjectRecord,
  SecretMaterial,
} from '@xecret/db/repositories';
import type { Database } from '@xecret/db';
import { ApiError } from './errors';
import { json } from './http';
import type { Bindings } from './bindings';
import type { ServiceContext } from './context';
import type { EnvironmentScope } from './tenancy';

/**
 * What these tests prove, and what still needs an integration suite.
 *
 * **They prove the cryptographic orchestration, for real.** Nothing here is
 * stubbed on the crypto side: a genuine 256-bit root key drives a real
 * `InMemoryKeyProvider`, a real Org Master Key wraps a real Env Data Key, and
 * every encryption and decryption below goes through Web Crypto's AES-256-GCM.
 * The properties asserted are the ones that would be catastrophic and silent if
 * they were wrong:
 *
 *  - a value survives the round trip byte-for-byte;
 *  - a ciphertext presented under any other organisation, environment, secret or
 *    version **fails to open**, which is the whole of the relocation defence
 *    described in `aad.ts` — it is asserted with the *same key*, so what the
 *    test demonstrates is the AAD binding specifically and not merely that two
 *    environments hold different keys;
 *  - the environment key is unwrapped once per request no matter how many
 *    secrets a request touches;
 *  - the unwrapped key bytes are zeroed afterwards, asserted on the very buffer
 *    the service used;
 *  - an unchanged value does not append a version, and a changed one does;
 *  - an oversized value becomes `payload_too_large` rather than reaching the
 *    cipher;
 *  - a decryption failure becomes a fixed `internal_error` that carries no
 *    detail, in the response or in the log line.
 *
 * **The database is a test double.** There is no PostgreSQL in this process, so
 * the four repository functions this module calls are mocked. That means
 * nothing here demonstrates: that `secrets_env_name_idx` actually rejects a
 * duplicate name, that `MAX(version) + 1` races the way the repository's comment
 * claims, that a transaction actually rolls back when the version check fires,
 * that soft-deleted parents hide their children, or that the pull path really
 * issues the two queries its comment counts. Those need a real database and must
 * exist before this ships; treating this file as coverage of the write path
 * would be worse than having no tests, because it reads like coverage.
 *
 * **Authorization and tenancy are not exercised here either.** They live in
 * `@xecret/core/authz` and `server/tenancy.ts`, are tested there, and are called
 * by the route handlers rather than by this module.
 */

const ORG_ID = '01930000-0000-7000-8000-0000000000a1';
const OTHER_ORG_ID = '01930000-0000-7000-8000-0000000000a2';
const PROJECT_ID = '01930000-0000-7000-8000-0000000000b1';
const ENV_A = '01930000-0000-7000-8000-0000000000c1';
const ENV_B = '01930000-0000-7000-8000-0000000000c2';
const ENV_KEY_ID = '01930000-0000-7000-8000-0000000000d1';
const SECRET_S = '01930000-0000-7000-8000-0000000000e1';
const SECRET_T = '01930000-0000-7000-8000-0000000000e2';
const USER_ID = '01930000-0000-7000-8000-0000000000f1';

const PLAINTEXT = 'postgres://user:hunter2@db.internal:5432/app?sslmode=require';

/**
 * The repository, as a double.
 *
 * `vi.hoisted` because `vi.mock` factories are hoisted above the module body:
 * without it the factory would close over a binding that is still in its
 * temporal dead zone when the mocked module is first imported.
 */
const repository = vi.hoisted(() => ({
  loadEnvironmentKeyChain: vi.fn(),
  loadEnvironmentSecrets: vi.fn(),
  createSecret: vi.fn(),
  addSecretVersion: vi.fn(),
}));

vi.mock('@xecret/db/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xecret/db/repositories')>();
  return {
    ...actual,
    loadEnvironmentKeyChain: repository.loadEnvironmentKeyChain,
    loadEnvironmentSecrets: repository.loadEnvironmentSecrets,
    createSecret: repository.createSecret,
    addSecretVersion: repository.addSecretVersion,
  };
});

const { applySecretWrites, decryptEnvironment, decryptOne, writeSecretValue } =
  await import('./secrets-service');

interface Harness {
  services: ServiceContext;
  scope: EnvironmentScope;
  /** Every buffer `openEnvKey` handed back, so zeroing can be asserted on it. */
  unwrappedKeys: Bytes[];
  openEnvKey: ReturnType<typeof vi.fn>;
  created: CreateSecretParams[];
  appended: AddSecretVersionParams[];
  /** The env key bytes, unwrapped independently, for computing expected HMACs. */
  envKeyBytes: Bytes;
}

async function harness(): Promise<Harness> {
  const rootKeys = JSON.stringify({ '1': toBase64Url(generateKeyBytes()) });
  const provider = new InMemoryKeyProvider(parseRootKeyMaterial(rootKeys, 1));
  const envelope = new EnvelopeService(provider);

  const orgKey = await envelope.createOrgKey(ORG_ID);
  const envKey = await envelope.createEnvKey({
    orgId: ORG_ID,
    environmentId: ENV_A,
    orgKey,
  });

  const chain: EnvironmentKeyChain = { envKeyId: ENV_KEY_ID, envKey, orgKey };
  repository.loadEnvironmentKeyChain.mockResolvedValue(chain);

  // Unwrapped separately, through the same service, so the test can compute the
  // HMAC of a value exactly as the write path would.
  const envKeyBytes = await envelope.openEnvKey({
    orgId: ORG_ID,
    environmentId: ENV_A,
    orgKey,
    envKey,
  });

  const unwrappedKeys: Bytes[] = [];
  const openEnvKey = vi.spyOn(envelope, 'openEnvKey');
  const passthrough = openEnvKey.getMockImplementation();
  openEnvKey.mockImplementation(async (params) => {
    const bytes = await (passthrough
      ? passthrough(params)
      : EnvelopeService.prototype.openEnvKey.call(envelope, params));
    unwrappedKeys.push(bytes);
    return bytes;
  });

  const created: CreateSecretParams[] = [];
  repository.createSecret.mockImplementation((_exec: unknown, params: CreateSecretParams) => {
    created.push(params);
    return Promise.resolve({ secret: { id: params.id }, version: { version: 1 } });
  });

  const appended: AddSecretVersionParams[] = [];
  repository.addSecretVersion.mockImplementation(
    (_exec: unknown, params: AddSecretVersionParams) => {
      appended.push(params);
      return Promise.resolve({ version: 2 });
    },
  );

  const services: ServiceContext = {
    env: {} as Bindings,
    // Only `transaction` is reachable: every query this module makes goes
    // through a mocked repository function.
    db: {
      transaction: (run: (tx: unknown) => Promise<unknown>) => run({}),
    } as unknown as Database,
    envelope,
    meta: {
      requestId: 'req-test',
      ipAddress: null,
      userAgent: null,
      method: 'POST',
      path: '/api/test',
    },
    waitUntil: () => {},
  };

  return {
    services,
    scope: environmentScope(),
    unwrappedKeys,
    openEnvKey,
    created,
    appended,
    envKeyBytes,
  };
}

function environmentScope(): EnvironmentScope {
  return {
    organization: { id: ORG_ID, slug: 'acme' } as unknown as Organization,
    project: { id: PROJECT_ID, slug: 'api' } as unknown as ProjectRecord,
    environment: { id: ENV_A, slug: 'production' } as unknown as EnvironmentRecord,
    actor: { kind: 'user', userId: USER_ID, orgId: ORG_ID },
    membership: undefined,
  };
}

/** A stored row, as `findSecretByName` would return it. */
function stored(
  encrypted: EncryptedValue,
  overrides: Partial<SecretMaterial> = {},
): SecretMaterial {
  return {
    secretId: SECRET_S,
    name: 'DATABASE_URL',
    environmentId: ENV_A,
    versionId: '01930000-0000-7000-8000-000000000001',
    version: 1,
    envKeyId: ENV_KEY_ID,
    encrypted,
    valueHmac: null,
    createdBy: USER_ID,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

/** Runs an operation that must fail, and returns the `ApiError` it produced. */
async function rejection(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (cause) {
    if (cause instanceof ApiError) return cause;
    throw cause;
  }
  throw new Error('expected the operation to fail, but it succeeded');
}

/** Encrypts `PLAINTEXT` through the real write path and returns the ciphertext. */
async function sealed(h: Harness): Promise<EncryptedValue> {
  await writeSecretValue(h.scope, h.services, {
    writer: USER_ID,
    name: 'DATABASE_URL',
    value: PLAINTEXT,
  });

  const write = h.created[0];
  if (!write) throw new Error('the write path stored nothing');
  return write.encrypted;
}

/**
 * Several tests below deliberately provoke a decryption failure, and the service
 * logs one line when that happens. It is captured rather than printed so the
 * suite's output stays readable — and so the one test that cares can assert on
 * exactly what was written.
 */
const consoleError = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(consoleError);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('encrypt and decrypt', () => {
  it('round-trips a value through the real key hierarchy', async () => {
    const h = await harness();
    const encrypted = await sealed(h);

    // The stored row must carry the id the value was encrypted for; the write
    // path chooses it precisely because the AAD binds it.
    const write = h.created[0];
    expect(write?.id).toBeTypeOf('string');
    expect(write?.envKeyId).toBe(ENV_KEY_ID);
    expect(write?.createdBy).toBe(USER_ID);

    const value = await decryptOne(
      h.scope,
      h.services,
      stored(encrypted, { secretId: write?.id ?? SECRET_S, version: 1 }),
    );

    expect(value).toBe(PLAINTEXT);
  });

  it('never stores the plaintext in the ciphertext it produces', async () => {
    const h = await harness();
    const encrypted = await sealed(h);

    expect(new TextDecoder().decode(encrypted.ciphertext)).not.toContain('hunter2');
    expect(encrypted.algorithm).toBe('AES-256-GCM');
    // A 96-bit IV, generated per operation and never supplied by a caller.
    expect(encrypted.iv).toHaveLength(12);
  });
});

/**
 * The relocation defence, one attempt per bound component.
 *
 * Each case reuses the **same environment key**, so a failure here can only come
 * from the AAD. That is the point: an attacker with database write access but no
 * key copies a ciphertext row into a place they are allowed to read, and reads
 * the plaintext through the ordinary API. Encryption alone does not stop that.
 */
describe('AAD binding rejects a relocated ciphertext', () => {
  it('fails when the ciphertext is presented in another environment', async () => {
    const h = await harness();
    const encrypted = await sealed(h);
    const secretId = h.created[0]?.id ?? SECRET_S;

    const error = await rejection(() =>
      decryptOne(h.scope, h.services, stored(encrypted, { secretId, environmentId: ENV_B })),
    );

    expect(error.code).toBe('internal_error');
  });

  it('fails when the ciphertext is presented under another secret', async () => {
    const h = await harness();
    const encrypted = await sealed(h);

    const error = await rejection(() =>
      decryptOne(h.scope, h.services, stored(encrypted, { secretId: SECRET_T })),
    );

    expect(error.code).toBe('internal_error');
  });

  it('fails when the ciphertext is presented as a different version', async () => {
    const h = await harness();
    const encrypted = await sealed(h);
    const secretId = h.created[0]?.id ?? SECRET_S;

    const error = await rejection(() =>
      decryptOne(h.scope, h.services, stored(encrypted, { secretId, version: 2 })),
    );

    expect(error.code).toBe('internal_error');
  });

  it('fails when the ciphertext is presented in another organisation', async () => {
    const h = await harness();
    const encrypted = await sealed(h);
    const secretId = h.created[0]?.id ?? SECRET_S;

    const foreign: EnvironmentScope = {
      ...h.scope,
      organization: { id: OTHER_ORG_ID, slug: 'other' } as unknown as Organization,
    };

    const error = await rejection(() =>
      decryptOne(foreign, h.services, stored(encrypted, { secretId })),
    );

    expect(error.code).toBe('internal_error');
  });
});

describe('decryption failure handling', () => {
  it('maps a DecryptionError to internal_error and leaks nothing', async () => {
    const h = await harness();
    const encrypted = await sealed(h);
    const secretId = h.created[0]?.id ?? SECRET_S;

    // A single flipped bit in the authenticated ciphertext.
    const corrupted = new Uint8Array(encrypted.ciphertext);
    corrupted.set([(corrupted[0] ?? 0) ^ 0x01], 0);
    const tampered: EncryptedValue = { ...encrypted, ciphertext: corrupted };

    const error = await rejection(() =>
      decryptOne(h.scope, h.services, stored(tampered, { secretId })),
    );

    expect(error.code).toBe('internal_error');
    expect(error.status).toBe(500);
    // The fixed message from `errors.internal`, and nothing else.
    expect(error.message).toBe('Something went wrong.');
    expect(JSON.stringify(error.toBody('req-test'))).not.toContain('decrypt');
    // The category is kept server-side so an operator can alert on it.
    expect(error.logDetail).toBe('decryptionFailed');

    // The log line names a category and a request, and carries no value, no key
    // and no ciphertext.
    expect(consoleError).toHaveBeenCalledTimes(1);
    const line = JSON.stringify(consoleError.mock.calls[0]);
    expect(line).toContain('decryptionFailed');
    expect(line).not.toContain('hunter2');
  });
});

describe('the unwrapped environment key', () => {
  it('is unwrapped once for an entire environment, not once per secret', async () => {
    const h = await harness();

    const first = await sealed(h);
    const materials = [
      stored(first, { secretId: h.created[0]?.id ?? SECRET_S, name: 'DATABASE_URL' }),
    ];

    // Three more secrets, each encrypted for its own id, all under one key.
    for (let index = 0; index < 3; index += 1) {
      h.created.length = 0;
      await writeSecretValue(h.scope, h.services, {
        writer: USER_ID,
        name: `SECRET_${index}`,
        value: `value-${index}`,
      });
      const write = h.created[0];
      if (!write) throw new Error('the write path stored nothing');
      materials.push(
        stored(write.encrypted, {
          secretId: write.id ?? SECRET_S,
          name: `SECRET_${index}`,
        }),
      );
    }

    repository.loadEnvironmentSecrets.mockResolvedValue(materials);
    h.openEnvKey.mockClear();

    const decrypted = await decryptEnvironment(h.scope, h.services);

    expect(decrypted).toHaveLength(4);
    expect(decrypted.map((secret) => secret.name)).toEqual([
      'DATABASE_URL',
      'SECRET_0',
      'SECRET_1',
      'SECRET_2',
    ]);
    expect(decrypted[0]?.value).toBe(PLAINTEXT);
    // Four secrets, one unwrap. This is the property that keeps `xecret run`
    // constant in the size of the environment.
    expect(h.openEnvKey).toHaveBeenCalledTimes(1);
  });

  it('is zeroed after use, on the success path', async () => {
    const h = await harness();
    const encrypted = await sealed(h);
    const secretId = h.created[0]?.id ?? SECRET_S;

    h.unwrappedKeys.length = 0;
    const value = await decryptOne(h.scope, h.services, stored(encrypted, { secretId }));

    // The decryption succeeded, so the bytes were live while they were in use.
    expect(value).toBe(PLAINTEXT);

    const used = h.unwrappedKeys[0];
    expect(used).toBeDefined();
    expect(used).toHaveLength(32);
    expect(used?.every((byte) => byte === 0)).toBe(true);
  });

  it('is zeroed after use, on the failure path', async () => {
    const h = await harness();
    const encrypted = await sealed(h);

    h.unwrappedKeys.length = 0;
    // Relocated, so decryption throws while the key is still borrowed.
    await rejection(() =>
      decryptOne(h.scope, h.services, stored(encrypted, { secretId: SECRET_T })),
    );

    const used = h.unwrappedKeys[0];
    expect(used).toBeDefined();
    expect(used?.every((byte) => byte === 0)).toBe(true);
  });
});

describe('the unchanged-value short circuit', () => {
  it('appends no version when the HMAC of the submitted value matches', async () => {
    const h = await harness();

    const valueHmac = await computeValueHmac({
      envKeyBytes: h.envKeyBytes,
      environmentId: ENV_A,
      plaintext: PLAINTEXT,
    });

    const result = await writeSecretValue(h.scope, h.services, {
      writer: USER_ID,
      name: 'DATABASE_URL',
      value: PLAINTEXT,
      existing: { secretId: SECRET_S, version: 4, valueHmac },
    });

    expect(result.status).toBe('unchanged');
    // The version is reported unchanged, so a client retrying a request it did
    // not see the answer to gets the truth rather than a phantom bump.
    expect(result.version).toBe(4);
    expect(repository.addSecretVersion).not.toHaveBeenCalled();
  });

  it('appends a version when the HMAC differs', async () => {
    const h = await harness();

    const valueHmac = await computeValueHmac({
      envKeyBytes: h.envKeyBytes,
      environmentId: ENV_A,
      plaintext: 'the previous value',
    });

    const result = await writeSecretValue(h.scope, h.services, {
      writer: USER_ID,
      name: 'DATABASE_URL',
      value: PLAINTEXT,
      existing: { secretId: SECRET_S, version: 1, valueHmac },
    });

    expect(result.status).toBe('updated');
    expect(result.version).toBe(2);
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]?.secretId).toBe(SECRET_S);

    // The appended row must open under the version it was stored at.
    const appended = h.appended[0];
    if (!appended) throw new Error('nothing was appended');
    await expect(
      decryptOne(h.scope, h.services, stored(appended.encrypted, { version: 2 })),
    ).resolves.toBe(PLAINTEXT);
  });

  it('appends a version when the stored row carries no HMAC at all', async () => {
    const h = await harness();

    const result = await writeSecretValue(h.scope, h.services, {
      writer: USER_ID,
      name: 'DATABASE_URL',
      value: PLAINTEXT,
      existing: { secretId: SECRET_S, version: 1, valueHmac: null },
    });

    // A row written before `value_hmac` existed must not be mistaken for a
    // match; "we cannot tell" has to mean "write it".
    expect(result.status).toBe('updated');
    expect(repository.addSecretVersion).toHaveBeenCalledTimes(1);
  });
});

describe('size limits', () => {
  it('maps an oversized value to payload_too_large', async () => {
    const h = await harness();

    const error = await rejection(() =>
      writeSecretValue(h.scope, h.services, {
        writer: USER_ID,
        name: 'HUGE',
        value: 'x'.repeat(MAX_SECRET_VALUE_BYTES + 1),
      }),
    );

    expect(error.code).toBe('payload_too_large');
    expect(error.status).toBe(413);
    expect(error.message).toContain(String(MAX_SECRET_VALUE_BYTES));
    // Nothing reached the database.
    expect(repository.createSecret).not.toHaveBeenCalled();
  });

  it('counts bytes rather than characters', async () => {
    const h = await harness();

    // Each `€` is three UTF-8 bytes, so this is under the character count and
    // over the byte count — the case a character-only check would let through.
    const error = await rejection(() =>
      writeSecretValue(h.scope, h.services, {
        writer: USER_ID,
        name: 'HUGE',
        value: '€'.repeat(MAX_SECRET_VALUE_BYTES / 2),
      }),
    );

    expect(error.code).toBe('payload_too_large');
  });
});

/**
 * `secret_versions.version` is computed as `MAX(version) + 1` inside the INSERT,
 * while the AAD is computed against the version the request expected. Usually a
 * race collides on `secret_versions_secret_version_unique` — but if the other
 * writer commits first, the subquery simply yields a higher number and the row
 * inserts cleanly at a version its ciphertext was never bound to. That row is
 * undecryptable forever, with no error anywhere.
 */
describe('version assignment', () => {
  it('refuses a row assigned a version its ciphertext was not bound to', async () => {
    const h = await harness();

    // Another writer got there first, so the database assigns 7 where this
    // request encrypted for 2.
    repository.addSecretVersion.mockResolvedValue({ version: 7 });

    const error = await rejection(() =>
      writeSecretValue(h.scope, h.services, {
        writer: USER_ID,
        name: 'DATABASE_URL',
        value: PLAINTEXT,
        existing: { secretId: SECRET_S, version: 1, valueHmac: null },
      }),
    );

    expect(error.code).toBe('conflict');
    expect(error.status).toBe(409);
  });
});

describe('dry run', () => {
  it('decides every outcome without writing or encrypting anything', async () => {
    const h = await harness();

    const unchangedHmac = await computeValueHmac({
      envKeyBytes: h.envKeyBytes,
      environmentId: ENV_A,
      plaintext: 'already stored',
    });

    const results = await applySecretWrites(h.scope, h.services, {
      writer: USER_ID,
      dryRun: true,
      writes: [
        { name: 'NEW_ONE', value: 'a' },
        {
          name: 'CHANGED',
          value: 'b',
          existing: { secretId: SECRET_S, version: 3, valueHmac: null },
        },
        {
          name: 'SAME',
          value: 'already stored',
          existing: { secretId: SECRET_T, version: 5, valueHmac: unchangedHmac },
        },
      ],
    });

    expect(results.map((result) => result.status)).toEqual(['created', 'updated', 'unchanged']);
    // The versions a real run would assign, which is what makes the preview and
    // the outcome the same computation rather than two that agree by habit.
    expect(results.map((result) => result.version)).toEqual([1, 4, 5]);

    expect(repository.createSecret).not.toHaveBeenCalled();
    expect(repository.addSecretVersion).not.toHaveBeenCalled();
  });

  it('does not unwrap a key for an empty batch', async () => {
    const h = await harness();
    h.openEnvKey.mockClear();

    await expect(
      applySecretWrites(h.scope, h.services, { writer: USER_ID, writes: [] }),
    ).resolves.toEqual([]);

    expect(h.openEnvKey).not.toHaveBeenCalled();
    expect(repository.loadEnvironmentKeyChain).not.toHaveBeenCalled();
  });
});

describe('response headers', () => {
  // The reveal route relies on this rather than setting the header itself, so
  // the reliance is asserted rather than assumed.
  it('marks every JSON response no-store', () => {
    expect(json({ secret: { value: 'x' } }).headers.get('cache-control')).toBe('no-store');
  });
});

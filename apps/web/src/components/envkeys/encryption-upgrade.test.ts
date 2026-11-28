import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  computeValueHmac,
  DecryptionError,
  encodePublicKey,
  generateEncryptionKeyPair,
  generateEnvironmentDataKey,
  generateEnvironmentHmacKey,
  generateSigningKeyPair,
  openGrant,
  toBase64Url,
  verifyGrantSignature,
} from '@xecret/core/crypto/client';
import { uuidv7 } from '@xecret/core/ids';

import { ApiError } from '@/lib/api';
import { parseWith } from '@/server/http';
import { encryptionUpgradeBody } from '@/server/schemas/encryption-upgrade';
import { holdVaultKeys, releaseVaultKeys } from '@/components/vault/key-store';
import type { VaultKeyMaterial } from '@/components/vault/key-store';

import {
  autoUpgradeEligible,
  buildUpgradeBody,
  nothingChanged,
  notNormalisedSecrets,
  runEncryptionUpgrade,
  UpgradeRefusedError,
  verifyUpgradeBody,
} from './encryption-upgrade';
import type {
  UpgradeBody,
  UpgradeDetails,
  UpgradeMaterial,
  UpgradePreview,
} from './encryption-upgrade';
import type { EnvKeyMaterial } from './env-key-store';
import { modePinKey, readModePins } from './pins';
import { decryptNote, decryptValue, encryptNote, encryptValue } from './secret-crypto';

/**
 * The browser half of the upgrade to end-to-end encryption, against real
 * cryptography.
 *
 * What is pinned here is the property a bug would destroy silently: the
 * upgrade request carries each value encrypted **exactly as the ordinary e2ee
 * write path encrypts it** — same functions, same AAD, same HMAC — for the
 * secret id and the version number the row already has. Every assertion opens
 * something; none counts calls. And the body is run through the server's own
 * zod schema, so a client that builds a body the server would refuse fails here
 * rather than in front of somebody's production environment.
 */

const ORG_ID = '018f3f6a-0000-7000-8000-0000000000a1';
const ENVIRONMENT_ID = '018f3f6a-0000-7000-8000-0000000000b1';
const USER_ID = '018f3f6a-0000-7000-8000-0000000000d1';
const DB_ID = '018f3f6a-0000-7000-8000-0000000000e1';
const API_ID = '018f3f6a-0000-7000-8000-0000000000e2';
const TOKEN_ID = '018f3f6a-0000-7000-8000-0000000000f1';
const DELETED_ID = '018f3f6a-0000-7000-8000-0000000000f2';

const TARGET = { orgId: 'acme', projectId: 'api', envSlug: 'legacy' };
const BASE = '/api/orgs/acme/projects/api/environments/legacy';

const posted: { path: string; body: unknown }[] = [];
const responses = new Map<string, unknown>();

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  const answer = (key: string) => {
    const value = responses.get(key);
    try {
      return Promise.resolve(typeof value === 'function' ? value() : (value ?? {}));
    } catch (cause) {
      return Promise.reject(cause);
    }
  };
  return {
    ...actual,
    api: {
      get: vi.fn((path: string) => answer(`GET ${path}`)),
      post: vi.fn((path: string, body: unknown) => {
        posted.push({ path, body });
        return answer(`POST ${path}`);
      }),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
  };
});

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

function material(overrides: Partial<UpgradeMaterial> = {}): UpgradeMaterial {
  return {
    orgId: ORG_ID,
    environmentId: ENVIRONMENT_ID,
    secrets: [
      {
        id: DB_ID,
        name: 'DATABASE_URL',
        valueType: 'url',
        note: 'primary — rotate quarterly',
        revision: '1732300000000001',
        versions: [
          { id: uuidv7(), version: 1, value: 'postgres://one' },
          { id: uuidv7(), version: 2, value: 'postgres://two' },
          { id: uuidv7(), version: 7, value: 'postgres://seven' },
        ],
      },
      {
        id: API_ID,
        name: 'API_KEY',
        valueType: 'string',
        note: null,
        revision: '1732300000000002',
        versions: [{ id: uuidv7(), version: 1, value: 'k-live-café' }],
      },
    ],
    deletedSecrets: [{ id: DELETED_ID, name: 'RETIRED' }],
    keylessTokens: [{ id: TOKEN_ID, name: 'deploy', tokenPrefix: 'xst_live_ab12' }],
    ...overrides,
  };
}

function details(overrides: Partial<UpgradeDetails> = {}): UpgradeDetails {
  return {
    liveSecretCount: 2,
    versionCount: 4,
    noteCount: 1,
    deletedSecrets: [{ id: DELETED_ID, name: 'RETIRED' }],
    keylessTokens: [{ id: TOKEN_ID, name: 'deploy', tokenPrefix: 'xst_live_ab12' }],
    otherEntitledCount: 1,
    ...overrides,
  };
}

function preview(overrides: Partial<UpgradeDetails> = {}): UpgradePreview {
  return {
    encryptionMode: 'server',
    environmentId: ENVIRONMENT_ID,
    canUpgrade: true,
    reasons: [],
    details: details(overrides),
  };
}

/** The window's storage, for the mode pin. */
function stubStorage(): Map<string, string> {
  const storage = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    },
  });
  return storage;
}

/** A copy, so one test can damage a body without touching another's. */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function keys() {
  return {
    envDataKeyId: uuidv7(),
    edk: generateEnvironmentDataKey(),
    ehk: generateEnvironmentHmacKey(),
  };
}

function asMaterial(generated: ReturnType<typeof keys>): EnvKeyMaterial {
  return {
    environmentId: ENVIRONMENT_ID,
    envDataKeyId: generated.envDataKeyId,
    edkVersion: 1,
    edk: generated.edk,
    ehk: generated.ehk,
  };
}

beforeEach(() => {
  posted.length = 0;
  responses.clear();
  releaseVaultKeys();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildUpgradeBody', () => {
  it('builds a body the server’s own schema accepts', async () => {
    const vault = vaultFor(USER_ID);
    const body = await buildUpgradeBody({
      vault,
      orgId: ORG_ID,
      material: material(),
      keys: keys(),
    });
    expect(() => parseWith(encryptionUpgradeBody, body)).not.toThrow();
    expect(body.eraseSecretIds).toEqual([DELETED_ID]);
    expect(body.revokeTokenIds).toEqual([TOKEN_ID]);
  });

  it('encrypts every version for the row and version it already occupies, as the ordinary write path does', async () => {
    const vault = vaultFor(USER_ID);
    const generated = keys();
    const read = material();
    const body = await buildUpgradeBody({ vault, orgId: ORG_ID, material: read, keys: generated });
    const envMaterial = asMaterial(generated);

    for (const secret of read.secrets) {
      const sent = body.secrets.find((entry) => entry.id === secret.id)!;
      expect(sent.revision).toBe(secret.revision);
      expect(sent.versions.map((version) => version.version)).toEqual(
        secret.versions.map((version) => version.version),
      );

      for (const version of secret.versions) {
        const entry = sent.versions.find((candidate) => candidate.id === version.id)!;
        expect(entry.value.envDataKeyId).toBe(generated.envDataKeyId);
        expect(entry.value.clientAlgorithm).toBe('xk2.gcm');

        const target = { orgId: ORG_ID, environmentId: ENVIRONMENT_ID, secretId: secret.id };
        // Opens under the version it is filed under…
        expect(
          await decryptValue({
            material: envMaterial,
            target,
            version: version.version,
            ciphertext: entry.value.ciphertext,
          }),
        ).toBe(version.value);
        // …and under no other: a restore-style "next version" binding would be
        // a row nobody could ever open.
        await expect(
          decryptValue({
            material: envMaterial,
            target,
            version: version.version + 1,
            ciphertext: entry.value.ciphertext,
          }),
        ).rejects.toBeInstanceOf(DecryptionError);

        // The HMAC is the one the ordinary write path computes from the EHK, so
        // re-saving the same value afterwards is the no-op it should be.
        const ordinary = await encryptValue({
          material: envMaterial,
          target,
          version: version.version,
          plaintext: version.value,
        });
        expect(entry.value.valueHmac).toBe(ordinary.valueHmac);
        expect(entry.value.valueHmac).toBe(
          toBase64Url(await computeValueHmac({ ehk: generated.ehk, plaintext: version.value })),
        );
      }
    }
  });

  it('seals each note under the new key, bound to its secret, and sends null for none', async () => {
    const vault = vaultFor(USER_ID);
    const generated = keys();
    const read = material();
    read.secrets.push({
      id: uuidv7(),
      name: 'EMPTY_NOTE',
      valueType: 'string',
      note: '',
      revision: '3',
      versions: [{ id: uuidv7(), version: 1, value: 'x' }],
    });
    const body = await buildUpgradeBody({ vault, orgId: ORG_ID, material: read, keys: generated });

    const database = body.secrets.find((secret) => secret.id === DB_ID)!;
    expect(
      await decryptNote({
        material: asMaterial(generated),
        target: { orgId: ORG_ID, environmentId: ENVIRONMENT_ID, secretId: DB_ID },
        blob: database.encNote!,
      }),
    ).toBe('primary — rotate quarterly');
    // Bound to the secret: the same blob does not open as another secret's note.
    await expect(
      decryptNote({
        material: asMaterial(generated),
        target: { orgId: ORG_ID, environmentId: ENVIRONMENT_ID, secretId: API_ID },
        blob: database.encNote!,
      }),
    ).rejects.toBeInstanceOf(DecryptionError);
    // The same construction `encryptNote` uses on the ordinary path.
    const ordinary = await encryptNote({
      material: asMaterial(generated),
      target: { orgId: ORG_ID, environmentId: ENVIRONMENT_ID, secretId: DB_ID },
      note: 'primary — rotate quarterly',
    });
    expect(ordinary.slice(0, 8)).toBe(database.encNote!.slice(0, 8));

    expect(body.secrets.find((secret) => secret.id === API_ID)?.encNote).toBeNull();
    // An empty note is no note, exactly as `encodeNote` says on the ordinary path.
    expect(body.secrets.find((secret) => secret.revision === '3')?.encNote).toBeNull();
  });

  it('seals version 1 of the new key to the upgrader, signed by them, as creation does', async () => {
    const vault = vaultFor(USER_ID);
    const generated = keys();
    const body = await buildUpgradeBody({
      vault,
      orgId: ORG_ID,
      material: material(),
      keys: generated,
    });
    const grant = body.keys.grant;

    expect(grant.recipientKind).toBe('member');
    expect(grant.recipientId).toBe(USER_ID);
    expect(
      verifyGrantSignature({
        signerPublicKey: vault.signPublicKey,
        signature: grant.signature,
        fields: {
          environmentId: ENVIRONMENT_ID,
          edkVersion: 1,
          recipientKind: 'member',
          recipientId: USER_ID,
          recipientPublicKey: vault.encPublicKey,
          edkSealedBlob: grant.edkSealed,
          ehkSealedBlob: grant.ehkSealed,
        },
      }),
    ).toBe(true);

    const opened = await openGrant({
      recipient: {
        environmentId: ENVIRONMENT_ID,
        edkVersion: 1,
        recipientKind: 'member',
        recipientId: USER_ID,
      },
      recipientPrivateKey: vault.encPrivateKey,
      grant,
    });
    expect(toBase64Url(opened.edk)).toBe(toBase64Url(generated.edk));
    expect(toBase64Url(opened.ehk)).toBe(toBase64Url(generated.ehk));
  });

  it('refuses a value whose bytes Unicode normalisation would change, naming the secret', async () => {
    const vault = vaultFor(USER_ID);
    // `é` as `e` + combining acute: NFD. The server envelope stored these bytes
    // as given; the e2ee path would store the composed form.
    const decomposed = 'café';
    const read = material();
    read.secrets[1]!.versions.push({ id: uuidv7(), version: 2, value: decomposed });

    expect(notNormalisedSecrets(read)).toEqual(['API_KEY']);
    const attempt = buildUpgradeBody({ vault, orgId: ORG_ID, material: read, keys: keys() });
    await expect(attempt).rejects.toBeInstanceOf(UpgradeRefusedError);
    await expect(attempt).rejects.toMatchObject({
      reason: 'not-normalised',
      secretNames: ['API_KEY'],
    });

    // A note's bytes can no more change silently than a value's (review round 2, 4).
    const noted = material();
    noted.secrets[0]!.note = `rotate ${decomposed} quarterly`;
    expect(notNormalisedSecrets(noted)).toEqual(['DATABASE_URL']);
    const notedAttempt = buildUpgradeBody({ vault, orgId: ORG_ID, material: noted, keys: keys() });
    await expect(notedAttempt).rejects.toMatchObject({
      reason: 'not-normalised',
      secretNames: ['DATABASE_URL'],
      message: expect.stringMatching(/^DATABASE_URL holds a value or a note/),
    });
  });
});

describe('autoUpgradeEligible', () => {
  const empty = preview({
    liveSecretCount: 0,
    versionCount: 0,
    noteCount: 0,
    deletedSecrets: [],
    keylessTokens: [],
    otherEntitledCount: 0,
  });

  it('is true only for an empty environment nobody else may read, the caller may upgrade, with the vault open', () => {
    expect(autoUpgradeEligible(empty, true)).toBe(true);
    expect(autoUpgradeEligible(empty, false)).toBe(false);
    expect(autoUpgradeEligible({ ...empty, canUpgrade: false, reasons: ['no-vault'] }, true)).toBe(
      false,
    );
    expect(autoUpgradeEligible({ ...empty, details: null }, true)).toBe(false);
  });

  it('never locks a teammate out: anybody else who may read it means the dialog', () => {
    expect(
      autoUpgradeEligible(
        { ...empty, details: { ...empty.details!, otherEntitledCount: 1 } },
        true,
      ),
    ).toBe(false);
  });

  it('asks whenever there is anything to decide', () => {
    const with_ = (overrides: Partial<UpgradeDetails>) => ({
      ...empty,
      details: { ...empty.details!, ...overrides },
    });
    expect(autoUpgradeEligible(with_({ liveSecretCount: 1, versionCount: 1 }), true)).toBe(false);
    expect(autoUpgradeEligible(with_({ keylessTokens: details().keylessTokens }), true)).toBe(
      false,
    );
    // Erasing a deleted secret early is a decision too, however small.
    expect(autoUpgradeEligible(with_({ deletedSecrets: details().deletedSecrets }), true)).toBe(
      false,
    );
    expect(autoUpgradeEligible(with_({ versionCount: 1 }), true)).toBe(false);
  });
});

describe('verifyUpgradeBody — nothing is sent that would not open again', () => {
  async function built() {
    const vault = vaultFor(USER_ID);
    const generated = keys();
    const read = material();
    const body = await buildUpgradeBody({ vault, orgId: ORG_ID, material: read, keys: generated });
    return { vault, generated, read, body };
  }

  async function refusal(promise: Promise<unknown>): Promise<UpgradeRefusedError> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(UpgradeRefusedError);
      return error as UpgradeRefusedError;
    }
    throw new Error('expected a refusal');
  }

  it('passes the body the builder produced', async () => {
    const { vault, generated, read, body } = await built();
    await expect(
      verifyUpgradeBody({ vault, orgId: ORG_ID, material: read, keys: generated, body }),
    ).resolves.toBeUndefined();
  });

  it('refuses a value filed under another version, naming the secret', async () => {
    const { vault, generated, read, body } = await built();
    const swapped = copy(body);
    const database = swapped.secrets.find((secret) => secret.id === DB_ID)!;
    [database.versions[0]!.value, database.versions[1]!.value] = [
      database.versions[1]!.value,
      database.versions[0]!.value,
    ];
    const error = await refusal(
      verifyUpgradeBody({ vault, orgId: ORG_ID, material: read, keys: generated, body: swapped }),
    );
    expect(error.reason).toBe('verification-failed');
    expect(error.secretNames).toEqual(['DATABASE_URL']);
  });

  it('refuses a value sealed for another organisation', async () => {
    const { vault, generated, read, body } = await built();
    const error = await refusal(
      verifyUpgradeBody({
        vault,
        orgId: '018f3f6a-0000-7000-8000-0000000000a9',
        material: read,
        keys: generated,
        body,
      }),
    );
    expect(error.secretNames).toEqual(expect.arrayContaining(['DATABASE_URL', 'API_KEY']));
  });

  it('refuses a dropped note, an invented one, and one sealed for another secret', async () => {
    const { vault, generated, read, body } = await built();
    const databaseNote = body.secrets.find((secret) => secret.id === DB_ID)!.encNote;

    const dropped = copy(body);
    dropped.secrets.find((secret) => secret.id === DB_ID)!.encNote = null;

    const invented = copy(body);
    invented.secrets.find((secret) => secret.id === API_ID)!.encNote = databaseNote;

    // API_KEY does have a note this time — and is sent DATABASE_URL's sealed
    // one, which opens only as DATABASE_URL's.
    const readWithNote = copy(read);
    readWithNote.secrets.find((secret) => secret.id === API_ID)!.note =
      'primary — rotate quarterly';

    for (const [attempt, readAs] of [
      [dropped, read],
      [invented, read],
      [invented, readWithNote],
    ] as const) {
      const error = await refusal(
        verifyUpgradeBody({
          vault,
          orgId: ORG_ID,
          material: readAs,
          keys: generated,
          body: attempt,
        }),
      );
      expect(error.reason).toBe('verification-failed');
    }
  });

  it('refuses a value whose change-detection tag is not the one its plaintext has (review round 2, 5)', async () => {
    const { vault, generated, read, body } = await built();
    const mistagged = copy(body);
    const api = mistagged.secrets.find((secret) => secret.id === API_ID)!;
    api.versions[0]!.value.valueHmac = mistagged.secrets.find(
      (secret) => secret.id === DB_ID,
    )!.versions[0]!.value.valueHmac;

    const error = await refusal(
      verifyUpgradeBody({ vault, orgId: ORG_ID, material: read, keys: generated, body: mistagged }),
    );
    expect(error.secretNames).toEqual(['API_KEY']);
  });

  it('refuses a grant that does not open, with this vault, to the key that sealed the values', async () => {
    const { vault, generated, read, body } = await built();

    // Sealed by a key other than the one the values are under.
    const otherKeys = { ...generated, edk: generateEnvironmentDataKey() };
    expect(
      (
        await refusal(
          verifyUpgradeBody({ vault, orgId: ORG_ID, material: read, keys: otherKeys, body }),
        )
      ).secretNames,
    ).toContain('the new key');

    // Addressed to a public key this vault does not hold.
    const readdressed = copy(body);
    readdressed.keys.grant.recipientPublicKey = encodePublicKey(
      generateEncryptionKeyPair().publicKey,
    );
    expect(
      (
        await refusal(
          verifyUpgradeBody({
            vault,
            orgId: ORG_ID,
            material: read,
            keys: generated,
            body: readdressed,
          }),
        )
      ).secretNames,
    ).toContain('the new key');
  });
});

describe('runEncryptionUpgrade', () => {
  it('refuses to send anything when the material names tokens or deleted secrets the person was not shown', async () => {
    const vault = vaultFor(USER_ID);
    holdVaultKeys(vault);
    responses.set(`GET ${BASE}/encryption-upgrade/material`, {
      material: material({
        keylessTokens: [
          ...material().keylessTokens,
          { id: uuidv7(), name: 'minted-later', tokenPrefix: 'xst_live_zz' },
        ],
      }),
    });

    const outcome = await runEncryptionUpgrade({
      target: TARGET,
      orgId: ORG_ID,
      vault,
      preview: preview(),
      share: true,
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.error).toBeInstanceOf(UpgradeRefusedError);
    expect(posted).toHaveLength(0);
  });

  it('refuses the automatic upgrade of an environment that is no longer empty', async () => {
    const vault = vaultFor(USER_ID);
    holdVaultKeys(vault);
    responses.set(`GET ${BASE}/encryption-upgrade/material`, {
      material: material({ deletedSecrets: [], keylessTokens: [] }),
    });

    const outcome = await runEncryptionUpgrade({
      target: TARGET,
      orgId: ORG_ID,
      vault,
      preview: preview({
        liveSecretCount: 0,
        versionCount: 0,
        deletedSecrets: [],
        keylessTokens: [],
        otherEntitledCount: 0,
      }),
      share: false,
      automatic: true,
    });
    expect(outcome.status === 'failed' && outcome.error).toMatchObject({
      reason: 'no-longer-empty',
    });
    expect(posted).toHaveLength(0);
  });

  it('posts the built body, pins the mode forward, and shares nothing when not asked to', async () => {
    stubStorage();
    const vault = vaultFor(USER_ID);
    holdVaultKeys(vault);
    const read = material();
    responses.set(`GET ${BASE}/encryption-upgrade/material`, { material: read });
    const result = {
      activeEdk: { id: uuidv7(), version: 1 },
      secretCount: 2,
      versionCount: 4,
      noteCount: 1,
      erasedSecretCount: 1,
      revokedTokenCount: 1,
    };
    responses.set(`POST ${BASE}/encryption-upgrade`, { upgraded: result });

    const steps: string[] = [];
    const outcome = await runEncryptionUpgrade({
      target: TARGET,
      orgId: ORG_ID,
      vault,
      preview: preview(),
      share: false,
      onProgress: (step) => steps.push(step),
    });

    expect(outcome).toEqual({ status: 'upgraded', result, shared: null });
    expect(steps).toEqual(['reading', 'encrypting', 'writing']);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.path).toBe(`${BASE}/encryption-upgrade`);
    expect(() => parseWith(encryptionUpgradeBody, posted[0]!.body)).not.toThrow();

    const pins = readModePins(window.localStorage as unknown as Storage);
    expect(pins[modePinKey(TARGET)]?.mode).toBe('e2ee');
  });

  it('reports a refused write as nothing having changed, re-reads nothing, and pins nothing', async () => {
    const storage = stubStorage();
    const vault = vaultFor(USER_ID);
    holdVaultKeys(vault);
    responses.set(`GET ${BASE}/encryption-upgrade/material`, { material: material() });
    responses.set(`POST ${BASE}/encryption-upgrade`, () => {
      throw new ApiError({
        code: 'conflict',
        message: 'version_conflict: changed',
        status: 409,
        requestId: null,
      });
    });
    const keysRead = vi.fn(() => {
      throw new Error('the key state is not read after the server’s own refusal');
    });
    responses.set(`GET ${BASE}/keys`, keysRead);

    const outcome = await runEncryptionUpgrade({
      target: TARGET,
      orgId: ORG_ID,
      vault,
      preview: preview(),
      share: true,
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && nothingChanged(outcome.error)).toBe(true);
    expect(keysRead).not.toHaveBeenCalled();
    expect(storage.size).toBe(0);
  });

  it('refuses before encrypting when the material answers for another organisation', async () => {
    const vault = vaultFor(USER_ID);
    holdVaultKeys(vault);
    responses.set(`GET ${BASE}/encryption-upgrade/material`, {
      material: material({ orgId: '018f3f6a-0000-7000-8000-0000000000a9' }),
    });

    const outcome = await runEncryptionUpgrade({
      target: TARGET,
      orgId: ORG_ID,
      vault,
      preview: preview(),
      share: true,
    });
    expect(outcome.status === 'failed' && outcome.error).toMatchObject({
      reason: 'wrong-organisation',
    });
    expect(posted).toHaveLength(0);
  });

  it('sends nothing — the automatic upgrade included — when its own work does not verify', async () => {
    const vault = vaultFor(USER_ID);
    // A vault whose public key is not its private key's: the grant is sealed to
    // one and cannot be opened by the other, which the verification finds.
    vault.encPublicKey = generateEncryptionKeyPair().publicKey;
    holdVaultKeys(vault);
    responses.set(`GET ${BASE}/encryption-upgrade/material`, {
      material: material({ secrets: [], deletedSecrets: [], keylessTokens: [] }),
    });

    const outcome = await runEncryptionUpgrade({
      target: TARGET,
      orgId: ORG_ID,
      vault,
      preview: preview({
        liveSecretCount: 0,
        versionCount: 0,
        noteCount: 0,
        deletedSecrets: [],
        keylessTokens: [],
        otherEntitledCount: 0,
      }),
      share: false,
      automatic: true,
    });
    expect(outcome.status === 'failed' && outcome.error).toMatchObject({
      reason: 'verification-failed',
    });
    expect(posted).toHaveLength(0);
  });

  describe('a response lost on the way back', () => {
    function lostAnswer() {
      responses.set(`POST ${BASE}/encryption-upgrade`, () => {
        throw new ApiError({
          code: 'network_error',
          message: 'Could not reach xecret.',
          status: 0,
          requestId: null,
        });
      });
    }

    function keysSay(mode: 'server' | 'e2ee', keyId: () => string | null) {
      responses.set(`GET ${BASE}/keys`, () => ({
        keys: {
          encryptionMode: mode,
          environmentId: ENVIRONMENT_ID,
          activeEdk: keyId() === null ? null : { id: keyId(), version: 1 },
          myGrant: null,
          ehkExists: mode === 'e2ee',
          pendingGrants: null,
          needsRotation: null,
          missingGrants: null,
          currentMaxSecretVersion: 0,
        },
      }));
    }

    const sentKeyId = () => (posted[0]!.body as UpgradeBody).envDataKeyId;

    it('is an upgrade when the environment is now end-to-end encrypted under the key it sent', async () => {
      const storage = stubStorage();
      const vault = vaultFor(USER_ID);
      holdVaultKeys(vault);
      responses.set(`GET ${BASE}/encryption-upgrade/material`, { material: material() });
      lostAnswer();
      keysSay('e2ee', sentKeyId);

      const outcome = await runEncryptionUpgrade({
        target: TARGET,
        orgId: ORG_ID,
        vault,
        preview: preview(),
        share: false,
      });

      expect(outcome).toMatchObject({
        status: 'upgraded',
        confirmedByKeyState: true,
        result: {
          activeEdk: { id: sentKeyId(), version: 1 },
          secretCount: 2,
          versionCount: 4,
          noteCount: 1,
          erasedSecretCount: 1,
          revokedTokenCount: 1,
        },
      });
      expect(
        readModePins(window.localStorage as unknown as Storage)[modePinKey(TARGET)]?.mode,
      ).toBe('e2ee');
      expect(storage.size).toBe(1);
    });

    it('is never "nothing changed" when the environment still reads server-mode — it asks twice, then says unknown (review round 2, 7)', async () => {
      const storage = stubStorage();
      const vault = vaultFor(USER_ID);
      holdVaultKeys(vault);
      responses.set(`GET ${BASE}/encryption-upgrade/material`, { material: material() });
      lostAnswer();
      let reads = 0;
      responses.set(`GET ${BASE}/keys`, () => {
        reads += 1;
        return {
          keys: {
            encryptionMode: 'server',
            environmentId: ENVIRONMENT_ID,
            activeEdk: null,
            myGrant: null,
            ehkExists: false,
            pendingGrants: null,
            needsRotation: null,
            missingGrants: null,
            currentMaxSecretVersion: 0,
          },
        };
      });

      const outcome = await runEncryptionUpgrade({
        target: TARGET,
        orgId: ORG_ID,
        vault,
        preview: preview(),
        share: true,
        confirmDelayMs: 0,
      });
      expect(reads).toBe(2);
      expect(outcome.status === 'failed' && outcome.error).toMatchObject({ reason: 'unconfirmed' });
      expect(outcome.status === 'failed' && nothingChanged(outcome.error)).toBe(false);
      expect(storage.size).toBe(0);
    });

    it('finds an upgrade the second read sees, after a 5xx', async () => {
      stubStorage();
      const vault = vaultFor(USER_ID);
      holdVaultKeys(vault);
      responses.set(`GET ${BASE}/encryption-upgrade/material`, { material: material() });
      responses.set(`POST ${BASE}/encryption-upgrade`, () => {
        throw new ApiError({
          code: 'internal_error',
          message: 'Something went wrong.',
          status: 502,
          requestId: null,
        });
      });
      let reads = 0;
      responses.set(`GET ${BASE}/keys`, () => {
        reads += 1;
        const landed = reads > 1;
        return {
          keys: {
            encryptionMode: landed ? 'e2ee' : 'server',
            environmentId: ENVIRONMENT_ID,
            activeEdk: landed ? { id: sentKeyId(), version: 1 } : null,
            myGrant: null,
            ehkExists: landed,
            pendingGrants: null,
            needsRotation: null,
            missingGrants: null,
            currentMaxSecretVersion: 0,
          },
        };
      });

      const outcome = await runEncryptionUpgrade({
        target: TARGET,
        orgId: ORG_ID,
        vault,
        preview: preview(),
        share: false,
        confirmDelayMs: 0,
      });
      expect(outcome).toMatchObject({ status: 'upgraded', confirmedByKeyState: true });
    });

    it('says somebody else’s upgrade won when it is end-to-end encrypted under another key', async () => {
      stubStorage();
      const vault = vaultFor(USER_ID);
      holdVaultKeys(vault);
      responses.set(`GET ${BASE}/encryption-upgrade/material`, { material: material() });
      lostAnswer();
      const elsewhere = uuidv7();
      keysSay('e2ee', () => elsewhere);

      const outcome = await runEncryptionUpgrade({
        target: TARGET,
        orgId: ORG_ID,
        vault,
        preview: preview(),
        share: true,
      });
      expect(outcome.status === 'failed' && outcome.error).toMatchObject({
        reason: 'upgraded-elsewhere',
      });
    });

    it('never says "nothing changed" when the key state cannot be read either', async () => {
      const storage = stubStorage();
      const vault = vaultFor(USER_ID);
      holdVaultKeys(vault);
      responses.set(`GET ${BASE}/encryption-upgrade/material`, { material: material() });
      lostAnswer();
      responses.set(`GET ${BASE}/keys`, () => {
        throw new ApiError({
          code: 'network_error',
          message: 'Could not reach xecret.',
          status: 0,
          requestId: null,
        });
      });

      const outcome = await runEncryptionUpgrade({
        target: TARGET,
        orgId: ORG_ID,
        vault,
        preview: preview(),
        share: true,
      });
      expect(outcome.status === 'failed' && outcome.error).toMatchObject({ reason: 'unconfirmed' });
      expect(outcome.status === 'failed' && nothingChanged(outcome.error)).toBe(false);
      expect(storage.size).toBe(0);
    });
  });
});

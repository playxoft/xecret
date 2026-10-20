import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  encryptSecret,
  generateEnvironmentDataKey,
  generateEnvironmentHmacKey,
} from '@xecret/core/crypto/client';
import { DEFAULT_SECRET_POLICY } from '@xecret/core/policy';
import { uuidv7 } from '@xecret/core/ids';

import { isApiError } from '@/lib/api';
import { parseWith } from '@/server/http';
import {
  createClientSecretBody,
  restoreClientSecretBody,
  updateClientSecretBody,
} from '@/server/schemas/secrets';
import { policyProblem } from '@/components/policies/policy-checks';

import { holdEnvKey, releaseEnvKeys } from './env-key-store';
import type { EnvKeyMaterial } from './env-key-store';
import { clientSecretIo } from './secret-io';
import { decryptValue, encryptValue } from './secret-crypto';

/**
 * The secret IO's P19 half: what a template write declares, what a pull asks
 * for, and what an import refuses before it encrypts.
 *
 * The bodies are run through the server's own schemas, as `env-keys.test.ts`
 * does with its own — the only check that stands between a body this client
 * likes and a server that refuses it in production.
 */

const ORG_ID = '018f3f6a-0000-7000-8000-0000000000a1';
const ENVIRONMENT_ID = '018f3f6a-0000-7000-8000-0000000000b1';
const EDK_ID = '018f3f6a-0000-7000-8000-0000000000c1';
const BASE = '/api/orgs/acme/projects/api/environments/production';

const sent: { method: string; path: string; body: unknown }[] = [];
const responses = new Map<string, unknown>();

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  const record = (method: string) => (path: string, body: unknown) => {
    sent.push({ method, path, body });
    return Promise.resolve(responses.get(`${method} ${path}`) ?? { secret: {} });
  };
  return {
    ...actual,
    api: {
      get: vi.fn((path: string) => Promise.resolve(responses.get(`GET ${path}`) ?? {})),
      post: vi.fn(record('POST')),
      patch: vi.fn(record('PATCH')),
      put: vi.fn(record('PUT')),
      delete: vi.fn(),
    },
  };
});

const context = { orgSlug: 'acme', orgId: ORG_ID, projectSlug: 'api', envSlug: 'production' };
let material: EnvKeyMaterial;

beforeEach(() => {
  sent.length = 0;
  responses.clear();
  releaseEnvKeys();
  material = {
    environmentId: ENVIRONMENT_ID,
    envDataKeyId: EDK_ID,
    edkVersion: 1,
    edk: generateEnvironmentDataKey(),
    ehk: generateEnvironmentHmacKey(),
  };
  holdEnvKey(material);
});

describe('template writes declare their references', () => {
  const template = 'postgres://${DB_USER}@${shared.DB_HOST}/${core.prod.DB_NAME}';

  it('on a create', async () => {
    await clientSecretIo(context, material).create({
      name: 'DATABASE_URL',
      value: template,
      valueType: 'template',
    });
    const body = parseWith(createClientSecretBody, sent[0]?.body);
    expect(body.valueType).toBe('template');
    expect(body.references).toEqual([
      { name: 'DB_USER' },
      { environment: 'shared', name: 'DB_HOST' },
      { project: 'core', environment: 'prod', name: 'DB_NAME' },
    ]);
    // The text is the secret; only the names it refers to travel in the clear.
    expect(JSON.stringify(body)).not.toContain('postgres://');
  });

  it('on an update that sends no type, because the stored row is a template', async () => {
    const id = uuidv7();
    await clientSecretIo(context, material).update(
      { id, name: 'DATABASE_URL', version: 2, valueType: 'template' },
      { value: 'pg://${DB_USER}' },
    );
    const body = parseWith(updateClientSecretBody, sent[0]?.body);
    expect(body.valueType).toBeUndefined();
    expect(body.references).toEqual([{ name: 'DB_USER' }]);
    expect(body.expectedVersion).toBe(3);
  });

  it('and stops declaring them when the type moves away from template', async () => {
    await clientSecretIo(context, material).update(
      { id: uuidv7(), name: 'DATABASE_URL', version: 2, valueType: 'template' },
      { value: 'literal ${NOT_A_REFERENCE}', valueType: 'string' },
    );
    const body = parseWith(updateClientSecretBody, sent[0]?.body);
    expect(body.valueType).toBe('string');
    expect(body.references).toBeUndefined();
  });

  it('on a restore, re-parsed from the version it decrypted', async () => {
    const id = uuidv7();
    responses.set(`GET ${BASE}/secrets/DATABASE_URL/versions/1`, {
      secret: {
        id,
        envDataKeyId: EDK_ID,
        version: 1,
        ciphertext: await encryptSecret({
          edk: material.edk,
          context: {
            field: 'value',
            orgId: ORG_ID,
            environmentId: ENVIRONMENT_ID,
            secretId: id,
            version: 1,
          },
          plaintext: 'pg://${OLD_USER}',
        }),
      },
    });

    await clientSecretIo(context, material).restore(
      { id, name: 'DATABASE_URL', version: 4, valueType: 'template' },
      1,
    );
    const body = parseWith(restoreClientSecretBody, sent[0]?.body);
    expect(body.references).toEqual([{ name: 'OLD_USER' }]);
    expect(body.expectedVersion).toBe(5);
  });

  it('refuses to encrypt a template that does not parse', async () => {
    await expect(
      clientSecretIo(context, material).create({
        name: 'BROKEN',
        value: 'secret-ish ${unclosed',
        valueType: 'template',
      }),
    ).rejects.toThrow(/never closed/);
    expect(sent).toEqual([]);
  });

  it('declares nothing for a value that is not a template', async () => {
    await clientSecretIo(context, material).create({
      name: 'SHELL_SNIPPET',
      value: 'echo ${HOME}',
      valueType: 'string',
    });
    expect(parseWith(createClientSecretBody, sent[0]?.body).references).toBeUndefined();
  });
});

describe('pulls ask for the resolved bundle shape', () => {
  async function sealed(name: string, value: string, template = false) {
    const id = uuidv7();
    const body = await encryptValue({
      material,
      target: { orgId: ORG_ID, environmentId: ENVIRONMENT_ID, secretId: id },
      version: 1,
      plaintext: value,
    });
    return {
      id,
      name,
      ciphertext: body.ciphertext,
      clientAlgorithm: 'xk2.gcm',
      envDataKeyId: EDK_ID,
      version: 1,
      ...(template ? { template: true, references: [{ name: 'DB_USER' }] } : {}),
    };
  }

  it('reads a version 2 bundle: its own values only, templates as their text', async () => {
    responses.set(`GET ${BASE}/pull?bundle=2&layers=none`, {
      bundle: true,
      bundleVersion: 2,
      encryptionMode: 'e2ee',
      keys: {},
      environment: {
        id: ENVIRONMENT_ID,
        projectSlug: 'api',
        slug: 'production',
        parentEnvironmentId: '018f3f6a-0000-7000-8000-0000000000b9',
      },
      secrets: [await sealed('DSN', 'pg://${DB_USER}', true), await sealed('PORT', '8080')],
      // A parent's values arrive as a layer, and are never shown as this
      // environment's own.
      layers: [
        {
          environmentId: '018f3f6a-0000-7000-8000-0000000000b9',
          projectSlug: 'api',
          environmentSlug: 'base',
          parentEnvironmentId: null,
          keys: null,
          secrets: [],
        },
      ],
      policy: { plaintextExport: 'disabled' },
    });

    const io = clientSecretIo(context, material);
    expect(await io.pull()).toEqual({ DSN: 'pg://${DB_USER}', PORT: '8080' });

    const pulled = await io.pullEnvironment();
    expect(pulled.plaintextExport).toBe('disabled');
    expect(pulled.inherits).toBe(true);
    expect(pulled.templates).toEqual(['DSN']);
  });

  it('accepts a version 1 bundle, which carries no policy and resolves nothing', async () => {
    responses.set(`GET ${BASE}/pull?bundle=2&layers=none`, {
      bundle: true,
      bundleVersion: 1,
      encryptionMode: 'e2ee',
      keys: {},
      secrets: [await sealed('PORT', '8080')],
    });
    const pulled = await clientSecretIo(context, material).pullEnvironment();
    expect(pulled).toEqual({
      plaintexts: { PORT: '8080' },
      plaintextExport: 'allowed',
      inherits: false,
      templates: [],
    });
  });
});

describe('an import is held to the secret policy before it encrypts', () => {
  // Letters only, so a name the importer leaves exactly as written still
  // breaks it: the importer normalises a key's case and punctuation first.
  const policy = { ...DEFAULT_SECRET_POLICY, enabled: true, namePattern: '[A-Z]+' };

  it('refuses every entry that breaks a rule, by name, and sends nothing', async () => {
    responses.set(`GET ${BASE}/secrets?limit=200`, { data: [], nextCursor: null });

    const refusal = await clientSecretIo(context, material)
      .runImport({
        content: 'API_TOKEN=changeme\nHAS_UNDERSCORE=plainvalue\nFINE=ok\n',
        filename: '.env',
        format: 'auto',
        strategy: 'skip',
        dryRun: true,
        checkPolicy: (entry) =>
          policyProblem(policy, { ...entry, valueType: 'string', isProduction: true }),
      })
      .catch((cause: unknown) => cause);

    expect(isApiError(refusal)).toBe(true);
    if (!isApiError(refusal)) return;
    expect(Object.keys(refusal.fieldErrors()).sort()).toEqual(['API_TOKEN', 'HAS_UNDERSCORE']);
    expect(JSON.stringify(refusal.fields)).not.toContain('changeme');
    // Nothing was encrypted and nothing was posted — not even the dry run.
    expect(sent).toEqual([]);
  });

  it('lets a file through that meets the rules', async () => {
    responses.set(`GET ${BASE}/secrets?limit=200`, { data: [], nextCursor: null });
    responses.set(`POST ${BASE}/import`, {
      dryRun: true,
      counts: { create: 1, overwrite: 0, unchanged: 0 },
      items: [{ name: 'FINE', status: 'created' }],
    });

    const plan = await clientSecretIo(context, material).runImport({
      content: 'FINE=ok\n',
      filename: '.env',
      format: 'auto',
      strategy: 'skip',
      dryRun: true,
      checkPolicy: (entry) =>
        policyProblem(policy, { ...entry, valueType: 'string', isProduction: true }),
    });
    expect(plan.counts.create).toBe(1);
    const entry = (sent[0]?.body as { entries: { id: string; value: { ciphertext: string } }[] })
      .entries[0]!;
    await expect(
      decryptValue({
        material,
        target: { orgId: ORG_ID, environmentId: ENVIRONMENT_ID, secretId: entry.id },
        version: 1,
        ciphertext: entry.value.ciphertext,
      }),
    ).resolves.toBe('ok');
  });
});

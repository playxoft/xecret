import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  encodePublicKey,
  encryptSecret,
  generateEncryptionKeyPair,
  generateEnvironmentDataKey,
  generateEnvironmentHmacKey,
  generateInviteFragment,
  generateSigningKeyPair,
  parseInviteFragment,
  verifyGrantSignature,
} from '@xecret/core/crypto/client';
import type { Bytes } from '@xecret/core/crypto/client';
import { uuidv7 } from '@xecret/core/ids';

import { parseWith } from '@/server/http';
import {
  createClientSecretBody,
  importClientBody,
  restoreClientSecretBody,
  updateClientSecretBody,
} from '@/server/schemas/secrets';
import { environmentKeyGrantsSchema, environmentKeyRotateSchema } from '@/server/schemas/env-keys';
import type { VaultKeyMaterial } from '@/components/vault/key-store';

import {
  createEnvironmentKeys,
  openEnvironmentKeys,
  reSealInviteGrants,
  sealGrantFor,
  sealInviteGrant,
} from './env-keys';
import { envKeyCount, readEnvKey, releaseEnvKeys } from './env-key-store';
import { checkPin, fingerprint, readPins, recordPin, replacePin, writePins } from './pins';
import { buildRotationGrants, planRotation, shareTargets } from './rotation';
import { clientSecretIo, renderExport } from './secret-io';
import { decryptValue, encryptValue } from './secret-crypto';
import type { EnvironmentKeys, GrantBody, InviteKeyGrant, Recipient } from './types';

/**
 * The environment-key client layer, against real cryptography.
 *
 * ── Why the crypto is not mocked ──
 * The same argument `vault-client.test.ts` makes about the user half. What can
 * go wrong here is never "did we call `sealGrant`" — it is "does the grant we
 * uploaded actually open in the browser it was addressed to". A seal built with
 * the wrong AAD component, a rotation set missing one principal, a value
 * encrypted for the version it was read at rather than the one it will be stored
 * as: every one of those passes a mocked test and produces a row that stores
 * cleanly, reports success, and can never be decrypted by anybody, ever.
 *
 * So X25519, Ed25519, HKDF and AES-GCM all run for real, and the assertions are
 * *opens* and *verifies* rather than call counts.
 *
 * ── The one thing that is substituted, and the one that is pinned ──
 * HTTP, because the endpoints belong to Phase 3a and are tested in
 * `server/env-keys.test.ts`; what is under test here is the shape of the body.
 *
 * And that shape is pinned by running the server's own zod schemas over it. That
 * cross-layer check is not decoration — it is the assertion that caught a real
 * bug in Phase 2b, and it is the only thing standing between a client that
 * builds a body it likes and a server that rejects it in production.
 */

const ORG_ID = '018f3f6a-0000-7000-8000-0000000000a1';
const ENVIRONMENT_ID = '018f3f6a-0000-7000-8000-0000000000b1';
const EDK_ID = '018f3f6a-0000-7000-8000-0000000000c1';
const USER_ID = '018f3f6a-0000-7000-8000-0000000000d1';
const OTHER_USER_ID = '018f3f6a-0000-7000-8000-0000000000d2';
const TOKEN_ID = '018f3f6a-0000-7000-8000-0000000000e1';
const INVITATION_ID = '018f3f6a-0000-7000-8000-0000000000f1';

const posted: { path: string; body: unknown }[] = [];
const responses = new Map<string, unknown>();

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  const record = (path: string, body: unknown) => {
    posted.push({ path, body });
    return Promise.resolve(responses.get(`POST ${path}`) ?? {});
  };
  return {
    ...actual,
    api: {
      get: vi.fn((path: string) => Promise.resolve(responses.get(`GET ${path}`) ?? {})),
      post: vi.fn(record),
      put: vi.fn(record),
      patch: vi.fn(record),
      delete: vi.fn(),
    },
  };
});

/** A vault, as an unlocked browser holds one. Real keypairs, not fixtures. */
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

/** The key state `GET …/keys` would answer, given a grant. */
function keyStateWith(grant: GrantBody | null): EnvironmentKeys {
  return {
    encryptionMode: 'e2ee',
    environmentId: ENVIRONMENT_ID,
    activeEdk: { id: EDK_ID, version: 1 },
    myGrant:
      grant === null
        ? null
        : {
            edkSealed: grant.edkSealed,
            ehkSealed: grant.ehkSealed,
            signature: grant.signature,
            signedByUserId: USER_ID,
          },
    ehkExists: true,
    pendingGrants: null,
    needsRotation: false,
    currentMaxSecretVersion: 0,
  };
}

beforeEach(() => {
  posted.length = 0;
  responses.clear();
  releaseEnvKeys();
});

describe('grants', () => {
  it('seals a grant the recipient can open, and signs what it sends', async () => {
    const owner = vaultFor(USER_ID);
    const recipient = vaultFor(OTHER_USER_ID);
    const edk = generateEnvironmentDataKey();
    const ehk = generateEnvironmentHmacKey();

    const grant = await sealGrantFor({
      vault: owner,
      environmentId: ENVIRONMENT_ID,
      edkVersion: 3,
      edk,
      ehk,
      recipientKind: 'member',
      recipientId: OTHER_USER_ID,
      recipientPublicKey: recipient.encPublicKey,
    });

    // The signature covers the blobs that were actually sent, not a different
    // pair — a scheme where those can diverge authenticates nothing.
    expect(
      verifyGrantSignature({
        signerPublicKey: owner.signPublicKey,
        signature: grant.signature,
        fields: {
          environmentId: ENVIRONMENT_ID,
          edkVersion: 3,
          recipientKind: 'member',
          recipientId: OTHER_USER_ID,
          recipientPublicKey: recipient.encPublicKey,
          edkSealedBlob: grant.edkSealed,
          ehkSealedBlob: grant.ehkSealed,
        },
      }),
    ).toBe(true);

    // And the recipient can actually open it, which is the property that
    // survives every refactor of the code above.
    const state: EnvironmentKeys = {
      ...keyStateWith(grant),
      activeEdk: { id: EDK_ID, version: 3 },
    };
    const opened = await openEnvironmentKeys(state, recipient);

    expect(opened.status).toBe('open');
    if (opened.status !== 'open') return;
    expect([...opened.material.edk]).toEqual([...edk]);
    expect([...opened.material.ehk]).toEqual([...ehk]);
  });

  it('refuses to open a grant addressed to somebody else', async () => {
    const owner = vaultFor(USER_ID);
    const intended = vaultFor(OTHER_USER_ID);
    const eavesdropper = vaultFor(OTHER_USER_ID);

    const grant = await sealGrantFor({
      vault: owner,
      environmentId: ENVIRONMENT_ID,
      edkVersion: 1,
      edk: generateEnvironmentDataKey(),
      ehk: generateEnvironmentHmacKey(),
      recipientKind: 'member',
      recipientId: OTHER_USER_ID,
      recipientPublicKey: intended.encPublicKey,
    });

    await expect(openEnvironmentKeys(keyStateWith(grant), eavesdropper)).rejects.toThrow();
  });

  it('reports the pending state rather than failing, when nobody has shared the key', async () => {
    const result = await openEnvironmentKeys(keyStateWith(null), vaultFor(USER_ID));

    // A designed state, not an error: they have access and no key. Rendering it
    // as a failure would send somebody to ask for permission they hold.
    expect(result).toMatchObject({ status: 'unavailable', reason: 'pending' });
  });

  it('reports `locked` for a browser holding no vault keys', async () => {
    const owner = vaultFor(USER_ID);
    const grant = await sealGrantFor({
      vault: owner,
      environmentId: ENVIRONMENT_ID,
      edkVersion: 1,
      edk: generateEnvironmentDataKey(),
      ehk: generateEnvironmentHmacKey(),
      recipientKind: 'member',
      recipientId: USER_ID,
      recipientPublicKey: owner.encPublicKey,
    });

    expect(await openEnvironmentKeys(keyStateWith(grant), null)).toMatchObject({
      status: 'unavailable',
      reason: 'locked',
    });
  });

  it('caches by environment and key version, and a lock empties the cache', async () => {
    const owner = vaultFor(USER_ID);
    const grant = await sealGrantFor({
      vault: owner,
      environmentId: ENVIRONMENT_ID,
      edkVersion: 1,
      edk: generateEnvironmentDataKey(),
      ehk: generateEnvironmentHmacKey(),
      recipientKind: 'member',
      recipientId: USER_ID,
      recipientPublicKey: owner.encPublicKey,
    });

    await openEnvironmentKeys(keyStateWith(grant), owner);
    expect(readEnvKey(ENVIRONMENT_ID, EDK_ID)).not.toBeNull();

    // A rotation is a cache miss, not a stale hit. Keyed on the environment
    // alone, the retired key would keep being handed out — and every value
    // written under it would be sealed against a key the server refuses.
    expect(readEnvKey(ENVIRONMENT_ID, uuidv7())).toBeNull();

    releaseEnvKeys();
    expect(envKeyCount()).toBe(0);
  });
});

describe('environment creation', () => {
  it('produces a self-grant the creator can immediately open', async () => {
    const creator = vaultFor(USER_ID);
    const environmentId = uuidv7();

    const created = await createEnvironmentKeys({ vault: creator, environmentId });

    expect(created.grant.recipientKind).toBe('member');
    expect(created.grant.recipientId).toBe(USER_ID);

    const opened = await openEnvironmentKeys(
      {
        ...keyStateWith(created.grant),
        environmentId,
        activeEdk: { id: EDK_ID, version: 1 },
      },
      creator,
    );

    expect(opened.status).toBe('open');
    if (opened.status !== 'open') return;
    expect([...opened.material.edk]).toEqual([...created.edk]);
  });
});

describe('rotation', () => {
  /** A recipient list, as `GET …/keys/recipients` serves one. */
  function recipientsOf(entries: readonly { kind: 'member' | 'token'; id: string; key: Bytes }[]) {
    return entries.map((entry): Recipient => ({
      kind: entry.kind,
      id: entry.id,
      publicKey: encodePublicKey(entry.key),
      holdsGrant: false,
    }));
  }

  it('builds exactly the set the server requires — every principal, once', async () => {
    const owner = vaultFor(USER_ID);
    const colleague = vaultFor(OTHER_USER_ID);
    const token = generateEncryptionKeyPair();

    const recipients = recipientsOf([
      { kind: 'member', id: USER_ID, key: owner.encPublicKey },
      { kind: 'member', id: OTHER_USER_ID, key: colleague.encPublicKey },
      { kind: 'token', id: TOKEN_ID, key: token.publicKey },
    ]);

    const plan = planRotation({ currentVersion: 4, recipients, unsealable: [] });
    expect(plan.newVersion).toBe(5);

    const grants = await buildRotationGrants({
      vault: owner,
      environmentId: ENVIRONMENT_ID,
      newVersion: plan.newVersion,
      newEdk: generateEnvironmentDataKey(),
      ehk: generateEnvironmentHmacKey(),
      recipients: plan.recipients,
    });

    // The server recomputes this set from `can()` and refuses any difference in
    // either direction — a missing principal is a silent revocation, an extra
    // one is a key handed to somebody the access model does not permit. This is
    // the client's half of that agreement.
    expect(grants.map((grant) => `${grant.recipientKind}:${grant.recipientId}`)).toEqual([
      `member:${USER_ID}`,
      `member:${OTHER_USER_ID}`,
      `token:${TOKEN_ID}`,
    ]);

    // And the body the server would actually receive is one it accepts.
    const parsed = parseWith(environmentKeyRotateSchema, {
      newVersion: plan.newVersion,
      grants,
    });
    expect(parsed.grants).toHaveLength(3);
  });

  it('carries the EHK forward unchanged while the EDK is replaced', async () => {
    const owner = vaultFor(USER_ID);
    const ehk = generateEnvironmentHmacKey();
    const newEdk = generateEnvironmentDataKey();

    const [grant] = await buildRotationGrants({
      vault: owner,
      environmentId: ENVIRONMENT_ID,
      newVersion: 2,
      newEdk,
      ehk,
      recipients: recipientsOf([{ kind: 'member', id: USER_ID, key: owner.encPublicKey }]),
    });

    const opened = await openEnvironmentKeys(
      { ...keyStateWith(grant!), activeEdk: { id: EDK_ID, version: 2 } },
      owner,
    );

    expect(opened.status).toBe('open');
    if (opened.status !== 'open') return;
    // The EHK survives rotation by design (spec §9): rotating it would record
    // the first write to every secret afterwards as a change when nothing
    // changed, which is the exact question `value_hmac` exists to answer.
    expect([...opened.material.ehk]).toEqual([...ehk]);
    expect([...opened.material.edk]).toEqual([...newEdk]);
  });

  it('shares only to principals that do not already hold a grant', () => {
    const held: Recipient = {
      kind: 'member',
      id: USER_ID,
      publicKey: encodePublicKey(generateEncryptionKeyPair().publicKey),
      holdsGrant: true,
    };
    const owed: Recipient = { ...held, id: OTHER_USER_ID, holdsGrant: false };

    // The opposite filter from a rotation, and deliberately so: the unique index
    // per principal per key would reject a batch that re-sent an existing grant,
    // failing the whole share.
    expect(shareTargets([held, owed])).toEqual([owed]);
  });
});

describe('the invite fragment flow', () => {
  it('runs end to end: derive, seal, open, re-seal', async () => {
    const inviter = vaultFor(USER_ID);
    const invitee = vaultFor(OTHER_USER_ID);
    const edk = generateEnvironmentDataKey();
    const ehk = generateEnvironmentHmacKey();

    // The inviter mints a fragment; only its public half ever leaves.
    const fragment = generateInviteFragment();
    const grant = await sealInviteGrant({
      vault: inviter,
      fragmentSeed: fragment.seed,
      invitationId: INVITATION_ID,
      environmentId: ENVIRONMENT_ID,
      edkVersion: 1,
      edk,
      ehk,
    });

    expect(grant.recipientKind).toBe('invite');
    expect(grant.recipientId).toBe(INVITATION_ID);

    // The invitee types the code they were sent over the other channel. Parsed
    // from the *display form*, which is what a human copies — the round trip
    // through the grouping and the check character is part of the flow.
    const typed = parseInviteFragment(fragment.displayForm);

    const served: InviteKeyGrant = {
      environmentId: ENVIRONMENT_ID,
      projectSlug: 'acme',
      environmentSlug: 'production',
      envDataKeyId: EDK_ID,
      edkVersion: 1,
      edkSealed: grant.edkSealed,
      ehkSealed: grant.ehkSealed,
    };

    const outcome = await reSealInviteGrants({
      vault: invitee,
      fragmentSeed: typed.seed,
      invitationId: INVITATION_ID,
      grants: [served],
      orgSlug: 'acme',
    });

    expect(outcome).toEqual({ opened: 1, failed: [] });

    // What was uploaded is a grant addressed to the invitee themselves, sealed
    // afresh — never the invitation's blob copied across, which would produce a
    // row nobody can open because its AAD still names the invitation.
    const [upload] = posted;
    expect(upload?.path).toContain('/keys/grants');

    const body = parseWith(environmentKeyGrantsSchema, upload?.body);
    expect(body.envDataKeyId).toBe(EDK_ID);
    expect(body.grants[0]?.recipientKind).toBe('member');
    expect(body.grants[0]?.recipientId).toBe(OTHER_USER_ID);
    expect(body.grants[0]?.edkSealed).not.toBe(grant.edkSealed);

    // And it opens, with the same key material the inviter sealed.
    const reopened = await openEnvironmentKeys(keyStateWith(body.grants[0] as GrantBody), invitee);
    expect(reopened.status).toBe('open');
    if (reopened.status !== 'open') return;
    expect([...reopened.material.edk]).toEqual([...edk]);
    expect([...reopened.material.ehk]).toEqual([...ehk]);
  });

  it('reports a wrong fragment as an unopened grant rather than throwing', async () => {
    const inviter = vaultFor(USER_ID);
    const invitee = vaultFor(OTHER_USER_ID);

    const grant = await sealInviteGrant({
      vault: inviter,
      fragmentSeed: generateInviteFragment().seed,
      invitationId: INVITATION_ID,
      environmentId: ENVIRONMENT_ID,
      edkVersion: 1,
      edk: generateEnvironmentDataKey(),
      ehk: generateEnvironmentHmacKey(),
    });

    const outcome = await reSealInviteGrants({
      vault: invitee,
      // A different, well-formed fragment: it passes its own checksum, so this
      // is not a typo — it is somebody pasting the code from another invitation.
      fragmentSeed: generateInviteFragment().seed,
      invitationId: INVITATION_ID,
      grants: [
        {
          environmentId: ENVIRONMENT_ID,
          projectSlug: 'acme',
          environmentSlug: 'production',
          envDataKeyId: EDK_ID,
          edkVersion: 1,
          edkSealed: grant.edkSealed,
          ehkSealed: grant.ehkSealed,
        },
      ],
      orgSlug: 'acme',
    });

    expect(outcome.opened).toBe(0);
    expect(outcome.failed).toHaveLength(1);
    expect(posted).toHaveLength(0);
  });
});

describe('trust-on-first-use pinning', () => {
  /** A `Storage`, in a test that runs under Node. */
  function memoryStorage(): Storage {
    const map = new Map<string, string>();
    return {
      get length() {
        return map.size;
      },
      clear: () => map.clear(),
      getItem: (key) => map.get(key) ?? null,
      key: (index) => [...map.keys()][index] ?? null,
      removeItem: (key) => map.delete(key),
      setItem: (key, value) => void map.set(key, value),
    } as Storage;
  }

  it('records on first sighting, matches afterwards, and flags a substitution', () => {
    const first = encodePublicKey(generateEncryptionKeyPair().publicKey);
    const substituted = encodePublicKey(generateEncryptionKeyPair().publicKey);

    expect(checkPin({}, 'member', USER_ID, first)).toEqual({ status: 'new' });

    const pinned = recordPin({}, 'member', USER_ID, first, new Date('2026-01-01T00:00:00Z'));
    expect(checkPin(pinned, 'member', USER_ID, first)).toMatchObject({ status: 'match' });

    // The whole point. A server that answers with a key it holds the private
    // half of has to do it in front of somebody who has sealed to the real one.
    expect(checkPin(pinned, 'member', USER_ID, substituted)).toMatchObject({
      status: 'changed',
      pinned: first,
    });
  });

  it('never overwrites a changed key by accident, and does on purpose', () => {
    const first = encodePublicKey(generateEncryptionKeyPair().publicKey);
    const second = encodePublicKey(generateEncryptionKeyPair().publicKey);

    const pinned = recordPin({}, 'member', USER_ID, first);
    // `recordPin` is called wherever a list of recipients is rendered. If it
    // overwrote, it would erase the evidence on the very render that shows the
    // warning about it.
    expect(recordPin(pinned, 'member', USER_ID, second)).toBe(pinned);

    const accepted = replacePin(pinned, 'member', USER_ID, second);
    expect(checkPin(accepted, 'member', USER_ID, second)).toMatchObject({ status: 'match' });
  });

  it('survives a page reload, and treats unreadable storage as an empty book', () => {
    const storage = memoryStorage();
    const key = encodePublicKey(generateEncryptionKeyPair().publicKey);

    writePins(recordPin({}, 'token', TOKEN_ID, key), storage);
    expect(checkPin(readPins(storage), 'token', TOKEN_ID, key)).toMatchObject({ status: 'match' });

    storage.setItem('xecret.pins.v1', 'not json');
    // Over-warns rather than under-warns: an unreadable book reports first
    // contact, which is the true statement about what this browser has recorded.
    expect(readPins(storage)).toEqual({});
  });

  it('renders a fingerprint that is stable, short, and in the product’s alphabet', async () => {
    const keypair = generateEncryptionKeyPair();

    const once = await fingerprint(keypair.publicKey);
    const again = await fingerprint(keypair.publicKey);

    expect(once).toBe(again);
    // Eight Crockford characters, grouped in two. Not a commitment — 40 bits —
    // but a string two people can read to each other, in the same alphabet the
    // recovery codes and the invite fragment use.
    expect(once).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}$/);
    expect(await fingerprint(generateEncryptionKeyPair().publicKey)).not.toBe(once);
  });
});

describe('the client secret IO', () => {
  const context = {
    orgSlug: 'acme',
    orgId: ORG_ID,
    projectSlug: 'api',
    envSlug: 'production',
  };

  const material = {
    environmentId: ENVIRONMENT_ID,
    envDataKeyId: EDK_ID,
    edkVersion: 1,
    edk: generateEnvironmentDataKey(),
    ehk: generateEnvironmentHmacKey(),
  };

  it('builds a create body the server’s schema accepts, and encrypts it for version 1', async () => {
    const io = clientSecretIo(context, material);
    await io.create({ name: 'DATABASE_URL', value: 'postgres://live', valueType: 'string' });

    const [write] = posted;
    // The cross-layer pin. A body this client likes and the server refuses is a
    // failure that only shows up in production, and only on the write path.
    const body = parseWith(createClientSecretBody, write?.body);

    expect(body.name).toBe('DATABASE_URL');
    expect(body.value.envDataKeyId).toBe(EDK_ID);
    expect(body.value.clientAlgorithm).toBe('xk2.gcm');

    // The id is the client's, and the ciphertext is bound to it: decrypting
    // against any other id fails, which is what makes a relocated row unreadable
    // rather than silently readable.
    const plaintext = await decryptValue({
      material,
      target: { orgId: ORG_ID, environmentId: ENVIRONMENT_ID, secretId: body.id },
      version: 1,
      ciphertext: body.value.ciphertext,
    });
    expect(plaintext).toBe('postgres://live');

    await expect(
      decryptValue({
        material,
        target: { orgId: ORG_ID, environmentId: ENVIRONMENT_ID, secretId: uuidv7() },
        version: 1,
        ciphertext: body.value.ciphertext,
      }),
    ).rejects.toThrow();
  });

  it('encrypts an update for the version it will become, not the one it read', async () => {
    const io = clientSecretIo(context, material);
    const secretId = uuidv7();

    await io.update({ id: secretId, name: 'API_KEY', version: 4 }, { value: 'sk_live_next' });

    const body = parseWith(updateClientSecretBody, posted[0]?.body);

    // Version 5, because that is the row the ciphertext will occupy. Bytes
    // produced for version 4 and stored as version 5 would fail to open for the
    // rest of their life, silently — which is the failure the AAD binding of
    // `version` exists to make impossible.
    await expect(
      decryptValue({
        material,
        target: { orgId: ORG_ID, environmentId: ENVIRONMENT_ID, secretId },
        version: 5,
        ciphertext: body.value.ciphertext,
      }),
    ).resolves.toBe('sk_live_next');

    await expect(
      decryptValue({
        material,
        target: { orgId: ORG_ID, environmentId: ENVIRONMENT_ID, secretId },
        version: 4,
        ciphertext: body.value.ciphertext,
      }),
    ).rejects.toThrow();
  });

  it('re-encrypts on restore rather than copying the old ciphertext forward', async () => {
    const io = clientSecretIo(context, material);
    const secretId = uuidv7();

    const oldCiphertext = await encryptSecret({
      edk: material.edk,
      context: {
        field: 'value',
        orgId: ORG_ID,
        environmentId: ENVIRONMENT_ID,
        secretId,
        version: 2,
      },
      plaintext: 'the value from version 2',
    });

    responses.set(
      'GET /api/orgs/acme/projects/api/environments/production/secrets/API_KEY/versions/2',
      {
        secret: { id: secretId, ciphertext: oldCiphertext, envDataKeyId: EDK_ID, version: 2 },
      },
    );

    await io.restore({ id: secretId, name: 'API_KEY', version: 6 }, 2);

    const body = parseWith(restoreClientSecretBody, posted[0]?.body);
    expect(body.version).toBe(2);
    // A different ciphertext from the one that was read, holding the same
    // plaintext, bound to version 7.
    expect(body.value.ciphertext).not.toBe(oldCiphertext);
    await expect(
      decryptValue({
        material,
        target: { orgId: ORG_ID, environmentId: ENVIRONMENT_ID, secretId },
        version: 7,
        ciphertext: body.value.ciphertext,
      }),
    ).resolves.toBe('the value from version 2');
  });

  it('refuses a ciphertext sealed under a key that has been rotated away', async () => {
    const io = clientSecretIo(context, material);
    responses.set('/api/orgs/acme/projects/api/environments/production/secrets/API_KEY', {});
    responses.set('GET /api/orgs/acme/projects/api/environments/production/secrets/API_KEY', {
      secret: {
        id: uuidv7(),
        ciphertext: 'xk2.gcm.AAAA',
        envDataKeyId: uuidv7(),
        version: 1,
      },
    });

    // Named rather than surfaced as an opaque decryption failure: this version
    // predates a rotation, and the key that would open it was never stored
    // anywhere but in the browsers that held it.
    await expect(io.reveal({ id: uuidv7(), name: 'API_KEY', version: 1 })).rejects.toThrow(
      /rotated away/i,
    );
  });
});

describe('import and export, client-side', () => {
  const context = {
    orgSlug: 'acme',
    orgId: ORG_ID,
    projectSlug: 'api',
    envSlug: 'production',
  };

  const material = {
    environmentId: ENVIRONMENT_ID,
    envDataKeyId: EDK_ID,
    edkVersion: 1,
    edk: generateEnvironmentDataKey(),
    ehk: generateEnvironmentHmacKey(),
  };

  it('parses locally, encrypts each entry, and posts a body the server accepts', async () => {
    const io = clientSecretIo(context, material);

    responses.set('POST /api/orgs/acme/projects/api/environments/production/import', {
      dryRun: false,
      counts: { create: 2, overwrite: 0, unchanged: 0 },
      items: [
        { name: 'DATABASE_URL', status: 'created' },
        { name: 'STRIPE_KEY', status: 'created' },
      ],
    });

    const plan = await io.runImport({
      content: 'DATABASE_URL=postgres://live\nSTRIPE_KEY=sk_live_x\n',
      filename: '.env',
      format: 'auto',
      strategy: 'skip',
      dryRun: false,
      existingNames: [],
      existing: new Map(),
    });

    expect(plan.counts.create).toBe(2);
    expect(plan.format).toBe('dotenv');

    const body = parseWith(importClientBody, posted[0]?.body);
    expect(body.entries).toHaveLength(2);

    // The file was parsed here. What crossed the network is names and
    // ciphertexts — never the document, which would have been every secret in
    // it, in plaintext, in a request body.
    expect(JSON.stringify(body)).not.toContain('postgres://live');
    expect(JSON.stringify(body)).not.toContain('sk_live_x');

    const entry = body.entries[0]!;
    await expect(
      decryptValue({
        material,
        target: { orgId: ORG_ID, environmentId: ENVIRONMENT_ID, secretId: entry.id },
        version: 1,
        ciphertext: entry.value.ciphertext,
      }),
    ).resolves.toBe('postgres://live');
  });

  it('encrypts an overwrite against the stored row, at the version it will become', async () => {
    const io = clientSecretIo(context, material);
    const secretId = uuidv7();

    responses.set('POST /api/orgs/acme/projects/api/environments/production/import', {
      dryRun: false,
      counts: { create: 0, overwrite: 1, unchanged: 0 },
      items: [{ name: 'DATABASE_URL', status: 'updated' }],
    });

    await io.runImport({
      content: 'DATABASE_URL=postgres://newer\n',
      filename: '.env',
      format: 'dotenv',
      strategy: 'overwrite',
      dryRun: false,
      existingNames: ['DATABASE_URL'],
      existing: new Map([['DATABASE_URL', { id: secretId, name: 'DATABASE_URL', version: 3 }]]),
    });

    const body = parseWith(importClientBody, posted[0]?.body);
    const entry = body.entries[0]!;

    // The stored id, not a fresh one — the row already exists, and a ciphertext
    // bound to a new uuid would be unopenable against it.
    expect(entry.id).toBe(secretId);
    await expect(
      decryptValue({
        material,
        target: { orgId: ORG_ID, environmentId: ENVIRONMENT_ID, secretId },
        version: 4,
        ciphertext: entry.value.ciphertext,
      }),
    ).resolves.toBe('postgres://newer');
  });

  it('round-trips a document: encrypt, pull, decrypt, format', async () => {
    const io = clientSecretIo(context, material);
    const names = ['ALPHA', 'BRAVO'];
    const values = ['one', 'two'];

    const secrets = await Promise.all(
      names.map(async (name, index) => {
        const id = uuidv7();
        const value = await encryptValue({
          material,
          target: { orgId: ORG_ID, environmentId: ENVIRONMENT_ID, secretId: id },
          version: 1,
          plaintext: values[index]!,
        });
        return {
          id,
          name,
          ciphertext: value.ciphertext,
          clientAlgorithm: value.clientAlgorithm,
          envDataKeyId: EDK_ID,
          version: 1,
        };
      }),
    );

    responses.set('GET /api/orgs/acme/projects/api/environments/production/pull', {
      encryptionMode: 'e2ee',
      keys: keyStateWith(null),
      secrets,
    });

    const plaintexts = await io.pull();
    expect(plaintexts).toEqual({ ALPHA: 'one', BRAVO: 'two' });

    // Formatted with the same `@xecret/core/format` the Worker runs, so the file
    // is byte-identical to the one a `server`-mode export produces. The export
    // endpoint answers 409 for an `e2ee` environment precisely because
    // formatting takes plaintext and the server has none.
    expect(renderExport(plaintexts, 'env')).toBe('ALPHA=one\nBRAVO=two\n');
    expect(JSON.parse(renderExport(plaintexts, 'json'))).toEqual({ ALPHA: 'one', BRAVO: 'two' });
  });
});

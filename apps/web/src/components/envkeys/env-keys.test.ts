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

import { ApiError } from '@/lib/api';
import { parseWith } from '@/server/http';
import {
  createClientSecretBody,
  importClientBody,
  restoreClientSecretBody,
  updateClientSecretBody,
} from '@/server/schemas/secrets';
import { environmentKeyGrantsSchema, environmentKeyRotateSchema } from '@/server/schemas/env-keys';
import { holdVaultKeys, releaseVaultKeys } from '@/components/vault/key-store';
import type { VaultKeyMaterial } from '@/components/vault/key-store';

import {
  createEnvironmentKeys,
  openEnvironmentKeys,
  reSealInviteGrants,
  sealGrantFor,
  sealInviteGrant,
  submitGrants,
} from './env-keys';
import { envKeyCount, holdEnvKey, readEnvKey, releaseEnvKeys } from './env-key-store';
import type { EnvKeyMaterial } from './env-key-store';
import {
  checkPin,
  fingerprint,
  modeIsAllowed,
  modePinKey,
  pinKey,
  readModePins,
  readPins,
  recordModePin,
  recordPin,
  recordSealedPins,
  replacePin,
  substitutedRecipients,
  writePins,
} from './pins';
import { buildRotationGrants, planRotation, rotateEnvironment, shareTargets } from './rotation';
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
    const answer = responses.get(`POST ${path}`);
    // A registered function may also *throw*, which is how a test stages a
    // server refusal — the 409 a rotation landing mid-request produces.
    try {
      return Promise.resolve(typeof answer === 'function' ? answer() : (answer ?? {}));
    } catch (cause) {
      return Promise.reject(cause);
    }
  };
  return {
    ...actual,
    api: {
      // A registered *function* is called rather than returned, which is what
      // lets a test fire something — a vault lock, say — from inside an
      // operation that is halfway through its awaits.
      get: vi.fn((path: string) => {
        const answer = responses.get(`GET ${path}`);
        return Promise.resolve(typeof answer === 'function' ? answer() : (answer ?? {}));
      }),
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
            recipientPublicKey: grant.recipientPublicKey,
            edkSealed: grant.edkSealed,
            ehkSealed: grant.ehkSealed,
            signature: grant.signature,
            signedByUserId: USER_ID,
          },
    ehkExists: true,
    // `null` for all three, which is what the server answers a caller who may not
    // manage the environment's keys — the ordinary case for the paths this file
    // exercises.
    pendingGrants: null,
    needsRotation: null,
    missingGrants: null,
    currentMaxSecretVersion: 0,
  };
}

/**
 * One page of `GET …/secrets`, as the import path reads it.
 *
 * Registered under the exact query string the IO builds, so a test that mocks
 * the first page and not the second fails rather than quietly serving `{}` —
 * which is the whole point of the pagination this exercises.
 */
function listing(
  data: { id: string; name: string; version: number }[],
  nextCursor: string | null = null,
  cursor?: string,
) {
  const base = '/api/orgs/acme/projects/api/environments/production/secrets?limit=200';
  const path = cursor === undefined ? base : `${base}&cursor=${cursor}`;
  responses.set(`GET ${path}`, { data, nextCursor });
}

beforeEach(() => {
  posted.length = 0;
  responses.clear();
  releaseEnvKeys();
  // Both stores, because both now refuse to let a multi-step operation run
  // against material they are not holding — see `withVaultKeys` and
  // `withEnvKey`. A test that leaked an unlock into the next one would make the
  // guard look satisfied for the wrong reason.
  releaseVaultKeys();
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

    // The invitee's browser is unlocked: `reSealInviteGrants` is a leased
    // operation, and a lease is only granted against the material the store
    // holds. That is the guard, not a fixture detail.
    holdVaultKeys(invitee);

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

    holdVaultKeys(invitee);

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

  /**
   * The second book: which mode an environment answered in.
   *
   * A downgrade needs no cryptography at all — the server just says `server`,
   * and the dashboard starts putting values in request bodies in the clear. So
   * the transition that is refused is exactly one, and the other three are not.
   */
  describe('the encryption-mode pin', () => {
    const key = modePinKey({ orgSlug: 'acme', projectSlug: 'api', envSlug: 'production' });

    it('permits first contact and every direction except the downgrade', () => {
      const storage = memoryStorage();

      expect(modeIsAllowed(readModePins(storage), key, 'server').allowed).toBe(true);
      expect(modeIsAllowed(readModePins(storage), key, 'e2ee').allowed).toBe(true);

      recordModePin(key, 'e2ee', storage);

      // The one that matters: obeying it means the next value this browser saves
      // travels in plaintext.
      const downgrade = modeIsAllowed(readModePins(storage), key, 'server');
      expect(downgrade.allowed).toBe(false);
      expect(downgrade.pinned).toBe('e2ee');

      expect(modeIsAllowed(readModePins(storage), key, 'e2ee').allowed).toBe(true);
    });

    it('pins forward through the migration, and never back', () => {
      const storage = memoryStorage();

      recordModePin(key, 'server', storage);
      expect(modeIsAllowed(readModePins(storage), key, 'e2ee').allowed).toBe(true);

      // `server` → `e2ee` takes capability away from the server, so it is
      // adopted rather than warned about.
      recordModePin(key, 'e2ee', storage);
      expect(readModePins(storage)[key]?.mode).toBe('e2ee');

      // And the reverse write cannot erase it — a caller that could would be the
      // same hole, reached from the other side.
      recordModePin(key, 'server', storage);
      expect(readModePins(storage)[key]?.mode).toBe('e2ee');
    });

    it('is filed per environment, not per project', () => {
      const storage = memoryStorage();
      recordModePin(key, 'e2ee', storage);

      const sibling = modePinKey({ orgSlug: 'acme', projectSlug: 'api', envSlug: 'staging' });
      expect(modeIsAllowed(readModePins(storage), sibling, 'server').allowed).toBe(true);
    });

    it('treats unreadable storage as no pin at all', () => {
      const storage = memoryStorage();
      recordModePin(key, 'e2ee', storage);
      storage.setItem('xecret.pins.mode.v1', 'not json');

      expect(readModePins(storage)).toEqual({});
      expect(modeIsAllowed(readModePins(storage), key, 'server').allowed).toBe(true);
    });
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

  /**
   * Held in the store, and rebuilt for every test.
   *
   * Both halves matter. `withEnvKey` compares the IO's captured material against
   * what the store holds, and that identity check is the whole of the in-flight
   * guard: an IO built over material the store has never seen is exactly the
   * "encrypting under a key that has been released" case it exists to refuse. The
   * bytes are regenerated per test because the outer `beforeEach` releases the
   * store, which overwrites them in place.
   */
  let material: EnvKeyMaterial;

  beforeEach(() => {
    material = {
      environmentId: ENVIRONMENT_ID,
      envDataKeyId: EDK_ID,
      edkVersion: 1,
      edk: generateEnvironmentDataKey(),
      ehk: generateEnvironmentHmacKey(),
    };
    holdEnvKey(material);
  });

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

    // Stated on the wire, not left for the server to derive. Without it a second
    // writer's version lands under this ciphertext and the row is lost behind a
    // 200 — see `expectedVersionSchema`.
    expect(body.expectedVersion).toBe(5);

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
    // The two versions a restore carries, and they are not the same number:
    // restored *from* 2, written *as* 7.
    expect(body.version).toBe(2);
    expect(body.expectedVersion).toBe(7);
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

  /**
   * Held in the store, and rebuilt for every test.
   *
   * Both halves matter. `withEnvKey` compares the IO's captured material against
   * what the store holds, and that identity check is the whole of the in-flight
   * guard: an IO built over material the store has never seen is exactly the
   * "encrypting under a key that has been released" case it exists to refuse. The
   * bytes are regenerated per test because the outer `beforeEach` releases the
   * store, which overwrites them in place.
   */
  let material: EnvKeyMaterial;

  beforeEach(() => {
    material = {
      environmentId: ENVIRONMENT_ID,
      envDataKeyId: EDK_ID,
      edkVersion: 1,
      edk: generateEnvironmentDataKey(),
      ehk: generateEnvironmentHmacKey(),
    };
    holdEnvKey(material);
  });

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

    listing([]);

    const plan = await io.runImport({
      content: 'DATABASE_URL=postgres://live\nSTRIPE_KEY=sk_live_x\n',
      filename: '.env',
      format: 'auto',
      strategy: 'skip',
      dryRun: false,
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
    expect(entry.expectedVersion).toBe(1);
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

    // The listing arrives in two pages, so the plan is only correct if the IO
    // follows the cursor to the end. A run that stopped at the first page would
    // classify DATABASE_URL as a create and seal against a uuid nobody stores.
    listing([{ id: uuidv7(), name: 'AAA_FIRST', version: 1 }], 'page-2');
    listing([{ id: secretId, name: 'DATABASE_URL', version: 3 }], null, 'page-2');

    await io.runImport({
      content: 'DATABASE_URL=postgres://newer\n',
      filename: '.env',
      format: 'dotenv',
      strategy: 'overwrite',
      dryRun: false,
    });

    const body = parseWith(importClientBody, posted[0]?.body);
    const entry = body.entries[0]!;

    // The stored id, not a fresh one — the row already exists, and a ciphertext
    // bound to a new uuid would be unopenable against it. It is on the *second*
    // listing page, so this also pins that the whole listing was read.
    expect(entry.id).toBe(secretId);
    expect(entry.expectedVersion).toBe(4);
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

describe('the in-flight crypto guard', () => {
  const context = {
    orgSlug: 'acme',
    orgId: ORG_ID,
    projectSlug: 'api',
    envSlug: 'production',
  };

  /**
   * The failure this whole section exists for.
   *
   * A lock used to overwrite the environment key **in place**, and the arrays it
   * overwrote were the ones a multi-step operation had already captured. So an
   * idle timer firing between two entries of an import did not abort the import;
   * it changed the key the second entry was encrypted with — to thirty-two
   * zeroes. AES-GCM under an all-zero key does not fail. It produces a perfectly
   * well-formed ciphertext that nothing will ever open, the upload returns 200,
   * and the row sits in the database looking exactly like a working one.
   *
   * Every assertion below is therefore an *open*, not a call count: the only
   * evidence that matters is whether what was uploaded decrypts under the key
   * the operation started with.
   */
  function freshMaterial(): EnvKeyMaterial {
    return {
      environmentId: ENVIRONMENT_ID,
      envDataKeyId: EDK_ID,
      edkVersion: 1,
      edk: generateEnvironmentDataKey(),
      ehk: generateEnvironmentHmacKey(),
    };
  }

  /** A detached copy, so the deferred wipe cannot reach the assertion's key. */
  function snapshot(material: EnvKeyMaterial): EnvKeyMaterial {
    return { ...material, edk: material.edk.slice(), ehk: material.ehk.slice() };
  }

  it('finishes a two-item import under the real key when the vault locks mid-flight', async () => {
    const material = freshMaterial();
    const before = snapshot(material);
    holdEnvKey(material);

    const io = clientSecretIo(context, material);

    // The lock lands *inside* the operation: `runImport` has already taken its
    // lease and is awaiting the listing when the idle timer fires.
    responses.set(
      'GET /api/orgs/acme/projects/api/environments/production/secrets?limit=200',
      () => {
        releaseEnvKeys();
        return { data: [], nextCursor: null };
      },
    );

    responses.set('POST /api/orgs/acme/projects/api/environments/production/import', {
      dryRun: false,
      counts: { create: 2, overwrite: 0, unchanged: 0 },
      items: [],
    });

    await io.runImport({
      content: 'ALPHA=one\nBRAVO=two\n',
      filename: '.env',
      format: 'auto',
      strategy: 'overwrite',
      dryRun: false,
    });

    const [upload] = posted;
    const body = parseWith(importClientBody, upload?.body);
    expect(body.entries).toHaveLength(2);

    // Both entries, opened with the key the operation began with. A zero-key
    // ciphertext would parse, would have passed the schema, and would fail here
    // — which is the only place it could ever have been caught.
    const opened = await Promise.all(
      body.entries.map((entry) =>
        decryptValue({
          material: before,
          target: { orgId: ORG_ID, environmentId: ENVIRONMENT_ID, secretId: entry.id },
          version: entry.expectedVersion,
          ciphertext: entry.value.ciphertext,
        }),
      ),
    );
    expect(opened).toEqual(['one', 'two']);
  });

  it('wipes the key once the operation that was holding it releases', async () => {
    const material = freshMaterial();
    holdEnvKey(material);

    const io = clientSecretIo(context, material);
    responses.set(
      'GET /api/orgs/acme/projects/api/environments/production/secrets?limit=200',
      () => {
        releaseEnvKeys();
        // The store forgets immediately — a locked session must be able to reach
        // nothing — while the overwrite waits for the lease.
        expect(readEnvKey(ENVIRONMENT_ID, EDK_ID)).toBeNull();
        expect(material.edk.some((byte) => byte !== 0)).toBe(true);
        return { data: [], nextCursor: null };
      },
    );

    responses.set('POST /api/orgs/acme/projects/api/environments/production/import', {
      dryRun: false,
      counts: { create: 1, overwrite: 0, unchanged: 0 },
      items: [],
    });

    await io.runImport({
      content: 'ALPHA=one\n',
      filename: '.env',
      format: 'auto',
      strategy: 'overwrite',
      dryRun: false,
    });

    // Deferred, not skipped. The bytes are gone the moment nothing is using them.
    expect([...material.edk]).toEqual([...new Uint8Array(32)]);
    expect([...material.ehk]).toEqual([...new Uint8Array(material.ehk.length)]);
  });

  it('refuses to start an operation against material the store no longer holds', async () => {
    const material = freshMaterial();
    holdEnvKey(material);

    const io = clientSecretIo(context, material);
    releaseEnvKeys();

    // Aborts before the first encrypt, and — the part that matters — before the
    // first request. Nothing half-written, nothing to reconcile.
    await expect(
      io.create({ name: 'DATABASE_URL', value: 'postgres://live', valueType: 'string' }),
    ).rejects.toThrow(/vault was locked/i);
    expect(posted).toHaveLength(0);
  });

  it('refuses a rotation whose environment key was released first', async () => {
    const vault = vaultFor(USER_ID);
    holdVaultKeys(vault);

    const material = freshMaterial();
    holdEnvKey(material);
    releaseEnvKeys();

    const outcome = await rotateEnvironment({
      target: { orgSlug: 'acme', projectSlug: 'api', envSlug: 'production' },
      vault,
      material,
      plan: planRotation({
        currentVersion: 1,
        recipients: [
          {
            kind: 'member',
            id: OTHER_USER_ID,
            publicKey: encodePublicKey(generateEncryptionKeyPair().publicKey),
            holdsGrant: false,
          },
        ],
        unsealable: [],
      }),
    });

    // A failure, not an `incomplete`: the server never heard about it, because a
    // rotation sealing the old EHK from a zeroized array would have produced a
    // complete-looking grant set that revokes everybody.
    expect(outcome.status).toBe('failed');
    expect(posted).toHaveLength(0);
  });
});

describe('sealing against a key that moved', () => {
  const target = { orgSlug: 'acme', projectSlug: 'api', envSlug: 'production' };

  it('re-reads, re-seals against the active key, and retries once', async () => {
    // ── The stale snapshot this closes ──
    // Every caller seals against material a screen has been holding. A rotation
    // landing between the render and the click makes the seal address a version
    // the server refuses — and reporting that to somebody who did nothing wrong
    // was the old behaviour on both the share banner and the token mint, where
    // it surfaced as `keyShared: false` on a credential that had already been
    // created and could never be shown again.
    const vault = vaultFor(USER_ID);
    holdVaultKeys(vault);

    const stale: EnvKeyMaterial = {
      environmentId: ENVIRONMENT_ID,
      envDataKeyId: EDK_ID,
      edkVersion: 1,
      edk: generateEnvironmentDataKey(),
      ehk: generateEnvironmentHmacKey(),
    };
    holdEnvKey(stale);

    // The key the rotation left behind, and the grant on it this browser holds.
    const rotatedEdkId = '018f3f6a-0000-7000-8000-0000000000c2';
    const freshEdk = generateEnvironmentDataKey();
    const freshEhk = generateEnvironmentHmacKey();
    const myGrant = await sealGrantFor({
      vault,
      environmentId: ENVIRONMENT_ID,
      edkVersion: 2,
      edk: freshEdk,
      ehk: freshEhk,
      recipientKind: 'member',
      recipientId: USER_ID,
      recipientPublicKey: vault.encPublicKey,
    });

    responses.set('GET /api/orgs/acme/projects/api/environments/production/keys', {
      keys: {
        ...keyStateWith(myGrant),
        activeEdk: { id: rotatedEdkId, version: 2 },
      },
    });

    let attempts = 0;
    responses.set('POST /api/orgs/acme/projects/api/environments/production/keys/grants', () => {
      attempts += 1;
      if (attempts === 1) {
        throw new ApiError({
          code: 'conflict',
          message: 'These grants were sealed for version 1; the active key is version 2.',
          status: 409,
          requestId: null,
        });
      }
      return { granted: 1 };
    });

    const recipient = vaultFor(OTHER_USER_ID);
    const outcome = await submitGrants({
      target,
      vault,
      material: stale,
      seal: (current) =>
        sealGrantFor({
          vault,
          environmentId: current.environmentId,
          edkVersion: current.edkVersion,
          edk: current.edk,
          ehk: current.ehk,
          recipientKind: 'member',
          recipientId: OTHER_USER_ID,
          recipientPublicKey: recipient.encPublicKey,
        }).then((grant) => [grant]),
    });

    expect(attempts).toBe(2);
    expect(outcome.granted).toBe(1);
    expect(outcome.material.envDataKeyId).toBe(rotatedEdkId);

    // The retry sealed *different bytes*, against the new key id, and the
    // recipient can open them. Re-posting the original blobs under a new key id
    // would have stored a row nobody can ever open, behind a 201.
    const [, retry] = posted;
    const body = parseWith(environmentKeyGrantsSchema, retry?.body);
    expect(body.envDataKeyId).toBe(rotatedEdkId);

    const opened = await openEnvironmentKeys(
      {
        ...keyStateWith(body.grants[0] as GrantBody),
        activeEdk: { id: rotatedEdkId, version: 2 },
      },
      recipient,
    );
    expect(opened.status).toBe('open');
    if (opened.status !== 'open') return;
    expect([...opened.material.edk]).toEqual([...freshEdk]);
  });

  it('gives up after one retry rather than chasing a second rotation', async () => {
    const vault = vaultFor(USER_ID);
    holdVaultKeys(vault);

    const material: EnvKeyMaterial = {
      environmentId: ENVIRONMENT_ID,
      envDataKeyId: EDK_ID,
      edkVersion: 1,
      edk: generateEnvironmentDataKey(),
      ehk: generateEnvironmentHmacKey(),
    };
    holdEnvKey(material);

    const myGrant = await sealGrantFor({
      vault,
      environmentId: ENVIRONMENT_ID,
      edkVersion: 1,
      edk: material.edk,
      ehk: material.ehk,
      recipientKind: 'member',
      recipientId: USER_ID,
      recipientPublicKey: vault.encPublicKey,
    });

    responses.set('GET /api/orgs/acme/projects/api/environments/production/keys', {
      keys: keyStateWith(myGrant),
    });

    let attempts = 0;
    responses.set('POST /api/orgs/acme/projects/api/environments/production/keys/grants', () => {
      attempts += 1;
      throw new ApiError({
        code: 'conflict',
        message: 'rotated again',
        status: 409,
        requestId: null,
      });
    });

    await expect(
      submitGrants({
        target,
        vault,
        material,
        seal: () => Promise.resolve([] as GrantBody[]),
      }),
    ).rejects.toThrow(/rotated again/);

    // Two administrators rotating at once is not a race this browser should keep
    // chasing, and a loop here would be one with no exit condition at all.
    expect(attempts).toBe(2);
  });
});

describe('trust on first use, enforced', () => {
  /** A `Storage`, in a test that runs under Node. See the pinning suite above. */
  function book(): Storage {
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

  it('names a substituted recipient and records nothing by looking at it', () => {
    const storage = book();
    const stored = encodePublicKey(generateEncryptionKeyPair().publicKey);
    const substituted = encodePublicKey(generateEncryptionKeyPair().publicKey);

    writePins(recordPin(readPins(storage), 'member', OTHER_USER_ID, stored), storage);

    const recipients: Recipient[] = [
      { kind: 'member', id: OTHER_USER_ID, publicKey: substituted, holdsGrant: false },
      { kind: 'member', id: USER_ID, publicKey: stored, holdsGrant: false },
    ];

    // The one presenting a different key is named; the one nobody has a pin for
    // is not, because first contact is not a substitution.
    expect(substitutedRecipients(recipients, readPins(storage)).map((entry) => entry.id)).toEqual([
      OTHER_USER_ID,
    ]);

    // And asking the question changed nothing. `FingerprintList` used to pin on
    // render, which meant a key was trusted for having been *displayed* — so a
    // substitution arriving before any pin existed was recorded as the trusted
    // key, and every later comparison agreed with it.
    expect(readPins(storage)[pinKey('member', USER_ID)]).toBeUndefined();
  });

  it('records pins only for the recipients a completed act sealed to', () => {
    const storage = book();
    const first = encodePublicKey(generateEncryptionKeyPair().publicKey);
    const second = encodePublicKey(generateEncryptionKeyPair().publicKey);

    recordSealedPins(
      [
        { kind: 'member', id: USER_ID, publicKey: first, holdsGrant: false },
        { kind: 'token', id: TOKEN_ID, publicKey: second, holdsGrant: false },
      ],
      storage,
    );

    expect(readPins(storage)[pinKey('member', USER_ID)]?.publicKey).toBe(first);
    expect(readPins(storage)[pinKey('token', TOKEN_ID)]?.publicKey).toBe(second);

    // A changed key is never overwritten by this path: the evidence that a
    // substitution happened is the only thing standing between a person and
    // sealing to it.
    const substituted = encodePublicKey(generateEncryptionKeyPair().publicKey);
    recordSealedPins(
      [{ kind: 'member', id: USER_ID, publicKey: substituted, holdsGrant: false }],
      storage,
    );
    expect(readPins(storage)[pinKey('member', USER_ID)]?.publicKey).toBe(first);
  });
});

describe('the fingerprint the CLI and the browser must agree on', () => {
  it('renders the shared cross-language vector', async () => {
    // The consent screen shows this for the CLI's hand-off key and the CLI
    // prints it for the same bytes; a person compares them by eye. Two
    // implementations of one format is exactly how they come to disagree, so the
    // agreement is pinned by a value both suites assert — `KeyFingerprint` in
    // `cli/internal/e2ee` checks the same input against the same string.
    const bytes = new Uint8Array(32);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;

    expect(await fingerprint(bytes)).toBe('CC6W-TAB6');
  });
});

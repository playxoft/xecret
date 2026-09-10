import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toBase64Url } from '@xecret/core/crypto';
import type { Database } from '@xecret/db';
import type {
  EnvironmentRecord,
  Organization,
  ProjectRecord,
  SecretMaterial,
} from '@xecret/db/repositories';
import { ApiError } from './errors';
import { createLogger } from './logging';
import type { Bindings } from './bindings';
import type { Principal } from './actor';
import type { ServiceContext } from './context';
import type { EnvironmentScope } from './tenancy';
import {
  environmentKeyGrantsSchema,
  environmentKeyRotateSchema,
  grantSchema,
} from './schemas/env-keys';
import {
  createClientSecretBody,
  duplicateEntryName,
  updateClientSecretBody,
} from './schemas/secrets';

/**
 * What these tests prove, and what they do not.
 *
 * **They prove the decisions this phase actually makes.** The server holds no
 * key under ADR 0009, so almost everything it does with an environment key is a
 * *policy* decision — who must appear in a rotation, who may hold a grant, when
 * a revocation is still outstanding — and those are exactly what is exercised
 * here, against the real `can()` and the real schemas:
 *
 *  - a rotation missing a principal with access is refused, **naming them**;
 *  - a rotation carrying a principal without access is refused too, which is the
 *    direction that would otherwise be a privilege escalation dressed as
 *    maintenance;
 *  - `needsRotation` is true exactly while somebody holds the active key who
 *    should not;
 *  - the pending queue is written when access widens and cleared when it narrows;
 *  - a developer denied production holds no grant path to it — neither the read
 *    nor the grant endpoint;
 *  - the wire schemas accept a conforming blob and reject a malformed one
 *    *without ever decoding it*.
 *
 * **The database is a test double.** No PostgreSQL runs in this process, so
 * nothing here demonstrates that `env_data_keys_active_unique` actually rejects a
 * second active key, that `env_key_grants_principal_check` actually refuses two
 * principals, or that a rotation's transaction rolls back. Those are asserted
 * structurally in `packages/db/src/schema/schema.test.ts` and need an integration
 * suite to be demonstrated behaviourally.
 *
 * **No cryptography is exercised, and there is none to exercise.** Every blob
 * below is a plausible-looking string, because a plausible-looking string is
 * exactly what this server can tell apart from a malformed one and no more. That
 * is not a gap in the tests; it is the property under test.
 */

const ORG_ID = '01930000-0000-7000-8000-0000000000a1';
const PROJECT_ID = '01930000-0000-7000-8000-0000000000b1';
const ENV_ID = '01930000-0000-7000-8000-0000000000c1';
const KEY_ID = '01930000-0000-7000-8000-0000000000d1';
const OWNER_ID = '01930000-0000-7000-8000-0000000000f1';
const DEVELOPER_ID = '01930000-0000-7000-8000-0000000000f2';
const TOKEN_ID = '01930000-0000-7000-8000-0000000000f3';
const INVITATION_ID = '01930000-0000-7000-8000-0000000000f4';
const GRANT_ID = '01930000-0000-7000-8000-0000000000f5';
/** A second project, for the invitation selections that must not reach this one. */
const OTHER_PROJECT_ID = '01930000-0000-7000-8000-0000000000f6';

/** A conforming `xk2.x25519.` payload: 92 bytes, base64url, no padding. */
const SEALED = `xk2.x25519.${'A'.repeat(123)}`;
/** A conforming `xk2.ed25519.` payload: exactly 64 bytes. */
const SIGNATURE = `xk2.ed25519.${'B'.repeat(86)}`;
/** A conforming 32-byte public key, base64url. */
const RECIPIENT_KEY = toBase64Url(new Uint8Array(32).fill(7));
/** A conforming `xk2.gcm.` payload, comfortably above the 28-byte floor. */
const CIPHERTEXT = `xk2.gcm.${'C'.repeat(64)}`;

const HMAC_A = toBase64Url(new Uint8Array(32).fill(1));
const HMAC_B = toBase64Url(new Uint8Array(32).fill(2));

const repository = vi.hoisted(() => ({
  loadEnvironmentKeyState: vi.fn(),
  findGrantForPrincipal: vi.fn(),
  listGrantsForEnvironment: vi.fn(),
  listPendingKeyGrants: vi.fn(),
  listSealableServiceTokens: vi.fn(),
  loadOrganizationAuthorizationContexts: vi.fn(),
  loadAuthorizationContext: vi.fn(),
  rotateEnvDataKey: vi.fn(),
  addEnvKeyGrants: vi.fn(),
  initializeEnvironmentKeys: vi.fn(),
  removeEnvKeyGrant: vi.fn(),
  removeMemberGrantsForEnvironment: vi.fn(),
  removePendingKeyGrant: vi.fn(),
  queuePendingKeyGrant: vi.fn(),
  findPendingInvitationForGrant: vi.fn(),
  canClaimInvitationGrants: vi.fn(),
  hasVault: vi.fn(),
  listEnvironmentsForOrganization: vi.fn(),
  loadMemberKeyPresence: vi.fn(),
  loadEnvironmentSecrets: vi.fn(),
  createSecret: vi.fn(),
  addSecretVersion: vi.fn(),
  updateSecretMetadata: vi.fn(),
}));

vi.mock('@xecret/db/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xecret/db/repositories')>();
  return { ...actual, ...repository };
});

const {
  addGrants,
  assertSelfGrant,
  environmentKeyState,
  initializeKeys,
  requireE2ee,
  requireSealingUser,
  revokeGrant,
  rotateKeys,
} = await import('./env-keys-service');

const { reconcileMemberKeyAccess } = await import('./member-keys');

const { applyClientSecretWrites, writeClientSecretValue } = await import('./secrets-service');

function services(): ServiceContext {
  return {
    env: {} as Bindings,
    db: {
      transaction: (run: (tx: unknown) => Promise<unknown>) => run({}),
    } as unknown as Database,
    envelope: {} as ServiceContext['envelope'],
    meta: {
      requestId: 'req-test',
      rayId: null,
      ipAddress: null,
      userAgent: null,
      method: 'POST',
      path: '/api/test',
      startedAt: 0,
    },
    log: createLogger({
      sink: { write: () => {}, flush: () => Promise.resolve() },
      minimum: 'error',
      base: { requestId: 'req-test' },
    }).logger,
    bindLog: () => {},
    waitUntil: () => {},
    settled: () => Promise.resolve(),
    dispose: () => {},
  };
}

/** The caller's scope. `owner` by default — the role that may manage keys. */
function scope(
  overrides: { role?: 'owner' | 'developer'; isProduction?: boolean } = {},
): EnvironmentScope {
  const role = overrides.role ?? 'owner';
  const userId = role === 'owner' ? OWNER_ID : DEVELOPER_ID;

  return {
    organization: { id: ORG_ID, slug: 'acme' } as unknown as Organization,
    project: { id: PROJECT_ID, slug: 'api' } as unknown as ProjectRecord,
    environment: {
      id: ENV_ID,
      projectId: PROJECT_ID,
      slug: 'production',
      isProduction: overrides.isProduction ?? true,
      encryptionMode: 'e2ee',
    } as unknown as EnvironmentRecord,
    actor: { kind: 'user', userId, orgId: ORG_ID },
    membership: { orgId: ORG_ID, userId, memberId: userId, role, status: 'active', grants: [] },
  };
}

const ownerPrincipal: Principal = {
  kind: 'user',
  sessionId: 'session-1',
  user: {
    id: OWNER_ID,
    email: 'owner@example.com',
    displayName: null,
    avatarUrl: null,
    emailVerified: true,
  },
  vaultUnlockedAt: new Date(),
};

const developerPrincipal: Principal = {
  ...ownerPrincipal,
  user: { ...ownerPrincipal.user, id: DEVELOPER_ID, email: 'dev@example.com' },
};

function grant(overrides: Partial<{ kind: 'member' | 'token' | 'invite'; id: string }> = {}) {
  return {
    recipientKind: overrides.kind ?? ('member' as const),
    recipientId: overrides.id ?? OWNER_ID,
    recipientPublicKey: RECIPIENT_KEY,
    edkSealed: SEALED,
    ehkSealed: SEALED,
    signature: SIGNATURE,
  };
}

/** A stored grant row, as the repository returns one. */
function grantRow(kind: 'member' | 'token' | 'invite', id: string, keyId = KEY_ID) {
  return {
    id: GRANT_ID,
    envDataKeyId: keyId,
    recipientKind: kind,
    recipientId: id,
    recipientPublicKey: new Uint8Array(32).fill(7),
    edkSealed: new TextEncoder().encode(SEALED),
    ehkSealed: new TextEncoder().encode(SEALED),
    signature: new TextEncoder().encode(SIGNATURE),
    signedByUserId: OWNER_ID,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };
}

/**
 * The roster the completeness check reads, and the levels it resolves.
 *
 * `owner` reaches production by role default; `developer` does not — production
 * is deny-by-default for everybody below admin, which is the single most
 * important row in `ROLE_ACCESS_DEFAULTS` and the one these tests lean on.
 */
function roster(members: { userId: string; role: 'owner' | 'developer' }[]) {
  // One bulk read, not a page plus a context per member. The shape is what
  // `loadOrganizationAuthorizationContexts` returns: every **active** member of
  // the organisation with their grants already attached, and no `hasMore` to
  // discard — which is the whole point, since a page boundary in this answer is
  // a silent revocation of everybody past it.
  repository.loadOrganizationAuthorizationContexts.mockResolvedValue(
    members.map((member) => ({
      orgId: ORG_ID,
      userId: member.userId,
      memberId: member.userId,
      role: member.role,
      status: 'active',
      grants: [],
    })),
  );

  repository.loadAuthorizationContext.mockImplementation(
    (_db: unknown, params: { userId: string }) => {
      const member = members.find((entry) => entry.userId === params.userId);
      if (!member) return Promise.resolve(null);
      return Promise.resolve({
        orgId: ORG_ID,
        userId: member.userId,
        memberId: member.userId,
        role: member.role,
        status: 'active',
        grants: [],
      });
    },
  );
}

/** Rotations that got past the completeness check and would have written rows. */
let rotationsCommitted = 0;

async function rejection(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (cause) {
    if (cause instanceof ApiError) return cause;
    throw cause;
  }
  throw new Error('expected the operation to fail, but it succeeded');
}

beforeEach(() => {
  vi.clearAllMocks();
  repository.loadEnvironmentKeyState.mockResolvedValue({
    activeKey: {
      id: KEY_ID,
      environmentId: ENV_ID,
      version: 1,
      status: 'active',
      createdBy: OWNER_ID,
      createdAt: new Date(),
    },
    ehkExists: true,
    currentMaxSecretVersion: 7,
  });
  repository.findGrantForPrincipal.mockResolvedValue(null);
  repository.listGrantsForEnvironment.mockResolvedValue([]);
  repository.listPendingKeyGrants.mockResolvedValue([]);
  repository.listSealableServiceTokens.mockResolvedValue([]);
  rotationsCommitted = 0;
  // The double runs the callback, which is the only way this file can observe
  // that the completeness check happens **inside** the rotation's transaction
  // rather than before it. A mock that merely resolved would let the service
  // stop calling it and every test below would still pass.
  //
  // `rotationsCommitted` is incremented only *after* the callback returns, so it
  // counts rotations that would actually have written rows — which is what "the
  // check refused it" now means. Asserting that `rotateEnvDataKey` was never
  // called stopped being the right question the moment the check moved inside
  // it: it is called, and it aborts.
  repository.rotateEnvDataKey.mockImplementation(
    async (_db: unknown, params: { version: number; assertGrantSet: (tx: unknown) => unknown }) => {
      await params.assertGrantSet({});
      rotationsCommitted += 1;
      return { id: KEY_ID, version: params.version };
    },
  );
  repository.addEnvKeyGrants.mockResolvedValue(1);
  repository.queuePendingKeyGrant.mockResolvedValue(true);
  repository.removePendingKeyGrant.mockResolvedValue(false);
  repository.removeMemberGrantsForEnvironment.mockResolvedValue(0);
  // An `admin` invitation with no selection: role defaults everywhere, and
  // `admin` reaches production. The scope under test is production, so this is
  // the fixture that lets an invite grant be *permitted* — which is what the
  // rotation tests below are about. An invitation whose future access does not
  // reach the environment is a separate case, exercised in its own describe.
  repository.findPendingInvitationForGrant.mockResolvedValue({
    id: INVITATION_ID,
    role: 'admin',
    initialGrants: null,
  });
  roster([{ userId: OWNER_ID, role: 'owner' }]);
});

describe('rotation completeness', () => {
  it('accepts a set that matches the authorization model exactly', async () => {
    roster([{ userId: OWNER_ID, role: 'owner' }]);

    const result = await rotateKeys(scope(), services(), ownerPrincipal, {
      newVersion: 2,
      grants: [grant()],
    });

    expect(result.version).toBe(2);
    expect(result.grantCount).toBe(1);
    expect(repository.rotateEnvDataKey).toHaveBeenCalledOnce();
  });

  it('recomputes the required set inside the rotation, never before it', async () => {
    // ── The race this closes ──
    // The check used to run before `rotateEnvDataKey` opened its transaction, and
    // the gap between the two was long enough for a concurrent member removal to
    // land. The rotation then wrote the grant set it had already validated — so
    // the brand-new key was sealed to the person the removal was cutting off, with
    // a 200 and an `envkey.rotated` record saying the revocation had completed.
    //
    // The observable form of the fix: the roster is not read until the repository
    // has been entered. Inside the real transaction that read sits under the
    // organisation lock, which is the same lock every membership and access-grant
    // write takes, so a removal either lands entirely before it or waits.
    const order: string[] = [];

    repository.loadOrganizationAuthorizationContexts.mockImplementation(() => {
      order.push('roster');
      return Promise.resolve([
        {
          orgId: ORG_ID,
          userId: OWNER_ID,
          memberId: OWNER_ID,
          role: 'owner',
          status: 'active',
          grants: [],
        },
      ]);
    });
    repository.rotateEnvDataKey.mockImplementation(
      async (
        _db: unknown,
        params: { version: number; assertGrantSet: (tx: unknown) => unknown },
      ) => {
        order.push('transaction opened');
        await params.assertGrantSet({});
        order.push('grants written');
        return { id: KEY_ID, version: params.version };
      },
    );

    await rotateKeys(scope(), services(), ownerPrincipal, { newVersion: 2, grants: [grant()] });

    expect(order).toEqual(['transaction opened', 'roster', 'grants written']);
  });

  it('aborts the rotation when the roster changed under it', async () => {
    // The same race from the client's side: the set was built from a recipients
    // listing that named the developer, and by the time the transaction reads the
    // roster they are gone. The write must not happen — an extra grant minted
    // through the rotation endpoint is a key handed to somebody the access model
    // no longer permits, recorded as routine maintenance.
    roster([{ userId: OWNER_ID, role: 'owner' }]);

    const error = await rejection(() =>
      rotateKeys(scope(), services(), ownerPrincipal, {
        newVersion: 2,
        grants: [grant(), grant({ id: DEVELOPER_ID })],
      }),
    );

    expect(error.code).toBe('validation_failed');
    expect(rotationsCommitted).toBe(0);
  });

  it('is exhaustive past the page size the roster used to be read with', async () => {
    // ── The finding, at the boundary that produced it ──
    // The required set was computed from `listMembers(..., { pageSize: 200 })`
    // with `hasMore` discarded, so at 201 members the answer stopped being *the
    // set* and became *a page of it*. Everybody past the boundary was absent from
    // the required set: a rotation naming them was refused as surplus, and one
    // omitting them was accepted — silently revoking every member past the two
    // hundredth through the check that exists to prevent silent revocation.
    //
    // 250 rather than a lowered constant, because there is no constant left to
    // lower: the repository reads the roster whole. What this asserts is that the
    // service demands a grant for the 250th member, which the old code could not
    // see at all.
    const members = Array.from({ length: 250 }, (_, index) => ({
      userId: `01930000-0000-7000-8000-${String(index).padStart(12, '0')}`,
      role: 'owner' as const,
    }));
    roster(members);

    const last = members[249]!.userId;

    const error = await rejection(() =>
      rotateKeys(scope(), services(), ownerPrincipal, {
        newVersion: 2,
        // Everybody but the last one — the set a paginated computation would
        // have called complete.
        grants: members.slice(0, 249).map((member) => grant({ id: member.userId })),
      }),
    );

    expect(error.code).toBe('validation_failed');
    expect(error.fields?.[0]?.message).toContain(last);
    expect(rotationsCommitted).toBe(0);
  });

  it('accepts the whole set at that size', async () => {
    const members = Array.from({ length: 250 }, (_, index) => ({
      userId: `01930000-0000-7000-8000-${String(index).padStart(12, '0')}`,
      role: 'owner' as const,
    }));
    roster(members);

    await expect(
      rotateKeys(scope(), services(), ownerPrincipal, {
        newVersion: 2,
        grants: members.map((member) => grant({ id: member.userId })),
      }),
    ).resolves.toMatchObject({ version: 2, grantCount: 250 });
  });

  it('refuses an invite grant for an invitation of another organisation', async () => {
    // The rotate path never ran the recipient check for invite grants: they were
    // filtered out of the surplus comparison and nothing looked at them again. So
    // a rotation could attach this environment's brand-new key to an invitation
    // belonging to somebody else's organisation, and the invitee would open it on
    // acceptance somewhere else entirely.
    repository.findPendingInvitationForGrant.mockResolvedValue(null);

    const error = await rejection(() =>
      rotateKeys(scope(), services(), ownerPrincipal, {
        newVersion: 2,
        grants: [grant(), grant({ kind: 'invite', id: INVITATION_ID })],
      }),
    );

    expect(error.code).toBe('bad_request');
    expect(rotationsCommitted).toBe(0);
  });

  it('refuses an invite grant whose selected access never reaches this environment', async () => {
    // A non-null selection is deny-by-default: every project the organisation
    // has receives an explicit `none` unless it was ticked, and `none` outranks
    // the role default. This invitation selected a different project entirely, so
    // acceptance will grant nothing here — and sealing this environment's key to
    // it would hand the invitee bytes their selection never entitled them to.
    repository.findPendingInvitationForGrant.mockResolvedValue({
      id: INVITATION_ID,
      role: 'admin',
      initialGrants: [{ projectId: OTHER_PROJECT_ID, environmentId: null }],
    });

    const error = await rejection(() =>
      rotateKeys(scope(), services(), ownerPrincipal, {
        newVersion: 2,
        grants: [grant(), grant({ kind: 'invite', id: INVITATION_ID })],
      }),
    );

    expect(error.code).toBe('bad_request');
    expect(rotationsCommitted).toBe(0);
  });

  it('refuses a set missing a member who has access, and names them', async () => {
    // The failure that matters most: a client that quietly omitted somebody
    // would produce a request that succeeds and silently revokes a colleague —
    // they keep read access, keep seeing every secret name, and simply cannot
    // decrypt anything written afterwards.
    roster([
      { userId: OWNER_ID, role: 'owner' },
      { userId: DEVELOPER_ID, role: 'owner' },
    ]);

    const error = await rejection(() =>
      rotateKeys(scope(), services(), ownerPrincipal, {
        newVersion: 2,
        grants: [grant()],
      }),
    );

    expect(error.code).toBe('validation_failed');
    expect(error.fields?.[0]?.message).toContain(DEVELOPER_ID);
    expect(error.fields?.[0]?.message).toContain('Missing a grant');
    // Nothing was written. The check now runs *inside* the rotation transaction,
    // so the repository is entered and then aborts — which is what closes the
    // window a pre-flight check left open, and why the assertion counts commits
    // rather than calls.
    expect(rotationsCommitted).toBe(0);
  });

  it('refuses a set carrying a principal with no access', async () => {
    // The other direction, and the more dangerous one: an extra grant is a key
    // handed to somebody the access model does not permit, minted through the
    // one endpoint whose job is writing grants in bulk. Without this check a
    // rotation would be a way to give a viewer production keys while the audit
    // log recorded routine maintenance.
    roster([{ userId: OWNER_ID, role: 'owner' }]);

    const error = await rejection(() =>
      rotateKeys(scope(), services(), ownerPrincipal, {
        newVersion: 2,
        grants: [grant(), grant({ id: DEVELOPER_ID })],
      }),
    );

    expect(error.code).toBe('validation_failed');
    expect(error.fields?.some((field) => field.message.includes('Unexpected grant'))).toBe(true);
    expect(rotationsCommitted).toBe(0);
  });

  it('requires a grant for every service token that can be sealed to', async () => {
    repository.listSealableServiceTokens.mockResolvedValue([
      { id: TOKEN_ID, publicKey: new Uint8Array(32) },
    ]);

    const error = await rejection(() =>
      rotateKeys(scope(), services(), ownerPrincipal, { newVersion: 2, grants: [grant()] }),
    );

    expect(error.fields?.some((field) => field.message.includes(TOKEN_ID))).toBe(true);
  });

  it('does not require a grant for a token with no keypair', async () => {
    // `listSealableServiceTokens` filters those out, and that filter is the
    // whole point: a token minted before the Phase 4 creation flow has nothing
    // to seal to, so demanding one would block every rotation for ever behind a
    // legacy credential nobody can re-key.
    repository.listSealableServiceTokens.mockResolvedValue([]);

    await expect(
      rotateKeys(scope(), services(), ownerPrincipal, { newVersion: 2, grants: [grant()] }),
    ).resolves.toMatchObject({ version: 2 });
  });

  it('permits an invitation grant without demanding one', async () => {
    // An invitation's grants are sealed to a one-off keypair whose private half
    // exists only in a fragment the server has never seen, so nobody rotating
    // can re-seal to it. Permitted in a set, never required.
    await expect(
      rotateKeys(scope(), services(), ownerPrincipal, {
        newVersion: 2,
        grants: [grant(), grant({ kind: 'invite', id: INVITATION_ID })],
      }),
    ).resolves.toMatchObject({ version: 2 });
  });

  it('refuses a set naming one principal twice', async () => {
    // A duplicate satisfies the set comparison while writing two grants for one
    // principal — which the unique index would then reject mid-transaction,
    // after completeness had already reported success.
    const error = await rejection(() =>
      rotateKeys(scope(), services(), ownerPrincipal, {
        newVersion: 2,
        grants: [grant(), grant()],
      }),
    );

    expect(error.code).toBe('bad_request');
    expect(error.message).toContain('exactly once');
  });

  it('refuses a rotation from a bearer token, which holds no signing key', async () => {
    const error = await rejection(() =>
      rotateKeys(
        scope(),
        services(),
        {
          kind: 'cliToken',
          tokenId: TOKEN_ID,
          tokenName: 'laptop',
          userId: OWNER_ID,
          orgId: ORG_ID,
        },
        { newVersion: 2, grants: [grant()] },
      ),
    );

    expect(error.code).toBe('forbidden');
  });
});

describe('missingGrants — the direction nothing used to report', () => {
  it('names an entitled member who holds no key', async () => {
    // ── The state this makes visible ──
    // `needsRotation` only ever asked "is somebody holding the key who should not
    // be?". The opposite asymmetry is just as real and was invisible from every
    // screen: a member entitled to an environment with no grant on its active key
    // can list every secret name and decrypt none of them. A vault reset produces
    // exactly that for every environment at once, and so does an acceptance whose
    // re-seal never completed — and nothing told the person, an administrator, or
    // the audit log.
    roster([
      { userId: OWNER_ID, role: 'owner' },
      { userId: DEVELOPER_ID, role: 'owner' },
    ]);
    repository.listGrantsForEnvironment.mockResolvedValue([grantRow('member', OWNER_ID)]);

    const state = await environmentKeyState(scope(), services(), ownerPrincipal);

    expect(state.missingGrants).toEqual([{ kind: 'member', id: DEVELOPER_ID }]);
    // And nothing is owed in the other direction: every holder is still entitled.
    expect(state.needsRotation).toBe(false);
  });

  it('names an entitled service token that holds no key', async () => {
    repository.listSealableServiceTokens.mockResolvedValue([
      { id: TOKEN_ID, publicKey: new Uint8Array(32) },
    ]);
    repository.listGrantsForEnvironment.mockResolvedValue([grantRow('member', OWNER_ID)]);

    const state = await environmentKeyState(scope(), services(), ownerPrincipal);

    expect(state.missingGrants).toEqual([{ kind: 'token', id: TOKEN_ID }]);
  });

  it('is empty when everybody entitled holds the active key', async () => {
    repository.listGrantsForEnvironment.mockResolvedValue([grantRow('member', OWNER_ID)]);

    const state = await environmentKeyState(scope(), services(), ownerPrincipal);

    expect(state.missingGrants).toEqual([]);
  });

  it('does not count a grant on a retired key as holding the key', async () => {
    // Which is the whole point of comparing against the *active* version: a
    // member holding only a retired grant reads history and nothing written
    // since, and that is precisely the person a share is owed to.
    repository.listGrantsForEnvironment.mockResolvedValue([
      grantRow('member', OWNER_ID, 'a-retired-key'),
    ]);

    const state = await environmentKeyState(scope(), services(), ownerPrincipal);

    expect(state.missingGrants).toEqual([{ kind: 'member', id: OWNER_ID }]);
  });

  it('withholds both hygiene answers from a caller who cannot act on them', async () => {
    // `null`, not `false`. They name other people, so they are administrative on
    // the same terms as `pendingGrants` — and computing them costs a read of the
    // whole roster, which `POST …/pull` would otherwise pay on every `xecret run`
    // for an answer it can do nothing with.
    const developerScope = scope({ role: 'developer', isProduction: false });

    const state = await environmentKeyState(developerScope, services(), developerPrincipal);

    expect(state.needsRotation).toBeNull();
    expect(state.missingGrants).toBeNull();
    // The roster is not read for them at all — the O(members) scan that used to
    // sit on the pull path is simply not issued.
    expect(repository.loadOrganizationAuthorizationContexts).not.toHaveBeenCalled();
    expect(repository.listGrantsForEnvironment).not.toHaveBeenCalled();
  });
});

describe('needsRotation', () => {
  it('is false when every holder of the active key still has access', async () => {
    repository.listGrantsForEnvironment.mockResolvedValue([grantRow('member', OWNER_ID)]);

    const state = await environmentKeyState(scope(), services(), ownerPrincipal);

    expect(state.needsRotation).toBe(false);
  });

  it('is true while somebody holds the active key who should not', async () => {
    // The honest name for "a grant was deleted and the key they held has not
    // been replaced". Deleting a grant stops a principal being handed the key
    // again; only a rotation stops the key they already have from opening what
    // is written next.
    repository.listGrantsForEnvironment.mockResolvedValue([
      grantRow('member', OWNER_ID),
      grantRow('member', DEVELOPER_ID),
    ]);

    const state = await environmentKeyState(scope(), services(), ownerPrincipal);

    expect(state.needsRotation).toBe(true);
  });

  it('ignores a grant on a retired key version', async () => {
    // History stays readable to whoever held it: a member removed today did not
    // stop having seen yesterday's values. Only the active key decides whether a
    // rotation is owed.
    repository.listGrantsForEnvironment.mockResolvedValue([
      grantRow('member', DEVELOPER_ID, 'a-retired-key'),
    ]);

    const state = await environmentKeyState(scope(), services(), ownerPrincipal);

    expect(state.needsRotation).toBe(false);
  });

  it('does not count an outstanding invitation as a pending revocation', async () => {
    repository.listGrantsForEnvironment.mockResolvedValue([
      grantRow('member', OWNER_ID),
      grantRow('invite', INVITATION_ID),
    ]);

    const state = await environmentKeyState(scope(), services(), ownerPrincipal);

    expect(state.needsRotation).toBe(false);
  });

  it('counts a dead service token still holding the active key', async () => {
    // A revoked or expired token drops out of `listSealableServiceTokens`, so it
    // is no longer *required* — which is the fix for a rotation blocked for ever
    // behind a credential nobody can re-key. Its leftover grant on the active key
    // is still a revocation waiting for its rotation, though: whoever held the
    // token string may have fetched the key while it authenticated. Reporting it
    // is what stops the expiry fix from quietly downgrading a revocation.
    repository.listSealableServiceTokens.mockResolvedValue([]);
    repository.listGrantsForEnvironment.mockResolvedValue([
      grantRow('member', OWNER_ID),
      grantRow('token', TOKEN_ID),
    ]);

    const state = await environmentKeyState(scope(), services(), ownerPrincipal);

    expect(state.needsRotation).toBe(true);
    // And it is not also reported as owed a key — it cannot be sealed to.
    expect(state.missingGrants).toEqual([]);
  });
});

describe('the key state payload', () => {
  it('carries the current max secret version, for the freshness counter', async () => {
    // Groundwork only. ADR 0009 records rollback as an accepted residual risk —
    // a compromised server would simply report a lower number — so what this
    // field buys is that a client-side monotonic counter can be added later
    // without an API change.
    const state = await environmentKeyState(scope(), services(), ownerPrincipal);
    expect(state.currentMaxSecretVersion).toBe(7);
  });

  it('serves the pending queue to an administrator', async () => {
    repository.listPendingKeyGrants.mockResolvedValue([
      {
        id: GRANT_ID,
        environmentId: ENV_ID,
        targetUserId: DEVELOPER_ID,
        requestedBy: OWNER_ID,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);

    const state = await environmentKeyState(scope(), services(), ownerPrincipal);

    expect(state.pendingGrants).toHaveLength(1);
    expect(state.pendingGrants?.[0]?.targetUserId).toBe(DEVELOPER_ID);
  });

  it('withholds it from a caller who may not act on it', async () => {
    // It names other people. A developer learning that "three teammates are
    // waiting for production keys" learns the shape of the team's access
    // without holding any authority over it.
    const developerScope = scope({ role: 'developer', isProduction: false });

    const state = await environmentKeyState(developerScope, services(), developerPrincipal);

    expect(state.pendingGrants).toBeNull();
    // The query is not even issued for them.
    expect(repository.listPendingKeyGrants).not.toHaveBeenCalled();
  });

  it('returns the caller their own grant, stripped of the recipient it names', async () => {
    repository.findGrantForPrincipal.mockResolvedValue(grantRow('member', OWNER_ID));

    const state = await environmentKeyState(scope(), services(), ownerPrincipal);

    expect(state.myGrant).toEqual({
      recipientPublicKey: RECIPIENT_KEY,
      edkSealed: SEALED,
      ehkSealed: SEALED,
      signature: SIGNATURE,
      signedByUserId: OWNER_ID,
    });
  });
});

describe('the authorization matrix around a production key', () => {
  it('denies a developer with production none, on the read path', async () => {
    // Production is deny-by-default for the developer role, so `secret.read`
    // fails — and the key endpoint is gated on exactly that action, because
    // holding an environment's key and reading its values are the same
    // authority.
    const developerScope = scope({ role: 'developer', isProduction: true });

    await expect(
      environmentKeyState(developerScope, services(), developerPrincipal).then(
        () => 'allowed',
        (cause: unknown) => (cause as Error).name,
      ),
    ).resolves.toBe('AuthorizationError');
  });

  it('denies a developer the grant endpoint on production too', async () => {
    // The point of the pairing: there is no path by which somebody denied the
    // values can come to hold the key. `addGrants` is gated on the same action.
    const developerScope = scope({ role: 'developer', isProduction: true });

    await expect(
      addGrants(developerScope, services(), developerPrincipal, {
        envDataKeyId: KEY_ID,
        grants: [grant({ id: DEVELOPER_ID })],
      }).then(
        () => 'allowed',
        (cause: unknown) => (cause as Error).name,
      ),
    ).resolves.toBe('AuthorizationError');

    expect(repository.addEnvKeyGrants).not.toHaveBeenCalled();
  });

  it('refuses a grant to a member who has no access to the environment', async () => {
    // The recipient-side check. Without it, any developer holding a production
    // key could hand it to anybody in the organisation, and production's
    // deny-by-default rule would hold on the routes that read secrets while the
    // key itself circulated freely.
    roster([
      { userId: OWNER_ID, role: 'owner' },
      { userId: DEVELOPER_ID, role: 'developer' },
    ]);

    const error = await rejection(() =>
      addGrants(scope(), services(), ownerPrincipal, {
        envDataKeyId: KEY_ID,
        grants: [grant({ id: DEVELOPER_ID })],
      }),
    );

    expect(error.code).toBe('bad_request');
    expect(error.message).toContain('no access to this environment');
    expect(repository.addEnvKeyGrants).not.toHaveBeenCalled();
  });

  it('refuses a grant to a service token that cannot be sealed to', async () => {
    repository.listSealableServiceTokens.mockResolvedValue([]);

    const error = await rejection(() =>
      addGrants(scope(), services(), ownerPrincipal, {
        envDataKeyId: KEY_ID,
        grants: [grant({ kind: 'token', id: TOKEN_ID })],
      }),
    );

    expect(error.code).toBe('bad_request');
  });

  it('refuses to consume an invitation this account did not accept', async () => {
    // ── The silent denial this closes ──
    // A claim deletes the invitation's sealed grants. Those grants are the only
    // copy of an environment key their holder can reach until they re-seal one,
    // so a member who could name somebody else's invitation could destroy the
    // keys they had not claimed yet — and nobody would notice, because the
    // pending-share fallback would quietly cover for it.
    roster([
      { userId: OWNER_ID, role: 'owner' },
      { userId: DEVELOPER_ID, role: 'developer' },
    ]);
    repository.canClaimInvitationGrants.mockResolvedValue(false);

    const error = await rejection(() =>
      addGrants(scope(), services(), ownerPrincipal, {
        envDataKeyId: KEY_ID,
        grants: [grant({ id: OWNER_ID })],
        claimInvitationId: INVITATION_ID,
      }),
    );

    expect(error.code).toBe('forbidden');
    expect(repository.addEnvKeyGrants).not.toHaveBeenCalled();
  });

  it('passes the claim through to the write that replaces the invitation copy', async () => {
    // The ordering is the fix, and it only means anything inside one
    // transaction: the repository deletes the invite grant in the same statement
    // batch that stores the re-sealed one, so a failure after the insert cannot
    // destroy the only reachable copy of the key.
    roster([{ userId: OWNER_ID, role: 'owner' }]);
    repository.canClaimInvitationGrants.mockResolvedValue(true);
    repository.addEnvKeyGrants.mockResolvedValue(1);

    await addGrants(scope(), services(), ownerPrincipal, {
      envDataKeyId: KEY_ID,
      grants: [grant({ id: OWNER_ID })],
      claimInvitationId: INVITATION_ID,
    });

    expect(repository.canClaimInvitationGrants).toHaveBeenCalledWith(expect.anything(), {
      orgId: ORG_ID,
      invitationId: INVITATION_ID,
      userId: OWNER_ID,
    });
    expect(repository.addEnvKeyGrants).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ claimInvitationId: INVITATION_ID }),
    );
  });

  it('consumes nothing when no invitation is named', async () => {
    roster([{ userId: OWNER_ID, role: 'owner' }]);
    repository.addEnvKeyGrants.mockResolvedValue(1);

    await addGrants(scope(), services(), ownerPrincipal, {
      envDataKeyId: KEY_ID,
      grants: [grant({ id: OWNER_ID })],
    });

    expect(repository.canClaimInvitationGrants).not.toHaveBeenCalled();
    expect(repository.addEnvKeyGrants).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ claimInvitationId: null }),
    );
  });

  it('refuses a grant to an invitation in another organisation', async () => {
    repository.findPendingInvitationForGrant.mockResolvedValue(null);

    const error = await rejection(() =>
      addGrants(scope(), services(), ownerPrincipal, {
        envDataKeyId: KEY_ID,
        grants: [grant({ kind: 'invite', id: INVITATION_ID })],
      }),
    );

    expect(error.code).toBe('bad_request');
  });
});

/**
 * The level an invitation's selection confers, which decides who gets a key.
 *
 * ── The finding these exist for ──
 * `invitationReaches` read the invited *role's* default for any scope the
 * selection named and never looked at the seed's own `accessLevel`. So an
 * invitation seeded `none` for an environment — an inviter deliberately
 * withholding it — passed the eligibility check anyway, and this environment's
 * key was sealed to the invitation. The invitee then joined with no access and
 * a copy of the key they could open through `/api/invitations/claimable`: the
 * routes said no and the bytes were already theirs, which is the one order of
 * events an access model cannot recover from.
 *
 * Nothing tested the level plumbing, so the whole of it passed CI. These are
 * the decision itself, stated as the pair of rules `applyInitialGrants` writes:
 * a seed's level is what it says, and a seed naming an environment outranks the
 * seed naming its project.
 */
describe('the level an invitation seed confers', () => {
  function invitation(
    initialGrants: { projectId: string; environmentId: string | null; accessLevel?: string }[],
    role: 'admin' | 'viewer' = 'admin',
  ) {
    repository.findPendingInvitationForGrant.mockResolvedValue({
      id: INVITATION_ID,
      role,
      initialGrants,
    });
  }

  /** Sealing this environment's key to the invitation. Production by default. */
  function seal(isProduction = true) {
    return addGrants(scope({ isProduction }), services(), ownerPrincipal, {
      envDataKeyId: KEY_ID,
      grants: [grant({ kind: 'invite', id: INVITATION_ID })],
    });
  }

  it('withholds the key from a seed that named this environment at no access', async () => {
    // The finding, at its narrowest. `admin` reaches everything by role, which
    // is exactly why the role default was the wrong thing to read: the inviter
    // said `none` for this one environment and the check said `admin`.
    invitation([{ projectId: PROJECT_ID, environmentId: ENV_ID, accessLevel: 'none' }]);

    const error = await rejection(() => seal());

    expect(error.code).toBe('bad_request');
    expect(repository.addEnvKeyGrants).not.toHaveBeenCalled();
  });

  it('withholds it from a whole-project seed at no access', async () => {
    invitation([{ projectId: PROJECT_ID, environmentId: null, accessLevel: 'none' }]);

    const error = await rejection(() => seal());

    expect(error.code).toBe('bad_request');
  });

  it('lets a named environment deny what its project seed granted', async () => {
    // The precedence rule, in the direction that matters: the two levels are
    // chosen independently, and `resolveAccessLevel` gives the specific row
    // precedence — so an environment carved out of an otherwise-granted project
    // must not receive its key.
    invitation([
      { projectId: PROJECT_ID, environmentId: null, accessLevel: 'admin' },
      { projectId: PROJECT_ID, environmentId: ENV_ID, accessLevel: 'none' },
    ]);

    const error = await rejection(() => seal());

    expect(error.code).toBe('bad_request');
  });

  it('lets a named environment grant what its project seed denied', async () => {
    // And the other way round, which is the ordinary shape: nothing across the
    // project except this one environment.
    invitation([
      { projectId: PROJECT_ID, environmentId: null, accessLevel: 'none' },
      { projectId: PROJECT_ID, environmentId: ENV_ID, accessLevel: 'read' },
    ]);

    await expect(seal()).resolves.toEqual({ added: 1 });
  });

  it('grants at the level the seed names rather than the role default', async () => {
    // A `viewer` has no production access by role — `read` here is the
    // inviter's explicit choice, and the selection of a production environment
    // is the conscious act the model asks for.
    invitation([{ projectId: PROJECT_ID, environmentId: ENV_ID, accessLevel: 'read' }], 'viewer');

    await expect(seal()).resolves.toEqual({ added: 1 });
  });

  it("falls back to the invited role's non-production default for a seed with no level", async () => {
    // Every seed written before the invite dialog offered levels has this
    // shape, and acceptance still reads it the way it always did.
    invitation([{ projectId: PROJECT_ID, environmentId: ENV_ID }], 'viewer');

    await expect(seal()).resolves.toEqual({ added: 1 });
  });

  it('withholds it from a project this invitation never named at all', async () => {
    // Deny-by-default has not moved: a non-null selection means every project
    // not in it receives an explicit `none` at acceptance.
    invitation([{ projectId: OTHER_PROJECT_ID, environmentId: null, accessLevel: 'admin' }]);

    const error = await rejection(() => seal());

    expect(error.code).toBe('bad_request');
  });
});

describe('initialisation', () => {
  it('refuses a first grant addressed to anybody but the creator', async () => {
    // At creation the only principal whose key could have sealed this blob is
    // the creator's own. A grant naming anybody else was fabricated or sealed to
    // a key the creator had no business using.
    const error = await rejection(() =>
      initializeKeys(scope(), services(), ownerPrincipal, {
        grant: grant({ id: DEVELOPER_ID }),
      }),
    );

    expect(error.code).toBe('bad_request');
    expect(repository.initializeEnvironmentKeys).not.toHaveBeenCalled();
  });

  /**
   * The same assertion the *creation* route now makes, exercised directly.
   *
   * ── The finding ──
   * `POST …/environments` writes an environment's first key grant through
   * `createEnvironment` rather than through `initializeKeys`, and it never made
   * this check. `grantSchema` accepts any `recipientKind` and any uuid, and the
   * foreign keys check that a row exists rather than that it belongs to this
   * tenant — so the one endpoint that mints a grant before an environment exists,
   * before any grant of it could be read or revoked or noticed, would seal an
   * organisation's brand-new key to a member of another one, to a service token
   * scoped elsewhere, or to an invitation nobody here issued.
   *
   * One exported assertion, called from both routes, is the only shape in which
   * the two cannot disagree again.
   */
  describe('the first-grant rule, which both creation paths now share', () => {
    it.each([
      ['another member', grant({ id: DEVELOPER_ID })],
      ['a service token', grant({ kind: 'token', id: TOKEN_ID })],
      ['an invitation', grant({ kind: 'invite', id: INVITATION_ID })],
    ])('refuses a first grant addressed to %s', (_name, offered) => {
      expect(() => assertSelfGrant(offered, OWNER_ID)).toThrowError(ApiError);
    });

    it('accepts the creator’s own', () => {
      expect(() => assertSelfGrant(grant({ id: OWNER_ID }), OWNER_ID)).not.toThrow();
    });
  });

  it('refuses to operate on a server-mode environment at all', () => {
    const serverScope = {
      ...scope(),
      environment: { ...scope().environment, encryptionMode: 'server' },
    } as EnvironmentScope;

    // A category error rather than a permission failure or a missing row: the
    // resource exists, the caller may see it, and the request does not apply.
    expect(() => requireE2ee(serverScope)).toThrowError(ApiError);
  });
});

describe('revoking a grant', () => {
  it('answers not found for a grant outside this environment', async () => {
    repository.removeEnvKeyGrant.mockResolvedValue(null);

    const error = await rejection(() => revokeGrant(scope(), services(), ownerPrincipal, GRANT_ID));

    expect(error.code).toBe('not_found');
  });

  it('reports which kind of principal lost the key', async () => {
    repository.removeEnvKeyGrant.mockResolvedValue(grantRow('token', TOKEN_ID));

    const removed = await revokeGrant(scope(), services(), ownerPrincipal, GRANT_ID);

    expect(removed.recipientKind).toBe('token');
  });
});

describe('the pending key-share queue', () => {
  const environment = {
    id: ENV_ID,
    projectId: PROJECT_ID,
    name: 'Production',
    slug: 'production',
    isProduction: false,
    encryptionMode: 'e2ee',
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    project: { id: PROJECT_ID, name: 'API', slug: 'api' },
  };

  beforeEach(() => {
    repository.listEnvironmentsForOrganization.mockResolvedValue([environment]);
    repository.loadMemberKeyPresence.mockResolvedValue({
      granted: new Set<string>(),
      pending: new Set<string>(),
    });
  });

  it('runs the whole reconciliation in one transaction', async () => {
    // ── What a loop of untransacted statements left behind ──
    // Six environments, a failure at the fourth: grants revoked on three, intact
    // on three, and no record anywhere that the act was incomplete. The member
    // could still read half the environments they had been removed from, and the
    // audit log said the removal succeeded.
    //
    // `revokeMemberAccess` takes the same executor for the same reason at a
    // smaller scale: deleting the grants and clearing the queued debt are one
    // act, and separately they can half-happen — leaving an instruction to re-seal
    // a key to somebody who was just cut off.
    const inside: string[] = [];
    const context = services();
    const db = context.db as unknown as { transaction: (run: (tx: unknown) => unknown) => unknown };
    const transaction = vi.fn((run: (tx: unknown) => unknown) => run({}));
    db.transaction = transaction;

    repository.loadAuthorizationContext.mockImplementation(() => {
      inside.push('read');
      return Promise.resolve(null);
    });
    repository.removeMemberGrantsForEnvironment.mockImplementation(() => {
      inside.push('revoke');
      return Promise.resolve(1);
    });

    await reconcileMemberKeyAccess(context, {
      orgId: ORG_ID,
      userId: DEVELOPER_ID,
      actorUserId: OWNER_ID,
    });

    expect(transaction).toHaveBeenCalledOnce();
    // Everything the reconciliation did happened inside it — the reads it decides
    // from as well as the writes, so it cannot decide from one moment and write
    // into another.
    expect(inside).toEqual(['read', 'revoke']);
  });

  it('queues a share when a member gains access without a key', async () => {
    repository.loadAuthorizationContext.mockResolvedValue({
      orgId: ORG_ID,
      userId: DEVELOPER_ID,
      memberId: DEVELOPER_ID,
      role: 'developer',
      status: 'active',
      grants: [],
    });

    const result = await reconcileMemberKeyAccess(services(), {
      orgId: ORG_ID,
      userId: DEVELOPER_ID,
      actorUserId: OWNER_ID,
    });

    expect(result.queued).toEqual([ENV_ID]);
    expect(result.revoked).toEqual([]);
    expect(repository.queuePendingKeyGrant).toHaveBeenCalledOnce();
  });

  it('queues nothing when the member already holds the key', async () => {
    repository.loadAuthorizationContext.mockResolvedValue({
      orgId: ORG_ID,
      userId: DEVELOPER_ID,
      memberId: DEVELOPER_ID,
      role: 'developer',
      status: 'active',
      grants: [],
    });
    repository.loadMemberKeyPresence.mockResolvedValue({
      granted: new Set([ENV_ID]),
      pending: new Set<string>(),
    });

    const result = await reconcileMemberKeyAccess(services(), {
      orgId: ORG_ID,
      userId: DEVELOPER_ID,
      actorUserId: OWNER_ID,
    });

    expect(result.queued).toEqual([]);
    expect(repository.queuePendingKeyGrant).not.toHaveBeenCalled();
  });

  it('queues nothing twice — a repeated call is free, not merely harmless', async () => {
    repository.loadAuthorizationContext.mockResolvedValue({
      orgId: ORG_ID,
      userId: DEVELOPER_ID,
      memberId: DEVELOPER_ID,
      role: 'developer',
      status: 'active',
      grants: [],
    });
    repository.loadMemberKeyPresence.mockResolvedValue({
      granted: new Set<string>(),
      pending: new Set([ENV_ID]),
    });

    const result = await reconcileMemberKeyAccess(services(), {
      orgId: ORG_ID,
      userId: DEVELOPER_ID,
      actorUserId: OWNER_ID,
    });

    expect(result.queued).toEqual([]);
    expect(repository.queuePendingKeyGrant).not.toHaveBeenCalled();
  });

  it('revokes grants and clears the debt when a member loses access', async () => {
    // A removed member resolves to no authorization context, which is a denial
    // everywhere — exactly the answer removal needs.
    repository.loadAuthorizationContext.mockResolvedValue(null);
    repository.removeMemberGrantsForEnvironment.mockResolvedValue(1);

    const result = await reconcileMemberKeyAccess(services(), {
      orgId: ORG_ID,
      userId: DEVELOPER_ID,
      actorUserId: OWNER_ID,
    });

    expect(result.revoked).toEqual([ENV_ID]);
    expect(repository.removePendingKeyGrant).toHaveBeenCalledOnce();
    expect(repository.queuePendingKeyGrant).not.toHaveBeenCalled();
  });

  it('leaves server-mode environments entirely alone', async () => {
    repository.listEnvironmentsForOrganization.mockResolvedValue([
      { ...environment, encryptionMode: 'server' },
    ]);

    const result = await reconcileMemberKeyAccess(services(), {
      orgId: ORG_ID,
      userId: DEVELOPER_ID,
      actorUserId: OWNER_ID,
    });

    expect(result).toEqual({ queued: [], revoked: [] });
    expect(repository.loadAuthorizationContext).not.toHaveBeenCalled();
    expect(repository.removeMemberGrantsForEnvironment).not.toHaveBeenCalled();
  });
});

describe('the client write path', () => {
  /**
   * The id a create carries. Chosen by the client, because the AAD binds it and
   * the ciphertext was sealed against it before the request existed.
   */
  const NEW_SECRET_ID = '01930000-0000-7000-8000-0000000000c1';

  const value = {
    ciphertext: CIPHERTEXT,
    clientAlgorithm: 'xk2.gcm',
    envDataKeyId: KEY_ID,
    valueHmac: HMAC_A,
  };

  beforeEach(() => {
    repository.createSecret.mockResolvedValue({ secret: {}, version: { version: 1 } });
    repository.addSecretVersion.mockResolvedValue({ version: 2 });
  });

  it('stores the blob verbatim and never reaches for an environment key', async () => {
    // The structural property: the client half of `secrets-service.ts` contains
    // no reference to the key hierarchy, so no key chain is ever loaded.
    const result = await writeClientSecretValue(scope(), services(), {
      writer: { userId: OWNER_ID },
      name: 'DATABASE_URL',
      secretId: NEW_SECRET_ID,
      expectedVersion: 1,
      value,
    });

    expect(result.status).toBe('created');
    // The row is written under the client's own id, never one minted in the
    // Worker: a value sealed against an id this process invented would fail to
    // authenticate on its first read, for ever, with nothing saying so.
    expect(result.secretId).toBe(NEW_SECRET_ID);

    const stored = repository.createSecret.mock.calls[0]?.[1] as {
      payload: { mode: string; ciphertext: Uint8Array; clientAlgorithm: string };
      note?: string | null;
    };
    expect(stored.payload.mode).toBe('e2ee');
    expect(new TextDecoder().decode(stored.payload.ciphertext)).toBe(CIPHERTEXT);
    expect(stored.payload.clientAlgorithm).toBe('xk2.gcm');
    // An e2ee secret carries no plaintext note.
    expect(stored.note).toBeUndefined();
  });

  it('detects a no-op write by HMAC equality, exactly as the server path does', async () => {
    const result = await writeClientSecretValue(scope(), services(), {
      writer: { userId: OWNER_ID },
      name: 'DATABASE_URL',
      // Deliberately not the stored id, and deliberately a version nobody could
      // be writing: a matching HMAC stores nothing, so there is no ciphertext
      // whose binding could be wrong and nothing to refuse.
      secretId: NEW_SECRET_ID,
      expectedVersion: 99,
      value,
      existing: {
        secretId: '01930000-0000-7000-8000-0000000000e1',
        version: 4,
        valueHmac: new Uint8Array(32).fill(1),
      },
    });

    expect(result.status).toBe('unchanged');
    // The version is reported unchanged, so a client retrying a request it did
    // not see the answer to gets the truth rather than a phantom bump.
    expect(result.version).toBe(4);
    expect(repository.addSecretVersion).not.toHaveBeenCalled();
  });

  it('appends when the HMAC differs', async () => {
    const result = await writeClientSecretValue(scope(), services(), {
      writer: { userId: OWNER_ID },
      name: 'DATABASE_URL',
      secretId: '01930000-0000-7000-8000-0000000000e1',
      expectedVersion: 2,
      value: { ...value, valueHmac: HMAC_B },
      existing: {
        secretId: '01930000-0000-7000-8000-0000000000e1',
        version: 1,
        valueHmac: new Uint8Array(32).fill(1),
      },
    });

    expect(result.status).toBe('updated');
    expect(result.version).toBe(2);
    expect(repository.addSecretVersion).toHaveBeenCalledOnce();
  });

  it('refuses a value sealed against a key that has since been rotated away', async () => {
    // Stored, it would look exactly like a working row and would open for
    // nobody. A conflict rather than a validation error: the body was correct
    // when the client built it, and the remedy is to re-read and encrypt again.
    const error = await rejection(() =>
      writeClientSecretValue(scope(), services(), {
        writer: { userId: OWNER_ID },
        name: 'DATABASE_URL',
        secretId: NEW_SECRET_ID,
        expectedVersion: 1,
        value: { ...value, envDataKeyId: '01930000-0000-7000-8000-00000000dead' },
      }),
    );

    expect(error.code).toBe('conflict');
    expect(repository.createSecret).not.toHaveBeenCalled();
  });

  it('refuses to write into an environment with no active data key', async () => {
    repository.loadEnvironmentKeyState.mockResolvedValue({
      activeKey: null,
      ehkExists: false,
      currentMaxSecretVersion: 0,
    });

    const error = await rejection(() =>
      writeClientSecretValue(scope(), services(), {
        writer: { userId: OWNER_ID },
        name: 'DATABASE_URL',
        secretId: NEW_SECRET_ID,
        expectedVersion: 1,
        value,
      }),
    );

    // 503, not 500: the deployment is broken rather than the request. And,
    // unlike the server envelope, no operator can repair it — the key only ever
    // existed inside the browser that generated it.
    expect(error.code).toBe('unavailable');
  });

  it('does not read the key state for an empty batch', async () => {
    await expect(
      applyClientSecretWrites(scope(), services(), { writer: { userId: OWNER_ID }, writes: [] }),
    ).resolves.toEqual([]);

    expect(repository.loadEnvironmentKeyState).not.toHaveBeenCalled();
  });

  it('decides every outcome on a dry run without writing anything', async () => {
    const results = await applyClientSecretWrites(scope(), services(), {
      writer: { userId: OWNER_ID },
      dryRun: true,
      writes: [
        { name: 'NEW_ONE', secretId: NEW_SECRET_ID, expectedVersion: 1, value },
        {
          name: 'SAME',
          secretId: '01930000-0000-7000-8000-0000000000e2',
          expectedVersion: 6,
          value,
          existing: {
            secretId: '01930000-0000-7000-8000-0000000000e2',
            version: 5,
            valueHmac: new Uint8Array(32).fill(1),
          },
        },
      ],
    });

    expect(results.map((result) => result.status)).toEqual(['created', 'unchanged']);
    expect(repository.createSecret).not.toHaveBeenCalled();
    expect(repository.addSecretVersion).not.toHaveBeenCalled();
  });

  /**
   * The AAD components the client chose, checked against where the write lands.
   *
   * Every case below would previously have committed with a 200 and produced a
   * row that opens for nobody — permanently, because no operator holds the key
   * and the plaintext existed only in the client that has since moved on.
   */
  describe('the client-write binding', () => {
    it('refuses a version the client did not seal for', async () => {
      // The repro: a version-history drawer left open across a restore. Its
      // snapshot still says version 3, so the second restore seals for 4 — and
      // the row is about to become 5.
      const error = await rejection(() =>
        writeClientSecretValue(scope(), services(), {
          writer: { userId: OWNER_ID },
          name: 'DATABASE_URL',
          secretId: '01930000-0000-7000-8000-0000000000e1',
          expectedVersion: 4,
          value: { ...value, valueHmac: HMAC_B },
          existing: {
            secretId: '01930000-0000-7000-8000-0000000000e1',
            version: 4,
            valueHmac: new Uint8Array(32).fill(1),
          },
        }),
      );

      expect(error.code).toBe('conflict');
      expect(error.message).toContain('version_conflict');
      expect(repository.addSecretVersion).not.toHaveBeenCalled();
    });

    it('refuses an entry that planned a create for a name that already exists', async () => {
      // The repro: a browser that listed only the first 200 names planned a
      // create — fresh uuid, version 1 — for the 201st. The server resolves the
      // stored row instead. Appending under the stored id would store bytes
      // whose AAD names the uuid the client invented.
      const error = await rejection(() =>
        applyClientSecretWrites(scope(), services(), {
          writer: { userId: OWNER_ID },
          writes: [
            {
              name: 'DATABASE_URL',
              secretId: NEW_SECRET_ID,
              expectedVersion: 1,
              value: { ...value, valueHmac: HMAC_B },
              existing: {
                secretId: '01930000-0000-7000-8000-0000000000e1',
                version: 7,
                valueHmac: new Uint8Array(32).fill(1),
              },
            },
          ],
        }),
      );

      expect(error.code).toBe('conflict');
      expect(error.message).toContain('DATABASE_URL');
      expect(repository.createSecret).not.toHaveBeenCalled();
      expect(repository.addSecretVersion).not.toHaveBeenCalled();
    });

    it('refuses before the batch is written, not part-way through it', async () => {
      // Preparation happens for every write before any of them commits, so a
      // bad entry in an import takes nothing with it.
      const error = await rejection(() =>
        applyClientSecretWrites(scope(), services(), {
          writer: { userId: OWNER_ID },
          writes: [
            { name: 'GOOD', secretId: NEW_SECRET_ID, expectedVersion: 1, value },
            { name: 'BAD', secretId: NEW_SECRET_ID, expectedVersion: 3, value },
          ],
        }),
      );

      expect(error.code).toBe('conflict');
      expect(repository.createSecret).not.toHaveBeenCalled();
    });

    it('does not refuse a no-op, whatever it claims to have sealed for', async () => {
      // A matching HMAC stores no ciphertext, so nothing can be bound wrongly.
      // Refusing would turn a harmless re-submission into an error.
      const result = await writeClientSecretValue(scope(), services(), {
        writer: { userId: OWNER_ID },
        name: 'DATABASE_URL',
        secretId: NEW_SECRET_ID,
        expectedVersion: 1,
        value,
        existing: {
          secretId: '01930000-0000-7000-8000-0000000000e1',
          version: 9,
          valueHmac: new Uint8Array(32).fill(1),
        },
      });

      expect(result.status).toBe('unchanged');
    });
  });
});

/**
 * The wire schemas.
 *
 * Every assertion here is about *shape*, and that is the property under test
 * rather than a limitation of it: a length and a prefix are exactly the checks a
 * party with no key can make. What they buy is that a column cannot come to hold
 * something no client will ever parse.
 */
describe('blob validation', () => {
  it('accepts a conforming grant and stores nothing else', () => {
    expect(grantSchema.safeParse(grant()).success).toBe(true);
  });

  it('rejects a sealed blob with the wrong version prefix', () => {
    // A blob written by a future version must fail loudly rather than be misread
    // as this one (spec §2).
    expect(
      grantSchema.safeParse({ ...grant(), edkSealed: `xk3.x25519.${'A'.repeat(123)}` }).success,
    ).toBe(false);
  });

  it('rejects a sealed blob below the format minimum', () => {
    expect(grantSchema.safeParse({ ...grant(), ehkSealed: 'xk2.x25519.AAAA' }).success).toBe(false);
  });

  it('rejects a signature that is not exactly 64 bytes', () => {
    // Unlike a sealed box, a detached Ed25519 signature has no payload that can
    // legitimately vary — anything else is a different construction wearing this
    // tag, or a truncation.
    expect(
      grantSchema.safeParse({ ...grant(), signature: `xk2.ed25519.${'B'.repeat(80)}` }).success,
    ).toBe(false);
  });

  it('rejects base64 padding, which the encoding does not use', () => {
    // Two spellings of one value in the database would make a `bytea` equality
    // lookup miss one of them.
    expect(
      grantSchema.safeParse({ ...grant(), edkSealed: `xk2.x25519.${'A'.repeat(122)}=` }).success,
    ).toBe(false);
  });

  it('rejects an unknown field on a grant', () => {
    expect(grantSchema.safeParse({ ...grant(), signedByUserId: OWNER_ID }).success).toBe(false);
  });

  it('requires the recipient public key the signature binds', () => {
    // Without it the row is not verifiable from itself, and a deferred verifier
    // would have to read the key from a table a vault reset rewrites — which
    // makes every honest pre-reset grant look forged (spec §6.1).
    const withoutKey: Record<string, unknown> = { ...grant() };
    delete withoutKey['recipientPublicKey'];
    expect(grantSchema.safeParse(withoutKey).success).toBe(false);
  });

  it('rejects a 36-character recipient id that is not a UUID', () => {
    // ── The 500 this closes ──
    // The field was validated by length alone, so `------------------------------------`
    // passed the schema, reached a `uuid` column, and PostgreSQL raised 22P02 —
    // which the route wrapper has no reason to recognise, so a malformed request
    // body was answered as a server fault. An alert fires, the caller learns
    // nothing, and the incident is filed against us rather than against the
    // request that caused it.
    expect(grantSchema.safeParse({ ...grant(), recipientId: '-'.repeat(36) }).success).toBe(false);
    expect(
      grantSchema.safeParse({ ...grant(), recipientId: 'not-a-uuid-but-exactly-36-chars-long' })
        .success,
    ).toBe(false);
  });

  it('rejects an uppercase UUID rather than normalising it', () => {
    // Strict on purpose: these ids are compared against database values and bound
    // into AAD, and two spellings of one identifier is how inconsistent-comparison
    // bugs start.
    expect(grantSchema.safeParse({ ...grant(), recipientId: OWNER_ID.toUpperCase() }).success).toBe(
      false,
    );
  });

  it('applies the same rule to the key id a grant set names', () => {
    expect(
      environmentKeyGrantsSchema.safeParse({ envDataKeyId: '-'.repeat(36), grants: [grant()] })
        .success,
    ).toBe(false);
    expect(
      environmentKeyGrantsSchema.safeParse({ envDataKeyId: KEY_ID, grants: [grant()] }).success,
    ).toBe(true);
  });

  it('rejects a recipient public key that is not 32 bytes', () => {
    expect(
      grantSchema.safeParse({ ...grant(), recipientPublicKey: toBase64Url(new Uint8Array(31)) })
        .success,
    ).toBe(false);
  });

  it('requires a rotation to start at version 2 or above', () => {
    // Version 1 is initialisation, which is a different endpoint with different
    // semantics — a rotation that claimed to produce version 1 would be asking
    // to replace a key that has values under it.
    expect(environmentKeyRotateSchema.safeParse({ newVersion: 1, grants: [grant()] }).success).toBe(
      false,
    );
    expect(environmentKeyRotateSchema.safeParse({ newVersion: 2, grants: [grant()] }).success).toBe(
      true,
    );
  });

  it('refuses an empty grant set on either key endpoint', () => {
    expect(environmentKeyRotateSchema.safeParse({ newVersion: 2, grants: [] }).success).toBe(false);
    expect(environmentKeyGrantsSchema.safeParse({ envDataKeyId: KEY_ID, grants: [] }).success).toBe(
      false,
    );
  });

  it('requires a value HMAC on every client write', () => {
    // It is what decides whether a write appends a version. A client that
    // omitted it would silently turn every re-submission of an unchanged value
    // into a rotation, filling the history with no-op bumps.
    const body = {
      name: 'DATABASE_URL',
      value: { ciphertext: CIPHERTEXT, clientAlgorithm: 'xk2.gcm', envDataKeyId: KEY_ID },
    };
    expect(createClientSecretBody.safeParse(body).success).toBe(false);
  });

  it('rejects a plaintext value sent to a client-encrypted endpoint', () => {
    // The mistake that matters: it would put a credential in a request body the
    // whole design exists to keep it out of. Refused at the boundary, before the
    // value is read.
    expect(
      updateClientSecretBody.safeParse({ value: 'postgres://user:hunter2@db/app' }).success,
    ).toBe(false);
  });

  it('accepts a well-formed client update', () => {
    expect(
      updateClientSecretBody.safeParse({
        expectedVersion: 2,
        value: {
          ciphertext: CIPHERTEXT,
          clientAlgorithm: 'xk2.gcm',
          envDataKeyId: KEY_ID,
          valueHmac: HMAC_A,
        },
      }).success,
    ).toBe(true);
  });

  it('requires a client update to state the version it sealed for', () => {
    // Without it the server derives a version the ciphertext was never bound to
    // whenever anything else has been written in between, and the row is lost
    // behind a 200.
    expect(
      updateClientSecretBody.safeParse({
        value: {
          ciphertext: CIPHERTEXT,
          clientAlgorithm: 'xk2.gcm',
          envDataKeyId: KEY_ID,
          valueHmac: HMAC_A,
        },
      }).success,
    ).toBe(false);
  });
});

describe('a client import that names one secret twice', () => {
  it('is caught in the body, naming the entry', () => {
    // ── What used to happen instead ──
    // Both entries resolved to the same stored row, so both planned version N+1.
    // The first append landed at N+1; the second landed at N+2 carrying a
    // ciphertext bound to N+1, and `commitClientWrites` rolled the entire
    // transaction back with "This secret was changed by another request." Nothing
    // else had changed it, the import wrote nothing, and the message sent
    // somebody hunting a concurrent editor who did not exist.
    expect(
      duplicateEntryName([{ name: 'API_KEY' }, { name: 'DATABASE_URL' }, { name: 'API_KEY' }]),
    ).toBe('API_KEY');
  });

  it('says nothing about a body whose names are all distinct', () => {
    expect(duplicateEntryName([{ name: 'A' }, { name: 'B' }, { name: 'C' }])).toBeNull();
    expect(duplicateEntryName([])).toBeNull();
  });

  it('compares names exactly, as the unique index does', () => {
    // `secrets_env_name_idx` is on the name as stored, and the two spellings are
    // two secrets. Folding case here would refuse a body the database accepts.
    expect(duplicateEntryName([{ name: 'API_KEY' }, { name: 'api_key' }])).toBeNull();
  });
});

/** Kept honest: the fixtures above must satisfy the schemas they stand in for. */
describe('the fixtures themselves', () => {
  it('uses blobs the API would actually accept', () => {
    expect(grantSchema.safeParse(grant()).success).toBe(true);
    expect(requireSealingUser(ownerPrincipal)).toBe(OWNER_ID);
  });

  it('never puts a plaintext value anywhere near a client payload', () => {
    // The promise test, at the level this file can check it: a material handed
    // to the client serialiser carries a blob and a key id, and there is no
    // field on it a plaintext could occupy.
    const material: Partial<SecretMaterial> = {
      clientValue: { ciphertext: new TextEncoder().encode(CIPHERTEXT), clientAlgorithm: 'xk2.gcm' },
      envDataKeyId: KEY_ID,
    };

    expect(Object.keys(material)).not.toContain('value');
    expect(Object.keys(material)).not.toContain('plaintext');
  });
});

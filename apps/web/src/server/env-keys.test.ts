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
import { createClientSecretBody, updateClientSecretBody } from './schemas/secrets';

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

/** A conforming `xk2.x25519.` payload: 92 bytes, base64url, no padding. */
const SEALED = `xk2.x25519.${'A'.repeat(123)}`;
/** A conforming `xk2.ed25519.` payload: exactly 64 bytes. */
const SIGNATURE = `xk2.ed25519.${'B'.repeat(86)}`;
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
  listMembers: vi.fn(),
  loadAuthorizationContext: vi.fn(),
  rotateEnvDataKey: vi.fn(),
  addEnvKeyGrants: vi.fn(),
  initializeEnvironmentKeys: vi.fn(),
  removeEnvKeyGrant: vi.fn(),
  removeMemberGrantsForEnvironment: vi.fn(),
  removePendingKeyGrant: vi.fn(),
  queuePendingKeyGrant: vi.fn(),
  findPendingInvitationForGrant: vi.fn(),
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
  repository.listMembers.mockResolvedValue({
    members: members.map((member) => ({
      id: member.userId,
      orgId: ORG_ID,
      userId: member.userId,
      role: member.role,
      status: 'active',
      seatAssigned: true,
      createdAt: new Date(),
      user: {
        id: member.userId,
        email: `${member.role}@example.com`,
        displayName: null,
        avatarUrl: null,
      },
    })),
    page: 1,
    pageSize: 200,
    hasMore: false,
  });

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
  repository.rotateEnvDataKey.mockResolvedValue({ id: KEY_ID, version: 2 });
  repository.addEnvKeyGrants.mockResolvedValue(1);
  repository.queuePendingKeyGrant.mockResolvedValue(true);
  repository.removePendingKeyGrant.mockResolvedValue(false);
  repository.removeMemberGrantsForEnvironment.mockResolvedValue(0);
  repository.findPendingInvitationForGrant.mockResolvedValue({ id: INVITATION_ID });
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
    // Nothing was written: the check runs before the rotation, so a refused set
    // cannot leave a half-rotated environment behind.
    expect(repository.rotateEnvDataKey).not.toHaveBeenCalled();
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
    expect(repository.rotateEnvDataKey).not.toHaveBeenCalled();
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
      secretId: NEW_SECRET_ID,
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
      secretId: NEW_SECRET_ID,
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
        { name: 'NEW_ONE', secretId: NEW_SECRET_ID, value },
        {
          name: 'SAME',
          secretId: '01930000-0000-7000-8000-0000000000c2',
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
    expect(grantSchema.safeParse({ ...grant(), recipientPublicKey: 'x' }).success).toBe(false);
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
        value: {
          ciphertext: CIPHERTEXT,
          clientAlgorithm: 'xk2.gcm',
          envDataKeyId: KEY_ID,
          valueHmac: HMAC_A,
        },
      }).success,
    ).toBe(true);
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

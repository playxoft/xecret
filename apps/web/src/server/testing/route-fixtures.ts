import { toBase64Url } from '@xecret/core/crypto';
import type { EnvelopeService } from '@xecret/core/crypto';
import type { DeclaredReference } from '@xecret/core/references';
import type { Database } from '@xecret/db';
import { createSecret } from '@xecret/db/repositories';
import type { Principal } from '../actor';

/**
 * The parts of `@xecret/db/testing`'s `TestDatabase` this module uses, stated
 * structurally: the test-database package is importable from `*.test.ts` files
 * only, and a suite hands its own instance in.
 */
export interface SeedDatabase {
  db: Database;
  pg: { query: (sql: string, params?: unknown[]) => Promise<unknown> };
}

/**
 * Rows and requests for the PGlite route suites of the P19 features — the seeding
 * every one of them needs, written once. Test support only: nothing in the
 * application imports this module.
 *
 * Each suite still declares its own `vi.mock`s (they are hoisted per file) and
 * hands this module its database, its envelope and the list its mocked
 * `waitUntil` pushes to.
 */

export const ORIGIN = 'https://xecret.test';
export const HMAC = 'A'.repeat(43);

/** A shape-valid `xk2.gcm.` blob. The server cannot open one, and never tries. */
export function blob(label: string): string {
  return `xk2.gcm.${toBase64Url(new TextEncoder().encode(label.padEnd(48, '.')))}`;
}

/** A shape-valid `xk2.x25519.` sealed box. */
export function sealed(label: string): string {
  return `xk2.x25519.${toBase64Url(new TextEncoder().encode(label.padEnd(72, '.')))}`;
}

export interface User {
  id: string;
  email: string;
}

export type Plan = 'free' | 'pro' | 'team';

export interface Org {
  orgId: string;
  slug: string;
  owner: User;
  orgKeyId: string | null;
}

export interface Env {
  id: string;
  keyId: string;
  slug: string;
}

export interface Answer<Body> {
  status: number;
  body: Body;
  headers: Headers;
  text: string;
}

type Handler = (request: Request, args?: { params?: Promise<never> }) => Promise<Response>;

export function routeFixtures(options: {
  t: () => SeedDatabase;
  envelope?: () => EnvelopeService;
  deferred: () => Promise<unknown>[];
}) {
  const db = () => options.t();
  const orgKeys = new Map<string, Awaited<ReturnType<EnvelopeService['createOrgKey']>>>();

  async function seedUser(): Promise<User> {
    const id = crypto.randomUUID();
    const email = `p19-${id.slice(0, 8)}@example.com`;
    await db().pg.query(
      `insert into users (id, workos_user_id, email, email_verified) values ($1, $2, $3, true)`,
      [id, `user_${id.slice(0, 8)}`, email],
    );
    return { id, email };
  }

  function sessionOf(user: User): Principal {
    return {
      kind: 'user',
      sessionId: crypto.randomUUID(),
      user: {
        id: user.id,
        email: user.email,
        emailVerified: true,
        displayName: null,
        avatarUrl: null,
      },
      vaultUnlockedAt: new Date(),
      lastSeenAt: new Date(),
      vaultAutoLockMinutes: null,
      signIn: { method: 'password', ssoWorkosOrgId: null },
    };
  }

  function cliTokenOf(user: User, orgId: string): Principal {
    return {
      kind: 'cliToken',
      tokenId: crypto.randomUUID(),
      tokenName: 'laptop',
      userId: user.id,
      orgId,
      signIn: { method: 'password', ssoWorkosOrgId: null },
    };
  }

  async function setPlan(orgId: string, plan: Plan): Promise<void> {
    await db().pg.query(
      `insert into org_subscriptions (org_id, plan, billing_interval) values ($1, $2, $3)
       on conflict (org_id) do update set plan = excluded.plan, billing_interval = excluded.billing_interval`,
      [orgId, plan, plan === 'free' ? null : 'monthly'],
    );
  }

  async function addMember(orgId: string, userId: string, role: string): Promise<void> {
    await db().pg.query(
      `insert into org_members (id, org_id, user_id, role) values ($1, $2, $3, $4)`,
      [crypto.randomUUID(), orgId, userId, role],
    );
  }

  async function seedOrg(plan: Plan): Promise<Org> {
    const owner = await seedUser();
    const orgId = crypto.randomUUID();
    const slug = `org-${orgId.slice(0, 8)}`;
    await db().pg.query(
      `insert into organizations (id, name, slug, created_by) values ($1, 'Acme', $2, $3)`,
      [orgId, slug, owner.id],
    );
    if (plan !== 'free') await setPlan(orgId, plan);
    await addMember(orgId, owner.id, 'owner');
    return { orgId, slug, owner, orgKeyId: null };
  }

  async function seedMember(org: Org, role: string): Promise<User> {
    const user = await seedUser();
    await addMember(org.orgId, user.id, role);
    return user;
  }

  async function seedProject(org: Org, slug = 'api'): Promise<string> {
    const id = crypto.randomUUID();
    await db().pg.query(
      `insert into projects (id, org_id, name, slug, created_by) values ($1, $2, $3, $4, $5)`,
      [id, org.orgId, slug, slug, org.owner.id],
    );
    return id;
  }

  async function grantTo(
    env: Env,
    recipient: { memberUserId?: string; serviceTokenId?: string },
    signer: string,
  ): Promise<void> {
    await db().pg.query(
      `insert into env_key_grants (id, env_data_key_id, member_user_id, service_token_id, edk_sealed, ehk_sealed, recipient_public_key, signature, signed_by_user_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        crypto.randomUUID(),
        env.keyId,
        recipient.memberUserId ?? null,
        recipient.serviceTokenId ?? null,
        new TextEncoder().encode(`xk2.x25519.${'A'.repeat(80)}`),
        new TextEncoder().encode(`xk2.x25519.${'A'.repeat(80)}`),
        new Uint8Array(32),
        new TextEncoder().encode(`xk2.ed25519.${'A'.repeat(86)}`),
        signer,
      ],
    );
  }

  /**
   * An environment. `e2ee` (the default) gets an active data key and a grant for
   * the owner; `server` gets the organisation's master key and a data key under
   * it, through the real envelope, so the server can encrypt and decrypt.
   */
  async function seedEnv(
    org: Org,
    projectId: string,
    slug: string,
    settings: { production?: boolean; mode?: 'e2ee' | 'server'; parentId?: string } = {},
  ): Promise<Env> {
    const id = crypto.randomUUID();
    const keyId = crypto.randomUUID();
    const mode = settings.mode ?? 'e2ee';
    await db().pg.query(
      `insert into environments (id, project_id, name, slug, encryption_mode, is_production, parent_environment_id)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [id, projectId, slug, slug, mode, settings.production ?? false, settings.parentId ?? null],
    );

    if (mode === 'e2ee') {
      await db().pg.query(
        `insert into env_data_keys (id, environment_id, version, status, created_by) values ($1, $2, 1, 'active', $3)`,
        [keyId, id, org.owner.id],
      );
      const env = { id, keyId, slug };
      await grantTo(env, { memberUserId: org.owner.id }, org.owner.id);
      return env;
    }

    if (options.envelope === undefined)
      throw new Error('a server-mode environment needs an envelope');
    const envelope = options.envelope();
    if (org.orgKeyId === null) {
      const orgKey = await envelope.createOrgKey(org.orgId);
      org.orgKeyId = crypto.randomUUID();
      await db().pg.query(
        `insert into org_keys (id, org_id, version, wrapped_key, wrap_iv, root_key_version) values ($1, $2, 1, $3, $4, $5)`,
        [org.orgKeyId, org.orgId, orgKey.ciphertext, orgKey.iv, orgKey.rootKeyVersion],
      );
      orgKeys.set(org.orgId, orgKey);
    }
    const orgKey = orgKeys.get(org.orgId);
    if (orgKey === undefined) throw new Error('organisation key not seeded by this suite');
    const envKey = await envelope.createEnvKey({ orgId: org.orgId, environmentId: id, orgKey });
    await db().pg.query(
      `insert into env_keys (id, environment_id, org_key_id, version, wrapped_key, wrap_iv) values ($1, $2, $3, 1, $4, $5)`,
      [keyId, id, org.orgKeyId, envKey.ciphertext, envKey.iv],
    );
    return { id, keyId, slug };
  }

  /** A current e2ee secret, written straight to the repository. Returns its id. */
  async function seedSecret(
    org: Org,
    env: Env,
    name: string,
    settings: {
      label?: string;
      hmac?: Uint8Array;
      references?: DeclaredReference[] | null;
      writer?: string;
    } = {},
  ): Promise<string> {
    const id = crypto.randomUUID();
    await createSecret(db().db, {
      id,
      orgId: org.orgId,
      environmentId: env.id,
      name,
      valueType: settings.references ? 'template' : 'string',
      payload: {
        mode: 'e2ee',
        envDataKeyId: env.keyId,
        ciphertext: new TextEncoder().encode(blob(settings.label ?? name)),
        clientAlgorithm: 'xk2.gcm',
      },
      valueHmac: settings.hmac ?? new Uint8Array(32),
      declaredReferences: settings.references ?? null,
      writer: { userId: settings.writer ?? org.owner.id },
    });
    return id;
  }

  async function seedServiceToken(org: Org, projectId: string, env: Env): Promise<Principal> {
    const tokenId = crypto.randomUUID();
    await db().pg.query(
      `insert into service_tokens (id, org_id, project_id, environment_id, name, token_hash, token_prefix, created_by, public_key, key_algorithm)
       values ($1, $2, $3, $4, 'ci', $5, 'xst_x', $6, $7, 'X25519')`,
      [
        tokenId,
        org.orgId,
        projectId,
        env.id,
        new TextEncoder().encode(tokenId),
        org.owner.id,
        new Uint8Array(32),
      ],
    );
    await grantTo(env, { serviceTokenId: tokenId }, org.owner.id);
    return {
      kind: 'serviceToken',
      tokenId,
      tokenName: 'ci',
      orgId: org.orgId,
      projectId,
      environmentId: env.id,
      accessLevel: 'write',
    };
  }

  async function call<Body>(
    handler: Handler,
    method: string,
    path: string,
    params: Record<string, string>,
    body?: unknown,
  ): Promise<Answer<Body>> {
    const response = await handler(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      { params: Promise.resolve(params) as Promise<never> },
    );
    await Promise.allSettled(options.deferred());
    const text = await response.text();
    let parsed = {} as Body;
    try {
      if (text !== '') parsed = JSON.parse(text) as Body;
    } catch {
      // A rendered document, not JSON.
    }
    return { status: response.status, body: parsed, headers: response.headers, text };
  }

  function envPath(org: Org, env: string, rest = '', project = 'api') {
    return {
      path: `/api/orgs/${org.slug}/projects/${project}/environments/${env}${rest}`,
      params: { orgSlug: org.slug, projectSlug: project, envSlug: env },
    };
  }

  return {
    seedUser,
    sessionOf,
    cliTokenOf,
    setPlan,
    addMember,
    seedOrg,
    seedMember,
    seedProject,
    grantTo,
    seedEnv,
    seedSecret,
    seedServiceToken,
    call,
    envPath,
  };
}

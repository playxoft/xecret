import { describe, expect, it, vi } from 'vitest';
import { WorkOS } from '@workos-inc/node';
import { IdentityVerificationError, isWorkosIdentity } from '@xecret/core/auth';
import type { Bindings } from './bindings';
import { MissingBindingError } from './bindings';
import {
  callbackUrl,
  IdentityProviderUnavailableError,
  MAX_CODE_LENGTH,
  providerFailure,
  resetWorkosClientForTesting,
  workosProvider,
  WorkosIdentityProvider,
} from './workos';
import type { WorkosApi } from './workos';

/**
 * The WorkOS provider against a stubbed client.
 *
 * What is under test is everything xecret does with a WorkOS answer — mapping
 * the user onto an identity, minting the brand the linking pass insists on,
 * refusing malformed codes before they are forwarded, and sorting failures into
 * "it said no" and "it could not be asked". Whether WorkOS itself verifies a code
 * correctly is WorkOS's business; the authorization URL is built by the real SDK
 * (it is a pure function of its inputs), so its parameters are checked as
 * WorkOS will read them.
 */

const CONFIG = {
  clientId: 'client_01TESTCLIENT',
  redirectUri: 'https://xecret.playxoft.com/api/auth/callback',
};

const CONTEXT = { codeVerifier: 'v'.repeat(43), ipAddress: '203.0.113.5', userAgent: 'vitest' };

const realSdk = new WorkOS('sk_test_not_a_real_key', { clientId: CONFIG.clientId });

function user(over: Record<string, unknown> = {}) {
  return {
    object: 'user',
    id: 'user_01HZXK9P3Q',
    email: 'alice@bigcorp.example',
    emailVerified: true,
    firstName: 'Alice',
    lastName: 'Liddell',
    profilePictureUrl: 'https://example.test/alice.png',
    name: null,
    lastSignInAt: null,
    locale: null,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    externalId: null,
    metadata: {},
    ...over,
  };
}

function stubApi(over: Partial<Record<string, unknown>> = {}) {
  const calls = {
    authenticateWithCode: vi.fn(async () => ({
      user: user(),
      accessToken: 'at',
      refreshToken: 'rt',
    })),
    createMagicAuth: vi.fn(async () => ({
      object: 'magic_auth',
      id: 'magic_auth_01',
      userId: 'user_01HZXK9P3Q',
      email: 'alice@bigcorp.example',
      code: '123456',
      expiresAt: '2026-10-12T10:10:00Z',
      createdAt: '2026-10-12T10:00:00Z',
      updatedAt: '2026-10-12T10:00:00Z',
    })),
    authenticateWithMagicAuth: vi.fn(async () => ({
      user: user(),
      accessToken: 'at',
      refreshToken: 'rt',
      authenticationMethod: 'MagicAuth',
    })),
    getOrganization: vi.fn(async () => ({
      id: 'org_01BIGCORP',
      domains: [
        { domain: 'BigCorp.example', state: 'verified' },
        { domain: 'pending.example', state: 'pending' },
        { domain: 'failed.example', state: 'failed' },
      ],
    })),
    ...over,
  };

  const api = {
    userManagement: {
      getAuthorizationUrl: (
        options: Parameters<WorkOS['userManagement']['getAuthorizationUrl']>[0],
      ) => realSdk.userManagement.getAuthorizationUrl(options),
      authenticateWithCode: calls.authenticateWithCode,
      createMagicAuth: calls.createMagicAuth,
      authenticateWithMagicAuth: calls.authenticateWithMagicAuth,
    },
    organizations: { getOrganization: calls.getOrganization, createOrganization: vi.fn() },
    adminPortal: { generateLink: vi.fn() },
    sso: { listConnections: vi.fn() },
  } as unknown as WorkosApi;

  return { api, calls, provider: new WorkosIdentityProvider(api, CONFIG) };
}

function failure(status: number | undefined, fields: Record<string, unknown> = {}) {
  return Object.assign(new Error('workos said no'), status === undefined ? {} : { status }, fields);
}

describe('the authorization URL', () => {
  const challenge = 'c'.repeat(43);

  function params(url: string) {
    return new URL(url).searchParams;
  }

  it('names AuthKit, this client, the derived redirect, the state and an S256 challenge', () => {
    const { provider } = stubApi();

    const url = provider.authorizationUrl({ state: 'the-state', codeChallenge: challenge });
    const query = params(url);

    expect(new URL(url).origin).toBe('https://api.workos.com');
    expect(query.get('provider')).toBe('authkit');
    expect(query.get('client_id')).toBe(CONFIG.clientId);
    expect(query.get('redirect_uri')).toBe(CONFIG.redirectUri);
    expect(query.get('response_type')).toBe('code');
    expect(query.get('state')).toBe('the-state');
    expect(query.get('code_challenge')).toBe(challenge);
    expect(query.get('code_challenge_method')).toBe('S256');
    expect(query.has('max_age')).toBe(false);
    expect(query.has('organization_id')).toBe(false);
  });

  it('asks for the credential again for a re-authentication', () => {
    const { provider } = stubApi();

    const url = provider.authorizationUrl({ state: 's', codeChallenge: challenge, maxAge: 0 });

    expect(params(url).get('max_age')).toBe('0');
  });

  it('deep-links an organisation’s SSO instead of naming the provider', () => {
    const { provider } = stubApi();

    const query = params(
      provider.authorizationUrl({
        state: 's',
        codeChallenge: challenge,
        organizationId: 'org_01BIGCORP',
      }),
    );

    expect(query.get('organization_id')).toBe('org_01BIGCORP');
    expect(query.has('provider')).toBe(false);
  });

  it('opens on the sign-up screen when asked', () => {
    const { provider } = stubApi();

    const query = params(
      provider.authorizationUrl({ state: 's', codeChallenge: challenge, screenHint: 'sign-up' }),
    );

    expect(query.get('screen_hint')).toBe('sign-up');
  });

  it('derives the redirect from the public origin, so the two cannot drift', () => {
    expect(callbackUrl({ XECRET_PUBLIC_URL: 'http://localhost:3030' } as unknown as Bindings)).toBe(
      'http://localhost:3030/api/auth/callback',
    );
  });
});

describe('the code exchange', () => {
  it('maps the WorkOS user onto an identity, minted once with the WorkOS brand', async () => {
    const { provider, calls } = stubApi();

    const exchange = await provider.exchangeCode('01HZXCODE', CONTEXT);

    expect(exchange.identity).toMatchObject({
      subject: 'user_01HZXK9P3Q',
      email: 'alice@bigcorp.example',
      emailVerified: true,
      displayName: 'Alice Liddell',
      avatarUrl: 'https://example.test/alice.png',
      provider: 'workos',
    });
    // The linking pass refuses anything `workosIdentity()` did not mint.
    expect(isWorkosIdentity(exchange.identity)).toBe(true);
    expect(Object.isFrozen(exchange.identity)).toBe(true);
    expect(calls.authenticateWithCode).toHaveBeenCalledWith({
      clientId: CONFIG.clientId,
      code: '01HZXCODE',
      codeVerifier: CONTEXT.codeVerifier,
      ipAddress: CONTEXT.ipAddress,
      userAgent: CONTEXT.userAgent,
    });
  });

  it('stamps authTime with the moment of the exchange', async () => {
    const { provider } = stubApi();
    const before = Math.floor(Date.now() / 1000);

    const { identity } = await provider.exchangeCode('code', CONTEXT);

    expect(identity.authTime).toBeGreaterThanOrEqual(before);
    expect(identity.authTime).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });

  it('carries the organisation, the method and the impersonator, and nothing else', async () => {
    const { provider } = stubApi({
      authenticateWithCode: vi.fn(async () => ({
        user: user(),
        organizationId: 'org_01BIGCORP',
        authenticationMethod: 'SSO',
        impersonator: { email: 'support@workos.example', reason: 'debugging' },
        accessToken: 'at',
        refreshToken: 'rt',
        sealedSession: 'sealed',
      })),
    });

    const exchange = await provider.exchangeCode('code', CONTEXT);

    expect(exchange.organizationId).toBe('org_01BIGCORP');
    expect(exchange.authenticationMethod).toBe('SSO');
    expect(exchange.impersonator).toEqual({ email: 'support@workos.example' });
    // The WorkOS tokens are dropped: xecret's own session is the credential.
    expect(JSON.stringify(exchange)).not.toContain('"at"');
    expect(JSON.stringify(exchange)).not.toContain('sealed');
  });

  it('reports an absent organisation, method and impersonator as null', async () => {
    const { provider } = stubApi();

    const exchange = await provider.exchangeCode('code', CONTEXT);

    expect(exchange.organizationId).toBeNull();
    expect(exchange.authenticationMethod).toBeNull();
    expect(exchange.impersonator).toBeNull();
  });

  it('passes an unverified address through as unverified, for the callback to refuse', async () => {
    const { provider } = stubApi({
      authenticateWithCode: vi.fn(async () => ({ user: user({ emailVerified: false }) })),
    });

    expect((await provider.exchangeCode('code', CONTEXT)).identity.emailVerified).toBe(false);
  });

  it('leaves absent profile fields undefined rather than inventing them', async () => {
    const { provider } = stubApi({
      authenticateWithCode: vi.fn(async () => ({
        user: user({ firstName: null, lastName: '  ', profilePictureUrl: null }),
      })),
    });

    const { identity } = await provider.exchangeCode('code', CONTEXT);

    // A blank last name does not become "Alice " or " ": the name is absent.
    expect(identity.displayName).toBeUndefined();
    expect(identity.avatarUrl).toBeUndefined();
  });

  it('refuses a user with no email, which has no account to attach to', async () => {
    const { provider } = stubApi({
      authenticateWithCode: vi.fn(async () => ({ user: user({ email: '' }) })),
    });

    await expect(provider.exchangeCode('code', CONTEXT)).rejects.toMatchObject({
      reason: 'no-email',
    });
  });

  it('refuses a subject that is not a WorkOS user id', async () => {
    const { provider } = stubApi({
      authenticateWithCode: vi.fn(async () => ({
        user: user({ id: 'Xk3pQ9mZ2vB7nR4tY6wL8sD1fG0h' }),
      })),
    });

    await expect(provider.exchangeCode('code', CONTEXT)).rejects.toBeInstanceOf(
      IdentityVerificationError,
    );
  });

  it.each([
    ['empty', ''],
    ['oversized', 'x'.repeat(MAX_CODE_LENGTH + 1)],
    ['carrying a space', 'abc def'],
    ['carrying a slash', 'abc/def'],
    ['carrying a newline', 'abc\ndef'],
  ])('refuses an %s code before forwarding it anywhere', async (_label, code) => {
    const { provider, calls } = stubApi();

    await expect(provider.exchangeCode(code, CONTEXT)).rejects.toMatchObject({
      reason: 'malformed-code',
    });
    expect(calls.authenticateWithCode).not.toHaveBeenCalled();
  });
});

describe('failure categories', () => {
  it.each([
    [
      'an expired or replayed code (invalid_grant)',
      failure(400, { error: 'invalid_grant' }),
      'invalid_grant',
    ],
    ['a 422 with a code', failure(422, { code: 'invalid_code' }), 'invalid_code'],
    ['a bare 404', failure(404), 'http-404'],
    ['a code that would smuggle log syntax', failure(400, { error: 'bad"} {evil' }), 'badevil'],
  ])('reports %s as a verification failure, by category', async (_label, cause, reason) => {
    const { provider } = stubApi({
      authenticateWithCode: vi.fn(async () => Promise.reject(cause)),
    });

    const error = await provider.exchangeCode('code', CONTEXT).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(IdentityVerificationError);
    expect(error).toMatchObject({ reason, message: 'Identity verification failed' });
  });

  it.each([
    ['a refused API key', failure(401), 'misconfigured'],
    ['a forbidden API key', failure(403), 'misconfigured'],
    ['a rate limit', failure(429), 'rate-limited'],
    ['a server error', failure(502), 'unreachable'],
    ['a network failure', new TypeError('fetch failed'), 'unreachable'],
    [
      'an authentication method switched off in the dashboard',
      failure(400, { error: 'authentication_method_not_allowed' }),
      'misconfigured',
    ],
  ])(
    'reports %s as the provider being unavailable, not as the person’s fault',
    async (_label, cause, reason) => {
      const { provider } = stubApi({
        authenticateWithCode: vi.fn(async () => Promise.reject(cause)),
      });

      const error = await provider.exchangeCode('code', CONTEXT).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(IdentityProviderUnavailableError);
      expect(error).toMatchObject({ reason });
    },
  );

  it('passes a verification failure it already classified straight through', () => {
    const original = new IdentityVerificationError('no-email');
    expect(providerFailure(original)).toBe(original);
  });
});

describe('Magic Auth', () => {
  it('creates a code for the address and says whose WorkOS user it reached', async () => {
    const { provider, calls } = stubApi();

    const created = await provider.createMagicAuth('alice@bigcorp.example', {
      ipAddress: null,
      userAgent: null,
    });

    expect(created.workosUserId).toBe('user_01HZXK9P3Q');
    // WorkOS emails the code; this server drops its copy unread.
    expect(JSON.stringify(created)).not.toContain('123456');
    expect(calls.createMagicAuth).toHaveBeenCalledWith({ email: 'alice@bigcorp.example' });
  });

  it('checks a code and reports the WorkOS user it proved, and any impersonation', async () => {
    const { provider, calls } = stubApi();

    const verified = await provider.authenticateWithMagicAuth(
      { code: '123456', email: 'alice@bigcorp.example' },
      { ipAddress: '203.0.113.5', userAgent: null },
    );

    expect(verified).toEqual({ workosUserId: 'user_01HZXK9P3Q', impersonated: false });
    expect(calls.authenticateWithMagicAuth).toHaveBeenCalledWith({
      clientId: CONFIG.clientId,
      code: '123456',
      email: 'alice@bigcorp.example',
      ipAddress: '203.0.113.5',
    });
  });

  it.each([['12345'], ['1234567'], ['12345a'], [''], ['12 345']])(
    'refuses %j before asking WorkOS',
    async (code) => {
      const { provider, calls } = stubApi();

      await expect(
        provider.authenticateWithMagicAuth(
          { code, email: 'alice@bigcorp.example' },
          { ipAddress: null, userAgent: null },
        ),
      ).rejects.toBeInstanceOf(IdentityVerificationError);
      expect(calls.authenticateWithMagicAuth).not.toHaveBeenCalled();
    },
  );

  it('reports a wrong code as a verification failure', async () => {
    const { provider } = stubApi({
      authenticateWithMagicAuth: vi.fn(async () =>
        Promise.reject(failure(400, { code: 'invalid_one_time_code' })),
      ),
    });

    await expect(
      provider.authenticateWithMagicAuth(
        { code: '000000', email: 'alice@bigcorp.example' },
        { ipAddress: null, userAgent: null },
      ),
    ).rejects.toMatchObject({ reason: 'invalid_one_time_code' });
  });
});

describe('verified domains', () => {
  it('returns only verified domains, lower-cased', async () => {
    const { provider, calls } = stubApi();

    const domains = await provider.verifiedDomains('org_01BIGCORP');

    expect([...domains]).toEqual(['bigcorp.example']);
    expect(calls.getOrganization).toHaveBeenCalledWith('org_01BIGCORP');
  });
});

describe('construction from the bindings', () => {
  const env = (over: Partial<Bindings> = {}) =>
    ({
      XECRET_PUBLIC_URL: 'https://xecret.playxoft.com',
      WORKOS_CLIENT_ID: 'client_01TESTCLIENT',
      WORKOS_API_KEY: 'sk_test_x',
      ...over,
    }) as Bindings;

  it('is a missing-binding failure without an API key or a client id — a 503, not a 500', () => {
    resetWorkosClientForTesting();
    expect(() => workosProvider(env({ WORKOS_API_KEY: undefined }))).toThrowError(
      MissingBindingError,
    );
    expect(() => workosProvider(env({ WORKOS_CLIENT_ID: undefined }))).toThrowError(
      MissingBindingError,
    );
  });

  it('builds against the configured client and the derived redirect', () => {
    resetWorkosClientForTesting();
    const query = new URL(
      workosProvider(env()).authorizationUrl({ state: 's', codeChallenge: 'c'.repeat(43) }),
    ).searchParams;

    expect(query.get('client_id')).toBe('client_01TESTCLIENT');
    expect(query.get('redirect_uri')).toBe('https://xecret.playxoft.com/api/auth/callback');
  });

  it('never answers with a client built for different credentials', () => {
    resetWorkosClientForTesting();
    workosProvider(env());
    const query = new URL(
      workosProvider(env({ WORKOS_CLIENT_ID: 'client_OTHER' })).authorizationUrl({
        state: 's',
        codeChallenge: 'c'.repeat(43),
      }),
    ).searchParams;

    expect(query.get('client_id')).toBe('client_OTHER');
  });
});

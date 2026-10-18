import { describe, expect, it, vi } from 'vitest';
import { WorkOS } from '@workos-inc/node';
import { IdentityVerificationError, isWorkosIdentity } from '@xecret/core/auth';
import type { Bindings } from './bindings';
import { MissingBindingError } from './bindings';
import {
  AuthenticationStepRequired,
  authKitSessionId,
  callbackUrl,
  CONNECTION_PAGE_LIMIT,
  CONNECTION_PAGE_SIZE,
  IdentityProviderUnavailableError,
  lastActiveAuthentication,
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
    authenticateWithTotp: vi.fn(async () => ({
      user: user(),
      accessToken: 'at',
      refreshToken: 'rt',
      authenticationMethod: 'MagicAuth',
    })),
    challengeFactor: vi.fn(async () => ({
      object: 'authentication_challenge',
      id: 'auth_challenge_01',
      authenticationFactorId: 'auth_factor_01',
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
      authenticateWithTotp: calls.authenticateWithTotp,
    },
    multiFactorAuth: { challengeFactor: calls.challengeFactor },
    organizations: { getOrganization: calls.getOrganization, createOrganization: vi.fn() },
    adminPortal: { generateLink: vi.fn() },
    sso: { listConnections: vi.fn() },
  } as unknown as WorkosApi;

  return { api, calls, provider: new WorkosIdentityProvider(api, CONFIG) };
}

/** A JWT-shaped access token with `claims` as its payload. The signature is never read. */
function accessToken(claims: unknown): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256', typ: 'JWT' })}.${part(claims)}.c2lnbmF0dXJl`;
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

  it('reads when the person last actively authenticated from the access token’s auth_time', async () => {
    const authTime = 1_790_000_000;
    const { provider } = stubApi({
      authenticateWithCode: vi.fn(async () => ({
        user: user(),
        accessToken: accessToken({
          sub: 'user_01HZXK9P3Q',
          auth_time: authTime,
          iat: authTime + 5,
        }),
        refreshToken: 'rt',
      })),
    });

    const exchange = await provider.exchangeCode('code', CONTEXT);

    expect(exchange.authenticatedAt).toBe(authTime);
    // The date is carried; the token is not.
    expect(JSON.stringify(exchange)).not.toContain('c2lnbmF0dXJl');
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

describe('reading auth_time', () => {
  it.each([
    ['no token', undefined],
    ['not a string', 42],
    ['an opaque token', 'at'],
    ['two parts', 'a.b'],
    ['four parts', 'a.b.c.d'],
    ['a payload that is not base64url', 'a.!!!.c'],
    ['a payload that is not JSON', `a.${Buffer.from('not json').toString('base64url')}.c`],
    ['a payload that is not UTF-8', `a.${Buffer.from([0xff, 0xfe]).toString('base64url')}.c`],
    ['a payload that is not an object', accessToken('auth_time')],
    ['no auth_time', accessToken({ sub: 'user_01', iat: 1_790_000_000 })],
    ['auth_time as a string', accessToken({ auth_time: '1790000000' })],
    ['auth_time as a fraction', accessToken({ auth_time: 1_790_000_000.5 })],
    ['auth_time of zero', accessToken({ auth_time: 0 })],
    ['a negative auth_time', accessToken({ auth_time: -1 })],
    ['an oversized token', accessToken({ auth_time: 1_790_000_000, pad: 'x'.repeat(9000) })],
  ])('reads %s as null — "not shown to be fresh"', (_name, token) => {
    expect(lastActiveAuthentication(token)).toBeNull();
  });

  it('reads a well-formed claim', () => {
    expect(lastActiveAuthentication(accessToken({ auth_time: 1_790_000_000 }))).toBe(1_790_000_000);
  });
});

describe('reading the AuthKit session (sid) — review round 2', () => {
  it.each([
    ['no token', undefined],
    ['an opaque token', 'at'],
    ['no sid', accessToken({ sub: 'user_01' })],
    ['a sid that is not a string', accessToken({ sid: 42 })],
    ['a sid of the wrong shape', accessToken({ sid: 'sess_01' })],
    ['a sid with a path in it', accessToken({ sid: 'session_01/../logout' })],
    ['a sid with a query in it', accessToken({ sid: 'session_01?return_to=evil' })],
    ['an over-long sid', accessToken({ sid: `session_${'A'.repeat(65)}` })],
  ])('reads %s as no session', (_name, token) => {
    expect(authKitSessionId(token)).toBeNull();
  });

  it('reads a well-formed sid, and carries it on the exchange', async () => {
    const sid = 'session_01H93ZY4F80QPBEZ1R5B2SHQG8';
    expect(authKitSessionId(accessToken({ sid }))).toBe(sid);

    const { provider } = stubApi({
      authenticateWithCode: vi.fn(async () => ({
        user: user(),
        accessToken: accessToken({ sid, auth_time: 1_790_000_000 }),
        refreshToken: 'rt',
      })),
    });
    const exchange = await provider.exchangeCode('code_01', CONTEXT);
    expect(exchange.providerSessionId).toBe(sid);
  });
});

describe('the logout URL — review round 2', () => {
  function withLogout() {
    const { api } = stubApi();
    (api.userManagement as Record<string, unknown>)['getLogoutUrl'] = (
      options: Parameters<WorkOS['userManagement']['getLogoutUrl']>[0],
    ) => realSdk.userManagement.getLogoutUrl(options);
    return new WorkosIdentityProvider(api, CONFIG);
  }

  it('is WorkOS’s, for the session, returning where it is told', () => {
    const url = new URL(
      withLogout().logoutUrl({
        sessionId: 'session_01H93ZY4F80QPBEZ1R5B2SHQG8',
        returnTo: 'https://xecret.playxoft.com/sign-in',
      }),
    );
    expect(url.origin).toBe('https://api.workos.com');
    expect(url.pathname).toBe('/user_management/sessions/logout');
    expect(url.searchParams.get('session_id')).toBe('session_01H93ZY4F80QPBEZ1R5B2SHQG8');
    expect(url.searchParams.get('return_to')).toBe('https://xecret.playxoft.com/sign-in');
  });

  it('is never built for something that is not a session id', () => {
    expect(() =>
      withLogout().logoutUrl({ sessionId: 'nope', returnTo: 'https://xecret.playxoft.com/' }),
    ).toThrow(IdentityVerificationError);
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

describe('authentication steps WorkOS asks for', () => {
  // The shape WorkOS documents for `mfa_challenge` (reference: AuthKit →
  // authentication errors), as the SDK raises it: an `AuthenticationException`
  // whose `code` names the step, with the pending token on the instance and the
  // factors in `rawData`. The status is 400 or 403 depending on the grant.
  function authException(status: number, fields: Record<string, unknown>) {
    return Object.assign(new Error('step'), { name: 'AuthenticationException', status, ...fields });
  }

  it.each([[400], [403]])(
    'classifies mfa_challenge (%i) by its code, with the pending token and the TOTP factor',
    (status) => {
      const step = providerFailure(
        authException(status, {
          code: 'mfa_challenge',
          pendingAuthenticationToken: 'pending',
          rawData: {
            code: 'mfa_challenge',
            pending_authentication_token: 'pending',
            authentication_factors: [
              { id: 'auth_factor_sms', type: 'sms' },
              { id: 'auth_factor_01', type: 'totp' },
            ],
          },
        }),
      );

      expect(step).toBeInstanceOf(AuthenticationStepRequired);
      expect(step).toMatchObject({
        code: 'mfa_challenge',
        pendingAuthenticationToken: 'pending',
        totpFactorId: 'auth_factor_01',
      });
      // Still a verification failure to anything that does not handle steps.
      expect(step).toBeInstanceOf(IdentityVerificationError);
    },
  );

  it.each([
    ['organization_selection_required', { code: 'organization_selection_required' }, 403],
    ['email_verification_required', { code: 'email_verification_required' }, 403],
    ['sso_required (OAuth-style error field)', { error: 'sso_required' }, 400],
    ['mfa_enrollment', { code: 'mfa_enrollment' }, 403],
  ])(
    'classifies %s as a step, not as a wrong code and not as an outage',
    (_label, fields, status) => {
      const step = providerFailure(authException(status, fields));

      expect(step).toBeInstanceOf(AuthenticationStepRequired);
      expect(step).not.toBeInstanceOf(IdentityProviderUnavailableError);
    },
  );

  it('reads the pending token from rawData when the instance lacks it', () => {
    const step = providerFailure(
      authException(403, {
        code: 'mfa_challenge',
        rawData: { pending_authentication_token: 'from-raw', authentication_factors: [] },
      }),
    ) as AuthenticationStepRequired;

    expect(step.pendingAuthenticationToken).toBe('from-raw');
    expect(step.totpFactorId).toBeNull();
  });

  it('treats Magic Auth switched off as misconfiguration, named in `error` or in `code`', () => {
    for (const fields of [
      { error: 'authentication_method_not_allowed' },
      { code: 'authentication_method_not_allowed' },
    ]) {
      expect(providerFailure(failure(400, fields))).toMatchObject({ reason: 'misconfigured' });
    }
  });

  it('completes a TOTP step: challenges the factor, then authenticates with the code', async () => {
    const { provider, calls } = stubApi();

    const result = await provider.completeWithTotp(
      { code: '654321', pendingAuthenticationToken: 'pending', totpFactorId: 'auth_factor_01' },
      { ipAddress: null, userAgent: null },
    );

    expect(result).toEqual({ workosUserId: 'user_01HZXK9P3Q', impersonated: false });
    expect(calls.challengeFactor).toHaveBeenCalledWith({
      authenticationFactorId: 'auth_factor_01',
    });
    expect(calls.authenticateWithTotp).toHaveBeenCalledWith({
      clientId: CONFIG.clientId,
      code: '654321',
      pendingAuthenticationToken: 'pending',
      authenticationChallengeId: 'auth_challenge_01',
    });
  });

  it('refuses a malformed TOTP code before challenging anything', async () => {
    const { provider, calls } = stubApi();

    await expect(
      provider.completeWithTotp(
        { code: '12345', pendingAuthenticationToken: 'p', totpFactorId: 'f' },
        { ipAddress: null, userAgent: null },
      ),
    ).rejects.toBeInstanceOf(IdentityVerificationError);
    expect(calls.challengeFactor).not.toHaveBeenCalled();
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

  it('reports every domain with its state for the settings, reading an unknown state as pending', async () => {
    const { provider } = stubApi({
      getOrganization: vi.fn(async () => ({
        id: 'org_01BIGCORP',
        domains: [
          { domain: 'BigCorp.example', state: 'verified' },
          { domain: 'failed.example', state: 'failed' },
          { domain: 'later.example', state: 'legacy_verified' },
        ],
      })),
    });

    expect(await provider.domains('org_01BIGCORP')).toEqual([
      { domain: 'bigcorp.example', state: 'verified' },
      { domain: 'failed.example', state: 'failed' },
      // Not `verified`, so it never counts as one — for the callback either.
      { domain: 'later.example', state: 'pending' },
    ]);
  });
});

describe('the organisation SSO calls (WS-5)', () => {
  function ssoStub() {
    const stub = stubApi();
    const organizations = (stub.api as unknown as { organizations: Record<string, unknown> })
      .organizations;
    const createOrganization = vi.fn(async () => ({ id: 'org_01NEW' }));
    const getOrganizationByExternalId = vi.fn();
    const deleteOrganization = vi.fn(async () => undefined);
    Object.assign(organizations, {
      createOrganization,
      getOrganizationByExternalId,
      deleteOrganization,
    });
    const generateLink = vi.fn();
    const listConnections = vi.fn();
    Object.assign(stub.api.adminPortal, { generateLink });
    Object.assign(stub.api.sso, { listConnections });
    return {
      provider: stub.provider,
      createOrganization,
      getOrganizationByExternalId,
      deleteOrganization,
      generateLink,
      listConnections,
    };
  }

  it('creates a WorkOS organisation from a name and the xecret id alone — never domainData', async () => {
    const { provider, createOrganization } = ssoStub();

    // A caller that reached past the type with extra fields, verified domains
    // among them, must not get any of them forwarded (PR #114).
    const id = await provider.createOrganization({
      name: 'Acme',
      externalId: 'org-uuid',
      domainData: [{ domain: 'acme.example', state: 'verified' }],
    } as never);

    expect(id).toBe('org_01NEW');
    expect(createOrganization).toHaveBeenCalledWith(
      { name: 'Acme', externalId: 'org-uuid' },
      { idempotencyKey: 'xecret-sso-enable-org-uuid' },
    );
  });

  it('adopts the organisation holding its externalId on a 409, and only that one', async () => {
    const { provider, createOrganization, getOrganizationByExternalId } = ssoStub();
    createOrganization.mockRejectedValue(failure(409));
    getOrganizationByExternalId.mockResolvedValueOnce({ id: 'org_01EARLIER', externalId: 'mine' });

    expect(await provider.createOrganization({ name: 'Acme', externalId: 'mine' })).toBe(
      'org_01EARLIER',
    );

    getOrganizationByExternalId.mockResolvedValueOnce({ id: 'org_01OTHER', externalId: 'theirs' });
    await expect(
      provider.createOrganization({ name: 'Acme', externalId: 'mine' }),
    ).rejects.toBeInstanceOf(IdentityVerificationError);
  });

  it('sorts a failed creation like any other WorkOS failure, without looking anything up', async () => {
    const { provider, createOrganization, getOrganizationByExternalId } = ssoStub();
    createOrganization.mockRejectedValue(failure(503));

    await expect(
      provider.createOrganization({ name: 'Acme', externalId: 'mine' }),
    ).rejects.toBeInstanceOf(IdentityProviderUnavailableError);
    expect(getOrganizationByExternalId).not.toHaveBeenCalled();
  });

  it('asks for an SSO-intent Admin Portal link and refuses anything that is not https', async () => {
    const { provider, generateLink } = ssoStub();
    generateLink.mockResolvedValueOnce({ link: 'https://setup.workos.com/portal/launch?x=1' });

    expect(
      await provider.generatePortalLink({
        workosOrgId: 'org_01BIGCORP',
        returnUrl: 'https://xecret.playxoft.com/app/acme/settings',
      }),
    ).toBe('https://setup.workos.com/portal/launch?x=1');
    expect(generateLink).toHaveBeenCalledWith({
      organization: 'org_01BIGCORP',
      intent: 'sso',
      returnUrl: 'https://xecret.playxoft.com/app/acme/settings',
    });

    for (const link of ['javascript:alert(1)', 'http://setup.workos.com/', '/portal', '']) {
      generateLink.mockResolvedValueOnce({ link });
      await expect(
        provider.generatePortalLink({ workosOrgId: 'org_01BIGCORP', returnUrl: 'https://x/' }),
      ).rejects.toBeInstanceOf(IdentityVerificationError);
    }
  });

  it('lists connections for the organisation, copying only id, state and type', async () => {
    const { provider, listConnections } = ssoStub();
    listConnections.mockResolvedValue({
      data: [
        {
          id: 'conn_01',
          state: 'active',
          type: 'OktaSAML',
          name: 'BigCorp',
          domains: [{ domain: 'bigcorp.example' }],
          organizationId: 'org_01BIGCORP',
        },
      ],
    });

    expect(await provider.listConnections('org_01BIGCORP')).toEqual([
      { id: 'conn_01', state: 'active', type: 'OktaSAML' },
    ]);
    expect(listConnections).toHaveBeenCalledWith({
      organizationId: 'org_01BIGCORP',
      limit: CONNECTION_PAGE_SIZE,
    });
  });

  it('follows every page, so a connection past the first ten is not missed (review C7)', async () => {
    const { provider, listConnections } = ssoStub();
    listConnections
      .mockResolvedValueOnce({
        data: [{ id: 'conn_01', state: 'draft', type: 'OktaSAML' }],
        listMetadata: { after: 'cursor_1' },
      })
      .mockResolvedValueOnce({
        data: [{ id: 'conn_02', state: 'active', type: 'GenericOIDC' }],
        listMetadata: { after: null },
      });

    expect(await provider.listConnections('org_01BIGCORP')).toEqual([
      { id: 'conn_01', state: 'draft', type: 'OktaSAML' },
      { id: 'conn_02', state: 'active', type: 'GenericOIDC' },
    ]);
    expect(listConnections).toHaveBeenNthCalledWith(2, {
      organizationId: 'org_01BIGCORP',
      limit: CONNECTION_PAGE_SIZE,
      after: 'cursor_1',
    });
  });

  it('stops at the page cap, and on a cursor that does not move', async () => {
    const { provider, listConnections } = ssoStub();
    listConnections.mockImplementation(async ({ after }: { after?: string }) => ({
      data: [{ id: `conn_${after ?? 'first'}`, state: 'draft', type: 'OktaSAML' }],
      listMetadata: { after: `${after ?? ''}x` },
    }));

    expect(await provider.listConnections('org_01BIGCORP')).toHaveLength(CONNECTION_PAGE_LIMIT);
    expect(listConnections).toHaveBeenCalledTimes(CONNECTION_PAGE_LIMIT);

    listConnections.mockReset();
    listConnections.mockResolvedValue({
      data: [{ id: 'conn_01', state: 'draft', type: 'OktaSAML' }],
      listMetadata: { after: 'same' },
    });
    await provider.listConnections('org_01BIGCORP');
    expect(listConnections).toHaveBeenCalledTimes(2);
  });

  it('reads a connection state it does not know as inactive, never as active (review C6)', async () => {
    const { provider, listConnections } = ssoStub();
    listConnections.mockResolvedValue({
      data: [
        { id: 'conn_01', state: 'suspended', type: 'OktaSAML' },
        { id: 'conn_02', state: undefined, type: 'OktaSAML' },
      ],
    });

    expect((await provider.listConnections('org_01BIGCORP')).map((c) => c.state)).toEqual([
      'inactive',
      'inactive',
    ]);
  });

  it('says which WorkOS environment it talks to, for the link to record (review S9)', () => {
    expect(ssoStub().provider.clientId).toBe('client_01TESTCLIENT');
  });

  it('deletes an orphaned WorkOS organisation by id', async () => {
    const { provider, deleteOrganization } = ssoStub();

    await provider.deleteOrganization('org_01ORPHAN');

    expect(deleteOrganization).toHaveBeenCalledWith('org_01ORPHAN');
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

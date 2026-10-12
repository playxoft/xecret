import { describe, expect, it } from 'vitest';
import {
  createWorkosUsersApi,
  parseWorkosUser,
  redact,
  sessionIdFromAccessToken,
  WorkosApiError,
} from './workos-api';

/** An unsigned JWT-shaped token with these claims. Only the payload is ever read. */
const accessToken = (claims: Record<string, unknown>) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.c2ln`;

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

const API_KEY = 'workos-api-key-fixture';

const userJson = (over: Record<string, unknown> = {}) => ({
  object: 'user',
  id: 'user_01HXYZ',
  email: 'ada@example.com',
  email_verified: true,
  external_id: 'fbUid1',
  ...over,
});

/** A fetch that answers from a queue and records what it was asked. */
function stubFetch(
  responses: { status: number; json?: unknown; headers?: Record<string, string> }[],
) {
  const calls: Recorded[] = [];
  // The client only ever passes a string URL.
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: input,
      method: init?.method ?? 'GET',
      headers,
      body:
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return new Response(next.json === undefined ? null : JSON.stringify(next.json), {
      status: next.status,
      headers: next.headers ?? {},
    });
  }) as typeof fetch;
  const sleeps: number[] = [];
  const api = createWorkosUsersApi({
    apiKey: API_KEY,
    fetch: fetchImpl,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  return { api, calls, sleeps };
}

describe('parseWorkosUser', () => {
  it('reads the fields the import relies on', () => {
    expect(parseWorkosUser(userJson())).toEqual({
      id: 'user_01HXYZ',
      email: 'ada@example.com',
      emailVerified: true,
      externalId: 'fbUid1',
    });
    expect(parseWorkosUser(userJson({ external_id: null })).externalId).toBeNull();
    expect(parseWorkosUser(userJson({ external_id: undefined })).externalId).toBeNull();
  });

  it.each([
    [null, /not an object/],
    [userJson({ id: 'fbUid1' }), /without a valid id/],
    [userJson({ email_verified: 'true' }), /missing email or email_verified/],
    [userJson({ email: undefined }), /missing email or email_verified/],
    [userJson({ external_id: 5 }), /non-string external_id/],
  ])('refuses %j', (json, message) => {
    expect(() => parseWorkosUser(json)).toThrow(message);
  });
});

describe('sessionIdFromAccessToken', () => {
  it('reads the sid claim of a JWT-shaped token', () => {
    expect(
      sessionIdFromAccessToken(accessToken({ sid: 'session_01H93ZY4F80QPBEZ1R5B2SHQG8' })),
    ).toBe('session_01H93ZY4F80QPBEZ1R5B2SHQG8');
  });

  it.each([
    ['not a string', 42],
    ['no payload', 'abc'],
    ['payload not JSON', 'e30.!!!.x'],
    ['no sid', accessToken({ sub: 'user_01' })],
    ['a sid that is not a session id', accessToken({ sid: 'user_01; drop' })],
  ])('is null for %s', (_name, token) => {
    expect(sessionIdFromAccessToken(token)).toBeNull();
  });
});

describe('redact', () => {
  it('replaces every secret, longest first', () => {
    expect(redact('bad hash abcdef in abcdefgh', ['abcdef', 'abcdefgh'])).toBe(
      'bad hash [redacted] in [redacted]',
    );
  });

  it('ignores fragments too short to mean anything', () => {
    expect(redact('v=1 r=8', ['1', '8', 'v'])).toBe('v=1 r=8');
  });
});

describe('createWorkosUsersApi', () => {
  it('looks a user up by external id, and answers null on 404', async () => {
    const { api, calls } = stubFetch([
      { status: 200, json: userJson() },
      { status: 404, json: {} },
    ]);
    expect(await api.getUserByExternalId('fb/uid 1')).toMatchObject({ id: 'user_01HXYZ' });
    expect(await api.getUserByExternalId('nobody')).toBeNull();
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: 'https://api.workos.com/user_management/users/external_id/fb%2Fuid%201',
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
  });

  it('finds a user by address with the email filter', async () => {
    const { api, calls } = stubFetch([
      { status: 200, json: { data: [userJson()] } },
      { status: 200, json: { data: [] } },
    ]);
    expect(await api.findUserByEmail('a+b@example.com')).toMatchObject({ id: 'user_01HXYZ' });
    expect(await api.findUserByEmail('none@example.com')).toBeNull();
    expect(calls[0]?.url).toBe(
      'https://api.workos.com/user_management/users?email=a%2Bb%40example.com&limit=2',
    );
  });

  it('refuses an address that matches two users rather than picking one', async () => {
    const { api } = stubFetch([
      { status: 200, json: { data: [userJson(), userJson({ id: 'user_02' })] } },
    ]);
    await expect(api.findUserByEmail('ada@example.com')).rejects.toThrow(/more than one user/);
  });

  it('creates a user with the firebase-scrypt hash type, in snake case', async () => {
    const { api, calls } = stubFetch([{ status: 201, json: userJson() }]);
    await api.createUser({
      email: 'ada@example.com',
      emailVerified: true,
      firstName: 'Ada',
      lastName: 'Lovelace',
      externalId: 'fbUid1',
      firebaseScryptHash: '$firebase-scrypt$v=1$r=8,m=14,ss=Bw,sk=SK$SALT$HASH',
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.workos.com/user_management/users',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: {
        email: 'ada@example.com',
        email_verified: true,
        first_name: 'Ada',
        last_name: 'Lovelace',
        external_id: 'fbUid1',
        password_hash: '$firebase-scrypt$v=1$r=8,m=14,ss=Bw,sk=SK$SALT$HASH',
        password_hash_type: 'firebase-scrypt',
      },
    });
  });

  it('sends no password field at all for a user without one', async () => {
    const { api, calls } = stubFetch([{ status: 201, json: userJson() }]);
    await api.createUser({ email: 'g@example.com', emailVerified: true });
    expect(calls[0]?.body).toEqual({ email: 'g@example.com', email_verified: true });
  });

  it('scrubs the hash, and each part of it, out of an error WorkOS sends back', async () => {
    const hash = '$firebase-scrypt$v=1$r=8,m=14,ss=Bw,sk=SIGNERKEYB64$SALTB64x$HASHB64xx';
    const { api } = stubFetch([
      {
        status: 422,
        json: {
          code: 'invalid_password_hash',
          message: `Bad hash ${hash}; salt SALTB64x; sk SIGNERKEYB64`,
        },
      },
    ]);
    const error = await api
      .createUser({ email: 'a@example.com', emailVerified: true, firebaseScryptHash: hash })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(WorkosApiError);
    const message = (error as WorkosApiError).message;
    expect(message).toMatch(
      /POST \/user_management\/users failed: HTTP 422 \(invalid_password_hash\)/,
    );
    for (const secret of ['SIGNERKEYB64', 'SALTB64x', 'HASHB64xx'])
      expect(message).not.toContain(secret);
  });

  it('never names the address in an error path', async () => {
    const { api } = stubFetch([{ status: 500, json: { message: 'oops for ada@example.com' } }]);
    const error = (await api.findUserByEmail('ada@example.com').catch((e: unknown) => e)) as Error;
    expect(error.message).toContain('GET /user_management/users?email={email}');
    expect(error.message).not.toContain('ada@example.com');
  });

  // Review round 2: getUser never knew the address, so it could not redact it by value.
  it('scrubs any address from a WorkOS error, even one the call never sent', async () => {
    const { api } = stubFetch([
      { status: 503, json: { message: 'user grace.hopper+x@example.org is locked; ask "a@b.co"' } },
    ]);
    const error = (await api.getUser('user_01HXYZ').catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/HTTP 503/);
    expect(error.message).not.toMatch(/@/);
    expect(error.message).toContain('[address]');
  });

  it('retries a 429 after Retry-After, then succeeds', async () => {
    const { api, sleeps } = stubFetch([
      { status: 429, headers: { 'retry-after': '2' } },
      { status: 429 },
      { status: 200, json: userJson() },
    ]);
    expect(await api.getUser('user_01HXYZ')).toMatchObject({ id: 'user_01HXYZ' });
    expect(sleeps[0]).toBe(2000);
    expect(sleeps).toHaveLength(2);
  });

  it('gives up on 429 after three retries', async () => {
    const { api } = stubFetch([{ status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }]);
    await expect(api.getUser('user_01HXYZ')).rejects.toThrow(/HTTP 429/);
  });

  it('deletes, and treats an already-deleted user as done', async () => {
    const { api, calls } = stubFetch([{ status: 202 }, { status: 404 }]);
    await api.deleteUser('user_01HXYZ');
    await api.deleteUser('user_01HXYZ');
    expect(calls.map((c) => c.method)).toEqual(['DELETE', 'DELETE']);
    expect(calls[0]?.url).toBe('https://api.workos.com/user_management/users/user_01HXYZ');
  });

  it('authenticates with a password using the key as client_secret, not as a bearer token', async () => {
    const { api, calls } = stubFetch([
      {
        status: 200,
        json: {
          user: userJson(),
          access_token: accessToken({ sid: 'session_01ABC', sub: 'user_01HXYZ' }),
          refresh_token: 'y',
        },
      },
    ]);
    expect(
      await api.authenticateWithPassword({
        clientId: 'client_01',
        email: 'ada@example.com',
        password: 'pw-1',
      }),
    ).toEqual({ ok: true, userId: 'user_01HXYZ', sessionId: 'session_01ABC' });
    expect(calls[0]?.headers).not.toHaveProperty('Authorization');
    expect(calls[0]?.body).toEqual({
      client_id: 'client_01',
      client_secret: API_KEY,
      grant_type: 'password',
      email: 'ada@example.com',
      password: 'pw-1',
    });
  });

  it('revokes a session with the key as a bearer token', async () => {
    const { api, calls } = stubFetch([
      { status: 200, json: {} },
      { status: 404, json: {} },
    ]);
    await api.revokeSession('session_01ABC');
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.workos.com/user_management/sessions/revoke',
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: { session_id: 'session_01ABC' },
    });
    await expect(api.revokeSession('session_01GONE')).rejects.toThrow(/HTTP 404/);
  });

  it('reports a refused password as a result, with WorkOS’s code', async () => {
    const { api } = stubFetch([
      { status: 400, json: { code: 'invalid_credentials', message: 'Invalid credentials.' } },
      { status: 401, json: { error: 'invalid_grant', error_description: 'nope' } },
    ]);
    const args = { clientId: 'client_01', email: 'ada@example.com', password: 'wrong' };
    expect(await api.authenticateWithPassword(args)).toEqual({
      ok: false,
      status: 400,
      code: 'invalid_credentials',
    });
    expect(await api.authenticateWithPassword(args)).toEqual({
      ok: false,
      status: 401,
      code: 'invalid_grant',
    });
  });

  it('tells a key and client of one environment from a mismatched pair, creating nothing', async () => {
    const { api, calls } = stubFetch([
      {
        status: 400,
        json: { error: 'invalid_grant', error_description: 'The code has expired or is invalid.' },
      },
      {
        status: 400,
        json: { error: 'invalid_client', error_description: 'different environment' },
      },
    ]);
    expect(await api.checkClientPairing('client_01SAME')).toBe('same-environment');
    expect(await api.checkClientPairing('client_01OTHER')).toBe('different-environment');
    expect(calls[0]?.body).toMatchObject({
      client_id: 'client_01SAME',
      client_secret: API_KEY,
      grant_type: 'authorization_code',
    });
  });

  it('refuses to guess when the environment check gets any other answer', async () => {
    const { api } = stubFetch([
      { status: 200, json: { user: userJson() } },
      { status: 400, json: { error: 'invalid_request' } },
      { status: 500, json: {} },
    ]);
    await expect(api.checkClientPairing('client_01')).rejects.toThrow(/environment check/);
    await expect(api.checkClientPairing('client_01')).rejects.toThrow(/invalid_request/);
    await expect(api.checkClientPairing('client_01')).rejects.toThrow(/HTTP 500/);
  });

  it('throws on a server error during authentication, without the password or key', async () => {
    const { api } = stubFetch([
      { status: 503, json: { message: `down; pw=hunter22 key=${API_KEY}` } },
    ]);
    const error = (await api
      .authenticateWithPassword({ clientId: 'c', email: 'a@example.com', password: 'hunter22' })
      .catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/HTTP 503/);
    expect(error.message).not.toContain('hunter22');
    expect(error.message).not.toContain(API_KEY);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { IdentityVerificationError } from '@xecret/core/auth';
import {
  connectionString,
  MissingBindingError,
  requireBinding,
  withProcessFallbacks,
} from './bindings';
import type { Bindings } from './bindings';
import { ApiError, errors } from './errors';
import {
  MAX_REQUEST_BODY_BYTES,
  bearerToken,
  clientIp,
  isSameOrigin,
  json,
  parseCookies,
  parseWith,
  readJsonBody,
  requestIdFrom,
  toApiError,
  userAgent,
} from './http';
import { FirebaseIdentityProvider, InMemoryKeyStore } from './firebase';
import type { FirebaseClaims, IdTokenVerifier } from './firebase';
import { attemptKey, consume, enforce } from './rate-limit';

/**
 * Tests for the request-handling spine.
 *
 * Everything here is exercised for real — there is no Cloudflare runtime in this
 * process, but nothing in these modules needs one: bindings are a plain object,
 * and the identity provider takes its verifier as a constructor argument
 * precisely so its rejection paths can be tested without a Firebase project.
 */

function bindings(overrides: Partial<Bindings> = {}): Bindings {
  return {
    ASSETS: undefined as unknown as Fetcher,
    XECRET_ENV: 'development',
    XECRET_PUBLIC_URL: 'http://localhost:3000',
    ...overrides,
  };
}

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request('https://xecret.playxoft.com/api/test', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('binding access', () => {
  it('names the missing binding, so a misconfiguration is self-diagnosing', () => {
    expect(() => requireBinding(bindings(), 'HYPERDRIVE')).toThrowError(MissingBindingError);
    try {
      requireBinding(bindings(), 'JWKS_CACHE');
    } catch (cause) {
      expect((cause as MissingBindingError).binding).toBe('JWKS_CACHE');
    }
  });

  it('prefers Hyperdrive over a direct URL, so only one database is ever reachable', () => {
    const env = bindings({
      HYPERDRIVE: { connectionString: 'postgres://pooled' } as Hyperdrive,
      DATABASE_URL: 'postgres://direct',
    });
    expect(connectionString(env)).toBe('postgres://pooled');
  });

  it('falls back to a direct URL for self-hosters without Hyperdrive', () => {
    expect(connectionString(bindings({ DATABASE_URL: 'postgres://direct' }))).toBe(
      'postgres://direct',
    );
  });

  it('refuses to guess when neither is configured', () => {
    expect(() => connectionString(bindings())).toThrowError(MissingBindingError);
  });
});

/**
 * Regression, twice over.
 *
 * `next dev` builds the Worker's `env` from `wrangler.jsonc`, faithfully
 * excluding the shell — so `phase run -- npm run dev` supplied values the
 * application could not see, and every route answered 503 while the identical
 * configuration worked in every script.
 *
 * The first fix covered only `DATABASE_URL`, and the very next request failed
 * on `FIREBASE_PROJECT_ID` with the same message for the same reason. Hence a
 * list rather than a call site: a per-value fix guarantees a per-value bug.
 */
describe('process environment fallbacks', () => {
  it('fills every value a secrets manager supplies', () => {
    const merged = withProcessFallbacks(bindings(), {
      DATABASE_URL: 'postgres://from-process',
      FIREBASE_PROJECT_ID: 'xecret-dev',
      XECRET_ROOT_KEY_VERSION: '2',
    });

    expect(merged.DATABASE_URL).toBe('postgres://from-process');
    expect(merged.FIREBASE_PROJECT_ID).toBe('xecret-dev');
    expect(merged.XECRET_ROOT_KEY_VERSION).toBe('2');
  });

  // The property that makes this safe to ship: a deployed Worker cannot have
  // its configuration overridden by a stray variable on an operator's machine.
  it('never overrides a binding that is already present', () => {
    const merged = withProcessFallbacks(
      bindings({ DATABASE_URL: 'postgres://bound', FIREBASE_PROJECT_ID: 'xecret-prod' }),
      { DATABASE_URL: 'postgres://from-process', FIREBASE_PROJECT_ID: 'xecret-dev' },
    );

    expect(merged.DATABASE_URL).toBe('postgres://bound');
    expect(merged.FIREBASE_PROJECT_ID).toBe('xecret-prod');
  });

  it('leaves Hyperdrive winning over a process DATABASE_URL', () => {
    const merged = withProcessFallbacks(
      bindings({ HYPERDRIVE: { connectionString: 'postgres://pooled' } as Hyperdrive }),
      { DATABASE_URL: 'postgres://from-process' },
    );

    expect(connectionString(merged)).toBe('postgres://pooled');
  });

  it('treats an empty string as absent, in both directions', () => {
    expect(withProcessFallbacks(bindings(), { DATABASE_URL: '' }).DATABASE_URL).toBeUndefined();
    expect(
      withProcessFallbacks(bindings({ DATABASE_URL: '' }), { DATABASE_URL: 'postgres://real' })
        .DATABASE_URL,
    ).toBe('postgres://real');
  });

  it('copies rather than mutating the env it was given', () => {
    const original = bindings();
    withProcessFallbacks(original, { DATABASE_URL: 'postgres://from-process' });
    expect(original.DATABASE_URL).toBeUndefined();
  });

  it('ignores variables that are not configuration', () => {
    const merged = withProcessFallbacks(bindings(), { PATH: '/usr/bin', HOME: '/root' });
    expect(merged).toEqual(bindings());
  });
});

describe('error envelope', () => {
  it('maps every code to its documented status', () => {
    expect(errors.notFound().status).toBe(404);
    expect(errors.unauthenticated().status).toBe(401);
    expect(errors.forbidden().status).toBe(403);
    expect(errors.conflict('taken').status).toBe(409);
    expect(errors.rateLimited().status).toBe(429);
    expect(errors.tooLarge('too big').status).toBe(413);
    expect(errors.unavailable('no binding').status).toBe(503);
    expect(errors.internal('boom').status).toBe(500);
    expect(errors.csrf('missing header').status).toBe(403);
  });

  // A client that can distinguish "does not exist" from "exists but not yours"
  // can enumerate another tenant's resources. Threat T2.
  it('gives a cross-tenant miss the same body as a genuine miss', () => {
    const genuine = errors.notFound().toBody('req-1');
    const crossTenant = errors.notFound('org mismatch').toBody('req-1');
    expect(crossTenant).toEqual(genuine);
  });

  it('keeps the log detail off the wire', () => {
    const error = errors.notFound('project 0198… belongs to org 0198…');
    expect(error.logDetail).toContain('belongs to org');
    expect(JSON.stringify(error.toBody('req-1'))).not.toContain('belongs to org');
  });

  it('omits the fields array when there is nothing to report', () => {
    expect(errors.badRequest('bad').toBody('req-1').error.fields).toBeUndefined();
  });

  // A postgres.js error message can embed the connection string; a crypto error
  // can embed identifiers. Neither may reach a client.
  it('never lifts a message off an arbitrary thrown value', () => {
    const leaky = new Error('connect ECONNREFUSED postgres://user:hunter2@db.example');
    const converted = toApiError(leaky);

    expect(converted.code).toBe('internal_error');
    expect(converted.message).toBe('Something went wrong.');
    expect(JSON.stringify(converted.toBody('req-1'))).not.toContain('hunter2');
  });

  it('passes an ApiError through unchanged', () => {
    const original = errors.conflict('A secret with that name already exists.');
    expect(toApiError(original)).toBe(original);
  });

  it('carries the request id, which is the only handle a user has on a failure', () => {
    expect(errors.internal('x').toBody('req-42').error.requestId).toBe('req-42');
  });
});

describe('request body reading', () => {
  it('parses a well-formed body', async () => {
    await expect(readJsonBody(post('{"name":"API_KEY"}'))).resolves.toEqual({ name: 'API_KEY' });
  });

  it('treats an empty body as absent rather than as a parse error', async () => {
    await expect(readJsonBody(post(''))).resolves.toBeUndefined();
  });

  it('rejects malformed JSON without echoing what was sent', async () => {
    await expect(readJsonBody(post('{"value": "sk_live_abc'))).rejects.toMatchObject({
      code: 'bad_request',
    });

    try {
      await readJsonBody(post('{"value": "sk_live_abc'));
    } catch (cause) {
      expect((cause as ApiError).message).not.toContain('sk_live_abc');
    }
  });

  it('rejects an oversized body on its declared length', async () => {
    const request = post('{}', { 'content-length': String(MAX_REQUEST_BODY_BYTES + 1) });
    await expect(readJsonBody(request)).rejects.toMatchObject({ code: 'payload_too_large' });
  });

  // A chunked request can omit or understate Content-Length, so the declared
  // length alone is not a limit — it is a hint. The running count is the limit.
  it('rejects an oversized body that lied about its length', async () => {
    const oversized = 'x'.repeat(MAX_REQUEST_BODY_BYTES + 10);
    const request = new Request('https://xecret.playxoft.com/api/test', {
      method: 'POST',
      body: `"${oversized}"`,
    });

    await expect(readJsonBody(request)).rejects.toMatchObject({ code: 'payload_too_large' });
  });
});

describe('validation', () => {
  const schema = {
    safeParse: (value: unknown) =>
      typeof value === 'object' && value !== null && 'name' in value
        ? { success: true as const, data: value as { name: string } }
        : {
            success: false as const,
            error: { issues: [{ path: ['name'], message: 'Required' }] },
          },
  };

  it('returns the parsed value on success', () => {
    expect(parseWith(schema as never, { name: 'API_KEY' })).toEqual({ name: 'API_KEY' });
  });

  it('reports the failing field and the rule, never the rejected value', () => {
    try {
      parseWith(schema as never, { value: 'sk_live_supersecret' });
      expect.unreachable('expected a validation error');
    } catch (cause) {
      const error = cause as ApiError;
      expect(error.code).toBe('validation_failed');
      expect(error.fields).toEqual([{ field: 'name', message: 'Required' }]);
      expect(JSON.stringify(error.toBody('req-1'))).not.toContain('sk_live_supersecret');
    }
  });
});

describe('cookie parsing', () => {
  it('parses a normal header', () => {
    const cookies = parseCookies('__Host-xecret_session=abc; __Host-xecret_csrf=def');
    expect(cookies.get('__Host-xecret_session')).toBe('abc');
    expect(cookies.get('__Host-xecret_csrf')).toBe('def');
  });

  // A subdomain can set a same-named cookie, and the browser sends both. Taking
  // the last would let it shadow the __Host- cookie — the precise attack the
  // prefix exists to prevent.
  it('keeps the first occurrence when a name is duplicated', () => {
    const cookies = parseCookies('__Host-xecret_session=real; __Host-xecret_session=attacker');
    expect(cookies.get('__Host-xecret_session')).toBe('real');
  });

  it('survives a missing, empty, or malformed header', () => {
    expect(parseCookies(null).size).toBe(0);
    expect(parseCookies('').size).toBe(0);
    expect(parseCookies('novalue; =orphan; a=1').get('a')).toBe('1');
    expect(parseCookies('novalue; =orphan; a=1').size).toBe(1);
  });

  it('keeps a base64 value with padding intact', () => {
    expect(parseCookies('t=YWJjZA==').get('t')).toBe('YWJjZA==');
  });
});

describe('bearer token extraction', () => {
  const withAuth = (value: string) =>
    new Request('https://xecret.playxoft.com/api/test', { headers: { authorization: value } });

  it('accepts the scheme case-insensitively', () => {
    expect(bearerToken(withAuth('Bearer xct_live_abc'))).toBe('xct_live_abc');
    expect(bearerToken(withAuth('bearer xct_live_abc'))).toBe('xct_live_abc');
  });

  it('ignores other schemes and malformed headers', () => {
    expect(bearerToken(withAuth('Basic abc'))).toBeNull();
    expect(bearerToken(withAuth('Bearer'))).toBeNull();
    expect(bearerToken(withAuth('Bearer    '))).toBeNull();
    expect(bearerToken(new Request('https://xecret.playxoft.com/api/test'))).toBeNull();
  });
});

describe('request metadata', () => {
  it('prefers the Cloudflare ray id so support can cross into platform logs', () => {
    const request = new Request('https://xecret.playxoft.com/', { headers: { 'cf-ray': 'ray-1' } });
    expect(requestIdFrom(request)).toBe('ray-1');
  });

  it('generates an id when the edge did not supply one', () => {
    expect(requestIdFrom(new Request('https://xecret.playxoft.com/'))).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  // X-Forwarded-For is client-appendable; CF-Connecting-IP is set by the edge.
  it('reads the client IP only from the header the edge controls', () => {
    const request = new Request('https://xecret.playxoft.com/', {
      headers: { 'x-forwarded-for': '1.2.3.4', 'cf-connecting-ip': '5.6.7.8' },
    });
    expect(clientIp(request)).toBe('5.6.7.8');
  });

  it('reports an absent IP honestly rather than inventing a placeholder', () => {
    expect(clientIp(new Request('https://xecret.playxoft.com/'))).toBeNull();
  });

  it('bounds the user agent, which is attacker-controlled and lands in an audit row', () => {
    const request = new Request('https://xecret.playxoft.com/', {
      headers: { 'user-agent': 'x'.repeat(5000) },
    });
    expect(userAgent(request)).toHaveLength(512);
  });
});

describe('origin checking', () => {
  const from = (origin: string | null) =>
    new Request('https://xecret.playxoft.com/api/test', {
      method: 'POST',
      headers: origin === null ? {} : { origin },
    });

  it('accepts a matching origin and rejects a foreign one', () => {
    expect(isSameOrigin(from('https://xecret.playxoft.com'), 'https://xecret.playxoft.com')).toBe(
      true,
    );
    expect(isSameOrigin(from('https://evil.example'), 'https://xecret.playxoft.com')).toBe(false);
  });

  // The CLI and CI clients legitimately send no Origin. Treating absence as a
  // failure would break them; the CSRF token is what covers browsers.
  it('permits a request with no Origin, which is how non-browser clients behave', () => {
    expect(isSameOrigin(from(null), 'https://xecret.playxoft.com')).toBe(true);
  });
});

describe('JSON responses', () => {
  it('is never cacheable — every response is tenant-specific', () => {
    expect(json({ ok: true }).headers.get('cache-control')).toBe('no-store');
  });

  it('emits repeatable Set-Cookie headers', () => {
    const response = json({ ok: true }, { cookies: ['a=1; Path=/', 'b=2; Path=/'] });
    expect(response.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
  });
});

describe('Firebase identity verification', () => {
  const claims: FirebaseClaims = {
    sub: 'firebase-uid-1',
    email: 'nitheesh@playxoft.com',
    email_verified: true,
    name: 'Nitheesh',
    picture: 'https://example.test/a.png',
    firebase: { sign_in_provider: 'google.com' },
  };

  const verifierReturning = (value: FirebaseClaims): IdTokenVerifier => ({
    verifyIdToken: async () => value,
  });

  const verifierThrowing = (cause: unknown): IdTokenVerifier => ({
    verifyIdToken: async () => {
      throw cause;
    },
  });

  it('maps a verified token onto an identity', async () => {
    const identity = await new FirebaseIdentityProvider(verifierReturning(claims)).verify('token');

    expect(identity).toEqual({
      subject: 'firebase-uid-1',
      email: 'nitheesh@playxoft.com',
      emailVerified: true,
      displayName: 'Nitheesh',
      avatarUrl: 'https://example.test/a.png',
    });
  });

  // exactOptionalPropertyTypes: an absent claim must be an absent key, not a
  // present-and-undefined one, or it would blank a stored profile on re-login.
  it('omits absent profile fields rather than setting them to undefined', async () => {
    const provider = new FirebaseIdentityProvider(
      verifierReturning({
        sub: 'u',
        email: 'a@b.test',
        firebase: { sign_in_provider: 'password' },
      }),
    );
    const identity = await provider.verify('token');

    expect(Object.hasOwn(identity, 'displayName')).toBe(false);
    expect(Object.hasOwn(identity, 'avatarUrl')).toBe(false);
    expect(identity.emailVerified).toBe(false);
  });

  it('rejects a token with no email, which has no account to attach to', async () => {
    const provider = new FirebaseIdentityProvider(
      verifierReturning({ sub: 'u', firebase: { sign_in_provider: 'anonymous' } }),
    );
    await expect(provider.verify('token')).rejects.toBeInstanceOf(IdentityVerificationError);
  });

  it('rejects an empty or absurdly long token before doing any work', async () => {
    const verify = vi.fn();
    const provider = new FirebaseIdentityProvider({ verifyIdToken: verify });

    await expect(provider.verify('')).rejects.toBeInstanceOf(IdentityVerificationError);
    await expect(provider.verify('x'.repeat(8193))).rejects.toBeInstanceOf(
      IdentityVerificationError,
    );
    expect(verify).not.toHaveBeenCalled();
  });

  // The category is for dashboards; the client is told only that it failed.
  it('preserves the failure category for logs but not for the caller', async () => {
    const provider = new FirebaseIdentityProvider(
      verifierThrowing({ code: 'token-expired', message: 'The token expired at 12:00' }),
    );

    await expect(provider.verify('token')).rejects.toMatchObject({
      reason: 'token-expired',
      message: 'Identity verification failed',
    });
  });

  it('categorises an unrecognised failure without crashing', async () => {
    const provider = new FirebaseIdentityProvider(verifierThrowing('a bare string'));
    await expect(provider.verify('token')).rejects.toMatchObject({ reason: 'unknown' });
  });

  it('never asks Firebase to check revocation, which would cost a round trip', async () => {
    const verify = vi.fn(async () => claims);
    await new FirebaseIdentityProvider({ verifyIdToken: verify }).verify('token');

    expect(verify).toHaveBeenCalledWith('token', false, undefined, expect.any(Number));
  });
});

describe('in-memory JWKS cache', () => {
  it('returns nothing before anything is stored', async () => {
    await expect(new InMemoryKeyStore().get()).resolves.toBeNull();
  });

  it('round-trips a value and then expires it', async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryKeyStore();
      await store.put(JSON.stringify({ kid: 'cert' }), 60);
      await expect(store.get()).resolves.toEqual({ kid: 'cert' });

      vi.advanceTimersByTime(61_000);
      await expect(store.get()).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('rate limiting', () => {
  const limiter = (success: boolean): RateLimit => ({ limit: async () => ({ success }) });

  it('allows the request and reports that nothing was enforced when unbound', async () => {
    await expect(consume(bindings(), 'RL_LOGIN', 'k')).resolves.toEqual({
      allowed: true,
      enforced: false,
    });
  });

  it('enforces when the binding is present', async () => {
    const env = bindings({ RL_LOGIN: limiter(false) });
    await expect(consume(env, 'RL_LOGIN', 'k')).resolves.toEqual({
      allowed: false,
      enforced: true,
    });
    await expect(enforce(env, 'RL_LOGIN', 'k')).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('passes the caller-supplied key straight through to the binding', async () => {
    const limit = vi.fn(async () => ({ success: true }));
    await consume(bindings({ RL_MUTATION: { limit } }), 'RL_MUTATION', 'org:1');
    expect(limit).toHaveBeenCalledWith({ key: 'org:1' });
  });

  // Two inputs must never be able to produce one key, or one account's limit
  // could be consumed by traffic aimed at another.
  it('encodes key parts so a separator inside a value cannot collide', () => {
    expect(attemptKey('1.2.3.4', 'a:b')).not.toBe(attemptKey('1.2.3.4:a', 'b'));
  });

  it('lower-cases the subject so casing cannot multiply an attacker’s budget', () => {
    expect(attemptKey('1.2.3.4', 'User@Example.com')).toBe(
      attemptKey('1.2.3.4', 'user@example.com'),
    );
  });

  it('represents an unknown IP distinctly rather than as an empty string', () => {
    expect(attemptKey(null, 'a@b.test')).toBe('-:a%40b.test');
  });
});

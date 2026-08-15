import { afterEach, describe, expect, it, vi } from 'vitest';

import { describeOutcome, describeRequest } from './describe-request';
import { defaultLogLevel } from './index';
import { createLogger, silentLogger } from './logger';
import { describeError, errorName, isSensitiveKey, redactFields, scrubText } from './redact';
import { BETTERSTACK_DEFAULT_URL, BetterStackSink, fanOut } from './sinks';
import { isLogLevel } from './types';
import type { LogEntry, LogSink } from './types';
import type { Bindings } from '../bindings';

/** A sink that keeps everything, so a test can assert on the finished line. */
function collectingSink(): LogSink & { entries: LogEntry[]; flushes: number } {
  const entries: LogEntry[] = [];
  return {
    entries,
    flushes: 0,
    write(entry) {
      entries.push(entry);
    },
    flush() {
      this.flushes += 1;
      return Promise.resolve();
    },
  };
}

const FIXED_NOW = Date.parse('2026-08-15T09:00:00.000Z');

describe('request descriptions', () => {
  /** The message an operator would actually read for this request. */
  function sentence(method: string, path: string, status: number): string {
    return describeOutcome(describeRequest(method, path), status);
  }

  const SECRET = '/api/orgs/acme/projects/api/environments/production/secrets/DATABASE_URL';

  it('names the action and the resource, not the framework', () => {
    expect(sentence('GET', SECRET, 200)).toBe(
      'Revealed the secret DATABASE_URL in acme/api/production',
    );
    expect(sentence('PUT', SECRET, 200)).toBe(
      'Wrote a new version of the secret DATABASE_URL in acme/api/production',
    );
    expect(sentence('DELETE', SECRET, 204)).toBe(
      'Deleted the secret DATABASE_URL from acme/api/production',
    );
  });

  // "Refused" and "Failed" are different incidents, and a reader should not have
  // to check a status code to tell them apart.
  it('changes the verb with the kind of outcome', () => {
    expect(sentence('GET', SECRET, 403)).toBe(
      'Refused to reveal the secret DATABASE_URL in acme/api/production',
    );
    expect(sentence('GET', SECRET, 404)).toBe(
      'Refused to reveal the secret DATABASE_URL in acme/api/production',
    );
    expect(sentence('GET', SECRET, 400)).toBe(
      'Rejected a request to reveal the secret DATABASE_URL in acme/api/production',
    );
    expect(sentence('GET', SECRET, 500)).toBe(
      'Failed to reveal the secret DATABASE_URL in acme/api/production',
    );
  });

  it('describes the whole-environment reads that matter most', () => {
    const base = '/api/orgs/acme/projects/api/environments/production';
    expect(sentence('GET', `${base}/pull`, 200)).toBe(
      'Decrypted every secret in acme/api/production',
    );
    expect(sentence('GET', `${base}/export`, 200)).toBe(
      'Exported every secret in acme/api/production as a document',
    );
    expect(sentence('GET', `${base}/secrets`, 200)).toBe(
      'Listed the secrets in acme/api/production',
    );
  });

  it('describes version history and restores', () => {
    expect(sentence('GET', `${SECRET}/versions`, 200)).toBe(
      'Listed the version history of the secret DATABASE_URL in acme/api/production',
    );
    expect(sentence('GET', `${SECRET}/versions/3`, 200)).toBe(
      'Revealed version 3 of the secret DATABASE_URL in acme/api/production',
    );
    expect(sentence('POST', `${SECRET}/restore`, 200)).toBe(
      'Restored the secret DATABASE_URL in acme/api/production to an earlier version',
    );
  });

  it('describes the account and organisation routes', () => {
    expect(sentence('POST', '/api/auth/session', 200)).toBe(
      'Signed the user in and issued a new session',
    );
    expect(sentence('DELETE', '/api/auth/session', 204)).toBe(
      'Signed the user out and revoked their session',
    );
    expect(sentence('POST', '/api/auth/pin/unlock', 200)).toBe(
      'Unlocked the session with the account PIN',
    );
    expect(sentence('POST', '/api/orgs/acme/members', 201)).toBe('Invited a new member to acme');
    expect(sentence('GET', '/api/orgs/acme/audit', 200)).toBe('Read the audit log for acme');
    expect(sentence('POST', '/api/orgs/acme/tokens/service', 201)).toBe(
      'Minted a new service token for acme',
    );
  });

  it('carries a stable event key beside the prose', () => {
    // The prose is for reading and will be rephrased; a dashboard groups on
    // this, and must not break when somebody improves a sentence.
    expect(describeRequest('GET', SECRET).event).toBe('secret.reveal');
    expect(
      describeRequest('GET', '/api/orgs/acme/projects/api/environments/production/pull').event,
    ).toBe('secret.pull');
    expect(describeRequest('POST', '/api/auth/session').event).toBe('auth.login');
  });

  // A route with no entry is a gap in the mapping, not a reason to say nothing.
  it('still names the method and path for an unmapped route', () => {
    expect(sentence('GET', '/api/something/new', 200)).toBe('Served GET /api/something/new');
    expect(describeRequest('GET', '/api/something/new').event).toBe('http.request');
  });

  it('bounds a path segment a caller controls', () => {
    const long = 'A'.repeat(300);
    const message = sentence(
      'GET',
      `/api/orgs/acme/projects/api/environments/dev/secrets/${long}`,
      200,
    );

    expect(message).toContain('…');
    expect(message.length).toBeLessThan(200);
  });

  it('decodes an escaped segment so the name reads as it was written', () => {
    expect(
      sentence('GET', '/api/orgs/acme/projects/api/environments/dev/secrets/MY%20KEY', 200),
    ).toBe('Revealed the secret MY KEY in acme/api/dev');
  });
});

describe('the level threshold', () => {
  it('accepts the four levels and nothing inherited from Object.prototype', () => {
    for (const level of ['debug', 'info', 'warn', 'error']) {
      expect(isLogLevel(level)).toBe(true);
    }

    // Regression: the check was `value in LOG_LEVEL_ORDER`, which walks the
    // prototype chain. `XECRET_LOG_LEVEL=toString` was therefore a valid level,
    // the threshold compared against a function, every `<` came out false
    // through `NaN`, and production emitted *every* line including `debug`. A
    // typo in an operator's environment turned the log bill and the debug
    // detail on with nothing to indicate it had.
    for (const inherited of ['toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
      expect(isLogLevel(inherited)).toBe(false);
    }
  });

  it('falls back to the environment default rather than trusting a bad value', () => {
    const env = (level: string): Bindings =>
      ({ XECRET_LOG_LEVEL: level, XECRET_ENV: 'production' }) as unknown as Bindings;

    expect(defaultLogLevel(env('warn'))).toBe('warn');
    expect(defaultLogLevel(env('toString'))).toBe('info');
  });
});

describe('redaction', () => {
  it('hides credential-shaped field names', () => {
    for (const key of [
      'value',
      'secretValue',
      'password',
      'pin',
      'pinHash',
      'apiToken',
      'cookie',
    ]) {
      expect(isSensitiveKey(key)).toBe(true);
    }
  });

  // The whole reason the identifier-suffix pass runs first: these all contain a
  // word from the deny list and all of them are what an investigation is
  // actually conducted with.
  it('keeps the identifier fields an investigation needs', () => {
    for (const key of [
      'tokenId',
      'sessionId',
      'requestId',
      'serviceTokenId',
      'tokenName',
      'secretName',
      'keyVersion',
      'requestedVersion',
      'accessLevel',
    ]) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });

  // The field the route wrapper binds on every authenticated line. It shipped as
  // `[redacted]` for the whole life of the feature, because it was called
  // `credential` — a word on the deny list — while the operations doc advertised
  // it as `cookie | bearer`. Nothing failed; the column was simply always blank.
  it('keeps the credential *kind*, which is a shape rather than a secret', () => {
    expect(isSensitiveKey('credential')).toBe(true);
    expect(isSensitiveKey('credentialKind')).toBe(false);
    expect(redactFields({ credentialKind: 'cookie' })).toEqual({ credentialKind: 'cookie' });
  });

  it('replaces a sensitive value rather than dropping the field', () => {
    // Present-but-hidden: "the object had a value column" is itself useful, and
    // a silently missing key reads as a bug in the code that built the line.
    expect(redactFields({ name: 'DB_URL', value: 'postgres://real' })).toEqual({
      name: 'DB_URL',
      value: '[redacted]',
    });
  });

  it('strips connection-string credentials out of free text', () => {
    // The documented leak: a postgres.js message can carry the whole DSN.
    expect(scrubText('connect ECONNREFUSED postgres://app:hunter2@db.internal:5432/xecret')).toBe(
      'connect ECONNREFUSED postgres://[redacted]@db.internal:5432/xecret',
    );
  });

  it('strips bearer tokens and inline credentials out of free text', () => {
    expect(scrubText('failed with Bearer xct_live_abcdefghijkl')).toBe(
      'failed with bearer [redacted]',
    );
    expect(scrubText('body was {"password": "hunter2"}')).toContain('password=[redacted]');
  });

  it('bounds strings, arrays and depth', () => {
    const long = 'a'.repeat(600);
    const redacted = redactFields({ long, list: Array.from({ length: 50 }, (_, i) => i) });

    expect(String(redacted['long'])).toHaveLength(513); // 512 plus the ellipsis
    expect((redacted['list'] as unknown[]).at(-1)).toBe('[+18 more]');

    // The guard is against unbounded *nesting*, so it fires on the container
    // rather than on a scalar — a string five levels down is still a string.
    const deep = redactFields({ a: { b: { c: { d: { e: { f: 'too far' } } } } } });
    expect(JSON.stringify(deep)).toContain('[truncated]');
    expect(JSON.stringify(deep)).not.toContain('too far');
  });

  it('serialises the awkward types a driver hands back', () => {
    const redacted = redactFields({
      when: new Date(FIXED_NOW),
      big: 10n,
      nope: Number.NaN,
      missing: undefined,
      nothing: null,
    });

    expect(redacted).toEqual({
      when: '2026-08-15T09:00:00.000Z',
      big: '10',
      nope: 'NaN',
      nothing: null,
    });
    expect('missing' in redacted).toBe(false);
  });

  it('describes an error with a bounded stack', () => {
    const described = describeError(new TypeError('bad input'));

    expect(described.name).toBe('TypeError');
    expect(described.message).toBe('bad input');
    expect(described.stack?.length).toBeGreaterThan(0);
    expect(described.stack?.length).toBeLessThanOrEqual(4);
  });

  it('scrubs the error message on the way in', () => {
    const described = describeError(new Error('postgres://app:hunter2@db/xecret is unreachable'));
    expect(described.message).not.toContain('hunter2');
  });

  it('reduces to a bare name where even a message is too much', () => {
    expect(errorName(new Error('mail to alice@example.com bounced'))).toBe('Error');
    expect(errorName('a string')).toBe('unknown');
  });
});

describe('logger', () => {
  it('merges request context, logger fields and call fields in that order', () => {
    const sink = collectingSink();
    const { logger } = createLogger({
      sink,
      minimum: 'debug',
      base: { service: 'xecret-web', requestId: 'r-1', stage: 'base' },
      now: () => FIXED_NOW,
    });

    logger.child({ stage: 'child' }).info('hello', { stage: 'call', extra: 1 });

    expect(sink.entries[0]).toMatchObject({
      dt: '2026-08-15T09:00:00.000Z',
      level: 'info',
      message: 'hello',
      service: 'xecret-web',
      requestId: 'r-1',
      stage: 'call',
      extra: 1,
    });
  });

  it('stamps the function name through at()', () => {
    const sink = collectingSink();
    const { logger } = createLogger({ sink, minimum: 'debug', now: () => FIXED_NOW });

    logger.at('revealSecret').warn('denied');

    expect(sink.entries[0]?.['fn']).toBe('revealSecret');
  });

  it('discards lines below the threshold', () => {
    const sink = collectingSink();
    const { logger } = createLogger({ sink, minimum: 'warn', now: () => FIXED_NOW });

    logger.debug('no');
    logger.info('no');
    logger.warn('yes');
    logger.error('yes');

    expect(sink.entries.map((entry) => entry.level)).toEqual(['warn', 'error']);
  });

  // The reason the request context is shared by reference rather than
  // snapshotted: the user id arrives from authentication, several lines into a
  // request whose loggers already exist.
  it('completes loggers created before the principal was known', () => {
    const sink = collectingSink();
    const { logger, bind } = createLogger({ sink, minimum: 'debug', now: () => FIXED_NOW });

    const service = logger.at('loadSecret');
    bind({ userId: 'u-1', orgId: 'o-1' });
    service.info('after');

    expect(sink.entries[0]).toMatchObject({ fn: 'loadSecret', userId: 'u-1', orgId: 'o-1' });
  });

  it('treats an undefined bind as "not known yet", never as an erase', () => {
    const sink = collectingSink();
    const { logger, bind } = createLogger({
      sink,
      minimum: 'debug',
      base: { orgId: 'o-1' },
      now: () => FIXED_NOW,
    });

    bind({ orgId: undefined, projectId: 'p-1' });
    logger.info('still scoped');

    expect(sink.entries[0]).toMatchObject({ orgId: 'o-1', projectId: 'p-1' });
  });

  it('will not let a caller overwrite the reserved fields', () => {
    const sink = collectingSink();
    const { logger } = createLogger({ sink, minimum: 'debug', now: () => FIXED_NOW });

    logger.error('real message', { level: 'debug', message: 'spoofed', dt: 'yesterday' });

    expect(sink.entries[0]).toMatchObject({
      level: 'error',
      message: 'real message',
      dt: '2026-08-15T09:00:00.000Z',
    });
  });

  it('redacts fields on the way into a line', () => {
    const sink = collectingSink();
    const { logger } = createLogger({ sink, minimum: 'debug', now: () => FIXED_NOW });

    logger.info('wrote', { name: 'API_KEY', value: 'sk_live_real' });

    expect(sink.entries[0]?.['value']).toBe('[redacted]');
  });

  it('silentLogger writes nowhere and still chains', () => {
    expect(() => silentLogger().at('x').child({ a: 1 }).error('boom')).not.toThrow();
  });
});

describe('Better Stack sink', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function entry(message: string): LogEntry {
    return { dt: '2026-08-15T09:00:00.000Z', level: 'info', message };
  }

  it('ships the whole request in one batched POST', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const sink = new BetterStackSink(
      { token: 'src-token', url: BETTERSTACK_DEFAULT_URL },
      collectingSink(),
    );
    sink.write(entry('one'));
    sink.write(entry('two'));
    await sink.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(BETTERSTACK_DEFAULT_URL);
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer src-token');
    expect(JSON.parse(init.body as string)).toHaveLength(2);
  });

  it('sends nothing when the request logged nothing', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    await new BetterStackSink({ token: 't', url: 'https://x' }, collectingSink()).flush();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  // One line, not a replay. `createSink` puts the console sink in the fan-out
  // *and* hands the same instance here, so every entry in the batch is already
  // on the Cloudflare tail; writing them back through it printed each one twice
  // and doubled the log volume during precisely the outage when an operator is
  // reading that tail. What is missing during a shipping failure is the
  // searchable copy, and that is all this line has to say.
  it('reports a shipping failure without replaying lines the console already has', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    const diagnostics = collectingSink();
    const sink = new BetterStackSink({ token: 't', url: 'https://x' }, diagnostics);
    sink.write(entry('one'));
    sink.write(entry('two'));
    await sink.flush();

    expect(diagnostics.entries).toHaveLength(1);
    expect(diagnostics.entries[0]).toMatchObject({ level: 'error', lines: 2 });
    expect(String(diagnostics.entries[0]?.message)).toContain('Could not ship 2 log line');
    expect(String(diagnostics.entries[0]?.message)).toContain('Cloudflare log tail');
  });

  it('degrades on a non-2xx as well as on a throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unrecognised source', { status: 401 })),
    );

    const diagnostics = collectingSink();
    const sink = new BetterStackSink({ token: 't', url: 'https://x' }, diagnostics);
    sink.write(entry('one'));
    await sink.flush();

    expect(String(diagnostics.entries[0]?.message)).toContain('Could not ship 1 log line');
    expect(String(diagnostics.entries[0]?.['reason'])).toContain('401');
  });

  // The reason quotes up to 200 bytes of an arbitrary remote response body, and
  // this is the one path that writes to a sink directly instead of through the
  // logger — so nothing else would scrub it. A 401 body echoing back the source
  // token it rejected is the obvious way that goes wrong.
  it('scrubs the remote response before quoting it as the reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response('Bearer src_tok_abcdefghijkl is not a source', { status: 401 }),
      ),
    );

    const diagnostics = collectingSink();
    const sink = new BetterStackSink({ token: 't', url: 'https://x' }, diagnostics);
    sink.write(entry('one'));
    await sink.flush();

    expect(String(diagnostics.entries[0]?.['reason'])).not.toContain('src_tok_abcdefghijkl');
    expect(String(diagnostics.entries[0]?.message)).not.toContain('src_tok_abcdefghijkl');
  });

  it('bounds the batch and reports what it dropped', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const sink = new BetterStackSink(
      { token: 't', url: 'https://x', maxBatch: 2 },
      collectingSink(),
    );
    sink.write(entry('one'));
    sink.write(entry('two'));
    sink.write(entry('three'));
    sink.write(entry('four'));
    await sink.flush();

    const shipped = JSON.parse(
      (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    ) as LogEntry[];

    expect(shipped).toHaveLength(3);
    expect(shipped[2]).toMatchObject({ droppedLines: 2, maxBatch: 2 });
    expect(String(shipped[2]?.message)).toContain('Dropped 2 log line');
  });

  it('a failing sink cannot strand another sink’s buffer', async () => {
    const healthy = collectingSink();
    const broken: LogSink = {
      write: () => undefined,
      flush: () => Promise.reject(new Error('nope')),
    };

    const combined = fanOut([broken, healthy]);
    combined.write(entry('one'));

    await expect(combined.flush()).resolves.toBeUndefined();
    expect(healthy.flushes).toBe(1);
  });
});

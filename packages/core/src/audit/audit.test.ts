import { describe, expect, it } from 'vitest';
import { generateToken, TOKEN_PREFIXES } from '../auth/tokens';
import { isUuid } from '../ids';
import { BufferedAuditRecorder, createAuditBuilder, InMemoryAuditSink, REDACTED } from './index';
import type {
  AuditContext,
  AuditDenial,
  AuditRecord,
  AuditResource,
  AuditSink,
  ActorType,
} from './index';
import {
  looksLikeCredential,
  redactUrlCredentials,
  redactValue,
  sanitizeMetadataString,
} from './redaction';

const context: AuditContext = {
  orgId: '018f3a1b-0000-7000-8000-000000000001',
  actorType: 'user',
  actorId: '018f3a1b-0000-7000-8000-000000000002',
  actorLabel: 'nitheesh@playxoft.com',
  ipAddress: '203.0.113.7',
  userAgent: 'xecret-cli/0.1.0',
  requestId: 'req_01HZY',
};

const secret: AuditResource = {
  type: 'secret',
  id: '018f3a1b-0000-7000-8000-000000000003',
  projectId: '018f3a1b-0000-7000-8000-000000000004',
  environmentId: '018f3a1b-0000-7000-8000-000000000005',
};

const forbidden: AuditDenial = {
  allowed: false,
  reason: 'forbidden',
  message: 'You do not have access to the production environment.',
};

function builderWith(overrides: Partial<AuditContext> = {}) {
  return createAuditBuilder({ ...context, ...overrides });
}

/** A lone surrogate is what PostgreSQL rejects in a `jsonb` string. */
function hasLoneSurrogate(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 0xd800 && code <= 0xdfff;
  });
}

describe('the type system, not the developer, keeps secret values out of a record', () => {
  it('will not compile a metadata object carrying a value, and drops it at runtime', () => {
    const record = builderWith().success('secret.created', secret, {
      secretName: 'DATABASE_URL',
      // @ts-expect-error - `AuditMetadata` is an allowlist with no `value` field and no index
      // signature. If this line ever stops being an error, the guarantee this module exists
      // to provide has been lost and this test fails loudly.
      value: 'hunter2',
    });

    expect(JSON.stringify(record.metadata)).not.toContain('hunter2');
    expect(record.metadata).toEqual({ secretName: 'DATABASE_URL' });
  });

  it('will not compile a caller-supplied reason on a denial', () => {
    const record = builderWith().denied('secret.read', secret, forbidden, {
      // @ts-expect-error - the reason on a denial comes from the decision, never the caller.
      reason: 'nothing to see here',
    });

    expect(record.metadata.reason).toBe('forbidden');
  });
});

describe('metadata sanitisation', () => {
  it('strips the newline that would let a secret name forge a second log line', () => {
    const record = builderWith().success('secret.created', secret, {
      secretName: 'DATABASE_URL\n2026-08-11 owner@example.com deleted PRODUCTION_KEY',
    });

    expect(record.metadata.secretName).not.toContain('\n');
    expect(record.metadata.secretName).toBe(
      'DATABASE_URL 2026-08-11 owner@example.com deleted PRODUCTION_KEY',
    );
  });

  it('strips carriage returns, tabs, NUL and other control characters', () => {
    const record = builderWith().success('secret.created', secret, {
      secretName: 'A\r\nB\tC\x00D\x07E',
    });

    expect(record.metadata.secretName).toBe('A B C D E');
  });

  it('strips invisible characters that would misrepresent the stored value', () => {
    const rightToLeftOverride = String.fromCharCode(0x202e);
    const lineSeparator = String.fromCharCode(0x2028);

    expect(sanitizeMetadataString(`API${rightToLeftOverride}_KEY`, 64)).toBe('API _KEY');
    expect(sanitizeMetadataString(`one${lineSeparator}two`, 64)).toBe('one two');
  });

  it('truncates a long value and marks that it was cut', () => {
    const record = builderWith().success('secret.created', secret, {
      secretName: 'N'.repeat(400),
    });

    expect(record.metadata.secretName).toHaveLength(256);
    expect(record.metadata.secretName?.endsWith('…')).toBe(true);
  });

  it('never truncates through the middle of a surrogate pair', () => {
    const astral = String.fromCodePoint(0x1f680);
    const truncated = sanitizeMetadataString(`LAUNCH_${astral}${astral}`, 9);

    expect(truncated).toBe('LAUNCH_…');
    expect(hasLoneSurrogate(truncated)).toBe(false);
  });

  it('redacts before truncating, so a length limit cannot smuggle a credential through', () => {
    // Truncating first would leave `ghp_aaaaaa`, which no pattern matches.
    expect(sanitizeMetadataString(`ghp_${'a'.repeat(36)}`, 10)).toBe(REDACTED);
  });

  it('returns nothing at all for a non-positive length', () => {
    expect(sanitizeMetadataString('anything', 0)).toBe('');
  });

  it('sanitises every string field the allowlist accepts', () => {
    const record = builderWith().success('member.role_changed', secret, {
      environmentSlug: 'produc\ntion',
      projectSlug: 'pay\tments',
      targetEmail: 'new\r@example.com',
      previousRole: 'view\ner',
      newRole: 'admi\nn',
      tokenPrefix: 'xct_live\n_a1b2',
      reason: 'promoted\nby owner',
    });

    for (const value of Object.values(record.metadata)) {
      expect(String(value)).not.toContain('\n');
    }
    expect(record.metadata.environmentSlug).toBe('produc tion');
    expect(record.metadata.targetEmail).toBe('new @example.com');
  });

  it('keeps numeric and enumerated fields as given', () => {
    const record = builderWith().success('secret.imported', secret, {
      secretCount: 42,
      keyVersion: 2,
      source: 'cli',
    });

    expect(record.metadata).toEqual({ secretCount: 42, keyVersion: 2, source: 'cli' });
  });

  it('drops a non-finite number rather than storing it as null', () => {
    const record = builderWith().success('secret.imported', secret, {
      secretCount: Number.NaN,
      keyVersion: Number.POSITIVE_INFINITY,
    });

    expect(record.metadata).toEqual({});
  });

  it('sanitises the user agent, which is entirely attacker-chosen', () => {
    const record = builderWith({ userAgent: 'curl/8.0\nFORGED LINE' }).success('auth.login', null);
    expect(record.userAgent).toBe('curl/8.0 FORGED LINE');
  });

  it('records a user agent of nothing but control characters as absent', () => {
    const record = builderWith({ userAgent: '\n\r\t' }).success('auth.login', null);
    expect(record.userAgent).toBeNull();
  });

  it('accepts a request that carries no user agent or request id', () => {
    const record = builderWith({ userAgent: null, requestId: null }).success('auth.login', null);

    expect(record.userAgent).toBeNull();
    expect(record.requestId).toBeNull();
  });
});

describe('credential detection — values that must never reach a log', () => {
  it('recognises a real token of every xecret class', async () => {
    for (const kind of ['session', 'cli', 'service', 'invitation'] as const) {
      const { token } = await generateToken(kind);
      expect(looksLikeCredential(token)).toBe(true);
    }
  });

  it('covers every prefix the auth layer defines, so a new class cannot escape it', () => {
    for (const prefix of Object.values(TOKEN_PREFIXES)) {
      expect(looksLikeCredential(`${prefix}_live_${'a'.repeat(43)}`)).toBe(true);
    }
  });

  it('recognises AWS access key ids', () => {
    expect(looksLikeCredential('AKIAIOSFODNN7EXAMPLE')).toBe(true);
    expect(looksLikeCredential('ASIAY34FZKBOKMSXQNTP')).toBe(true);
  });

  it('recognises GitHub tokens', () => {
    const body = '16C7e42F292c6912E7710c838347Ae178B4a';
    expect(looksLikeCredential(`ghp_${body}`)).toBe(true);
    expect(looksLikeCredential(`gho_${body}`)).toBe(true);
    expect(looksLikeCredential(`ghs_${body}`)).toBe(true);
    expect(looksLikeCredential('github_pat_11ABCDEFG0abcdefghijklmn_ABCDEFGHIJKLMNOPQRSTUVW')).toBe(
      true,
    );
  });

  it('recognises Slack tokens', () => {
    expect(looksLikeCredential('xoxb-123456789012-1234567890123-abcdefghijklmnopqrst')).toBe(true);
    expect(looksLikeCredential('xoxp-123456789012-1234567890123-abcdefghijklmnopqrst')).toBe(true);
  });

  it('recognises Stripe keys', () => {
    expect(looksLikeCredential('sk_live_4eC39HqLyjWDarjtT1zdp7dc')).toBe(true);
    expect(looksLikeCredential('rk_live_4eC39HqLyjWDarjtT1zdp7dc')).toBe(true);
  });

  it('recognises Google API keys', () => {
    expect(looksLikeCredential('AIzaSyD-1234567890abcdefghijklmnopqrstu')).toBe(true);
  });

  it('recognises a PEM private key header', () => {
    expect(looksLikeCredential('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
    expect(looksLikeCredential('-----BEGIN PRIVATE KEY-----')).toBe(true);
  });

  it('recognises a JWT', () => {
    expect(
      looksLikeCredential(
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      ),
    ).toBe(true);
  });

  it('recognises a connection string carrying a password', () => {
    expect(looksLikeCredential('postgres://app_rw:hunter2@db.internal:5432/xecret')).toBe(true);
  });

  it('recognises an unrecognised high-entropy blob', () => {
    expect(
      looksLikeCredential('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'),
    ).toBe(true);
    expect(looksLikeCredential('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')).toBe(true);
  });

  it('finds a credential pasted into the middle of a sentence', () => {
    expect(
      looksLikeCredential('rotated ghp_16C7e42F292c6912E7710c838347Ae178B4a this morning'),
    ).toBe(true);
  });
});

describe('credential detection — values a heuristic must leave alone', () => {
  // A detector that says yes to everything is not a detector, and each false
  // positive here would erase something an operator needs during an incident.
  it.each([
    'production',
    'DATABASE_URL',
    'MY_VERY_LONG_SECRET_NAME_FOR_THE_PRODUCTION_ENVIRONMENT',
    'production-eu-west-1-primary',
    'PRODUCTIONDATABASECONNECTIONSTRING',
    'Rotated because the on-call engineer left the company.',
    'nitheesh@playxoft.com',
    '018f3a1b-0000-7000-8000-000000000001',
    'https://xecret.dev/docs/secrets',
    'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    '',
  ])('leaves %j alone', (value) => {
    expect(looksLikeCredential(value)).toBe(false);
  });
});

describe('URL credential redaction', () => {
  it('replaces the password and keeps everything that makes the record useful', () => {
    expect(redactUrlCredentials('postgres://app_rw:hunter2@db.internal:5432/xecret')).toBe(
      `postgres://app_rw:${REDACTED}@db.internal:5432/xecret`,
    );
  });

  it('leaves a URL with no userinfo untouched', () => {
    const url = 'https://db.internal:5432/xecret?sslmode=require';
    expect(redactUrlCredentials(url)).toBe(url);
  });

  it('leaves an @ in the path untouched', () => {
    const url = 'https://xecret.dev/users/@nitheesh/settings';
    expect(redactUrlCredentials(url)).toBe(url);
  });

  it('does not mistake a port for a password', () => {
    const url = 'https://db.internal:5432/@nitheesh';
    expect(redactUrlCredentials(url)).toBe(url);
  });

  it('redacts every URL in the value, not just the first', () => {
    const redacted = redactUrlCredentials(
      'primary redis://u1:p1@a.internal replica redis://u2:p2@b.internal',
    );

    expect(redacted).toBe(
      `primary redis://u1:${REDACTED}@a.internal replica redis://u2:${REDACTED}@b.internal`,
    );
  });

  it('is idempotent, and its output is no longer a finding', () => {
    const once = redactUrlCredentials('postgres://app_rw:hunter2@db.internal/xecret');

    expect(redactUrlCredentials(once)).toBe(once);
    expect(looksLikeCredential(once)).toBe(false);
  });

  it('keeps the host when a connection string is pasted into a metadata field', () => {
    const record = builderWith().success('secret.created', secret, {
      reason: 'imported from postgres://app_rw:hunter2@db.internal/xecret',
    });

    expect(record.metadata.reason).toBe(
      `imported from postgres://app_rw:${REDACTED}@db.internal/xecret`,
    );
  });
});

describe('redactValue', () => {
  it('is a fixed marker that reveals neither a prefix nor a length', () => {
    expect(redactValue('hunter2')).toBe(REDACTED);
    expect(redactValue('a much longer secret value than that one')).toBe(REDACTED);
    expect(redactValue('hunter2')).not.toContain('hunt');
  });

  it('leaves nothing behind that still looks like a credential', () => {
    for (const value of [
      'sk_live_4eC39HqLyjWDarjtT1zdp7dc',
      '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      'postgres://app_rw:hunter2@db.internal/xecret',
    ]) {
      expect(looksLikeCredential(sanitizeMetadataString(value, 256))).toBe(false);
    }
  });
});

describe('event construction', () => {
  it('carries the request context onto every record', () => {
    const record = builderWith().success('secret.read', secret);

    expect(record).toMatchObject({
      orgId: context.orgId,
      actorType: 'user',
      actorId: context.actorId,
      actorLabel: 'nitheesh@playxoft.com',
      action: 'secret.read',
      outcome: 'success',
      ipAddress: '203.0.113.7',
      userAgent: 'xecret-cli/0.1.0',
      requestId: 'req_01HZY',
    });
  });

  it('denormalises project and environment so the audit UI filters without a join', () => {
    const record = builderWith().success('secret.read', secret);

    expect(record.resourceType).toBe('secret');
    expect(record.resourceId).toBe(secret.id);
    expect(record.projectId).toBe(secret.projectId);
    expect(record.environmentId).toBe(secret.environmentId);
  });

  it('records an org-level action that has no resource', () => {
    const record = builderWith().success('auth.login', null, { source: 'dashboard' });

    expect(record.resourceType).toBeNull();
    expect(record.resourceId).toBeNull();
    expect(record.projectId).toBeNull();
    expect(record.environmentId).toBeNull();
  });

  it('leaves project and environment null when the resource does not name them', () => {
    const record = builderWith().success('project.created', { type: 'project', id: null });

    expect(record.resourceId).toBeNull();
    expect(record.projectId).toBeNull();
  });

  it('gives every record a distinct UUIDv7 that sorts in creation order', () => {
    const builder = builderWith();
    const ids = Array.from({ length: 500 }, () => builder.success('secret.read', secret).id);

    expect(new Set(ids).size).toBe(500);
    expect(ids.every(isUuid)).toBe(true);
    expect(ids.every((id) => id[14] === '7')).toBe(true);
    expect([...ids].sort()).toEqual(ids);
  });
});

describe('denials are recorded as loudly as successes', () => {
  it('records the outcome and the reason the authorization engine gave', () => {
    const record = builderWith().denied('secret.read', secret, forbidden);

    expect(record.outcome).toBe('denied');
    expect(record.metadata.reason).toBe('forbidden');
  });

  it('distinguishes a cross-tenant probe from an ordinary refusal', () => {
    const notFound: AuditDenial = {
      allowed: false,
      reason: 'notFound',
      message: 'No such project.',
    };
    const record = builderWith().denied('project.deleted', secret, notFound);

    expect(record.metadata.reason).toBe('notFound');
  });

  it('keeps the context that makes a denial worth alerting on', () => {
    const record = builderWith().denied('secret.read', secret, forbidden, {
      secretName: 'STRIPE_LIVE_KEY',
      environmentSlug: 'production',
    });

    expect(record.metadata).toEqual({
      secretName: 'STRIPE_LIVE_KEY',
      environmentSlug: 'production',
      reason: 'forbidden',
    });
  });

  it('records a failure as a category, never as an exception message', () => {
    const record = builderWith().error('secret.read', secret, 'decryptionFailed');

    expect(record.outcome).toBe('error');
    expect(record.metadata.reason).toBe('decryptionFailed');
  });
});

describe('actor labelling', () => {
  it('denormalises the label so the record still reads correctly after deletion', () => {
    const record = builderWith().success('secret.deleted', secret);
    expect(record.actorLabel).toBe('nitheesh@playxoft.com');
  });

  it.each([
    ['user', '(deleted user)'],
    ['cli_token', '(deleted CLI token)'],
    ['service_token', '(deleted service token)'],
    ['system', 'system'],
  ] as ReadonlyArray<readonly [ActorType, string]>)(
    'describes an unlabelled %s honestly rather than leaving the column empty',
    (actorType, expected) => {
      const record = builderWith({ actorType, actorLabel: null }).success('secret.read', secret);
      expect(record.actorLabel).toBe(expected);
    },
  );

  it('treats a blank label as no label', () => {
    const record = builderWith({ actorLabel: '   ' }).success('secret.read', secret);
    expect(record.actorLabel).toBe('(deleted user)');
  });

  it('claims no actor at all when there is no id to attach one to', () => {
    const record = builderWith({ actorId: null, actorLabel: null }).success(
      'auth.login_failed',
      null,
    );
    expect(record.actorLabel).toBeNull();
  });

  it('sanitises a label, which is a name the actor chose for themselves', () => {
    const record = builderWith({ actorLabel: 'mallory\nadmin@example.com' }).success(
      'secret.read',
      secret,
    );
    expect(record.actorLabel).toBe('mallory admin@example.com');
  });
});

describe('BufferedAuditRecorder', () => {
  function records(count: number): AuditRecord[] {
    const builder = builderWith();
    return Array.from({ length: count }, () => builder.success('secret.read', secret));
  }

  it('writes the whole request in one batch, in order', async () => {
    const sink = new InMemoryAuditSink();
    const recorder = new BufferedAuditRecorder(sink);
    const events = records(3);

    recorder.record(...events);
    expect(recorder.size).toBe(3);
    await recorder.flush();

    expect(sink.batches).toHaveLength(1);
    expect(sink.events.map((event) => event.id)).toEqual(events.map((event) => event.id));
    expect(recorder.size).toBe(0);
  });

  it('flushes exactly once, however many times it is asked', async () => {
    const sink = new InMemoryAuditSink();
    const recorder = new BufferedAuditRecorder(sink);

    recorder.record(...records(2));
    await recorder.flush();
    await recorder.flush();

    expect(sink.batches).toHaveLength(1);
  });

  it('shares one write between concurrent flushes', async () => {
    const sink = new InMemoryAuditSink();
    const recorder = new BufferedAuditRecorder(sink);

    recorder.record(...records(2));
    await Promise.all([recorder.flush(), recorder.flush()]);

    expect(sink.batches).toHaveLength(1);
  });

  it('writes nothing when there is nothing to write', async () => {
    const sink = new InMemoryAuditSink();
    await new BufferedAuditRecorder(sink).flush();

    expect(sink.batches).toHaveLength(0);
  });

  it('propagates a sink failure instead of swallowing it', async () => {
    const failing: AuditSink = {
      write: () => Promise.reject(new Error('connection reset')),
    };
    const recorder = new BufferedAuditRecorder(failing);
    recorder.record(...records(2));

    await expect(recorder.flush()).rejects.toThrow('connection reset');
  });

  it('keeps every event when a flush fails, so nothing is lost silently', async () => {
    let attempt = 0;
    const sink = new InMemoryAuditSink();
    const flaky: AuditSink = {
      write: (events) => {
        attempt += 1;
        return attempt === 1 ? Promise.reject(new Error('connection reset')) : sink.write(events);
      },
    };

    const recorder = new BufferedAuditRecorder(flaky);
    recorder.record(...records(2));

    await expect(recorder.flush()).rejects.toThrow('connection reset');
    expect(recorder.size).toBe(2);

    await recorder.flush();
    expect(sink.events).toHaveLength(2);
    expect(recorder.size).toBe(0);
  });

  it('keeps events recorded while a write was in flight', async () => {
    const sink = new InMemoryAuditSink();
    const late = records(1);
    const recorder = new BufferedAuditRecorder({
      write: async (events) => {
        recorder.record(...late);
        await sink.write(events);
      },
    });

    recorder.record(...records(2));
    await recorder.flush();

    expect(sink.events).toHaveLength(2);
    expect(recorder.size).toBe(1);
  });
});

describe('every declared metadata field survives sanitisation', () => {
  // `sanitizeMetadata` rebuilds the object field by field with no loop, so a
  // field added to `AuditMetadata` but not to the sanitiser is silently dropped
  // before the INSERT. That happened to `deviceName`, `sessionCount` and
  // `valueType` once; this test makes the omission a failure instead.
  it('copies each field through, sanitised', () => {
    const record = builderWith().success('member.role_changed', null, {
      secretName: 'DATABASE_URL',
      secretCount: 3,
      environmentSlug: 'production',
      projectSlug: 'api',
      targetEmail: 'new@example.com',
      previousRole: 'viewer',
      newRole: 'developer',
      previousAccessLevel: 'read',
      newAccessLevel: 'write',
      tokenPrefix: 'xst_live_abc',
      deviceName: 'work-laptop',
      keyVersion: 2,
      sessionCount: 4,
      valueType: 'url',
      reason: 'rotation',
      source: 'dashboard',
    });

    expect(record.metadata).toEqual({
      secretName: 'DATABASE_URL',
      secretCount: 3,
      environmentSlug: 'production',
      projectSlug: 'api',
      targetEmail: 'new@example.com',
      previousRole: 'viewer',
      newRole: 'developer',
      previousAccessLevel: 'read',
      newAccessLevel: 'write',
      // A display prefix still matches the credential detector — it is the
      // first twelve characters of a real token — and the detector deliberately
      // does not carve out an exception for it. Conservative loses nothing
      // here: the prefix is recoverable from the token row the record points at.
      tokenPrefix: REDACTED,
      deviceName: 'work-laptop',
      keyVersion: 2,
      sessionCount: 4,
      valueType: 'url',
      reason: 'rotation',
      source: 'dashboard',
    });
  });

  it('sanitises the attacker-influenced additions like every other string', () => {
    const record = builderWith().success('token.created', null, {
      deviceName: 'lap\ntop ',
      previousAccessLevel: 'read only',
    });

    expect(record.metadata.deviceName).toBe('lap top');
    expect(record.metadata.previousAccessLevel).toBe('read only');
  });

  it('drops a non-finite session count rather than storing null', () => {
    const record = builderWith().success('auth.locked', null, { sessionCount: Number.NaN });

    expect(record.metadata).toEqual({});
  });
});

describe('InMemoryAuditSink', () => {
  it('copies each batch, so a caller reusing its array cannot rewrite history', async () => {
    const sink = new InMemoryAuditSink();
    const batch = [builderWith().success('secret.read', secret)];

    await sink.write(batch);
    batch.length = 0;

    expect(sink.events).toHaveLength(1);
    expect(sink.batches[0]).toHaveLength(1);
  });
});

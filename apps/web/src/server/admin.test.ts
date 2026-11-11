import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Principal } from './actor';
import { ADMIN_ACTOR_LABEL, adminAudit, adminEmails, isAdmin, requireAdmin } from './admin';
import type { Bindings } from './bindings';
import type { ServiceContext } from './context';
import { ApiError } from './errors';
import { createLogger } from './logging';
import type { LogEntry } from './logging';

/**
 * The admin allow-list (`server/admin.ts`): one environment variable is the
 * whole of the gate in front of a page that hands out paid plans, so every
 * way of misreading it must fail closed — nobody, never everybody.
 */

const envWith = (raw: string | undefined): Bindings =>
  ({ XECRET_ADMIN_EMAILS: raw }) as unknown as Bindings;

function session(email: string, emailVerified = true): Principal {
  return {
    kind: 'user',
    sessionId: randomUUID(),
    user: { id: randomUUID(), email, emailVerified, displayName: 'Admin', avatarUrl: null },
    vaultUnlockedAt: new Date(),
    lastSeenAt: new Date(),
    vaultAutoLockMinutes: null,
    signIn: { method: 'password', ssoWorkosOrgId: null },
  };
}

const cliToken = (): Principal => ({
  kind: 'cliToken',
  tokenId: randomUUID(),
  tokenName: 'laptop',
  userId: randomUUID(),
  orgId: randomUUID(),
  signIn: { method: 'password', ssoWorkosOrgId: null },
});

const serviceToken = (): Principal => ({
  kind: 'serviceToken',
  tokenId: randomUUID(),
  tokenName: 'ci',
  orgId: randomUUID(),
  projectId: randomUUID(),
  environmentId: randomUUID(),
  accessLevel: 'read',
});

describe('adminEmails', () => {
  it('reads a JSON array of addresses, lower-cased', () => {
    expect([...adminEmails('["Ops@Example.com", "second@example.org"]')]).toEqual([
      'ops@example.com',
      'second@example.org',
    ]);
  });

  it('reads a list separated by commas, semicolons, spaces or newlines', () => {
    for (const raw of [
      'a@example.com,b@example.com',
      'a@example.com; b@example.com',
      'a@example.com\nb@example.com',
      '  a@example.com \t b@example.com  ',
      'a@example.com,,;\n b@example.com,',
    ]) {
      expect([...adminEmails(raw)], JSON.stringify(raw)).toEqual([
        'a@example.com',
        'b@example.com',
      ]);
    }
  });

  it('matches whatever case the address was written in, and de-duplicates it', () => {
    expect([...adminEmails('Admin@Example.COM, admin@example.com')]).toEqual(['admin@example.com']);
  });

  it('fails closed on JSON that is not an array — nobody, rather than a guess', () => {
    expect(adminEmails('["a@example.com"').size).toBe(0);
    expect(adminEmails('[a@example.com]').size).toBe(0);
    // Starts like an array but is not one: unreadable, so nobody.
    expect(adminEmails('[}').size).toBe(0);
    // An object or a quoted string is JSON, but not a list: nobody, never the
    // address inside it, nor a fragment of it that looks like one.
    expect(adminEmails('{"admin":"a@example.com"}').size).toBe(0);
    expect(adminEmails('"a@example.com"').size).toBe(0);
    // Pasted punctuation never becomes part of an address.
    expect([...adminEmails('"a@example.com", b@example.com')]).toEqual([]);
    expect([...adminEmails('a@example.com, b@example.com;')]).toEqual([
      'a@example.com',
      'b@example.com',
    ]);
  });

  it('skips entries of a JSON array that are not strings, and keeps the ones that are', () => {
    expect([...adminEmails('[1, null, {"email":"x@example.com"}, "ok@example.com"]')]).toEqual([
      'ok@example.com',
    ]);
    expect(adminEmails('[1, true, null]').size).toBe(0);
  });

  it('never lets a wildcard, a bare @ or a word stand for an address', () => {
    expect(adminEmails('*').size).toBe(0);
    expect(adminEmails('@').size).toBe(0);
    expect(adminEmails('foo').size).toBe(0);
    expect(adminEmails('*@*').size).toBe(0);
    expect(adminEmails('@example.com').size).toBe(0);
    expect(adminEmails('admin@localhost').size).toBe(0);
    expect([...adminEmails('*, @, foo, real@example.com')]).toEqual(['real@example.com']);
    expect([...adminEmails('["*", "@", "foo", "real@example.com"]')]).toEqual(['real@example.com']);
  });

  it('is empty when unset, empty or only whitespace', () => {
    expect(adminEmails(undefined).size).toBe(0);
    expect(adminEmails('').size).toBe(0);
    expect(adminEmails('   \n\t ').size).toBe(0);
    expect(adminEmails('[]').size).toBe(0);
  });
});

describe('isAdmin', () => {
  const env = envWith('ops@example.com, other@example.com');

  it('admits a session whose verified address is on the list, whatever its case', () => {
    expect(isAdmin(env, session('ops@example.com'))).toBe(true);
    expect(isAdmin(env, session('OPS@Example.com'))).toBe(true);
  });

  it('folds case in ASCII only, so a look-alike letter never stands in for an admin', () => {
    // U+212A KELVIN SIGN lower-cases to "k" in Unicode; an address carrying
    // it is somebody else's mailbox, and is not on any list.
    const kelly = envWith('kelly@example.com');
    expect(isAdmin(kelly, session('Kelly@example.com'))).toBe(false);
    expect(adminEmails('Kelly@example.com').size).toBe(0);
    expect(isAdmin(kelly, session('KELLY@example.com'))).toBe(true);
  });

  it('refuses an address on the list that was never verified', () => {
    expect(isAdmin(env, session('ops@example.com', false))).toBe(false);
  });

  it('refuses an address that is not on the list', () => {
    expect(isAdmin(env, session('someone@example.com'))).toBe(false);
    // A list entry is matched whole, never as a suffix or a prefix.
    expect(isAdmin(env, session('xops@example.com'))).toBe(false);
    expect(isAdmin(env, session('ops@example.com.evil.test'))).toBe(false);
  });

  it('refuses every token — CLI and service alike — whoever it belongs to', () => {
    expect(isAdmin(env, cliToken())).toBe(false);
    expect(isAdmin(env, serviceToken())).toBe(false);
  });

  it('refuses everybody when the variable is unset or unreadable', () => {
    expect(isAdmin(envWith(undefined), session('ops@example.com'))).toBe(false);
    expect(isAdmin(envWith(''), session('ops@example.com'))).toBe(false);
    expect(isAdmin(envWith('["ops@example.com"'), session('ops@example.com'))).toBe(false);
  });
});

describe('requireAdmin', () => {
  function services(raw: string | undefined): { services: ServiceContext; lines: LogEntry[] } {
    const lines: LogEntry[] = [];
    const log = createLogger({
      sink: { write: (entry) => lines.push(entry), flush: () => Promise.resolve() },
      minimum: 'debug',
    }).logger;
    return { services: { env: envWith(raw), log } as unknown as ServiceContext, lines };
  }

  it('hands an admin back as the session it is', () => {
    const admin = session('ops@example.com');
    expect(requireAdmin(services('ops@example.com').services, admin)).toBe(admin);
  });

  it('answers anybody else the 404 an unknown path gets, and logs the refusal', () => {
    const { services: context, lines } = services('ops@example.com');
    for (const principal of [session('someone@example.com'), cliToken(), serviceToken()]) {
      let thrown: unknown;
      try {
        requireAdmin(context, principal);
      } catch (cause) {
        thrown = cause;
      }
      expect(thrown).toBeInstanceOf(ApiError);
      expect((thrown as ApiError).status).toBe(404);
      expect((thrown as ApiError).code).toBe('not_found');
    }
    const warnings = lines.filter((line) => line.level === 'warn');
    expect(warnings).toHaveLength(3);
    // The address of whoever knocked is not what the line is for.
    expect(JSON.stringify(warnings)).not.toContain('someone@example.com');
  });
});

describe('adminAudit', () => {
  it('attributes the change to xecret support, as the system — never the admin’s IP or browser', () => {
    const orgId = randomUUID();
    const meta = { ipAddress: '203.0.113.9', userAgent: 'vitest', requestId: 'req_admin_1' };
    const record = adminAudit({ meta } as unknown as ServiceContext, orgId).success(
      'plan.changed',
      null,
      { operator: ADMIN_ACTOR_LABEL, plan: 'team' },
    );
    expect(record).toMatchObject({
      orgId,
      actorType: 'system',
      actorId: null,
      actorLabel: ADMIN_ACTOR_LABEL,
      // Every owner of the organisation reads this row; the request's address
      // and agent are the staff member's, and stay on the server's log line.
      ipAddress: null,
      userAgent: null,
      requestId: 'req_admin_1',
      outcome: 'success',
      metadata: { operator: ADMIN_ACTOR_LABEL, plan: 'team' },
    });
    expect(ADMIN_ACTOR_LABEL).toBe('xecret support');
  });
});

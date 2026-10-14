import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { generateToken, hashUnlockVerifier } from '@xecret/core/auth';
import type { AuditRecord } from '@xecret/core/audit';
import {
  computeValueHmac,
  derivePassphraseWrapKey,
  deriveRecoveryKey,
  deriveStretchedKey,
  deriveUkUnlockVerifier,
  deriveUnlockVerifier,
  encodePublicKey,
  encryptSecret,
  fromBase64Url,
  generateEncryptionKeyPair,
  generateEnvironmentDataKey,
  generateEnvironmentHmacKey,
  generateKdfSalt,
  generateRecoveryCodes,
  generateSigningKeyPair,
  generateUserKey,
  openGrant,
  recoveryLookupHash,
  sealGrant,
  signGrant,
  toBase64Url,
  toHex,
  unwrapPrivateKey,
  unwrapUserKey,
  wrapPrivateKey,
  wrapUserKey,
} from '@xecret/core/crypto/client';
import type { Argon2idParams, Bytes, RecoveryCode } from '@xecret/core/crypto/client';
import { openArchive, readArchiveFile } from '@xecret/core/vault-archive';
import {
  createSession,
  createVault,
  issueReauthProof,
  markSessionUnlocked,
  measureArchiveSecrets,
  recordFreshSignIn,
  resetVault as resetVaultRows,
} from '@xecret/db/repositories';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '@xecret/db/testing';
import type { TestDatabase } from '@xecret/db/testing';
import { createLogger } from './logging';
import type { LogEntry, RequestLog } from './logging';

/**
 * P23 end to end, through the real routes and the real `authenticatedRoute`
 * against a real database, with real cryptography on the "browser" side:
 *
 *  - a reset emails the escape archive — ZeptoMail is a stubbed `fetch`, and
 *    the attachment it was handed is opened with the old passphrase — and then
 *    retains the vault for seven days;
 *  - a failed send resets nothing; a production deployment with no mail
 *    refuses; an archive that cannot be emailed is shown by the preflight and
 *    resets only when the person chose to go without it (the owner decision);
 *  - the reset retains the vault that was archived, or nothing;
 *  - the retained vault is recovered into a new one with the old passphrase,
 *    and only by its owner, from an unlocked session, with the proof;
 *  - the purge removes it after seven days, runs only from the scheduler, and
 *    removes nothing earlier.
 */

const ORIGIN = 'https://xecret.playxoft.com';
const CSRF = 'csrf-token-for-tests';
const ZEPTO = 'https://api.zeptomail.com/v1.1/email';
const DAY = 24 * 60 * 60 * 1000;

/** Cheap but in range (§3.1): the archive reader validates what it runs. */
const KDF: Argon2idParams = { alg: 'argon2id', v: 19, m: 19456, t: 1, p: 1, len: 32 };

const PLAINTEXT = 'postgres://app:example-not-a-real-key@db.internal:5432/escape';
const NOTE = 'escape-test note, example-not-a-real-key';

const context = vi.hoisted(() => ({ workerContext: vi.fn(), createServiceContext: vi.fn() }));
/**
 * Makes `encodeArchivePart` fail for one part on its Nth encoding — a part
 * that is over its budget, or a bug at send time. Off unless a test sets it.
 */
const encoder = vi.hoisted(() => ({
  failPart: null as number | null,
  onCall: 1,
  calls: new Map<number, number>(),
}));
const auditSink = vi.hoisted(() => ({ write: vi.fn() }));
const logging = vi.hoisted(() => ({ createRequestLog: vi.fn() }));

vi.mock('./context', () => context);
vi.mock('@xecret/core/vault-archive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xecret/core/vault-archive')>();
  return {
    ...actual,
    encodeArchivePart: (...args: Parameters<typeof actual.encodeArchivePart>) => {
      const part = args[0].part;
      const call = (encoder.calls.get(part) ?? 0) + 1;
      encoder.calls.set(part, call);
      if (encoder.failPart === part && encoder.onCall === call) {
        throw new actual.ArchiveTooLargeError('test: this part is over its budget');
      }
      return actual.encodeArchivePart(...args);
    },
  };
});
vi.mock('./audit-sink', () => ({
  DatabaseAuditSink: class {
    write = auditSink.write;
  },
}));
vi.mock('./logging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./logging')>()),
  createRequestLog: logging.createRequestLog,
}));

const resetRoute = await import('@/app/api/auth/vault/reset/route');
const preflightRoute = await import('@/app/api/auth/vault/reset/preflight/route');
const retainedRoute = await import('@/app/api/auth/vault/retained/route');
const retainedOneRoute = await import('@/app/api/auth/vault/retained/[retainedId]/route');
const recoveryWrapRoute =
  await import('@/app/api/auth/vault/retained/[retainedId]/recovery-wrap/route');
const restoreRoute = await import('@/app/api/auth/vault/retained/[retainedId]/restore/route');
const purgeRoute = await import('@/app/api/internal/scheduled/vault-purge/route');
const { runScheduledJob, VAULT_PURGE_PATH } = await import('./scheduled');
const { ARCHIVE_EMAIL_LIMITS, archiveEnvironments, emailVaultArchive, surveyVaultArchive } =
  await import('./vault-archive-service');
const { VAULT_RESET_CONFIRMATION } = await import('./schemas/vault');

let t: TestDatabase;
let audit: AuditRecord[] = [];
let lines: LogEntry[] = [];
let deferred: Promise<unknown>[] = [];
let env: Record<string, string>;
let mailRequests: { url: string; body: Record<string, unknown> }[] = [];
let mailStatus = 201;
/** Runs inside the next send, once: a way to change the world mid-reset. */
let onMail: (() => Promise<void>) | null = null;

beforeAll(async () => {
  t = await createTestDatabase();
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  t.reset();
  audit = [];
  lines = [];
  deferred = [];
  mailRequests = [];
  mailStatus = 201;
  onMail = null;
  encoder.failPart = null;
  encoder.onCall = 1;
  encoder.calls.clear();
  env = {
    XECRET_PUBLIC_URL: ORIGIN,
    XECRET_ENV: 'production',
    ZEPTOMAIL_TOKEN: 'zepto-test-token',
    ZEPTOMAIL_FROM_ADDRESS: 'no-reply@example.com',
  };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url !== ZEPTO) throw new Error(`unexpected fetch to ${url}`);
      const hook = onMail;
      onMail = null;
      await hook?.();
      mailRequests.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response('{}', { status: mailStatus });
    }),
  );

  logging.createRequestLog.mockImplementation((_env: unknown, base: Record<string, unknown>) =>
    createLogger({
      sink: { write: (entry) => lines.push(entry), flush: () => Promise.resolve() },
      minimum: 'debug',
      base,
    }),
  );
  context.workerContext.mockImplementation(async () => ({ env, ctx: { waitUntil: () => {} } }));
  context.createServiceContext.mockImplementation(
    async (
      request: Request,
      _worker: unknown,
      requestId: string,
      log: RequestLog,
      startedAt: number,
    ) => ({
      env,
      db: t.db,
      envelope: {},
      meta: {
        requestId,
        rayId: null,
        ipAddress: '203.0.113.5',
        userAgent: 'vitest',
        method: request.method,
        path: new URL(request.url).pathname,
        startedAt,
      },
      log: log.logger,
      bindLog: log.bind,
      waitUntil: (promise: Promise<unknown>) => deferred.push(promise),
      settled: () => Promise.allSettled(deferred),
      dispose: () => {},
    }),
  );
  auditSink.write.mockImplementation(async (events: AuditRecord[]) => {
    audit.push(...events);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ── fixtures: a vault built the way the browser builds one ───────────────── */

interface Keys {
  userKey: Bytes;
  encPrivateKey: Bytes;
  encPublicKey: Bytes;
  signPrivateKey: Bytes;
  signPublicKey: Bytes;
  codes: RecoveryCode[];
}

interface Account {
  userId: string;
  email: string;
  sessionId: string;
  token: string;
  passphrase: string;
  keys: Keys;
}

async function setUpVault(userId: string, passphrase: string): Promise<Keys> {
  const userKey = generateUserKey();
  const enc = generateEncryptionKeyPair();
  const sign = generateSigningKeyPair();
  const salt = generateKdfSalt();
  const stretched = await deriveStretchedKey({ passphrase, salt, params: KDF });
  const wrapKey = await derivePassphraseWrapKey(stretched);
  const codes = generateRecoveryCodes(2);

  const recoveryWraps = [];
  for (const code of codes) {
    const lookupHash = await recoveryLookupHash(code.codeBytes);
    recoveryWraps.push({
      lookupHash,
      wrap: new TextEncoder().encode(
        await wrapUserKey({
          wrapKey: await deriveRecoveryKey(code.codeBytes),
          userKey,
          context: { userId, wrapKind: 'recovery', lookupHash },
        }),
      ),
    });
  }

  const ascii = (value: string) => new TextEncoder().encode(value);
  await createVault(t.db, {
    userId,
    encAlgorithm: 'X25519',
    encPublicKey: enc.publicKey,
    encPrivateKeyEnc: ascii(
      await wrapPrivateKey({ userKey, privateKey: enc.privateKey, userId, purpose: 'encryption' }),
    ),
    signAlgorithm: 'Ed25519',
    signPublicKey: sign.publicKey,
    signPrivateKeyEnc: ascii(
      await wrapPrivateKey({ userKey, privateKey: sign.privateKey, userId, purpose: 'signing' }),
    ),
    kdfSalt: salt,
    kdfParams: KDF,
    unlockVerifierHash: await hashUnlockVerifier(await deriveUnlockVerifier(stretched)),
    ukUnlockVerifierHash: await hashUnlockVerifier(await deriveUkUnlockVerifier(userKey)),
    passphraseWrap: ascii(
      await wrapUserKey({ wrapKey, userKey, context: { userId, wrapKind: 'passphrase' } }),
    ),
    recoveryWraps,
  });

  return {
    userKey,
    encPrivateKey: enc.privateKey,
    encPublicKey: enc.publicKey,
    signPrivateKey: sign.privateKey,
    signPublicKey: sign.publicKey,
    codes,
  };
}

async function account(): Promise<Account> {
  const userId = randomUUID();
  const email = `escape-${userId.slice(0, 8)}@example.com`;
  await t.pg.query(
    `insert into users (id, workos_user_id, email, email_verified) values ($1, $2, $3, true)`,
    [userId, `user_01${userId.replaceAll('-', '').slice(0, 20)}`, email],
  );
  const { token } = await generateToken('session');
  const session = await createSession(t.db, { userId, token, ipAddress: null, userAgent: null });
  const passphrase = `correct horse ${userId.slice(0, 6)} battery staple`;
  const keys = await setUpVault(userId, passphrase);
  return { userId, email, sessionId: session.id, token, passphrase, keys };
}

interface Environment {
  orgId: string;
  projectId: string;
  environmentId: string;
  edkId: string;
  edk: Bytes;
  ehk: Bytes;
  secretId: string;
}

/**
 * An org the account owns (or, with `member: false`, one it is not in), one
 * e2ee environment with an active key granted to the account, and one secret
 * with a value and a note encrypted under it.
 */
async function environmentFor(
  who: Account,
  options: { member?: boolean; role?: 'owner' | 'developer'; production?: boolean } = {},
): Promise<Environment> {
  const orgId = randomUUID();
  const projectId = randomUUID();
  const environmentId = randomUUID();
  const edkId = randomUUID();
  const secretId = randomUUID();
  const edk = generateEnvironmentDataKey();
  const ehk = generateEnvironmentHmacKey();

  await t.pg.query(
    `insert into organizations (id, name, slug, created_by) values ($1, 'Acme', $2, $3)`,
    [orgId, `acme-${orgId.slice(0, 8)}`, who.userId],
  );
  if (options.member !== false) {
    await t.pg.query(
      `insert into org_members (id, org_id, user_id, role) values ($1, $2, $3, $4)`,
      [randomUUID(), orgId, who.userId, options.role ?? 'owner'],
    );
  }
  await t.pg.query(
    `insert into projects (id, org_id, name, slug, created_by) values ($1, $2, 'API', 'api', $3)`,
    [projectId, orgId, who.userId],
  );
  await t.pg.query(
    `insert into environments (id, project_id, name, slug, encryption_mode, is_production) values ($1, $2, 'Production', 'production', 'e2ee', $3)`,
    [environmentId, projectId, options.production ?? false],
  );
  await t.pg.query(
    `insert into env_data_keys (id, environment_id, version, status, created_by) values ($1, $2, 1, 'active', $3)`,
    [edkId, environmentId, who.userId],
  );
  await grantTo(who.userId, who.keys, environmentId, edkId, edk, ehk);

  const value = await encryptSecret({
    edk,
    context: { field: 'value', orgId, environmentId, secretId, version: 1 },
    plaintext: PLAINTEXT,
  });
  const note = await encryptSecret({
    edk,
    context: { field: 'note', orgId, environmentId, secretId },
    plaintext: NOTE,
  });
  await t.pg.query(
    `insert into secrets (id, environment_id, name, enc_note, created_by) values ($1, $2, 'DATABASE_URL', $3, $4)`,
    [secretId, environmentId, new TextEncoder().encode(note), who.userId],
  );
  await t.pg.query(
    `insert into secret_versions (id, secret_id, version, ciphertext, env_data_key_id, client_algorithm, value_hmac, created_by)
     values ($1, $2, 1, $3, $4, 'xk2.gcm', $5, $6)`,
    [
      randomUUID(),
      secretId,
      new TextEncoder().encode(value),
      edkId,
      await computeValueHmac({ ehk, plaintext: PLAINTEXT }),
      who.userId,
    ],
  );

  return { orgId, projectId, environmentId, edkId, edk, ehk, secretId };
}

async function grantTo(
  userId: string,
  keys: Pick<Keys, 'encPublicKey' | 'signPrivateKey'>,
  environmentId: string,
  edkId: string,
  edk: Bytes,
  ehk: Bytes,
): Promise<void> {
  const recipient = {
    environmentId,
    edkVersion: 1,
    recipientKind: 'member' as const,
    recipientId: userId,
    recipientPublicKey: keys.encPublicKey,
  };
  const sealed = await sealGrant({ recipient, edk, ehk });
  const signature = signGrant({
    signerPrivateSeed: keys.signPrivateKey,
    fields: { ...recipient, edkSealedBlob: sealed.edkSealed, ehkSealedBlob: sealed.ehkSealed },
  });
  const ascii = (value: string) => new TextEncoder().encode(value);
  await t.pg.query(
    `insert into env_key_grants (id, env_data_key_id, member_user_id, edk_sealed, ehk_sealed, recipient_public_key, signature, signed_by_user_id)
     values ($1, $2, $3, $4, $5, $6, $7, $3)`,
    [
      randomUUID(),
      edkId,
      userId,
      ascii(sealed.edkSealed),
      ascii(sealed.ehkSealed),
      keys.encPublicKey,
      ascii(signature),
    ],
  );
}

/** Both re-authentication locks, recorded as the routes record them, and the proof. */
async function proofFor(who: Account): Promise<string> {
  await recordFreshSignIn(t.db, { userId: who.userId, sessionId: who.sessionId, at: new Date() });
  // The emailed code was requested — no proof is minted on an attempt without one.
  await t.pg.query(`update reauthentications set code_sent_at = now() where session_id = $1`, [
    who.sessionId,
  ]);
  const { token, hash } = await generateToken('reauthProof');
  const issued = await issueReauthProof(t.db, {
    userId: who.userId,
    sessionId: who.sessionId,
    signedInSince: new Date(Date.now() - 60_000),
    proofHash: hash,
    expiresAt: new Date(Date.now() + 300_000),
  });
  expect(issued).toBeTruthy();
  return token;
}

function call(
  route: Record<string, unknown>,
  method: 'GET' | 'POST',
  path: string,
  who: Pick<Account, 'token'>,
  options: { body?: unknown; params?: Record<string, string> } = {},
): Promise<Response> {
  const handler = route[method] as (
    request: Request,
    args?: { params: Promise<Record<string, string>> },
  ) => Promise<Response>;
  return handler(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        cookie: `__Host-xecret_session=${who.token}; __Host-xecret_csrf=${CSRF}`,
        'x-xecret-csrf': CSRF,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
    options.params === undefined ? undefined : { params: Promise.resolve(options.params) },
  );
}

async function reset(
  who: Account,
  options: { proceedWithoutArchive?: boolean } = {},
): Promise<Response> {
  const reauthProof = await proofFor(who);
  return call(resetRoute, 'POST', '/api/auth/vault/reset', who, {
    body: { confirm: VAULT_RESET_CONFIRMATION, reauthProof, ...options },
  });
}

/** Whether the session's reset proof is still unspent. */
async function proofUnspent(who: Account): Promise<boolean> {
  const rows = await t.pg.query<{ used_at: Date | null }>(
    `select used_at from reauthentications where session_id = $1`,
    [who.sessionId],
  );
  return rows.rows[0]?.used_at === null;
}

async function errorMessage(response: Response): Promise<string> {
  return ((await response.json()) as { error: { message: string } }).error.message;
}

interface Preflight {
  resettable: boolean;
  archive: {
    deliverable: boolean;
    reason: string | null;
    estimatedBytes: number;
    maxBytes: number;
    environmentCount: number;
    secretCount: number;
  };
}

async function preflight(who: Account): Promise<Response> {
  return call(preflightRoute, 'GET', '/api/auth/vault/reset/preflight', who);
}

async function count(sql: string, params: unknown[]): Promise<number> {
  return (await t.pg.query<{ n: number }>(`select count(*)::int as n from ${sql}`, params)).rows[0]!
    .n;
}

/**
 * A value as it could appear inside sent text: itself, and its base64 and
 * base64url after 0, 1 and 2 bytes of lead-in — the middle of each, so the
 * characters that depend on the neighbouring bytes are left out.
 */
function encodedForms(value: string): string[] {
  const forms = [value];
  for (let offset = 0; offset < 3; offset += 1) {
    const full = btoa('x'.repeat(offset) + value);
    const lead = Math.ceil((offset * 4) / 3);
    const middle = full.slice(lead + 1, full.length - 4);
    forms.push(middle, middle.replaceAll('+', '-').replaceAll('/', '_'));
  }
  return forms;
}

/** The attachment ZeptoMail was handed, as file bytes. */
function attachmentOf(request: { body: Record<string, unknown> }): {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
} {
  const [attachment] = request.body['attachments'] as {
    name: string;
    mime_type: string;
    content: string;
  }[];
  const binary = atob(attachment!.content);
  return {
    name: attachment!.name,
    mimeType: attachment!.mime_type,
    bytes: Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  };
}

/* ── the reset emails the archive, then retains ──────────────────────────── */

describe('a vault reset', () => {
  it('emails an archive the old passphrase opens, then retains the vault for seven days', async () => {
    const who = await account();
    const readable = await environmentFor(who);
    // A grant in an organisation the account is no longer in, and a stale one
    // on a production environment its role may no longer read: never archived.
    const foreign = await environmentFor(who, { member: false });
    const revoked = await environmentFor(who, { role: 'developer', production: true });

    const before = Date.now();
    const response = await reset(who);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      vault: { configured: boolean };
      archive: { emailed: boolean; parts: number; to: string };
      retained: { id: string; retainedUntil: string; grantCount: number };
    };

    expect(body.vault.configured).toBe(false);
    expect(body.archive).toEqual({ emailed: true, parts: 1, to: who.email });
    const until = new Date(body.retained.retainedUntil).getTime();
    expect(until - before).toBeGreaterThanOrEqual(7 * DAY);
    expect(until - Date.now()).toBeLessThanOrEqual(7 * DAY);
    expect(body.retained.grantCount).toBe(3);

    // One mail, to the account's own address, with one zip attached.
    expect(mailRequests).toHaveLength(1);
    const mail = mailRequests[0]!;
    expect(mail.body['to']).toEqual([{ email_address: { address: who.email } }]);
    expect(String(mail.body['textbody'])).toContain('anyone who gets this email');
    const attachment = attachmentOf(mail);
    expect(attachment.mimeType).toBe('application/zip');
    expect(attachment.name).toMatch(/^xecret-vault-archive-\d{4}-\d{2}-\d{2}\.zip$/);

    // Nothing readable anywhere in what was sent — raw, or base64 / base64url
    // at any of the three alignments a value can sit at inside a longer string.
    const sentText = JSON.stringify(mail.body) + new TextDecoder().decode(attachment.bytes);
    for (const value of [PLAINTEXT, NOTE]) {
      for (const form of encodedForms(value)) expect(sentText).not.toContain(form);
    }
    // The positive control: the same check finds a value hidden in base64 at an offset.
    const hidden = btoa(`xy${PLAINTEXT}`);
    expect(encodedForms(PLAINTEXT).some((form) => hidden.includes(form))).toBe(true);

    // And the old passphrase opens it, offline, to exactly what was stored.
    const doc = await readArchiveFile(attachment.bytes);
    expect(doc.account.userId).toBe(who.userId);
    expect(doc.environments.map((environment) => environment.environmentId)).toEqual([
      readable.environmentId,
    ]);
    const opened = await openArchive(doc, { kind: 'passphrase', passphrase: who.passphrase });
    expect(opened.environments[0]!.secrets).toMatchObject([
      { name: 'DATABASE_URL', outcome: 'ok', value: PLAINTEXT, note: NOTE },
    ]);
    // …and so does a recovery code.
    const byCode = await openArchive(doc, {
      kind: 'recovery-code',
      code: who.keys.codes[1]!.displayForm,
    });
    expect(byCode.environments[0]!.secrets[0]!.value).toBe(PLAINTEXT);

    // The live vault is gone and the retained one holds it.
    expect(await count('user_keys where user_id = $1', [who.userId])).toBe(0);
    expect(await count('retained_vaults where user_id = $1', [who.userId])).toBe(1);
    expect(
      await count('retained_vault_grants where retained_vault_id = $1', [body.retained.id]),
    ).toBe(3);
    void foreign;
    void revoked;

    await Promise.allSettled(deferred);
    expect(audit.map((record) => [record.action, record.outcome])).toEqual([
      ['vault.archive_emailed', 'success'],
      ['vault.reset', 'success'],
    ]);
    expect(audit[0]!.metadata).toMatchObject({ partCount: 1, environmentCount: 1, secretCount: 1 });
    expect(JSON.stringify(audit)).not.toContain('example-not-a-real-key');
  });

  it('resets nothing when the archive cannot be sent', async () => {
    const who = await account();
    await environmentFor(who);
    mailStatus = 500;

    const response = await reset(who);

    expect(response.status).toBe(503);
    expect(await errorMessage(response)).toBe(
      'We couldn’t email your vault archive, so nothing was reset. To try again you’ll need to ' +
        'sign in again and get a new code.',
    );
    expect(await count('user_keys where user_id = $1', [who.userId])).toBe(1);
    expect(await count('retained_vaults where user_id = $1', [who.userId])).toBe(0);
    // The proof was spent: a retry starts again from the sign-in.
    const used = await t.pg.query(`select used_at from reauthentications where session_id = $1`, [
      who.sessionId,
    ]);
    expect(used.rows[0]).toMatchObject({ used_at: expect.any(Date) });
  });

  it('is refused in production with no mail provider, before the proof is spent', async () => {
    const who = await account();
    await environmentFor(who);
    delete env['ZEPTOMAIL_TOKEN'];

    const refused = await reset(who);
    expect(refused.status).toBe(503);
    expect(await errorMessage(refused)).toMatch(
      /has no email set up, and a vault is never reset without emailing its archive first/,
    );
    expect(await proofUnspent(who)).toBe(true);
    expect(await count('user_keys where user_id = $1', [who.userId])).toBe(1);
    expect(await count('retained_vaults where user_id = $1', [who.userId])).toBe(0);

    // Not even by choosing to go without it: the archive would be missing only
    // because of the deployment.
    const second = { ...who, ...(await freshSession(who.userId)) };
    expect((await reset(second, { proceedWithoutArchive: true })).status).toBe(503);
    expect(await count('retained_vaults where user_id = $1', [who.userId])).toBe(0);
  });

  it('outside production with no mail, resets only when told to go without the archive', async () => {
    const who = await account();
    await environmentFor(who);
    delete env['ZEPTOMAIL_TOKEN'];
    env['XECRET_ENV'] = 'development';

    const refused = await reset(who);
    expect(refused.status).toBe(409);
    expect(await errorMessage(refused)).toMatch(/Reset without the emailed archive/);
    expect(await proofUnspent(who)).toBe(true);
    expect(await count('retained_vaults where user_id = $1', [who.userId])).toBe(0);

    // A new session for the second attempt: each session's sign-in is recorded once.
    const second = { ...who, ...(await freshSession(who.userId)) };
    const response = await reset(second, { proceedWithoutArchive: true });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { archive: unknown }).archive).toEqual({
      emailed: false,
      reason: 'mail-not-configured',
    });
    expect(mailRequests).toHaveLength(0);
    expect(await count('retained_vaults where user_id = $1', [who.userId])).toBe(1);
    await Promise.allSettled(deferred);
    expect(audit.map((record) => [record.action, record.outcome])).toEqual([
      ['vault.archive_emailed', 'error'],
      ['vault.reset', 'success'],
    ]);
  });

  it('is a 404 with no vault, and sends nothing', async () => {
    const who = await account();
    await t.pg.query(`delete from user_key_wraps where user_id = $1`, [who.userId]);
    await t.pg.query(`delete from user_keys where user_id = $1`, [who.userId]);

    const response = await reset(who);

    expect(response.status).toBe(404);
    expect(mailRequests).toHaveLength(0);
    // Spent like every other outcome after the archive checks.
    expect(await proofUnspent(who)).toBe(false);
  });

  it('emails a deliverable archive even when the request says it may go without', async () => {
    const who = await account();
    await environmentFor(who);

    const response = await reset(who, { proceedWithoutArchive: true });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { archive: { emailed: boolean } }).archive.emailed).toBe(
      true,
    );
    expect(mailRequests).toHaveLength(1);
    expect(mailRequests[0]!.body['attachments']).toBeDefined();
  });

  it('resets nothing when a later part cannot be sent, the earlier one already out', async () => {
    const original = { ...ARCHIVE_EMAIL_LIMITS };
    ARCHIVE_EMAIL_LIMITS.maxPartBytes = 10_000;
    try {
      const who = await account();
      await environmentFor(who);
      await environmentFor(who);
      // The first send goes through; the provider refuses the second.
      onMail = async () => {
        onMail = async () => {
          mailStatus = 500;
        };
      };

      const response = await reset(who);

      expect(response.status).toBe(503);
      // Two attempted: the first delivered, the second refused by the provider.
      expect(mailRequests).toHaveLength(2);
      expect(await count('user_keys where user_id = $1', [who.userId])).toBe(1);
      expect(await count('retained_vaults where user_id = $1', [who.userId])).toBe(0);
      expect(await proofUnspent(who)).toBe(false);
    } finally {
      Object.assign(ARCHIVE_EMAIL_LIMITS, original);
    }
  });

  it('checks every part before the first is sent: one over its budget sends nothing', async () => {
    const original = { ...ARCHIVE_EMAIL_LIMITS };
    ARCHIVE_EMAIL_LIMITS.maxPartBytes = 10_000;
    try {
      const who = await account();
      await environmentFor(who);
      await environmentFor(who);
      encoder.failPart = 2;

      const response = await reset(who);

      expect(response.status).toBe(409);
      expect(mailRequests).toHaveLength(0);
      expect(await count('retained_vaults where user_id = $1', [who.userId])).toBe(0);
    } finally {
      Object.assign(ARCHIVE_EMAIL_LIMITS, original);
    }
  });

  it('answers a part that fails at send time with a 503 that resets nothing, not a 500', async () => {
    const original = { ...ARCHIVE_EMAIL_LIMITS };
    ARCHIVE_EMAIL_LIMITS.maxPartBytes = 10_000;
    try {
      const who = await account();
      await environmentFor(who);
      await environmentFor(who);
      // Passes the check, then fails when encoded again to be sent.
      encoder.failPart = 2;
      encoder.onCall = 2;

      const response = await reset(who);

      expect(response.status).toBe(503);
      expect(mailRequests).toHaveLength(1);
      expect(await count('retained_vaults where user_id = $1', [who.userId])).toBe(0);
    } finally {
      Object.assign(ARCHIVE_EMAIL_LIMITS, original);
    }
  });

  it('refuses, with no choice made, an archive the estimate allowed and the plan did not fit', async () => {
    const original = { ...ARCHIVE_EMAIL_LIMITS };
    ARCHIVE_EMAIL_LIMITS.maxPartBytes = 10_000;
    ARCHIVE_EMAIL_LIMITS.maxParts = 1;
    try {
      const who = await account();
      await environmentFor(who);
      await environmentFor(who);

      const response = await reset(who);

      expect(response.status).toBe(409);
      expect(await errorMessage(response)).toMatch(/too large to email/);
      expect(mailRequests).toHaveLength(0);
      expect(await count('user_keys where user_id = $1', [who.userId])).toBe(1);
      expect(await count('retained_vaults where user_id = $1', [who.userId])).toBe(0);
    } finally {
      Object.assign(ARCHIVE_EMAIL_LIMITS, original);
    }
  });

  it('retains one vault when two sessions reset at once', async () => {
    const who = await account();
    await environmentFor(who);
    const second = { ...who, ...(await freshSession(who.userId)) };

    const [a, b] = await Promise.all([reset(who), reset(second)]);

    expect([a.status, b.status].sort()).toEqual([200, 404]);
    expect(await count('retained_vaults where user_id = $1', [who.userId])).toBe(1);
  });

  it('resets nothing without a proof, whatever the body chooses', async () => {
    const who = await account();
    await environmentFor(who);
    delete env['ZEPTOMAIL_TOKEN'];
    env['XECRET_ENV'] = 'staging';

    const response = await call(resetRoute, 'POST', '/api/auth/vault/reset', who, {
      body: {
        confirm: VAULT_RESET_CONFIRMATION,
        reauthProof: 'x'.repeat(43),
        proceedWithoutArchive: true,
      },
    });

    expect(response.status).toBe(403);
    expect(await count('retained_vaults where user_id = $1', [who.userId])).toBe(0);
  });

  it('retains the vault that was archived or nothing: one set up again meanwhile is refused', async () => {
    const who = await account();
    await environmentFor(who);
    // Mid-send, the vault is reset elsewhere and a new one set up.
    onMail = async () => {
      await t.pg.query(`delete from user_key_wraps where user_id = $1`, [who.userId]);
      await t.pg.query(`delete from user_keys where user_id = $1`, [who.userId]);
      await setUpVault(who.userId, `${who.passphrase} elsewhere`);
    };

    const response = await reset(who);

    expect(response.status).toBe(409);
    expect(await errorMessage(response)).toMatch(/^Your vault changed while it was being reset/);
    expect(mailRequests).toHaveLength(1);
    // The vault set up meanwhile is untouched, and nothing was retained.
    expect(await count('user_keys where user_id = $1', [who.userId])).toBe(1);
    expect(await count('retained_vaults where user_id = $1', [who.userId])).toBe(0);
  });

  it('writes names and slugs every reader accepts, whatever the rows hold', async () => {
    const who = await account();
    const environment = await environmentFor(who);
    const escape = String.fromCharCode(0x1b);
    const lineSeparator = String.fromCharCode(0x2028);
    await t.pg.query(`update organizations set name = $1, slug = $2 where id = $3`, [
      `Acme${escape}[2J${lineSeparator}`,
      'Acme Corp!',
      environment.orgId,
    ]);
    await t.pg.query(`update environments set slug = $1 where id = $2`, [
      'prod\nfake',
      environment.environmentId,
    ]);

    const response = await reset(who);
    expect(response.status).toBe(200);

    const doc = await readArchiveFile(attachmentOf(mailRequests[0]!).bytes);
    expect(doc.environments[0]).toMatchObject({
      orgName: 'Acme[2J',
      orgSlug: `x-${environment.orgId.replaceAll('-', '')}`,
      environmentSlug: `x-${environment.environmentId.replaceAll('-', '')}`,
      projectSlug: 'api',
    });
    const opened = await openArchive(doc, { kind: 'passphrase', passphrase: who.passphrase });
    expect(opened.environments[0]!.secrets[0]!.value).toBe(PLAINTEXT);
  });

  it('keeps both vaults when it happens twice inside the window', async () => {
    const who = await account();
    await environmentFor(who);
    expect((await reset(who)).status).toBe(200);
    const again = await setUpVault(who.userId, `${who.passphrase} again`);
    void again;
    // A fresh session for the second attempt: a proof is bound to the session
    // whose sign-in minted it, and each session takes one attempt.
    const second = { ...who, ...(await freshSession(who.userId)) };
    expect((await reset(second)).status).toBe(200);

    expect(await count('retained_vaults where user_id = $1', [who.userId])).toBe(2);
  });
});

async function freshSession(userId: string): Promise<{ sessionId: string; token: string }> {
  const { token } = await generateToken('session');
  const session = await createSession(t.db, { userId, token, ipAddress: null, userAgent: null });
  return { sessionId: session.id, token };
}

/* ── the preflight, and a vault too large to email ───────────────────────── */

describe('the reset preflight', () => {
  it('reports an archive that can be emailed, sized as an upper bound', async () => {
    const who = await account();
    await environmentFor(who);
    await environmentFor(who);
    await markSessionUnlocked(t.db, who.sessionId, new Date());

    const response = await preflight(who);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Preflight;
    expect(body).toMatchObject({
      resettable: true,
      archive: { deliverable: true, reason: null, environmentCount: 2, secretCount: 2 },
    });
    expect(body.archive.maxBytes).toBe(8 * 1024 * 1024);

    // The estimate is never below what is then written.
    expect((await reset(who)).status).toBe(200);
    const doc = await readArchiveFile(attachmentOf(mailRequests[0]!).bytes);
    const written = new TextEncoder().encode(JSON.stringify(doc, null, 2)).length;
    expect(body.archive.estimatedBytes).toBeGreaterThanOrEqual(written);
    // Generous by a fixed allowance per environment, not by a multiple.
    expect(body.archive.estimatedBytes).toBeLessThan(written + 32 * 1024);
  });

  it('stays an upper bound for many small secrets, where the per-entry overhead dominates', async () => {
    const who = await account();
    const environment = await environmentFor(who);
    // Eighty more secrets beside the first, each a copy of its version row
    // under a new name: well-formed, small, and what the estimate's per-secret
    // allowance exists for.
    for (let index = 0; index < 80; index += 1) {
      const secretId = randomUUID();
      await t.pg.query(
        `insert into secrets (id, environment_id, name, created_by) values ($1, $2, $3, $4)`,
        [secretId, environment.environmentId, `EXTRA_${index}`, who.userId],
      );
      await t.pg.query(
        `insert into secret_versions (id, secret_id, version, ciphertext, env_data_key_id, client_algorithm, value_hmac, created_by)
         select $1, $2, 1, ciphertext, env_data_key_id, client_algorithm, value_hmac, created_by
           from secret_versions where secret_id = $3`,
        [randomUUID(), secretId, environment.secretId],
      );
    }

    await markSessionUnlocked(t.db, who.sessionId, new Date());
    const body = (await (await preflight(who)).json()) as Preflight;
    expect(body.archive.secretCount).toBe(81);

    expect((await reset(who)).status).toBe(200);
    const doc = await readArchiveFile(attachmentOf(mailRequests[0]!).bytes);
    const written = new TextEncoder().encode(JSON.stringify(doc, null, 2)).length;
    expect(body.archive.estimatedBytes).toBeGreaterThanOrEqual(written);
    expect(body.archive.estimatedBytes).toBeLessThan(written * 2);
  });

  it('tells a locked session whether the archive can be emailed, and nothing about its contents', async () => {
    const who = await account();
    await environmentFor(who);
    await environmentFor(who);

    const response = await preflight(who);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      resettable: true,
      archive: { deliverable: true, reason: null },
    });
  });

  it('is rate limited on a key of its own', async () => {
    const who = await account();
    await environmentFor(who);
    const keys: string[] = [];
    (env as Record<string, unknown>)['RL_LOGIN'] = {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: false };
      },
    };

    const response = await preflight(who);

    expect(response.status).toBe(429);
    expect(keys).toEqual([`vault_reset_preflight:${who.userId}`]);
  });

  it('says a production deployment with no mail cannot reset at all', async () => {
    const who = await account();
    delete env['ZEPTOMAIL_TOKEN'];

    const body = (await (await preflight(who)).json()) as Preflight;
    expect(body.resettable).toBe(false);
    expect(body.archive).toMatchObject({ deliverable: false, reason: 'mail-not-configured' });

    env['XECRET_ENV'] = 'development';
    const elsewhere = (await (await preflight(who)).json()) as Preflight;
    expect(elsewhere.resettable).toBe(true);
    expect(elsewhere.archive).toMatchObject({ deliverable: false, reason: 'mail-not-configured' });
  });

  it('is a 404 with no vault', async () => {
    const who = await account();
    await t.pg.query(`delete from user_key_wraps where user_id = $1`, [who.userId]);
    await t.pg.query(`delete from user_keys where user_id = $1`, [who.userId]);
    expect((await preflight(who)).status).toBe(404);
  });
});

describe('sizing an archive in SQL', () => {
  it('counts the latest version of each live secret, and only the bytes the archive carries', async () => {
    const who = await account();
    const environment = await environmentFor(who);
    const sizes = await t.pg.query<{ value: number; note: number }>(
      `select octet_length(v.ciphertext)::int as value, octet_length(s.enc_note)::int as note
         from secret_versions v join secrets s on s.id = v.secret_id where s.id = $1`,
      [environment.secretId],
    );
    const first = sizes.rows[0]!;
    expect(await measureArchiveSecrets(t.db, [environment.environmentId])).toEqual({
      count: 1,
      bytes: first.value + first.note + 'DATABASE_URL'.length,
    });

    // A newer version replaces the older one in the measure, as in the archive.
    const longer = new TextEncoder().encode(`xk2.gcm.${'A'.repeat(500)}`);
    await t.pg.query(
      `insert into secret_versions (id, secret_id, version, ciphertext, env_data_key_id, client_algorithm, value_hmac, created_by)
       select $1, secret_id, 2, $2, env_data_key_id, client_algorithm, value_hmac, created_by
         from secret_versions where secret_id = $3`,
      [randomUUID(), longer, environment.secretId],
    );
    expect(await measureArchiveSecrets(t.db, [environment.environmentId])).toEqual({
      count: 1,
      bytes: longer.length + first.note + 'DATABASE_URL'.length,
    });

    // A deleted secret is not archived, so not measured.
    await t.pg.query(`update secrets set deleted_at = now() where id = $1`, [environment.secretId]);
    expect(await measureArchiveSecrets(t.db, [environment.environmentId])).toEqual({
      count: 0,
      bytes: 0,
    });
    expect(await measureArchiveSecrets(t.db, [])).toEqual({ count: 0, bytes: 0 });
  });
});

describe('a vault too large to email', () => {
  const original = { ...ARCHIVE_EMAIL_LIMITS };
  beforeEach(() => {
    ARCHIVE_EMAIL_LIMITS.maxDocumentBytes = 1_000;
  });
  afterEach(() => {
    Object.assign(ARCHIVE_EMAIL_LIMITS, original);
  });

  it('is shown by the preflight, before anything is confirmed', async () => {
    const who = await account();
    await environmentFor(who);

    // Locked, as everybody at the reset screen is: the size is told, because
    // it is the reason, and the counts are not.
    const body = (await (await preflight(who)).json()) as Preflight;
    expect(body).toEqual({
      resettable: true,
      archive: {
        deliverable: false,
        reason: 'too-large',
        estimatedBytes: expect.any(Number),
        maxBytes: 8 * 1024 * 1024,
      },
    });
    expect(body.archive.estimatedBytes).toBeGreaterThan(1_000);

    await markSessionUnlocked(t.db, who.sessionId, new Date());
    const unlocked = (await (await preflight(who)).json()) as Preflight;
    expect(unlocked.archive).toMatchObject({ environmentCount: 1, secretCount: 1 });
  });

  it('is not reset without the choice: refused before the proof is spent, nothing sent', async () => {
    const who = await account();
    await environmentFor(who);

    const response = await reset(who);

    expect(response.status).toBe(409);
    expect(await errorMessage(response)).toMatch(/too large to email/);
    expect(await proofUnspent(who)).toBe(true);
    expect(mailRequests).toHaveLength(0);
    expect(await count('user_keys where user_id = $1', [who.userId])).toBe(1);
    expect(await count('retained_vaults where user_id = $1', [who.userId])).toBe(0);
  });

  it('is reset with the choice, emailing the notice instead and retaining the vault', async () => {
    const who = await account();
    await environmentFor(who);

    const response = await reset(who, { proceedWithoutArchive: true });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { archive: unknown }).archive).toEqual({
      emailed: false,
      reason: 'too-large',
    });
    expect(mailRequests).toHaveLength(1);
    expect(mailRequests[0]!.body['subject']).toBe('Resetting your xecret vault');
    expect(mailRequests[0]!.body['attachments']).toBeUndefined();
    expect(await count('retained_vaults where user_id = $1', [who.userId])).toBe(1);

    await Promise.allSettled(deferred);
    expect(audit.map((record) => [record.action, record.outcome])).toEqual([
      ['vault.archive_emailed', 'error'],
      ['vault.reset', 'success'],
    ]);
  });

  it('is not reset when the notice cannot be sent either', async () => {
    const who = await account();
    await environmentFor(who);
    mailStatus = 500;

    const second = { ...who, ...(await freshSession(who.userId)) };
    expect((await reset(second, { proceedWithoutArchive: true })).status).toBe(503);
    expect(await count('retained_vaults where user_id = $1', [who.userId])).toBe(0);
  });
});

describe('emailing an archive', () => {
  const services = () =>
    ({
      db: t.db,
      env,
      log: { at: () => ({ warn: () => {}, error: () => {} }) },
    }) as unknown as Parameters<typeof emailVaultArchive>[0];
  const params = (who: Account) => ({
    email: who.email,
    now: new Date(),
    retainedUntil: new Date(Date.now() + 7 * DAY),
    archiveId: randomUUID(),
  });

  it('sends nothing when the plan needs more parts than allowed', async () => {
    const who = await account();
    await environmentFor(who);
    const survey = await surveyVaultArchive(t.db, who.userId, { mailConfigured: true });
    const sent: unknown[] = [];

    const delivery = await emailVaultArchive(
      services(),
      survey!,
      params(who),
      { send: async (message) => void sent.push(message) },
      { maxDocumentBytes: ARCHIVE_EMAIL_LIMITS.maxDocumentBytes, maxPartBytes: 2_000, maxParts: 1 },
    );

    expect(delivery).toEqual({ status: 'not-emailed', reason: 'too-large' });
    expect(sent).toHaveLength(0);
  });

  it('splits into parts that each open alone', async () => {
    const who = await account();
    await environmentFor(who);
    await environmentFor(who);
    const sent: { attachments?: { content: Uint8Array }[] }[] = [];
    const survey = await surveyVaultArchive(t.db, who.userId, { mailConfigured: true });

    const delivery = await emailVaultArchive(
      services(),
      survey!,
      params(who),
      { send: async (message) => void sent.push(message as never) },
      {
        maxDocumentBytes: ARCHIVE_EMAIL_LIMITS.maxDocumentBytes,
        maxPartBytes: 10_000,
        maxParts: 3,
      },
    );

    expect(delivery).toMatchObject({
      status: 'emailed',
      parts: 2,
      environmentCount: 2,
      secretCount: 2,
    });
    for (const message of sent) {
      const doc = await readArchiveFile(message.attachments![0]!.content);
      const opened = await openArchive(doc, { kind: 'passphrase', passphrase: who.passphrase });
      for (const environment of opened.environments) {
        for (const secret of environment.secrets) expect(secret.value).toBe(PLAINTEXT);
      }
    }
  });
});

describe('the archive’s environments', () => {
  it('carry at most the newest 1000 key versions, once each', () => {
    const environmentId = randomUUID();
    const grant = (version: number) => ({
      envDataKeyId: randomUUID(),
      edkVersion: version,
      edkSealed: new TextEncoder().encode('xk2.x25519.edk'),
      ehkSealed: new TextEncoder().encode('xk2.x25519.ehk'),
      environmentId,
      environmentName: 'Production',
      environmentSlug: 'production',
      isProduction: true,
      projectId: randomUUID(),
      projectName: 'API',
      projectSlug: 'api',
      orgId: randomUUID(),
      orgName: 'Acme',
      orgSlug: 'acme',
    });
    const grants = Array.from({ length: 1001 }, (_, index) => grant(index + 1));
    grants.push(grant(1001));

    const [environment] = archiveEnvironments(grants);
    const versions = environment!.keys.map((key) => key.edkVersion);
    expect(versions).toHaveLength(1000);
    expect(new Set(versions).size).toBe(1000);
    expect(Math.min(...versions)).toBe(2);
    expect(Math.max(...versions)).toBe(1001);
  });
});

/* ── recovery ─────────────────────────────────────────────────────────────── */

/** Resets, sets up a new vault, and unlocks the session into it. */
async function resetAndStartAgain(who: Account): Promise<{ retainedId: string; current: Keys }> {
  const response = await reset(who);
  expect(response.status).toBe(200);
  const retainedId = ((await response.json()) as { retained: { id: string } }).retained.id;
  const current = await setUpVault(who.userId, `${who.passphrase} new`);
  await markSessionUnlocked(t.db, who.sessionId, new Date());
  return { retainedId, current };
}

interface RetainedMaterial {
  id: string;
  kdfSalt: string;
  kdfParams: unknown;
  passphraseWrap: string;
  encPrivateKeyEnc: string;
  grants: {
    envDataKeyId: string;
    edkVersion: number;
    environmentId: string;
    edkSealed: string;
    ehkSealed: string;
  }[];
}

/** What the recovery screen does in the browser, with the old passphrase. */
async function resealWithPassphrase(who: Account, material: RetainedMaterial, current: Keys) {
  const stretched = await deriveStretchedKey({
    passphrase: who.passphrase,
    salt: fromBase64Url(material.kdfSalt),
    params: material.kdfParams,
  });
  const oldUserKey = await unwrapUserKey({
    wrapKey: await derivePassphraseWrapKey(stretched),
    blob: material.passphraseWrap,
    context: { userId: who.userId, wrapKind: 'passphrase' },
  });
  return reseal(who.userId, oldUserKey, material, current);
}

async function reseal(
  userId: string,
  oldUserKey: Bytes,
  material: RetainedMaterial,
  current: Keys,
) {
  const oldPrivate = await unwrapPrivateKey({
    userKey: oldUserKey,
    blob: material.encPrivateKeyEnc,
    userId,
    purpose: 'encryption',
  });

  const grants = [];
  for (const grant of material.grants) {
    const recipient = {
      environmentId: grant.environmentId,
      edkVersion: grant.edkVersion,
      recipientKind: 'member' as const,
      recipientId: userId,
    };
    const { edk, ehk } = await openGrant({
      recipient,
      recipientPrivateKey: oldPrivate,
      grant: { edkSealed: grant.edkSealed, ehkSealed: grant.ehkSealed },
    });
    const sealed = await sealGrant({
      recipient: { ...recipient, recipientPublicKey: current.encPublicKey },
      edk,
      ehk,
    });
    grants.push({
      envDataKeyId: grant.envDataKeyId,
      recipientPublicKey: encodePublicKey(current.encPublicKey),
      edkSealed: sealed.edkSealed,
      ehkSealed: sealed.ehkSealed,
      signature: signGrant({
        signerPrivateSeed: current.signPrivateKey,
        fields: {
          ...recipient,
          recipientPublicKey: current.encPublicKey,
          edkSealedBlob: sealed.edkSealed,
          ehkSealedBlob: sealed.ehkSealed,
        },
      }),
    });
  }

  return { ukUnlockVerifier: toBase64Url(await deriveUkUnlockVerifier(oldUserKey)), grants };
}

async function material(who: Account, retainedId: string): Promise<RetainedMaterial> {
  const response = await call(
    retainedOneRoute,
    'GET',
    `/api/auth/vault/retained/${retainedId}`,
    who,
    {
      params: { retainedId },
    },
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { retained: RetainedMaterial }).retained;
}

const restore = (who: Account, retainedId: string, body: unknown) =>
  call(restoreRoute, 'POST', `/api/auth/vault/retained/${retainedId}/restore`, who, {
    params: { retainedId },
    body,
  });

describe('recovering a retained vault', () => {
  it('brings its keys into the new vault with the old passphrase, and settles the pending share', async () => {
    const who = await account();
    const environment = await environmentFor(who);
    const { retainedId, current } = await resetAndStartAgain(who);
    expect(
      await count('pending_key_grants where target_user_id = $1 and environment_id = $2', [
        who.userId,
        environment.environmentId,
      ]),
    ).toBe(1);

    const listed = await call(retainedRoute, 'GET', '/api/auth/vault/retained', who);
    expect(
      ((await listed.json()) as { retained: { id: string }[] }).retained.map((each) => each.id),
    ).toEqual([retainedId]);

    const loaded = await material(who, retainedId);
    expect(loaded.grants.map((grant) => grant.environmentId)).toContain(environment.environmentId);

    const response = await restore(
      who,
      retainedId,
      await resealWithPassphrase(who, loaded, current),
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as { restored: number; skipped: { reason: string }[] };
    // The foreign-org grant is not offered at all: the account is not in that organisation.
    expect(result.restored).toBe(1);

    // The restored grant opens with the *new* vault's private key.
    const row = (
      await t.pg.query<{ edk_sealed: Uint8Array; ehk_sealed: Uint8Array }>(
        `select edk_sealed, ehk_sealed from env_key_grants where member_user_id = $1`,
        [who.userId],
      )
    ).rows[0]!;
    const opened = await openGrant({
      recipient: {
        environmentId: environment.environmentId,
        edkVersion: 1,
        recipientKind: 'member',
        recipientId: who.userId,
      },
      recipientPrivateKey: current.encPrivateKey,
      grant: {
        edkSealed: new TextDecoder().decode(row.edk_sealed),
        ehkSealed: new TextDecoder().decode(row.ehk_sealed),
      },
    });
    expect(toHex(opened.edk)).toBe(toHex(environment.edk));
    expect(await count('pending_key_grants where target_user_id = $1', [who.userId])).toBe(0);

    await Promise.allSettled(deferred);
    expect(audit.filter((record) => record.action === 'vault.recovered')).toEqual([
      expect.objectContaining({
        orgId: environment.orgId,
        metadata: expect.objectContaining({ grantCount: 1 }),
      }),
    ]);
  });

  it('does not hand out a grant the account may no longer read', async () => {
    const who = await account();
    const kept = await environmentFor(who);
    const lost = await environmentFor(who, { role: 'owner', production: true });
    const { retainedId } = await resetAndStartAgain(who);
    await t.pg.query(
      `update org_members set role = 'developer' where user_id = $1 and org_id = $2`,
      [who.userId, lost.orgId],
    );

    const loaded = await material(who, retainedId);

    expect(loaded.grants.map((grant) => grant.environmentId)).toEqual([kept.environmentId]);
  });

  it('skips an environment the account may no longer read', async () => {
    const who = await account();
    const environment = await environmentFor(who, { role: 'owner', production: true });
    const { retainedId, current } = await resetAndStartAgain(who);
    const loaded = await material(who, retainedId);
    // Demoted during the window: a developer has no production access by default.
    await t.pg.query(
      `update org_members set role = 'developer' where user_id = $1 and org_id = $2`,
      [who.userId, environment.orgId],
    );

    const response = await restore(
      who,
      retainedId,
      await resealWithPassphrase(who, loaded, current),
    );

    expect(await response.json()).toEqual({
      restored: 0,
      skipped: [{ envDataKeyId: environment.edkId, reason: 'no-access' }],
    });
    expect(await count('env_key_grants where member_user_id = $1', [who.userId])).toBe(0);
  });

  it('answers a malformed id with the same 404 as anybody else’s, on every route', async () => {
    const who = await account();
    await environmentFor(who);
    await resetAndStartAgain(who);
    const retainedId = 'not-a-uuid';

    const responses = [
      await call(retainedOneRoute, 'GET', `/api/auth/vault/retained/${retainedId}`, who, {
        params: { retainedId },
      }),
      await call(
        recoveryWrapRoute,
        'POST',
        `/api/auth/vault/retained/${retainedId}/recovery-wrap`,
        who,
        { params: { retainedId }, body: { lookupHash: toBase64Url(new Uint8Array(32)) } },
      ),
      await restore(who, retainedId, {
        ukUnlockVerifier: toBase64Url(new Uint8Array(32)),
        grants: [],
      }),
    ];

    expect(responses.map((response) => response.status)).toEqual([404, 404, 404]);
  });

  it('refuses even the right answer while the retained vault is locked out', async () => {
    const who = await account();
    await environmentFor(who);
    const { retainedId, current } = await resetAndStartAgain(who);
    const loaded = await material(who, retainedId);
    const right = await resealWithPassphrase(who, loaded, current);
    await t.pg.query(
      `update retained_vaults set recovery_locked_until = now() + interval '10 minutes' where id = $1`,
      [retainedId],
    );

    const restored = await restore(who, retainedId, right);
    const code = who.keys.codes[0]!;
    const wrap = await call(
      recoveryWrapRoute,
      'POST',
      `/api/auth/vault/retained/${retainedId}/recovery-wrap`,
      who,
      {
        params: { retainedId },
        body: { lookupHash: toBase64Url(await recoveryLookupHash(code.codeBytes)) },
      },
    );

    expect(restored.status).toBe(429);
    expect(wrap.status).toBe(429);
    expect(await count('env_key_grants where member_user_id = $1', [who.userId])).toBe(0);
  });

  it('gives the way back from a hostile reset: reset again, set up your own vault, recover', async () => {
    const victim = await account();
    await environmentFor(victim);
    // Somebody holding another session of the account resets it and sets up
    // their own vault, then spends the original's guesses on wrong proofs.
    const attacker = { ...victim, ...(await freshSession(victim.userId)) };
    const hostile = await reset(attacker);
    expect(hostile.status).toBe(200);
    const original = ((await hostile.json()) as { retained: { id: string } }).retained.id;
    await setUpVault(victim.userId, 'a passphrase the attacker chose');
    await markSessionUnlocked(t.db, attacker.sessionId, new Date());
    for (let guess = 1; guess <= 7; guess += 1) {
      await restore(attacker, original, {
        ukUnlockVerifier: toBase64Url(new Uint8Array(32).fill(guess)),
        grants: [],
      });
    }

    // The victim resets again, which locks every session the attacker holds,
    // and sets up their own vault.
    const back = { ...victim, ...(await freshSession(victim.userId)) };
    expect((await reset(back)).status).toBe(200);
    const current = await setUpVault(victim.userId, `${victim.passphrase} again`);
    await markSessionUnlocked(t.db, back.sessionId, new Date());
    expect((await call(retainedRoute, 'GET', '/api/auth/vault/retained', attacker)).status).toBe(
      403,
    );

    // The original survived the second reset; the attacker's guesses may hold
    // it locked for a while (the user docs say up to an hour), then it opens.
    const loaded = await material(back, original);
    const locked = await restore(back, original, await resealWithPassphrase(back, loaded, current));
    expect(locked.status).toBe(429);
    await t.pg.query(
      `update retained_vaults set recovery_locked_until = now() - interval '1 second' where id = $1`,
      [original],
    );
    const recovered = await restore(
      back,
      original,
      await resealWithPassphrase(back, loaded, current),
    );
    expect(((await recovered.json()) as { restored: number }).restored).toBe(1);
  });

  it('outlives an account deleted inside the window, out of reach of its sessions', async () => {
    const { deleteAccount } = await import('./account-service');
    const who = await account();
    await environmentFor(who);
    const { retainedId } = await resetAndStartAgain(who);

    await deleteAccount({ db: t.db } as unknown as Parameters<typeof deleteAccount>[0], who.userId);

    // Nothing in xecret deletes it early — account deletion included — and the
    // purge takes it when the window ends.
    expect(await count('retained_vaults where id = $1', [retainedId])).toBe(1);
    expect(
      await count('retained_vault_wraps where retained_vault_id = $1', [retainedId]),
    ).toBeGreaterThan(0);
    const fetched = await call(
      retainedOneRoute,
      'GET',
      `/api/auth/vault/retained/${retainedId}`,
      who,
      { params: { retainedId } },
    );
    expect(fetched.status).toBe(401);
  });

  it('works with an old recovery code, fetched by its lookup hash', async () => {
    const who = await account();
    await environmentFor(who);
    const { retainedId, current } = await resetAndStartAgain(who);
    const loaded = await material(who, retainedId);
    const code = who.keys.codes[0]!;
    const lookupHash = await recoveryLookupHash(code.codeBytes);

    const response = await call(
      recoveryWrapRoute,
      'POST',
      `/api/auth/vault/retained/${retainedId}/recovery-wrap`,
      who,
      { params: { retainedId }, body: { lookupHash: toBase64Url(lookupHash) } },
    );
    expect(response.status).toBe(200);
    const { wrap } = (await response.json()) as { wrap: string };
    const oldUserKey = await unwrapUserKey({
      wrapKey: await deriveRecoveryKey(code.codeBytes),
      blob: wrap,
      context: { userId: who.userId, wrapKind: 'recovery', lookupHash },
    });

    const restored = await restore(
      who,
      retainedId,
      await reseal(who.userId, oldUserKey, loaded, current),
    );
    expect(((await restored.json()) as { restored: number }).restored).toBe(1);
  });

  it('refuses, and counts, a code that is not the vault’s', async () => {
    const who = await account();
    const { retainedId } = await resetAndStartAgain(who);

    const response = await call(
      recoveryWrapRoute,
      'POST',
      `/api/auth/vault/retained/${retainedId}/recovery-wrap`,
      who,
      { params: { retainedId }, body: { lookupHash: toBase64Url(new Uint8Array(32).fill(7)) } },
    );

    expect(response.status).toBe(400);
    expect(
      await count('retained_vaults where id = $1 and recovery_failed_attempts = 1', [retainedId]),
    ).toBe(1);
  });

  it('refuses a restore without the proof of the old User Key, and counts it', async () => {
    const who = await account();
    await environmentFor(who);
    const { retainedId, current } = await resetAndStartAgain(who);
    const loaded = await material(who, retainedId);
    const body = await resealWithPassphrase(who, loaded, current);

    const response = await restore(who, retainedId, {
      ...body,
      ukUnlockVerifier: toBase64Url(new Uint8Array(32).fill(9)),
    });

    expect(response.status).toBe(403);
    expect(await count('env_key_grants where member_user_id = $1', [who.userId])).toBe(0);
    expect(
      await count('retained_vaults where id = $1 and recovery_failed_attempts = 1', [retainedId]),
    ).toBe(1);
  });

  it('is invisible to every other account', async () => {
    const who = await account();
    await environmentFor(who);
    const { retainedId, current } = await resetAndStartAgain(who);
    const loaded = await material(who, retainedId);
    const body = await resealWithPassphrase(who, loaded, current);

    const stranger = await account();
    await markSessionUnlocked(t.db, stranger.sessionId, new Date());

    const fetched = await call(
      retainedOneRoute,
      'GET',
      `/api/auth/vault/retained/${retainedId}`,
      stranger,
      {
        params: { retainedId },
      },
    );
    expect(fetched.status).toBe(404);
    // Even holding the owner's valid proof and grants.
    expect((await restore(stranger, retainedId, body)).status).toBe(404);
    const listed = await call(retainedRoute, 'GET', '/api/auth/vault/retained', stranger);
    expect(((await listed.json()) as { retained: unknown[] }).retained).toEqual([]);
  });

  it('needs an unlocked session', async () => {
    const who = await account();
    const { retainedId } = await resetAndStartAgain(who);
    await t.pg.query(`update sessions set vault_unlocked_at = null where id = $1`, [who.sessionId]);

    const response = await call(
      retainedOneRoute,
      'GET',
      `/api/auth/vault/retained/${retainedId}`,
      who,
      {
        params: { retainedId },
      },
    );
    expect(response.status).toBe(403);
  });

  it('has no route that deletes a retained vault', () => {
    for (const route of [retainedRoute, retainedOneRoute, recoveryWrapRoute, restoreRoute]) {
      expect(Object.keys(route).filter((name) => /^(DELETE|PUT|PATCH)$/.test(name))).toEqual([]);
    }
  });
});

/* ── the purge ────────────────────────────────────────────────────────────── */

describe('the scheduled purge', () => {
  const callPurge = (request: Request) =>
    (purgeRoute.POST as (request: Request) => Promise<Response>)(request);

  it('answers 404 to anything but the scheduler, and purges nothing', async () => {
    const who = await account();
    const reset8 = await resetVaultRows(t.db, who.userId, { now: new Date(Date.now() - 8 * DAY) });

    for (const headers of [{}, { 'x-xecret-scheduled': 'guess' }]) {
      const response = await callPurge(
        new Request(`${ORIGIN}${VAULT_PURGE_PATH}`, { method: 'POST', headers }),
      );
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('');
    }
    // Refused before anything was built: no services, so no database connection.
    expect(context.createServiceContext).not.toHaveBeenCalled();
    expect(await count('retained_vaults where id = $1', [reset8!.id])).toBe(1);
  });

  it('removes vaults past their seven days, and nothing younger, as the system', async () => {
    const old = await account();
    const young = await account();
    const expired = await resetVaultRows(t.db, old.userId, { now: new Date(Date.now() - 8 * DAY) });
    const recent = await resetVaultRows(t.db, young.userId, {
      now: new Date(Date.now() - 6 * DAY),
    });
    // The record goes to the account's primary organisation, so it needs one.
    const orgId = randomUUID();
    await t.pg.query(
      `insert into organizations (id, name, slug, created_by) values ($1, 'Old', $2, $3)`,
      [orgId, `old-${orgId.slice(0, 8)}`, old.userId],
    );
    await t.pg.query(
      `insert into org_members (id, org_id, user_id, role) values ($1, $2, $3, 'owner')`,
      [randomUUID(), orgId, old.userId],
    );

    await runScheduledJob(callPurge, ORIGIN, VAULT_PURGE_PATH);

    expect(await count('retained_vaults where id = $1', [expired!.id])).toBe(0);
    expect(await count('retained_vaults where id = $1', [recent!.id])).toBe(1);
    // Written by the purge's own transaction, straight to the table.
    const purged = await t.pg.query<{ actor_type: string; resource_id: string; org_id: string }>(
      `select actor_type, resource_id, org_id from audit_logs where action = 'vault.purged'
        and resource_id in ($1, $2)`,
      [old.userId, young.userId],
    );
    expect(purged.rows).toEqual([{ actor_type: 'system', resource_id: old.userId, org_id: orgId }]);
  });

  it('still purges an account in no organisation, logging it instead', async () => {
    const lonely = await account();
    const expired = await resetVaultRows(t.db, lonely.userId, {
      now: new Date(Date.now() - 8 * DAY),
    });

    await runScheduledJob(callPurge, ORIGIN, VAULT_PURGE_PATH);

    expect(await count('retained_vaults where id = $1', [expired!.id])).toBe(0);
    expect(lines.some((line) => line.message.includes('in no organisation'))).toBe(true);
  });
});

import {
  csrfCookie,
  deriveOAuthStateKey,
  generateCsrfToken,
  generateToken,
  hashToken,
  isWellFormedToken,
  serializeCookie,
  SESSION_LIFETIME_MS,
  sessionCookie,
} from '@xecret/core/auth';
import type { AuthorizationCodeExchange, OAuthPurpose, WorkosIdentity } from '@xecret/core/auth';
import { createAuditBuilder } from '@xecret/core/audit';
import type { AuditRecord, SignInMethod } from '@xecret/core/audit';
import {
  createSession,
  findOrgByWorkosOrgId,
  findSessionByTokenHash,
  joinOrganizationJustInTime,
  listOrganizationsForUser,
  provisionOrganization,
  recordFreshSignIn,
  RepositoryError,
  revokeSession,
  upsertUserFromWorkosIdentity,
} from '@xecret/db/repositories';
import type {
  Executor,
  IdentityLinkOutcome,
  OrganizationMembership,
  User,
} from '@xecret/db/repositories';
import type { SignInErrorCode } from '@/lib/sign-in-errors';
import { DatabaseAuditSink } from './audit-sink';
import type { Bindings } from './bindings';
import { MissingBindingError } from './bindings';
import type { ServiceContext } from './context';
import { describeError } from './logging';
import { attemptKey, consume } from './rate-limit';
import { ORGANIZATIONS_PER_ACCOUNT_LIMIT } from './schemas/resources';
import type { WorkosIdentityProvider } from './workos';

/**
 * What happens between "WorkOS says this is user_01H…" and "this browser holds
 * an xecret session" — the decisions the sign-in callback makes, in the order
 * it makes them.
 *
 * Kept out of the route file for the same reason `vault-service.ts` is: the
 * order of operations is itself the security control, and a handler is where a
 * step gets reordered by somebody who does not know why it was where it was.
 *
 * The order, and why each step is where it is:
 *
 *  1. **Refuse an impersonated sign-in.** A WorkOS administrator acting as a
 *     user is not that user, and nothing downstream is built to tell the two
 *     apart. Refused outright, before anything is read or written.
 *  2. **Refuse an unverified address.** The linking pass adopts accounts by
 *     verified email; an address the provider has not verified must never reach
 *     it. (`user.emailVerified` describes the WorkOS *user*, not this sign-in —
 *     which is why email verification has to stay on in both WorkOS
 *     environments; see the deployment-check skill.)
 *  3. **Hold an SSO sign-in to its organisation's verified domains.** An
 *     enterprise identity provider can assert any address, including one in
 *     somebody else's company. Its word is taken only for domains its
 *     organisation proved it owns — and this runs *before* the linker, so it
 *     covers an already-linked identity as well as adoption and creation.
 *  4. **Link** — `upsertUserFromWorkosIdentity`, at READ COMMITTED (no
 *     transaction is wrapped around it: its lost-race handling re-reads to see
 *     the winner's committed row, which a snapshot isolation level would hide).
 *  5. **Enforce `sso_required`** on every organisation the account belongs to.
 *  6. **Just-in-time join** the organisation whose SSO this was, if any.
 *  7. **Provision a personal organisation** for an account that still has none.
 *  8. **Issue the session**, and for a forced re-authentication, record that it
 *     happened.
 *
 * Steps 5 and 6 key on `authenticationMethod === 'SSO'` *and* the organisation
 * id together. AuthKit reports an organisation after organisation *selection*
 * in password and Google sign-ins too, so the id alone does not mean the
 * organisation's identity provider vouched for anybody.
 */

/**
 * A refusal the person is told about, by code, on the sign-in page.
 *
 * `status` is the HTTP status the refusal *is* — 403 for "you may not", 409 for
 * the address conflict — recorded in the log line, because the callback itself
 * answers every refusal with a 303 to `/sign-in?error=…`: it is a top-level
 * navigation, and a bare 403 body is a dead end for a person.
 */
export class SignInRefusal extends Error {
  constructor(
    readonly code: SignInErrorCode,
    readonly status: number,
    /** For the log. Never shown. */
    readonly logDetail: string,
  ) {
    super(`Sign-in refused: ${code}`);
    this.name = 'SignInRefusal';
  }
}

/** The role a just-in-time member starts at (§2.3). Never more. */
export const JIT_DEFAULT_ROLE = 'viewer' as const;

export interface SignInResult {
  user: User;
  outcome: IdentityLinkOutcome;
  memberships: OrganizationMembership[];
  /** `Set-Cookie` values for the new session and its CSRF pair. */
  cookies: string[];
  sessionId: string;
}

export interface CompleteSignInParams {
  exchange: AuthorizationCodeExchange<WorkosIdentity>;
  purpose: OAuthPurpose;
  provider: Pick<WorkosIdentityProvider, 'verifiedDomains'>;
  /** The session cookie this browser presented, if any — replaced by the new one. */
  presentedSessionToken: string | null;
}

/**
 * Steps 1–8 above. Throws {@link SignInRefusal} for every refusal a person is
 * told about, and lets anything else — a programming error, the database —
 * escape to the caller's 500 handling.
 */
export async function completeSignIn(
  services: ServiceContext,
  params: CompleteSignInParams,
): Promise<SignInResult> {
  const { exchange } = params;
  const { identity } = exchange;
  const log = services.log.at('completeSignIn');

  // ── 1. Impersonation ─────────────────────────────────────────────────────
  if (exchange.impersonator !== null) {
    throw new SignInRefusal('impersonation', 403, 'impersonated sign-in refused');
  }

  // ── 2. An unverified address never reaches the linker ────────────────────
  // `=== true`, not truthiness. The linker checks this again; this one exists
  // to give the person the right sentence, that one to stay true after a
  // second caller appears.
  if (identity.emailVerified !== true) {
    throw new SignInRefusal('verify-email', 403, 'email not verified');
  }

  const sso = isSsoSignIn(exchange);

  // ── 3. An SSO sign-in is believed only for its organisation's domains ────
  if (exchange.authenticationMethod === 'SSO') {
    if (exchange.organizationId === null) {
      // An SSO connection belongs to an organisation; a sign-in claiming SSO
      // with none is one whose domain cannot be checked, so it is refused.
      throw new SignInRefusal('sso-domain', 403, 'SSO sign-in with no organisation');
    }
    const domain = emailDomain(identity.email);
    const verified = await params.provider.verifiedDomains(exchange.organizationId);
    if (domain === null || !verified.has(domain)) {
      throw new SignInRefusal(
        'sso-domain',
        403,
        'SSO sign-in for an address outside the organisation’s verified domains',
      );
    }
  }

  // A second bucket, keyed on the identity. The IP bucket the route spends
  // first is too coarse behind a corporate NAT and useless against a botnet;
  // together, one attacker cannot lock out every user behind a shared address,
  // and one account cannot be hammered from many.
  const perIdentity = await consume(
    services.env,
    'RL_LOGIN',
    attemptKey(services.meta.ipAddress, identity.subject),
  );
  if (!perIdentity.allowed) throw new SignInRefusal('rate-limited', 429, 'per-identity limit');

  // ── 4. Link ──────────────────────────────────────────────────────────────
  // `identity` is passed exactly as `workosIdentity()` minted it: the linker
  // refuses a copy, a spread or a parsed body, whatever its type says.
  const linked = await upsertUserFromWorkosIdentity(services.db, identity).catch(
    (cause: unknown) => {
      if (cause instanceof RepositoryError) {
        switch (cause.code) {
          case 'forbidden':
            throw new SignInRefusal('verify-email', 403, 'linker: email not verified');
          case 'notFound':
            // 403, not 404: this caller has just proven control of the
            // identity, so "this account was deleted" tells them nothing they
            // are not entitled to know.
            throw new SignInRefusal('account-deleted', 403, 'linker: account deleted');
          case 'conflict':
            // Names neither the other account nor how it signs in — see
            // `lib/sign-in-errors.ts`.
            throw new SignInRefusal('account-conflict', 409, `linker: ${cause.message}`);
          default:
            break;
        }
      }
      // A TypeError from the linker is a programming error — an identity that
      // was not minted from the API response — and is a 500, loudly.
      throw cause;
    },
  );
  const { user, outcome } = linked;

  let memberships = await listOrganizationsForUser(services.db, user.id);

  // An adoption is audited the moment it is written, not at the end. The
  // linker has already put this WorkOS identity on the account; if the steps
  // below then refuse the sign-in (sso_required, no seat), the link stays, and
  // "who could sign in as this account, and since when" must still find it.
  // An account with no organisation yet has nowhere to file it until step 7.
  let linkAudited = false;
  const auditLink = (orgId: string) => {
    services.waitUntil(
      writeEvents(services, [
        auditFor(orgId, user, services).success(
          'auth.identity_linked',
          { type: 'user', id: user.id },
          { source: 'dashboard', signInMethod: signInMethodOf(exchange.authenticationMethod) },
        ),
      ]),
    );
    linkAudited = true;
  };
  if (outcome === 'linked' && memberships[0]) auditLink(memberships[0].organization.id);

  // ── 5. sso_required ──────────────────────────────────────────────────────
  // Every organisation the account is in that requires SSO must be the one
  // whose SSO this was. An account in two such organisations can satisfy only
  // one per sign-in and is refused — the strict reading, because the session
  // this would issue is not scoped to an organisation and would carry the
  // other organisation's access without its identity provider's say-so.
  for (const membership of memberships) {
    const organization = membership.organization;
    if (!organization.ssoRequired) continue;
    if (
      sso &&
      organization.workosOrgId !== null &&
      organization.workosOrgId === exchange.organizationId
    ) {
      continue;
    }
    throw new SignInRefusal(
      'sso-required',
      403,
      `organisation ${organization.id} requires SSO; this sign-in was ${exchange.authenticationMethod ?? 'unspecified'}`,
    );
  }

  // ── 6. Just-in-time membership ───────────────────────────────────────────
  if (sso && exchange.organizationId !== null) {
    const organization = await findOrgByWorkosOrgId(services.db, exchange.organizationId);
    if (organization && !memberships.some((m) => m.organization.id === organization.id)) {
      const joined = await joinOrganizationJustInTime(services.db, {
        orgId: organization.id,
        userId: user.id,
        role: JIT_DEFAULT_ROLE,
      });
      const audit = auditFor(organization.id, user, services);

      if (joined.outcome === 'no-seat') {
        // An adoption with no organisation to file it under yet (step 7 never
        // runs on this path): filed under the organisation whose sign-in it
        // was, rather than not at all.
        if (outcome === 'linked' && !linkAudited) auditLink(organization.id);
        services.waitUntil(
          writeEvents(services, [
            audit.error('member.jit_denied', { type: 'member', id: null }, 'quotaExceeded', {
              targetEmail: user.email,
              newRole: JIT_DEFAULT_ROLE,
              limitName: 'seats',
            }),
          ]),
        );
        throw new SignInRefusal('no-seat', 403, `organisation ${organization.id} has no free seat`);
      }

      if (joined.outcome === 'joined') {
        services.waitUntil(
          writeEvents(services, [
            audit.success(
              'member.jit_joined',
              { type: 'member', id: joined.member.id },
              { targetEmail: user.email, newRole: JIT_DEFAULT_ROLE, signInMethod: 'sso' },
            ),
          ]),
        );
        memberships = await listOrganizationsForUser(services.db, user.id);
      }
      // `already-member` is a suspended membership: JIT never reinstates.
    }
  }

  // ── 7. A personal organisation for an account with none ──────────────────
  // What makes the product usable within a minute of signing up. Under the
  // same ceiling as `POST /api/orgs` — see `provisionOrganization` for why the
  // limit is threaded through even though an account reaching this branch
  // holds no organisation and cannot be refused.
  if (memberships.length === 0) {
    const created = await provisionOrganization(services.db, {
      user,
      envelope: services.envelope,
      limit: ORGANIZATIONS_PER_ACCOUNT_LIMIT,
    });
    memberships = await listOrganizationsForUser(services.db, user.id);

    services.waitUntil(
      writeEvents(services, [
        auditFor(created.organization.id, user, services).success('org.created', {
          type: 'org',
          id: created.organization.id,
        }),
      ]),
    );
    if (outcome === 'linked' && !linkAudited) auditLink(created.organization.id);
  }

  // ── 8. The session ───────────────────────────────────────────────────────
  // The new session and, for a re-authentication, the record that it is one,
  // in one transaction: either the browser gets a session that carries lock
  // one, or it gets nothing — never a session that silently does not, which
  // the reset screen would show as an unexplained "sign in again".
  const armsLockOne =
    params.purpose === 'reauth' && countsAsReauthentication(exchange.authenticationMethod);
  const { token, sessionId } = await services.db.transaction(async (tx) => {
    const issued = await issueSession(services, user.id, tx);
    // The first of the vault reset's two locks, recorded against the session
    // this sign-in just issued, so it is the new cookie — and only the new
    // cookie — that carries it.
    if (armsLockOne) {
      await recordFreshSignIn(tx, { userId: user.id, sessionId: issued.sessionId, at: new Date() });
    }
    return issued;
  });

  if (params.purpose === 'reauth' && !armsLockOne) {
    // Signed in, but not with a method that counts — an emailed code, most
    // likely, which would make the two locks one inbox twice. The person is
    // signed in all the same; the reset screen asks them to sign in again
    // with one that does.
    log.warn('A re-authentication sign-in used a method that does not count as lock one', {
      signInMethod: signInMethodOf(exchange.authenticationMethod),
    });
  }

  // Last, once the new session exists: the browser is about to be handed a
  // new session cookie, which overwrites whatever it held. If that was a live
  // session of this same account, it is revoked rather than left behind —
  // nothing can present it any more, so all it could still do is be stolen,
  // and it would sit in the device list looking like a second browser. Done
  // after the issue, so a failure here costs a stale device-list row rather
  // than a browser with no session at all.
  await retireSupersededSession(services, params.presentedSessionToken, user.id);

  const primary = memberships[0];
  if (primary) {
    services.waitUntil(
      writeEvents(services, [
        auditFor(primary.organization.id, user, services).success(
          SIGN_IN_ACTIONS[outcome],
          { type: 'session', id: sessionId },
          { source: 'dashboard', signInMethod: signInMethodOf(exchange.authenticationMethod) },
        ),
      ]),
    );
  }

  log.debug(`Signed a user in through WorkOS — ${outcome}`, {
    outcome,
    purpose: params.purpose,
    signInMethod: signInMethodOf(exchange.authenticationMethod),
  });

  return { user, outcome, memberships, cookies: sessionCookies(token), sessionId };
}

/**
 * What each linker outcome's successful sign-in is audited as (PR #100, note 3).
 * An adoption also records `auth.identity_linked`, separately, at the moment
 * the link is written — see step 4.
 */
const SIGN_IN_ACTIONS = {
  matched: 'auth.login',
  linked: 'auth.login',
  created: 'auth.signup',
} as const satisfies Record<IdentityLinkOutcome, AuditRecord['action']>;

/** Whether this sign-in came through the organisation's own identity provider. */
function isSsoSignIn(exchange: AuthorizationCodeExchange<WorkosIdentity>): boolean {
  return exchange.authenticationMethod === 'SSO' && exchange.organizationId !== null;
}

/**
 * The domain of an address, lower-cased — or `null` for one that is not plain
 * ASCII.
 *
 * ASCII only, for the same reason adoption is (`isSameAddress` in the users
 * repository): an internationalised domain can arrive in Unicode or punycode,
 * and two spellings of one domain must not be compared as if they were the same
 * string, nor two different domains as if they were one. A non-ASCII domain is
 * refused rather than guessed at.
 */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  const domain = email.slice(at + 1);
  if (!/^[\x21-\x7e]+$/.test(domain)) return null;
  return domain.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/**
 * WorkOS's names for the sign-in methods that count as the vault reset's first
 * lock — exactly these, and nothing matched by pattern, so that a method WorkOS
 * adds, or one an operator switches on later, does not count until somebody
 * decides here that it should.
 *
 * ── What each one actually proves ──
 * Not the same thing, and ADR 0010 says so:
 *
 *  - `Password`, `Passkey` — typed or tapped on AuthKit's own page. The login
 *    route's `max_age=0` makes AuthKit ask for them even when it holds a
 *    session, so these are a credential presented just now.
 *  - `GoogleOAuth`, `SSO` — AuthKit hands off to Google or the company's
 *    identity provider, which WorkOS's `max_age` does not reach. A live Google
 *    or SSO session in the same browser satisfies them without a prompt. They
 *    count because refusing them would leave Google-only and SSO users no way
 *    to reset at all; what they prove is "this browser can sign in to that
 *    account now", not "somebody typed a secret just now".
 *
 * Not here: `MagicAuth` (lock two is already an emailed code, and counting it
 * would make the two locks one inbox twice), other OAuth providers (none is
 * enabled; add one here deliberately when it is), and anything unnamed.
 */
export const REAUTHENTICATING_METHODS: ReadonlySet<string> = new Set([
  'Password',
  'Passkey',
  'GoogleOAuth',
  'SSO',
]);

/** Whether a sign-in by `method` counts as the vault reset's first lock. */
export function countsAsReauthentication(method: string | null): boolean {
  return method !== null && REAUTHENTICATING_METHODS.has(method);
}

/** WorkOS's method names, folded into the audit log's closed set. */
export function signInMethodOf(method: string | null): SignInMethod {
  if (method === null) return 'other';
  if (method === 'SSO') return 'sso';
  if (method === 'Password') return 'password';
  if (method === 'MagicAuth') return 'magic_auth';
  if (method === 'Passkey') return 'passkey';
  if (method.endsWith('OAuth')) return 'oauth';
  return 'other';
}

/**
 * Issues a session for an already-authenticated user. Unchanged from the
 * Firebase sign-in it was lifted out of: a 256-bit opaque token, only its hash
 * stored, the request's address and user agent beside it.
 */
export async function issueSession(
  services: ServiceContext,
  userId: string,
  exec: Executor = services.db,
): Promise<{ token: string; sessionId: string }> {
  const { token } = await generateToken('session');

  const session = await createSession(exec, {
    userId,
    token,
    ipAddress: services.meta.ipAddress,
    userAgent: services.meta.userAgent,
  });

  return { token, sessionId: session.id };
}

/** The session cookie and its CSRF pair, as `Set-Cookie` values. */
export function sessionCookies(token: string): string[] {
  return [
    serializeCookie(sessionCookie(token)),
    // Readable by JavaScript on purpose — the client must echo it in a header,
    // which is the whole double-submit mechanism. It carries no authority
    // without the HttpOnly session cookie.
    csrfCookie(generateCsrfToken(), Math.floor(SESSION_LIFETIME_MS / 1000)),
  ];
}

async function retireSupersededSession(
  services: ServiceContext,
  token: string | null,
  userId: string,
): Promise<void> {
  if (token === null || !isWellFormedToken(token, 'session')) return;
  const existing = await findSessionByTokenHash(services.db, await hashToken(token));
  if (existing && existing.user.id === userId) await revokeSession(services.db, existing.id);
}

export function auditFor(
  orgId: string,
  user: { id: string; email: string },
  services: ServiceContext,
) {
  return createAuditBuilder({
    orgId,
    actorType: 'user',
    actorId: user.id,
    actorLabel: user.email,
    ipAddress: services.meta.ipAddress,
    userAgent: services.meta.userAgent,
    requestId: services.meta.requestId,
  });
}

/**
 * Writes audit events directly rather than through the request recorder.
 *
 * The sign-in resolves its organisation part-way through, so events are
 * produced at several points and can carry different `org_id` values. Writing
 * each as it is produced is clearer than rebinding a recorder mid-request, and
 * these are low-volume paths — one or two rows per sign-in.
 *
 * A failure is logged rather than rethrown: the response has been decided by
 * the time this runs, and failing a successful sign-in because its audit row
 * could not be written would be the wrong trade. It is logged at `error` so it
 * is alertable.
 */
export async function writeEvents(services: ServiceContext, events: AuditRecord[]): Promise<void> {
  try {
    await new DatabaseAuditSink(services.db).write(events);
  } catch (cause) {
    services.log
      .at('writeEvents')
      .error(
        `Failed to write the audit record for ${events[0]?.action ?? 'an event'} — the act ` +
          'itself happened, but this event is now missing from the audit log',
        { action: events[0]?.action, error: describeError(cause) },
      );
  }
}

/** The isolate's derived state-cookie key, keyed by the secret it came from. */
let cachedStateKey: { secret: string; key: Promise<CryptoKey> } | undefined;

/**
 * The MAC key for the sign-in state cookie, derived once per isolate.
 *
 * A missing or too-short `WORKOS_COOKIE_PASSWORD` is an operator fault, and is
 * reported as one — a 503 naming the binding — rather than signing state with
 * a weak key.
 */
export async function oauthStateKey(env: Bindings): Promise<CryptoKey> {
  const secret = env.WORKOS_COOKIE_PASSWORD;
  if (!secret) throw new MissingBindingError('WORKOS_COOKIE_PASSWORD');

  if (cachedStateKey?.secret !== secret) {
    cachedStateKey = { secret, key: deriveOAuthStateKey(secret) };
  }
  try {
    return await cachedStateKey.key;
  } catch {
    cachedStateKey = undefined;
    throw new MissingBindingError('WORKOS_COOKIE_PASSWORD (at least 32 characters)');
  }
}

/** Exists for tests. */
export function resetSignInCachesForTesting(): void {
  cachedStateKey = undefined;
}

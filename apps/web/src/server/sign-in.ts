import {
  csrfCookie,
  deriveOAuthStateKey,
  deriveSignInConfirmationKey,
  generateCsrfToken,
  generateToken,
  hashToken,
  isWellFormedToken,
  serializeCookie,
  SESSION_LIFETIME_MS,
  sessionCookie,
} from '@xecret/core/auth';
import type {
  AuthorizationCodeExchange,
  OAuthPurpose,
  ParkedLockOne,
  SignInConfirmationReason,
  WorkosIdentity,
} from '@xecret/core/auth';
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
 * Two halves, because a session is not always issued in the request that
 * prepared it. {@link prepareSignIn} is steps 1–7; {@link issueSignIn} is step
 * 8. Between them the callback asks {@link confirmationReason} whether the
 * person must confirm first (the planted-session login CSRF, review S1) — and
 * if so parks the prepared result in a sealed cookie, and step 8 runs only when
 * the person answers "Continue" on `/sign-in/confirm`.
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
 *  5. **Just-in-time join** the organisation whose SSO this was, if any, and
 *     only if that organisation opted in to admitting people that way — and
 *     never somebody it removed.
 *  6. **`sso_required`, at sign-in.** The requirement is enforced on every
 *     request (`resolveOrg`), against how the session signed in, so a session
 *     that does not satisfy one organisation simply cannot reach that one. The
 *     sign-in itself is refused only when it would leave the account with *no*
 *     organisation it could use — every one of its memberships requires a
 *     single sign-on this was not. One organisation's requirement no longer
 *     locks somebody out of every other (review S6).
 *  7. **Provision a personal organisation** for an account that still has none.
 *  8. **Issue the session** — recording how it signed in, which is what step 6's
 *     per-request half reads — and for a forced re-authentication, record that
 *     it happened if the method counts and the provider says the person
 *     actually authenticated during this flow (see {@link armsLockOne}). Then
 *     audit the sign-in, and the owner exemption in every organisation it was
 *     used in.
 *
 * Steps 3, 5 and 6 key on `authenticationMethod === 'SSO'` *and* the
 * organisation id together. AuthKit reports an organisation after organisation
 * *selection* in password and Google sign-ins too, so the id alone does not
 * mean the organisation's identity provider vouched for anybody.
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

/**
 * How a sign-in authenticated, as the session it issues records it (migration
 * 0022) — and so as every later request is judged by.
 */
export interface SignInFacts {
  signInMethod: SignInMethod;
  /**
   * The WorkOS organisation whose own identity provider vouched for this
   * sign-in, or `null`. Set only for `SSO` with an organisation — never for an
   * organisation AuthKit reported after organisation *selection*.
   */
  ssoWorkosOrgId: string | null;
}

/** Steps 1–7 done: everything issuing a session needs, and nothing issued yet. */
export interface PreparedSignIn {
  user: User;
  outcome: IdentityLinkOutcome;
  facts: SignInFacts;
  /** For a `reauth`, how lock one was judged (see {@link armsLockOne}); `null` otherwise. */
  lockOne: ParkedLockOne | null;
}

export interface SignInResult {
  user: Pick<User, 'id' | 'email'>;
  outcome: IdentityLinkOutcome;
  memberships: OrganizationMembership[];
  /** `Set-Cookie` values for the new session and its CSRF pair. */
  cookies: string[];
  sessionId: string;
}

export interface PrepareSignInParams {
  exchange: AuthorizationCodeExchange<WorkosIdentity>;
  purpose: OAuthPurpose;
  provider: Pick<WorkosIdentityProvider, 'verifiedDomains'>;
  /**
   * When this sign-in flow began — the state cookie's `issuedAt`, in seconds
   * since the epoch, which only this server can have written.
   */
  flowIssuedAt: number;
}

/**
 * Steps 1–7 above. Throws {@link SignInRefusal} for every refusal a person is
 * told about, and lets anything else — a programming error, the database —
 * escape to the caller's 500 handling.
 */
export async function prepareSignIn(
  services: ServiceContext,
  params: PrepareSignInParams,
): Promise<PreparedSignIn> {
  const { exchange } = params;
  const { identity } = exchange;
  const log = services.log.at('prepareSignIn');

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

  const facts = signInFactsOf(exchange);

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
  // below then refuse the sign-in (sso_required, no seat) — or the person never
  // confirms it — the link stays, and "who could sign in as this account, and
  // since when" must still find it. An account with no organisation yet has
  // nowhere to file it until step 7.
  let linkAudited = false;
  const auditLink = (orgId: string) => {
    services.waitUntil(
      writeEvents(services, [
        auditFor(orgId, user, services).success(
          'auth.identity_linked',
          { type: 'user', id: user.id },
          { source: 'dashboard', signInMethod: facts.signInMethod },
        ),
      ]),
    );
    linkAudited = true;
  };
  if (outcome === 'linked' && memberships[0]) auditLink(memberships[0].organization.id);

  // ── 5. Just-in-time membership ───────────────────────────────────────────
  // Only for an organisation that opted in (`jit_join_enabled`, off by
  // default): connecting an identity provider says who an organisation's
  // people are, and admitting every one of them is a separate decision an
  // owner takes in the SSO settings (PR #114's constraint for WS-5). Checked
  // here on the row just found, to skip the transaction for the organisations
  // that have not; the check that counts is the repository's, under the row
  // lock, which answers `not-enabled` if it was switched off in between — and
  // `removed` for somebody the organisation removed (review S4). Without a
  // join the person simply signs in to whatever else they belong to — a
  // personal organisation, for a newcomer — and joins this one the ordinary
  // way, by invitation.
  if (facts.ssoWorkosOrgId !== null) {
    const organization = await findOrgByWorkosOrgId(services.db, facts.ssoWorkosOrgId);
    if (
      organization &&
      organization.jitJoinEnabled &&
      !memberships.some((m) => m.organization.id === organization.id)
    ) {
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

      if (joined.outcome === 'removed') {
        // Not a refusal of the sign-in — the person may well belong elsewhere
        // — but a record, in the organisation that removed them, that its
        // identity provider is still vouching for somebody it showed the door.
        services.waitUntil(
          writeEvents(services, [
            audit.error('member.jit_denied', { type: 'member', id: null }, 'removed', {
              targetEmail: user.email,
              newRole: JIT_DEFAULT_ROLE,
              signInMethod: 'sso',
            }),
          ]),
        );
        log.info(
          'Did not re-admit somebody this organisation removed, though its identity provider ' +
            'vouched for them; they rejoin only by invitation',
          { orgId: organization.id },
        );
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
      // `not-enabled` is the opt-in switched off since the row above was read.
    }
  }

  // ── 6. sso_required, at sign-in ──────────────────────────────────────────
  // Every organisation the account is in is either usable by this sign-in or
  // not, by the same rule `resolveOrg` applies on every request: not requiring
  // SSO, or this organisation's own SSO, or an owner (the break-glass). One
  // usable organisation is enough to sign in; the others refuse this session
  // when it reaches them. Only an account left with nothing usable is turned
  // away here — the sentence on the sign-in page is kinder than a dashboard
  // full of refusals.
  if (
    memberships.length > 0 &&
    memberships.every((membership) => refusesThisSignIn(membership, facts))
  ) {
    const first = memberships[0]!.organization;
    throw new SignInRefusal(
      'sso-required',
      403,
      `every organisation of this account requires its SSO (e.g. ${first.id}); this sign-in was ${exchange.authenticationMethod ?? 'unspecified'}`,
    );
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

  // Lock one is judged here, on the exchange, whether or not the session is
  // issued in this request: a parked re-authentication carries the verdict to
  // the confirmation, which cannot see the exchange any more.
  const lockOne = params.purpose === 'reauth' ? armsLockOne(exchange, params.flowIssuedAt) : null;
  if (lockOne !== null && lockOne !== 'armed') {
    // Signed in, but not in a way that counts. The person is signed in all the
    // same; the reset screen asks them to sign in again. Which way it fell
    // short is for the log: a method that does not count is an emailed code,
    // most likely, which would make the two locks one inbox twice; a stale
    // authentication is a provider that reused its session without asking —
    // `max_age=0` stripped from the URL, or not honoured.
    log.warn(
      lockOne === 'method'
        ? 'A re-authentication sign-in used a method that does not count as lock one'
        : 'A re-authentication sign-in did not show a fresh authentication, so it is not lock one',
      {
        signInMethod: facts.signInMethod,
        reason: lockOne,
        ...(typeof exchange.authenticatedAt !== 'number'
          ? {}
          : { authenticatedSecondsBeforeFlow: params.flowIssuedAt - exchange.authenticatedAt }),
      },
    );
  }

  return { user, outcome, facts, lockOne };
}

/**
 * Whether a sign-in that is about to issue a session must be confirmed by the
 * person first — and why — or `null` when it may be issued straight away.
 *
 * ── The attack this exists for (review S1) ──
 * `state` and PKCE prove the callback completes a flow this browser started;
 * they cannot prove *whose* authentication came back, because AuthKit reuses a
 * session it already holds without asking. An attacker who owns a WorkOS
 * organisation here, wired to an identity provider they control, can plant
 * their own AuthKit session in a victim's browser — a hidden navigation to
 * AuthKit's authorize URL for their organisation, or their provider's
 * IdP-initiated sign-in through the initiate-login URI — and the victim's next
 * plain "Sign in" comes back as the attacker, against the victim's valid state.
 * The victim would land in the attacker's account and store their secrets
 * there. Two signs give it away, and either one parks the sign-in:
 *
 *  - `'organization'` — it came back through an organisation the flow did not
 *    ask for (the state seals what it asked for: an `?org=` deep link, or
 *    nothing). That includes every single-sign-on result of a plain sign-in,
 *    and an organisation reported after organisation selection. A person who
 *    really did sign in through their company's identity provider answers one
 *    question; a person whose browser was used against them gets to say no.
 *  - `'reused-session'` — WorkOS answered from an authentication that predates
 *    the flow (its `auth_time`, beyond {@link REAUTH_AUTH_TIME_SKEW_SECONDS}):
 *    a session reused without asking anything, which is the planted session's
 *    own signature whatever organisation it names. Only where WorkOS says when
 *    the person authenticated; without that, only the organisation is checked.
 */
export function confirmationReason(
  flow: { organizationId: string | null; issuedAt: number },
  exchange: Pick<AuthorizationCodeExchange, 'organizationId' | 'authenticatedAt'>,
): SignInConfirmationReason | null {
  if (exchange.organizationId !== flow.organizationId) return 'organization';
  if (
    typeof exchange.authenticatedAt === 'number' &&
    Number.isFinite(exchange.authenticatedAt) &&
    exchange.authenticatedAt < flow.issuedAt - REAUTH_AUTH_TIME_SKEW_SECONDS
  ) {
    return 'reused-session';
  }
  return null;
}

export interface IssueSignInParams {
  user: Pick<User, 'id' | 'email'>;
  outcome: IdentityLinkOutcome;
  facts: SignInFacts;
  purpose: OAuthPurpose;
  lockOne: ParkedLockOne | null;
  /** The session cookie this browser presented, if any — replaced by the new one. */
  presentedSessionToken: string | null;
}

/**
 * Step 8: issues the session — from the callback for a sign-in that needed no
 * confirmation, or from the confirmation's POST for one that did.
 */
export async function issueSignIn(
  services: ServiceContext,
  params: IssueSignInParams,
): Promise<SignInResult> {
  const { user, outcome, facts } = params;
  const log = services.log.at('issueSignIn');

  // The new session and, for a re-authentication, the record that it is one,
  // in one transaction: either the browser gets a session that carries lock
  // one, or it gets nothing — never a session that silently does not, which
  // the reset screen would show as an unexplained "sign in again".
  const { token, sessionId } = await services.db.transaction(async (tx) => {
    const issued = await issueSession(services, user.id, tx, facts);
    // The first of the vault reset's two locks, recorded against the session
    // this sign-in just issued, so it is the new cookie — and only the new
    // cookie — that carries it.
    if (params.lockOne === 'armed') {
      await recordFreshSignIn(tx, { userId: user.id, sessionId: issued.sessionId, at: new Date() });
    }
    return issued;
  });

  // Last, once the new session has committed: the browser is about to be
  // handed a new session cookie, which overwrites whatever it held. If that
  // was a live session of this same account, it is revoked rather than left
  // behind — nothing can present it any more, so all it could still do is be
  // stolen, and it would sit in the device list looking like a second browser.
  //
  // After the issue, and never allowed to fail the sign-in. Before it, a
  // sign-in that then failed would have revoked the session the browser still
  // had and issued none. And a failure here, thrown, would answer with an
  // error page while the new session — committed, and never handed to anybody
  // — stayed live. So it is caught and logged: what it costs is the old
  // session staying in the device list until it expires or somebody signs it
  // out there, and the error line is what makes that visible.
  try {
    await retireSupersededSession(services, params.presentedSessionToken, user.id);
  } catch (cause) {
    log.error(
      'Signed a user in, but could not revoke the session this browser held before — it stays ' +
        'live, in the device list, until it expires or is signed out there',
      { error: describeError(cause) },
    );
  }

  const memberships = await listOrganizationsForUser(services.db, user.id);
  const events: AuditRecord[] = [];
  const primary = memberships[0];
  if (primary) {
    events.push(
      auditFor(primary.organization.id, user, services).success(
        SIGN_IN_ACTIONS[outcome],
        { type: 'session', id: sessionId },
        { source: 'dashboard', signInMethod: facts.signInMethod },
      ),
    );
  }

  // ── The owner exemption, filed where it was used (review C3) ──
  // `auth.login` lands in one organisation; an owner of several that require
  // SSO bypassed each of their identity providers, and each one's own log is
  // where its administrators look. So a record per organisation, beside the
  // log line.
  for (const membership of memberships) {
    if (!usesOwnerExemption(membership, facts)) continue;
    log.info(
      'An owner signed in without their organisation’s required single sign-on; owners are ' +
        'exempt, so that a broken identity provider cannot lock the organisation out',
      { orgId: membership.organization.id, signInMethod: facts.signInMethod },
    );
    events.push(
      auditFor(membership.organization.id, user, services).success(
        'auth.sso_exemption_used',
        { type: 'session', id: sessionId },
        { source: 'dashboard', signInMethod: facts.signInMethod },
      ),
    );
  }
  if (events.length > 0) services.waitUntil(writeEvents(services, events));

  log.debug(`Signed a user in through WorkOS — ${outcome}`, {
    outcome,
    purpose: params.purpose,
    signInMethod: facts.signInMethod,
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

/** What the session a sign-in issues will record about how it signed in. */
export function signInFactsOf(
  exchange: Pick<AuthorizationCodeExchange, 'authenticationMethod' | 'organizationId'>,
): SignInFacts {
  const sso = exchange.authenticationMethod === 'SSO' && exchange.organizationId !== null;
  return {
    signInMethod: signInMethodOf(exchange.authenticationMethod),
    ssoWorkosOrgId: sso ? exchange.organizationId : null,
  };
}

/** Whether this organisation's `sso_required` would refuse a session signed in so. */
function refusesThisSignIn(membership: OrganizationMembership, facts: SignInFacts): boolean {
  const organization = membership.organization;
  if (!organization.ssoRequired || membership.role === 'owner') return false;
  return organization.workosOrgId === null || facts.ssoWorkosOrgId !== organization.workosOrgId;
}

/** Whether a sign-in so reaches this organisation only by the owner exemption. */
function usesOwnerExemption(membership: OrganizationMembership, facts: SignInFacts): boolean {
  const organization = membership.organization;
  return (
    organization.ssoRequired &&
    membership.role === 'owner' &&
    (organization.workosOrgId === null || facts.ssoWorkosOrgId !== organization.workosOrgId)
  );
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
 *    session, and {@link armsLockOne} checks WorkOS's `auth_time` to see that
 *    it did, so these are a credential presented just now.
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

/**
 * How far before the flow began an active authentication may be dated and
 * still count, for the difference between this server's clock and WorkOS's.
 * The same allowance decides when a sign-in is a reused session that must be
 * confirmed ({@link confirmationReason}).
 */
export const REAUTH_AUTH_TIME_SKEW_SECONDS = 30;

/**
 * Whether a `reauth` sign-in arms the vault reset's first lock — and if not,
 * why not.
 *
 * Two conditions. The method has to be one of {@link REAUTHENTICATING_METHODS};
 * and the provider has to say the person actively authenticated **during this
 * flow** — `authenticatedAt` (WorkOS's `auth_time`) no earlier than the moment
 * the flow began, less {@link REAUTH_AUTH_TIME_SKEW_SECONDS}.
 *
 * The second closes the gap `max_age=0` left open on its own. That parameter
 * rides in a URL the browser follows, and somebody at an unlocked laptop can
 * strip it; AuthKit then reuses the session it holds without asking for
 * anything, and the code it mints is dated by that session's original sign-in.
 * Checking the date makes AuthKit's honouring of `max_age=0` something the
 * server sees, rather than takes on trust. A missing or unreadable date fails
 * closed: no lock one. "Unreadable" is anything that is not a finite number —
 * checked as such here rather than as `=== null`, so a value that slipped past
 * the parser's type (a string, `undefined`, `NaN`) can never compare its way
 * into arming the lock.
 *
 * What it does not change: a Google or identity-provider session that signs the
 * person in silently is, as far as WorkOS is concerned, an active
 * authentication, so its date is fresh — ADR 0010 records that residual.
 */
export function armsLockOne(
  exchange: Pick<
    AuthorizationCodeExchange<WorkosIdentity>,
    'authenticationMethod' | 'authenticatedAt'
  >,
  flowIssuedAt: number,
): ParkedLockOne {
  if (!countsAsReauthentication(exchange.authenticationMethod)) return 'method';
  if (typeof exchange.authenticatedAt !== 'number' || !Number.isFinite(exchange.authenticatedAt)) {
    return 'no-auth-time';
  }
  if (exchange.authenticatedAt < flowIssuedAt - REAUTH_AUTH_TIME_SKEW_SECONDS) return 'stale';
  return 'armed';
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
 * Firebase sign-in it was lifted out of — a 256-bit opaque token, only its hash
 * stored, the request's address and user agent beside it — and now also how
 * the sign-in authenticated, which every later request is judged by
 * (`resolveOrg`). Without `facts` the session records nothing, which reads as
 * "not single sign-on".
 */
export async function issueSession(
  services: ServiceContext,
  userId: string,
  exec: Executor = services.db,
  facts?: SignInFacts,
): Promise<{ token: string; sessionId: string }> {
  const { token } = await generateToken('session');

  const session = await createSession(exec, {
    userId,
    token,
    ipAddress: services.meta.ipAddress,
    userAgent: services.meta.userAgent,
    signInMethod: facts?.signInMethod ?? null,
    ssoWorkosOrgId: facts?.ssoWorkosOrgId ?? null,
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

/** The isolate's derived cookie keys, keyed by the secret they came from. */
let cachedStateKey: { secret: string; key: Promise<CryptoKey> } | undefined;
let cachedConfirmationKey: { secret: string; key: Promise<CryptoKey> } | undefined;

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

/**
 * The MAC key for the sign-in confirmation cookie: the same operator secret,
 * under the confirmation's own HKDF label, so neither cookie can stand in for
 * the other. Same failure as {@link oauthStateKey}.
 */
export async function signInConfirmationKey(env: Bindings): Promise<CryptoKey> {
  const secret = env.WORKOS_COOKIE_PASSWORD;
  if (!secret) throw new MissingBindingError('WORKOS_COOKIE_PASSWORD');

  if (cachedConfirmationKey?.secret !== secret) {
    cachedConfirmationKey = { secret, key: deriveSignInConfirmationKey(secret) };
  }
  try {
    return await cachedConfirmationKey.key;
  } catch {
    cachedConfirmationKey = undefined;
    throw new MissingBindingError('WORKOS_COOKIE_PASSWORD (at least 32 characters)');
  }
}

/** Exists for tests. */
export function resetSignInCachesForTesting(): void {
  cachedStateKey = undefined;
  cachedConfirmationKey = undefined;
}

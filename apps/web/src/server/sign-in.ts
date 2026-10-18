import {
  csrfCookie,
  deriveLastAccountKey,
  deriveOAuthStateKey,
  deriveSignInConfirmationKey,
  deriveSsoContinueKey,
  generateCsrfToken,
  generateToken,
  hashToken,
  isWellFormedToken,
  lastAccountCookie,
  sealLastAccount,
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
  findMembership,
  findOrgByWorkosOrgId,
  findSessionByTokenHash,
  joinOrganizationJustInTime,
  listOrganizationsForUser,
  provisionOrganization,
  recordFreshSignIn,
  RepositoryError,
  revokeSession,
  upsertUserFromWorkosIdentity,
  wasRemovedFrom,
} from '@xecret/db/repositories';
import type {
  Executor,
  IdentityLinkOutcome,
  Organization,
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
 * prepared it. {@link prepareSignIn} decides who this is and whether they may
 * sign in at all; {@link issueSignIn} does everything that touches an
 * organisation and issues the session. Between them the callback asks
 * {@link confirmationReason} whether the person must confirm first (the
 * planted-session login CSRF, review S1 and round 2) — and if so parks the
 * prepared result in a sealed cookie, and `issueSignIn` runs only when the
 * person answers "Continue" on `/sign-in/confirm`. "This isn't me" then leaves
 * no trace in any organisation (review round 2, L6): nothing that changes one
 * runs before the answer.
 *
 * The order, and why each step is where it is:
 *
 * **Prepare** (`prepareSignIn`)
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
 *  5. **Plan the just-in-time join** — read-only: which organisation here, in
 *     this deployment's WorkOS environment, the single sign-on came through,
 *     whether the account is already an active member of it (if not, the
 *     callback holds the sign-in back: `not-member`), and whether that
 *     organisation would admit it.
 *  6. **`sso_required`, at sign-in.** The requirement is enforced on every
 *     request (`resolveOrg`), against how the session signed in, so a session
 *     that does not satisfy one organisation simply cannot reach that one. The
 *     sign-in itself is refused only when it would leave the account with *no*
 *     organisation it could use — every one of its memberships requires a
 *     single sign-on this was not, and no join is in prospect. One
 *     organisation's requirement no longer locks somebody out of every other
 *     (review S6).
 *  7. **Provision a personal organisation** for an account that has none and
 *     is not about to join one. This one *does* run before the confirmation:
 *     it is the account's own, created for the identity that just signed in
 *     (the linker created that account a step earlier, too), and it touches no
 *     other organisation — so declining leaves nothing in anybody else's.
 *
 * **Issue** (`issueSignIn`)
 *  8. **Just-in-time join**, under the organisation's row lock — only if it
 *     opted in to admitting people that way, and never somebody it removed —
 *     then `sso_required` and the personal organisation again, for the account
 *     as the join left it.
 *  9. **Issue the session** — recording how it signed in, which is what step 6's
 *     per-request half reads, and the AuthKit session it came from, which
 *     sign-out ends — and for a forced re-authentication, record that it
 *     happened, dated by the authentication itself, if the method counts and
 *     the provider says the person actually authenticated during this flow
 *     (see {@link armsLockOne}). Then audit the sign-in — saying why it was
 *     held back, when it was — and the owner exemption in every organisation it
 *     was used in.
 *
 * Steps 3, 5, 6 and 8 key on `authenticationMethod === 'SSO'` *and* the
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
  /**
   * For a `reauth` in which the person actively authenticated during the flow
   * by a method that re-proves who they are (see {@link freshAuthenticationAt}),
   * when — WorkOS's `auth_time`, seconds since the epoch. `null` otherwise.
   */
  freshAuthAt: number | null;
  /** The AuthKit session this sign-in came from (WorkOS's `sid`), or `null`. */
  providerSessionId: string | null;
  /**
   * The organisation here, linked in this deployment's WorkOS environment,
   * whose single sign-on this was — or `null`, for any sign-in that was not one
   * and for an identity provider no organisation here is linked to.
   */
  ssoOrganization: Organization | null;
  /** Whether the account is already an active member of {@link ssoOrganization}. */
  ssoMember: boolean;
  /**
   * Whether issuing will make the account a member of {@link ssoOrganization}
   * — its just-in-time opt-in, read here and decided again under its lock at
   * issue. Said on the confirmation page, because it is a consequence.
   */
  joins: boolean;
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
  provider: Pick<WorkosIdentityProvider, 'verifiedDomains' | 'clientId'>;
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

  const memberships = await listOrganizationsForUser(services.db, user.id);

  // An adoption is audited the moment it is written, not at the end. The
  // linker has already put this WorkOS identity on the account; if the steps
  // below then refuse the sign-in (sso_required, no seat) — or the person never
  // confirms it — the link stays, and "who could sign in as this account, and
  // since when" must still find it. An account with no organisation yet has
  // nowhere to file it until step 7 — or, when it is about to join one, until
  // the join at issue (`issueSignIn` files it there).
  if (outcome === 'linked' && memberships[0]) {
    auditIdentityLinked(services, memberships[0].organization.id, user, facts);
  }

  // ── 5. The just-in-time join, planned ────────────────────────────────────
  // Read-only. Which organisation here the single sign-on came through — in
  // this deployment's WorkOS environment only (a link written from another
  // environment resolves to nothing) — whether the account already belongs to
  // it, and whether it would admit the account. The join itself is
  // `issueSignIn`'s, after any confirmation, under the organisation's lock.
  const ssoOrganization =
    facts.ssoWorkosOrgId === null
      ? null
      : await findOrgByWorkosOrgId(services.db, facts.ssoWorkosOrgId, params.provider.clientId);
  const ssoMember =
    ssoOrganization !== null && memberships.some((m) => m.organization.id === ssoOrganization.id);
  const joinCandidate = ssoOrganization !== null && ssoOrganization.jitJoinEnabled && !ssoMember;
  // Whether the join would actually happen, for the confirmation page to say
  // so — asked the way the join itself asks, under its lock, at issue. Two
  // candidates it will turn away: a removed person, and a suspended member
  // (review round 3). `memberships` lists active ones only, so somebody
  // suspended here reads as a candidate, and would be told "Continuing makes
  // this account a member of it" — and then the join answers `already-member`
  // and nothing happens. Any membership row at all, then, means no join.
  const joins =
    joinCandidate &&
    (await findMembership(services.db, ssoOrganization.id, user.id)) === null &&
    !(await wasRemovedFrom(services.db, { orgId: ssoOrganization.id, userId: user.id }));

  // ── 6. sso_required, at sign-in ──────────────────────────────────────────
  // Every organisation the account is in is either usable by this sign-in or
  // not, by the same rule `resolveOrg` applies on every request: not requiring
  // SSO, or this organisation's own SSO, or an owner (the break-glass). One
  // usable organisation is enough to sign in; the others refuse this session
  // when it reaches them. Only an account left with nothing usable, and no
  // join in prospect, is turned away here — the sentence on the sign-in page is
  // kinder than a dashboard full of refusals. (A join that then does not happen
  // is held to the same rule at issue.)
  if (!joins) assertSomeOrganizationUsable(memberships, facts, exchange.authenticationMethod);

  // ── 7. A personal organisation for an account with none ──────────────────
  // What makes the product usable within a minute of signing up. Under the
  // same ceiling as `POST /api/orgs` — see `provisionOrganization` for why the
  // limit is threaded through even though an account reaching this branch
  // holds no organisation and cannot be refused. Here, before any
  // confirmation, because it is the new account's own and nobody else's; an
  // account about to join an organisation by its single sign-on gets one only
  // if that join does not happen (`issueSignIn`).
  if (memberships.length === 0 && !joins) {
    await provisionPersonalOrganization(services, user, outcome, facts);
  }

  // Lock one is judged here, on the exchange, whether or not the session is
  // issued in this request: a parked re-authentication carries the verdict to
  // the confirmation, which cannot see the exchange any more.
  const lockOne = params.purpose === 'reauth' ? armsLockOne(exchange, params.flowIssuedAt) : null;
  const freshAuthAt =
    params.purpose === 'reauth' ? freshAuthenticationAt(exchange, params.flowIssuedAt) : null;
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

  return {
    user,
    outcome,
    facts,
    lockOne,
    freshAuthAt,
    providerSessionId: exchange.providerSessionId,
    ssoOrganization,
    ssoMember,
    joins,
  };
}

/** Step 6's rule: refuses when every organisation of the account would refuse this sign-in. */
function assertSomeOrganizationUsable(
  memberships: readonly OrganizationMembership[],
  facts: SignInFacts,
  method: string | null,
): void {
  if (
    memberships.length > 0 &&
    memberships.every((membership) => refusesThisSignIn(membership, facts))
  ) {
    const first = memberships[0]!.organization;
    throw new SignInRefusal(
      'sso-required',
      403,
      `every organisation of this account requires its SSO (e.g. ${first.id}); this sign-in was ${method ?? 'unspecified'}`,
    );
  }
}

/** Step 7: the account's own organisation, audited — and the adoption with it, if it waited. */
async function provisionPersonalOrganization(
  services: ServiceContext,
  user: Pick<User, 'id' | 'email' | 'displayName'>,
  outcome: IdentityLinkOutcome,
  facts: SignInFacts,
): Promise<void> {
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
  if (outcome === 'linked') auditIdentityLinked(services, created.organization.id, user, facts);
}

/** `auth.identity_linked`, filed in `orgId`. */
function auditIdentityLinked(
  services: ServiceContext,
  orgId: string,
  user: Pick<User, 'id' | 'email'>,
  facts: SignInFacts,
): void {
  services.waitUntil(
    writeEvents(services, [
      auditFor(orgId, user, services).success(
        'auth.identity_linked',
        { type: 'user', id: user.id },
        { source: 'dashboard', signInMethod: facts.signInMethod },
      ),
    ]),
  );
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
 * there. Three signs give it away, and any one parks the sign-in:
 *
 *  - `'organization'` — it came back through an organisation the flow did not
 *    ask for (the state seals what it asked for: an `?org=` deep link, or
 *    nothing). That includes every single-sign-on result of a plain sign-in,
 *    and an organisation reported after organisation selection. A person who
 *    really did sign in through their company's identity provider answers one
 *    question; a person whose browser was used against them gets to say no.
 *  - `'not-member'` — a single sign-on through an organisation the account is
 *    not an active member of, *even when the flow asked for that organisation*
 *    (review round 2). The `?org=` deep link is meant to be followed only from
 *    the warning page, by a person, but a deep link that arrived some other way
 *    — a chain of same-origin redirects, a way round nobody has found yet —
 *    would otherwise be the one sign-in through an attacker's organisation that
 *    issued at once. Somebody signing in to their own company's organisation is
 *    already in it; the first time, joining it is worth one question.
 *  - `'reused-session'` — WorkOS answered from an authentication that predates
 *    the flow (its `auth_time`, beyond {@link REAUTH_AUTH_TIME_SKEW_SECONDS}):
 *    a session reused without asking anything, which is the planted session's
 *    own signature whatever organisation it names. Only where WorkOS says when
 *    the person authenticated; without that, the other two are still checked.
 *    **Not asked when the account is the last one this browser signed in as**
 *    (`lastAccountUserId`, a signed cookie): that is a person back after their
 *    xecret session ended while AuthKit's had not, and asking them every time
 *    would teach them to click "Continue" without reading. A planted session
 *    is always somebody else's account, so it is still asked. Sign-out now
 *    ends the AuthKit session too, which makes this case rarer still.
 */
export function confirmationReason(params: {
  flow: { organizationId: string | null; issuedAt: number };
  exchange: Pick<AuthorizationCodeExchange, 'organizationId' | 'authenticatedAt'>;
  prepared: Pick<PreparedSignIn, 'facts' | 'ssoMember' | 'user'>;
  /** The account the browser's last-account cookie names, or `null`. */
  lastAccountUserId: string | null;
}): SignInConfirmationReason | null {
  const { flow, exchange, prepared } = params;
  if (exchange.organizationId !== flow.organizationId) return 'organization';
  if (prepared.facts.ssoWorkosOrgId !== null && !prepared.ssoMember) return 'not-member';
  if (
    typeof exchange.authenticatedAt === 'number' &&
    Number.isFinite(exchange.authenticatedAt) &&
    exchange.authenticatedAt < flow.issuedAt - REAUTH_AUTH_TIME_SKEW_SECONDS &&
    params.lastAccountUserId !== prepared.user.id
  ) {
    return 'reused-session';
  }
  return null;
}

export interface IssueSignInParams {
  user: Pick<User, 'id' | 'email' | 'displayName'>;
  outcome: IdentityLinkOutcome;
  facts: SignInFacts;
  purpose: OAuthPurpose;
  lockOne: ParkedLockOne | null;
  /** See {@link PreparedSignIn.freshAuthAt}. */
  freshAuthAt: number | null;
  /** The AuthKit session the sign-in came from, kept so that sign-out can end it. */
  providerSessionId: string | null;
  /** This deployment's WorkOS client id: a link made in any other environment admits nobody. */
  workosClientId: string;
  /** Why the sign-in was held back for the person to confirm, or `null` when it was not. */
  confirmation: SignInConfirmationReason | null;
  /** The session cookie this browser presented, if any — replaced by the new one. */
  presentedSessionToken: string | null;
}

/**
 * Steps 8 and 9: the just-in-time join and the session — from the callback
 * for a sign-in that needed no confirmation, or from the confirmation's POST
 * for one that did. Throws {@link SignInRefusal} as `prepareSignIn` does.
 */
export async function issueSignIn(
  services: ServiceContext,
  params: IssueSignInParams,
): Promise<SignInResult> {
  const { user, outcome, facts } = params;
  const log = services.log.at('issueSignIn');

  // ── 8. The just-in-time join, and what it leaves ─────────────────────────
  await joinJustInTime(services, params);

  // Lock one is recorded only for a verdict of `armed` *and* a fresh
  // authentication to date it by; a cookie parked by the build before this one
  // carried no date, and fails closed — the reset screen asks the person to
  // sign in again.
  const lockOneAt =
    params.lockOne === 'armed' && params.freshAuthAt !== null
      ? authenticationDate(params.freshAuthAt)
      : null;
  const freshAuthAt = params.freshAuthAt === null ? null : authenticationDate(params.freshAuthAt);

  // ── 9. The session ───────────────────────────────────────────────────────
  // The new session and, for a re-authentication, the record that it is one,
  // in one transaction: either the browser gets a session that carries lock
  // one, or it gets nothing — never a session that silently does not, which
  // the reset screen would show as an unexplained "sign in again".
  const { token, sessionId } = await services.db.transaction(async (tx) => {
    const issued = await issueSession(services, user.id, tx, facts, {
      workosSessionId: params.providerSessionId,
      freshAuthAt,
    });
    // The first of the vault reset's two locks, recorded against the session
    // this sign-in just issued, so it is the new cookie — and only the new
    // cookie — that carries it. Dated by the authentication, not by now: a
    // sign-in held back for confirmation is issued up to five minutes after
    // the person authenticated, and the reset's ten minutes are counted from
    // when they proved themselves (review round 2).
    if (lockOneAt !== null) {
      await recordFreshSignIn(tx, { userId: user.id, sessionId: issued.sessionId, at: lockOneAt });
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
        {
          source: 'dashboard',
          signInMethod: facts.signInMethod,
          // A sign-in the person confirmed says so, and why it was asked.
          ...(params.confirmation === null ? {} : { confirmation: params.confirmation }),
        },
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

  return {
    user,
    outcome,
    memberships,
    cookies: [...sessionCookies(token), ...(await lastAccountCookies(services, user.id))],
    sessionId,
  };
}

/**
 * Step 8: the just-in-time join the sign-in planned, made now — after any
 * confirmation, so that a declined sign-in leaves no trace in the organisation
 * (review round 2, L6) — and the account's organisations brought to what the
 * join left: `sso_required` and the personal organisation, as at prepare.
 *
 * Only for an organisation that opted in (`jit_join_enabled`, off by
 * default): connecting an identity provider says who an organisation's people
 * are, and admitting every one of them is a separate decision an owner takes
 * in the SSO settings (PR #114's constraint for WS-5). Checked here on the row
 * just found, to skip the transaction for the organisations that have not; the
 * check that counts is the repository's, under the organisation's row lock,
 * which answers `not-enabled` if it was switched off in between — and
 * `removed` for somebody the organisation removed (review S4). Without a join
 * the person simply signs in to whatever else they belong to — a personal
 * organisation, for a newcomer — and joins this one the ordinary way, by
 * invitation.
 */
async function joinJustInTime(services: ServiceContext, params: IssueSignInParams): Promise<void> {
  const { user, outcome, facts } = params;
  const log = services.log.at('issueSignIn');

  let memberships = await listOrganizationsForUser(services.db, user.id);
  // An adoption by an account that had no organisation to file it in at
  // prepare, because it was about to join one; filed below, once it has one.
  const linkAuditPending = outcome === 'linked' && memberships.length === 0;

  if (facts.ssoWorkosOrgId !== null) {
    const organization = await findOrgByWorkosOrgId(
      services.db,
      facts.ssoWorkosOrgId,
      params.workosClientId,
    );
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
        // An adoption with no organisation to file it under: filed under the
        // organisation whose sign-in it was, rather than not at all.
        if (linkAuditPending) auditIdentityLinked(services, organization.id, user, facts);
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

  // The join may not have happened — switched off, no longer wanted, a removed
  // person — so steps 6 and 7 again, for the account as it stands.
  assertSomeOrganizationUsable(memberships, facts, facts.signInMethod);
  if (memberships.length === 0) {
    // The adoption is filed with the organisation, inside.
    await provisionPersonalOrganization(services, user, outcome, facts);
  } else if (linkAuditPending) {
    auditIdentityLinked(services, memberships[0]!.organization.id, user, facts);
  }
}

/** An `auth_time` as the moment it records — never later than now, whatever WorkOS's clock says. */
function authenticationDate(seconds: number): Date {
  return new Date(Math.min(seconds * 1000, Date.now()));
}

/**
 * The "last account on this browser" cookie for a session just issued — what
 * spares a returning person the reused-session confirmation next time (see
 * {@link confirmationReason}). A convenience: a failure to make it is logged
 * and never fails the sign-in.
 */
async function lastAccountCookies(services: ServiceContext, userId: string): Promise<string[]> {
  try {
    return [lastAccountCookie(await sealLastAccount(await lastAccountKey(services.env), userId))];
  } catch (cause) {
    services.log
      .at('issueSignIn')
      .warn('Could not write the last-account cookie; the next reused session will be confirmed', {
        error: describeError(cause),
      });
    return [];
  }
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
 * The methods that count as a *fresh sign-in* for the SSO setup portal's
 * step-up (review round 2, L7): every {@link REAUTHENTICATING_METHODS} method,
 * and an emailed code (`MagicAuth`) too.
 *
 * Wider than the vault reset's first lock on purpose. The reset leaves
 * `MagicAuth` out only because its *second* lock is an emailed code, and
 * counting the first would make the two locks one inbox twice; the portal has
 * no second lock, and an owner who signs in by emailed code proves exactly
 * what they prove every other time they sign in. Leaving it out stranded them:
 * such an owner could never open the portal at all. The vault reset's rule is
 * unchanged.
 */
export const FRESH_AUTHENTICATION_METHODS: ReadonlySet<string> = new Set([
  ...REAUTHENTICATING_METHODS,
  'MagicAuth',
]);

/**
 * For a re-authentication, when the person actively authenticated during this
 * flow by one of {@link FRESH_AUTHENTICATION_METHODS} — WorkOS's `auth_time` —
 * or `null`. The same freshness rule as {@link armsLockOne}, over the portal's
 * wider set of methods; what the session it issues records as
 * `fresh_auth_at`, and what the portal's ten minutes are counted from.
 */
export function freshAuthenticationAt(
  exchange: Pick<
    AuthorizationCodeExchange<WorkosIdentity>,
    'authenticationMethod' | 'authenticatedAt'
  >,
  flowIssuedAt: number,
): number | null {
  const method = exchange.authenticationMethod;
  if (method === null || !FRESH_AUTHENTICATION_METHODS.has(method)) return null;
  const at = exchange.authenticatedAt;
  if (typeof at !== 'number' || !Number.isSafeInteger(at)) return null;
  return at < flowIssuedAt - REAUTH_AUTH_TIME_SKEW_SECONDS ? null : at;
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
 * "not single sign-on". `extra` carries the AuthKit session sign-out ends, and
 * when a re-authentication's person last proved themselves.
 */
export async function issueSession(
  services: ServiceContext,
  userId: string,
  exec: Executor = services.db,
  facts?: SignInFacts,
  extra: { workosSessionId?: string | null; freshAuthAt?: Date | null } = {},
): Promise<{ token: string; sessionId: string }> {
  const { token } = await generateToken('session');

  const session = await createSession(exec, {
    userId,
    token,
    ipAddress: services.meta.ipAddress,
    userAgent: services.meta.userAgent,
    signInMethod: facts?.signInMethod ?? null,
    ssoWorkosOrgId: facts?.ssoWorkosOrgId ?? null,
    workosSessionId: extra.workosSessionId ?? null,
    freshAuthAt: extra.freshAuthAt ?? null,
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
let cachedLastAccountKey: { secret: string; key: Promise<CryptoKey> } | undefined;
let cachedSsoContinueKey: { secret: string; key: Promise<CryptoKey> } | undefined;

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

/**
 * The MAC key for the "last account on this browser" cookie: the same operator
 * secret, under that cookie's own HKDF label. Same failure as
 * {@link oauthStateKey}.
 */
export async function lastAccountKey(env: Bindings): Promise<CryptoKey> {
  const secret = env.WORKOS_COOKIE_PASSWORD;
  if (!secret) throw new MissingBindingError('WORKOS_COOKIE_PASSWORD');

  if (cachedLastAccountKey?.secret !== secret) {
    cachedLastAccountKey = { secret, key: deriveLastAccountKey(secret) };
  }
  try {
    return await cachedLastAccountKey.key;
  } catch {
    cachedLastAccountKey = undefined;
    throw new MissingBindingError('WORKOS_COOKIE_PASSWORD (at least 32 characters)');
  }
}

/**
 * The MAC key for the SSO deep link's "Continue" token: the same operator
 * secret, under the token's own HKDF label. Same failure as
 * {@link oauthStateKey}.
 */
export async function ssoContinueKey(env: Bindings): Promise<CryptoKey> {
  const secret = env.WORKOS_COOKIE_PASSWORD;
  if (!secret) throw new MissingBindingError('WORKOS_COOKIE_PASSWORD');

  if (cachedSsoContinueKey?.secret !== secret) {
    cachedSsoContinueKey = { secret, key: deriveSsoContinueKey(secret) };
  }
  try {
    return await cachedSsoContinueKey.key;
  } catch {
    cachedSsoContinueKey = undefined;
    throw new MissingBindingError('WORKOS_COOKIE_PASSWORD (at least 32 characters)');
  }
}

/** Exists for tests. */
export function resetSignInCachesForTesting(): void {
  cachedStateKey = undefined;
  cachedConfirmationKey = undefined;
  cachedLastAccountKey = undefined;
  cachedSsoContinueKey = undefined;
}

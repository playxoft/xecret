import { LAST_ACCOUNT_COOKIE_NAME, openLastAccount, SESSION_COOKIE_NAME } from '@xecret/core/auth';
import type { AuthorizationCodeExchange, OAuthPurpose, WorkosIdentity } from '@xecret/core/auth';
import type { IdentityLinkOutcome } from '@xecret/db/repositories';
import type { ServiceContext } from './context';
import { confirmationReason, issueSignIn, lastAccountKey, prepareSignIn } from './sign-in';
import { parkSignIn } from './sign-in-confirmation';
import { knownDeviceCookies } from './sign-in-throttle';
import type { WorkosIdentityProvider } from './workos';

/**
 * The tail every sign-in shares, once WorkOS has said whose it is.
 *
 * Every way into xecret ends here — an authorization code at the callback
 * (Google, an organisation's single sign-on, AuthKit's hosted page for the
 * re-authentication flows), and a password, an emailed code or an
 * email-verification code typed on the sign-in page itself
 * (`server/in-app-sign-in.ts`). Each hands over the exchange its provider call
 * minted, and from there the decisions are one sequence, written once:
 *
 *  1. `prepareSignIn` — impersonation, the verified address, an SSO sign-in's
 *     domains, the per-identity rate limit, the linker (and its conflict and
 *     deleted-account refusals), `sso_required`, the personal organisation.
 *     Its header lists the steps and why they are in that order.
 *  2. `confirmationReason` — whether the person must confirm first. All three
 *     of its reasons are asked of every path; what differs is which can
 *     arise. For a password or an emailed code, presented from this site's own
 *     page: `not-member` cannot (it needs a single sign-on); `organization`
 *     does when WorkOS reports an organisation the sign-in did not ask for —
 *     after its own organisation selection, exactly when AuthKit's page used
 *     to ask the person to pick; and `reused-session` only if WorkOS dates the
 *     authentication more than its allowance before `flow.issuedAt`. That is
 *     why the in-app routes pass the real start of their flow — the request
 *     itself, or the paused password step for an email verification — so a
 *     person who took minutes to find an email is not mistaken for a session
 *     WorkOS reused.
 *  3. Held back: parked in the sealed confirmation cookie, for
 *     `/sign-in/confirm`. Otherwise: `issueSignIn`, and the session cookies.
 *
 * What it answers is the outcome, not a response: the callback turns it into a
 * 303, the in-app routes into JSON for the page that asked. Refusals are thrown
 * (`SignInRefusal`), for the caller's own failure answer.
 */

export interface CompleteSignInParams {
  exchange: AuthorizationCodeExchange<WorkosIdentity>;
  purpose: OAuthPurpose;
  provider: Pick<WorkosIdentityProvider, 'verifiedDomains' | 'clientId'>;
  /**
   * What the flow asked for and when it began: the state cookie's sealed
   * organisation and `issuedAt` for the callback; for an in-app sign-in, no
   * organisation, and the moment the request arrived — or, for an email
   * verification, the moment the paused password step answered.
   */
  flow: { organizationId: string | null; issuedAt: number };
  /** Where a finished sign-in lands — already held to `safePostSignInPath`. */
  next: string;
  /** The request's cookies: the session it replaces, the last account on this browser. */
  cookies: ReadonlyMap<string, string>;
}

/**
 * `issued`: a session was issued, and `cookies` are its `Set-Cookie` values.
 * `parked`: held back for the person to confirm, and `cookie` is the sealed
 * confirmation.
 */
export type CompletedSignIn = (
  { kind: 'issued'; cookies: string[] } | { kind: 'parked'; cookie: string }
) & {
  /**
   * What the linker did: `created` when this sign-in made the xecret account,
   * `matched` or `linked` when the account was already there. The in-app
   * sign-up reads it — the linker's own answer, decided in the same write that
   * made or found the row — to set a chosen password only on an account this
   * sign-up created, never on one that already existed.
   */
  outcome: IdentityLinkOutcome;
};

export async function completeSignIn(
  services: ServiceContext,
  params: CompleteSignInParams,
): Promise<CompletedSignIn> {
  const { exchange, purpose, provider, flow, next, cookies } = params;

  const prepared = await prepareSignIn(services, {
    exchange,
    purpose,
    provider,
    flowIssuedAt: flow.issuedAt,
  });

  const reason = confirmationReason({
    flow,
    exchange,
    prepared,
    lastAccountUserId: await openLastAccount(
      await lastAccountKey(services.env),
      cookies.get(LAST_ACCOUNT_COOKIE_NAME),
    ),
  });
  if (reason !== null) {
    // Logged at `info`, with what was asked against what came back: one of
    // these is a person signing in through their company's identity provider
    // from the plain button; a burst of them for one address is the
    // planted-session attack being tried.
    services.log
      .at('completeSignIn')
      .info(
        'Held a sign-in back for the person to confirm: it came back through an organisation ' +
          'this flow did not ask for, through the single sign-on of one the account is not in, ' +
          'or from a session WorkOS reused without asking',
        {
          reason,
          askedForOrganization: flow.organizationId !== null,
          signInMethod: prepared.facts.signInMethod,
        },
      );
    const parked = await parkSignIn(services, {
      prepared,
      purpose,
      next,
      flowIssuedAt: flow.issuedAt,
      reason,
    });
    services.bindLog({ signInOutcome: 'confirmation-required', signInPurpose: purpose });
    return { kind: 'parked', cookie: parked, outcome: prepared.outcome };
  }

  const result = await issueSignIn(services, {
    user: prepared.user,
    outcome: prepared.outcome,
    facts: prepared.facts,
    purpose,
    lockOne: prepared.lockOne,
    freshAuthAt: prepared.freshAuthAt,
    providerSessionId: prepared.providerSessionId,
    workosClientId: provider.clientId,
    confirmation: null,
    presentedSessionToken: cookies.get(SESSION_COOKIE_NAME) ?? null,
  });

  services.bindLog({ signInOutcome: result.outcome, signInPurpose: purpose });
  // The browser that just signed in is now known to this address: the in-app
  // sign-in throttle counts its attempts in a pool of its own
  // (`server/sign-in-throttle.ts`), so an attacker locking the address's shared
  // pool never locks this browser out. Every path that issues a session does
  // this — Google and single sign-on included.
  return {
    kind: 'issued',
    cookies: [...result.cookies, ...(await knownDeviceCookies(services, prepared.user.email))],
    outcome: prepared.outcome,
  };
}

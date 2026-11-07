import { LAST_ACCOUNT_COOKIE_NAME, openLastAccount, SESSION_COOKIE_NAME } from '@xecret/core/auth';
import type { AuthorizationCodeExchange, OAuthPurpose, WorkosIdentity } from '@xecret/core/auth';
import type { ServiceContext } from './context';
import { confirmationReason, issueSignIn, lastAccountKey, prepareSignIn } from './sign-in';
import { parkSignIn } from './sign-in-confirmation';
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
 *  2. `confirmationReason` — whether the person must confirm first. The
 *     callback's reasons are about a session planted at AuthKit; a password
 *     or an emailed code was presented in this very request, from this site's
 *     own page, so for them only an organisation WorkOS reported unasked
 *     (after its own organisation selection) holds the sign-in back — exactly
 *     as it did when AuthKit's page asked the person to pick.
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
   * organisation, and the moment the request arrived.
   */
  flow: { organizationId: string | null; issuedAt: number };
  /** Where a finished sign-in lands — already held to `safePostSignInPath`. */
  next: string;
  /** The request's cookies: the session it replaces, the last account on this browser. */
  cookies: ReadonlyMap<string, string>;
}

export type CompletedSignIn =
  /** A session was issued. `cookies` are its `Set-Cookie` values. */
  | { kind: 'issued'; cookies: string[] }
  /** Held back for the person to confirm. `cookie` is the sealed confirmation. */
  | { kind: 'parked'; cookie: string };

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
    return { kind: 'parked', cookie: parked };
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
  return { kind: 'issued', cookies: result.cookies };
}

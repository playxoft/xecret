/**
 * The API's error vocabulary.
 *
 * Two rules govern everything here:
 *
 *  1. **An error response says only what the caller is entitled to know.** A
 *     resource in another organisation is `not_found`, never `forbidden` —
 *     `forbidden` would confirm it exists, which is an enumeration oracle
 *     (threat T2). A failed login says "invalid credentials", never "no such
 *     user", for the same reason.
 *  2. **Nothing derived from an exception reaches the client.** Driver errors
 *     embed connection strings, and validation libraries happily echo the input
 *     they rejected — which, in this product, may be a secret value. Only the
 *     fixed messages defined here are ever sent.
 */

export type ApiErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'payload_too_large'
  | 'rate_limited'
  | 'csrf_failed'
  /**
   * The credential is valid but the session's vault is locked — see `vault.ts`
   * in `@xecret/core/auth`.
   *
   * Its own code rather than a plain `forbidden`, because it is the one 403 in
   * the product that the *client* can resolve without anybody changing anything:
   * the dashboard shows the lock screen, and the request succeeds on retry. A
   * generic "you do not have permission" would send a user to ask an admin for
   * access they already have.
   */
  | 'session_locked'
  /**
   * The caller is authenticated and permitted, and their *plan* does not
   * include what they asked for.
   *
   * Its own code rather than a plain `forbidden` for the same reason
   * `session_locked` has one: it is a 403 the client can resolve without
   * anybody granting them anything. The dashboard renders an upgrade path from
   * the `plan` block below and the CLI prints a one-line hint, neither of which
   * is possible from a generic "you do not have permission".
   *
   * Never used for a *data-plane* refusal, because there is no such thing —
   * a secret fetch is never refused for a billing reason. See
   * `isDataPlaneActive` in `@xecret/core/entitlements`.
   */
  | 'plan_limit'
  /**
   * The organisation requires its single sign-on, and this credential — a
   * session, or a CLI token approved from one — did not come through it.
   *
   * Its own code for the reason `session_locked` has one: the caller is a
   * member, is permitted, and can fix it without anybody granting them
   * anything — by signing in through the organisation's identity provider. The
   * dashboard offers that sign-in; the CLI says to run `xecret login` again
   * from a single-sign-on session. Only ever answered to a member: the
   * organisation and the membership are resolved first, so it confirms
   * nothing a stranger could not already see.
   */
  | 'sso_required'
  /**
   * The action needs a fresh sign-in of this session first — a step-up. The
   * dashboard sends the person through `GET /api/auth/login?reauth=1` and back.
   */
  | 'reauth_required'
  | 'internal_error'
  /**
   * An upstream provider (WorkOS) answered, and refused the request this
   * server built — a configuration problem rather than an outage, so "try
   * again in a minute" would be the wrong advice. The message names the
   * provider's own error category, which is bounded and stripped to a
   * log-safe token before it gets here.
   */
  | 'upstream_refused'
  | 'unavailable';

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  bad_request: 400,
  validation_failed: 422,
  unauthenticated: 401,
  forbidden: 403,
  plan_limit: 403,
  sso_required: 403,
  reauth_required: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  rate_limited: 429,
  csrf_failed: 403,
  session_locked: 403,
  internal_error: 500,
  upstream_refused: 502,
  unavailable: 503,
};

/**
 * A field-level validation problem.
 *
 * Carries the field path and a message about the *rule* that failed — never the
 * value that failed it. `"value must be at most 65536 bytes"` is useful;
 * echoing the 65537-byte value the user just tried to store is a leak into
 * whatever logs the response.
 */
export interface FieldProblem {
  field: string;
  message: string;
}

/**
 * What a plan refusal tells the client.
 *
 * Enough to render one upgrade button, and nothing else. No price — prices vary
 * by currency and interval and belong to the pricing page, and an amount quoted
 * in an error body is an amount that will one day be wrong. No organisation
 * identifier, no counts of anything but the resource in question: these bodies
 * are logged.
 */
export interface PlanProblem {
  /** The resource or capability that was refused, e.g. `projects`, `oidcSso`. */
  resource: string;
  /** The ceiling, or `null` where the refusal was about a capability. */
  limit: number | null;
  current: number | null;
  /** The plan the organisation holds now. */
  plan: string;
  /** The cheapest plan that would allow it, or `null` when none would. */
  upgradeTo: string | null;
}

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    /** Correlates a user-visible failure with the server log line. */
    requestId: string;
    fields?: FieldProblem[];
    /** Present only on `plan_limit`. */
    plan?: PlanProblem;
  };
}

/**
 * Thrown by anything below the route layer; converted to a response once, at
 * the boundary.
 *
 * `logDetail` never leaves the server. It exists so a handler can record why
 * something failed without that reason becoming part of the API contract or
 * reaching the client.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly fields: FieldProblem[] | undefined;
  readonly plan: PlanProblem | undefined;
  readonly logDetail: string | undefined;

  constructor(
    code: ApiErrorCode,
    message: string,
    options: { fields?: FieldProblem[]; plan?: PlanProblem; logDetail?: string } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.fields = options.fields;
    this.plan = options.plan;
    this.logDetail = options.logDetail;
  }

  get status(): number {
    return STATUS_BY_CODE[this.code];
  }

  toBody(requestId: string): ApiErrorBody {
    const error: ApiErrorBody['error'] = {
      code: this.code,
      message: this.message,
      requestId,
    };
    if (this.fields && this.fields.length > 0) error.fields = this.fields;
    if (this.plan) error.plan = this.plan;
    return { error };
  }
}

/**
 * Constructors for the errors routes actually raise.
 *
 * Fixed messages, defined in one place. A handler that composes its own message
 * from request data is how an identifier or a secret ends up in a response body,
 * so the ergonomic path is the safe one.
 */
export const errors = {
  /**
   * The single response for "you may not see this".
   *
   * Used for a resource that does not exist, one in another organisation, and
   * one the caller lacks permission for. They are indistinguishable on purpose:
   * a client that can tell them apart can enumerate another tenant's resources.
   */
  notFound: (logDetail?: string): ApiError =>
    new ApiError('not_found', 'Not found.', logDetail === undefined ? {} : { logDetail }),

  unauthenticated: (logDetail?: string): ApiError =>
    new ApiError(
      'unauthenticated',
      'Authentication required.',
      logDetail === undefined ? {} : { logDetail },
    ),

  /**
   * Reserved for the case where the caller is authenticated, the resource is
   * known to be in their organisation, and they still may not act on it — e.g.
   * a developer attempting an owner-only action. Nothing is leaked because
   * membership is already established.
   */
  forbidden: (message = 'You do not have permission to perform this action.'): ApiError =>
    new ApiError('forbidden', message),

  badRequest: (message: string): ApiError => new ApiError('bad_request', message),

  validation: (fields: FieldProblem[]): ApiError =>
    new ApiError('validation_failed', 'The request could not be processed.', { fields }),

  conflict: (message: string): ApiError => new ApiError('conflict', message),

  /**
   * A conflict about one field of the request — a name somebody else holds.
   *
   * Still a 409, with the field named as a validation error names one, so a
   * form can put the message beside the input it is about without matching
   * the sentence. The message is a fixed one from the repository.
   */
  conflictOn: (field: string, message: string): ApiError =>
    new ApiError('conflict', message, { fields: [{ field, message }] }),

  /**
   * The organisation's plan does not include this.
   *
   * The message is composed by `@xecret/core/entitlements`, which builds it from
   * plan names and a ceiling — never from request data. That keeps this inside
   * rule 2 at the top of the file while still saying something useful, which
   * the other constructors here cannot do because their inputs are untrusted.
   */
  planLimit: (message: string, plan: PlanProblem): ApiError =>
    new ApiError('plan_limit', message, { plan }),

  tooLarge: (message: string): ApiError => new ApiError('payload_too_large', message),

  rateLimited: (): ApiError =>
    new ApiError('rate_limited', 'Too many requests. Please slow down and try again.'),

  /**
   * The session is authenticated but its vault is locked.
   *
   * Carries no detail about *why* beyond the fact — whether the user has a vault
   * at all is answered by `GET /api/auth/me`, which is deliberately outside this
   * gate so the dashboard can tell "set one up" from "unlock yours" without
   * needing a failed request to find out.
   *
   * The error *code* is unchanged from the PIN it replaced, deliberately. The
   * Go CLI matches on `session_locked` to tell a lock apart from a permission
   * failure, and renaming a wire constant to match an internal rename would
   * break every CLI in the field to no benefit.
   */
  locked: (logDetail?: string): ApiError =>
    new ApiError(
      'session_locked',
      'Unlock your vault to continue.',
      logDetail === undefined ? {} : { logDetail },
    ),

  /**
   * Too many failed unlock or recovery attempts.
   *
   * The wait is stated because it is the only actionable thing left, and it
   * discloses nothing: the caller already knows they were refused, and the
   * schedule is a published constant. Rounded up to whole seconds so the message
   * never says "wait 0 seconds" for a lockout that has not quite elapsed.
   */
  vaultLocked: (retryAfterMs: number): ApiError =>
    new ApiError(
      'rate_limited',
      `Too many failed attempts. Try again in ${describeWait(retryAfterMs)}.`,
      { logDetail: 'vault lockout' },
    ),

  /**
   * The vault reset's emailed-code guesses for this account are used up for
   * the day. Its own sentence because the wait is the only thing left to do,
   * and it discloses nothing the person is not entitled to: the budget is a
   * published constant.
   */
  reauthBudgetSpent: (): ApiError =>
    new ApiError(
      'rate_limited',
      'Too many codes have been tried on this account today. Try again in 24 hours.',
      { logDetail: 'reauth guess budget' },
    ),

  csrf: (logDetail: string): ApiError =>
    new ApiError('csrf_failed', 'The request could not be verified. Please refresh and retry.', {
      logDetail,
    }),

  /**
   * A configuration fault, not a bug in the request — a missing binding, an
   * unreachable database. 503 rather than 500 so monitoring can tell "this
   * deployment is misconfigured" from "this code path is broken".
   */
  unavailable: (logDetail: string): ApiError =>
    new ApiError('unavailable', 'The service is temporarily unavailable.', { logDetail }),

  /**
   * A contact enquiry that could not be delivered.
   *
   * Its own constructor rather than `unavailable` with a custom string, because
   * messages live in this file and nowhere else — a handler that composes its
   * own is how a request field ends up in a response body. The same 503, and a
   * message that names what to do instead: this is the one endpoint where the
   * generic sentence leaves somebody with a question and no way to ask it.
   *
   * Nothing about *why* appears here. The provider, its status and its body go
   * to the log, where the person who can act on them will look.
   */
  contactUndeliverable: (logDetail: string): ApiError =>
    new ApiError(
      'unavailable',
      'We could not deliver your message. Please try again shortly, or open an issue at ' +
        'github.com/playxoft/xecret/issues.',
      { logDetail },
    ),

  /**
   * A vault reset refused because its escape archive — or, when the person
   * chose to go without it, the notice — could not be emailed. Nothing was
   * reset: the mail goes first. The reset's proof was spent, so the sentence
   * says what a retry takes.
   */
  vaultArchiveNotSent: (logDetail: string, what: 'archive' | 'notice' = 'archive'): ApiError =>
    new ApiError(
      'unavailable',
      (what === 'archive'
        ? 'We couldn’t email your vault archive, so nothing was reset. '
        : 'We couldn’t email you about the reset, so nothing was reset. ') +
        'To try again you’ll need to sign in again and get a new code.',
      { logDetail },
    ),

  /**
   * A vault reset refused because this production deployment cannot send mail
   * at all. A vault is never reset without its archive unless the person chose
   * that, and nobody can choose it here — the archive would only be missing
   * because of our configuration.
   */
  vaultArchiveMailMissing: (logDetail: string): ApiError =>
    new ApiError(
      'unavailable',
      'This xecret installation has no email set up, and a vault is never reset without ' +
        'emailing its archive first. Nothing was reset. Whoever runs this installation needs to ' +
        'set up email before a vault can be reset.',
      { logDetail },
    ),

  /**
   * A vault reset whose archive cannot be emailed, asked for without saying
   * "reset without the emailed archive". Refused before the reset's proof is
   * spent; the reset screen shows the same fact before anybody confirms, so
   * this is reached only when the vault changed in between.
   */
  vaultArchiveUndeliverable: (reason: 'too-large' | 'mail-not-configured'): ApiError =>
    new ApiError(
      'conflict',
      reason === 'too-large'
        ? 'Your vault is too large to email as an archive, so nothing was reset. To reset it ' +
            'anyway, choose “Reset without the emailed archive” and confirm again.'
        : 'This installation has no email set up, so no archive can be sent and nothing was ' +
            'reset. To reset anyway, choose “Reset without the emailed archive” and confirm again.',
      { logDetail: `vault archive ${reason}` },
    ),

  /**
   * A vault reset refused because the vault it would retain is not the one
   * its archive was made from — another reset, and a new vault, landed in
   * between. The archive already sent says "you asked to reset", not "was".
   */
  vaultChangedDuringReset: (): ApiError =>
    new ApiError(
      'conflict',
      'Your vault changed while it was being reset, so nothing was reset. To try again you’ll ' +
        'need to sign in again and get a new code.',
      { logDetail: 'vault changed between archive and reset' },
    ),

  /**
   * An organisation SSO settings call that needed WorkOS and could not get an
   * answer from it — unreachable, rate-limited, or refusing this deployment's
   * key. Nothing was changed. Its own sentence because "temporarily
   * unavailable" on a settings page reads as the whole product being down,
   * when what is down is one provider's API.
   */
  ssoProviderUnavailable: (logDetail: string): ApiError =>
    new ApiError(
      'unavailable',
      'WorkOS, which runs single sign-on for xecret, could not be reached, so nothing was changed. ' +
        'Try again in a minute.',
      { logDetail },
    ),

  /**
   * WorkOS answered an SSO settings call, and refused it: a 4xx about the
   * request this server built — the WorkOS organisation deleted in the WorkOS
   * dashboard, a parameter WorkOS stopped accepting. Not an outage, so the
   * sentence does not say "try again"; it names WorkOS's own category so that
   * whoever reads it to support has something to quote.
   *
   * `category` is never request data: it comes from `providerFailure` in
   * `workos.ts`, which strips WorkOS's error code to `[a-z0-9_-]` and 64
   * characters before it exists — the one value in this file not written here,
   * and bounded so it can be nothing else.
   */
  ssoProviderRefused: (category: string, logDetail: string): ApiError =>
    new ApiError(
      'upstream_refused',
      `WorkOS refused the request (${category.replace(/[^a-z0-9_-]/gi, '').slice(0, 64) || 'rejected'}), ` +
        'so nothing was changed. This usually means the organisation’s setup at WorkOS needs ' +
        'attention; contact support with the request id.',
      { logDetail },
    ),

  /**
   * This organisation's single sign-on link was made in a different WorkOS
   * environment from this deployment's (review S9) — typically an "enable"
   * clicked in local development, which runs against WorkOS Staging over the
   * production database. Refused rather than acted on: every WorkOS call made
   * with it would be about an organisation this environment does not have.
   */
  ssoEnvironmentMismatch: (): ApiError =>
    new ApiError(
      'conflict',
      'This organisation’s single sign-on was set up in a different WorkOS environment from the ' +
        'one this deployment uses, so it cannot be managed from here. Contact support to have the ' +
        'link checked.',
      { logDetail: 'workos client id mismatch' },
    ),

  /**
   * Turning SSO on, or switching a policy on, from a deployment whose WorkOS
   * environment is not the one this database belongs to (`workos_home`,
   * migration 0023) — local development against WorkOS Staging over the
   * production database, most likely. Refused before WorkOS is asked anything:
   * a link written from here would be one no sign-in in the database's own
   * environment could ever come through.
   *
   * The other way to arrive here is a self-hosted database that still holds the
   * client id 0023 seeded — Playxoft's — because its operator has not recorded
   * their own yet (review round 3). "Make this change from that deployment"
   * was a dead end for them, there being no such deployment, so the message
   * names the step, and where it is written down, for both cases.
   */
  ssoNotHomeEnvironment: (): ApiError =>
    new ApiError(
      'conflict',
      'Single sign-on can only be changed from a deployment in the WorkOS environment this ' +
        'database records (workos_home), and this deployment uses a different WorkOS ' +
        'environment — so nothing was changed. On a self-hosted deployment, an operator records ' +
        'its own WORKOS_CLIENT_ID there once, as the database owner: ' +
        "UPDATE workos_home SET client_id = '<WORKOS_CLIENT_ID>' (the “WorkOS environment” " +
        'step in docs/self-hosting.md). Otherwise, make this change from the deployment that ' +
        'database belongs to.',
      { logDetail: 'workos client id is not workos_home' },
    ),

  /**
   * The same, for a database with no WorkOS environment recorded at all — a
   * self-hosted deployment that has not done the one-time operator step.
   */
  ssoHomeUnrecorded: (): ApiError =>
    new ApiError(
      'conflict',
      'Single sign-on cannot be turned on yet: this deployment’s database has no WorkOS ' +
        'environment recorded. An operator records it once (the “WorkOS environment” step in ' +
        'docs/self-hosting.md), and then it can.',
      { logDetail: 'workos_home is empty' },
    ),

  /** See the `sso_required` code above. */
  ssoRequired: (logDetail?: string): ApiError =>
    new ApiError(
      'sso_required',
      'This organisation requires its single sign-on. Sign in through your company’s identity ' +
        'provider to use it.',
      logDetail === undefined ? {} : { logDetail },
    ),

  /** See the `reauth_required` code above. */
  reauthRequired: (message: string): ApiError => new ApiError('reauth_required', message),

  internal: (logDetail: string): ApiError =>
    new ApiError('internal_error', 'Something went wrong.', { logDetail }),
} as const;

/** "45 seconds" / "3 minutes" — whichever reads better at that magnitude. */
function describeWait(ms: number): string {
  const seconds = Math.max(Math.ceil(ms / 1000), 1);
  if (seconds < 90) return `${seconds} second${seconds === 1 ? '' : 's'}`;

  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

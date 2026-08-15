import { BufferedAuditRecorder, createAuditBuilder } from '@xecret/core/audit';
import type { AuditBuilder, AuditRecord } from '@xecret/core/audit';
import { AuthorizationError } from '@xecret/core/authz';
import { actorId, actorLabel, actorType, assertCsrf, authenticate, isUnlocked } from './actor';
import type { CredentialSource, Principal } from './actor';
import { DatabaseAuditSink } from './audit-sink';
import { MissingBindingError, publicOrigin } from './bindings';
import type { Bindings, WorkerContext } from './bindings';
import { createServiceContext, workerContext } from './context';
import type { ServiceContext } from './context';
import { errors } from './errors';
import {
  REQUEST_ID_HEADER,
  clientIp,
  isSameOrigin,
  json,
  rayIdFrom,
  requestIdFrom,
  toApiError,
  userAgent,
} from './http';
import { createRequestLog, describeError, describeOutcome, describeRequest } from './logging';
import type { LogFields, Logger, RequestAction, RequestLog } from './logging';

/**
 * The route wrapper.
 *
 * Every handler under `app/api` is wrapped by one of the two functions below.
 * That is not a style preference — it is how the cross-cutting guarantees are
 * made unforgettable rather than merely documented:
 *
 *  - authentication happens before the handler body runs
 *  - CSRF is checked on every cookie-authenticated mutation
 *  - an unexpected throw becomes a fixed 500, never a stack trace or a driver
 *    message that might carry a connection string
 *  - audit records buffered during the request are flushed afterwards, and a
 *    failure to flush is logged loudly rather than swallowed
 *  - **every request produces exactly one completion line**, carrying the
 *    request id, the route, the outcome, the duration, and — for anything
 *    authenticated — the caller and their organisation
 *
 * A handler that opted out of the wrapper would silently lose all five. There is
 * no reason to, and a reviewer can check compliance by grepping for `export
 * const GET =`.
 *
 * ── One line per request, not one per stage ──
 * The start of a request is logged at `debug`, so it is off in production. What
 * production gets is the completion line, because a start line that is never
 * followed by a finish is indistinguishable from a start line whose finish was
 * dropped — and paying for both on every request buys a duplicate of the field
 * set for the few requests that hang. The duration on the finish line answers
 * the question the start line was there for.
 */

export interface PublicRouteContext<Params> {
  request: Request;
  params: Params;
  services: ServiceContext;
}

export interface RouteContext<Params> extends PublicRouteContext<Params> {
  principal: Principal;
  source: CredentialSource;
  /**
   * Builds an audit builder bound to an organisation.
   *
   * A function rather than a ready-made builder because the organisation is
   * resolved from the request path inside the handler, and an audit record
   * without a correct `org_id` is unfilterable in the audit UI and unusable in
   * an incident.
   */
  audit: (orgId: string) => AuditBuilder;
  /** Queues records for the post-response flush. */
  record: (...events: AuditRecord[]) => void;
}

type Handler<Context> = (context: Context) => Promise<Response>;

/** Next.js hands dynamic segments in as a promise; params may be absent. */
type NextRouteArgs<Params> = { params?: Promise<Params> | undefined } | undefined;

/**
 * Wraps a handler that does not require a credential.
 *
 * Used by `POST /api/auth/session` — which authenticates by verifying a Firebase
 * ID token rather than by presenting an xecret credential — and by the logout
 * route, which must succeed even when the session it is clearing is already
 * invalid.
 */
export function publicRoute<Params = Record<string, never>>(
  handler: Handler<PublicRouteContext<Params>>,
): (request: Request, args?: NextRouteArgs<Params>) => Promise<Response> {
  return async (request, args) => {
    // `begin` itself can fail — a missing Hyperdrive binding, an unparseable
    // root key. Those must produce the same clean envelope as any other
    // failure, so the request id and the logger are established first and
    // everything else, including context construction, happens inside the
    // boundary. A 503 from a missing binding is precisely the failure that most
    // needs a log line, and it happens before there is a `ServiceContext` to
    // hang one off.
    const requestId = requestIdFrom();
    const doing = describeRequest(request.method, new URL(request.url).pathname);
    const log = openLog(request, requestId, doing);
    const startedAt = Date.now();

    let started: RequestScope | undefined;
    let response: Response;

    try {
      started = await begin(request, requestId, log, doing, startedAt);
      const params = ((await args?.params) ?? {}) as Params;

      response = withRequestId(
        await handler({ request, params, services: started.services }),
        requestId,
      );
    } catch (cause) {
      response = failure(cause, requestId, log.logger, doing);
    } finally {
      if (started) settle(started.services, started.recorder);
    }

    finished(log.logger, doing, response.status, startedAt);
    // Last, so nothing this request can still queue is left out of the batch —
    // neither the finish line above nor the lines the deferred work writes.
    shipLogs(started, log);
    return response;
  };
}

export interface AuthenticatedRouteOptions {
  /**
   * Lets a route run against a locked session.
   *
   * **Deny by default.** The option exists at all only because a locked user
   * must still be able to reach the handful of endpoints that get them unlocked
   * — otherwise the lock screen cannot function and the account is bricked until
   * the session expires. Exactly four routes opt out, and each says why:
   *
   *  - `GET /api/auth/me` — the dashboard has to learn *that* it is locked, and
   *    whether a PIN exists at all, before it can render anything.
   *  - `POST /api/auth/pin` — setting the first PIN happens from a locked
   *    session by definition; a new session has never been unlocked.
   *  - `POST /api/auth/pin/unlock` and the reset pair — the unlock itself.
   *  - `DELETE /api/auth/session` — signing out must never require unlocking
   *    first. "I cannot remember my PIN, let me just sign out" has to work.
   *
   * Any other route reaching for this is a bug: the gate is what makes the lock
   * a security control rather than a screen the client chooses to draw.
   */
  allowLocked?: boolean;
}

/**
 * Wraps a handler that requires an authenticated principal.
 *
 * Authentication, the cross-origin check, CSRF, and the PIN gate all run before
 * the handler body. Authorization does not: it needs the resource, which only
 * the handler can resolve. The handler calls `can()` — see
 * `docs/architecture/api.md` §2.
 *
 * ── Why the lock is enforced here ──
 * The dashboard draws a lock screen, and that is decoration. This is the control:
 * a request that arrives with a locked session gets a 403 whatever the client
 * believes, so a stale tab, a replayed `fetch` from the console, or a script
 * holding a stolen cookie all get the same answer. Putting the check in each
 * handler instead would make it something a new route can forget, which is
 * precisely the class of mistake a wrapper exists to eliminate.
 */
export function authenticatedRoute<Params = Record<string, never>>(
  handler: Handler<RouteContext<Params>>,
  options: AuthenticatedRouteOptions = {},
): (request: Request, args?: NextRouteArgs<Params>) => Promise<Response> {
  return async (request, args) => {
    const requestId = requestIdFrom();
    const doing = describeRequest(request.method, new URL(request.url).pathname);
    const log = openLog(request, requestId, doing);
    const startedAt = Date.now();

    let started: RequestScope | undefined;
    let response: Response;

    try {
      started = await begin(request, requestId, log, doing, startedAt);
      const { services, recorder } = started;

      // Checked before authentication so a cross-site request is rejected
      // without the cost of a token lookup, and without its outcome depending
      // on whether the credential happened to be valid.
      if (!isSameOrigin(request, publicOrigin(services.env))) {
        throw errors.csrf('origin mismatch');
      }

      const { principal, source } = await authenticate(request, services);

      // The moment the caller stops being anonymous, every line for the rest of
      // the request says who they are — including lines already emitted by
      // loggers a service is holding, because the context is shared by
      // reference. This is the single most useful field in the whole scheme:
      // "everything this user did on Tuesday" is one query.
      //
      // `credentialKind`, not `credential`: the redactor's deny list contains
      // the word "credential", so a field by that name is `[redacted]` on every
      // authenticated line whatever it holds — and this one holds `cookie` or
      // `bearer`, which is a shape and not a secret. The `kind` suffix is what
      // the identifier pass already recognises, so the field survives without
      // punching a hole in the deny list for the names that should be hidden.
      services.bindLog({ ...principalFields(principal), credentialKind: source });

      assertCsrf(request, source);

      if (options.allowLocked !== true && !isUnlocked(principal, new Date())) {
        throw errors.locked('session not unlocked');
      }

      const params = ((await args?.params) ?? {}) as Params;

      response = withRequestId(
        await handler({
          request,
          params,
          services,
          principal,
          source,
          audit: (orgId) =>
            createAuditBuilder({
              orgId,
              actorType: actorType(principal),
              actorId: actorId(principal),
              actorLabel: actorLabel(principal),
              ipAddress: services.meta.ipAddress,
              userAgent: services.meta.userAgent,
              requestId: services.meta.requestId,
            }),
          record: (...events) => recorder.record(...events),
        }),
        requestId,
      );
    } catch (cause) {
      response = failure(cause, requestId, log.logger, doing);
    } finally {
      if (started) settle(started.services, started.recorder);
    }

    finished(log.logger, doing, response.status, startedAt);
    shipLogs(started, log);
    return response;
  };
}

interface RequestScope {
  services: ServiceContext;
  recorder: BufferedAuditRecorder;
  /**
   * The runtime's own `waitUntil`, kept aside from the tracked one on
   * `ServiceContext`.
   *
   * Only `shipLogs` uses it, and only because the log flush is the one deferred
   * task that must *follow* the tracked set rather than join it. Everything else
   * defers through `services.waitUntil`, so the database handle is not closed
   * underneath it.
   */
  ctx: WorkerContext['ctx'];
}

async function begin(
  request: Request,
  requestId: string,
  log: RequestLog,
  doing: RequestAction,
  startedAt: number,
): Promise<RequestScope> {
  const worker = await workerContext();
  const services = await createServiceContext(request, worker, requestId, log, startedAt);

  log.logger.at('begin').debug(`Received a request to ${doing.base} ${doing.object}`);

  return {
    services,
    recorder: new BufferedAuditRecorder(new DatabaseAuditSink(services.db)),
    ctx: worker.ctx,
  };
}

/**
 * Builds the request's logger before anything else exists.
 *
 * The bindings are not available here — `workerContext()` is an async call into
 * the OpenNext adapter and belongs inside the try boundary — so the sink and
 * threshold are resolved from `process.env` alone. In a deployed Worker those
 * are the same values `withProcessFallbacks` would supply, because
 * `BETTERSTACK_*` and `XECRET_LOG_LEVEL` are plain strings rather than real
 * bindings; the cost of building it this early is that a *misconfigured*
 * deployment still logs its own misconfiguration, which is the case that
 * matters most.
 */
function openLog(request: Request, requestId: string, doing: RequestAction): RequestLog {
  const url = new URL(request.url);

  return createRequestLog(process.env as unknown as Bindings, {
    requestId,
    rayId: rayIdFrom(request),
    method: request.method,
    path: url.pathname,
    ip: clientIp(request),
    userAgent: userAgent(request),
    event: doing.event,
  });
}

/**
 * The one line every request produces.
 *
 * The message is a sentence describing what the request actually did —
 * "Revealed the secret DATABASE_URL in acme/api/production" — rather than a
 * label like "request completed", which restates two fields and makes every
 * line in the stream look identical. See `describe-request.ts` for why the
 * stable `event` key is carried separately: prose is for reading, `event` is
 * for grouping, and a dashboard must never depend on the wording.
 *
 * `outcome` is derived rather than left to the reader: a panel grouping on a
 * string beats one that has to express `status >= 500`. The level follows the
 * same split, so "alert on error" needs no status arithmetic either — a 404 is
 * not a page at 3am, and a 500 is.
 */
function finished(logger: Logger, doing: RequestAction, status: number, startedAt: number): void {
  const outcome = status >= 500 ? 'server_error' : status >= 400 ? 'client_error' : 'success';
  const line = logger.at('request');
  const fields = { status, outcome, durationMs: Date.now() - startedAt };
  const message = describeOutcome(doing, status);

  if (status >= 500) {
    line.error(message, fields);
    return;
  }
  line.info(message, fields);
}

/**
 * Hands the batch to the runtime, after the response and after the deferred
 * work.
 *
 * ── Why the flush waits, rather than being merely deferred ──
 * `flush` drains the buffer the instant it is called; the network round trip
 * that follows is irrelevant to what the batch contains. So calling it here and
 * handing the *resulting* promise to `waitUntil` ships only the lines written
 * before the response — and the lines that matter most are written after it. The
 * audit-flush failure in `settle`, the sign-in and CLI-exchange records in
 * `writeEvents`, an invitation or PIN-reset email that never left: every one of
 * those is an `error` emitted from inside `waitUntil`, into a buffer that has
 * already been drained and will never be drained again.
 * `docs/operations/logging.md` advertises those as the alertable lines, so
 * losing them disarms the alerts silently — which is the worst way for an
 * observability system to fail.
 *
 * Chaining behind `settled()` fixes that: the flush runs once every task the
 * request queued has finished, by which point those lines are in the buffer.
 *
 * ── Why the runtime's `waitUntil` and not the tracked one ──
 * The tracked one exists so `dispose` can hold the database connection open for
 * work that needs it. This flush needs the network, not the database, so it has
 * no business extending the connection's life — and adding it to the set it is
 * already waiting on is a knot with no reason to be tied. The two run
 * concurrently and neither touches what the other holds.
 */
function shipLogs(scope: RequestScope | undefined, log: RequestLog): void {
  // Without a scope, `begin` failed before a context existed: nothing was
  // deferred, so there is nothing to wait for — and no runtime handle to keep
  // the isolate alive either. The batch races the end of the invocation, which
  // is the best available answer for a request that could not be started.
  const flushing = (scope ? scope.services.settled() : Promise.resolve())
    .then(() => log.flush())
    // A shipping failure is already degraded to the console inside the sink, so
    // this catch only exists for the impossible case. It must not reject: an
    // unhandled rejection in `waitUntil` is a Worker-level error report for a
    // request that succeeded.
    .catch(() => undefined);

  scope?.ctx.waitUntil(flushing);
}

/** The caller, flattened into fields a log query can group on. */
function principalFields(principal: Principal): LogFields {
  switch (principal.kind) {
    case 'user':
      return { actorType: 'user', userId: principal.user.id, sessionId: principal.sessionId };
    case 'cliToken':
      return {
        actorType: 'cli_token',
        userId: principal.userId,
        tokenId: principal.tokenId,
        orgId: principal.orgId,
      };
    case 'serviceToken':
      return {
        actorType: 'service_token',
        tokenId: principal.tokenId,
        orgId: principal.orgId,
        projectId: principal.projectId,
        environmentId: principal.environmentId,
        accessLevel: principal.accessLevel,
      };
  }
}

/**
 * Ends the request's deferred work: flushes buffered audit records, then
 * schedules the database handle's release.
 *
 * Runs in `finally`, so records queued before a failure are still written — the
 * denial that caused the failure is exactly the record worth keeping.
 *
 * The order is the point. The audit flush is registered through the tracked
 * `waitUntil` first, and `dispose` closes the connection only after every
 * tracked task has settled — so the flush cannot race the close it depends on.
 * The handle is per-request by hard runtime rule (see `context.ts`): workerd
 * forbids a socket from serving any request but the one that opened it.
 *
 * A flush failure is logged and not rethrown, because by this point the response
 * has already gone and there is nobody to tell. It is logged at `error` so it is
 * alertable: an audit log that is quietly missing entries is worse than one that
 * is visibly broken.
 */
function settle(services: ServiceContext, recorder: BufferedAuditRecorder): void {
  if (recorder.size > 0) {
    services.waitUntil(
      recorder.flush().catch((cause: unknown) => {
        services.log
          .at('settle')
          .error(
            `Failed to write ${recorder.size} buffered audit record(s) after the response — ` +
              'those events are now missing from the audit log and cannot be recovered',
            { pending: recorder.size, error: describeError(cause) },
          );
      }),
    );
  }

  services.dispose();
}

function withRequestId(response: Response, requestId: string): Response {
  response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}

/**
 * Converts anything thrown into a response.
 *
 * Three conversions happen here and nowhere else, so there is one place to audit
 * for "can an internal detail reach a client?".
 */
function failure(
  cause: unknown,
  requestId: string,
  logger: Logger,
  doing: RequestAction,
): Response {
  const log = logger.at('failure');

  // An authorization denial is a value, not an exception — but `assertCan`
  // throws so handlers can stay linear. Its decision already distinguishes
  // notFound from forbidden, which is the distinction that must not be lost.
  if (cause instanceof AuthorizationError) {
    const error =
      cause.decision.reason === 'notFound'
        ? errors.notFound('authorization denied')
        : errors.forbidden(cause.decision.message);

    // At `warn`, not `error`: a denial is the authorization layer working. It
    // is logged at all because a burst of them from one principal is the shape
    // of an account being probed, and that pattern is invisible if each denial
    // is silent.
    log.warn(
      cause.decision.reason === 'notFound'
        ? `Refused to ${doing.base} ${doing.object}, and answered "not found" rather than ` +
            '"forbidden" so the caller cannot learn whether the resource exists'
        : `Refused to ${doing.base} ${doing.object} — the caller's role does not carry the ` +
            'capability this action requires',
      { reason: cause.decision.reason, status: error.status },
    );

    return json(error.toBody(requestId), {
      status: error.status,
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  }

  // A missing binding is an operator fault, not a bad request. 503 lets
  // monitoring separate "this deployment is misconfigured" from "this code is
  // broken", which are very different pages to be woken up for.
  if (cause instanceof MissingBindingError) {
    const error = errors.unavailable(`missing binding ${cause.binding}`);
    log.error(
      `This deployment is missing the ${cause.binding} binding, so it cannot serve requests — ` +
        'every call will answer 503 until the binding is configured and the Worker redeployed',
      { binding: cause.binding },
    );

    return json(error.toBody(requestId), {
      status: error.status,
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  }

  const error = toApiError(cause);

  if (error.status >= 500) {
    // The one place a full stack is recorded. `logDetail` is the curated
    // summary the error type chose to expose; `error` is what actually landed,
    // scrubbed of connection strings and bearer tokens on the way in. A 500
    // without a stack is a 500 nobody can fix.
    log.error(
      `An unhandled error escaped the handler while trying to ${doing.base} ${doing.object} — ` +
        'the caller received a 500 with no detail, and the cause is in the error field below',
      {
        code: error.code,
        status: error.status,
        detail: error.logDetail,
        error: describeError(cause),
      },
    );
  } else {
    // Client errors at `debug`: a 400 is normal traffic, and one line per
    // rejected request in production is noise that hides the 500s. The finish
    // line still records the status, so the rate is queryable without this.
    log.debug(`Rejected a request to ${doing.base} ${doing.object} as ${error.code}`, {
      code: error.code,
      status: error.status,
    });
  }

  return json(error.toBody(requestId), {
    status: error.status,
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}

import { BufferedAuditRecorder, createAuditBuilder } from '@xecret/core/audit';
import type { AuditBuilder, AuditRecord } from '@xecret/core/audit';
import { AuthorizationError } from '@xecret/core/authz';
import { actorId, actorLabel, actorType, assertCsrf, authenticate } from './actor';
import type { CredentialSource, Principal } from './actor';
import { DatabaseAuditSink } from './audit-sink';
import { MissingBindingError, publicOrigin } from './bindings';
import { createServiceContext, workerContext } from './context';
import type { ServiceContext } from './context';
import { errors } from './errors';
import { REQUEST_ID_HEADER, isSameOrigin, json, requestIdFrom, toApiError } from './http';

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
 *
 * A handler that opted out of the wrapper would silently lose all four. There is
 * no reason to, and a reviewer can check compliance by grepping for `export
 * const GET =`.
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
    // failure, so the request id is established first and everything else,
    // including context construction, happens inside the boundary.
    const requestId = requestIdFrom(request);

    let started: RequestScope | undefined;
    try {
      started = await begin(request, requestId);
      const params = ((await args?.params) ?? {}) as Params;

      return withRequestId(
        await handler({ request, params, services: started.services }),
        requestId,
      );
    } catch (cause) {
      return failure(cause, requestId);
    } finally {
      if (started) flush(started.services, started.recorder);
    }
  };
}

/**
 * Wraps a handler that requires an authenticated principal.
 *
 * Authentication, the cross-origin check, and CSRF all run before the handler
 * body. Authorization does not: it needs the resource, which only the handler
 * can resolve. The handler calls `can()` — see `docs/architecture/api.md` §2.
 */
export function authenticatedRoute<Params = Record<string, never>>(
  handler: Handler<RouteContext<Params>>,
): (request: Request, args?: NextRouteArgs<Params>) => Promise<Response> {
  return async (request, args) => {
    const requestId = requestIdFrom(request);

    let started: RequestScope | undefined;
    try {
      started = await begin(request, requestId);
      const { services, recorder } = started;

      // Checked before authentication so a cross-site request is rejected
      // without the cost of a token lookup, and without its outcome depending
      // on whether the credential happened to be valid.
      if (!isSameOrigin(request, publicOrigin(services.env))) {
        throw errors.csrf('origin mismatch');
      }

      const { principal, source } = await authenticate(request, services);
      assertCsrf(request, source);

      const params = ((await args?.params) ?? {}) as Params;

      const response = await handler({
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
      });

      return withRequestId(response, requestId);
    } catch (cause) {
      return failure(cause, requestId);
    } finally {
      if (started) flush(started.services, started.recorder);
    }
  };
}

interface RequestScope {
  services: ServiceContext;
  recorder: BufferedAuditRecorder;
}

async function begin(request: Request, requestId: string): Promise<RequestScope> {
  const services = await createServiceContext(request, await workerContext(), requestId);
  return {
    services,
    recorder: new BufferedAuditRecorder(new DatabaseAuditSink(services.db)),
  };
}

/**
 * Flushes buffered audit records after the response has been sent.
 *
 * Runs in `finally`, so records queued before a failure are still written — the
 * denial that caused the failure is exactly the record worth keeping.
 *
 * A flush failure is logged and not rethrown, because by this point the response
 * has already gone and there is nobody to tell. It is logged at `error` so it is
 * alertable: an audit log that is quietly missing entries is worse than one that
 * is visibly broken.
 */
function flush(services: ServiceContext, recorder: BufferedAuditRecorder): void {
  if (recorder.size === 0) return;

  services.waitUntil(
    recorder.flush().catch((cause: unknown) => {
      console.error('audit flush failed', {
        requestId: services.meta.requestId,
        path: services.meta.path,
        pending: recorder.size,
        // The name only. An audit-write failure is usually a database error, and
        // those messages carry connection strings.
        error: cause instanceof Error ? cause.name : 'unknown',
      });
    }),
  );
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
function failure(cause: unknown, requestId: string): Response {
  // An authorization denial is a value, not an exception — but `assertCan`
  // throws so handlers can stay linear. Its decision already distinguishes
  // notFound from forbidden, which is the distinction that must not be lost.
  if (cause instanceof AuthorizationError) {
    const error =
      cause.decision.reason === 'notFound'
        ? errors.notFound('authorization denied')
        : errors.forbidden(cause.decision.message);

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
    console.error('missing binding', { requestId, binding: cause.binding });

    return json(error.toBody(requestId), {
      status: error.status,
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  }

  const error = toApiError(cause);

  if (error.status >= 500) {
    console.error('unhandled route failure', {
      requestId,
      code: error.code,
      detail: error.logDetail,
    });
  }

  return json(error.toBody(requestId), {
    status: error.status,
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}

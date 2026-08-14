/**
 * The browser's client for the xecret HTTP API.
 *
 * Contract: `docs/architecture/api.md`. Three properties matter more than
 * ergonomics here, and each is enforced in one place so no call site can opt
 * out of it by accident:
 *
 *  1. **Cookie credentials, plus the CSRF double-submit on every mutation.**
 *     §2 of the contract rejects a mutation that presents the session cookie
 *     without the matching `X-Xecret-Csrf` header. Attaching that header here,
 *     rather than at each call site, is what makes "we always send it" true.
 *  2. **Response bodies are never logged.** A single `GET …/secrets/{name}`
 *     response *is* a plaintext credential. There is no log level at which
 *     printing it is acceptable, so this module never passes a body to
 *     `console`, never embeds one in an `Error` message, and never re-throws
 *     an exception whose message was built from one.
 *  3. **A 401 ends the session, visibly.** Leaving a signed-out user staring
 *     at a dashboard of stale data invites them to retry an action that has
 *     already failed silently.
 */

/** Set by the server on login; readable by JavaScript by design — it is the
 *  echo half of the double-submit pair, not a credential on its own. */
export const CSRF_COOKIE_NAME = '__Host-xecret_csrf';
export const CSRF_HEADER_NAME = 'X-Xecret-Csrf';

export const SIGN_IN_PATH = '/sign-in';

/**
 * Where sign-in lands when the request carried no `?next=`.
 *
 * Declared here, in one place, because both authentication screens and the
 * dashboard's own entry point need to agree on it.
 */
export const POST_SIGN_IN_PATH = '/app';

const API_BASE = '/api';

/**
 * The server's vocabulary from §3 of the contract, plus one code the server
 * can never send: `network_error`, for a request that never got a response.
 * Callers that switch on `code` need a case for "the API was unreachable", and
 * inventing a fake `internal_error` for it would misattribute the fault.
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
  /** The session is authenticated but locked. The dashboard shows the PIN screen. */
  | 'session_locked'
  | 'internal_error'
  | 'unavailable'
  | 'network_error';

export interface FieldProblem {
  field: string;
  message: string;
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  /** Correlates with the server log line. Surface it in error UI. */
  readonly requestId: string | null;
  readonly fields: readonly FieldProblem[];

  constructor(init: {
    code: ApiErrorCode;
    message: string;
    status: number;
    requestId: string | null;
    fields?: readonly FieldProblem[];
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.code = init.code;
    this.status = init.status;
    this.requestId = init.requestId;
    this.fields = init.fields ?? [];
  }

  /** Field errors keyed by field name, for wiring into `<Field error>`. */
  fieldErrors(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const problem of this.fields) {
      if (!(problem.field in map)) map[problem.field] = problem.message;
    }
    return map;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export type QueryValue = string | number | boolean | null | undefined;

export interface ApiRequestOptions {
  query?: Record<string, QueryValue>;
  signal?: AbortSignal;
  /**
   * Defaults to `true`. Set `false` for calls that legitimately run without a
   * session — signing out, or probing `/api/auth/me` on a public page — where
   * bouncing to the sign-in screen would be wrong or would loop.
   */
  redirectOnUnauthenticated?: boolean;
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split('; ')) {
    const separator = part.indexOf('=');
    if (separator > 0 && part.slice(0, separator) === name) {
      return decodeURIComponent(part.slice(separator + 1));
    }
  }
  return null;
}

/**
 * Accepts only a same-origin absolute path.
 *
 * The `?next=` parameter is attacker-supplied, and a sign-in page that
 * forwards to an arbitrary URL after authenticating is a phishing primitive:
 * the victim really did sign in to the real site, then landed on the
 * attacker's. `//evil.example` and `/\evil.example` are both protocol-relative
 * in browsers, so a leading-slash check alone is not enough.
 */
export function safeRedirectPath(value: string | null | undefined, fallback = '/'): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  if (!value.startsWith('/')) return fallback;
  if (value.startsWith('//') || value.startsWith('/\\')) return fallback;
  return value;
}

function buildUrl(path: string, query: Record<string, QueryValue> | undefined): string {
  const url = path.startsWith('/api/')
    ? path
    : `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
  if (!query) return url;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  const serialised = params.toString();
  return serialised.length > 0 ? `${url}?${serialised}` : url;
}

function isFieldProblem(value: unknown): value is FieldProblem {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate['field'] === 'string' && typeof candidate['message'] === 'string';
}

const ERROR_CODES = new Set<string>([
  'bad_request',
  'validation_failed',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'payload_too_large',
  'rate_limited',
  'csrf_failed',
  'session_locked',
  'internal_error',
  'unavailable',
]);

const FALLBACK_MESSAGE = 'Something went wrong. Please try again.';

/**
 * Turns a non-2xx response into an `ApiError`.
 *
 * If the body is not the documented envelope it is discarded entirely rather
 * than surfaced — an unexpected body is exactly the case where it might be an
 * upstream proxy page, a stack trace, or a partially serialised secret.
 */
async function toApiError(response: Response): Promise<ApiError> {
  const headerRequestId = response.headers.get('x-xecret-request-id');

  let code: ApiErrorCode = 'internal_error';
  let message = FALLBACK_MESSAGE;
  let requestId = headerRequestId;
  let fields: FieldProblem[] = [];

  try {
    const body: unknown = await response.json();
    const envelope =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)['error']
        : undefined;

    if (typeof envelope === 'object' && envelope !== null) {
      const error = envelope as Record<string, unknown>;
      if (typeof error['code'] === 'string' && ERROR_CODES.has(error['code'])) {
        code = error['code'] as ApiErrorCode;
      }
      if (typeof error['message'] === 'string' && error['message'].length > 0) {
        message = error['message'];
      }
      if (typeof error['requestId'] === 'string') {
        requestId = error['requestId'];
      }
      if (Array.isArray(error['fields'])) {
        fields = error['fields'].filter(isFieldProblem);
      }
    }
  } catch {
    // Body was absent or not JSON. Nothing about it is recorded: see the note
    // at the top of this file about response bodies.
  }

  return new ApiError({ code, message, status: response.status, requestId, fields });
}

function redirectToSignIn(): void {
  if (typeof window === 'undefined') return;
  const { pathname, search, hash } = window.location;
  // Already on an auth screen: a redirect here would loop and would discard
  // whatever the user had typed.
  if (pathname.startsWith(SIGN_IN_PATH) || pathname === '/sign-up') return;

  const next = encodeURIComponent(`${pathname}${search}${hash}`);
  // A full document load rather than `router.push`, deliberately. The session
  // has just been rejected, so every RSC payload the router has cached for
  // this tab was rendered for a session that no longer exists; a soft
  // navigation would keep them. Throwing the document away is the only way to
  // guarantee no authenticated content survives the transition.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- see above
  window.location.assign(`${SIGN_IN_PATH}?next=${next}`);
}

async function request<T>(
  method: string,
  path: string,
  body: unknown,
  options: ApiRequestOptions = {},
): Promise<T> {
  const headers = new Headers({ accept: 'application/json' });

  let payload: string | undefined;
  if (body !== undefined) {
    headers.set('content-type', 'application/json');
    payload = JSON.stringify(body);
  }

  if (method !== 'GET' && method !== 'HEAD') {
    const csrf = readCookie(CSRF_COOKIE_NAME);
    // A missing cookie is not a client-side failure: the server decides, and
    // its 403 `csrf_failed` is the honest answer. Guessing here would only
    // produce a second, less accurate error message.
    if (csrf !== null) headers.set(CSRF_HEADER_NAME, csrf);
  }

  const init: RequestInit = {
    method,
    headers,
    // The session lives in a `__Host-` cookie, so it only travels when the
    // request is explicitly credentialed.
    credentials: 'include',
    // Several of these responses carry decrypted values. Nothing about them
    // may end up in the HTTP cache, regardless of what an intermediary does.
    cache: 'no-store',
  };
  if (payload !== undefined) init.body = payload;
  if (options.signal) init.signal = options.signal;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), init);
  } catch (cause) {
    // Offline, DNS failure, or an aborted request. The thrown value is not
    // attached: fetch rejection reasons are opaque and this keeps the error
    // shape uniform for callers.
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError({
      code: 'network_error',
      message: 'Could not reach xecret. Check your connection and try again.',
      status: 0,
      requestId: null,
    });
  }

  if (!response.ok) {
    const error = await toApiError(response);
    if (error.status === 401 && options.redirectOnUnauthenticated !== false) {
      redirectToSignIn();
    }
    throw error;
  }

  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return undefined as T;
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError({
      code: 'internal_error',
      message: FALLBACK_MESSAGE,
      status: response.status,
      requestId: response.headers.get('x-xecret-request-id'),
    });
  }
}

export const api = {
  get: <T>(path: string, options?: ApiRequestOptions): Promise<T> =>
    request<T>('GET', path, undefined, options),

  post: <T>(path: string, body?: unknown, options?: ApiRequestOptions): Promise<T> =>
    request<T>('POST', path, body, options),

  patch: <T>(path: string, body?: unknown, options?: ApiRequestOptions): Promise<T> =>
    request<T>('PATCH', path, body, options),

  put: <T>(path: string, body?: unknown, options?: ApiRequestOptions): Promise<T> =>
    request<T>('PUT', path, body, options),

  delete: <T>(path: string, body?: unknown, options?: ApiRequestOptions): Promise<T> =>
    request<T>('DELETE', path, body, options),
} as const;

/**
 * Ends the xecret session.
 *
 * This lives here rather than in `lib/firebase.ts` on purpose. Signing out of
 * the product means revoking *our* session — there is nothing to sign out of
 * on the Firebase side, because `exchangeForSession` drops the Firebase user
 * the moment the session cookie exists and persistence is in-memory anyway.
 *
 * Keeping it out of the Firebase module also keeps the Firebase SDK out of
 * every bundle that renders the app shell. That is ~300 KB the signed-in
 * dashboard has no use for.
 */
export function endSession(): Promise<void> {
  return api.delete<void>('/auth/session', undefined, { redirectOnUnauthenticated: false });
}

/**
 * A human-readable message for any thrown value.
 *
 * Non-`ApiError` values are collapsed to a fixed string rather than having
 * their `message` read: an arbitrary exception's message may have been built
 * from the request payload, which in this product may be a secret value.
 */
export function errorMessage(error: unknown): string {
  return isApiError(error) ? error.message : FALLBACK_MESSAGE;
}

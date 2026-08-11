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
  | 'internal_error'
  | 'unavailable';

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  bad_request: 400,
  validation_failed: 422,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  rate_limited: 429,
  csrf_failed: 403,
  internal_error: 500,
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

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    /** Correlates a user-visible failure with the server log line. */
    requestId: string;
    fields?: FieldProblem[];
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
  readonly logDetail: string | undefined;

  constructor(
    code: ApiErrorCode,
    message: string,
    options: { fields?: FieldProblem[]; logDetail?: string } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.fields = options.fields;
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

  tooLarge: (message: string): ApiError => new ApiError('payload_too_large', message),

  rateLimited: (): ApiError =>
    new ApiError('rate_limited', 'Too many requests. Please slow down and try again.'),

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

  internal: (logDetail: string): ApiError =>
    new ApiError('internal_error', 'Something went wrong.', { logDetail }),
} as const;

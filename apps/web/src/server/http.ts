import type { ZodMiniType } from 'zod/mini';
import { uuidv7 } from '@xecret/core/ids';
import { ApiError, errors } from './errors';
import type { FieldProblem } from './errors';

/**
 * Request and response plumbing shared by every route handler.
 */

/**
 * Largest JSON body the API will read.
 *
 * A single secret is capped at 64 KB by `MAX_SECRET_VALUE_BYTES`; this ceiling
 * exists for the bulk paths (import, batch write) and to stop an unauthenticated
 * caller from making the Worker buffer megabytes before authentication has even
 * run. The limit is enforced *before* parsing, because `JSON.parse` on a
 * hostile 50 MB document is itself the denial of service.
 */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

/**
 * Every response carries a request id, and every log line for that request
 * carries the same one. It is the only thing that lets a user report "I got an
 * error" and an operator find the corresponding server-side detail — which
 * matters precisely because the error body deliberately says so little.
 */
export const REQUEST_ID_HEADER = 'x-xecret-request-id';

/**
 * Mints this request's id.
 *
 * ── Always ours, always UUIDv7 ──
 * This used to return Cloudflare's `cf-ray` when present, to make a support
 * conversation cross into the platform's own logs. That is a real benefit and
 * it is kept — as `rayIdFrom` below, logged as its own field — but it is the
 * wrong thing to *be* the request id, for three reasons that only became
 * obvious once every log line started carrying one:
 *
 *  - **It is client-supplied.** `cf-ray` is a header, and a request that
 *    reaches the Worker without passing the edge — `next dev`, a self-hosted
 *    deployment behind a different proxy, a crafted request — can set it to
 *    anything, including an id already in use. Two unrelated requests sharing
 *    an id is the one failure a correlation key cannot survive.
 *  - **It is not sortable.** A UUIDv7's leading 48 bits are a millisecond
 *    timestamp, so ids sort in creation order. `ORDER BY requestId` in a log
 *    query is chronological, and the id alone dates an incident without a
 *    clock field.
 *  - **It was inconsistent.** A ray id in production and a UUID in development
 *    meant a format that log tooling could not parse or validate.
 *
 * The generator is the same one that mints every row's primary key, so ids in
 * the audit log and ids in the log stream have one shape and one meaning.
 */
export function requestIdFrom(): string {
  return uuidv7();
}

/**
 * Cloudflare's ray id, when the request arrived through the edge.
 *
 * A correlation label only, on the log line beside our own id — never used for
 * a security decision, and never trusted to be unique, because it is a header.
 * `null` under `next dev` and behind any proxy that is not Cloudflare.
 */
export function rayIdFrom(request: Request): string | null {
  const ray = request.headers.get('cf-ray');
  if (ray === null) return null;
  // Bounded like every other attacker-controlled header that lands in a log.
  return ray.slice(0, 64);
}

/**
 * The client's IP, for rate limiting and audit records.
 *
 * `CF-Connecting-IP` is set by Cloudflare's edge and overwrites anything the
 * client sent, so it is trustworthy here in a way `X-Forwarded-For` never is —
 * a client can append whatever it likes to the latter. Returns null rather than
 * a placeholder when absent, so an audit record says "unknown" honestly instead
 * of asserting an address that was never observed.
 */
export function clientIp(request: Request): string | null {
  return request.headers.get('cf-connecting-ip');
}

export function userAgent(request: Request): string | null {
  const value = request.headers.get('user-agent');
  if (value === null) return null;
  // Bounded because it lands in an audit row and in logs; an unbounded
  // attacker-controlled header is a cheap way to inflate storage.
  return value.slice(0, 512);
}

export interface JsonResponseInit {
  status?: number;
  headers?: Record<string, string>;
  /** `Set-Cookie` must be repeatable, so cookies are passed separately. */
  cookies?: readonly string[];
}

export function json(body: unknown, init: JsonResponseInit = {}): Response {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    // An API response is never a cacheable artefact here: every one is
    // tenant-specific, and several carry decrypted secret values. `private` is
    // not enough — an intermediary that ignores it is exactly the risk.
    'cache-control': 'no-store',
    ...init.headers,
  });

  for (const cookie of init.cookies ?? []) headers.append('set-cookie', cookie);

  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

export function noContent(cookies: readonly string[] = []): Response {
  const headers = new Headers({ 'cache-control': 'no-store' });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 204, headers });
}

/**
 * Reads and parses a JSON body, enforcing the size ceiling first.
 *
 * `Content-Length` is checked as a cheap rejection, but the body is still read
 * with a running byte count because a chunked request may omit or understate it.
 * Trusting the declared length alone is a well-worn way past a size limit.
 */
export async function readJsonBody(request: Request): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_REQUEST_BODY_BYTES) {
    throw errors.tooLarge('Request body is too large.');
  }

  const text = await readBoundedText(request);
  if (text.trim() === '') return undefined;

  try {
    return JSON.parse(text);
  } catch {
    throw errors.badRequest('Request body is not valid JSON.');
  }
}

async function readBoundedText(request: Request): Promise<string> {
  const body = request.body;
  if (body === null) return '';

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BODY_BYTES) {
      await reader.cancel();
      throw errors.tooLarge('Request body is too large.');
    }
    chunks.push(value);
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder('utf-8', { fatal: true }).decode(joined);
}

/**
 * Validates a value against a schema, converting failures into field problems.
 *
 * Only the issue's path and message cross the boundary. Zod's `input` is
 * discarded on purpose: in this product the rejected input may itself be a
 * secret value, and echoing it back would place it in the response body, the
 * browser's network log, and any error-reporting pipeline.
 */
export function parseWith<T>(schema: ZodMiniType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  const fields: FieldProblem[] = result.error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join('.') : '(body)',
    message: issue.message,
  }));

  throw errors.validation(fields);
}

export async function parseJsonBody<T>(request: Request, schema: ZodMiniType<T>): Promise<T> {
  return parseWith(schema, await readJsonBody(request));
}

export function parseQuery<T>(request: Request, schema: ZodMiniType<T>): T {
  const params = new URL(request.url).searchParams;
  return parseWith(schema, Object.fromEntries(params.entries()));
}

/**
 * Parses a `Cookie` header into a map.
 *
 * Written out rather than taken from a library because the rules that matter
 * here are narrow and worth being explicit about: the first occurrence of a name
 * wins. A browser may send duplicates when a host-scoped and a domain-scoped
 * cookie share a name, and taking the last one would let a subdomain shadow the
 * `__Host-` cookie — the exact attack the prefix exists to prevent.
 */
export function parseCookies(header: string | null): ReadonlyMap<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;

    const name = part.slice(0, separator).trim();
    if (name === '' || cookies.has(name)) continue;

    cookies.set(name, part.slice(separator + 1).trim());
  }

  return cookies;
}

/** The bearer credential on a request, if it presented one. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;

  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || rest.length === 0) return null;

  const token = rest.join(' ').trim();
  return token === '' ? null : token;
}

/**
 * Cross-origin check for state-changing requests.
 *
 * Complements the CSRF token rather than replacing it. `Origin` is set by the
 * browser and cannot be forged by page script, so it catches a cross-site
 * mutation even if the CSRF token were somehow leaked. It is not sufficient
 * alone: non-browser clients legitimately omit it, so a missing `Origin` cannot
 * be treated as a failure without breaking the CLI.
 */
export function isSameOrigin(request: Request, expectedOrigin: string): boolean {
  const origin = request.headers.get('origin');
  if (origin === null) return true;
  return origin === expectedOrigin;
}

export function toApiError(cause: unknown): ApiError {
  if (cause instanceof ApiError) return cause;
  // Deliberately does not read `cause.message`: a postgres.js error message can
  // contain the connection string, and a crypto failure can contain identifiers.
  return errors.internal(cause instanceof Error ? cause.name : 'unknown');
}

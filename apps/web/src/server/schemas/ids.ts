import * as z from 'zod/mini';

/**
 * UUID fields on the wire.
 *
 * ── Why a length check was not enough ──
 * Several request schemas validated a uuid as "a string of 36 characters", which
 * accepts `------------------------------------` and every other 36-byte string
 * a client cares to send. The value then reached a `uuid` column, PostgreSQL
 * raised `22P02 invalid input syntax for type uuid`, and the route wrapper — which
 * has no reason to recognise a driver error code — turned a malformed request
 * body into a **500**. A caller learns nothing, an alert fires, and the fault is
 * recorded against the server rather than against the request that caused it.
 *
 * So the shape is checked where every other shape is checked: at the boundary,
 * before anything is written, and reported as the validation error it is.
 *
 * ── Strict, deliberately ──
 * The pattern is the one `@xecret/core/ids` applies — canonical lowercase, no
 * braces, no URN prefix. Ids arriving from a client are compared against database
 * values and against ids bound into AAD, and silently accepting several spellings
 * of one identifier is how inconsistent-comparison bugs start. Uppercase is
 * rejected rather than normalised for the same reason.
 *
 * The length check stays alongside the regex: it is what a caller sees first when
 * they sent something of the wrong size, and the two together mean a change to
 * either cannot quietly widen what is accepted.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A canonical UUID string, with the message the field wants to give. */
export function uuidField(message: string) {
  return z.string().check(z.length(36, message), z.regex(UUID_PATTERN, message));
}

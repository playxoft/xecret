/**
 * What is allowed to reach a log line.
 *
 * ── This is defence in depth, not the guarantee ──
 * The guarantee is that no call site passes a secret to the logger, and it is
 * held the same way the audit metadata allowlist holds it: by review, at the
 * call site, where somebody can see what the value is. This module exists
 * because that guarantee is one careless spread away from being false —
 * `log.info('wrote secret', { ...row })` is a plausible line to write, and the
 * row has a `value` column.
 *
 * So: a field whose *name* suggests a credential never has its value
 * serialised, whatever it holds. Field names are chosen by developers and are
 * stable; values are not, which is why the rule keys on the name.
 *
 * ── And the two leaks that are documented rather than hypothetical ──
 * A postgres.js error message can contain the connection string, and an
 * `Authorization` header can end up inside a fetch failure. Both are scrubbed
 * out of message text by pattern, because both have appeared in this
 * codebase's comments as the reason error messages were previously never
 * logged at all.
 */

const REDACTED = '[redacted]';

/** Long enough for a stack frame or a path; short enough to bound a log line. */
const MAX_STRING = 512;

/** Deep objects in a log line are a mistake; four levels is generous. */
const MAX_DEPTH = 4;

const MAX_KEYS = 48;
const MAX_ARRAY_ITEMS = 32;

/**
 * Suffixes that make a name an identifier rather than a credential.
 *
 * Checked *before* the sensitive substrings below, and that order is the whole
 * design. `tokenId`, `sessionId`, `keyVersion` and `secretName` all contain a
 * word from the deny list and all of them are safe — they are the fields an
 * investigation is actually conducted with. Without this pass, turning on
 * redaction would blank exactly the columns that make the logs useful.
 */
const IDENTIFIER_SUFFIXES = [
  'id',
  'ids',
  'at',
  'ms',
  'name',
  'slug',
  'kind',
  'type',
  'count',
  'version',
  'length',
  'bytes',
  'status',
  'level',
  'reason',
  'action',
];

/**
 * Words that make a field a credential.
 *
 * `value` is on the list because that is the column secrets are stored in, and
 * `hash`/`salt` because a stored verifier is still material an offline attack
 * starts from.
 */
const SENSITIVE_WORDS = [
  'secret',
  'password',
  'passphrase',
  'pin',
  'token',
  'credential',
  'authorization',
  'cookie',
  'key',
  'cipher',
  'plaintext',
  'ciphertext',
  'value',
  'hash',
  'salt',
  'signature',
  'bearer',
  'private',
  'jwt',
  'seed',
];

/**
 * Names that survive both rules above.
 *
 * Small on purpose: an entry here is a standing exception, and each one is a
 * field somebody decided is worth reading in an incident.
 */
const ALWAYS_SAFE = new Set(['keyversion', 'rootkeyversion', 'requestedversion', 'algorithm']);

export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (ALWAYS_SAFE.has(lower)) return false;
  if (IDENTIFIER_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return false;
  return SENSITIVE_WORDS.some((word) => lower.includes(word));
}

/**
 * Patterns that are stripped out of free text.
 *
 * Applied to messages and stack frames — the places where a credential arrives
 * embedded in a sentence rather than as its own field, which no name-based rule
 * can catch.
 */
const TEXT_SCRUBBERS: readonly { pattern: RegExp; replacement: string }[] = [
  // postgres://user:password@host/db — the documented reason error messages
  // were previously not logged at all in this codebase. The scheme and
  // everything after the `@` survive, because "which host did it fail to reach"
  // is the useful half and carries no credential.
  { pattern: /\b([a-z][a-z0-9+.-]*):\/\/[^\s@/]+:[^\s@/]+@/gi, replacement: '$1://[redacted]@' },
  // `Bearer eyJ…`, `Authorization: …`
  { pattern: /\bbearer\s+[\w.\-+/=]{8,}/gi, replacement: 'bearer [redacted]' },
  { pattern: /\bauthorization\s*[:=]\s*\S+/gi, replacement: 'authorization=[redacted]' },
  // `password=…`, `"token": …`, `api_key=…` inside a serialised blob. The
  // optional quotes matter more than they look: the common case is a JSON body
  // echoed into an error message, where the key arrives as `"password"`.
  {
    pattern:
      /\b(password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key)"?\s*[:=]\s*"?[^\s",}]+"?/gi,
    replacement: '$1=[redacted]',
  },
];

/** Removes credential-shaped substrings from free text and bounds its length. */
export function scrubText(text: string): string {
  let scrubbed = text;
  for (const { pattern, replacement } of TEXT_SCRUBBERS) {
    scrubbed = scrubbed.replace(pattern, replacement);
  }
  return scrubbed.length > MAX_STRING ? `${scrubbed.slice(0, MAX_STRING)}…` : scrubbed;
}

/**
 * Converts one value into something `JSON.stringify` will handle predictably.
 *
 * Depth- and width-bounded, because a log line is a record of what happened and
 * not a heap dump — and because the entries are batched in memory until the
 * response has been sent, so an unbounded one is charged to the request that
 * emitted it.
 */
function sanitiseValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return null;

  switch (typeof value) {
    case 'string':
      return scrubText(value);
    case 'number':
      // NaN and ±Infinity serialise to `null`, which reads in a log viewer as
      // "the field was absent" rather than "the arithmetic went wrong".
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'function':
    case 'symbol':
      return `[${typeof value}]`;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '[invalid-date]' : value.toISOString();
  }

  if (value instanceof Error) return describeError(value);

  if (depth >= MAX_DEPTH) return '[truncated]';

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitiseValue(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[+${value.length - MAX_ARRAY_ITEMS} more]`);
    return items;
  }

  if (value instanceof Map || value instanceof Set) return `[${value.constructor.name}]`;

  if (typeof value === 'object') {
    return sanitiseFields(value as Record<string, unknown>, depth + 1);
  }

  return '[unserialisable]';
}

function sanitiseFields(fields: Record<string, unknown>, depth: number): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  let seen = 0;

  for (const [key, value] of Object.entries(fields)) {
    if (seen >= MAX_KEYS) {
      output['_truncatedKeys'] = Object.keys(fields).length - MAX_KEYS;
      break;
    }
    seen += 1;

    if (isSensitiveKey(key)) {
      // Recorded as present-but-hidden rather than dropped: "the row had a
      // value column" is itself useful, and a silently missing field reads as a
      // bug in the code that built the line.
      output[key] = REDACTED;
      continue;
    }

    if (value === undefined) continue;
    output[key] = sanitiseValue(value, depth);
  }

  return output;
}

/** Entry point: redacts and bounds a whole field bag. */
export function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  return sanitiseFields(fields, 0);
}

export interface DescribedError {
  name: string;
  message: string;
  /** The top frames only — enough to locate the throw, not a full dump. */
  stack?: string[];
  /** Present when the thrown value carried a `cause`. */
  cause?: string;
}

/** How many stack frames are worth keeping. */
const STACK_FRAMES = 4;

/**
 * Turns anything thrown into loggable fields.
 *
 * The message *is* included, scrubbed — which is a deliberate reversal of the
 * previous rule in this codebase, where error messages were never logged
 * because a postgres.js message can carry the connection string. That rule
 * bought safety at the cost of unfixable incidents: `{ error: 'Error' }` tells
 * an operator nothing at 3am. The connection string is now removed by pattern
 * in `scrubText`, which addresses the actual leak instead of discarding the
 * whole message to avoid it.
 *
 * Use `errorName` instead at the few call sites where the message is known to
 * embed a user's email — a mail delivery failure, for one.
 */
export function describeError(cause: unknown): DescribedError {
  if (cause instanceof Error) {
    const described: DescribedError = {
      name: cause.name,
      message: scrubText(cause.message),
    };

    if (typeof cause.stack === 'string') {
      const frames = cause.stack
        .split('\n')
        .slice(1, STACK_FRAMES + 1)
        .map((frame) => scrubText(frame.trim()))
        .filter((frame) => frame.length > 0);
      if (frames.length > 0) described.stack = frames;
    }

    if (cause.cause !== undefined && cause.cause !== null) {
      described.cause =
        cause.cause instanceof Error ? cause.cause.name : scrubText(String(cause.cause));
    }

    return described;
  }

  return { name: 'NonError', message: scrubText(String(cause)) };
}

/** The thrown value's name and nothing else, where even a message is too much. */
export function errorName(cause: unknown): string {
  return cause instanceof Error ? cause.name : 'unknown';
}

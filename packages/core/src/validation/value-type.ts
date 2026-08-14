import { parse as parseYaml } from 'yaml';
import { checkXmlWellFormed } from './xml';

/**
 * What shape a secret's value is supposed to have.
 *
 * ── Why a secret manager validates values at all ──
 * The failure this prevents is not a typo. It is the deploy where `PORT` was
 * saved as `3o30`, the service refused to start at 02:00, and the value looked
 * right to everyone who read it. A secret is written once and read by a machine
 * thereafter, so the moment a person is present is the only moment the mistake
 * is cheap — after that it surfaces as a crash loop in something that has no idea
 * what a valid port is.
 *
 * ── The default is `string`, and that is deliberate ──
 * Most secrets are opaque tokens with no shape worth asserting, and a tool that
 * demands a type before it will store a value is a tool people route around. So
 * `string` accepts anything and is what every existing secret already is.
 *
 * ── Where this runs ──
 * Both sides, from this one module. The dashboard checks as you type and on
 * paste, so a bad value never leaves the browser; the API checks again on write,
 * because the CLI, the import endpoint and anything else holding a token all
 * reach the same tables and a client-side rule is a suggestion. Neither copy can
 * drift from the other, because there is only one.
 *
 * ── What a check is allowed to see ──
 * The value. Nothing here logs, throws with the value in the message, or returns
 * any part of it: `ValueTypeCheck.message` is assembled from fixed strings and
 * the type's own name. That matters because the one caller that fails is the one
 * holding a credential, and an error message is the easiest place in a system for
 * a secret to escape into a log.
 */

export const SECRET_VALUE_TYPES = [
  'string',
  'boolean',
  'int',
  'decimal',
  'email',
  'url',
  'date',
  'datetime',
  'json',
  'yaml',
  'xml',
  'ulid',
  'uuidv4',
  'uuidv7',
] as const;

export type SecretValueType = (typeof SECRET_VALUE_TYPES)[number];

/** Applied to every secret that does not name a type, including every existing one. */
export const DEFAULT_SECRET_VALUE_TYPE: SecretValueType = 'string';

export interface ValueTypeCheck {
  valid: boolean;
  /**
   * Why it was rejected. Safe to render directly: built from fixed strings and
   * the type name, never from the value.
   */
  message?: string;
}

const VALID: ValueTypeCheck = { valid: true };

export function isSecretValueType(value: unknown): value is SecretValueType {
  return typeof value === 'string' && (SECRET_VALUE_TYPES as readonly string[]).includes(value);
}

/** Falls back to `string` for an absent or unrecognised type, rather than throwing. */
export function toSecretValueType(value: unknown): SecretValueType {
  return isSecretValueType(value) ? value : DEFAULT_SECRET_VALUE_TYPE;
}

/** How a type is presented in a picker, and what it accepts. */
export interface SecretValueTypeDescriptor {
  type: SecretValueType;
  /** Shown in the type selector. */
  label: string;
  /** One line under the input, describing what will be accepted. */
  hint: string;
  /** A concrete accepted value, used as an input placeholder. */
  example: string;
}

export const SECRET_VALUE_TYPE_DESCRIPTORS: Readonly<
  Record<SecretValueType, SecretValueTypeDescriptor>
> = {
  string: {
    type: 'string',
    label: 'String',
    hint: 'Any text. Nothing is checked.',
    example: '',
  },
  boolean: {
    type: 'boolean',
    label: 'Boolean',
    hint: 'true, false, 1, 0, yes, no, on or off — in any case.',
    example: 'true',
  },
  int: {
    type: 'int',
    label: 'Integer',
    hint: 'A whole number, optionally signed, within the 64-bit range.',
    example: '5432',
  },
  decimal: {
    type: 'decimal',
    label: 'Decimal',
    hint: 'A number with an optional decimal point. No exponent notation.',
    example: '19.99',
  },
  email: {
    type: 'email',
    label: 'Email',
    hint: 'One address. The shape is checked; deliverability is not.',
    example: 'ops@example.com',
  },
  url: {
    type: 'url',
    label: 'URL',
    hint: 'An absolute URL with a scheme — https, postgres, redis, anything.',
    example: 'https://api.example.com',
  },
  date: {
    type: 'date',
    label: 'Date',
    hint: 'YYYY-MM-DD, and a date that exists.',
    example: '2026-01-31',
  },
  datetime: {
    type: 'datetime',
    label: 'Date and time',
    hint: 'ISO 8601 with a timezone, so it is never ambiguous.',
    example: '2026-01-31T09:30:00Z',
  },
  json: {
    type: 'json',
    label: 'JSON',
    hint: 'Any valid JSON document.',
    example: '{"region":"eu-west-1"}',
  },
  yaml: {
    type: 'yaml',
    label: 'YAML',
    hint: 'Parses as YAML. Almost any single line does, so this mainly catches broken blocks.',
    example: 'region: eu-west-1',
  },
  xml: {
    type: 'xml',
    label: 'XML',
    hint: 'Well-formed XML with a single root element. Not checked against a schema.',
    example: '<config><region>eu-west-1</region></config>',
  },
  ulid: {
    type: 'ulid',
    label: 'ULID',
    hint: '26 characters in Crockford base32.',
    example: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  },
  uuidv4: {
    type: 'uuidv4',
    label: 'UUID v4',
    hint: 'A random UUID — version nibble 4.',
    example: '9b2f4c1e-8a3d-4f6b-9c2e-1d5a7b3e6f80',
  },
  uuidv7: {
    type: 'uuidv7',
    label: 'UUID v7',
    hint: 'A time-ordered UUID — version nibble 7.',
    example: '019456f0-8c3a-7d21-9f4e-6b8a2c5d1e30',
  },
};

/** In the order the picker should offer them: the common ones first. */
export const SECRET_VALUE_TYPE_ORDER: readonly SecretValueType[] = SECRET_VALUE_TYPES;

/**
 * Checks a value against a type.
 *
 * ── Exactly the bytes that will be stored ──
 * No check below trims. An earlier version did, and it was wrong in a way worth
 * recording: xecret stores the value verbatim, so trimming here would accept
 * `" 5432 "` as an integer and then hand a consumer a string that `Atoi` refuses.
 * The validator has to see what the database will see, or it is validating a
 * value that never existed.
 *
 * Surrounding whitespace therefore fails — but with its own message, because
 * "expected a whole number" is baffling when the value plainly *is* one and the
 * real problem is a newline the user cannot see. This is the single most common
 * way a pasted credential arrives, so it gets a sentence that says what to do.
 *
 * ── Empty is not a shape failure ──
 * "A secret must have a value" is the write path's rule. Reporting it here would
 * flag a row the instant somebody picked a type, before they had typed anything.
 */
export function checkSecretValue(value: string, type: SecretValueType): ValueTypeCheck {
  if (value.length === 0) return VALID;

  const check = CHECKS[type](value);
  if (check.valid) return check;

  const trimmed = value.trim();
  if (trimmed.length > 0 && trimmed !== value && CHECKS[type](trimmed).valid) {
    return invalid(
      'That value has whitespace around it — often a stray newline from a copy. Remove it.',
    );
  }

  return check;
}

const BOOLEAN_LITERALS = new Set(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off']);

/** Signed 64-bit, matching what a Postgres `bigint` or a Go `int64` will hold. */
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

const INT_PATTERN = /^[+-]?\d+$/;
const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|z|[+-]\d{2}:\d{2})$/;
const ULID_PATTERN = /^[0-7][0-9ABCDEFGHJKMNPQRSTVWXYZ]{25}$/i;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * A pragmatic address shape, not RFC 5322.
 *
 * The full grammar accepts quoted local parts containing spaces and comments in
 * parentheses, which no configuration value has ever legitimately used, and
 * implementing it would reject nothing people actually get wrong. This catches
 * the real mistakes — a missing `@`, a bare hostname, a trailing comma from a
 * copied list — and says plainly that it is a shape check.
 */
const EMAIL_PATTERN =
  /^[^\s@,;<>"]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const EMAIL_MAX_LENGTH = 254;

type Check = (value: string) => ValueTypeCheck;

function invalid(message: string): ValueTypeCheck {
  return { valid: false, message };
}

const CHECKS: Readonly<Record<SecretValueType, Check>> = {
  string: () => VALID,

  boolean: (value) =>
    BOOLEAN_LITERALS.has(value.toLowerCase())
      ? VALID
      : invalid('Expected true, false, 1, 0, yes, no, on or off.'),

  int: (value) => {
    if (!INT_PATTERN.test(value)) return invalid('Expected a whole number, such as 5432.');
    // BigInt rather than Number: a 19-digit identifier is a perfectly ordinary
    // secret, and `Number` would silently round it before the range check ran.
    const parsed = BigInt(value);
    if (parsed < INT64_MIN || parsed > INT64_MAX) {
      return invalid('That number is outside the 64-bit integer range.');
    }
    return VALID;
  },

  decimal: (value) =>
    DECIMAL_PATTERN.test(value)
      ? VALID
      : invalid('Expected a decimal number, such as 19.99. Exponent notation is not accepted.'),

  email: (value) => {
    if (value.length > EMAIL_MAX_LENGTH) {
      return invalid(`An email address cannot be longer than ${EMAIL_MAX_LENGTH} characters.`);
    }
    return EMAIL_PATTERN.test(value)
      ? VALID
      : invalid('Expected one email address, such as ops@example.com.');
  },

  url: (value) => {
    // Rejected before parsing: `new URL` tolerates a tab or newline inside a URL
    // by stripping it, so a value with one would be accepted here and then
    // behave differently in whatever consumes it.
    if (/[\s]/.test(value)) return invalid('A URL cannot contain spaces or line breaks.');

    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return invalid('Expected an absolute URL including a scheme, such as https://example.com.');
    }

    // `new URL('https:')` parses. Requiring something after the scheme is what
    // makes this reject a value that is only half typed.
    if (parsed.protocol.length === 0 || value.length <= parsed.protocol.length + 1) {
      return invalid('That URL has a scheme but nothing after it.');
    }

    return VALID;
  },

  date: (value) => {
    const match = DATE_PATTERN.exec(value);
    if (!match) return invalid('Expected a date as YYYY-MM-DD, such as 2026-01-31.');
    return isRealDate(match[1] as string, match[2] as string, match[3] as string)
      ? VALID
      : invalid('That date does not exist in the calendar.');
  },

  datetime: (value) => {
    const match = DATETIME_PATTERN.exec(value);
    if (!match) {
      return invalid(
        'Expected an ISO 8601 date and time with a timezone, such as 2026-01-31T09:30:00Z.',
      );
    }
    if (!isRealDate(match[1] as string, match[2] as string, match[3] as string)) {
      return invalid('That date does not exist in the calendar.');
    }

    const hours = Number(match[4]);
    const minutes = Number(match[5]);
    const seconds = match[6] === undefined ? 0 : Number(match[6]);
    // 24:00 and a leap second are both legal ISO 8601 and both break consumers
    // that use a plain time type, so they are refused rather than normalised.
    if (hours > 23 || minutes > 59 || seconds > 59) {
      return invalid('That time of day does not exist.');
    }

    return VALID;
  },

  json: (value) => {
    try {
      JSON.parse(value);
      return VALID;
    } catch {
      // The parser's own message quotes the offending token, which on this path
      // is part of a secret. Replaced with a fixed string.
      return invalid('That is not valid JSON.');
    }
  },

  yaml: (value) => {
    try {
      parseYaml(value);
      return VALID;
    } catch {
      return invalid('That is not valid YAML.');
    }
  },

  xml: (value) => {
    const problem = checkXmlWellFormed(value);
    if (problem === null) return VALID;
    // The scanner's messages name elements and attributes from the document.
    // Those are structure rather than payload, and a person fixing a broken
    // block needs them — but the line number is what makes the message useful,
    // so both are kept and nothing else from the document is.
    return invalid(`Line ${problem.line}: ${problem.message}`);
  },

  ulid: (value) =>
    ULID_PATTERN.test(value) ? VALID : invalid('Expected a 26-character ULID in Crockford base32.'),

  uuidv4: (value) => (UUID_V4_PATTERN.test(value) ? VALID : invalid('Expected a version 4 UUID.')),

  uuidv7: (value) => (UUID_V7_PATTERN.test(value) ? VALID : invalid('Expected a version 7 UUID.')),
};

/**
 * Whether a Y-M-D triple is a date that exists.
 *
 * Done by round-tripping through `Date` rather than by a month-length table, so
 * leap years — including the century rule that makes 2100-02-29 invalid and
 * 2000-02-29 valid — come from the runtime instead of from arithmetic here.
 * `Date.UTC` avoids the local-timezone shift that would make a date near
 * midnight round-trip to the day before.
 */
function isRealDate(year: string, month: string, day: string): boolean {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;

  const date = new Date(Date.UTC(y, m - 1, d));
  // `Date.UTC` maps years 0–99 onto 1900–1999, which would reject the legal
  // date 0050-01-01 as non-existent. Rare, but a silent wrong answer.
  if (y < 100) date.setUTCFullYear(y);

  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

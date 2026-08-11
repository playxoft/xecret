/**
 * Display formatting.
 *
 * Everything here is pure and takes its "now" as an argument where time is
 * involved, so the same input always produces the same output. A formatter
 * that reads the clock internally cannot be tested and cannot be rendered on
 * the server without drifting from the client.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

const absolute = new Intl.DateTimeFormat('en', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * "3 minutes ago", "in 2 days", "last week".
 *
 * Anything older than four weeks becomes an absolute date: "7 months ago" is
 * useless when you are trying to work out whether a token predates an incident.
 *
 * The output depends on the reader's locale and clock, so a value rendered on
 * the server will not match the browser. Render this in a Client Component, or
 * pair it with `suppressHydrationWarning`.
 */
export function formatRelativeTime(
  value: Date | string | number,
  now: number = Date.now(),
): string {
  const date = toDate(value);
  const ms = date.getTime();
  if (Number.isNaN(ms)) return 'unknown';

  const delta = ms - now;
  const magnitude = Math.abs(delta);

  if (magnitude < 45_000) return 'just now';
  if (magnitude < HOUR) return relative.format(Math.round(delta / MINUTE), 'minute');
  if (magnitude < DAY) return relative.format(Math.round(delta / HOUR), 'hour');
  if (magnitude < WEEK) return relative.format(Math.round(delta / DAY), 'day');
  if (magnitude < 4 * WEEK) return relative.format(Math.round(delta / WEEK), 'week');
  return absolute.format(date);
}

/** The full timestamp, for `title` attributes next to a relative one. */
export function formatAbsoluteTime(value: Date | string | number): string {
  const date = toDate(value);
  return Number.isNaN(date.getTime()) ? 'unknown' : absolute.format(date);
}

/** ISO 8601, for `<time dateTime>`. */
export function toIsoString(value: Date | string | number): string | undefined {
  const date = toDate(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

const BYTE_UNITS = ['B', 'KB', 'MB'] as const;

/**
 * Binary units with the conventional short labels.
 *
 * 1 KB means 1024 bytes here, because the limits this formats against — a
 * 64 KB secret, a 1 MB request body — are themselves powers of two. Showing
 * "65.5 KB" for a value the API calls 64 KB would be technically SI-correct
 * and practically confusing.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit] ?? 'B'}`;
}

/**
 * Shortens from the middle, keeping both ends.
 *
 * Identifiers in this product are distinguished by their tails as often as
 * their heads — `STRIPE_KEY_STAGING` and `STRIPE_KEY_PRODUCTION` are identical
 * for eighteen characters. Trailing-ellipsis truncation would render them the
 * same string.
 */
export function truncateMiddle(value: string, maxLength = 32): string {
  if (maxLength < 5 || value.length <= maxLength) return value;
  const head = Math.ceil((maxLength - 1) / 2);
  const tail = Math.floor((maxLength - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

/** Up to two letters for an avatar fallback. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1] ?? '') : '';
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase() || '?';
}

/** `1 secret` / `2 secrets`, without a dependency on a pluralisation library. */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString('en')} ${count === 1 ? singular : plural}`;
}

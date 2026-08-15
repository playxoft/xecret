/**
 * The shapes the logging system is built from.
 *
 * Kept separate from every implementation so the logger, the sinks and the
 * redactor can be read — and tested — without pulling in `fetch`, the Worker
 * bindings, or each other.
 */

/**
 * The four levels, and nothing else.
 *
 * No `trace`, no `fatal`. `trace` becomes a synonym for `debug` that half the
 * codebase picks at random, and `fatal` describes a process that is about to
 * die — which a Worker isolate never does in a way a log line could report.
 * Four levels with distinct alerting meanings beat six with overlapping ones:
 *
 *  - `debug` — off in production. The shape of a request while you develop.
 *  - `info`  — something happened that an operator would want in a timeline.
 *  - `warn`  — something was refused or degraded, and the system carried on.
 *            A rejected credential lives here: it is expected traffic.
 *  - `error` — something is broken, or a guarantee was not kept. Alertable.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Ranked, for threshold comparisons. */
export const LOG_LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && value in LOG_LEVEL_ORDER;
}

/**
 * Structured fields attached to one line.
 *
 * `unknown` rather than a JSON-value union, deliberately. A call site that has
 * to hand-convert a `Date` or an `Error` before it can log will eventually skip
 * the log instead — so the redactor accepts anything and is responsible for
 * turning it into something serialisable. The type system is the wrong place to
 * enforce that; a value arriving from a database driver is `unknown` anyway.
 */
export type LogFields = Readonly<Record<string, unknown>>;

/**
 * One finished, redacted line.
 *
 * `dt`, `level` and `message` are named for Better Stack: it reads `dt` as the
 * event time — without it, lines are stamped on arrival and a batch flushed
 * after the response all lands on the same millisecond — and it promotes
 * `level` and `message` to first-class columns. Everything else is an indexed
 * field.
 */
export interface LogEntry {
  /** RFC 3339, always UTC. */
  dt: string;
  level: LogLevel;
  message: string;
  [field: string]: unknown;
}

/**
 * Somewhere a line goes.
 *
 * `write` is synchronous and must never throw: a logger that can fail is a
 * logger call sites start wrapping in `try`, and the first one that forgets
 * turns a log line into a 500. Buffering sinks do their real work in `flush`,
 * which the request wrapper defers past the response.
 */
export interface LogSink {
  write(entry: LogEntry): void;
  flush(): Promise<void>;
}

/**
 * The call-site interface.
 *
 * `at` is the reason every line in this codebase can name the function that
 * emitted it without anybody remembering to pass a string: a module does
 * `services.log.at('revealSecret')` once and every line beneath it carries
 * `fn`. Reading a stack trace out of an `Error` would be the alternative, and it
 * does not survive minification of the Worker bundle.
 */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A child that stamps `fn` on everything it emits. */
  at(fn: string): Logger;
  /** A child that stamps arbitrary fields on everything it emits. */
  child(fields: LogFields): Logger;
}

/**
 * A request's logger, plus the two controls only the request wrapper uses.
 *
 * `bind` exists because the most valuable fields — who is calling, and which
 * organisation they are in — are not known when the logger is created. They are
 * learned during authentication and during path resolution, several lines into
 * a request that has already logged. Binding mutates one shared object that
 * every logger in the request reads at emit time, so a child created before the
 * principal was known still carries the user id afterwards.
 */
export interface RequestLog {
  logger: Logger;
  bind: (fields: LogFields) => void;
  flush: () => Promise<void>;
}

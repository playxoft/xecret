import { redactFields, scrubText } from './redact';
import { LOG_LEVEL_ORDER } from './types';
import type { LogEntry, LogFields, LogLevel, LogSink, Logger, RequestLog } from './types';

/**
 * The logger.
 *
 * ── Three field bags, merged at emit time ──
 * Every line is the union of the **request context**, the **logger's own
 * fields**, and the **call's fields**, in that order of increasing precedence.
 *
 * The request context is shared by reference and mutable, which is the one
 * unusual decision here and the one that makes the whole thing work. The fields
 * an investigation actually needs — who is calling, which organisation they are
 * in — are not known when the logger is built: the user id arrives from
 * authentication and the organisation from resolving the path, both of them
 * several lines into a request that has already logged. If children snapshotted
 * their parent's fields, a logger created in `authenticate` would carry `userId:
 * undefined` for the rest of the request. Reading a shared object at emit time
 * instead means binding the principal retroactively completes every logger in
 * the request, including ones already handed to a service.
 *
 * ── `at()`, and why `fn` is on every line ──
 * A log line without the function that emitted it is a message you have to
 * grep the codebase for, and messages get copy-pasted between call sites. `at`
 * makes naming it a single call per module rather than a field per line, so it
 * actually gets done. Reading the name out of an `Error` stack was the
 * alternative and does not survive minification of the Worker bundle.
 */

interface LoggerState {
  sink: LogSink;
  minimum: LogLevel;
  /** Shared by reference with every logger built from the same request. */
  context: Record<string, unknown>;
  now: () => number;
}

function build(state: LoggerState, own: LogFields): Logger {
  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[state.minimum]) return;

    const merged = {
      ...state.context,
      ...own,
      ...(fields ?? {}),
    };

    const entry: LogEntry = {
      ...redactFields(merged),
      // Assigned last, so a caller who happens to pass a field called `level`
      // annotates their line instead of corrupting the level Better Stack
      // filters and alerts on.
      dt: new Date(state.now()).toISOString(),
      level,
      // Scrubbed and bounded like any other string. Messages are sentences now
      // rather than fixed labels, and a sentence built from a request describes
      // a path the caller chose — so the same rules that apply to a field value
      // have to apply here.
      message: scrubText(message),
    };

    state.sink.write(entry);
  };

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    at: (fn) => build(state, { ...own, fn }),
    child: (fields) => build(state, { ...own, ...fields }),
  };
}

export interface CreateLoggerOptions {
  sink: LogSink;
  /** Lines below this are discarded before they are redacted or serialised. */
  minimum: LogLevel;
  /** Facts known at creation: service, environment, request id, method, path. */
  base?: LogFields;
  /** Injected in tests. */
  now?: () => number;
}

/**
 * Builds a request's logger and the two controls the request wrapper needs.
 *
 * Returned as a bundle rather than as a logger with extra methods, so `bind`
 * and `flush` are reachable only by the code that owns the request's lifecycle.
 * A service that could call `flush` would ship a partial batch mid-request and
 * spend one of the six outgoing connections doing it; one that could call
 * `bind` could rewrite the user id on lines it does not own.
 */
export function createLogger(options: CreateLoggerOptions): RequestLog {
  const context: Record<string, unknown> = { ...(options.base ?? {}) };

  const state: LoggerState = {
    sink: options.sink,
    minimum: options.minimum,
    context,
    now: options.now ?? Date.now,
  };

  return {
    logger: build(state, {}),
    bind: (fields) => {
      for (const [key, value] of Object.entries(fields)) {
        // `undefined` is "not known yet", never "erase what we learned". A
        // resolver that fails partway through must not blank the organisation
        // a previous step established.
        if (value !== undefined) context[key] = value;
      }
    },
    flush: () => options.sink.flush(),
  };
}

/**
 * A logger that writes nowhere.
 *
 * For tests and for the handful of code paths that run outside a request, where
 * there is no context to attach and nobody to read the line.
 */
export function silentLogger(): Logger {
  const noop: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    at: () => noop,
    child: () => noop,
  };
  return noop;
}

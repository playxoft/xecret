import type { Bindings } from '../bindings';
import { createLogger } from './logger';
import { BETTERSTACK_DEFAULT_URL, BetterStackSink, ConsoleSink, fanOut } from './sinks';
import { isLogLevel } from './types';
import type { LogFields, LogLevel, LogSink, RequestLog } from './types';

export { describeOutcome, describeRequest } from './describe-request';
export type { RequestAction } from './describe-request';
export { createLogger, silentLogger } from './logger';
export { describeError, errorName, isSensitiveKey, redactFields, scrubText } from './redact';
export { BETTERSTACK_DEFAULT_URL, BetterStackSink, ConsoleSink, fanOut } from './sinks';
export { LOG_LEVEL_ORDER, isLogLevel } from './types';
export type { DescribedError } from './redact';
export type { LogEntry, LogFields, LogLevel, LogSink, Logger, RequestLog } from './types';

/**
 * Assembling the logging stack from configuration.
 *
 * ── Better Stack is optional, exactly like mail ──
 * A self-hoster running xecret for one team has Cloudflare's own log tail and
 * no reason to sign up for anything. So an absent `BETTERSTACK_SOURCE_TOKEN`
 * means "console only", not a failed boot — the same call this codebase already
 * makes for ZeptoMail. Requiring it would make an observability vendor a
 * dependency of an open-source deployment, which is the sort of thing that
 * makes a project only runnable on its author's accounts.
 */

/**
 * The default threshold.
 *
 * `debug` in development because that is where the shape of a request is worth
 * seeing; `info` everywhere else because a debug line per request in production
 * is a bill, not an insight. Overridable with `XECRET_LOG_LEVEL` for the case
 * this exists to serve: turning debug on in production for ten minutes during
 * an incident, without a deploy.
 */
export function defaultLogLevel(env: Bindings): LogLevel {
  const configured = env.XECRET_LOG_LEVEL;
  if (isLogLevel(configured)) return configured;
  return env.XECRET_ENV === 'development' ? 'debug' : 'info';
}

/**
 * Builds the sink stack for this deployment. Console always; Better Stack when
 * configured.
 *
 * The console sink is handed to `BetterStackSink` as well as placed in the
 * fan-out, and it is deliberately the *same* instance: because it is already in
 * the fan-out, every line has been written to the Cloudflare tail before the
 * batch is even assembled, so a shipping failure has nothing to recover and only
 * has to be announced. See `BetterStackSink.degrade`.
 */
export function createSink(env: Bindings): LogSink {
  const console = new ConsoleSink();
  const token = env.BETTERSTACK_SOURCE_TOKEN;

  if (!token) return console;

  return fanOut([
    console,
    new BetterStackSink(
      { token, url: env.BETTERSTACK_INGEST_URL || BETTERSTACK_DEFAULT_URL },
      console,
    ),
  ]);
}

/**
 * The fields every line of a request carries before anything is known about it.
 *
 * `service` and `env` are here rather than configured in Better Stack because a
 * single source usually receives staging and production, and a query that
 * cannot separate them is a query that reports staging's error rate as an
 * outage.
 */
export interface RequestLogBase {
  requestId: string;
  /** Cloudflare's ray id, when the request came through the edge. */
  rayId: string | null;
  method: string;
  path: string;
  ip: string | null;
  userAgent: string | null;
  /**
   * The stable action key for this route, e.g. `secret.reveal`.
   *
   * On the base rather than only on the completion line, so *every* line of the
   * request — a decryption failure deep in a service, a denied authorization —
   * can be grouped by what the request was trying to do. Prose in `message`
   * answers "what happened"; this answers "which of these are the same kind of
   * thing", and a dashboard must never depend on the prose.
   */
  event: string;
}

export function createRequestLog(env: Bindings, base: RequestLogBase): RequestLog {
  const fields: LogFields = {
    service: 'xecret-web',
    env: env.XECRET_ENV,
    ...base,
  };

  return createLogger({
    sink: createSink(env),
    minimum: defaultLogLevel(env),
    base: fields,
  });
}

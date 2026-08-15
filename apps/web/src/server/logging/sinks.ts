import { scrubText } from './redact';
import type { LogEntry, LogSink } from './types';

/**
 * Where log lines go.
 *
 * ── Two destinations, always ──
 * Every line is written to the console *and* buffered for Better Stack. That is
 * not redundancy for its own sake: `wrangler tail` and the Cloudflare dashboard
 * read the console, and they are what you have during a deploy, in local
 * development, and in the minutes when the log pipeline itself is the thing
 * that is broken. Better Stack is what you have a week later when somebody asks
 * why a secret was read on Tuesday.
 *
 * It is also what makes a shipping failure survivable without any recovery
 * machinery: the console has already written every line by the time the batch
 * leaves, so a failed POST costs the retention, not the record.
 *
 * ── Why Better Stack is batched and deferred ──
 * A Worker invocation may open six outgoing connections (ADR 0006) and the
 * database already holds one. A POST per log line would exhaust that on any
 * request that logged more than five times, and would add the round trip to the
 * latency of a response the user is waiting for. So lines accumulate in memory
 * for the life of the request and leave in a single batch, handed to
 * `waitUntil` after the response has been sent.
 *
 * ── Failure is contained here ──
 * `write` cannot throw, and a failed flush degrades to the console rather than
 * propagating. An observability pipeline that can fail a request is worse than
 * no observability pipeline.
 */

/** Routes by level so Cloudflare's own dashboard classifies the line correctly. */
export class ConsoleSink implements LogSink {
  write(entry: LogEntry): void {
    // One JSON object per line. Not `console.log(message, fields)` — that
    // renders as two arguments in the dashboard and cannot be queried.
    const line = safeStringify(entry);

    // The one sanctioned `console` in the codebase. `no-console` bans it
    // everywhere else precisely so that this is the only boundary — a stray
    // `console.log` in a service is a line with no request id, no user and no
    // organisation, which is the thing this whole module exists to prevent.
    // `debug` and `info` are disabled below because the lint rule allows only
    // `warn` and `error`, and dropping the level distinction would make
    // Cloudflare's dashboard classify every line as an error.
    /* eslint-disable no-console */
    switch (entry.level) {
      case 'error':
        console.error(line);
        return;
      case 'warn':
        console.warn(line);
        return;
      case 'debug':
        console.debug(line);
        return;
      default:
        console.info(line);
    }
    /* eslint-enable no-console */
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Better Stack's default ingest host.
 *
 * Sources created after mid-2024 get their own `<id>.betterstackdata.com`
 * hostname and **must** use it — posting to the shared host with a
 * region-specific token answers 401 with no explanation. `BETTERSTACK_INGEST_URL`
 * exists for exactly that, and `check:env` calls it out, because it is the same
 * class of confusing regional failure as ZeptoMail's.
 */
export const BETTERSTACK_DEFAULT_URL = 'https://in.logs.betterstack.com';

export interface BetterStackConfig {
  /** The source token from the Better Stack source's settings page. */
  token: string;
  url: string;
  /**
   * Lines held for one request before new ones are dropped.
   *
   * A bound rather than a rejection: the entries sit in the isolate's memory
   * until the response is sent, so a request stuck in a logging loop would
   * otherwise be charged memory until the runtime killed it. Drops are counted
   * and reported in the batch, so a truncated request is visible as truncated.
   */
  maxBatch?: number;
}

const DEFAULT_MAX_BATCH = 256;

/** How long the ingest POST is given before it is abandoned. */
const FLUSH_TIMEOUT_MS = 5_000;

export class BetterStackSink implements LogSink {
  private readonly buffer: LogEntry[] = [];
  private readonly maxBatch: number;
  private dropped = 0;

  /**
   * @param diagnostics Where the *failure* is reported when a POST does not
   *   land. Always the console sink, which `createSink` also puts in the fan-out
   *   — so the lines themselves are already on the Cloudflare tail and there is
   *   nothing here to recover. This sink only has to say that the retention copy
   *   is missing, and why.
   */
  constructor(
    private readonly config: BetterStackConfig,
    private readonly diagnostics: LogSink,
  ) {
    this.maxBatch = config.maxBatch ?? DEFAULT_MAX_BATCH;
  }

  write(entry: LogEntry): void {
    if (this.buffer.length >= this.maxBatch) {
      this.dropped += 1;
      return;
    }
    this.buffer.push(entry);
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0, this.buffer.length);

    if (this.dropped > 0) {
      batch.push({
        dt: new Date().toISOString(),
        level: 'warn',
        message:
          `Dropped ${this.dropped} log line(s) from this request: the per-request batch limit ` +
          `of ${this.maxBatch} was reached, so this request's log is incomplete`,
        fn: 'BetterStackSink.flush',
        droppedLines: this.dropped,
        maxBatch: this.maxBatch,
      });
      this.dropped = 0;
    }

    try {
      const response = await fetch(this.config.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.token}`,
          'content-type': 'application/json',
        },
        // An array in one request. Better Stack accepts either a single object
        // or a batch, and a batch is the whole reason this sink buffers.
        body: safeStringify(batch),
        signal: AbortSignal.timeout(FLUSH_TIMEOUT_MS),
      });

      if (!response.ok) {
        // Read and discard: leaving the body unread holds the connection open,
        // and the Worker only has six.
        const detail = await response.text().catch(() => '<unreadable>');
        this.degrade(batch, `ingest responded ${response.status}: ${detail.slice(0, 200)}`);
      }
    } catch (cause) {
      this.degrade(batch, cause instanceof Error ? cause.name : 'unknown');
    }
  }

  /**
   * Reports that a batch did not reach Better Stack.
   *
   * One line, not a replay. The console sink sits alongside this one in the
   * fan-out and has already written every entry in the batch, so echoing them
   * back through it would print each line twice — doubling Cloudflare's log
   * volume during exactly the outage when the operator is reading that tail, and
   * for no gain. What is actually missing is the *searchable* copy, and that is
   * what this line says.
   *
   * `reason` is scrubbed because up to 200 bytes of it is an arbitrary remote
   * response body. This is the one path that writes to a sink directly rather
   * than through the logger, so nothing else would redact it.
   */
  private degrade(batch: readonly LogEntry[], reason: string): void {
    const scrubbed = scrubText(reason);

    this.diagnostics.write({
      dt: new Date().toISOString(),
      level: 'error',
      message:
        `Could not ship ${batch.length} log line(s) to Better Stack (${scrubbed}) — they are on ` +
        'the Cloudflare log tail, which is where this request has to be reconstructed from until ' +
        'shipping recovers',
      fn: 'BetterStackSink.flush',
      lines: batch.length,
      reason: scrubbed,
    });
  }
}

/** Writes every line to each sink; flushes them concurrently. */
export function fanOut(sinks: readonly LogSink[]): LogSink {
  return {
    write(entry) {
      for (const sink of sinks) sink.write(entry);
    },
    async flush() {
      // `allSettled`, so one sink's failure cannot strand another's buffer.
      await Promise.allSettled(sinks.map((sink) => sink.flush()));
    },
  };
}

/**
 * `JSON.stringify` that cannot throw.
 *
 * The redactor already flattens everything it is given, so a cycle should be
 * impossible — but this runs in the path that reports failures, and a throw
 * here would replace a diagnostic with a different, less useful one.
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return JSON.stringify({
      level: 'error',
      message:
        'A log entry could not be serialised to JSON and was replaced by this line; the ' +
        'original is lost',
      dt: new Date().toISOString(),
    });
  }
}

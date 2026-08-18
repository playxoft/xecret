import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

/**
 * Database connection adapter. See docs/adr/0006-database-access.md.
 *
 * Production uses Cloudflare Hyperdrive, which keeps a warm connection pool at
 * the edge, so the Worker never pays connection setup and — importantly — the
 * database does not consume any of the 6 outgoing `fetch` connections a Worker
 * invocation is allowed.
 *
 * Nothing else in the codebase knows which connection path is in use. Keep it
 * that way: self-hosters without Hyperdrive swap this with one env var.
 */

export type Database = ReturnType<typeof createDatabase>;

export interface DatabaseConfig {
  /**
   * Connection string. In a Worker this is `env.HYPERDRIVE.connectionString`;
   * locally it is the direct Neon URL.
   */
  connectionString: string;
  /**
   * Hyperdrive already pools, so the Worker-side client should open exactly one
   * connection per isolate. Raise only for scripts running outside a Worker.
   */
  maxConnections?: number;
  /** Emits generated SQL. Never enable in production — queries carry identifiers. */
  debug?: boolean;
}

function connect(config: DatabaseConfig) {
  return postgres(config.connectionString, {
    max: config.maxConnections ?? 1,
    // Hyperdrive terminates TLS to the origin itself; prepared statements are
    // disabled because Hyperdrive's pooling may route queries across sessions.
    //
    // Transactions are unaffected and are safe to rely on: Hyperdrive pins a
    // single origin connection for the life of an explicit transaction, so the
    // statements between BEGIN and COMMIT all reach the same session. That
    // matters more here than in most applications — organisation bootstrap and
    // environment creation both write key material and its parent row together,
    // and a partial commit there produces an account that cannot be repaired
    // without an operator holding the Root KEK.
    prepare: false,
    // A Worker isolate is short-lived; do not hold sockets waiting on idle.
    idle_timeout: 20,
    connect_timeout: 10,
    // postgres.js would otherwise print notices to stdout. Secrets never appear
    // in a notice, but a secret manager should not emit unstructured output.
    onnotice: () => {},
  });
}

/**
 * For long-lived processes — scripts, migrations, tests — where the connection
 * outlives any single unit of work and the process exit is the cleanup.
 *
 * **Not for a Worker request path.** workerd forbids using a TCP socket
 * outside the request that opened it ("Cannot perform I/O on behalf of a
 * different request"), so a client held across requests serves the first one
 * and wedges every one after it. A Worker uses `createDatabaseHandle`, one
 * per request, and disposes it after the response.
 */
export function createDatabase(config: DatabaseConfig) {
  const client = connect(config);
  return drizzle(client, { schema, logger: config.debug ?? false });
}

/**
 * A database whose lifetime the caller owns.
 *
 * This is the Worker-side shape: one handle per request, `end()` after the
 * response (and after any deferred audit writes). Per-request connection setup
 * is what Hyperdrive exists to make cheap — the handshake terminates at the
 * edge proxy, not at the origin — so the cost of correctness here is
 * milliseconds, and the alternative is the cross-request I/O error above.
 */
export interface DatabaseHandle {
  db: Database;
  /** Closes the connections, waiting briefly for in-flight queries to settle. */
  end(): Promise<void>;
}

export function createDatabaseHandle(config: DatabaseConfig): DatabaseHandle {
  const client = connect(config);
  return {
    db: drizzle(client, { schema, logger: config.debug ?? false }),
    end: async () => {
      // `timeout` bounds the wait for active queries; the socket is closed
      // either way. Without it, one hung query would keep the handle — and
      // whatever awaits its disposal — alive indefinitely.
      await client.end({ timeout: 5 });
    },
  };
}

export { schema };

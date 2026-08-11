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

export function createDatabase(config: DatabaseConfig) {
  const client = postgres(config.connectionString, {
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

  return drizzle(client, { schema, logger: config.debug ?? false });
}

export { schema };

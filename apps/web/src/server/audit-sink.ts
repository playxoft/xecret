import { appendAuditEvents } from '@xecret/db/repositories';
import type { AuditRecord, AuditSink } from '@xecret/core/audit';
import type { Database } from '@xecret/db';

/**
 * Writes audit records to the database.
 *
 * The adapter exists so `@xecret/core` never imports the database: the audit
 * builder can then be unit-tested with an in-memory sink, and a self-hoster who
 * ships records to an external SIEM implements this one interface rather than
 * forking the builder.
 *
 * `audit_logs` is append-only by database grant, not by convention — the
 * application role holds INSERT and SELECT and nothing else. So this class
 * cannot offer an update or a delete even if someone wanted one.
 */
export class DatabaseAuditSink implements AuditSink {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async write(events: readonly AuditRecord[]): Promise<void> {
    if (events.length === 0) return;
    await appendAuditEvents(this.#db, events);
  }
}

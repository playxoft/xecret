import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/**
 * Applies pending migrations.
 *
 * Run as:  phase run -- npm run db:migrate
 *
 * Uses MIGRATION_DATABASE_URL when present, so migrations run under a more
 * privileged role than the application (which has no DDL rights at all — see
 * docs/architecture/database-schema.md §10).
 */
async function main(): Promise<void> {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

  if (!url) {
    console.error(
      'No database URL. Set DATABASE_URL (or MIGRATION_DATABASE_URL).\n' +
        'Secrets come from Phase.dev — try: phase run -- npm run db:migrate',
    );
    process.exit(1);
  }

  // max: 1 — migrations must run sequentially on a single connection.
  const client = postgres(url, { max: 1, onnotice: () => {} });

  try {
    console.warn('Applying migrations…');
    await migrate(drizzle(client), { migrationsFolder: './migrations' });
    console.warn('Migrations applied.');
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  // Never print the error object itself: a connection error from postgres.js
  // can embed the connection string, which contains the database password.
  console.error('Migration failed:', error instanceof Error ? error.message : 'unknown error');
  process.exit(1);
});

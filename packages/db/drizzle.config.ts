import { defineConfig } from 'drizzle-kit';

/**
 * Migrations are generated here, then **committed and reviewed as SQL**.
 * Generated migrations are never applied unreviewed — a security product cannot
 * have surprise schema changes. See docs/adr/0006-database-access.md.
 */
export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    // Supplied by Phase.dev: `phase run -- npm run db:generate`
    url: process.env.DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
});

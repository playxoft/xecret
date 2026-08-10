import { defineCloudflareConfig } from '@opennextjs/cloudflare';

/**
 * OpenNext adapter configuration.
 *
 * Deliberately minimal. Incremental cache, tag cache, and queue overrides are
 * intentionally omitted in Phase 1: xecret's pages are authenticated and
 * user-specific, so there is nothing meaningful to cache at the edge, and every
 * override adds bundle weight against the 10 MB compressed ceiling.
 *
 * Revisit when the marketing site (Phase 9) gains static pages worth caching.
 */
export default defineCloudflareConfig();

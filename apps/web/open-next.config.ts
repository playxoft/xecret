import { defineCloudflareConfig } from '@opennextjs/cloudflare';
import staticAssetsIncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache';

/**
 * OpenNext adapter configuration.
 *
 * ── Why there is an incremental cache here now ──
 * This file used to omit one, on the reasoning that "xecret's pages are
 * authenticated and user-specific, so there is nothing meaningful to cache at
 * the edge", with a note to revisit when the marketing site arrived. It
 * arrived, and the note was not acted on, and the consequence was not slower
 * pages — it was a public site that did not work at all.
 *
 * Without an incremental cache the adapter has nowhere to read prerendered
 * output from, so every request re-renders the route inside the Worker. For a
 * page assembled from components that is merely wasteful, which is why `/`,
 * `/pricing` and `/features` looked fine. Every route that reads its content
 * off disk — the docs, the blog, `sitemap.xml`, `llms.txt` — calls `node:fs`,
 * which does not exist in workerd, and answered 500. `/docs/[...slug]` answered
 * 404 instead, because it sets `dynamicParams = false` and the params it was
 * built with were unreachable at request time. The build was correct throughout:
 * 56 routes were prerendered, and nothing could read them.
 *
 * ── Why the static-assets cache specifically ──
 * It is read-only: it serves what `next build` produced out of the Worker's own
 * assets and refuses writes. That is the whole requirement here — the documents
 * are markdown in the repository, so a deploy is the only thing that can change
 * them, and there is nothing to revalidate between deploys. It also needs no R2
 * bucket and no KV namespace, so it adds a binding to nothing and costs
 * nothing, which the KV and R2 adapters both would.
 *
 * The one thing it cannot serve is Next's composable cache (`use cache`), which
 * this application does not use. Reach for the R2 adapter if that changes, or
 * if a route ever needs genuine on-demand revalidation.
 */
export default defineCloudflareConfig({
  incrementalCache: staticAssetsIncrementalCache,
});

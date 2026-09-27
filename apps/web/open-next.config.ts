import { defineCloudflareConfig } from '@opennextjs/cloudflare';
import type { OpenNextConfig } from '@opennextjs/cloudflare';
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
 *
 * ── Why the build command is not the default ──
 * `npm run build` is what OpenNext runs anyway; the second half removes the
 * byte-identical copies Turbopack makes of the server chunk every API route
 * loads, before OpenNext bundles them. Without it the Worker carries twenty of
 * them — 3.1 MB of its gzipped size. `scripts/dedupe-server-chunks.mjs` says
 * why they exist and why removing them changes nothing at runtime. It runs from
 * this directory, which is where OpenNext runs the build command.
 *
 * `--skipNextBuild` skips it along with `next build`: bundling a `.next` that a
 * plain `next build` produced gives the fat Worker, and the bundle job's
 * duplicate check fails on it.
 */
const config: OpenNextConfig = {
  ...defineCloudflareConfig({
    incrementalCache: staticAssetsIncrementalCache,
  }),
  buildCommand: 'npm run build && node ../../scripts/dedupe-server-chunks.mjs',
};

export default config;

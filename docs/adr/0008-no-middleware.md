# 0008 — No middleware: route protection lives in the API layer

**Status:** Accepted
**Date:** 2026-08-11

## Context

The dashboard lives under `/app/**`. A visitor with no session should land on the sign-in
page rather than on a shell that renders, fetches, fails, and only then redirects.

The obvious tool is Next.js middleware — renamed to **Proxy** in Next 16. A `proxy.ts` doing
exactly this was written, and then removed. It cannot run on this stack.

## The constraint

Two facts that do not compose:

1. **Next 16 defaults Proxy to the Node.js runtime, and there is no way to opt out.** From
   `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`:

   > Proxy defaults to using the Node.js runtime. The `runtime` config option is not
   > available in Proxy files. Setting the `runtime` config option in Proxy will throw an
   > error.

   The version history in the same file records it: `v16.0.0 — Middleware is deprecated and
   renamed to Proxy. Proxy defaults to the Node.js runtime.`

2. **`@opennextjs/cloudflare` refuses to build a Node middleware.** In
   `dist/cli/build/build.js`:

   ```js
   if (useNodeMiddleware(options)) {
     logger.error("Node.js middleware is not currently supported. Consider switching to Edge Middleware.");
     process.exit(1);
   }
   ```

   `useNodeMiddleware()` returns false only when the build emitted an *edge* middleware
   entry — which, per (1), Next 16 will not do.

So the build fails, and no configuration fixes it. This was found by running the build, not
by reading ahead; it is exactly the class of breakage `AGENTS.md` warns about.

## Options

**A. Keep a Proxy file and pin to Next 15 semantics.** Rejected: pinning the framework to
avoid one redirect is a large tail wagging a very small dog, and Next 15's Node-middleware
support was itself new.

**B. Wait for OpenNext to support Node middleware.** Rejected as a *blocker*; it remains a
perfectly good reason to revisit this ADR later. It is not a reason to hold Phase 5.

**C. Drop middleware entirely and redirect from the API client.** Chosen.

## Decision

There is no middleware in xecret. Route protection is:

- **The real control:** every `/api/**` handler authenticates and authorises independently,
  through `authenticate()` and `can()`. This was already true and is unchanged.
- **The convenience:** `lib/api.ts` performs a full-document navigation to `/sign-in` when
  any request returns 401, carrying a `?next=` for the path it was on.

Next's own documentation argues for this arrangement independently of our constraint:

> A matcher change or a refactor that moves a Server Function to a different route can
> silently remove Proxy coverage. Always verify authentication and authorization inside each
> Server Function rather than relying on Proxy alone.

## Consequences

**Good**

- One place decides who may do what, and it is the place that can see the database.
- No matcher to drift out of sync with the route tree — the failure Next warns about is not
  available to us.
- One fewer component on the deploy path, and one fewer Next/OpenNext compatibility surface.

**Bad — state these plainly**

- A signed-out visitor navigating straight to `/app/playxoft/default/production` briefly sees
  the dashboard's loading skeleton before the redirect. It is a skeleton, not another
  tenant's data, but it is a worse first impression than an immediate bounce.
- The redirect depends on client-side JavaScript. With scripting disabled the visitor sees an
  empty shell and no redirect. Nothing is *disclosed* — the shell has no data in it, and
  every fetch it would make is a 401 — but it is a dead end rather than a signpost.
- A full-document navigation on 401 discards the router cache. That is deliberate (the cache
  was rendered for a session that no longer exists) but it is slower than a soft navigation.

**Revisit when** OpenNext supports Node middleware, or Next restores an edge Proxy runtime.
If it is restored, add it as a redirect only — never as a security boundary. Anything that
reads a cookie without consulting the database is guessing.

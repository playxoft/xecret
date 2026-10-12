#!/bin/sh
# Builds and deploys the Worker.
#
#   phase run -- sh scripts/deploy-web.sh production
#
# A script rather than an inline `sh -c`, because `phase run` re-joins its
# arguments through the shell and flattens nested quoting.
#
# `phase run` is how *this* repository puts the deploy-time variables in the
# environment, not something the script depends on. Any wrapper that exports
# them works — Doppler, a CI secret block, a sourced `.env` — and a self-hoster
# using one of those is in a supported configuration; ADR 0002 is what makes it
# so, because the deployed Worker reads nothing from any secret manager at
# runtime. Since sign-in became server-initiated
# (docs/adr/0010-workos-as-identity-provider.md) the build needs little from it
# either: the client bundle carries no identity-provider configuration, so
# `next build` inlines no secret, and what the wrapper mostly supplies is
# Cloudflare's credentials for the upload. What the script does insist on is the
# configuration that fails *quietly* — a build for a different deployment than
# the one being uploaded, and a deployment that does not name its identity
# provider. Hence the checks below rather than a sentence in a comment nobody
# reads.

set -eu

env_name="${1:-production}"
cd "$(dirname "$0")/../apps/web"

# The deploy step inspects the config through wrangler's *local* platform
# proxy, which refuses a Hyperdrive binding without a local stand-in. This is
# emulation plumbing only — nothing here is uploaded; the deployed Worker uses
# the real Hyperdrive binding. A placeholder satisfies it when DATABASE_URL is
# absent, because the proxy validates the variable's presence, not the value.
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="${DATABASE_URL:-postgres://placeholder:placeholder@localhost:5432/placeholder}"

# ── The build has to be told which deployment it is building for ──
#
# `lib/site.ts` bakes the deployment's origin into every prerendered page:
# canonical URLs, sitemap.xml, robots.txt's Host line, the JSON-LD `@id`. All of
# those are decided during `next build`, and `XECRET_PUBLIC_URL` in
# `wrangler.toml` is a *runtime* var — it is uploaded with the Worker and does
# not exist while the build runs. Nothing connected the two, so a staging deploy
# built with whatever happened to be in the shell and told crawlers its
# canonical was production.
#
# Read out of `wrangler.toml` for the environment being deployed, using
# wrangler's own config reader rather than a second copy of the values here:
# there is then one file naming each environment's host, and the origin the
# build writes into the HTML is the origin the Worker answers requests on
# because they were read from the same place. This overrides any value already
# in the environment on purpose — the Worker will run with wrangler's, so a
# build using a different one would be building for a deployment that is not
# about to exist.
wrangler_var() {
  WRANGLER_ENV="$env_name" WRANGLER_VAR="$1" node --input-type=module -e '
    import { unstable_readConfig } from "wrangler";

    const name = process.env.WRANGLER_VAR;
    const environment = process.env.WRANGLER_ENV;

    // Awaited although it is synchronous today. `@opennextjs/cloudflare` awaits
    // its own call to this function with the note that it "is sync as of
    // wrangler 4.60.0 but will eventually become async", and on the release
    // that flips it a missing `await` reads `.vars` off a Promise, gets
    // `undefined`, and exits 1 blaming a config file that is perfectly fine.
    // Awaiting a plain object costs a microtask and nothing else.
    const value = (await unstable_readConfig({ env: environment })).vars?.[name];

    if (typeof value !== "string" || value === "") {
      console.error(`wrangler.toml: env.${environment}.vars.${name} is missing or not a string`);
      process.exit(1);
    }

    process.stdout.write(value);
  '
}

XECRET_PUBLIC_URL="$(wrangler_var XECRET_PUBLIC_URL)"
XECRET_ENV="$(wrangler_var XECRET_ENV)"
export XECRET_PUBLIC_URL XECRET_ENV

# Printed with its provenance, for the reader who did not put it there. The
# values come out of a file that is committed to this repository, so a
# self-hoster who has not edited `env.$env_name.vars` is about to bake somebody
# else's origin into their canonical URLs, sitemap and robots.txt Host line.
# This line is the last chance to notice, and it names the file so that noticing
# leads somewhere.
echo "Building for $XECRET_ENV at $XECRET_PUBLIC_URL"
echo "  (from apps/web/wrangler.toml → env.$env_name.vars — stop now if that is not your deployment)"

# ── The deployment has to name its identity provider ──
#
# `WORKOS_CLIENT_ID` is a runtime var: the Worker reads it, the build never
# does, so nothing about building or uploading would notice it missing. A
# deployment without one is up, serves every page, and answers 503 to every
# sign-in — which is a deployment nobody can use, found by a user rather than by
# this script. `wrangler deploy` replaces the Worker's vars with exactly
# `env.$env_name.vars`, so if it is not in that table it will not be on the
# Worker, whatever the dashboard shows today.
#
# The shape is checked too. The id is public and belongs in the committed file;
# the WorkOS *secret* key, which starts `sk_`, is the value most likely to be
# pasted into the wrong field, and in this file it would be published.
#
# What this cannot check is that the id and the Worker's WORKOS_API_KEY secret
# come from the same WorkOS environment — the secret is not readable from here.
# `npm run check:env` and the deployment-check skill cover that pairing.
if ! WORKOS_CLIENT_ID="$(wrangler_var WORKOS_CLIENT_ID)"; then
  cat >&2 <<EOF
Refusing to build: apps/web/wrangler.toml declares no WORKOS_CLIENT_ID for
env.$env_name.

Every sign-in on the deployment would answer 503. Add the client id of the
WorkOS environment this deployment signs people in against to
[env.$env_name.vars] — the Production environment's for production, the
Staging environment's for anything else. It is not a secret; the API key is,
and that one belongs in \`wrangler secret put\`, not in the file.
EOF
  exit 1
fi

case "$WORKOS_CLIENT_ID" in
  client_*) ;;
  *)
    cat >&2 <<EOF
Refusing to build: env.$env_name.vars.WORKOS_CLIENT_ID in apps/web/wrangler.toml
is not a WorkOS client id (expected client_…).

If it is the API key (sk_…), it has been committed: rotate it in the WorkOS
dashboard before doing anything else, then put the client id here and the new
key in \`wrangler secret put WORKOS_API_KEY --env $env_name\`.
EOF
    exit 1
    ;;
esac

echo "  (signing in against WorkOS client $WORKOS_CLIENT_ID — its API key must be from the same WorkOS environment)"

# ── What `GET /api/version` will answer with ──
#
# Nothing in the tree knows the commit or the build time, and the Worker has no
# build environment to read at request time, so they are stamped in here and
# inlined by `next.config.ts`. A build that skips this script reports `unknown`
# for both, which is the truth: it did not come from a deploy.
#
# `--dirty` rather than a bare short SHA, because the commit is only an honest
# answer if the tree it was built from matched it. A deployment reporting
# `a1b2c3d-dirty` is telling whoever is debugging it that the source is not on
# any branch. `2>/dev/null || echo unknown` covers a build from a tarball with
# no `.git` — a self-hoster's perfectly ordinary case, not an error.
XECRET_BUILD_COMMIT="$(git describe --always --dirty --abbrev=7 2>/dev/null || echo unknown)"
XECRET_BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export XECRET_BUILD_COMMIT XECRET_BUILD_TIME

echo "  (build $XECRET_BUILD_COMMIT at $XECRET_BUILD_TIME)"

npx opennextjs-cloudflare build

# ── Before anything is uploaded ──
#
# The build collapses the byte-identical copies Turbopack makes of the server
# chunk every API route loads, and CI checks that it still does. A deploy from
# a laptop never passes through CI, so it checks for itself: if the copies are
# back, this stops here rather than publishing a Worker 3 MB heavier than the
# one CI measured.
node ../../scripts/check-duplicate-chunks.mjs

npx opennextjs-cloudflare deploy --env "$env_name"

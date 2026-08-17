#!/bin/sh
# Builds and deploys the Worker.
#
#   phase run -- sh scripts/deploy-web.sh production
#
# A script rather than an inline `sh -c`, because `phase run` re-joins its
# arguments through the shell and flattens nested quoting. Run under
# `phase run` so NEXT_PUBLIC_FIREBASE_CONFIG reaches the client bundle at
# build time — the deployed Worker itself reads nothing from Phase (ADR 0002).

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
# `wrangler.jsonc` is a *runtime* var — it is uploaded with the Worker and does
# not exist while the build runs. Nothing connected the two, so a staging deploy
# built with whatever happened to be in the shell and told crawlers its
# canonical was production.
#
# Read out of `wrangler.jsonc` for the environment being deployed, using
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
    const value = unstable_readConfig({ env: environment }).vars?.[name];

    if (typeof value !== "string" || value === "") {
      console.error(`wrangler.jsonc: env.${environment}.vars.${name} is missing or not a string`);
      process.exit(1);
    }

    process.stdout.write(value);
  '
}

XECRET_PUBLIC_URL="$(wrangler_var XECRET_PUBLIC_URL)"
XECRET_ENV="$(wrangler_var XECRET_ENV)"
export XECRET_PUBLIC_URL XECRET_ENV

echo "Building for $XECRET_ENV at $XECRET_PUBLIC_URL"

npx opennextjs-cloudflare build
npx opennextjs-cloudflare deploy --env "$env_name"

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

npx opennextjs-cloudflare build
npx opennextjs-cloudflare deploy --env "$env_name"

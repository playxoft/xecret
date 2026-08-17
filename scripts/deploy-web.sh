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
# runtime. What the script does insist on is that the variables are actually
# there when it runs, since the ones that matter are consumed during `next
# build` and every one of them fails *quietly* when absent. Hence the checks
# below rather than a sentence in a comment nobody reads.

set -eu

env_name="${1:-production}"
cd "$(dirname "$0")/../apps/web"

# ── The client bundle is built here, so the client's configuration has to be ──
#
# `next build` inlines NEXT_PUBLIC_FIREBASE_CONFIG into the bundle, and
# `next.config.ts` additionally derives the Content-Security-Policy from it:
# `frame-src` and `connect-src` have to name this deployment's own Firebase
# `authDomain`, because `signInWithPopup` embeds a hidden iframe on that host to
# hear the answer back (see lib/csp.ts).
#
# A build that cannot see the variable does not fail. `firebaseAuthOrigin()`
# returns null, the policy is assembled without those entries, and the
# deployment ships — with a header that blocks its own sign-in frame. The
# symptom is every Google sign-in failing with `auth/network-request-failed`, a
# message that sends whoever is debugging it looking for a network outage. That
# is a whole deployment nobody can log in to, found by a user rather than by
# this script, so it is checked before anything is built.
if [ -z "${NEXT_PUBLIC_FIREBASE_CONFIG:-}" ]; then
  cat >&2 <<EOF
NEXT_PUBLIC_FIREBASE_CONFIG is not set in this environment.

It is inlined into the client bundle at build time, and the Content-Security-
Policy's frame-src and connect-src are derived from its authDomain. Building
without it produces a deployment whose own sign-in popup is blocked by its own
CSP, and nothing about the build or the deploy reports that.

Run this under whatever populates your deploy-time environment. In this
repository that is Phase.dev:

    phase run -- sh $0 $env_name
EOF
  exit 1
fi

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

    // Awaited although it is synchronous today. `@opennextjs/cloudflare` awaits
    // its own call to this function with the note that it "is sync as of
    // wrangler 4.60.0 but will eventually become async", and on the release
    // that flips it a missing `await` reads `.vars` off a Promise, gets
    // `undefined`, and exits 1 blaming a config file that is perfectly fine.
    // Awaiting a plain object costs a microtask and nothing else.
    const value = (await unstable_readConfig({ env: environment })).vars?.[name];

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

# Printed with its provenance, for the reader who did not put it there. The
# values come out of a file that is committed to this repository, so a
# self-hoster who has not edited `env.$env_name.vars` is about to bake somebody
# else's origin into their canonical URLs, sitemap and robots.txt Host line.
# This line is the last chance to notice, and it names the file so that noticing
# leads somewhere.
echo "Building for $XECRET_ENV at $XECRET_PUBLIC_URL"
echo "  (from apps/web/wrangler.jsonc → env.$env_name.vars — stop now if that is not your deployment)"

npx opennextjs-cloudflare build
npx opennextjs-cloudflare deploy --env "$env_name"

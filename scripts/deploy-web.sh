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

# ── The build-time secrets have to belong to the environment being deployed ──
#
# `NEXT_PUBLIC_FIREBASE_CONFIG` arrives from whatever populates the environment,
# and nothing about that wrapper is tied to `$env_name`. `phase run` resolves
# `.phase.json`'s `defaultEnv`, which is `Development`; a self-hoster's wrapper
# has its own default. So the ordinary mistake is not a missing variable, it is
# a *present* one from the wrong environment — and it is invisible, because the
# build succeeds and the deployment looks fine until sign-in fails against a
# Firebase project that never issued the token.
#
# `env.$env_name.vars.FIREBASE_PROJECT_ID` is what the deployed Worker will
# verify tokens against, and the client config names the project the browser
# will get them from. If those two disagree, every sign-in on the deployment is
# rejected. Comparing them here is the only point where both are in hand.
#
# Skipped when the target environment declares no `FIREBASE_PROJECT_ID` —
# `env.staging` currently does not — because a comparison against nothing would
# fail every deploy of an environment that has simply not been filled in yet.
expected_project="$(wrangler_var FIREBASE_PROJECT_ID 2>/dev/null || true)"
if [ -n "$expected_project" ]; then
  building_project="$(
    printf '%s' "$NEXT_PUBLIC_FIREBASE_CONFIG" |
      node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).projectId??""))}catch{process.stdout.write("")}})'
  )"

  if [ "$building_project" != "$expected_project" ]; then
    cat >&2 <<EOF
Refusing to build: the Firebase project in this environment is not the one
env.$env_name deploys against.

  NEXT_PUBLIC_FIREBASE_CONFIG projectId : ${building_project:-<unparseable>}
  wrangler env.$env_name.FIREBASE_PROJECT_ID : $expected_project

The client config almost certainly came from the wrong environment of whatever
supplies it. With Phase, the environment is chosen explicitly:

    phase run --env Production -- sh $0 $env_name

Building anyway would deploy a site whose browser gets tokens from one Firebase
project while the Worker verifies them against another, so every sign-in is
rejected — and nothing about the build or the deploy would report it.
EOF
    exit 1
  fi
fi

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
npx opennextjs-cloudflare deploy --env "$env_name"

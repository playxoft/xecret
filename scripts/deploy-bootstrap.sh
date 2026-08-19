#!/bin/sh
# One-time creation of the Cloudflare resources the production Worker binds.
#
#   phase run -- sh scripts/deploy-bootstrap.sh
#
# Creates, if missing:
#   1. Hyperdrive `xecret-db` — from DATABASE_URL, converted to Neon's DIRECT
#      endpoint (the `-pooler` host is pgbouncer; Hyperdrive pools itself, and
#      stacking the two breaks prepared statements).
#   2. The XECRET_ROOT_KEYS secret in the account's default Secrets Store —
#      value piped on stdin, never in argv (ADR 0002: Phase.dev is the source
#      of truth, Cloudflare serves the runtime copy).
#   3. KV namespace JWKS_CACHE — Google's signing keys, so token verification
#      costs no outgoing fetch.
#
# Idempotent: anything that already exists is reported, not recreated. Output
# is the three ids to paste into apps/web/wrangler.toml — ids are plain
# configuration, not secrets. No credential is ever printed.

set -eu

say() { printf '%s\n' "$*" >&2; }

[ -n "${DATABASE_URL:-}" ] || { say "DATABASE_URL is not set — run under: phase run -- sh $0"; exit 1; }
[ -n "${XECRET_ROOT_KEYS:-}" ] || { say "XECRET_ROOT_KEYS is not set — run under: phase run -- sh $0"; exit 1; }

# Strips the box-drawing table wrangler prints down to one trimmed cell.
cell() { awk -F'│' -v row="$1" -v col="$2" '$0 ~ row { gsub(/^[ \t]+|[ \t]+$/, "", $col); print $col; exit }'; }

# ── 1. Hyperdrive ────────────────────────────────────────────────────────────
if npx wrangler hyperdrive list 2>/dev/null | grep -q ' xecret-db '; then
  say "hyperdrive: xecret-db already exists"
else
  direct=$(node -e 'const u = new URL(process.env.DATABASE_URL); u.hostname = u.hostname.replace("-pooler", ""); process.stdout.write(u.toString())')
  say "hyperdrive: creating xecret-db (direct Neon endpoint)…"
  npx wrangler hyperdrive create xecret-db --connection-string="$direct" >/dev/null
fi
HYPERDRIVE_ID=$(npx wrangler hyperdrive list 2>/dev/null | cell ' xecret-db ' 2)

# ── 2. Root key → Secrets Store ──────────────────────────────────────────────
STORE_ID=$(npx wrangler secrets-store store list --remote 2>/dev/null | cell 'default_secrets_store' 3)
[ -n "$STORE_ID" ] || { say "could not find the default secrets store"; exit 1; }

if npx wrangler secrets-store secret list "$STORE_ID" --remote 2>/dev/null | grep -q ' XECRET_ROOT_KEYS '; then
  say "secrets store: XECRET_ROOT_KEYS already present"
else
  say "secrets store: pushing XECRET_ROOT_KEYS…"
  printf '%s' "$XECRET_ROOT_KEYS" |
    npx wrangler secrets-store secret create "$STORE_ID" \
      --name XECRET_ROOT_KEYS --scopes workers --remote >/dev/null
fi

# ── 3. JWKS cache ────────────────────────────────────────────────────────────
KV_ID=$(npx wrangler kv namespace list 2>/dev/null | node -e '
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    const ns = JSON.parse(raw).find((n) => n.title.includes("JWKS_CACHE"));
    if (ns) process.stdout.write(ns.id);
  });
')
if [ -z "$KV_ID" ]; then
  say "kv: creating JWKS_CACHE…"
  npx wrangler kv namespace create JWKS_CACHE >/dev/null
  KV_ID=$(npx wrangler kv namespace list 2>/dev/null | node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      const ns = JSON.parse(raw).find((n) => n.title.includes("JWKS_CACHE"));
      if (ns) process.stdout.write(ns.id);
    });
  ')
else
  say "kv: JWKS_CACHE already exists"
fi

# ── Result — paste these into apps/web/wrangler.toml ───────────────────────
echo "HYPERDRIVE_ID=$HYPERDRIVE_ID"
echo "STORE_ID=$STORE_ID"
echo "KV_ID=$KV_ID"

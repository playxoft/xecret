# xecret CLI

The xecret command-line interface. Written in Go for a single static binary with
no runtime dependency — see [ADR 0004](../docs/adr/0004-cli-language-go.md).

> **Licence:** this directory is **MIT**, unlike the rest of the repository which
> is AGPL-3.0. The CLI is embedded in users' Docker images and CI pipelines, where
> a copyleft licence would be a blocker. See [ADR 0007](../docs/adr/0007-licensing.md).

## Status

**Phase 8 — the full command set plus CI support.** Every endpoint the API
offers a CLI-shaped credential is reachable from here; the two that are not are
listed below and are browser-only server-side. In CI, set `XECRET_TOKEN=xst_…`
and nothing else: the token's own pinned scope answers which organisation,
project and environment to use, no login flow runs, no keychain is touched,
and no offline cache is ever written — a runner is ephemeral and a cache that
outlived a token's revocation would be a revocation bypass. `--project` /
`--environment` flags and `.xecret.yaml` still win when present; the server
enforces the pin either way.

```bash
XECRET_TOKEN=xst_... xecret run -- npm run build
XECRET_TOKEN=xst_... xecret pull --format env > .env   # legacy pipelines; stderr warns
```

```bash
xecret login                     # browser consent + PKCE; token → OS keychain
xecret init                      # pick project + environment; writes .xecret.yaml
xecret run -- npm run dev        # inject secrets into a child process
xecret secrets list              # masked listing
xecret secrets get NAME --plain  # reveal one value (audited server-side)
printf '%s' "$V" | xecret secrets set NAME
xecret import .env               # server-side parse + plan; --dry-run previews
xecret pull --format env         # print every secret, with a warning
xecret export -o .env            # the same, to a 0600 file, audited as a copy
xecret whoami / logout / cache clear
```

Version history, resources and administration:

```bash
xecret secrets versions NAME             # history — metadata only, deliberately
xecret secrets get NAME --version 3 --plain
xecret secrets restore NAME --version 3  # re-append an old value; history intact
xecret secrets annotate NAME --note "…"  # metadata; appends no version

xecret orgs / orgs use SLUG              # which organisation commands address
xecret projects create "Checkout API"    # + its default environments and keys
xecret environments create "PR 412" --slug pr-412
xecret audit --action secret.revealed --since 7d
xecret members
xecret tokens list / tokens revoke ID --kind service

xecret completion zsh                    # bash | zsh | fish
xecret doctor                            # what this machine is set up to do
xecret upgrade                           # is a newer release published?
```

Two things are deliberately *not* here, and the commands say so rather than
letting the server answer with a 403:

- **Minting a service token.** `POST …/tokens/service` requires a browser
  session: a token that could mint another token turns one leaked credential
  into a permanent foothold, so the chain has to start with a person.
- **Inviting or suspending members.** Same reason, same server-side rule.
  `xecret members` reads; it does not write.

## How authentication works

`xecret login` is an OAuth-style loopback flow (RFC 8252) with PKCE against the
xecret server — never Firebase directly. The browser shows a consent screen
naming this device; approval sends a one-time code to a listener on
`127.0.0.1`; the code plus the in-memory PKCE verifier are exchanged for a
`xct_` token, which is stored in the **OS keychain** (macOS Keychain, Windows
Credential Manager, Linux Secret Service). Machines without a keyring fall
back to a `0600` file — with a visible warning, never silently.

## Offline behaviour

A successful `xecret run` writes an **encrypted cache** (AES-256-GCM, key in
the keychain, files `0600` under `~/.xecret/cache/`). When the API is
unreachable, `run` answers from that cache with a loud warning showing its
age. `--offline` forces it; `--no-cache` disables it; `logout` and
`cache clear` destroy the files *and* the key.

The cache only ever stands in for **unavailability** (network failure, 5xx).
A 401/403/404 never falls back — a revoked token that kept working out of a
local file would make revocation meaningless.

## Development

```bash
go build ./cmd/xecret     # build
go test ./...             # test
go vet ./...              # lint
./xecret version          # run

# point the CLI at a local server:
XECRET_API_URL=http://localhost:3000 ./xecret login
```

From the repository root: `npm run cli:build`, `npm run cli:test`.

## Two rules that hold everywhere

1. **A secret value never leaves the process boundary incidentally.** Values go
   into the child process environment and nowhere else. The deliberate
   exceptions — `pull`, `export` and `secrets get [--version N] --plain` — exist
   to produce a value on request, write it raw to stdout (or, for `export`, to
   one named `0600` file), and warn on stderr.
2. **Credentials live in the OS keychain**, never in a dotfile a user might
   commit or sync to cloud storage. The file fallback is `0600` and warns
   visibly. `.xecret.yaml` holds a project and environment slug — never
   secrets — and is safe to commit.

## Layout

```
cli/
├── cmd/xecret/          entry point + one file per command
├── npm/                 the npm distribution — wrapper, resolver, publisher
└── internal/
    ├── api/             HTTP client, typed endpoints, error mapping, retries
    ├── auth/            PKCE, loopback listener, browser open
    ├── buildinfo/       version metadata (ldflags)
    ├── cache/           encrypted offline cache (AES-256-GCM, AAD-bound)
    ├── config/          .xecret.yaml discovery + read/write
    ├── cred/            credential persistence on top of the keyring
    ├── keyring/         OS credential manager + announced 0600 fallback
    ├── output/          tty vs --json, NO_COLOR, tables
    └── run/             process spawn, env injection, signal forwarding
```

## Release

Two stages, because the registry half cannot be undone.

**On a `v*` tag.** GoReleaser builds darwin/linux/windows × amd64/arm64,
publishes archives with SHA-256 checksums and cosign signatures, pushes the
Docker image, and pushes a Homebrew formula to `playxoft/homebrew-tap`. The
GitHub release is left as a **draft** for a human to read.

**On publishing that draft.** The `npm` job downloads the release's own
archives, verifies each against the signed `checksums.txt`, and publishes seven
packages: `xecret` plus one per platform. npm has no draft state and no
meaningful undo, so it waits for the same gate everything else does.

`scripts/install-cli.sh` is the `curl | sh` installer (it verifies the checksum
before unpacking).

### The npm distribution

`cli/npm/` holds a wrapper package with six platform packages as
`optionalDependencies` — the esbuild shape. No postinstall, nothing downloaded
at install time: `npm ci --ignore-scripts` is a reasonable thing to run, and the
binary belongs under npm's own integrity hash rather than behind a fetch we
would have to verify ourselves. The reasoning is written out at the top of
`cli/npm/lib/resolve.js`.

```bash
cd cli/npm && node --test            # the resolver, and its drift checks
node publish.mjs --version v1.2.3 --archives /tmp/release --dry-run
```

`lib/resolve.test.js` reads `.goreleaser.yaml` and `publish.mjs` and asserts all
three agree on the platform list — a target added to the build matrix and
forgotten in one of them is a machine that installs xecret and is told it has no
build.

Secrets to set once, before the first release:

| Secret | For |
|---|---|
| `HOMEBREW_TAP_GITHUB_TOKEN` | A fine-grained PAT with `contents:write` on `playxoft/homebrew-tap`. |
| `NPM_TOKEN` | An npm automation token for the account that owns `xecret`. |

> **Do not distribute binaries until the permanent domain is locked** — the
> API origin is compiled into every copy (`internal/buildinfo`), and changing
> it later breaks every installed CLI. See §7 of the plan.

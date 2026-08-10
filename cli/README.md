# xecret CLI

The xecret command-line interface. Written in Go for a single static binary with
no runtime dependency — see [ADR 0004](../docs/adr/0004-cli-language-go.md).

> **Licence:** this directory is **MIT**, unlike the rest of the repository which
> is AGPL-3.0. The CLI is embedded in users' Docker images and CI pipelines, where
> a copyleft licence would be a blocker. See [ADR 0007](../docs/adr/0007-licensing.md).

## Status

**Phase 1 — skeleton only.** `version` and `help` work. Real commands land in
Phase 6 (login, projects, secrets, pull, run) and Phase 8 (CI service tokens).

## Development

```bash
go build ./cmd/xecret     # build
go test ./...             # test
go vet ./...              # lint
./xecret version          # run
```

From the repository root: `npm run cli:build`, `npm run cli:test`.

## Two rules that hold from the first commit

1. **A secret value never leaves the process boundary.** Not to stdout, stderr, a
   log, a temporary file, or a process argument. Values go into the child
   process environment and nowhere else.
2. **Credentials live in the OS keychain** — macOS Keychain, Windows Credential
   Manager, Linux Secret Service — never in a dotfile a user might commit or
   sync to cloud storage. The file fallback is `0600` and warns visibly.

## Planned layout

```
cli/
├── cmd/xecret/          entry point
└── internal/
    ├── api/             HTTP client, retries, error mapping
    ├── auth/            PKCE loopback flow, token refresh
    ├── buildinfo/       version metadata          ← exists
    ├── cache/           encrypted offline cache
    ├── config/          .xecret.yaml discovery
    ├── importer/        .env / JSON / YAML parsing
    ├── keyring/         OS credential storage
    ├── output/          tty vs --json rendering
    └── run/             process spawn, env injection, signal forwarding
```

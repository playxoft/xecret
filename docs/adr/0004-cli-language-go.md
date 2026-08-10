# 0004 — Go for the CLI

**Status:** Accepted
**Date:** 2026-08-10

## Context

The CLI is the product's primary interface. `xecret run -- npm run dev` is the moment a user
decides whether they like xecret. It must start instantly, install trivially, and work
identically on a developer's laptop and inside a minimal CI container.

CI is an explicit first-class use case, which means the binary is frequently downloaded into
a fresh container on every pipeline run.

## Options considered

### A. Go
- ✅ Single static binary, no runtime, no shared libraries.
- ✅ Trivial cross-compilation to darwin/linux/windows × amd64/arm64 from one machine.
- ✅ ~5–15 ms startup. Small download (~8–15 MB).
- ✅ Works in `alpine`, `distroless`, and scratch-based CI images with no dependencies.
- ✅ Excellent stdlib for HTTP, process spawning, and signal handling — the three things this
  CLI actually does.
- ✅ Mature ecosystem for exactly this shape of tool (cobra, goreleaser, keyring).
- ❌ A second language in the repo.
- ❌ More verbose than the alternatives.

### B. Rust
- ✅ Same single-binary and startup advantages. Strongest memory-safety story.
- ✅ Genuine appeal for a security tool.
- ❌ Slower to write; longer compile times.
- ❌ Cross-compilation is meaningfully more painful than Go's.
- ❌ Smaller pool of contributors for an open-source CLI.
- The safety advantage is largely theoretical here: this CLI does HTTP calls and spawns a
  process. It is not parsing untrusted binary formats.

### C. TypeScript / Node
- ✅ One language across the repo; shared types with the API for free.
- ❌ **Requires Node on the user's machine** — unacceptable when the target includes Go, Rust,
  Python, and Java developers, plus minimal CI containers.
- ❌ ~100 ms+ startup, felt on every single `xecret run`.
- ❌ Bundling to a standalone binary (`pkg`, `bun build --compile`) produces 40–90 MB
  artifacts, downloaded on every CI run.
- ❌ `node_modules` supply-chain surface in a security product's critical path.

## Decision

**Go.**

The deciding factor is CI. A CI runner downloads this binary on every pipeline execution;
size, startup time, and zero runtime dependencies compound there in a way they do not on a
laptop. Go wins that comparison decisively, and its cross-compilation story means one
release job produces every platform artifact.

Rust would be a defensible choice and is the runner-up. TypeScript is disqualified by the
Node requirement alone.

Module path: `github.com/playxoft/xecret/cli`

Planned dependencies, kept deliberately few:
- `spf13/cobra` — command structure
- `zalando/go-keyring` — OS credential storage
- `goreleaser` — release automation (build-time only)
- stdlib for everything else

## Consequences

### Positive
- `curl | sh`, Homebrew, `go install`, and a ~10 MB container layer all work.
- Instant startup keeps `xecret run` feeling like a native part of the shell.
- No runtime for users to install or for us to support.

### Negative
- Two languages to maintain. The API contract between Go and TypeScript is not
  compile-time checked — it is enforced by integration tests against a running API and by
  shared JSON Schema fixtures in `packages/core/validation`.
- Contributors comfortable in TypeScript may not be comfortable in Go. Mitigated by keeping
  the CLI small and conventional.

### Neutral
- The CLI is MIT-licensed while the server is AGPL-3.0 — see [0007](0007-licensing.md).

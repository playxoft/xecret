# 0005 — Single monorepo for web, CLI, and shared packages

**Status:** Accepted
**Date:** 2026-08-10

## Context

The project has three deliverables that must stay in sync: a Next.js application on
Cloudflare Workers, a Go CLI, and shared logic (crypto, authorization, validation schemas).

The CLI and the API share a wire contract that will change frequently in the first months.

## Options considered

### A. Single monorepo
- ✅ A change to the API contract and the CLI that consumes it lands in **one atomic commit**.
- ✅ One issue tracker, one CI configuration, one release process, one place to file a bug.
- ✅ Contributors clone once and see the whole system.
- ❌ Mixed-language tooling in one repository.
- ❌ Repository grows large over time.

### B. Separate repositories (`xecret-web`, `xecret-cli`)
- ✅ Clean per-language tooling.
- ✅ CLI can be permissively licensed without any ambiguity.
- ❌ Every contract change becomes a cross-repo dance with version pinning.
- ❌ Two issue trackers; users guess wrong about where to report.
- ❌ Integration testing requires checking out both at compatible commits.

### C. Monorepo now, split later if needed
Same as A, plus an explicit acknowledgement that extraction stays possible because `cli/` is
already a self-contained Go module with its own licence and release pipeline.

## Decision

**Option C — monorepo, structured so extraction is cheap.**

```
xecret/
├── apps/web/         Next.js on Cloudflare Workers        (AGPL-3.0)
├── cli/              Go module, self-contained            (MIT)
├── packages/
│   ├── core/         crypto, authz, audit, validation     (AGPL-3.0)
│   └── db/           Drizzle schema + migrations          (AGPL-3.0)
├── docs/  examples/  scripts/
```

npm workspaces for the TypeScript side. `cli/` is an ordinary Go module in a subdirectory —
`go build ./...` and GoReleaser both handle this natively with no special configuration.

**`packages/core` must not import Cloudflare bindings, `next`, or any runtime-specific API.**
Crypto and authorization are the two components most likely to be reviewed by an external
security auditor and most in need of exhaustive unit tests. Runtime coupling would make both
harder. Enforced by an ESLint rule.

## Consequences

### Positive
- Contract changes are atomic and reviewable in one diff.
- One `git clone` gives a contributor the entire system.
- Shared validation schemas have a single home.

### Negative
- CI must be path-filtered so a CLI change does not run the whole web test suite, and vice
  versa.
- Mixed-language repositories confuse some tooling defaults (IDE indexing, dependency
  scanners). Acceptable.
- Two licences in one repository requires clear per-directory `LICENSE` files and an
  unambiguous statement in the root `README`.

### Revisit when
The CLI develops an independent contributor community and release cadence, or the repository
becomes unwieldy. `cli/` can be extracted with `git subtree split`, preserving its history.

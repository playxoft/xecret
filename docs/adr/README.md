# Architecture Decision Records

Each ADR captures one significant decision: the context, the options considered, what was
chosen, and what it costs us.

**Rules**

- An ADR is immutable once `Accepted`. To change a decision, write a new ADR that supersedes it.
- Every ADR states its **Consequences**, including the bad ones. An ADR with no downsides
  listed has not been thought about hard enough.
- Link to ADRs from code comments where a decision is non-obvious.

| # | Title | Status |
|---|---|---|
| [0001](0001-trust-model.md) | Server-side envelope encryption over end-to-end | Accepted |
| [0002](0002-root-key-custody.md) | Root key custody: Phase.dev → Cloudflare Secrets Store | Accepted |
| [0003](0003-firebase-as-identity-provider.md) | Firebase Auth as identity provider only | Accepted |
| [0004](0004-cli-language-go.md) | Go for the CLI | Accepted |
| [0005](0005-monorepo.md) | Single monorepo for web, CLI and packages | Accepted |
| [0006](0006-database-access.md) | Neon + Hyperdrive + Drizzle | Accepted |
| [0007](0007-licensing.md) | AGPL-3.0 server, MIT CLI, CLA required | Accepted |
| [0008](0008-no-middleware.md) | No middleware; route protection lives in the API layer | Accepted |

## Template

```markdown
# NNNN — Title

**Status:** Proposed | Accepted | Superseded by [NNNN](...)
**Date:** YYYY-MM-DD

## Context
What forces are at play? What makes this decision necessary?

## Options considered
Each option with its honest pros and cons.

## Decision
What we chose.

## Consequences
### Positive
### Negative
### Neutral / revisit when
```

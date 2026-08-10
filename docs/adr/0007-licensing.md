# 0007 — AGPL-3.0 for the server, MIT for the CLI, CLA required

**Status:** Accepted
**Date:** 2026-08-10

## Context

xecret is open source. Two goals are in tension:

1. **Trust.** People are being asked to hand us their production credentials. A secret
   manager that cannot be independently audited does not deserve that trust, and the security
   community treats "source available" with noticeably more suspicion than OSI-approved open
   source.
2. **Protection.** If someone forks xecret, improves it, and runs it as a competing service,
   the improvements should come back to the project.

## Options considered

| Licence | Modify + deploy → must publish? | Blocks competing SaaS? | OSI open source? | Notable users |
|---|---|---|---|---|
| MIT / Apache-2.0 | No | No | Yes | most libraries |
| **AGPL-3.0** | **Yes** | No | **Yes** | Grafana, Mattermost, Cal.com |
| BSL 1.1 | n/a | **Yes** | No | HashiCorp, MariaDB |
| FSL | n/a | **Yes** | No | Sentry |
| Elastic v2 | n/a | **Yes** | No | Elasticsearch |

**AGPL-3.0** closes the "SaaS loophole" in GPL: providing modified software over a network
counts as distribution, so modifications must be published.

**BSL/FSL** go further and forbid competing commercial services outright — but they are not
open source, may not be described as such, and provoke real backlash. HashiCorp's move to BSL
produced the OpenTofu fork within weeks.

## Decision

**A split licence, plus a CLA.**

| Component | Licence | Reason |
|---|---|---|
| `apps/web`, `packages/*` | **AGPL-3.0-only** | Delivers the stated goal: fork, modify, run as a service → publish your changes. Keeps xecret honestly OSI open source, which is a security feature for this product. |
| `cli/`, future client SDKs | **MIT** | The CLI is embedded in customers' Docker images and CI pipelines. AGPL there triggers corporate legal bans and would suppress exactly the adoption the CLI exists to drive. This split is standard practice. |
| Contributions | **CLA required** | Contributors assign the rights needed for us to relicense. |

The CLA is the load-bearing part and the one most often skipped. Without it, once external
contributors exist, the licence can **never** be changed — not to BSL, not to a dual
commercial licence, not at all. With it, those options stay open.

## Consequences

### Positive
- xecret can accurately be called open source, and the code can be audited by anyone.
- Modified network deployments must publish their changes.
- The CLI is unencumbered wherever it needs to run.
- A commercial licence can be sold to organisations that cannot accept AGPL.

### Negative
- **AGPL does not stop someone running an *unmodified* copy as a competing service.** Only
  BSL/FSL do that. This is a deliberate trade: openness now, with the CLA preserving the
  ability to change course.
- Some enterprises ban AGPL software outright, which will cost some self-hosted adoption. The
  MIT CLI limits the damage, since that is the component that lands inside their
  infrastructure.
- A CLA adds friction to first-time contributions. Mitigated with an automated CLA bot
  (single click on the pull request).

### Implementation
- `/LICENSE` — AGPL-3.0-only full text
- `/cli/LICENSE` — MIT full text
- Root `README.md` states the split unambiguously, above the fold
- `package.json` files declare matching SPDX identifiers; `cli/go.mod` accompanied by its own
  `LICENSE`
- CLA bot configured before the repository is made public

### Revisit when
A competitor runs an unmodified xecret as a commercial service at meaningful scale. At that
point the CLA makes an FSL or BSL migration legally possible — expect community backlash and
budget for it.

# Contributing to xecret

Thanks for wanting to help. This document is short on ceremony and specific
about the things that actually matter in a security product.

## Before anything else

**Found a security vulnerability?** Do not open an issue.
Email **security@playxoft.com** — see [SECURITY.md](SECURITY.md).

## Getting set up

```bash
git clone https://github.com/playxoft/xecret.git
cd xecret
npm install

phase run -- npm run dev     # secrets come from Phase.dev, not a .env file
```

Requires Node ≥ 20.9 and Go ≥ 1.25.

Before pushing:

```bash
npm run verify     # format, lint, typecheck, test
npm run cli:test   # if you touched cli/
```

## The CLA

Every contributor signs a Contributor Licence Agreement, once. Open a pull
request and a bot will ask you in the thread; you reply with one line and it
never asks again. Bot accounts are exempt.

We ask because without it the licence could never be changed once external
contributions exist — every contributor would have to be found and agree. That
would remove our ability to respond if the project's licensing needs change. It
is not about taking your work: you keep your copyright, and the reasoning,
including what it costs you, is in [CLA.md](CLA.md) and
[ADR 0007](docs/adr/0007-licensing.md).

## Non-negotiable rules

These are not style preferences. A pull request that breaks one of these will be
asked to change, however good the rest of it is.

1. **Never invent cryptography.** Web Crypto primitives only. No hand-rolled
   constructions, no clever optimisations of a standard algorithm.
2. **A secret value never enters a log, an error message, a URL, an audit
   record, an analytics event, or client-side state.** If you are unsure whether
   a code path can reach a log, assume it can.
3. **Every protected route calls the one authorization function.** Do not write
   a bespoke permission check, however small. Cross-tenant access is the most
   likely real breach (threat T2) and one function is what makes it testable.
4. **Never trust an ID from the client.** `projectId`, `orgId`, `environmentId`
   from a request body or URL are inputs to an ownership check, never a
   shortcut past one.
5. **No dependency that cannot run on Cloudflare Workers.** Prefer Web APIs.
   `firebase-admin` is blocked by lint rule and is not up for discussion — see
   [ADR 0003](docs/adr/0003-firebase-as-identity-provider.md).
6. **Security-relevant changes need a test that fails without the fix.**

## Architecture decisions

Significant decisions live in [`docs/adr/`](docs/adr/). If you are proposing a
change that contradicts one, write a new ADR that supersedes it rather than
quietly diverging — an ADR is immutable once accepted.

If you are unsure whether something is "significant": if reversing it in six
months would be expensive, it is.

## Pull requests

- Branch from `main`, named `feat/…`, `fix/…`, or `docs/…`.
- [Conventional Commits](https://www.conventionalcommits.org/) — this drives the
  changelog.
- Describe *why*, not just *what*. The diff already shows what.
- Keep them focused. A 2,000-line PR touching six areas will sit unreviewed, and
  in a security product an unreviewed merge is worse than a slow one.
- Note explicitly if your change touches crypto, authorization, session
  handling, or audit logging so it gets the review attention it needs.

## Tests

| Area | Expectation |
|---|---|
| `packages/core/crypto` | ≥95% coverage, including tamper and rotation cases |
| `packages/core/authz` | ≥95% coverage, including the cross-tenant matrix |
| Everything else | Test the behaviour you would be embarrassed to break |

Write the test that fails first. For authorization work, that means a test where
a member of org A tries to reach org B's resource and must receive 404.

## Good first issues

Look for the `good first issue` label. Documentation improvements, CLI error
message quality, and test coverage gaps are genuinely valuable and a good way to
get familiar with the codebase.

## Code of conduct

Be decent. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

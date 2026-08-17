---
title: Your CI pipeline is the softest target you own: a practical guide to secrets in CI/CD
description: CI holds production credentials, runs code from pull requests, and writes logs half the company can read. The failure modes that leak secrets, and the fixes.
keywords: [CI/CD secrets management, GitHub Actions secrets, pipeline security, service token, secure build pipeline]
published: 2026-07-15
author: The xecret team
role: Playxoft
category: Engineering
---

An attacker who gets your source code gets your source code. An attacker who
gets your pipeline gets your source code, your registry, your cloud account,
your deployment credentials, and a scheduled job that will run whatever they
write. CI is where every credential in the organisation eventually meets,
because CI is the one machine that has to talk to everything.

## Why CI concentrates risk

Three properties make a build runner a worse place to keep a secret than a
laptop, and they are all properties you deliberately chose.

**It holds production credentials by design.** A deploy job cannot deploy
without them. There is no configuration that removes this — the whole point of
the job is to act with authority in production, unattended, at three in the
morning if the schedule says so.

**It executes code it has not read.** Every pull request is an invitation to run
a stranger's `package.json` scripts, their new test file, their added build
step. On a public repository, "a stranger" is literal. On a private one it is
still every contractor, every intern and every compromised laptop with a push
token.

**Its output is read by more people than its secrets are.** Access to a
repository's secret store is usually restricted to admins. Access to build logs
is usually granted to everyone who can see the repository, and the retention is
generous. The secret is behind an access control; the log line that contains
the secret frequently is not.

Put together: the machine with the most authority runs the least reviewed code
and produces the most widely readable output. That is the shape of the problem.

## Five specific ways a pipeline leaks

### A fork pull request that reaches repository secrets

The dangerous trigger is the one that runs with the *base* repository's
permissions against the *head* repository's code. On GitHub Actions that is
`pull_request_target`; other systems have their own version of the same idea,
usually introduced so that a workflow can label or comment on a fork's PR.

The moment a workflow using that trigger checks out
`github.event.pull_request.head.sha` and runs anything from it — a build, a
test, a lint step that loads a config file — a stranger's code is executing with
your secrets in scope. It does not need to print them. It can post them
somewhere.

Use the ordinary `pull_request` trigger, which gives a fork's build no access to
your secrets, and require a maintainer's approval before any secret-bearing job
runs.

### The step that prints the environment

`printenv`. `set -x`. `npm config list`. A verbose Docker build. A test harness
that dumps context on failure. A crash reporter configured in CI as it is in
production.

Nobody adds these on purpose. They get added during a Friday afternoon
debugging session and then stay, because the pipeline went green and nobody
reads a green log.

### A third-party action pinned to a mutable tag

`uses: some-org/some-action@v3` is a promise from a stranger that `v3` will
still mean today what it meant when you added it. A tag is a pointer. It can be
moved to any commit at any time by anyone who can push to that repository, and
the compromise of one popular action's repository is a supply chain event that
lands in thousands of pipelines within hours.

The action runs inside your job. It sees your job's environment.

### A cache that captured a `.env`

Caching is aggressive by design. If a step writes an env file into the
workspace and a later step caches a directory that contains it, the plaintext
is now a tarball on shared storage — restorable by later jobs, and depending on
your provider's scoping rules, by jobs on other branches.

The same applies to build artefacts, to Docker layers created by `COPY . .`,
and to any "upload the workspace on failure" debugging convenience.

### The credential nobody dares rotate

The oldest one in the list, and the most common. A key issued years ago by
somebody who has since left, referenced by four pipelines and one infrastructure
module, expiring never. It is not rotated because nobody can enumerate what
breaks when it changes.

That is not a rotation problem. It is an inventory problem, and it is worth
reading [how to rotate a secret without taking production
down](/blog/rotate-secrets-without-downtime) before you touch it.

## What actually helps

### Scoped, short-lived tokens instead of standing credentials

A credential that expires is a credential that stops being a liability on a
known date. A credential scoped to one project and one environment turns
"what did the attacker get?" from a research project into a lookup.

Wherever a provider supports it, prefer a token minted per job over a long-lived
key stored in the CI secret store — OIDC federation with a cloud provider is the
common case. Where you must store something, store the narrowest thing that
works.

### One token per pipeline, not one token per company

The instinct is to mint one token and reuse it, because minting is a chore. The
cost of that convenience is paid exactly once, at the worst possible moment.

### Least privilege per environment

Most jobs read. A deploy reads a set of values and hands them to a runtime; it
does not write secrets back. Give a build job read access to one environment and
nothing else, and make `write` the exception you can justify per pipeline.

Then check that production is not reachable by a pipeline that has no business
in production — a staging build with a production token is the same accident as
a staging deploy against the production database.

### Masking is a safety net, never a control

Every CI provider will mask registered secret values in log output. Use it. Then
assume it will fail, because it is string replacement over a byte stream and it
loses in all the ordinary cases:

- the value base64-encoded by a tool that logs its own input;
- the value split across a line boundary by a wrapping log formatter;
- the value inside a JSON blob with escaped quotes;
- the value transformed — a password URL-encoded into a connection string;
- the value written to an artefact instead of a log.

Masking catches the accident you already prevented. It does not prevent
anything.

### Pin actions by commit SHA

```yaml
# ✗ mutable — the tag can be repointed at any commit, at any time
- uses: some-org/setup-thing@v3

# ✓ immutable — pin the commit; keep the human-readable version in a comment
- uses: some-org/setup-thing@9f2c1b4e7a3d5c8f0b6e2a1d4c7f9b3e5a8d0c26 # v3.4.1
```

The comment is what makes this survivable. Without it, nobody can tell whether
a pinned SHA is a year behind, and the pin quietly becomes a way of never
patching.

### Separate the build credential from the deploy credential

A build needs the values that get compiled in. A deploy needs the values that
get handed to the running service. These are usually different sets, they are
almost always different environments, and merging them means the job that runs
on every pull request holds the credentials that only the release job needs.

Two jobs, two tokens, two scopes. It costs one extra secret in your CI settings.

## A pipeline that follows the rules

Here is the shape, using xecret's service tokens for the injection step. The
token is pinned server-side to one project and one environment, so there is no
configuration file in the repository and no `--environment` flag that a typo
could point at production.

```yaml
name: ship

on:
  push:
    branches: [main]

# The default token gets nothing it does not need.
permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<commit-sha> # v4 — pinned, see above

      - uses: playxoft/xecret@<commit-sha> # v1

      # Secrets land in `npm run build`'s environment and nowhere else:
      # not the workspace, not the log, not a later step's context.
      - run: xecret run -- npm run build
        env:
          XECRET_TOKEN: ${{ secrets.XECRET_TOKEN_BUILD }}

  deploy:
    needs: build
    runs-on: ubuntu-latest
    # A different token, a different environment, a different blast radius.
    steps:
      - uses: actions/checkout@<commit-sha> # v4
      - uses: playxoft/xecret@<commit-sha> # v1
      - run: xecret run -- ./deploy.sh
        env:
          XECRET_TOKEN: ${{ secrets.XECRET_TOKEN_DEPLOY_PRODUCTION }}
```

The token is deliberately set in `env:` on the step that needs it rather than at
workflow level. It exists where it is used, and nowhere else in the workflow
context. Provider-by-provider recipes — GitLab, CircleCI, plain runners,
containers — are in [secrets in CI](/docs/guides/ci).

> **Warning** — Writing secrets to a file in the workspace undoes all of this.
> `xecret pull --format env > .env` exists for pipelines that genuinely cannot
> be changed, warns every time it runs, and puts plaintext somewhere caches and
> artefacts will find it. Prefer `xecret run`.

## Revocation at three in the morning

This is the argument for one token per pipeline, and it is easier to see as a
table than as a paragraph. A CI credential has leaked. You are awake, you are
alone, and you have to decide something in the next few minutes.

| The question you are actually asking | One shared token | One token per pipeline |
|---|---|---|
| What could it read? | Everything every pipeline can reach | One environment of one project |
| What happens if I revoke it now? | Every pipeline stops, including the one that ships the fix | One pipeline stops |
| Who was using it? | Grep every workflow file in every repository | The token's name says so |
| What do I rotate downstream? | Every secret it could reach | The secrets in one environment |
| How long until I am back to normal? | A coordination problem across teams | Mint, update one CI variable, revoke |

The middle row is the one that decides real incidents. A shared credential turns
revocation into a negotiation about how much of the company to break, which is
how a leaked token stays live for another day while somebody drafts an email.

A xecret service token is pinned at creation to one organisation, one project
and one environment, is read-only unless you say otherwise, can never delete a
secret, and appears in the [audit log](/docs/security/audit-log) under its own
name — so "what did it read, and when?" is a filter rather than an
investigation. Revocation takes effect on the next request; the CLI's offline
cache never softens it, because a rejection is a decision. The scoping rules and
the leak runbook are in [tokens and credentials](/docs/api/tokens).

## Where xecret fits

Kept in its own section so you can skip it. xecret is open-source secret
management built around one command: store your environment variables once, per
environment, and `xecret run` injects them into whatever your pipeline was going
to run anyway. In CI that means a service token in your provider's secret store,
no login step, no config file, no plaintext on the runner's disk, and one audit
row per read. It is pre-alpha and we say so; the server is AGPL-3.0 if you would
rather run it yourself. If you take nothing else from this article, take the
SHA pins and the second token — both are free, and both are worth having before
you need them.

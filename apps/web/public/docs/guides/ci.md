---
title: Secrets in CI/CD
navTitle: Secrets in CI
description: Service tokens end to end — GitHub Actions, GitLab CI, CircleCI and generic runners — with scoping, rotation and the one anti-pattern to avoid.
keywords: [github actions secrets, gitlab ci variables, circleci environment, service token, ci secret management, xecret token]
updated: 2026-08-16
---

Every CI recipe follows the same three-line story:

1. **Mint a service token** in the dashboard, under *Tokens → New service
   token*. It is pinned to exactly one project and one environment, read-only
   by default, and shown exactly once.
2. **Expose it to the job** as the environment variable `XECRET_TOKEN`.
3. **Run your build through `xecret run`.** Secrets are injected into the child
   process's environment — never written to disk, never echoed to the log.

There is nothing else to configure. The token knows its own scope, so no
`.xecret.yaml`, no organisation flag and no login step are needed in CI.

## Minting the token

In the dashboard: *Tokens → New service token*.

| Field | What to choose |
|---|---|
| Name | What the token is for — `ci-build`, `deploy-staging`. It appears in the audit log against every action the token takes. |
| Project + environment | Exactly the one the job needs. This is the pin; it cannot be widened later. |
| Access level | `read` unless the job writes secrets. Most do not. |
| Expiry | Set one. A credential with no expiry is a credential you will forget you issued. |
| IP allowlist | If your runners have stable egress addresses, use it. |

The token value is displayed once. Copy it straight into the CI provider's
secret store and close the dialog — it cannot be retrieved again, only replaced.

> **Note** — A service token can never delete a secret, and `read` tokens
> cannot write. CI rotates a value by writing a new version; destroying history
> is a human's decision. See [tokens](../api/tokens.md).

## GitHub Actions

Store the token as a repository or environment secret named `XECRET_TOKEN`
(*Settings → Secrets and variables → Actions*).

```yaml
name: build

on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # Installs the CLI and puts it on PATH. Pin a version for reproducible
      # builds: with: { version: v1.2.3 }
      - uses: playxoft/xecret@v1

      # Secrets reach `npm run build`'s environment only — never the
      # workspace, the logs, or any later step.
      - run: xecret run -- npm run build
        env:
          XECRET_TOKEN: ${{ secrets.XECRET_TOKEN }}
```

The token is deliberately **not** an input to the action. Putting it in `env:`
on the steps that use it means GitHub masks it and it exists only where it is
needed, rather than spreading through the workflow context.

### Different environments per branch

```yaml
      - run: xecret run -- npm run deploy
        env:
          XECRET_TOKEN: ${{ github.ref == 'refs/heads/main'
            && secrets.XECRET_TOKEN_PRODUCTION
            || secrets.XECRET_TOKEN_STAGING }}
```

Two tokens, each pinned to its own environment, is safer than one token with a
`--environment` flag: the pin is enforced by the server, and a mistake in the
expression cannot reach production.

## GitLab CI

Add `XECRET_TOKEN` under *Settings → CI/CD → Variables*. Mark it **Masked** —
it is one line of high-entropy base64url, so masking works — and **Protected**
if your plan offers it.

```yaml
build:
  image: node:22
  script:
    - curl -fsSL https://xecret.playxoft.com/install.sh | sh
    - xecret run -- npm run build
```

For a job that needs only the CLI itself — for example writing an env file for
a later stage that cannot be changed:

```yaml
export-legacy-env:
  image:
    name: ghcr.io/playxoft/xecret:latest
    entrypoint: [""]
  script:
    - /usr/local/bin/xecret pull --format env > .env
  artifacts:
    paths: [.env]
    expire_in: 30 min
```

Note the short `expire_in`. A build artefact containing plaintext secrets is a
liability with a half-life; if you must produce one, make it expire.

## CircleCI

Add `XECRET_TOKEN` under *Project Settings → Environment Variables*, or in a
Context shared across projects.

```yaml
version: 2.1

jobs:
  build:
    docker:
      - image: cimg/node:22.9
    steps:
      - checkout
      - run:
          name: Install xecret
          command: curl -fsSL https://xecret.playxoft.com/install.sh | sh
      - run:
          name: Build with secrets injected
          command: xecret run -- npm run build

workflows:
  build:
    jobs:
      - build
```

## Any other runner

The pattern is provider-independent:

```bash
export XECRET_TOKEN="$CI_SECRET_XECRET_TOKEN"
curl -fsSL https://xecret.playxoft.com/install.sh | sh
xecret run -- make build
```

Self-hosted deployments add one variable:

```bash
export XECRET_API_URL=https://secrets.your-company.com
```

## What CI does differently

Under `XECRET_TOKEN` the CLI behaves differently in three ways, all
deliberate:

- **No offline cache** is written or read. A runner is disposable, so a cache
  would rarely hit — while reliably leaving an encrypted blob of production
  configuration on a machine somebody else's job runs next.
- **`login`, `logout` and `init` are refused.** None of them mean anything for
  a credential the machine did not create.
- **Error hints change**, because "run `xecret login`" is useless advice in a
  job with no browser.

## Rotating a token

1. Mint a new token with the same name and scope.
2. Update the CI provider's secret.
3. Revoke the old one in the dashboard.

Revocation is immediate: the lookup filters on "not revoked" in SQL, so an
in-flight job using the old token fails on its next request. Do step 2 before
step 3.

## The one anti-pattern to avoid

```bash
# ✗ don't
xecret pull --format env > .env
```

This writes plaintext secrets to the runner's disk, where they survive into
caches, artefacts, and anything that archives the workspace. The command exists
for legacy pipelines that genuinely cannot be changed, it warns on stderr every
time, and `xecret run` makes it unnecessary everywhere else.

If you must, write it somewhere ephemeral and delete it in the same script.

## Next

- [Tokens](../api/tokens.md) — what each credential can do.
- [Docker](docker.md) — containers and BuildKit secret mounts.
- [Teams, roles and access](teams.md) — who can mint a token.

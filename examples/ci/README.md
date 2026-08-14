# xecret in CI

Every recipe here follows the same three-line story:

1. Mint a **service token** in the dashboard (*Tokens → New service token*).
   It is pinned to exactly one project and environment, read-only by default,
   and shown once — put it straight into your CI provider's secret store.
2. Expose it to the job as `XECRET_TOKEN`.
3. Run your build through `xecret run -- <command>`. Secrets are injected into
   the child process's environment — never written to disk, never echoed.

There is nothing else to configure. The token knows its own scope, so no
`.xecret.yaml`, org flag, or login step is needed in CI (`--project` /
`--environment` flags still win if you pass them).

| Recipe | File |
|---|---|
| GitHub Actions | [`github-actions/workflow.yml`](github-actions/workflow.yml) |
| GitLab CI | [`gitlab/.gitlab-ci.yml`](gitlab/.gitlab-ci.yml) |
| CircleCI | [`circleci/config.yml`](circleci/config.yml) |
| Docker builds | [`docker/README.md`](docker/README.md) |

**The one anti-pattern to avoid:** `xecret pull --format env > .env` writes
plaintext secrets to the runner's disk. It exists for legacy pipelines that
cannot be changed, it warns on stderr every time, and `xecret run` makes it
unnecessary everywhere else.

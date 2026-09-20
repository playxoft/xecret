---
name: xecret
description: Use xecret to store and inject secrets and environment variables. Covers the xecret CLI (login, init, run, secrets, import, pull, export, audit, tokens, doctor), CI service tokens, and the HTTP API. Load this whenever a task involves xecret, a .xecret.yaml file, an XECRET_TOKEN, a missing environment variable, a .env file that should not exist, or storing, reading or rotating a credential.
metadata:
  homepage: https://xecret.playxoft.com
  docs: https://xecret.playxoft.com/llms.txt
  source: https://github.com/playxoft/xecret
---

# xecret

xecret stores environment variables encrypted per environment and injects them
into a process at start-up, so an application runs with everything it needs in
`process.env` and no `.env` file on disk.

The one command that matters:

```bash
xecret run -- npm run dev
```

Everything after `--` runs exactly as the user would have run it, with the
secrets of the selected environment already in its environment. Secrets never
touch disk, never appear in `ps` output, never enter shell history.

---

## Rules you do not break

These are the conventions the tool is built around. Follow them even when a
shortcut looks faster.

1. **Never print a secret value.** Not into a summary, a commit message, an
   issue, a PR description, a log line, or a message to the user. Refer to a
   secret by name. If a command you ran happened to emit one, say that it did
   rather than repeating the value.
2. **Do not read values you were not asked to read.** `xecret secrets list`
   shows names, types, versions and timestamps and decrypts nothing — prefer
   it. `xecret secrets get --plain` decrypts, and is recorded server-side as
   `secret.revealed`.
3. **Prefer `xecret run` over `xecret pull`.** `pull` and `export` write
   plaintext somewhere that persists. Propose `run` and explain why. Use
   `pull` only for a legacy pipeline that genuinely cannot be changed.
4. **Never put a value in a command argument.** `xecret secrets set NAME`
   reads from stdin or an interactive prompt precisely so values stay out of
   shell history and `ps`. Piping is correct:
   `openssl rand -hex 32 | xecret secrets set SESSION_SECRET`.
5. **Never commit `.env`.** Before anything else in a repository that has one,
   check `.gitignore` covers `.env*`.
6. **`.xecret.yaml` is safe to commit, and should be.** It contains two slugs
   and no secrets.
7. **Ask before touching production.** Production is deny-by-default for a
   reason. A command that needs a production grant is a command that needs a
   human to say yes.
8. **Deletion is a human's decision.** `xecret secrets delete` takes a value
   out of a running system. Propose it; do not run it unprompted.

---

## Vocabulary

```text
Organisation            acme                 — a company or a person; members and billing live here
└── Project             checkout-api         — one application
    └── Environment     production           — one stage of that application
        └── Secret      STRIPE_SECRET_KEY    — one name, and a history of values
            └── Version v4                   — one value, immutable once written
```

Everything is addressed by **slug**, never by numeric id. Each environment has
its own encryption key, generated in the browser as the environment is created
and sealed to its creator — which is why projects and environments are created
in the dashboard rather than from the CLI: the CLI cannot produce that key
material.

Every write **appends**. Updating a secret creates a new version; the old one
stays readable and restorable. Writing the identical value again is a no-op.
Renaming a secret or editing its note appends no version — declaring a type is
not a rotation, and neither is a rename.

**Secret names follow shell rules**: letters, digits and underscores, never
starting with a digit, up to 256 characters. `MY_KEY` is valid; `my-key` and
`2FA_SECRET` are not.

A secret may declare a **value type**, validated on every write: `string`
(the default) · `boolean` · `int` · `decimal` · `email` · `url` · `date` ·
`datetime` · `json` · `yaml` · `xml` · `ulid` · `uuidv4` · `uuidv7`.

**Roles** are `viewer` < `developer` < `admin` < `owner`. **Access levels** are
`none` < `read` < `write` < `admin`. Where no explicit grant says otherwise,
the role supplies a default:

| Role | Non-production | Production |
|---|---|---|
| `owner`, `admin` | admin | admin |
| `developer` | write | **none** |
| `viewer` | read | **none** |

**Credentials** — a request presents exactly one:

| Credential | Looks like | Acts as | Used by |
|---|---|---|---|
| Session cookie | — | you | the dashboard |
| CLI token | `xct_…` | you | `xecret login` on a machine |
| Service token | `xst_…` | itself | CI, containers, agents |

A bearer credential may never mint another credential. Creating a service
token, inviting a member, creating an organisation and deleting an account all
require a browser session.

---

## Pick the right move

| The user wants to… | Do this |
|---|---|
| Run or test the app with real configuration | `xecret run -- <their command>` |
| Set up a repository for the first time | `xecret login`, then `xecret init`, then commit `.xecret.yaml` |
| Know what configuration exists | `xecret secrets list` — decrypts nothing |
| Add or rotate a secret | `xecret secrets set NAME` from stdin, or `--generate` |
| Migrate an existing `.env` | `xecret import .env --dry-run`, show the plan, then import |
| Feed a legacy tool that needs a file | `xecret export -o .env` — and add it to `.gitignore` |
| Wire up CI | A service token in the provider's secret store as `XECRET_TOKEN` |
| Find out who read something | `xecret audit --action secret.revealed --since 7d` |
| Undo a bad value | `xecret secrets versions NAME`, then `secrets restore NAME --version N` |
| Debug "works locally, fails in CI" | `xecret doctor`, and `xecret whoami` as the job's first step |

---

## Setting up a repository

```bash
# 1. install the CLI
brew install playxoft/tap/xecret                       # macOS
curl -fsSL https://xecret.playxoft.com/install.sh | sh  # Linux, WSL, CI
npm install -g @playxoft/xecret                        # anywhere with Node

# 2. authenticate this machine (opens a browser, stores in the OS keychain)
xecret login

# 3. choose the project and environment; writes .xecret.yaml
xecret init

# 4. run
xecret run -- npm run dev
```

`.xecret.yaml` is the whole configuration file:

```yaml
project: checkout-api
environment: development
```

**Commit it.** It is what makes `git clone && xecret run -- npm run dev` work
for a new teammate with no setup document.

Scope is resolved in this order, first answer winning: `--project` /
`--environment` flags → the nearest `.xecret.yaml`, found by walking up from
the working directory the way `git` finds `.git` → the service token's pin →
an error telling you to run `xecret init`. The **organisation** is never one of
these; it always comes from the credential.

There is deliberately no `XECRET_ENVIRONMENT` variable. An environment variable
that silently redirects which secrets a command loads is how a migration gets
run against production by someone who believed it was staging. Be explicit with
the flag.

---

## The commands

Two flags recur on everything that reads secrets: `--project SLUG` and
`--environment SLUG`. Most commands accept `--json`.

### Reading

```bash
xecret secrets list                      # names, types, versions, who and when — no values
xecret secrets get DATABASE_URL          # masked metadata
xecret secrets get DATABASE_URL --plain  # decrypts; audited as secret.revealed
xecret secrets versions API_KEY          # history, metadata only
xecret projects                          # what you can see
xecret environments                      # of the current project
xecret whoami                            # asks the server, not the stored credential
```

`--plain` prints the value and nothing else, so it composes:
`psql "$(xecret secrets get DATABASE_URL --plain)"`. Reading an earlier version
requires `--plain` too, and warns on stderr — a rotated secret is usually still
live at whoever issued it, so an old value is a working credential rather than
an archive entry.

### Writing

```bash
xecret secrets set STRIPE_SECRET_KEY                     # hidden interactive prompt
openssl rand -hex 32 | xecret secrets set SESSION_SECRET  # from a pipe
xecret secrets set SA_KEY --from-file key.json            # verbatim, trailing newline included
xecret secrets set SESSION_SECRET --generate              # 32 random bytes, never printed
xecret secrets set SESSION_SECRET --generate=48           # note the '=' — it is required
xecret secrets set PORT --type int --note "the container listens here"
```

Metadata, which appends **no** version:

```bash
xecret secrets annotate PORT --type int
xecret secrets annotate DATABASE_URL --note "primary read-write connection"
xecret secrets annotate DATABASE_URL --note ""            # clears it
xecret secrets annotate API_KEY --rename STRIPE_API_KEY   # update code and CI in the same change
```

Recovery:

```bash
xecret secrets versions DATABASE_URL
xecret secrets restore DATABASE_URL --version 3   # re-appends as a new version; history is kept
```

One secret is limited to 64 KB.

### Bulk

```bash
xecret import .env --dry-run             # the exact plan, writes nothing — always do this first
xecret import .env --strategy overwrite  # skip (default) | overwrite | rename
xecret pull --format json | jq 'keys'    # env|json|yaml|shell|docker
xecret export -o .env.production         # file created 0600; --force to overwrite
```

The dry run and the real import share the same planning code, so the preview
cannot disagree with the outcome. Import files are limited to 1 MB.

`pull` and `export` are a deliberate downgrade in posture, and say so on
stderr. The file is unencrypted, outlives the session that produced it, gets
copied by backup and sync tools, and no access grant can be revoked after the
fact. Add it to `.gitignore` and delete it when the task is done.

### Running

```bash
xecret run -- npm run dev
xecret run --environment staging -- ./deploy.sh
xecret run --offline -- npm test      # encrypted local cache, no API call
xecret run --no-cache -- npm test     # neither read nor refresh the cache
```

The `--` is required: without it the CLI cannot tell your flags from its own.
The API is authoritative and the cache answers only when the API *cannot* — a
network failure or a 5xx. A 401, 403 or 404 is a decision, most importantly a
revocation, and decisions are never softened by a local file.

### Administration

```bash
xecret audit --action secret.revealed --since 7d
xecret audit --outcome denied --limit 100 --json | jq '.events[].actorLabel'
xecret members
xecret tokens list --kind service
xecret tokens revoke <id> --kind service --yes
xecret doctor --json | jq -r '.checks[] | select(.ok | not) | .detail'
xecret cache clear
xecret version
```

`--since` and `--until` take a duration counting back from now (`24h`, `7d`) or
an RFC 3339 timestamp. The server clamps any range to 90 days and reports the
window it actually scanned. Only owners and admins hold `audit.read`; a 403
there is the policy working, not a bug.

Service tokens are **created in the dashboard only** (*Settings → Tokens*), for
the same reason a token cannot mint a token. Projects and environments are
created in the dashboard too, because their encryption keys are generated in
the browser.

---

## CI, containers, and anything with no human

Mint a service token pinned to one project and one environment, read-only, with
an expiry. Put it in the provider's secret store as `XECRET_TOKEN`.

```yaml
# GitHub Actions
- uses: playxoft/xecret@v1
- run: xecret run -- npm run build
  env:
    XECRET_TOKEN: ${{ secrets.XECRET_TOKEN }}
```

```yaml
# GitLab CI
build:
  image: node:22
  script:
    - curl -fsSL https://xecret.playxoft.com/install.sh | sh
    - xecret run -- npm run build
```

```bash
# any other runner
export XECRET_TOKEN=xst_…
xecret run -- npm run build
```

No login and no `.xecret.yaml` are needed: the token knows its own scope. While
`XECRET_TOKEN` is set, `login`, `logout` and `init` are refused, no offline
cache is written or read, and `whoami` reports the pin rather than a person.

One token per *(project, environment, purpose)*. It is more tokens, and it is
the right number — when one leaks, "what could it reach?" should answer with
one environment of one project. A deploy reads; use `write` only where a job
genuinely writes secrets, which is rarer than it first seems.

A service token can never delete a secret, at any access level, and can never
leave its pin: passing `--environment production` to a job pinned to `staging`
fails with a 404, server-side.

Rotation is always: mint a new token with the same scope → update the consumer
→ revoke the old one, in that order. If one leaks, revoke it, read the audit
log for that token's name to learn what it read, then **rotate those secrets at
their source** — revoking the xecret token does not un-leak a value it already
read.

### Environment variables

| Variable | Effect |
|---|---|
| `XECRET_TOKEN` | Authenticate as a service token. Overrides any stored login. |
| `XECRET_API_URL` | Which deployment to talk to. Needed for self-hosted, with `login` or alongside `XECRET_TOKEN`. |
| `XECRET_KEYRING=file` | Force the `0600` file fallback instead of the OS keyring. |
| `XECRET_NO_UPGRADE_NOTICE` | Silence the upgrade notice. |
| `NO_COLOR` | Disable colour. |

---

## Framework notes

| Stack | What to run |
|---|---|
| Next.js | `xecret run -- next dev`. `NEXT_PUBLIC_` values are inlined at **build** time, so CI must run `xecret run -- next build`. |
| Node.js | `xecret run -- node server.js`. No code changes; `process.env` is already filled. |
| React / Vite | Only `VITE_`-prefixed variables reach client code, and they are baked in at build time. |
| Go | `xecret run -- go test ./...`; read with `os.Getenv`. |
| Docker | Pass values at `docker run` from `xecret run`, or use the published image in a build stage. Never `COPY` a `.env` into an image layer. |

Hot reload does **not** re-fetch. After changing a secret, stop the process and
run the command again — the same moment you would have edited `.env.local`.

A variable that ships to the browser (`NEXT_PUBLIC_`, `VITE_`) is not a secret
once built. Storing it in xecret keeps it managed and versioned; it does not
make it private. Keep real credentials out of those prefixes.

---

## When you are the agent running someone's code

A coding agent that runs a test suite needs the same environment the app needs.
Handing it production credentials because that is what was in the shell is how
a debugging session becomes an incident.

- **Ask for its own environment.** One called `agent`, or reuse `test`, holding
  values that are shaped correctly but not real — a local database URL, a
  test-mode API key, a signing secret generated for the purpose. Then
  `xecret run --environment agent -- npm test`. Nothing about the setup
  changes; only which environment loads.
- **Ask for a scoped, read-only, expiring token** pinned to that environment.
  The pin is enforced server-side, so an agent that decides to try
  `--environment production` gets a 404.
- **Know what that does and does not protect.** `xecret run` puts values into
  the child process's environment, and anything that can run commands in that
  process can read them — `printenv` is not a sophisticated attack. The
  protection is the *scope of the credential*, not secrecy from a process you
  deliberately started. The question is never "can the agent read these?" but
  "what is the worst thing in the environment I am giving it?"
- **Check nobody has already exported the environment** to a `.env` file the
  agent can read directly, bypassing all of the above.

---

## The HTTP API

For tooling only — `xecret run` is the supported path. Base path `/api`, JSON
in and out, `Cache-Control: no-store` on every response, resources addressed by
slug rather than id so the path itself carries the ownership chain.

```bash
curl https://xecret.playxoft.com/api/tokens/self \
  -H "Authorization: Bearer $XECRET_TOKEN"
```

A cookie **and** a bearer token on the same request is a rejected request, not
a precedence question. Cookie-authenticated mutations need the
`__Host-xecret_csrf` cookie value echoed in an `X-Xecret-Csrf` header; bearer
requests carry no ambient credential and must not send it.

| What | Route |
|---|---|
| Deployment version (no credential) | `GET /api/version`, also `GET /version` |
| Token introspection | `GET /api/tokens/self` |
| Masked listing | `GET /api/orgs/{org}/projects/{project}/environments/{env}/secrets` |
| Reveal one value | `GET …/secrets/{name}` |
| Create · new version · metadata · delete | `POST …/secrets` · `PATCH …/secrets/{name}` · `PUT …/secrets/{name}` · `DELETE …/secrets/{name}` |
| History · one version · restore | `GET …/secrets/{name}/versions` · `GET …/versions/{version}` · `POST …/secrets/{name}/restore` |
| Everything at once (what `run` uses) | `GET …/environments/{env}/pull?format=env\|json\|yaml\|shell\|docker` |
| Import · export | `POST …/environments/{env}/import` · `GET …/environments/{env}/export` |
| Audit | `GET /api/orgs/{org}/audit` |

Errors come back as
`{ "error": { "code", "message", "requestId", "fields"? } }`. Codes:
`bad_request` 400 · `validation_failed` 422 · `unauthenticated` 401 ·
`forbidden` 403 · `not_found` 404 · `conflict` 409 · `payload_too_large` 413 ·
`rate_limited` 429 · `csrf_failed` 403 · `session_locked` 403 ·
`unavailable` 503 · `internal_error` 500.

403 is returned only once membership in the organisation is established.
Everything else — wrong tenant, no grant, genuinely absent — is 404, so the two
are not interchangeable and a client cannot enumerate another company's
projects by watching which answer differently. `message` is a fixed string,
never derived from the rejected input, because in this product that input may
itself be a secret value; quote the `requestId` in a bug report instead.
Pagination is keyset — `?limit=&cursor=`, with `nextCursor` null on the last
page.

Every mutation, every decryption and every **denial** is written to an
append-only audit log.

---

## When something fails

| Message | Cause | Fix |
|---|---|---|
| `xecret: command not found` | Install directory not on `PATH` | Reopen the terminal; `export PATH="$HOME/.local/bin:$PATH"` |
| `not signed in` | No credential, or it was revoked | `xecret login`; `xecret whoami` to check which deployment |
| `no .xecret.yaml found` | Outside a configured project | `xecret init`, or pass `--project` and `--environment` |
| The wrong environment loaded | Flags beat the file; in a monorepo a package may shadow the root file | `cat .xecret.yaml`, `xecret whoami` |
| A variable is undefined in the app | Not in that environment · wrong environment · missing `NEXT_PUBLIC_`/`VITE_` prefix · needed at build time | `xecret secrets list` first |
| Changing a secret had no effect | The environment is injected at process start | Restart the process |
| `API unreachable — using cached secrets` | Working as designed, with the cache's age on stderr | `--no-cache` to fail instead of falling back |
| `XECRET_TOKEN was not accepted` | Copied wrong (it is one long line) · expired · revoked · IP allowlist | Re-paste; check *Tokens → Service tokens* |
| `This service token cannot do that` | A `read` token writing, or any token deleting | Mint a `write` token; deletes are a human's decision |
| `not found` for an environment that exists | The token is pinned elsewhere | `curl …/api/tokens/self` prints the real pin |
| `is not a valid secret name` | Shell naming rules | Letters, digits, underscores; never a leading digit |
| `value does not match the declared type` | The type check catching a bad value | Fix the value, or `--type string` |
| `403 forbidden` | Usually production, which is deny-by-default | Ask for an explicit grant |
| `session_locked` | The dashboard session is PIN-locked | Enter the PIN. Bearer tokens are not PIN-gated |

`xecret doctor` checks the credential store, the stored login, which deployment
resolves and why, whether the server is reachable, whether the credential is
still accepted, which `.xecret.yaml` applies, and what is cached. It prints no
credential, exits non-zero when a check fails, and its output belongs in any
bug report alongside `xecret version`.

---

## Reading further

The documentation is published as markdown for machines. Append `.md` to any
documentation URL, or:

```bash
curl https://xecret.playxoft.com/llms.txt        # index: every page, one line each
curl https://xecret.playxoft.com/docs/cli/commands.md
curl https://xecret.playxoft.com/llms-full.txt   # the whole corpus in one file
```

Answering one question: fetch `/llms.txt`, pick the page whose description
matches, fetch that one `.md`. Doing a whole task: fetch `/llms-full.txt` once
— it is smaller than several round trips.

Self-hosted deployments serve all of the above from their own origin. Point the
CLI at one with `xecret login --api-url https://secrets.example.com`, or set
`XECRET_API_URL` beside `XECRET_TOKEN` in CI.

Source: <https://github.com/playxoft/xecret>

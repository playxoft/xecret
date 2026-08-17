# CLI reference

The `xecret` binary: a single static executable (Go, `CGO_ENABLED=0`) for
macOS, Linux and Windows, amd64 and arm64. MIT-licensed, unlike the server —
see [ADR 0007](../adr/0007-licensing.md).

Two rules govern everything it does:

1. **A secret value is never written** to stdout, stderr, a log, a temp file
   or a process argument — except by `pull`, `export` and
   `secrets get [--version N] --plain`, whose stated purpose is producing one,
   and which write it to stdout (or, for `export`, to one named `0600` file)
   and nowhere else.
2. **Credentials live in the OS keychain** (macOS Keychain, Windows Credential
   Manager, Secret Service on Linux), never in a dotfile. Where no keyring
   exists, a `0600` file under `~/.xecret/` is used and announces itself.

## Scope resolution

Every secret-touching command needs an *(organisation, project, environment)*
triple, resolved in this order:

1. `--project` / `--environment` flags
2. `.xecret.yaml`, discovered by walking up from the working directory
3. Under `XECRET_TOKEN`: the token's own pinned scope
4. Otherwise: an error telling you to run `xecret init`

The organisation always comes from the credential — a login is pinned to one
org, a service token to one org, project *and* environment. Naming a scope
outside a service token's pin is refused by the server, never merely by the
client.

## Environment variables

| Variable | Effect |
|---|---|
| `XECRET_TOKEN` | Authenticate as a service token (`xst_…`). No login, no keychain, no offline cache. Wins over any stored login. |
| `XECRET_API_URL` | The deployment to talk to, for `login` and for `XECRET_TOKEN` mode. A stored login remembers its own URL. |
| `XECRET_KEYRING=file` | Force the `0600` file fallback instead of the OS keyring. |
| `NO_COLOR` | Disable colour. Output is also uncoloured when stdout is not a TTY. |

## Commands

### Authentication

```
xecret login [--api-url URL] [--name DEVICE]
```
OAuth-style browser consent with PKCE against the xecret server (never
Firebase directly): a loopback listener on `127.0.0.1:<random port>` receives
a one-time code, exchanged — together with the PKCE verifier — for an `xct_`
token stored in the keychain. The device name appears on the consent screen
and in the dashboard's *Tokens → Your devices*, where it can be revoked.

```
xecret logout
```
Revokes this device's credential server-side, clears the keychain entry and
wipes the encrypted offline cache. Refused while `XECRET_TOKEN` is set: that
credential was not minted by this machine and is not this machine's to sign
out — `xecret tokens revoke ID --kind service` is.

```
xecret whoami [--json]
```
Asks the server, so a revoked credential reads as signed out rather than as
its stale identity. Under `XECRET_TOKEN`, answers with the token's pinned
scope instead of a person.

```
xecret orgs [list] [--json]
xecret orgs use SLUG
```
A CLI token authenticates as its *user*, and the server settles membership per
request against whichever organisation the path names — so `use` is a local
change to one field beside the token, checked against the server's own list
first so "you are not a member" arrives now rather than as a 404 on the next
command. Refused under `XECRET_TOKEN`, which is pinned server-side.

### Project setup

```
xecret init [--project SLUG] [--environment SLUG] [--force]
```
Interactive picker that writes `.xecret.yaml` — two slugs, never secrets, safe
to commit. Refused under `XECRET_TOKEN` (a CI job needs no config file; the
token's pin already answers).

```
xecret projects [list] [--json]
xecret projects create NAME [--slug SLUG] [--description TEXT]
xecret projects delete SLUG [--yes]
xecret environments [list] [--project SLUG] [--json]
xecret environments create NAME [--slug SLUG] [--production] [--project SLUG]
xecret environments delete SLUG [--yes] [--project SLUG]
```

- The bare form is still the listing, so no existing invocation changes
  meaning: a first argument that begins with `-` is a flag on `list`.
- Creating a project creates its default environments and each one's Env Data
  Key in a single transaction; creating an environment creates its key the same
  way. `secret_versions.env_key_id` is `NOT NULL`, so an environment without a
  key silently rejects every write it will ever receive and cannot be repaired
  without an operator holding the Root KEK.
- Both deletes are soft, and both send `{"confirm": "<slug>"}` unconditionally —
  the server requires it only for production, and a request that came back
  asking for one would be a retry the user did not understand.
- Creating either is refused for a service token: `project.create` is not in
  `SERVICE_TOKEN_ACTIONS`, because a CI credential must never appear as the
  author of anything.

### Secrets

```
xecret secrets list  [--project P] [--environment E] [--json]
xecret secrets get NAME [--version N] [--plain] [--json]
xecret secrets set NAME [--type TYPE] [--note TEXT] [--from-file PATH] [--generate[=BYTES]]
xecret secrets annotate NAME [--note TEXT] [--type TYPE] [--rename NEW]
xecret secrets versions NAME [--json]
xecret secrets restore NAME --version N
xecret secrets delete NAME [--yes]
```

- `get` is **masked by default**; `--plain` prints the decrypted value — and
  is audited server-side as `secret.revealed`, so an audit row always means a
  plaintext actually left the server. `--version N` reveals one historical
  value and requires `--plain`, because the value is the only thing it adds
  over `versions`; the audit record carries the version.
- `set` reads the value from stdin or an interactive prompt — never from
  argv, where it would land in shell history and `ps` output. `--from-file`
  takes a file's bytes verbatim, trailing newline included (a pipe's newline is
  the shell's framing; a file's is part of the file). `--generate` mints 32
  bytes from the OS entropy source and writes them without printing them.
- `--type` declares the value's shape (`int`, `url`, `json`, …); future writes
  that do not match are refused by the server.
- `annotate` is the `PUT` that **appends no version** — name, note and declared
  type live on the secret, not on the version. Declaring `PORT` an integer is
  not a rotation, and neither is a rename, so neither may bump the number that
  answers "when did this credential last actually change?". `set --note` on an
  *existing* secret applies the note through this same route, because the
  version-append body has no field for it and would otherwise discard it. That
  makes `set --note` two requests, so it can half-succeed: if the second one
  fails the value is written and the note is not, and the command says which and
  **exits non-zero** — `set --note … && deploy` must not treat a partly applied
  write as a success.
- `versions` is **metadata only**, and that is the design rather than a
  limitation: a rotated secret usually still works at the provider that issued
  it, so a listing carrying values would serve a page of live credentials under
  an interface people read as an archive. Reading the past is one version at a
  time, audited each time.
- `restore` re-appends an earlier value as a new current version. History is
  never rewritten; the value is decrypted and re-encrypted rather than copied,
  because the AAD binds the version number.
- Under a *write* service token, `set` works; `delete` is always refused for
  service tokens — CI rotates values by writing new ones, destroying history
  is a human's decision.

### Moving secrets in bulk

```
xecret import FILE [--format dotenv|json|yaml|shell] [--strategy skip|overwrite|rename] [--dry-run] [--json]
xecret pull [--format env|json|yaml|shell|docker] [-o FILE]
xecret export [--format env|json|yaml|shell|docker] [-o FILE] [--force]
```

- `import` auto-detects the format, and `--dry-run` prints the exact plan the
  real import would execute — the same planning code path, so the preview
  cannot disagree with the outcome.
- `pull` prints every current secret in the chosen format. Writing secrets to
  disk is a downgrade and the command says so on stderr; `-o` at least creates
  the file `0600`. Prefer `xecret run`.
- `export` is the same document written to a file, through the server's
  `…/export` endpoint rather than `…/pull`. They stay separate because the
  request path is what tells "a build read its configuration" apart from
  "somebody took a copy" in the audit record. The filename defaults per format,
  and an existing one is never overwritten without `--force`.
- Both `export` and `pull -o` leave the file at mode `0600` whether they created
  it or overwrote it. `os.WriteFile` would not: it hands its permission argument
  to `open(2)`, which applies it only on creation, so a `--force` over a `.env`
  already sitting at `0644` would have written every decrypted secret into a
  world-readable file under a message claiming `0600`.

### Administration

```
xecret audit [--action A] [--project P] [--environment E] [--outcome success|denied|error]
             [--since 24h|7d|TIMESTAMP] [--until 1h|7d|TIMESTAMP] [--limit N] [--json]
xecret members [--json]
xecret tokens list [--kind cli|service] [--json]
xecret tokens revoke ID --kind cli|service [--yes]
```

- `audit` needs `audit.read` — owners and admins, deliberately not developers:
  the log spans projects a developer cannot see and holds every denial anyone
  received. The window the server actually scanned is printed, because the range
  is clamped to ninety days and a caller who asked for more must be told.
- `--since` and `--until` take the same spellings — a duration counting back
  from now (`24h`, `7d`) or an RFC 3339 timestamp, normalised to UTC before it
  is sent. A window that cannot contain anything is refused rather than sent: a
  negative or absurd relative value, a `--since` after `--until`, a `--since` in
  the future. The server clamps a backwards range to a single instant, so each
  of those would otherwise come back as "No matching events" — a sentence that
  reads as a fact about the log when it is a fact about the question.
- `members` is read-only. Inviting, suspending and role changes require a
  browser session server-side, so a write command here could only print a 403.
- `tokens revoke` requires `--kind`: the two kinds are addressed through
  different paths and the client must not guess which credential to kill.
- **Minting a service token is not a CLI command.** `POST …/tokens/service`
  calls `requireSessionPrincipal`, so it is browser-only by design — a token
  that could mint another token turns one leaked credential into a permanent
  foothold. `xecret tokens create` says so and names the dashboard page.

### The golden path

```
xecret run [--project P] [--environment E] [--offline] [--no-cache] -- COMMAND [ARGS…]
```

Fetches the environment (decrypted server-side), injects it into the child
process, forwards signals, and exits with the child's exit code. Secrets never
touch disk, argv or stdout.

**Offline behaviour, stated once:** the API is authoritative; the encrypted
cache answers only when the API *cannot* — network failure or a 5xx — and
never when it *will not*. A 401/403/404 is a decision (revocation above all),
and decisions are not softened by a local file. Cache fallback is loud: the
cache's age and secret count are printed to stderr every time.

- `--offline` — use the cache without calling the API (refused under
  `XECRET_TOKEN`, which never writes one).
- `--no-cache` — neither read nor refresh the cache.

The cache lives in `~/.xecret/cache/`, one AES-256-GCM file per
(host, org, project, environment), key in the OS keychain, AAD bound to that
exact scope — a cache file cannot be relocated between environments any more
than a server-side ciphertext can.

### Housekeeping

```
xecret cache clear                  # remove every cached environment
xecret completion bash|zsh|fish     # shell completion script
xecret doctor [--json]              # what this machine is set up to do
xecret upgrade [--json]             # is a newer release published?
xecret version
xecret help
```

- `completion` is generated from one table in `cmd/xecret/completion.go`, so a
  command added to `dispatch` and forgotten there is one missing completion
  rather than three that disagree. Flags hang off each command in that table,
  because a flag offered where it is not defined completes to `flag provided but
  not defined`. Secret *names* are deliberately not completed: that would be an
  audited API call per press of the Tab key.
- `doctor` prints no credential — the keyring check writes and deletes a probe
  value of its own. It reports which store is in use, whether the credential is
  still accepted, which deployment resolved and *why*, the `.xecret.yaml` in
  effect, and what is in the cache.
- `doctor` **exits non-zero when a check fails**, so `xecret doctor || exit 1`
  works as a container start-up guard. Warnings (no `.xecret.yaml` here, an
  unreadable cache) are not failures. `--json` carries a `checks` array of
  `{name, status, ok, detail}` plus a top-level `ok`, so the verdicts are
  readable by a machine and not only by a person reading the glyphs.
- `upgrade` asks GitHub, not the xecret server, and only when asked: a version
  check describes which machine runs which build of a secret-management client,
  and doing it in the background would ship that from inside every CI job. It
  never replaces the binary — the published archives are checksummed and signed,
  and `scripts/install-cli.sh` verifies the checksum before unpacking.

## Conventions

- **stdout is results, stderr is commentary.** `xecret projects --json | jq`
  works because warnings, hints and progress never share the pipe.
- `--json` on listing commands emits one machine-readable document.
- **Flags may appear anywhere**, before or after positional arguments —
  `xecret secrets get API_KEY --plain` is the documented form. Go's `flag`
  package stops at the first non-flag argument, so `parseFlags` in `main.go`
  walks the list instead: parse, take the positional that stopped it, parse the
  rest. A bare `--` still ends the flags.
- Errors say what to do next; API failures carry a hint line (`Run 'xecret
  login'…`, or under `XECRET_TOKEN`, what to check about the token).
- `run` propagates the child's exit code untouched; the CLI's own failures
  exit 1.

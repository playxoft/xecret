# CLI reference

The `xecret` binary: a single static executable (Go, `CGO_ENABLED=0`) for
macOS, Linux and Windows, amd64 and arm64. MIT-licensed, unlike the server —
see [ADR 0007](../adr/0007-licensing.md).

Two rules govern everything it does:

1. **A secret value is never written** to stdout, stderr, a log, a temp file
   or a process argument — except by `pull` and `secrets get --plain`, whose
   stated purpose is producing one, and which write it to stdout raw and
   nowhere else.
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
wipes the encrypted offline cache. Refused while `XECRET_TOKEN` is set —
service tokens are revoked from the dashboard.

```
xecret whoami [--json]
```
Asks the server, so a revoked credential reads as signed out rather than as
its stale identity. Under `XECRET_TOKEN`, answers with the token's pinned
scope instead of a person.

### Project setup

```
xecret init [--project SLUG] [--environment SLUG] [--force]
```
Interactive picker that writes `.xecret.yaml` — two slugs, never secrets, safe
to commit. Refused under `XECRET_TOKEN` (a CI job needs no config file; the
token's pin already answers).

```
xecret projects [--json]
xecret environments [--project SLUG] [--json]
```

### Secrets

```
xecret secrets list  [--project P] [--environment E] [--json]
xecret secrets get NAME [--plain] [--json]
xecret secrets set NAME [--type TYPE] [--note TEXT]
xecret secrets delete NAME [--yes]
```

- `get` is **masked by default**; `--plain` prints the decrypted value — and
  is audited server-side as `secret.revealed`, so an audit row always means a
  plaintext actually left the server.
- `set` reads the value from stdin or an interactive prompt — never from
  argv, where it would land in shell history and `ps` output.
- `--type` declares the value's shape (`int`, `url`, `json`, …); future writes
  that do not match are refused by the server.
- Under a *write* service token, `set` works; `delete` is always refused for
  service tokens — CI rotates values by writing new ones, destroying history
  is a human's decision.

### Moving secrets in bulk

```
xecret import FILE [--format dotenv|json|yaml|shell] [--strategy skip|overwrite|rename] [--dry-run] [--json]
xecret pull [--format env|json|yaml|shell|docker] [-o FILE]
```

- `import` auto-detects the format, and `--dry-run` prints the exact plan the
  real import would execute — the same planning code path, so the preview
  cannot disagree with the outcome.
- `pull` prints every current secret in the chosen format. Writing secrets to
  disk is a downgrade and the command says so on stderr; `-o` at least creates
  the file `0600`. Prefer `xecret run`.

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
xecret cache clear     # remove every cached environment
xecret version
xecret help
```

## Conventions

- **stdout is results, stderr is commentary.** `xecret projects --json | jq`
  works because warnings, hints and progress never share the pipe.
- `--json` on listing commands emits one machine-readable document.
- Errors say what to do next; API failures carry a hint line (`Run 'xecret
  login'…`, or under `XECRET_TOKEN`, what to check about the token).
- `run` propagates the child's exit code untouched; the CLI's own failures
  exit 1.

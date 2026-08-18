# Quickstart

From nothing to `xecret run` in about five minutes. Everything here also works
against a self-hosted deployment — set `XECRET_API_URL` and the steps are
identical.

## 1. Create an account

Sign up at the dashboard with Google or email. Your personal organisation, a
default project, and three environments — development, staging, production —
are created on first sign-in, each environment with its own encryption key.

## 2. Import the .env you already have

Open your project, pick an environment, and drag your `.env` file into the
import dialog. Parsing happens **in your browser** — the dry-run preview shows
exactly what will be created, renamed or skipped before a single value is
sent. Multiline PEM blocks, `export` prefixes, CRLF files and trailing
comments all parse the way you would hope.

## 3. Install the CLI

```bash
# macOS
brew install playxoft/tap/xecret

# Linux / CI (checksum-verified)
curl -fsSL https://xecret.playxoft.com/install.sh | sh

# anywhere you already have Node
npm install -g xecret
```

Or download a signed archive from the
[releases page](https://github.com/playxoft/xecret/releases).

## 4. Sign in and point at your project

```bash
xecret login     # opens the browser; approve this device
xecret init      # pick project + environment; writes .xecret.yaml
```

`.xecret.yaml` holds two slugs and no secrets — commit it, and everyone who
clones the repository is one `xecret run` away from a working app.

## 5. Run your app

```bash
xecret run -- npm run dev
```

Secrets are decrypted server-side, injected into the child process's
environment, and never touch disk, argv, or your shell history. Every read
lands in the audit log. If the API is unreachable, an encrypted local cache
answers instead — loudly, with its age printed — so an outage on our side
does not stop your `npm run dev`.

## 6. Put it in CI

Mint a **service token** in the dashboard (*Tokens → New service token*): it
is pinned to one project and one environment, read-only by default, and shown
exactly once. Then:

```yaml
# GitHub Actions
- uses: playxoft/xecret@v1
- run: xecret run -- npm run build
  env:
    XECRET_TOKEN: ${{ secrets.XECRET_TOKEN }}
```

No login, no config file — the token's own scope answers everything. Recipes
for GitLab, CircleCI and Docker are in [`examples/ci/`](../examples/ci/).

## Where next

- Working with a team? Invite people from *Members* — roles, per-environment
  grants, and the effective-access preview are covered in the dashboard.
- The full command surface: [CLI reference](cli/reference.md).
- What xecret can and cannot protect you from, stated plainly:
  [threat model](security/threat-model.md).

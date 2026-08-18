---
title: Quickstart
navTitle: Quickstart
description: From sign-up to running your app with injected secrets in about five minutes, including your first CI job.
keywords: [xecret quickstart, get started, xecret run, install xecret cli, import env file]
updated: 2026-08-16
---

Five steps, about five minutes. Everything here also works against a
self-hosted deployment — set `XECRET_API_URL` and the steps are identical.

If a word here is unfamiliar, [core concepts](concepts.md) defines all of them
in one page.

## 1. Create an account

Sign up with Google or with an email address and password. On your first
sign-in xecret creates:

- your **personal organisation** — a workspace with just you in it;
- a **default project** — one project per application;
- three **environments** — `development`, `staging` and `production`.

Each environment gets its own encryption key at the moment it is created. A
secret stored in `staging` is encrypted under a different key from the same
secret in `production`.

## 2. Import the `.env` you already have

Open your project in the dashboard, pick an environment, and drag your `.env`
file into the import dialog.

The file is parsed **in your browser**. A dry-run preview shows exactly what
will be created, renamed or skipped before a single value is sent anywhere —
which means a pasted blob of production credentials never becomes a request
body you have to trust us with.

Multiline PEM blocks, `export ` prefixes, CRLF line endings and trailing
comments all parse the way you would hope. JSON and YAML work too.

> **Tip** — No `.env` to import? Add one secret by hand to see the flow:
> `DATABASE_URL` is the usual first.

## 3. Install the CLI

```bash
# macOS
brew install playxoft/tap/xecret

# Linux, WSL, CI — verifies the release checksum before unpacking
curl -fsSL https://xecret.playxoft.com/install.sh | sh
```

Windows, other package managers and manual installs are covered in
[installing the CLI](install.md). Check it worked:

```bash
xecret version
```

## 4. Sign in and point at your project

```bash
xecret login     # opens your browser; approve this device
xecret init      # pick a project and environment; writes .xecret.yaml
```

`xecret login` opens a browser page where you approve the device by name. The
credential it receives is stored in your operating system's keychain — macOS
Keychain, Windows Credential Manager, or Secret Service on Linux — never in a
dotfile you might commit or sync.

`xecret init` writes a file called `.xecret.yaml`:

```yaml
project: my-app
environment: development
```

Two slugs and no secrets. **Commit it.** Everyone who clones the repository is
then one command away from a working app.

## 5. Run your app

```bash
xecret run -- npm run dev
```

Everything after `--` is your command, run exactly as you would have run it
yourself. The difference is that its environment already contains every secret
in the environment you selected.

What happens under the hood:

1. The CLI resolves which project and environment you mean (flags, then
   `.xecret.yaml`).
2. It asks the server for that environment; the server decrypts the values and
   returns them over TLS.
3. The CLI starts your command with those values in its environment,
   forwards signals such as `Ctrl-C`, and exits with your command's exit code.

Secrets never touch disk, never appear in `ps` output, and never enter your
shell history. Every read is written to the audit log.

If the API is unreachable, an encrypted local cache answers instead — loudly,
printing its age to stderr — so an outage on our side does not stop your
`npm run dev`. See [the offline cache](cli/offline-cache.md).

Now delete your `.env` file, and make sure `.env*` is in `.gitignore`.

## 6. Put it in CI

Mint a **service token** in the dashboard, under *Tokens → New service token*.
A service token is pinned to exactly one project and one environment, is
read-only by default, and is shown to you exactly once — copy it straight into
your CI provider's secret store.

```yaml
# GitHub Actions
- uses: playxoft/xecret@v1
- run: xecret run -- npm run build
  env:
    XECRET_TOKEN: ${{ secrets.XECRET_TOKEN }}
```

No login, no `.xecret.yaml`, no configuration: the token knows its own scope.
GitLab, CircleCI and Docker recipes are in [secrets in CI](guides/ci.md).

## Where to go next

| If you want to… | Read |
|---|---|
| Understand the words used above | [Core concepts](concepts.md) |
| See every command and flag | [CLI command reference](cli/commands.md) |
| Wire this into your framework | [Next.js](guides/nextjs.md) · [Node.js](guides/nodejs.md) · [React / Vite](guides/react-vite.md) · [Go](guides/go.md) |
| Add your team | [Teams, roles and access](guides/teams.md) |
| Know exactly what we can see | [Trust model](security/trust-model.md) |
| Fix something that went wrong | [Troubleshooting](troubleshooting.md) |

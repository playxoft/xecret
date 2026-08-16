---
title: Installing the CLI
navTitle: Installing the CLI
description: Install the xecret command-line tool on macOS, Linux, Windows, in Docker and in CI — with checksum verification and upgrade instructions.
keywords: [install xecret cli, homebrew xecret, curl install script, xecret windows, xecret docker install]
updated: 2026-08-16
---

The `xecret` binary is a single static executable written in Go
(`CGO_ENABLED=0`), for macOS, Linux and Windows on both amd64 and arm64. It has
no runtime dependencies — no Node, no Python, no shared libraries — which is
what lets it drop into a scratch container.

The CLI is MIT-licensed, unlike the server, so it can live inside your Docker
images and CI pipelines without licence friction.

## macOS

```bash
brew install playxoft/tap/xecret
```

Upgrade with `brew upgrade xecret`.

## Linux, WSL and CI

```bash
curl -fsSL https://xecret.playxoft.com/install.sh | sh
```

The script detects your OS and architecture, downloads the matching release
archive, **verifies its checksum**, and installs to `/usr/local/bin` (or
`~/.local/bin` if that is not writable).

> **Note** — Piping a script to a shell deserves scepticism. The security
> boundary here is the checksum verification inside the script, not the URL:
> the URL redirects to the canonical installer, and you are welcome to fetch it
> and read it before running it.
>
> ```bash
> curl -fsSL https://xecret.playxoft.com/install.sh -o install.sh
> less install.sh
> sh install.sh
> ```

### A specific version

```bash
curl -fsSL https://xecret.playxoft.com/install.sh | sh -s -- --version v1.2.0
```

Pinning a version is the right default in CI: an installer that always fetches
the newest release makes your pipeline depend on our release schedule.

## Windows

Download the `windows_amd64` or `windows_arm64` archive from the releases page,
unzip it, and put `xecret.exe` somewhere on your `PATH`.

The CLI stores its credential in **Windows Credential Manager**. PowerShell,
`cmd.exe` and WSL all work; under WSL you are using the Linux binary and the
Linux keyring rules apply.

## Docker

Copy the binary into your image rather than installing it at build time — one
fewer network call in every build:

```dockerfile
FROM alpine:3 AS xecret
RUN apk add --no-cache curl \
 && curl -fsSL https://xecret.playxoft.com/install.sh | sh

FROM node:22-slim
COPY --from=xecret /usr/local/bin/xecret /usr/local/bin/xecret
```

Full patterns, including why you should not bake secrets into layers, are in
[Docker](guides/docker.md).

## Verify the install

```bash
xecret version
```

prints the version, the commit it was built from, the build date, and your
platform. If the shell answers `command not found`, the install directory is
not on your `PATH` — reopen your terminal, or add it:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## Pointing at a self-hosted deployment

The binary ships with `https://xecret.playxoft.com` compiled in as its default
server. To use your own:

```bash
xecret login --api-url https://secrets.your-company.com
```

The URL is stored with the credential, so you only pass it once. In CI, where
there is no stored login, set `XECRET_API_URL` beside `XECRET_TOKEN`. See
[configuration](cli/configuration.md).

## Upgrading

| Installed with | Upgrade with |
|---|---|
| Homebrew | `brew upgrade xecret` |
| Install script | Run the same command again; it replaces the binary in place. |
| Manual download | Download the new archive and replace the binary. |

Your stored credential survives an upgrade. It lives in the OS keychain, not
beside the binary.

## Uninstalling

```bash
xecret logout          # revokes this device's credential server-side
                       # and wipes the encrypted offline cache
```

Then remove the binary (`brew uninstall xecret`, or delete it from
`/usr/local/bin`) and, if you want nothing left behind, the `~/.xecret/`
directory.

Running `logout` first matters: deleting the binary leaves the credential valid
on the server. If you have already deleted it, revoke the device from the
dashboard under *Tokens → Your devices*.

## Next

- [The CLI](cli.md) — what it does and the rules it follows.
- [Quickstart](quickstart.md) — sign in and run something.

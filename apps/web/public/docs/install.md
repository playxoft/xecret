---
title: Installing the CLI
navTitle: Installing the CLI
description: Install the xecret command-line tool on macOS, Linux, Windows, from npm, in Docker and in CI — with checksum verification and upgrade instructions.
keywords: [install xecret cli, homebrew xecret, npm install xecret, curl install script, xecret windows, xecret docker install]
updated: 2026-08-18
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
curl -fsSL https://xecret.playxoft.com/install.sh | XECRET_VERSION=v1.2.0 sh
```

The version is an environment variable, not a flag — the installer reads
`XECRET_VERSION` and parses no arguments at all, so anything after `-s --` is
silently discarded and you get the latest release instead.

Pinning a version is the right default in CI: an installer that always fetches
the newest release makes your pipeline depend on our release schedule.

## npm

```bash
npm install -g @playxoft/xecret
```

Or as a dev dependency, so everyone on the project gets the same version from
the lockfile:

```bash
npm install --save-dev xecret
npx @playxoft/xecret run -- npm run dev
```

`xecret` is a small wrapper whose `optionalDependencies` are six packages
holding one executable each — npm installs exactly the one that matches your
machine and skips the other five.

> **Note** — There is no `postinstall` script and nothing is downloaded during
> the install. That is deliberate. `npm ci --ignore-scripts` is a sensible thing
> to run, and a secret manager whose installer silently broke under it would be
> teaching people to turn that protection off. Shipping the binary *as* a
> package also puts it under npm's own `integrity` hash in your lockfile,
> checked on every install, instead of behind a download our own code would have
> to verify.

The published packages carry [npm
provenance](https://docs.npmjs.com/generating-provenance-statements): the
registry can show you the workflow run and the commit each tarball was built
from. The binaries inside are the same ones the GitHub release serves, verified
against the signed `checksums.txt` before they were packaged.

One trade-off worth knowing: installed this way, a Node process sits in front of
the binary for the life of each command. It costs a few milliseconds and one
process. For `xecret run -- npm run dev`, which runs for hours, Homebrew or the
install script are the better choice — they give you the executable and nothing
else.

## Windows

Download the `windows_amd64` or `windows_arm64` archive from the releases page,
unzip it, and put `xecret.exe` somewhere on your `PATH`.

`npm install -g @playxoft/xecret` works on Windows too, and is usually the shortest route
if you already have Node.

The CLI stores its credential in **Windows Credential Manager**. PowerShell,
`cmd.exe` and WSL all work; under WSL you are using the Linux binary and the
Linux keyring rules apply.

## Docker

Copy the binary out of the published image rather than installing it at build
time — no package manager, no network fetch, and a version you pinned:

```dockerfile
FROM ghcr.io/playxoft/xecret:1.2.0 AS xecret

FROM node:22-slim
COPY --from=xecret /usr/local/bin/xecret /usr/local/bin/xecret
```

`ghcr.io/playxoft/xecret` is a multi-arch (amd64 and arm64) distroless image
carrying the same static binary the installer would have fetched. The image
tags carry the version *without* the leading `v` — `1.2.0`, not `v1.2.0` —
because that is what GoReleaser templates from, the same way the archive names
do. Pin it: an unpinned install resolves the latest release at build time, so
the same Dockerfile would produce a different binary on every rebuild.

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

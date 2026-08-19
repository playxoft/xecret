# xecret

Open-source, developer-first secret management. `xecret run` fetches your
secrets, injects them into your process, and exits with whatever your command
exited with — the values never touch disk, argv or stdout.

```bash
npm install -g xecret

xecret login
xecret init
xecret run -- npm run dev
```

Full documentation: **https://xecret.playxoft.com/docs**

## What this package is

The `xecret` binary is a single static executable written in Go. This package
installs it — it is a small wrapper whose `optionalDependencies` are six
platform packages holding one executable each, and npm installs exactly the one
that matches your machine.

**There is no `postinstall` script and nothing is downloaded at install time.**
That is deliberate: `npm ci --ignore-scripts` is a sensible thing to run, and a
secret manager whose installer breaks under it would be teaching people to turn
the protection off. Shipping the binary *as* a package also puts it under npm's
own integrity hash in your lockfile, verified on every install.

If you would rather not have Node in front of the binary at all:

```bash
brew install playxoft/tap/xecret
curl -fsSL https://xecret.playxoft.com/install.sh | sh
```

Both install the same executable, checksum-verified. For long-running processes
— `xecret run -- npm run dev` — the standalone binary is the better choice: the
npm wrapper keeps a Node process alive alongside your command for the life of
the run.

## Common commands

```bash
xecret login                       # browser consent + PKCE; token → OS keychain
xecret init                        # writes .xecret.yaml (two slugs, no secrets)
xecret run -- npm run dev          # the golden path
xecret secrets list                # masked listing
xecret secrets set STRIPE_KEY      # value from stdin or a hidden prompt
xecret secrets versions STRIPE_KEY # history, metadata only
xecret import .env --dry-run       # see the plan before writing
xecret help
```

In CI, set `XECRET_TOKEN` and nothing else — the token's own scope answers which
organisation, project and environment to use:

```bash
XECRET_TOKEN=xst_… xecret run -- npm run build
```

## Requirements

Node 18 or newer, on macOS, Linux or Windows (x64 or arm64). The binary itself
has no runtime dependencies — it is `CGO_ENABLED=0`, so it runs in scratch,
distroless and Alpine images alike.

## Licence

MIT. The xecret server is AGPL-3.0; the CLI is deliberately not, so it can live
inside your images and pipelines without licence friction.

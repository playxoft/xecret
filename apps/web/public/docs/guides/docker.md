---
title: xecret with Docker
navTitle: Docker
description: Keep secrets out of image layers — runtime injection, BuildKit secret mounts, Compose, and the export format that exists only for docker run.
keywords: [docker secrets, dockerfile env secrets, buildkit secret mount, docker compose env, container secret management]
updated: 2026-08-16
---

One rule shapes everything on this page:

> **Important** — A secret must never end up in an image layer. `ENV`, `ARG`
> and `COPY .env` all bake the value into image history, where
> `docker history` reads it back out of any copy of the image, forever.

## Runtime injection — the right default

Do not put secrets in the image at all. Build an image that expects its
configuration from the environment, and supply it when the container runs.

```dockerfile
# Dockerfile — no secrets anywhere in it
FROM node:22-slim
WORKDIR /app
COPY . .
RUN npm ci && npm run build
CMD ["node", "server.js"]
```

```bash
xecret run -- docker run --rm \
  -e DATABASE_URL -e STRIPE_SECRET_KEY \
  my-app
```

The mechanism is worth understanding. `xecret run` puts the values into *its
own* process environment. `-e NAME` with **no `=value`** tells Docker to
forward the variable of that name from the surrounding environment. The value
therefore never appears on a command line, in your shell history, or in `ps`
output.

Writing `-e DATABASE_URL="$DATABASE_URL"` would undo all of that.

## When the container should fetch its own secrets

For an orchestrator that cannot forward a long list of variables, put the CLI
in the image and make it the entrypoint:

```dockerfile
FROM alpine:3 AS xecret
RUN apk add --no-cache curl \
 && curl -fsSL https://xecret.playxoft.com/install.sh | sh

FROM node:22-slim
COPY --from=xecret /usr/local/bin/xecret /usr/local/bin/xecret
WORKDIR /app
COPY . .
RUN npm ci && npm run build
ENTRYPOINT ["xecret", "run", "--"]
CMD ["node", "server.js"]
```

```bash
docker run --rm -e XECRET_TOKEN=xst_… my-app
```

What you are trading: the container now needs network access to xecret at
start-up, and one credential (`XECRET_TOKEN`) instead of many. That is often a
good trade — one secret to manage in your orchestrator rather than twenty — but
it does mean a xecret outage delays a container restart. There is no offline
cache under a service token, deliberately; see
[the offline cache](../cli/offline-cache.md).

Keep the token scoped to exactly one project and environment, read-only.

## Build-time secrets

Sometimes a build genuinely needs a credential — a private npm registry, a
private Go module proxy. Use **BuildKit secret mounts**, the one mechanism that
keeps the value out of layers and build history:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-slim
WORKDIR /app
COPY . .
# The secret exists only for this RUN, as a tmpfs file. It is in no layer.
RUN --mount=type=secret,id=npm_token \
    NPM_TOKEN="$(cat /run/secrets/npm_token)" npm ci
```

Feed one value from xecret into the mount without it touching disk:

```bash
XECRET_TOKEN=xst_… xecret secrets get NPM_TOKEN --plain \
  | docker build --secret id=npm_token,src=/dev/stdin .
```

## Docker Compose

Compose reads `env_file` and `environment` from the host. Inject at the point
you run Compose:

```yaml
# compose.yaml
services:
  api:
    build: .
    environment:
      - DATABASE_URL
      - STRIPE_SECRET_KEY
```

```bash
xecret run -- docker compose up
```

Again: names only, no `=value`. Compose forwards each from the environment
`xecret run` created.

For a stack where each service needs a different environment, run Compose under
the widest one and scope inside your application, or split the services into
separate projects with separate tokens.

## The `docker` export format

`xecret pull --format docker` produces the shape `docker run --env-file`
expects. It exists for **runtime** use:

```bash
xecret pull --format docker -o /run/secrets.env   # 0600
docker run --env-file /run/secrets.env my-app
rm /run/secrets.env
```

Even here you are writing plaintext to disk, so prefer the `-e NAME` form
above. Never feed this format to `docker build`.

## What not to do

```bash
# ✗ bakes every secret into a layer, readable with `docker history`
xecret pull --format docker > args.txt && docker build $(cat args.txt) .
```

```dockerfile
# ✗ the file is in the layer even if a later step deletes it
COPY .env .env

# ✗ ARG and ENV values are visible in image metadata
ARG STRIPE_SECRET_KEY
ENV STRIPE_SECRET_KEY=$STRIPE_SECRET_KEY
```

Deleting a file in a later layer does not remove it from the image. Each layer
is kept.

## Kubernetes and other orchestrators

The same fork applies:

- **Sync into the platform's own secret store** at deploy time, and let the
  platform mount them. Your workloads need no xecret access at all.
- **Give each workload a service token** and use `xecret run` as the
  entrypoint, as above.

The first is the conventional choice for production clusters; the second is
simpler to keep in sync. Both are legitimate — pick one deliberately rather
than ending up with half of each.

## Next

- [Secrets in CI](ci.md) — building the image.
- [Tokens](../api/tokens.md) — scoping the credential the container holds.
- [The offline cache](../cli/offline-cache.md) — why CI and containers have none.

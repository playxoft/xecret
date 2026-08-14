# xecret in Docker builds

The rule that shapes everything here: **a secret must not end up in an image
layer.** `ENV`, `ARG`, and `COPY .env` all bake the value into image history,
where `docker history` reads it back out forever.

## Runtime secrets (the right default)

Do not put secrets in the image at all. Inject them when the container runs:

```dockerfile
# Dockerfile — no secrets anywhere
FROM node:22-slim
WORKDIR /app
COPY . .
RUN npm ci && npm run build
CMD ["node", "server.js"]
```

```bash
# The host (or orchestrator) runs the container through xecret:
xecret run -- docker run --rm \
  -e DATABASE_URL -e STRIPE_KEY \
  my-app
```

`xecret run` puts the values in *its* environment; `-e NAME` (no `=value`)
forwards them into the container without ever writing them down.

## Build-time secrets (when a build genuinely needs one)

Use BuildKit secret mounts — the one mechanism that keeps the value out of
layers and build history:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-slim
WORKDIR /app
COPY . .
# The secret exists only during this RUN, as a tmpfs file.
RUN --mount=type=secret,id=npm_token \
    NPM_TOKEN="$(cat /run/secrets/npm_token)" npm ci
```

```bash
# Feed one value from xecret into the mount without touching disk:
XECRET_TOKEN=xst_... xecret secrets get NPM_TOKEN --plain \
  | docker build --secret id=npm_token,src=/dev/stdin .
```

## What not to do

```bash
# ✗ Bakes every secret into a layer:
xecret pull --format docker > args.txt && docker build $(cat args.txt) .
# ✗ Same problem with extra steps:
COPY .env .env
```

The `docker` export format exists for `docker run --env-file` at *runtime* —
never for `docker build`.

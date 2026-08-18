# xecret with Go

## Local development

Go reads configuration from `os.Getenv` — no loader library needed, which
makes this the shortest guide:

```go
dsn := os.Getenv("DATABASE_URL")
```

```bash
xecret init
xecret run -- go run ./cmd/server
```

Tests too:

```bash
xecret run -- go test ./...
```

If the project currently uses `godotenv`, delete the import and the `.env`
file — `xecret import .env` first, so nothing is lost.

## CI

```yaml
- uses: playxoft/xecret@v1
- run: xecret run -- go build ./...
  env:
    XECRET_TOKEN: ${{ secrets.XECRET_TOKEN }}
```

## Docker

Go's static binaries pair naturally with secret-free images: build without
secrets, inject at runtime.

```dockerfile
FROM golang:1.25 AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -o /app ./cmd/server

FROM gcr.io/distroless/static-debian12
COPY --from=build /app /app
ENTRYPOINT ["/app"]
```

```bash
xecret run -- docker run --rm -e DATABASE_URL -e API_KEY my-app
```

`-e NAME` with no value forwards the variable from `xecret run`'s environment
into the container — the value never appears in the command line or the image.
The full set of Docker patterns, including BuildKit secret mounts for the rare
build-time secret, is in [`examples/ci/docker/`](../../examples/ci/docker/README.md).

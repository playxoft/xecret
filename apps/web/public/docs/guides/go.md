---
title: xecret with Go
navTitle: Go
description: Use xecret in a Go project — go run and go test under injected secrets, reading configuration at startup, and building static binaries in CI.
keywords: [go environment variables, os.Getenv, go secrets management, go test env, golang configuration]
updated: 2026-08-16
---

Go reads configuration with `os.Getenv`. `xecret run` supplies it. No library,
no code change.

```bash
xecret init
xecret run -- go run ./cmd/server
xecret run -- go test ./...
```

## Reading configuration

The Go convention is to read every variable once at startup and fail loudly
rather than discovering a missing value on the first request at 3am:

```go
package config

import (
	"fmt"
	"os"
	"strconv"
)

type Config struct {
	DatabaseURL   string
	SessionSecret string
	Port          int
}

func Load() (*Config, error) {
	cfg := &Config{
		DatabaseURL:   os.Getenv("DATABASE_URL"),
		SessionSecret: os.Getenv("SESSION_SECRET"),
		Port:          8080,
	}

	// Names only. A configuration error must never print the value it
	// rejected — in this program the rejected value is a credential.
	for name, value := range map[string]string{
		"DATABASE_URL":   cfg.DatabaseURL,
		"SESSION_SECRET": cfg.SessionSecret,
	} {
		if value == "" {
			return nil, fmt.Errorf("missing %s (is this running under `xecret run`?)", name)
		}
	}

	if port := os.Getenv("PORT"); port != "" {
		parsed, err := strconv.Atoi(port)
		if err != nil {
			return nil, fmt.Errorf("PORT is not a number")
		}
		cfg.Port = parsed
	}

	return cfg, nil
}
```

If `PORT` is a number, declare that in xecret too and the server will refuse a
bad write in the first place:

```bash
xecret secrets set PORT --type int
```

## Tests

`go test` runs each package's tests in a separate process, and each inherits the
environment `xecret run` created — so one wrapper covers the whole run:

```bash
xecret run --environment test -- go test ./...
```

Create a `test` environment beside `development` so a test run can never reach
real credentials. Tests that need no configuration at all are better still:
prefer passing a `Config` value into your constructors over reading
`os.Getenv` deep inside them.

## Makefile

```makefile
.PHONY: dev test build

dev:
	xecret run -- go run ./cmd/server

test:
	xecret run --environment test -- go test ./... -race

build:
	CGO_ENABLED=0 go build -o dist/server ./cmd/server
```

`build` deliberately has no `xecret run`: compiling a Go binary needs no
secrets. Only commands that *execute* your code do.

## CI

```yaml
# GitHub Actions
- uses: actions/setup-go@v5
  with: { go-version: '1.25' }
- uses: playxoft/xecret@v1
- run: xecret run -- go test ./... -race
  env:
    XECRET_TOKEN: ${{ secrets.XECRET_TOKEN }}
```

Point the token at your `test` environment, read-only. A test run has no
business holding a write credential. Full recipes: [secrets in CI](ci.md).

## In production

A compiled Go binary usually runs in a container or under systemd, taking its
environment from the platform. Two options:

- **The platform supplies the environment** — the usual arrangement. Sync it
  from xecret at deploy time.
- **The container fetches its own** — `xecret run -- /app/server` as the
  entrypoint, with a service token in the container's environment. Simpler to
  keep in sync, at the cost of the process needing network access to xecret at
  start-up. [Docker](docker.md) covers both.

## Next

- [Docker](docker.md) — shipping the binary.
- [Secrets in CI](ci.md) — service tokens end to end.
- [Node.js](nodejs.md) — the same patterns in another runtime.

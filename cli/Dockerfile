# ghcr.io/playxoft/xecret — the CLI as a CI image.
#
# Built by GoReleaser, which supplies the already-compiled static binary as the
# build context; there is deliberately no `go build` here, so the image cannot
# drift from the released artifact it ships.
#
# Distroless static, nonroot: the binary is CGO_ENABLED=0 (ADR 0004), so the
# image needs nothing but CA certificates — no shell, no package manager, no
# libc. A secrets tool's image should have the smallest possible surface for a
# compromised pipeline step to pivot through.
#
# Usage in CI:
#   docker run --rm -e XECRET_TOKEN ghcr.io/playxoft/xecret pull --format env
FROM gcr.io/distroless/static-debian12:nonroot

COPY xecret /usr/local/bin/xecret

ENTRYPOINT ["/usr/local/bin/xecret"]

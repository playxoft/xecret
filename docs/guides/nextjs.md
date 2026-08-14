# xecret with Next.js

## Local development

Replace `.env.local` with nothing — that is the point:

```bash
xecret init                    # once per repo; commit .xecret.yaml
xecret run -- next dev
```

Everything the server side reads through `process.env` is already there.
Delete `.env.local` and add `.env*` to `.gitignore` if it is not already.

Two Next.js-specific things to know:

- **`NEXT_PUBLIC_` variables are inlined at build time.** They must be in the
  environment of the *build*, so CI runs `xecret run -- next build`. They are
  not secrets once built — anything `NEXT_PUBLIC_` ships to the browser, so
  keep real credentials out of that prefix regardless of where they are
  stored.
- **`next dev` restarts do not re-fetch.** The environment is injected when
  `xecret run` starts the process. After changing a secret, restart the dev
  server (Ctrl-C, run again) — the same moment you would have edited
  `.env.local`.

## CI and deployment

```yaml
- uses: playxoft/xecret@v1
- run: xecret run -- next build
  env:
    XECRET_TOKEN: ${{ secrets.XECRET_TOKEN }}
```

For platforms that inject environment at deploy time (Vercel, Cloudflare,
etc.), keep xecret as the source of truth and sync at deploy:
`xecret pull --format env` in the deploy pipeline, piped to the platform's
secret-setting CLI — never committed.

## Multiple environments

`.xecret.yaml` names the default (`development`). Point a command elsewhere
without editing anything:

```bash
xecret run --environment staging -- next start
```

Production is deny-by-default for developer roles — a grant from an admin, not
a flag, is what changes that.

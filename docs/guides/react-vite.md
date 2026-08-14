# xecret with React + Vite

## Local development

```bash
xecret init
xecret run -- vite
```

Vite exposes environment variables to client code only when they start with
`VITE_`, via `import.meta.env.VITE_…`. That prefix rule is a **publication
boundary, not a security one**: anything `VITE_` ends up in the shipped
JavaScript bundle, readable by anyone. Keep it to genuinely public
configuration — API base URLs, feature flags, publishable keys.

Real secrets belong on whatever backend the app talks to — which is where
xecret injects them:

```bash
# the API server the Vite app calls
xecret run --project backend -- node server.js
```

## Builds and CI

`import.meta.env` values are inlined at build time, so the build needs them in
its environment:

```yaml
- uses: playxoft/xecret@v1
- run: xecret run -- vite build
  env:
    XECRET_TOKEN: ${{ secrets.XECRET_TOKEN }}
```

## The habit worth breaking

A `.env` file next to `vite.config.ts` is the default Vite teaches. After
moving to xecret, delete it and let `.gitignore` keep it gone — `xecret
import .env` exists precisely so the file's last useful act is being imported.

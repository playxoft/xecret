---
title: xecret with Node.js
navTitle: Node.js
description: Use xecret in any Node project — npm scripts, dotenv removal, TypeScript, monorepos, tests, and reading configuration safely at startup.
keywords: [nodejs secrets, dotenv replacement, process.env node, npm scripts secrets, node environment variables]
updated: 2026-08-16
---

Node reads configuration from `process.env`. `xecret run` fills it. There is no
SDK to install and no code to change.

## The one change to make

```bash
xecret init                     # once per repository; commit .xecret.yaml
xecret run -- node server.js
```

Then delete the `dotenv` call and the `.env` file:

```js
// before
import 'dotenv/config';
const url = process.env.DATABASE_URL;

// after — the import is gone; the second line is unchanged
const url = process.env.DATABASE_URL;
```

Keep `dotenv` as a dependency only if something else in your toolchain needs
it. It is harmless when there is no `.env` for it to load, but leaving it in
place is a second source of truth waiting to disagree with the first.

## npm scripts

Put `xecret run` in the script, so nobody has to remember it:

```json
{
  "scripts": {
    "dev": "xecret run -- node --watch server.js",
    "start": "node server.js",
    "test": "xecret run --environment development -- node --test",
    "migrate": "xecret run -- node scripts/migrate.js"
  }
}
```

Note `start` has no `xecret run`. In production the environment is usually
supplied by the platform — a container's env vars, a systemd unit — and the
process should read whatever it is given. Wrapping `start` too would mean your
production container needs network access to xecret at boot.

> **Tip** — If you *do* want the container to fetch its own secrets at boot,
> that is a legitimate pattern, and [Docker](docker.md) covers it, including
> the trade-off you are accepting.

## Fail fast on missing configuration

`xecret run` guarantees the variables that exist in the environment you chose
are present. It cannot know your code needs one you never stored. Validate at
startup, where the error is cheap:

```js
const REQUIRED = ['DATABASE_URL', 'SESSION_SECRET', 'STRIPE_SECRET_KEY'];

const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing configuration: ${missing.join(', ')}`);
  console.error('Are you running under `xecret run`, and is the environment right?');
  process.exit(1);
}
```

Never log the values, only the names. A crash report that helpfully prints your
configuration is a crash report that leaks it.

## TypeScript

Nothing special is required, but typing the variables you depend on turns a
runtime surprise into a compile-time one:

```ts
// env.ts
const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

export const config = {
  databaseUrl: required('DATABASE_URL'),
  sessionSecret: required('SESSION_SECRET'),
  port: Number(process.env.PORT ?? 3000),
} as const;
```

## Monorepos

`.xecret.yaml` is found by walking up from the working directory, the way
`git` finds `.git`. Two arrangements both work:

- **One file at the repository root** — every package shares an environment.
  Simple, and right when the packages deploy together.
- **One file per package** — each service gets its own project and its own
  secrets. Right when they deploy separately.

```text
repo/
├── .xecret.yaml            project: platform, environment: development
├── apps/api/               inherits the root file
└── apps/worker/
    └── .xecret.yaml        project: worker, environment: development
```

The nearest file wins, because the walk stops at the first one it finds.

## Tests

Point tests at a dedicated environment so a test run can never touch real
credentials:

```json
{ "scripts": { "test": "xecret run --environment test -- vitest run" } }
```

Create a `test` environment in the dashboard alongside `development`. Its
values can be fakes — the point is that they are managed and shared rather than
invented per machine.

## Reading a single secret in a script

For a one-off script that needs exactly one value, `xecret run` is still the
right answer. But `secrets get --plain` composes when you need the value as a
string:

```bash
psql "$(xecret secrets get DATABASE_URL --plain)"
```

Every `--plain` read is audited, which is the intended trade: convenient, and
recorded.

## Next

- [Next.js](nextjs.md) — build-time variables and `NEXT_PUBLIC_`.
- [Docker](docker.md) — containers, without baking secrets into layers.
- [Secrets in CI](ci.md) — service tokens.

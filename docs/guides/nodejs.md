# xecret with Node.js

## The short version

Remove `dotenv` and stop reading files:

```diff
- require('dotenv').config();
  const db = connect(process.env.DATABASE_URL);
```

```bash
xecret run -- node server.js
```

`xecret run` puts every secret into the child's environment before your first
line executes — `process.env` simply has the values, with no loader, no import
order problem, and no file on disk.

## Scripts and tooling

Anything that reads `process.env` works unchanged:

```bash
xecret run -- npm test
xecret run -- npx prisma migrate deploy
xecret run -- node --env-file=/dev/null server.js   # belt and braces: no stray file
```

package.json scripts stay portable — put `xecret run --` in front of the
invocation, not inside the script, so contributors without xecret can still
read what the script does:

```bash
xecret run -- npm run start
```

## Production and CI

```bash
XECRET_TOKEN=xst_... xecret run -- node server.js
```

For long-running production processes, remember the injection is at start:
rotating a secret takes effect on the next process start, exactly as it would
with any environment-variable deployment. Pair rotations with your normal
restart/rollout mechanism.

## What not to do

`xecret pull --format env > .env` recreates the problem you just removed. It
exists for legacy pipelines that cannot be changed and warns on stderr every
time it runs.

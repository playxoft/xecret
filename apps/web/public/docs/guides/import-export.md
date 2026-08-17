---
title: Importing and exporting secrets
navTitle: Import and export
description: Move secrets in and out of xecret — .env, JSON, YAML and shell formats, conflict strategies, dry runs, and migrating from another secret manager.
keywords: [import env file, migrate secrets, dotenv import, export secrets, secret migration, bulk secret upload]
updated: 2026-08-16
---

Getting your existing configuration in, and getting it out again if you ever
want to leave. Both matter: a secret manager you cannot export from is a secret
manager that has taken your configuration hostage.

## Importing from the dashboard

Open a project, pick an environment, and drag your file into the import dialog.

The file is parsed **in your browser**. A dry-run preview shows exactly what
will be created, renamed or skipped, and only the resulting plan is sent — so a
pasted blob of production credentials never becomes a request body.

Supported formats, auto-detected:

| Format | Looks like |
|---|---|
| `dotenv` | `KEY=value`, with or without `export `, quotes, and `#` comments |
| `json` | A flat object of string values |
| `yaml` | A flat mapping |
| `shell` | A script of `export KEY=value` lines |

Multiline PEM blocks, CRLF line endings and trailing comments all parse the way
you would hope.

## Importing from the CLI

```bash
xecret import .env --dry-run
xecret import .env --strategy overwrite
xecret import config.json --format json
```

| Flag | Effect |
|---|---|
| `--format` | Force a parser instead of detecting one |
| `--strategy skip` | *(default)* leave existing names alone |
| `--strategy overwrite` | append a new version for names that already exist |
| `--strategy rename` | import under a suffixed name, keeping both |
| `--dry-run` | print the plan and write nothing |
| `--json` | machine-readable output |

**Always dry-run first against a production environment.** The preview is
produced by the same planning code the real import runs, so it cannot disagree
with the outcome.

Files are limited to 1 MB, and a single secret value to 64 KB.

### Names that need fixing

Secret names must match your shell's rules: letters, digits and underscores,
never starting with a digit. If your source file has `my-key` or `2fa-secret`,
the import reports them rather than silently mangling them. Rename them in the
source file and import again — a rename you did not choose is a rename you will
be debugging at 3am.

## Exporting

```bash
xecret pull --format env
xecret pull --format json | jq 'keys'
xecret pull --format yaml -o config.yaml     # created 0600
```

| Format | Output |
|---|---|
| `env` | `KEY=value` lines, quoted where needed |
| `json` | one object |
| `yaml` | one mapping |
| `shell` | `export KEY=value` lines, for `source` |
| `docker` | the shape `docker run --env-file` expects |

The dashboard has the same thing under the environment's export dialog, as a
file download.

> **Warning** — Every one of these writes plaintext secrets somewhere they
> persist. `pull` says so on stderr each time it runs. Use it to migrate, to
> feed a pipeline that cannot be changed, and to prove to yourself you can
> leave — not as a daily habit. [`xecret run`](../cli/commands.md#run) is the
> daily habit.

## Migrating from another tool

### From `.env` files

The whole job:

```bash
xecret import .env --dry-run          # look at the plan
xecret import .env                    # do it
rm .env                               # and mean it
echo ".env*" >> .gitignore
```

Then replace the run command in your scripts — see
[Node.js](nodejs.md), [Next.js](nextjs.md) or [Go](go.md).

If different developers have drifted apart, collect one canonical file first:
diff two colleagues' `.env` files and reconcile before importing. The import is
a good moment to notice that half the team has a stale Stripe key.

### From another secret manager

Most tools can export a flat `.env` or JSON. Export one environment at a time,
import it into the matching xecret environment, and verify before deleting
anything:

```bash
other-tool export --env production > production.env
xecret import production.env --environment production --dry-run
xecret import production.env --environment production

# verify: the names should match, one for one
diff <(sort -t= -k1,1 production.env | cut -d= -f1) \
     <(xecret pull --environment production --format env | cut -d= -f1 | sort)

shred -u production.env      # or rm, on a filesystem where that is enough
```

Do one environment at a time, starting with `development`. Migrating
production first is how a migration becomes an incident.

### Keeping both for a transition period

While you are moving over, it is reasonable to run both. Make xecret the source
of truth immediately and sync outwards from it — never the reverse — so there
is never a question about which copy is current:

```bash
xecret pull --format env | other-tool import --env production
```

## What is not exported

- **Version history.** `pull` gives you the current value of each secret. Older
  versions stay in xecret; there is no bulk history export.
- **Notes, value types, and grants.** These are metadata about how the
  environment is managed, not configuration your app reads.
- **The audit log.** Available through [the API](../api/reference.md) for
  owners and admins.

## Next

- [Command reference](../cli/commands.md) — `import` and `pull` in full.
- [Core concepts](../concepts.md) — naming rules and value types.
- [Secrets in CI](ci.md) — why `pull > .env` is the anti-pattern there.

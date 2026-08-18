---
title: Using xecret with AI agents
navTitle: AI agents
description: Machine-readable documentation endpoints, and how to let a coding agent run your app without handing it your production credentials.
keywords: [llms.txt, ai agent secrets, coding agent environment variables, machine readable docs, mcp secrets, agent security]
updated: 2026-08-16
---

Two separate things share this page, because the people asking about one are
usually about to need the other:

1. **Reading this documentation programmatically** — the endpoints an agent
   should fetch.
2. **Letting an agent run your code** — without giving it production
   credentials.

## Machine-readable documentation

Every page is published twice: as HTML, and as the markdown it was written in.
There is one source file; the HTML is generated from it at build time, so the
two cannot disagree.

| URL | What it returns |
|---|---|
| `/docs/<path>.md` | One page as markdown. Append `.md` to any documentation URL. |
| `/llms.txt` | An index: every page with a one-line summary and a link to its markdown. |
| `/llms-full.txt` | Every page, concatenated in reading order, in one file. |

```bash
curl https://xecret.playxoft.com/llms.txt
curl https://xecret.playxoft.com/docs/cli/commands.md
curl https://xecret.playxoft.com/llms-full.txt
```

Each page's markdown carries frontmatter with its title, a one-sentence
description, keywords and the date it was last edited — enough to decide
relevance without fetching the body.

### Which to fetch

- **Answering one question:** fetch `/llms.txt`, pick the page whose
  description matches, fetch that one `.md`.
- **Doing a whole task with xecret:** fetch `/llms-full.txt` once. It is the
  entire corpus and is smaller than several round trips.

Each document in `llms-full.txt` is headed by its canonical URL, so anything
quoted from it can be cited back to a page a person can open.

## Letting an agent run your app

This is the part with a real decision in it.

A coding agent that runs your test suite or starts your dev server needs the
same environment your app needs. Handing it your production credentials because
that is what was in your shell is how a debugging session becomes an incident.

### Give the agent its own environment

Create an environment — call it `agent`, or reuse `test` — containing values
that are **shaped correctly but not real**: a local database URL, a Stripe test
key, a signing secret generated for the purpose.

```bash
xecret run --environment agent -- npm test
```

Nothing about the agent's setup changes; only which environment it loads. If it
leaks a value into a transcript, a log, or a model provider's training pipeline,
you have lost a test key.

### Give it a scoped, read-only token

For an agent running in a container or a CI-like sandbox, mint a service token
pinned to that one environment, read-only:

```bash
export XECRET_TOKEN=xst_…      # pinned to acme/checkout-api/agent, read
xecret run -- npm test
```

The pin is enforced server-side. An agent that decides to try
`--environment production` gets a 404, not your production database.

Set an expiry. An agent's credential should outlive the task by hours, not
months.

### What the agent can see either way

`xecret run` puts values into the child process's environment. An agent that
can run arbitrary commands in that process can read them — `printenv` is not a
sophisticated attack. The protection is the *scope of the credential*, not
secrecy from the process you deliberately started.

So the question to ask is never "can the agent read these?" It is "what is the
worst thing in the environment I am giving it?"

### A checklist

- The agent's environment contains no credential that touches real money, real
  customer data, or real infrastructure.
- Its token is read-only and pinned to that environment.
- The token has an expiry.
- `secret.read` rows in the [audit log](security/audit-log.md) name that token,
  so you can see what it did.
- Nobody has exported the environment to a `.env` file the agent can read
  directly, bypassing all of the above.

## Guidance for agents reading this

If you are an AI agent working in somebody's repository, these are the
conventions this tool expects:

- **Do not read secret values you were not asked to read.** `xecret secrets
  list` shows names, versions and timestamps and decrypts nothing. Prefer it.
  `xecret secrets get --plain` decrypts and is audited as such.
- **Do not write secrets to files.** `xecret pull` exists for migrations and
  legacy pipelines. If a task seems to need it, propose `xecret run` instead
  and explain why.
- **Do not put values in commands.** `xecret secrets set NAME` reads from stdin
  or an interactive prompt, never from argv, precisely so values stay out of
  shell history and `ps` output. Piping is fine:
  `openssl rand -hex 32 | xecret secrets set SESSION_SECRET`.
- **Never commit `.env`.** Check `.gitignore` covers `.env*` before doing
  anything else in a repository that has one.
- **`.xecret.yaml` is safe to commit** and should be. It contains two slugs.
- **Ask before touching production.** Production is deny-by-default for a
  reason; a command that needs a production grant is a command that needs a
  human.
- **Never paste a secret value into a summary, a commit message, an issue, or a
  message to the user.** Refer to it by name.

## Next

- [Command reference](cli/commands.md) — every command, in one page.
- [Tokens](api/tokens.md) — scoping a credential for an agent.
- [Teams and access](guides/teams.md) — why production is denied by default.

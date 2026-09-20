---
title: Using xecret with AI agents
navTitle: AI agents
description: The one-line skill install for Claude, ChatGPT, Gemini and every other coding agent, the machine-readable documentation endpoints, and letting an agent run your app without production credentials.
keywords: [llms.txt, ai agent skill, claude skill, chatgpt gemini agent, ai agent secrets, coding agent environment variables, machine readable docs, agent security]
updated: 2026-09-20
---

Three separate things share this page, because the people asking about one are
usually about to need the next:

1. **Teaching an agent to use xecret** — one document, one line to install it.
2. **Reading this documentation programmatically** — the endpoints an agent
   should fetch.
3. **Letting an agent run your code** — without giving it production
   credentials.

## The skill

A single document teaches any agent how this product works: the commands, the
scoping rules, the CI story, the errors, and the conventions it is expected to
respect — never print a value, prefer `xecret run` over a `.env` file, ask
before touching production.

It is published at `https://xecret.playxoft.com/skill.md` and is the same
document however you load it.

**In a repository**, for agents that read files — Claude Code, Codex, Cursor,
Antigravity, Gemini CLI, Copilot, Windsurf, Zed:

```bash
curl -fsSL https://xecret.playxoft.com/skill.sh | sh
```

That writes the skill to `.agents/skills/xecret/SKILL.md` and
`.claude/skills/xecret/SKILL.md`, and adds a short pointer to your `AGENTS.md`
so an agent that reads only that file still finds it. It installs at the root
of the repository you are standing in, wherever in the tree you run it from,
and refuses to run outside one; `--no-pointer` skips the instruction files, and
`XECRET_SKILL_DIR` names a directory explicitly. Re-running it upgrades the
copies and leaves your own instructions alone. Commit the result: everyone who
clones the repository gets it, and the next person's agent does not have to be
told twice.

**In a chat**, for ChatGPT, Gemini, Claude or anything else with a browser:

```text
Read https://xecret.playxoft.com/skill.md and follow it whenever I ask you
about xecret, secrets, or environment variables.
```

**Without writing any files**, pipe it straight into whatever you are feeding:

```bash
curl -fsSL https://xecret.playxoft.com/skill.sh | sh -s -- --print
```

Self-hosting? Every deployment serves its own copy, so point at yours and the
agent learns your hostname along with everything else:

```bash
XECRET_SKILL_URL=https://secrets.your-company.com/skill.md \
  sh -c "$(curl -fsSL https://secrets.your-company.com/skill.sh)"
```

The skill is a summary with an escape hatch: it names the endpoints below, so
an agent that needs the exact flags of one command fetches that page rather
than guessing from what it remembers.

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

Create an environment in the dashboard — call it `agent`, or reuse `test` —
containing values that are **shaped correctly but not real**: a local database
URL, a Stripe test key, a signing secret generated for the purpose.

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

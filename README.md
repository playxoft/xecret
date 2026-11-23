<div align="center">

# xecret

**Open-source secret management that gets out of your way.**

Stop emailing `.env` files. Store secrets once, inject them anywhere.

*Powered by [Playxoft](https://playxoft.com)*

</div>

---

```bash
xecret run -- npm run dev
```

Your app starts with every secret already in `process.env`. No `.env` file on
disk, no secrets in Slack, no "works on my machine".

> The hosted service runs at [xecret.playxoft.com](https://xecret.playxoft.com):
> end-to-end encryption, the dashboard, the Go CLI, teams and granular access,
> CI service tokens, the audit log, and the docs you are reading. How it is
> secured is at [xecret.playxoft.com/security](https://xecret.playxoft.com/security)
> and [the trust model](https://xecret.playxoft.com/docs/security/trust-model).
> See [the roadmap](docs/ROADMAP.md) and [the docs](docs/README.md).

## Why

| | |
|---|---|
| **End-to-end encrypted** | Values and notes are encrypted on your device before they are sent. We store ciphertext and cannot read it. |
| **Fast** | Runs on Cloudflare's edge. Secret reads make zero external network calls. |
| **Works offline** | An encrypted local cache means an xecret outage never stops your `npm run dev` or your CI build. |
| **Built for CI** | Scoped, read-only service tokens are a first-class feature, not a v2 afterthought. |
| **Import in one step** | Drag in your existing `.env`, JSON, or YAML. Parsing happens in your browser, so a pasted blob of production secrets never becomes a request body. |
| **Auditable** | Every secret read is logged, append-only, enforced by database grants rather than convention. |
| **Actually open source** | AGPL-3.0. Read the code, run it yourself, verify our claims. |

## How it works

```
Dashboard ──▶ create project ──▶ add environments ──▶ add secrets
                                                          │
CLI ──▶ xecret login ──▶ xecret run -- npm run dev ───────┘
                              │
                              └──▶ secrets injected into your process environment
```

## Teach your AI agent

One document covers the commands, the scoping rules, the CI story and the
conventions an agent should respect — never print a value, prefer `xecret run`
over a `.env` file, ask before touching production.

```bash
# Claude Code, Codex, Cursor, Antigravity, Gemini CLI, Copilot, Windsurf, Zed
curl -fsSL https://xecret.playxoft.com/skill.sh | sh
```

```text
# ChatGPT, Gemini, Claude, or any chat with a browser
Read https://xecret.playxoft.com/skill.md and follow it whenever I ask you
about xecret, secrets, or environment variables.
```

The installer writes the skill into `.agents/skills/` and `.claude/skills/` and
points your `AGENTS.md` at it. Commit the result and your teammates' agents
know it too. Details, and how to give an agent an environment that holds
nothing real: [AI agents](https://xecret.playxoft.com/docs/ai-agents).

## The security model

**xecret cannot read your secrets.** Secret values and notes are end-to-end
encrypted: the dashboard (Web Crypto) or the CLI encrypts each one with
AES-256-GCM under a per-environment key the client generates, and that key is
sealed (X25519) to every member and service token allowed to read it. Private
keys leave your devices only encrypted — wrapped under a User Key that your
master passphrase (Argon2id, run on your device), a passkey or a one-time
recovery code unlocks. A CI service token carries its own private key, so CI
decrypts on the runner. The server stores ciphertext; a database breach, an
insider or a court order gets nothing that opens it.

What the server does see: secret **names**, project and environment names,
members, the audit log of who read what, and billing details. Names are
deliberately plaintext so listing and search stay server-side. And the
guarantee has edges — the dashboard is JavaScript we serve, public keys are
trusted on first use, grant signatures are not yet verified. We list them
rather than bury them: [what xecret can and cannot see](https://xecret.playxoft.com/docs/security/trust-model) ·
[ADR 0009](docs/adr/0009-zero-knowledge-encryption.md) ·
[crypto spec](docs/security/e2ee-crypto-spec.md) ·
[Security policy](SECURITY.md)

## Stack

Next.js 16 on Cloudflare Workers · Neon PostgreSQL via Hyperdrive · Drizzle ·
WorkOS AuthKit (identity only — sessions are ours) · Go CLI · end-to-end
encryption (AES-256-GCM, X25519, Argon2id)

Every significant decision is written down in [`docs/adr/`](docs/adr/), including
the trade-offs we accepted.

## Development

```bash
git clone https://github.com/playxoft/xecret.git
cd xecret
npm install

# Secrets come from Phase.dev — there is no .env file to create.
phase run -- npm run dev
```

| Command | What it does |
|---|---|
| `npm run dev` | Next.js dev server |
| `npm run verify` | format, lint, typecheck, test — run before pushing |
| `npm run db:generate` | Generate a migration from schema changes |
| `npm run db:migrate` | Apply pending migrations |
| `npm run cli:build` | Build the Go CLI |
| `npm run preview` | Build and preview on the Workers runtime locally |

Requires Node ≥ 20.9 and Go ≥ 1.25.

## Repository layout

```
apps/web/        Next.js application on Cloudflare Workers   (AGPL-3.0)
cli/             Go CLI — single static binary                (MIT)
packages/core/   crypto · authz · audit · validation          (AGPL-3.0)
packages/db/     Drizzle schema and migrations                (AGPL-3.0)
docs/            ADRs, threat model, architecture
```

`packages/core` deliberately imports nothing runtime-specific, so the
cryptography and authorization logic can be audited and unit-tested in
isolation. See [ADR 0005](docs/adr/0005-monorepo.md).

## Licence

**The server is [AGPL-3.0](LICENSE). The CLI is [MIT](cli/LICENSE).**

In plain terms: run xecret yourself freely. If you modify the server and offer
it as a network service, publish your changes. The CLI is unencumbered so it can
live inside your Docker images and CI pipelines without licence friction.

Reasoning and alternatives considered: [ADR 0007](docs/adr/0007-licensing.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues go to
security@playxoft.com — please do not open a public issue.

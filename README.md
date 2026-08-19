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

> **Status: pre-alpha, feature-complete for v1, not yet deployed.** Phases 0–9
> of 11 are built: crypto core, auth, the secrets API, the dashboard, the Go
> CLI, teams and granular access, CI service tokens, the audit log, and the
> docs you are reading. What remains before real credentials belong here:
> integration against a live database (nothing has run against production
> infrastructure yet) and the Phase 10 security pass. See
> [the roadmap](docs/ROADMAP.md) and [the docs](docs/README.md).

## Why

| | |
|---|---|
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

## Honesty about the security model

xecret uses **server-side envelope encryption**. The service can technically
decrypt your secrets — the same model Doppler uses, and what makes team sharing,
CI tokens, and web import work simply.

If you need a provider that *cannot* read your secrets even in principle, you
need a zero-knowledge product. We would rather say so here than have you find
out later. Full reasoning: [ADR 0001](docs/adr/0001-trust-model.md) ·
[Threat model](docs/security/threat-model.md) · [Security policy](SECURITY.md)

## Stack

Next.js 16 on Cloudflare Workers · Neon PostgreSQL via Hyperdrive · Drizzle ·
Firebase Auth (identity only — sessions are ours) · Go CLI · AES-256-GCM
envelope encryption

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

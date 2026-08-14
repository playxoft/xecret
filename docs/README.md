# xecret documentation

Start here. Each document is written to stand alone; together they cover using
xecret, running it yourself, and the reasoning behind its design.

## Using xecret

| Document | What it answers |
|---|---|
| [Quickstart](quickstart.md) | From sign-up to `xecret run` in a few minutes. |
| [CLI reference](cli/reference.md) | Every command, flag, environment variable and exit convention. |
| [CI recipes](../examples/ci/README.md) | GitHub Actions, GitLab, CircleCI, Docker — service tokens end to end. |
| Framework guides | [Next.js](guides/nextjs.md) · [React / Vite](guides/react-vite.md) · [Node.js](guides/nodejs.md) · [Go](guides/go.md) |

## Running xecret

| Document | What it answers |
|---|---|
| [Self-hosting](self-hosting.md) | The honest dependency list and the full deployment walk-through. |
| [Database setup](operations/database-setup.md) | Neon, migrations, and the restricted application role. |

## How it works — and why

| Document | What it answers |
|---|---|
| [System architecture](architecture/system-architecture.md) | Components, request pipeline, failure modes, budgets. |
| [HTTP API](architecture/api.md) | The contract the dashboard, CLI and CI all speak. |
| [Database schema](architecture/database-schema.md) | Every table, and the invariants behind them. |
| [Threat model](security/threat-model.md) | Ten attacker classes, mitigations, and residual risk — stated plainly. |
| [Key recovery](security/key-recovery.md) | The root-key ceremony, Shamir escrow, and the restore drill. |
| [Colour system](design/colour-system.md) | The token palette, with measured WCAG ratios in both themes. |
| [Architecture decisions](adr/README.md) | ADRs 0001–0008 — the choices that are settled, and why. |

## Contributing

[CONTRIBUTING.md](../CONTRIBUTING.md) covers setup, the six non-negotiable
rules, and the CLA. Security reports go through [SECURITY.md](../SECURITY.md),
never through public issues.

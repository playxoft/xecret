# xecret documentation

## User-facing documentation lives on the site

Everything a user of xecret needs — quickstart, core concepts, the full CLI
reference, framework and CI guides, the HTTP API, the security model and
self-hosting — is published at **`/docs`** on the deployment itself, and its
source is `apps/web/public/docs/`.

That is one copy, published twice: the markdown files are rendered into pages
at build time, and the same files are served verbatim so an agent or a `curl`
can read them. There is an index for machines at `/llms.txt` and the whole set
concatenated at `/llms-full.txt`.

To edit a page, edit its markdown file. `apps/web/src/app/docs/_lib/nav.ts`
decides the order; the frontmatter in each file supplies its title, description
and keywords. `docs-content.test.ts` fails the build on a page nobody linked, a
link that resolves nowhere, or a heading anchor that stopped existing.

> **Note on the overlap.** The user-facing pages that used to live in this
> directory — `quickstart.md`, `cli/reference.md`, `guides/`, `self-hosting.md`
> — are still here and are now superseded by their published counterparts.
> They should be deleted once someone has confirmed nothing external links to
> them; keeping two copies of the same instructions is how the two disagree.

## What stays in this directory

Engineering documentation, for people working on xecret rather than with it.

| Document | What it answers |
|---|---|
| [System architecture](architecture/system-architecture.md) | Components, request pipeline, failure modes, budgets. |
| [HTTP API](architecture/api.md) | The internal contract, with the reasoning behind each decision. |
| [Database schema](architecture/database-schema.md) | Every table, and the invariants behind them. |
| [Threat model](security/threat-model.md) | Ten attacker classes, mitigations, and residual risk. |
| [Key recovery](security/key-recovery.md) | The root-key ceremony, Shamir escrow, and the restore drill. |
| [Database setup](operations/database-setup.md) | Neon, migrations, and the restricted application role. |
| [Logging](operations/logging.md) | The log pipeline and what may never enter it. |
| [Colour system](design/colour-system.md) | The token palette, with measured WCAG ratios in both themes. |
| [Architecture decisions](adr/README.md) | ADRs 0001–0008 — the choices that are settled, and why. |
| [Roadmap](ROADMAP.md) | What is built, what is left, and the reasoning behind the order. |

## Contributing

[CONTRIBUTING.md](../CONTRIBUTING.md) covers setup, the six non-negotiable
rules, and the CLA. Security reports go through [SECURITY.md](../SECURITY.md),
never through public issues.

# The colour system

The palette is defined once, in
[`apps/web/src/app/globals.css`](../../apps/web/src/app/globals.css), as CSS
custom properties with a light theme on `:root` and a dark theme on
`:root[data-theme='dark']`. **Every colour pair there is annotated in place
with its measured WCAG 2.1 contrast ratio** — the stylesheet is the authority;
this page explains the system and quotes the headline numbers.

## Targets

| Class of thing | Target | Criterion |
|---|---|---|
| Body text | **AAA** (≥ 7:1) | SC 1.4.6 |
| Secondary text, every interactive state | **AA** (≥ 4.5:1) | SC 1.4.3 |
| Non-text UI — meaningful borders, focus rings, status fills | **≥ 3:1** | SC 1.4.11 |
| Disabled controls | deliberately below AA (~3.3–3.5:1) | exempt under SC 1.4.3; full contrast would make disabled look enabled |

In a product where a mislabelled environment costs a production outage,
"close enough" contrast is a bug class, not a taste question.

## Token families

Semantic tokens, not raw colours — components speak `bg-surface`,
`text-fg-muted`, `border-line`, never a hex value:

- **Surfaces:** `canvas`, `canvas-inset`, `surface`, `surface-hover`,
  `surface-active`, `overlay`
- **Text:** `fg` (18.31:1 light / 16.31:1 dark — AAA), `fg-muted` (6.86:1 /
  8.83:1 — AA), `fg-subtle` (5.14:1 / 5.40:1 — AA), `fg-disabled`
- **Lines:** `line-subtle`, `line`, `line-strong`; `ring` for focus
  (3.92:1 / 11.02:1 — SC 1.4.11)
- **Accent** ("cipher" cyan) and three status families — `success`,
  `warning`, `danger` — each in the same five-part shape:
  base, `-hover`, `-fg` (text on the fill), `-text` (the colour as text),
  `-tint` + `-line` (washes and borders). Every `-fg` and `-text` value is AA
  in both themes.

## Production is not a colour

The `--production-*` family is **reserved** for marking production
environments and used for nothing else. And because roughly 1 in 12 men
cannot rely on hue, production is never colour alone: the hazard hatching
(`.x-hazard`) and the letterform badge carry the same meaning in greyscale.
The reserved-ness is a rule with teeth — using the production tokens for a
badge that merely wants to look important would erode the one signal that
must never be ambiguous.

## Two themes, one contract

Dark is the primary theme (`data-theme` defaults to `dark`, set pre-paint so
there is no flash of the wrong theme; `system` follows the OS). The contract
is that **every ratio target holds in both themes independently** — the dark
palette is not the light palette inverted, it is re-measured.

## Changing a colour

1. Edit the token in `globals.css`.
2. Re-measure every pair the annotation names (any contrast checker that
   implements WCAG 2.1 relative luminance).
3. Update the annotation. A colour without a current measurement beside it
   does not merge — the annotation *is* the review artifact.

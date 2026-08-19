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
| Disabled controls | deliberately below AA (3.0:1 light, 3.3:1 dark) | exempt under SC 1.4.3; full contrast would make disabled look enabled |

In a product where a mislabelled environment costs a production outage,
"close enough" contrast is a bug class, not a taste question.

## Token families

Semantic tokens, not raw colours — components speak `bg-surface`,
`text-fg-muted`, `border-line`, never a hex value:

- **Surfaces:** `canvas`, `canvas-inset`, `surface`, `surface-hover`,
  `surface-active`, `overlay`
- **Text:** `fg` (19.80:1 light on `surface` / 18.97:1 dark on `canvas` —
  AAA), `fg-muted` (9.59:1 / 8.82:1 — AAA), `fg-subtle` (6.69:1 / 7.21:1 —
  AA+), `fg-disabled` (3.0:1 / 3.3:1 — below AA by design). SC 1.4.3
  exempts disabled controls, so that is the only place it may be used: on
  static text it is simply a contrast failure, which is what it had drifted
  into on the terminal transcripts and the features page.
- **Lines:** `line-subtle`, `line`, `line-strong`; `ring` for focus
  (4.74:1 light on `surface`, 7.66:1 dark on `canvas` — SC 1.4.11)
- **Accent** — monochrome, not a hue: `#171717` in light and `#e5e5e5` in
  dark. It used to be a "cipher" cyan, and the mark that justified it went
  achromatic too, so nothing of *ours* carries a brand colour any more. The
  one exemption is third-party logos used nominatively — Node's green,
  React's two blues, the Gopher blue and Docker's blue, all in
  `components/marketing/brand-logos` — which are those owners' marks
  reproduced unmodified and are not ours to desaturate. Three
  status families — `success`,
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

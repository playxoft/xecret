## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Checklist

- [ ] `npm run lint && npm run typecheck && npm run test` pass (and
      `go vet ./... && go test ./...` in `cli/` if the CLI changed)
- [ ] No secret value can reach a log, an error message, a URL, or an audit
      record through this change (standing rule 4)
- [ ] Authorization still flows through `can()` — no route grew its own check
      (standing rule 5)
- [ ] Security-sensitive behaviour comes with a test that fails without the
      change (CONTRIBUTING rule 6)
- [ ] Conventional Commit message; ADR included if this changes architecture

## Notes for the reviewer

<!-- Anything non-obvious: why this shape, what you ruled out, what to look at
     hardest. -->

---

By submitting, you confirm you can license this contribution under the
repository's licences (AGPL-3.0 server / MIT CLI) — see CONTRIBUTING.md on the
CLA.

# CLA signatures

This branch exists only to hold `.github/cla-signatures.json`, which the CLA
workflow appends to when a contributor agrees.

It is deliberately not `main`. The workflow commits to whichever branch stores
the signatures, and `main` is protected — a protected branch would reject that
commit and the CLA check would fail for everyone. Keeping the record here lets
`main` stay locked without breaking the thing that guards it.

Nothing else belongs on this branch. See `CLA.md` on `main`.

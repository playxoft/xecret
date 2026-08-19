# Contributor Licence Agreement

**Version 0 (draft) — no effective date.** Every later version carries a number
and a date, and a signature binds only the version in force when it was given.

**Status: draft — do not rely on this text.** It was reworded from the Apache
Software Foundation's Individual Contributor Licence Agreement (current version
v2.2) for readability, and a review found that the rewording changed the meaning
in several places — in one clause, reversing it. Those defects are being fixed
by restoring Apache's own wording rather than paraphrasing it again.

Until that is done and a solicitor has read the result, this is not a sound
basis for a contribution, and no outside pull request should be merged against
it. If you signed an earlier version you will be asked again once the final text
lands: a signature against this draft is not agreement to whatever replaces it.

---

## Why this exists

xecret is AGPL-3.0 for the server and MIT for the CLI, and the intention is that
it stays open. This agreement does not change that, and it does not take your
copyright — you keep it, and you can do whatever you like with your own work
elsewhere.

What it does is keep one door open. Without it, the licence could never be
changed once external contributions exist, because every contributor would have
to be found and agree. That is not a hypothetical: it is the reason projects
that later needed to move — to a different open licence, to a source-available
licence such as BSL or FSL which is **not** open source, or to a commercial
exception for a customer who cannot use AGPL — either could not, or spent a year
tracking down people who had long since moved on.

The honest version of the trade: signing this means the maintainers could, in
future, release the project under different terms, including terms you might not
like. The reasoning behind accepting that risk is written up in
[ADR 0007](docs/adr/0007-licensing.md), including its costs. Read it before you
sign — it argues against itself in places, and you should see that.

## Agreement

By signing, you accept the following terms for your past, present and future
contributions to xecret.

**1. Definitions.** "You" means the individual or legal entity signing this
agreement. "Contribution" means any work of authorship you intentionally submit
to this project — code, documentation, configuration, anything — through a pull
request, an issue, or any other channel, excluding anything you clearly mark as
"Not a Contribution".

**2. Copyright licence.** You grant Playxoft and every recipient of software
distributed by Playxoft a perpetual, worldwide, non-exclusive, royalty-free,
irrevocable copyright licence to reproduce your Contribution, prepare derivative
works of it, publicly display and perform it, sublicense it, and distribute it
and those derivative works.

**3. Patent licence.** You grant Playxoft and every recipient of the software a
perpetual, worldwide, non-exclusive, royalty-free, irrevocable patent licence to
make, have made, use, offer to sell, sell, import and otherwise transfer the
work. This applies only to patent claims you own or control that are necessarily
infringed by your Contribution alone or by its combination with the project. If
anyone institutes patent litigation alleging that the project or a Contribution
infringes a patent, any patent licence granted here to that party terminates as
of the date the litigation is filed.

**4. You have the right to grant this.** You confirm that each Contribution is
your original creation, and that you are legally entitled to grant the licences
above. If your employer has rights to work you create, you confirm that you have
permission to contribute on their behalf, or that they have waived those rights,
or that they have signed a corporate version of this agreement.

**5. Third-party material.** If your Contribution includes work that is not your
original creation, you will submit it separately from any of your own, identify
its source and licence, and flag any restriction attached to it — for example by
saying so plainly in the pull request.

**6. No obligations.** You are not expected to provide support for your
Contribution, and unless you choose to, it is provided "as is" without
warranties or conditions of any kind, express or implied, including any warranty
of merchantability or fitness for a particular purpose.

**7. Tell us if something changes.** If any statement you have made here stops
being accurate, you agree to say so.

## Signing

There is nothing to print or post. Open a pull request; a bot will ask you once,
and you reply in the thread with:

```
I have read the CLA and I agree to its terms.
```

Type it on its own, with nothing else in the comment — the check is an exact
match, so a "thanks!" in front of it fails with no explanation.

Four things worth knowing before you do:

- **Everyone whose commits are in the pull request has to sign**, not just
  whoever opened it. A cherry-picked or co-authored commit brings its author in
  too. If a commit's email is not attached to a GitHub account, add it to your
  account or that commit cannot be matched to anyone.
- **What is recorded is public and permanent**: your GitHub username, numeric
  account id, the comment id, the pull request number and a timestamp, committed
  to `.github/cla-signatures.json` in this repository. Your legal name and email
  are not collected.
- **Bot accounts are exempt** — they cannot agree to anything. That exempts the
  account, not the work: a person or an agent submitting substantive code
  through an automated account is contributing, and that needs a signature.
- **You are not asked again** on later pull requests, unless the agreement
  itself changes version.

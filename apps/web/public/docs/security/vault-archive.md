---
title: Resetting your vault, the archive, and the seven-day window
navTitle: Vault reset and archive
description: What happens when you reset a vault you cannot open — the emailed archive and its risk, the seven days to recover, and how to import or open the archive offline.
keywords: [vault reset, lost passphrase, recovery codes, encrypted backup, offline decryption, xecret vault open-archive]
updated: 2026-10-14
---

Your secrets are encrypted with keys only your master passphrase and your
recovery codes can open. Nobody at xecret holds a copy. That is the point of the
product — and it means that if you lose the passphrase **and** every recovery
code, nobody can open your vault for you.

Resetting is the way out of that dead end. It gives you a new, empty vault so you
can keep using your account. This page says exactly what a reset does with the
old one.

## What a reset does

You start a reset from the unlock screen, under **I have lost my passphrase and
every recovery code**. You sign in again, then enter a code we email you. Then:

1. **We email you an archive** of your secrets, still encrypted (see below).
2. **We reset your vault.** You set up a new one straight away, with a new
   passphrase and a new Emergency Kit.
3. **We keep your old vault for seven days.** If your passphrase or a recovery
   code turns up in that time, you can recover it (see below). Nothing in xecret
   can delete it before the seven days are up. After that it is deleted
   automatically, for good.

Your teammates and your organisation's data are not affected. Until you recover
the old vault, an owner or admin will need to share each team environment with
you again; the dashboard asks them to.

**We never reset a vault without its archive unless you choose to.**

- If we cannot send the archive, nothing is reset. To try again you will need to
  sign in again and get a new code.
- If xecret cannot send email at all, it does not reset vaults until it can.
- If your vault is too large to email — more than about 8 MB of encrypted
  secrets, which is tens of thousands of them — the reset screen says so
  **before** you sign in again or confirm anything. You can still reset by
  ticking **Reset without the emailed archive**; we then email you a notice
  instead of an archive, and the seven days below are the only way back to the
  old secrets.

## The archive, and the risk that comes with it

The archive is a `.zip` file attached to an email sent to your account's address.
It holds every secret in the end-to-end encrypted environments your old vault
could open — **still encrypted**, exactly as xecret stored them — plus the
organisation, project, environment and secret **names**, in plain text. A large
vault arrives as several emails, each with one part; each part opens on its own.

Only the old vault's master passphrase, or one of its unused recovery codes, can
open it.

> **Anyone who gets that email or the attachment can try to guess your old
> passphrase on their own computers, as fast and for as long as they like.** In
> xecret, a wrong passphrase is slowed down and then locked out. Against a copy of
> the archive there is no limit, no lockout, and no way to take the copy back.
> Each guess is deliberately expensive (Argon2id, 64 MiB of memory per guess), so
> a strong passphrase holds — but a weak one will not.

So:

- save the attachment somewhere private — a password manager or an encrypted
  disk — and **delete the email**, including from your bin;
- do not forward it, and be aware that mailbox backups keep copies;
- if you believe somebody else has had the email, assume anything the old
  passphrase protected may be exposed: the archive holds each environment's
  **key** as well as its values, so **rotate the environment keys** (an owner
  can, from each environment's key settings) and rotate the secrets themselves.

Environments that are not end-to-end encrypted are not in the archive. A reset
does not affect them: you can still read them after setting up your new vault.

## Recovering your old vault within seven days

If you find your old passphrase or one of its recovery codes within seven days:

1. Set up your new vault (if you have not already) and unlock it.
2. Go to **Settings → Security → Recover a previous vault**.
3. Choose **Recover**, and enter the old passphrase or a recovery code.

Your browser opens the old vault and moves its environment keys into your
**current** vault. Your current passphrase, recovery codes and passkeys stay as
they are — recovering brings back access to your environments, not your old
passphrase. Anything you or your teammates did after the reset is kept:

- an environment a teammate already shared with you again is left as it is;
- environments you have lost access to since the reset are not restored;
- environments deleted since the reset are skipped.

The old passphrase and recovery codes are checked in your browser and are never
sent to xecret.

### If somebody else reset your vault

A reset needs a fresh sign-in **and** a code sent to your inbox, so somebody
would need both. If you get a reset email you did not ask for:

1. Sign in and secure your account — change how you sign in, and sign out your
   other sessions.
2. If the vault you now find is not yours (somebody set up their own after the
   reset), reset again and set up your own vault. Your original vault is not
   affected by the second reset: each reset keeps its own old vault for its own
   seven days.
3. Recover your original vault from **Settings → Security → Recover a previous
   vault** with your passphrase.
4. Treat the archive that email carried as exposed, and rotate environment keys
   as described above.

## Importing the archive into a project

Any time — including long after the seven days — you can put the archive's
secrets back into a project:

1. Open the project and choose **Import archive**.
2. Choose the `.zip` file (or the `archive.json` inside it).
3. Enter the **old** vault's passphrase or one of its recovery codes. The archive
   is opened in your browser; neither the file's contents nor the passphrase is
   sent to xecret.
4. For each environment in the archive, choose which environment of this project
   it goes into, or **Don't import**. Each of this project's environments is
   shown with its encryption mode. An archive environment starts matched only to
   the environment it came from — the same environment, not just the same name —
   and only when you can write to it now.
5. Choose what happens when a secret with the same name already exists: keep the
   existing value, or replace it with the archive's.
6. **Preview**. The preview lists every secret it would write, with each value
   hidden until you reveal it. **Import** is available only after it.

Each value is encrypted in your browser with the target environment's current
key before it is sent, so xecret never sees it. That is why only end-to-end
encrypted environments are offered: a server-encrypted environment would
receive the values readable, so it is shown but cannot be chosen. You need your
vault unlocked, and permission to write to each environment you import into.
Only values are imported — notes and value types are not.

If you were the only member of an environment, its key was in the vault you
reset, and nobody else holds it. The import says so — "Nobody can open this
environment's key any more" — and the way through is to **create a new
environment and import into it**. (Recovering the old vault within seven days
brings the key back instead.)

## Opening the archive without xecret

The archive does not need xecret, an account, or a network connection. With the
[xecret CLI](/docs/cli/commands):

```bash
xecret vault open-archive xecret-vault-archive-2026-10-12.zip
```

It asks for the old passphrase without showing it, then prints every secret,
grouped by environment, as `.env` lines. Other options:

| Option | What it does |
|---|---|
| `--recovery-code` | Ask for a recovery code instead of the passphrase |
| `--format json` | Any export format: `env`, `json`, `yaml`, `shell`, `docker` |
| `--environment acme/api/production` | Only one environment (or just `production`) |
| `--out-dir secrets/` | Write one file per environment (mode 0600) instead of printing |
| `--list` | Show what the archive holds, without opening it |

The file format is specified in full in section 14 of xecret's E2EE format
specification (`docs/security/e2ee-crypto-spec.md` in the
[source code](https://github.com/playxoft/xecret/tree/main/docs/security)), so
it can be opened by other tools too.

Some values may not open: a value written under a key your account never held
is reported as such, and a damaged value is reported and makes the command exit
with an error. Everything else is still printed.

## What is recorded

Your organisation's [audit log](/docs/security/audit-log) records
`vault.archive_emailed` and `vault.reset` when you reset, `vault.recovered` when
you recover (in each organisation whose environments came back), and
`vault.purged` when the old vault is deleted after seven days. None of them
contains a secret, a name of a secret, or anything from the archive.

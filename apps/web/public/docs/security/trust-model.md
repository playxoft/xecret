---
title: What xecret can and cannot see
navTitle: Trust model
description: Secret values are end-to-end encrypted, so xecret cannot read them. The key hierarchy, what each kind of breach yields, what we can see, and where the guarantee stops.
keywords: [end-to-end encrypted secret manager, zero knowledge secrets, secret manager security, aes-256-gcm, x25519, key hierarchy, threat model]
updated: 2026-11-22
---

A security product that overstates its guarantees has broken the only thing it
sells. So this page says what xecret protects you from, and what it does not,
before you put a real credential in it.

## The short version

**We cannot read your secrets.**

Every secret value and every note is encrypted on your device (in the
dashboard, or in the CLI) before it is sent. Our servers store ciphertext and
hold no key that opens it. That is true of Playxoft, of anyone with production
access, of anyone who steals our database, and of anyone who compels us to hand
it over.

The people you share an environment with can read it. That is what sharing
means. What we *can* see (secret names, who read what, when) is listed below,
and so are the limits of the guarantee.

## The key hierarchy

Two halves: the keys that belong to you, and the keys that belong to an
environment.

```text
YOUR KEYS (made on your device)

  Master passphrase ──Argon2id──┐
  Passkey (WebAuthn PRF) ───────┼──opens──▶  User Key  ──encrypts──▶  your private keys
  Recovery code (one of five) ──┘                                     (X25519 and Ed25519)

AN ENVIRONMENT'S KEYS (made by the client that creates it)

  Environment data key ──sealed to──▶  each member's public key
                       ──sealed to──▶  each service token's public key
                       ──encrypts───▶  every value and note (AES-256-GCM)
```

| Key | Where it lives | What opens it |
|---|---|---|
| Master passphrase | In your head. **Never sent anywhere.** | n/a |
| User Key | On our servers, only as wraps: one under your passphrase, one under each recovery code, one under each passkey | You, on your device |
| Your private keys | On our servers, encrypted under your User Key. The public halves are stored in the clear. | Your User Key |
| Environment data key | On our servers, once per member and per service token allowed to read the environment, each copy sealed to that principal's public key | Each recipient's private key |
| Secret values and notes | On our servers, encrypted under the environment's data key | The environment's data key |

The passphrase is stretched with **Argon2id** (64 MiB of memory, three passes)
in your browser or in the CLI, so each guess at it is deliberately expensive.
The server receives a verifier derived from your keys, which lets it tell a
locked session from an unlocked one; the verifier opens nothing.

Values are encrypted with **AES-256-GCM**, and each ciphertext is bound to the
row that holds it: its organisation, environment, secret and version. A value
moved from `staging` to `production`, or from one secret to another, fails to
decrypt instead of quietly succeeding. Sealing a key to somebody uses X25519;
every blob carries a version prefix, and a client refuses a version it does not
know rather than guessing.

### Where the work happens

- **Import.** The dashboard parses a `.env` file and encrypts every value in
  your browser. Only the encrypted values are sent.
- **Reading.** `xecret run`, `xecret pull`, exports and the dashboard all fetch
  ciphertext and decrypt it on your machine.
- **CI.** A service token carries its own private key inside the token string.
  We keep only the public half and a hash of the part that authenticates, so a
  `xecret run` with `XECRET_TOKEN` decrypts on the runner, never on our servers.
- **The offline cache** stores ciphertext and the sealed keys that open it, not
  plaintext. See [the offline cache](../cli/offline-cache.md).

### Sharing and removing people

Giving somebody an environment means sealing its data key to their public key.
Only a client that already holds the key can do that, so it is done by a
teammate's browser, not by us.

Removing somebody deletes their copies of the key. Then **rotate** it, from the
environment's key settings: a new data key, sealed to everyone still entitled.
The dashboard does not do this for you on removal, so make it part of
offboarding. Rotation stops the removed person opening anything written
afterwards. It cannot make them forget values they already read, so rotate those
secrets at their source.

### Forgetting your passphrase

A recovery code or a passkey still opens your vault. Lose the passphrase, every
recovery code **and** every passkey, and nobody can open it, including us.
There is no escrow and no support reset; a way round it would be a way for us to
read your secrets.

Your teammates' data is unaffected, and they can share their environments with
your new vault. A reset keeps the old vault recoverable for seven days and
emails you an encrypted archive of it first. See
[resetting your vault](vault-archive.md).

## What each kind of compromise yields

| An attacker who gets… | Gets |
|---|---|
| A database backup | **Ciphertext.** Plus the metadata listed below, and the wrapped keys, which let them try guesses at each person's passphrase offline, at Argon2id's cost per guess. A strong passphrase holds; a weak one may not. |
| The database *and* our root key | The same. The root key protects the server's own operational secrets, such as webhook signing secrets, and opens no end-to-end encrypted value. |
| Somebody inside xecret, or a court order | The same again. We hold no key to hand over. |
| Your CLI token | On its own: the ciphertext you can reach, and your passphrase wrap to guess against offline. With the key the CLI keeps in your OS keychain (or, where there is none, its 0600 credentials file) as well: everything you can read. Revoke it; every use is audited. |
| A CI service token | One environment of one project: the server scopes the token to it, and the token can open only that environment's key. Read-only unless you made it otherwise. |
| Your session cookie | Your account's authority on the server while the session is unlocked, but no value: your keys are held by your browser, not carried in the cookie. A locked vault refuses nearly everything until it is unlocked again. |

## What xecret can see

Saying this plainly is part of the guarantee being worth anything.

- **Secret names.** `STRIPE_LIVE_KEY` existing in `production` is real
  information about your stack. Names are left unencrypted deliberately, so that
  listing, search and sorting stay ordinary server-side queries. Value types,
  version numbers, timestamps and who changed what are visible too.
- **Roughly how long each value is.** Ciphertext is about the size of what it
  encrypts.
- **Organisation, project and environment names**, and members' names, email
  addresses, roles and access levels.
- **The audit log**: who fetched which environment or secret, when, and from
  which IP address.
- **Public keys**, and so which members and tokens hold which environments.
- **Billing details** for paid plans.

What we never receive: values, notes, your personal overrides, the text of a
template, your passphrase, your recovery codes, or any key in a form that
opens something. Private keys and the User Key reach us only wrapped.

## The rules the implementation follows

These are enforced structurally, not by convention:

- **Clients encrypt; the server stores.** Write handlers check shapes, names
  and permissions and store ciphertext. No server code path holds a key for an
  end-to-end encrypted environment.
- **No secret material is ever sent to the server.** Not the passphrase, and
  never a key in usable form: the User Key and private keys arrive only wrapped,
  and the half of a service token that holds its key not at all, including in
  diagnostics and error reports.
- **Every value fetched is audited.** Each pull, run, reveal or export writes a
  record. The server cannot see you decrypt, so it
  records the moment it handed ciphertext to somebody holding the key, which
  is the moment that matters.
- **Every denial is audited too.** A system that records only what succeeded
  cannot detect an attack in progress.
- **Audit metadata cannot contain a value.** The type describing it is a fixed
  allowlist of field names with no catch-all, so a secret cannot be placed in a
  record: the compiler rejects it rather than a reviewer having to notice.
- **Error messages are fixed strings.** Nothing derived from an exception, a
  database error, or the rejected input reaches a client, because the rejected
  input may itself be a secret.
- **The database role is least-privilege.** The application's credentials
  cannot alter the audit table, which is append-only by grant rather than by
  discipline.

## The limits of the guarantee

End-to-end encryption moves trust; it does not remove it. These are the places
it still rests on us, listed so you can weigh them:

- **The dashboard is JavaScript we serve.** A server willing to send one
  poisoned page to one targeted person could capture what that person decrypts
  in it. A strict Content Security Policy narrows this; nothing in a browser
  closes it. The CLI is the client you can verify (see below).
- **Public keys are trusted on first use.** A server that swapped a member's
  public key could receive keys sealed to them afterwards. Clients remember the
  keys they have seen, every key change is audited, and the members screen
  shows each key's fingerprint so you can compare it with your colleague
  directly.
- **Grants are signed, but the signatures are not checked yet.** Until they
  are, a server willing to forge a grant could read values written after the
  forgery. The signatures exist now so that checking them later is a client
  update.
- **Stale data is not detected.** A server could serve an older version of a
  value, or an older set of keys, and a client could not tell. Nothing is
  decrypted that should not be, but you might act on an out-of-date value.
- **The encryption mode is pinned, not proved.** Once a client has seen an
  environment as end-to-end encrypted it refuses any later answer saying
  otherwise. A client meeting an environment for the first time (a new browser,
  cleared site data) has nothing to compare against.
- **A device PIN leans on the server.** The convenience PIN on one browser is
  opened by six digits plus a value our server holds; five wrong guesses destroy
  it, but a server colluding with whoever holds that device could try every
  PIN. Your passphrase and passkeys do not depend on us in this way.
- **Names and metadata are in the clear**, as listed above.

### Environments created before end-to-end encryption

Environments created before end-to-end encryption shipped used server-side
encryption, under keys protected by our root key, and any that have not been
upgraded still do. We can read the values in those. The environment says so,
*This environment uses server-side encryption*, above its values and in its
key settings. Every environment created since is end-to-end encrypted from its
first key.

An owner or admin of such an environment can **upgrade it in place**: open it
and press *Upgrade to end-to-end encryption*. It keeps its name, its access,
its policies and its settings. What happens:

- **Your browser does the encrypting.** It reads every value, every older
  version and every note once (the last time our server decrypts anything in
  that environment, recorded in the audit log as a read), generates a new key,
  re-encrypts all of it, opens every value again to check it before anything is
  sent, and sends back only ciphertext.
- **It lands all at once, or not at all.** The server checks that what came
  back is exactly what the environment holds (nothing written in between is
  dropped), rewrites every value in one transaction, and deletes the key it used
  to hold. If anything fails, nothing changes.
- **CI tokens made for the old environment stop working.** They have no key of
  their own, so the new key cannot be shared with them; the upgrade revokes them
  and names them before you confirm. Issue new tokens afterwards.
- **Deleted secrets are erased now**, rather than kept for the usual thirty
  days, because they cannot be re-encrypted. The dialog lists them first.
- **Your teammates get the key from your browser**, straight after you confirm
  the upgrade: each one who may read the environment and has a vault, except
  anyone whose public key has changed since your browser last saw it, who is
  left for you to confirm and share with from the key settings. Anyone without
  a vault gets it once they set one up and somebody who holds it shares it.
  Until then they see the secret names and cannot read the values.

An environment with nothing in it (no secrets, no deleted secrets, no CI
tokens) **that nobody else may read** has nothing to decide and nobody to
leave out, so it is upgraded automatically the first time its owner or admin
opens it with an unlocked vault. Anywhere a teammate may read it, the dialog
asks first, so the key is shared with them as part of the same act.

Upgrading reads every value into one browser in plaintext (more than an
export would), even though nothing is written to a file and nothing leaves that
browser except as ciphertext. Where an environment's policy disables plaintext
export, the upgrade is still allowed: the policy is changed by the same
environment admins who can upgrade, so refusing would stop nobody it was meant
to. Instead the audit records say whether the policy was in force, and the read
triggers the environment's new-address read alert unless alerts were switched
off.

Two copies outlast an upgrade, and we say so rather than let the word
"deleted" imply otherwise. Our database backups from before it still hold the
old ciphertext and the server's old key for it until that backup history ages
out. Until then, the values as they stood on the day of the upgrade could be
recovered from a backup by us. Nothing written afterwards can. And a machine
whose CLI cached the environment before the upgrade keeps that offline copy
until its next successful read replaces it, or until `xecret cache clear`; the
CLI refuses to serve it once it has seen the environment as end-to-end
encrypted.

## What xecret does not protect you from

Stated plainly, because these are the failures people are surprised by:

- **A compromised laptop.** If somebody has your machine with the vault
  unlocked, or your unlocked keychain, they have what you have. Revoke the
  device; the audit log tells you what it read.
- **Your own code leaking values.** `xecret run` puts secrets into your
  process's environment. If your app logs `process.env`, or a crash reporter
  ships it, xecret cannot stop that.
- **`xecret pull` writing a file.** The command warns each time. What happens
  to that file afterwards is yours.
- **A member determined to keep a copy.** [Disabling plaintext
  export](../features/policies.md#disabling-plaintext-export) and the secret
  policy's value rules are enforced by the clients that hold the plaintext, so
  they stop honest mistakes, not somebody who means to get round them: anyone
  who may read a value can write it down. A removed member's offline cache also
  stays readable on their machine for as long as they keep it: the seven-day
  limit is enforced by their own CLI, which they can raise or turn off. Rotate
  what they could read.
- **A server that misbehaves, in two narrow ways**, even though values are
  end-to-end encrypted. It could answer a [reference](../features/references.md)
  or an inherited name with a *different value you can already decrypt* (
  another secret, or one from another environment whose key you hold), because
  which environment a slug means, and which stored secret a name means, are
  things your client learns from the server. And it could keep serving a
  [personal override](../features/overrides.md) you replaced or removed,
  because an override carries no version. It cannot make up a value, read one
  you could not, or forge an override in your name.
- **Anything a browser can read.** `NEXT_PUBLIC_` and `VITE_` variables are
  inlined into bundles you serve to the public. Managed and versioned, yes;
  private, no. See [React / Vite](../guides/react-vite.md).

## If you would rather not trust our JavaScript

The CLI is the client you can check for yourself: Go, MIT-licensed, every
release signed with cosign, and buildable from source. Reading and writing
values with it, and running CI with a service token, never involves a page we
serve.

The dashboard cannot be avoided entirely today. Vaults are set up there,
projects and environments are created there (their keys are generated in the
browser), and CLI logins are approved there. Keeping those visits few is what
narrows the window.

## If you self-host

Self-hosting does not change the model. Whoever operates the deployment (that is,
you) cannot read end-to-end encrypted values either. What moves to you is
everything else on this page: the metadata, the audit log, availability, and
the JavaScript your dashboard serves.

The root key is still yours to keep. It protects the deployment's own
operational secrets, such as webhook signing secrets, and any environment still
on server-side encryption.

> **Important**: Lose the root key and those are permanently unrecoverable:
> webhooks need new signing secrets, and server-side encrypted environments are
> gone. End-to-end encrypted values are not affected. Generate it, split it, and
> escrow the shares in physically separate places **before** you go live.

See [self-hosting](../self-hosting.md).

## Reading the source

The server is AGPL-3.0 and the CLI is MIT. The cryptography and authorisation
logic live in a package that imports nothing runtime-specific, so both can be
audited and unit-tested in isolation rather than read through a web framework.

The byte-level format (every key derivation, every blob layout, the sealed box,
the recovery codes and the test vectors) is specified in
`docs/security/e2ee-crypto-spec.md` in the
[source code](https://github.com/playxoft/xecret/tree/main/docs/security), so a
second implementation, or an auditor, can check ours against it. There has been
no external security audit yet, and xecret holds no certification.

## Next

- [The audit log](audit-log.md): what is recorded and how to read it.
- [Resetting your vault](vault-archive.md): the way out when every key is lost.
- [Tokens](../api/tokens.md): scoping credentials, and what to do if one leaks.
- [Self-hosting](../self-hosting.md): running it yourself.

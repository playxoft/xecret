---
title: Envelope encryption, zero-knowledge, or plain trust: how to read a secret manager's security page
description: Every secret manager encrypts your data. Only some cannot read it. How envelope encryption works, what zero-knowledge really costs, and the questions to ask.
keywords: [envelope encryption, zero-knowledge secret manager, secrets manager security, how secrets managers work, data key root key]
published: 2026-07-08
author: The xecret team
role: Playxoft
category: Security
---

"Encrypted at rest with AES-256" appears on the security page of every secret
manager ever built, and it answers almost nothing you want to know. Of course it
is encrypted. The interesting question is who holds the key, and every product
answers that in one of three ways.

This article explains all three, explains envelope encryption properly, and ends
with the questions worth putting to any vendor — including us, since we say
plainly below which of the three xecret is.

## Three models, and only three

The test that separates them is blunt: **if the provider wanted to produce your
plaintext, could they?** Not "would they", not "do their policies allow it".
Could they.

### (a) The provider holds the keys

The service stores your ciphertext and controls the key that decrypts it,
usually a root key in a cloud KMS or a hardware security module. Decryption
happens on their servers, in response to a request they authorised.

Answer to the test: **yes**. An operator with sufficient access to the running
system can produce plaintext.

Most developer-facing secret managers sit here: any product whose dashboard can
show you a value, whose CI token reads an environment with no other key
material, or whose support can help after you forget your password. xecret
included — its own section is below.

### (b) End-to-end, or zero-knowledge

The key is derived on the client — from your password, or a key file — and never
leaves it. The server receives ciphertext and metadata and can do nothing with
either. Sharing is a key exchange: the data key gets re-wrapped under each
recipient's public key by a client that already holds it.

Answer to the test: **no** — assuming the client is the client you think it is.
That caveat is not rhetorical. A zero-knowledge product delivered as a web
application ships new code to your browser on every load, and whoever controls
that code is the party you were trying not to trust. Native clients with
reproducible builds narrow the gap; nothing closes it.

### (c) Bring your own key

You supply the root key — usually one in your own cloud KMS account — and the
provider calls your account to wrap and unwrap. Marketed as the best of both,
sometimes truthfully.

Answer to the test: **usually yes**, and the honest version depends on three
things nobody puts on the marketing page. Does the provider cache unwrapped data
keys? Does your key live in *your* account under *your* policy? Does revoking
their grant stop reads at once, and does every use reach your key-usage log?

"Not cached", "my account", "yes to both" makes BYOK a real control. Any softer
answer makes it a billing arrangement with a security-shaped name.

## Envelope encryption, properly

Nearly every product in models (a) and (c) uses envelope encryption. It is worth
understanding, because it explains what a key rotation costs.

The naive design encrypts every secret directly under one key, and fails on two
things. **Rotation**: retiring that key means re-encrypting every value you have
ever stored, as one migration, while the system serves traffic — so nobody
rotates. **Exposure**: the key must be reachable by every code path that reads a
value, so it is in memory in many places, each of them a way to lose it.

One layer of indirection changes both:

```text
Root key       in a KMS or secrets store; never in the database
   │  wraps
   ▼
Data key       one per environment; in the database, as ciphertext
   │  encrypts
   ▼
Secret value   in the database, as ciphertext
```

A read walks down that chain and back:

```ts
// A sketch of the read path — the shape, not anybody's source.
const wrapped = await db.dataKeyFor(environmentId); // ciphertext, from the database
const dataKey = await rootKey.unwrap(wrapped); // the only use of the root key
const plaintext = await aesGcm.decrypt(dataKey, row.ciphertext, {
  // Bound to its position, so a row copied from `staging`
  // into `production` fails to decrypt.
  aad: `${orgId}/${projectId}/${environmentId}/${row.name}`,
});
```

Now count the work in a root key rotation: one re-wrap per data key — the number
of environments — rather than one re-encryption per stored value. A hundred
environments and forty thousand secret versions means touching a hundred small
blobs. That is a maintenance task rather than a migration project, and a cheap
rotation is one that actually happens.

The root key's blast radius shrinks too. It performs exactly one operation, so
it can live behind an interface that never returns it, in a system with no
database access. A stolen backup then holds wrapped data keys and encrypted
values, and nothing that unwraps either.

Two details separate a careful implementation from a box-ticking one: binding
each ciphertext to its position, as the sketch does, and a key per environment
rather than per account.

## What an audit log adds that encryption does not

Encryption answers one question: what does an attacker get from a stolen
database? It says nothing about a legitimate credential used illegitimately — a
stolen CLI token, a leaked CI token, somebody reading values they have no
business reading. In each case the system decrypts correctly, because it was
asked correctly.

The control for that is a log the writer cannot edit:

- **Append-only by database grant**, not by convention. If the application's own
  credentials can delete a row, so can an attacker holding them.
- **One row per decryption**, so a row always means a plaintext left the server.
- **Denials recorded too.** Successes alone cannot show an attack in progress,
  which usually looks like refusals just before one.
- **Precise attribution.** A CI write recorded under the name of whoever minted
  the token is worse than no attribution at all.

Encryption limits what a breach yields; the audit log bounds an incident,
because it tells you which secrets to rotate rather than all of them. Ours is
documented event by event in [the audit log](/docs/security/audit-log), and it
is why [rotating a credential](/blog/rotate-secrets-without-downtime) can start
with a consumer list you never had to write.

## What each model costs you

Few developer tools ship zero-knowledge, and not out of laziness: the property
you gain removes capabilities teams use daily.

| | (a) Provider holds keys | (b) Zero-knowledge | (c) Bring your own key |
|---|---|---|---|
| Provider can decrypt | Yes | No | Usually, while your key is reachable |
| A database leak yields | Ciphertext | Ciphertext | Ciphertext |
| A root key leak yields | Everything | Nothing; the key is not there | Everything it can reach |
| Adding a team member | A server-side grant | A key re-wrap per member, needing their public key | A server-side grant |
| Browser `.env` import | Straightforward | Client-only, and the client is the browser | Straightforward |
| A read-only CI token | Straightforward | Hard — the runner needs the key, so the key lives in CI | Straightforward |
| You forget your password | Recoverable | Data loss, absent a recovery key | Recoverable |
| Server-side validation or search | Possible | Impossible on values | Possible |
| Who you must trust | The provider and their infrastructure | The client build and its update channel | The provider, plus your key custody |

The CI row decides the market. A build runner is unattended by definition, so
something must hand it the key — at which point the key lives in CI, [the
softest target you own](/blog/secrets-in-ci-pipelines). Teams answer this with
an exception for CI, and the exception is where the guarantee stops applying.

None of that makes zero-knowledge wrong. It makes it a different product,
chosen from a threat model rather than from which security page sounded better.

## xecret is model (a), and here is why

**xecret uses server-side envelope encryption. We can technically decrypt your
secrets.** A root key we hold wraps an organisation key, which wraps a
per-environment data key, which encrypts your values. Decryption happens in one
request handler on our servers, and writes an audit row every time.

We chose it for the reasons in that table's first column: importing a `.env`
from a browser with no key ceremony, adding a colleague without exchanging
public keys, giving a CI runner a read-only token, and not losing your data
because you forgot a password. A model that made those hard is a model people
work around — usually by putting the value back in a file.

We reduce what the trust costs where we can. The root key sits in a secrets
store bound to the Worker, never in the database, so a stolen backup is
ciphertext at every layer. Decryption exists in exactly one place, so "where can
a plaintext be produced?" is answerable by reading the source. Every decryption
and every denial lands in a table the application's own credentials cannot
alter. And it self-hosts, which moves the trust from us to you.

> **Important** — Choose a zero-knowledge product instead if a regulator or a
> contract requires the provider to be technically incapable of reading your
> data, if your threat model includes the provider being compelled to hand over
> plaintext, or if exposure of these secrets would be unrecoverable regardless
> of rotation. We would rather write that here than have you find it out after
> migrating.

The long version, including what each kind of compromise yields, is in the
[trust model](/docs/security/trust-model).

## Nine questions for any vendor, including us

Take these to whichever security page you read next. Their *availability*
matters as much as the answers themselves.

1. **Who holds the root key, and where does it live?** "Our KMS" and "your KMS"
   are different products.
2. **Where does decryption happen — on a machine you operate, or on mine?**
3. **Can one of your employees produce plaintext, and is that logged where I can
   see it?**
4. **What is written when a value is decrypted, and how long is it kept?**
5. **If your database leaks tomorrow, what does the attacker have?** The only
   good answer is "ciphertext, at every layer".
6. **If your root key leaks tomorrow, what does the attacker have?** Every model
   (a) product must answer "everything"; be suspicious of one that does not.
7. **If I forget my password, can I get my secrets back?** A "yes" means the
   provider can decrypt, whatever the marketing said.
8. **Is the key per customer, per environment, or one for everybody?**
9. **Can I run the whole thing myself, and is anything held back if I do?**

If a vendor cannot answer six of these from published documentation, that is
your answer. A security model that exists only in a sales call is not one.

## Where xecret fits

Its own section, so you can skip it. xecret is open-source secret management
that replaces the `.env` file: values stored once per environment, injected by
`xecret run`, with an append-only audit log of every read. It is model (a) —
envelope encryption, provider-held root key, and we can technically decrypt —
which we would rather put in our own explainer than bury in an FAQ. Pre-alpha,
AGPL-3.0 server, MIT CLI, threat model in the repository. If the questions above
lead you elsewhere, that is a good outcome; the
[quickstart](/docs/quickstart) is here if they do not.

# Security Policy

xecret stores other people's production credentials. We would rather hear about
a problem early and awkwardly than late and publicly.

## Reporting a vulnerability

Two private channels, either is fine:

- **GitHub:** [open a private security advisory](https://github.com/playxoft/xecret/security/advisories/new) —
  the report stays between you and the maintainers, and the eventual advisory
  is published from the same thread.
- **Email:** security@playxoft.com

Please do **not** open a public GitHub issue for a security problem.

Include what you have: the affected component, reproduction steps, and what an
attacker could achieve. A rough report is more useful than no report.

**Our commitment**

| | |
|---|---|
| Acknowledgement | within 48 hours |
| Initial assessment | within 5 working days |
| Fix or mitigation plan | within 30 days for high severity |
| Public disclosure | coordinated with you, after a fix ships |

We will credit you in the advisory unless you prefer otherwise. We do not
currently run a paid bounty programme.

---

## What xecret can and cannot protect you from

We would rather be plainly honest than reassuring. Read
[`docs/security/threat-model.md`](docs/security/threat-model.md) for the full
analysis and [ADR 0009](docs/adr/0009-zero-knowledge-encryption.md) for the
design.

### The most important thing to understand

**Secret values and notes are end-to-end encrypted. xecret — the service, and
Playxoft — cannot decrypt them.**

They are encrypted on the user's device, by the web dashboard (Web Crypto) or
the Go CLI, with AES-256-GCM under a per-environment data key the client
generates. That key is sealed with X25519 to the public key of every member and
service token allowed to read the environment. Private keys leave users'
devices only wrapped under a User Key that a master passphrase (Argon2id, m=64 MiB,
t=3, p=1, run on the device), a passkey (WebAuthn PRF) or one of five one-time
recovery codes unlocks. A service token carries its own private key inside the
token string; the server keeps only the public half and an authentication hash,
so CI decrypts on the runner.

The server stores ciphertext and holds no key that opens it. The byte-level
format is specified in
[`docs/security/e2ee-crypto-spec.md`](docs/security/e2ee-crypto-spec.md).

The consequence we will not soften: a user who loses their passphrase, every
recovery code and every passkey cannot be recovered by us. There is no escrow
and no support reset.

### What we do protect against

| Attack | Protection |
|---|---|
| Database breach | A dump yields ciphertext, wrapped keys and public keys — nothing that opens a value. It does allow offline guessing of each user's passphrase, at Argon2id's cost per guess. Session and API tokens are stored as hashes. |
| Root key compromise | The server's root key protects only its own operational secrets (webhook signing secrets) and environments created before end-to-end encryption shipped. It opens no end-to-end encrypted value. |
| An xecret operator, or compelled disclosure | There is no key on our side to use or hand over. |
| Another tenant's user | Every request is authorized against current database state through one function. Cross-tenant probes get 404, not 403, so existence is not confirmed. |
| Stolen CLI credential | Credentials live in the OS keychain (or a 0600 file where there is none), are revocable, expire, and every use is logged with IP and device. |
| Compromised CI | Service tokens are scoped to one project and one environment, read-only by default, and carry no user identity. |
| Ciphertext relocation | Every ciphertext is bound to its organisation, environment, secret and version. Moving a row makes decryption fail rather than succeed. |
| Audit tampering | The audit table is append-only enforced by database grants — the application role has no UPDATE or DELETE on it. |

### What we do not protect against

The limits of the guarantee, stated as plainly as the guarantee itself:

- **The web dashboard is JavaScript we serve.** A server willing to deliver a
  malicious bundle to a targeted user could capture what that user decrypts in
  the browser. A strict CSP narrows this; it cannot close it. The CLI — Go,
  MIT-licensed, releases signed with cosign, buildable from source — is the
  verifiable client.
- **Public keys are trusted on first use.** A server that substituted a
  member's public key could receive keys sealed to that member afterwards.
  Clients pin keys they have seen, key changes are audited, and fingerprints are
  shown for out-of-band comparison.
- **Grant signatures are created but not yet verified.** Until they are, a
  malicious server could insert a grant of its own and read values written
  afterwards.
- **Secret names and metadata are plaintext** — names, project and environment
  names, members, the audit log, IP addresses. Deliberately, so listing and
  search stay server-side.
- **No rollback protection yet.** A server could serve stale values or stale
  grants, and a client could not tell.
- **The encryption mode is pinned, not proved.** Once a client has seen an
  environment as end-to-end encrypted it refuses a later downgrade; a client at
  first contact cannot detect one.
- **Environments created before end-to-end encryption shipped** still use
  server-side envelope encryption until they are moved, and their values can
  be decrypted by the server.
- **Exfiltration by someone with legitimate access.** Anyone an environment is
  shared with can read it. Audit logs make it detectable, not preventable, and
  rotating an environment's key after removing someone cannot un-read what they
  already saw.
- **Your own compromised systems** after a secret has been legitimately
  delivered to them.

---

## Supported versions

xecret is pre-1.0 and under active development. Only the latest release
receives security fixes. Once 1.0 ships, this section will state a support
window.

## Scope

**In scope:** the web application, the API, the CLI, the cryptographic design,
authorization logic, and the published release artifacts.

**Out of scope:** vulnerabilities in Cloudflare, Neon, WorkOS, or Phase.dev
themselves (report those to the respective vendors), social engineering,
physical attacks, and denial of service through resource exhaustion.

## Cryptography

Never invent cryptography, and never implement a primitive by hand. xecret uses
Web Crypto AES-256-GCM, X25519 and Ed25519 from `@noble/curves`, Argon2id and
HKDF-SHA256, under a versioned format specified byte for byte in
[`docs/security/e2ee-crypto-spec.md`](docs/security/e2ee-crypto-spec.md). If you
believe you have found a cryptographic weakness, that is a high-severity report
— please say so in the subject line.

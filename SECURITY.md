# Security Policy

xecret stores other people's production credentials. We would rather hear about
a problem early and awkwardly than late and publicly.

## Reporting a vulnerability

**Email:** security@playxoft.com

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
analysis.

### The most important thing to understand

**xecret uses server-side envelope encryption. This means the service can
technically decrypt your secrets.**

This is the same model Doppler uses, and it is what makes team sharing, CI
tokens, web-based import, and `xecret run` work simply. It is a deliberate
trade-off, recorded in [ADR 0001](docs/adr/0001-trust-model.md).

If your threat model requires that the operator *cannot* read your secrets even
in principle, you need a zero-knowledge product. We would rather tell you that
than have you discover it later.

### What we do protect against

| Attack | Protection |
|---|---|
| Database breach | Secrets are encrypted with keys never stored in the database. A dump yields ciphertext. Session and API tokens are stored as hashes. |
| Another tenant's user | Every request is authorized against current database state through one function. Cross-tenant probes get 404, not 403, so existence is not confirmed. |
| Stolen CLI credential | Credentials live in the OS keychain, are revocable, expire, and every use is logged with IP and device. |
| Compromised CI | Service tokens are scoped to one project and one environment, read-only by default, and carry no user identity. |
| Ciphertext relocation | Every ciphertext is bound to its org, environment, secret, and version. Moving a row makes decryption fail rather than succeed. |
| Audit tampering | The audit table is append-only enforced by database grants — the application role has no UPDATE or DELETE on it. |

### What we do not protect against

- **A compromised xecret Worker.** Code running inside our trust boundary can
  decrypt. This is the highest residual risk in the system.
- **An xecret operator with production access.** See ADR 0001.
- **Exfiltration by someone with legitimate access.** Audit logs make it
  detectable, not preventable.
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

**Out of scope:** vulnerabilities in Cloudflare, Neon, Firebase, or Phase.dev
themselves (report those to the respective vendors), social engineering,
physical attacks, and denial of service through resource exhaustion.

## Cryptography

Never invent cryptography, and never implement a primitive by hand. xecret uses
Web Crypto AES-256-GCM with a versioned key hierarchy. If you believe you have
found a cryptographic weakness, that is a high-severity report — please say so
in the subject line.

---
title: Teams, roles and access
navTitle: Teams and access
description: Invite people, choose roles, grant access per project and environment, and understand why production is denied by default to developers.
keywords: [team secret management, rbac secrets, invite members, production access control, per environment permissions]
updated: 2026-08-16
---

Everything about who can see what. If you are working alone, you can skip this
page until somebody joins.

## Inviting somebody

*Members → Invite*. You need an email address and a role.

The invitation email carries a single-use link. Accepting it requires being
signed in as **that same address** — a forwarded email must not let a colleague
join as somebody else.

Only the hash of the invitation token is stored, so the link is shown to you
exactly once, at creation. If mail is not configured on a self-hosted
deployment, you get a shareable link instead of an email.

You cannot invite somebody at a role above your own.

## The four roles

Ordered `viewer` < `developer` < `admin` < `owner`.

| Role | Can | Cannot |
|---|---|---|
| `owner` | Everything, including deleting the organisation | — |
| `admin` | Manage members, tokens, projects, environments; read the audit log | Delete the organisation |
| `developer` | Read and write secrets where granted | Manage members or tokens |
| `viewer` | Read secrets where granted | Write anything |

A role decides what *class* of action is available to you at all. It is
org-wide and no grant can change it: an `admin` grant on one environment cannot
turn a `viewer` into a writer, because the viewer's capability table says
"cannot write" and grants do not edit that table.

## Access levels

The second gate. Levels are ordered `none` < `read` < `write` < `admin`, and
they apply to a specific project or environment.

Where no grant mentions a resource, the role supplies a default:

| Role | Non-production | Production |
|---|---|---|
| `owner` | admin | admin |
| `admin` | admin | admin |
| `developer` | write | **none** |
| `viewer` | read | **none** |

### Why production is deny-by-default

A developer who needs production must be granted it explicitly, by somebody who
manages members, and that grant is written to the audit log with a name
attached.

The alternative — production behaving like every other environment until
somebody remembers to lock it down — makes the safe state the one that requires
work. Every organisation that has done it the other way has, at some point,
discovered a contractor with production access nobody meant to give.

`viewer` gets `none` on production for a related reason: a viewer with `read`
there would hold strictly more production access than a developer, which no
reviewer could justify.

## Grants

A grant sets a level on a **whole project** or on a **single environment**.
More specific wins:

```text
developer role                          → write on non-production, none on production
+ project grant: checkout-api = read    → read across checkout-api
+ environment grant: production = write → write on checkout-api/production
```

`none` always denies, whatever the role default would have said. That makes it
the tool for carving one project out of an otherwise trusted role.

Grants are managed on each member's own page: *Members → (person) → Access*.

### The effective-access preview

The same page shows every project and environment with the member's **resolved**
level and the rule that produced it:

| Environment | Level | Because |
|---|---|---|
| checkout-api / development | write | role default |
| checkout-api / production | write | environment grant |
| billing / production | none | role default |
| billing / staging | none | project grant |

This is computed by the same function the enforcement path calls, so it cannot
disagree with what actually happens. When somebody says "I can't see the
staging secrets", this table is the first place to look.

Anyone can see their own row. Seeing somebody else's requires the permission to
manage members.

## Inviting with access already set

The invitation form lets you tick the projects and environments the person
should get. When you use it, acceptance becomes **deny-by-default**: every
project that exists at that moment gets an explicit `none` unless you selected
it, and the ones you selected get the invited role's normal level.

A ticked production environment is the conscious act that grants production.

Projects created *after* they accept fall back to the role default; narrowing
that is the member page's job.

## Changing and removing people

| Action | Requires |
|---|---|
| Change a role | Managing members, and the role hierarchy on **both** sides |
| Suspend | Managing members. Keeps the membership, denies everything. |
| Reinstate | Managing members |
| Remove | Managing members. Grants are deleted with the membership. |

"Both sides" means: to change somebody from `developer` to `admin`, you must be
at least an `admin` yourself, to assign that role, *and* rank above the role
they currently hold, to touch them at all. Without the second half, an admin
could "demote" an owner — which is removing an owner's authority without
holding it.

You cannot change or remove yourself, and an organisation can never be left
without an active owner. Both are enforced inside the database transaction, not
by the form.

Suspension is the right tool for "somebody is on leave" or "we are
investigating". Removal is permanent, and their grants do not come back.

## Tokens belong to people too

A **CLI token** from `xecret login` acts as the person who created it: their
role, their grants, nothing more. Revoking their membership makes every one of
their devices stop working immediately.

A **service token** is not a person. It is pinned to one project and
environment, and its actions are recorded against the token's own name — never
against whoever minted it. See [tokens](../api/tokens.md).

Members can see and revoke their own devices under *Tokens → Your devices*.
Admins can revoke anyone's.

## A sensible starting arrangement

For a team of five to fifteen:

- **Owners:** two people. One is a single point of failure; five is nobody
  being accountable.
- **Admins:** whoever runs deployments.
- **Developers:** everybody else. They get write access to development and
  staging automatically, and nothing in production.
- **Production:** granted per person, per environment, and reviewed
  occasionally against the audit log.
- **CI:** its own service tokens, read-only, one per project and environment.

## Next

- [Core concepts](../concepts.md) — the hierarchy these rules apply to.
- [The audit log](../security/audit-log.md) — checking what actually happened.
- [Tokens](../api/tokens.md) — credentials in detail.

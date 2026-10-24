# WorkOS environments and the organisation link

What an operator does when an organisation's single sign-on link belongs to the wrong WorkOS
environment, and the checks that keep it from happening — and (§4) the logout redirect each
environment needs before the build that ends AuthKit sessions at sign-out is deployed, with the
checks to make on Staging. The design is in
`docs/architecture/database-schema.md` (§2, `workos_org_id`, `workos_client_id` and
`workos_home`) and `docs/security/threat-model.md` (T13).

---

## 1. Why it can happen at all

A WorkOS organisation id means something only in the WorkOS environment that created it, and
local development runs against WorkOS **Staging** while sharing the **production** database.
An organisation's `workos_org_id` is set once, when an owner turns SSO on, and never
re-pointed. So an "enable" clicked in local development used to link a production
organisation, permanently, to a Staging organisation that no production sign-in can ever come
through.

Three things now stand in the way:

| Check | Where | What it does |
| --- | --- | --- |
| `workos_client_id` beside every link (0022) | `organizations` | The settings refuse to act on a link made in another environment, the sign-in path ignores one, and an enable never adopts one. |
| `workos_home` (0023) | one-row table | The one client id this database's links may come from. Turning SSO on, opening the setup portal and switching a policy on refuse from any other deployment, or while the table is empty; `setOrgWorkosOrgId` checks it inside its own `UPDATE` too. Switching a policy **off** is allowed from anywhere. |
| `organizations_workos_link_client_check` (0022, validated by 0023) | `organizations` | No link without its client id, on any row. |

`workos_home` is seeded with the Playxoft production client id,
`client_01M36CECX3Z66Q2FYY2FN8WG73`. A self-hosted database records its own
(`docs/self-hosting.md`, "The WorkOS environment, recorded once").

## 2. Before migration 0023: the hard gate

0023 backfills every linked organisation that has no `workos_client_id` with the **production**
client id, then validates the constraint. That is right only for a link production code made.
Run this first, against the database 0023 is about to change:

```sql
SELECT id, slug, workos_org_id
  FROM organizations
 WHERE workos_org_id IS NOT NULL AND workos_client_id IS NULL;
```

- **No rows:** apply 0023.
- **A row you know production made** (you can find its `workos_org_id` in the WorkOS
  **Production** dashboard): apply 0023; the backfill records it correctly.
- **A row you cannot vouch for** — not in the Production dashboard, or found in Staging's: do
  not apply 0023 yet. Clear the link (§3) — on a 0022 database a row like this cannot be updated
  through the product, nor have its policies switched off by SQL on their own, so it is cleared
  with the single statement in §3, step 2 — then apply 0023.

## 3. Clearing a foreign link

For an organisation linked to an organisation in the wrong WorkOS environment. The link is
otherwise never cleared, by design: re-pointing an organisation's SSO re-points it at another
identity provider. This is the operator's override, so it is done by hand, as the database
owner, inside one transaction, and only while both SSO policies are off — which the statement
itself insists on (or, for the one row step 2 cannot switch off on its own, switches off in the
same statement).

1. **Find it.** `workos_client_id` is not `workos_home`'s (or is NULL, before 0023):

   ```sql
   SELECT o.id, o.slug, o.workos_org_id, o.workos_client_id, o.sso_required, o.jit_join_enabled
     FROM organizations o, workos_home h
    WHERE o.workos_org_id IS NOT NULL
      AND o.workos_client_id IS DISTINCT FROM h.client_id;
   ```

   On a database without `workos_home` yet (before 0023), use
   `o.workos_client_id IS DISTINCT FROM 'client_01M36CECX3Z66Q2FYY2FN8WG73'` instead.

2. **Switch both policies off** — from the deployed product (Organisation settings → Single
   sign-on; switching a policy off works from any environment, and is audited). A link must
   never be cleared under `sso_required` or the just-in-time opt-in:
   `organizations_sso_flags_need_link_check` would refuse it anyway, and step 3 insists on it
   too.

   **On a 0022 database, a row with a link and no `workos_client_id` (the §2 case) cannot have
   its policies switched off on their own** — not through the product, and not by an `UPDATE`
   that sets only the two flags. 0022 added `organizations_workos_link_client_check` `NOT
   VALID`, and Postgres checks a `NOT VALID` constraint on every `UPDATE` of a row, whatever the
   statement changes: such a row fails it (SQLSTATE `23514`) until it has a client id or no
   link. Nor can the link be cleared first, while a policy is on — the flags check refuses that.
   So for that row, switch the policies off **and** clear the link in one statement, which
   leaves a row both checks accept, and skip step 3:

   ```sql
   BEGIN;
   UPDATE organizations
      SET sso_required = false, jit_join_enabled = false,
          workos_org_id = NULL, workos_client_id = NULL, updated_at = now()
    WHERE id = '<organisation id>'
      AND workos_org_id IS NOT NULL
      AND workos_client_id IS NULL;
   -- Expect: UPDATE 1. Anything else: ROLLBACK and look again.
   COMMIT;
   ```

   (`packages/db/src/schema/migration-0023.test.ts` replays exactly this against such a row.)

3. **Clear the link**, and only the link — the statement touches nothing with a policy still
   on, nothing linked in this database's own environment, and nothing but the one row:

   ```sql
   BEGIN;
   UPDATE organizations
      SET workos_org_id = NULL, workos_client_id = NULL, updated_at = now()
    WHERE id = '<organisation id>'
      AND sso_required = false
      AND jit_join_enabled = false
      AND workos_client_id IS DISTINCT FROM (SELECT client_id FROM workos_home);
   -- Expect: UPDATE 1. Anything else: ROLLBACK and look again.
   COMMIT;
   ```

   On a pre-0023 database, drop the `workos_home` condition and compare with the production
   client id literally, as in step 1.

4. **Record it.** Note the organisation, the cleared `workos_org_id`, who did it and why, in
   the incident log; the audit log has no event for an operator's SQL. Optionally delete the
   orphaned organisation in the WorkOS environment it belongs to.

The organisation is now as if SSO had never been turned on. An owner turns it on again from the
production deployment, which writes a link in the right environment and files `org.sso.enabled`.

## 4. The logout redirect, in both environments, before deploying

Signing out of xecret also ends the person's AuthKit session: `DELETE /api/auth/session`
revokes the xecret session, then answers WorkOS's logout URL for the AuthKit session it came
from, with `return_to=<origin>/sign-in`, and the dashboard sends the browser there. "This isn't
me" on a held-back sign-in goes the same way, returning to `<origin>/sign-in?error=declined`.
WorkOS returns the browser only to a logout redirect configured for that environment.

1. **Before deploying the build that does this, add `<origin>/sign-in` as a logout redirect in
   both WorkOS environments** — Staging (`http://localhost:3030/sign-in`, and every staging
   deployment's origin) and Production (the production origin). Otherwise every sign-out can
   land on a WorkOS error page instead of the sign-in page (step 2). Nobody stays signed in to
   xecret either way — its session is revoked before the browser is sent anywhere — but every
   person who signs out meets the error. If the environment matches redirects exactly, query
   string included, add `<origin>/sign-in?error=declined` too.
2. **Do not count on a fallback.** WorkOS may answer a `return_to` it does not know with an
   error page rather than its default redirect; which one it does is to be verified live, on
   Staging, not assumed — so step 1 comes first, not after the first complaint.
3. **Check on Staging**, with a person, after deploying there:
   - **The decline path, with only `<origin>/sign-in` allowed.** Configure `/sign-in` alone, get
     a sign-in held back (single sign-on through `org_test_idp` from the plain "Sign in" button
     always is), choose "This isn't me", and expect `/sign-in?error=declined` with its sentence.
     If WorkOS refuses it because of the query string, add the `?error=declined` URL to both
     environments and record that here.
   - **Sign-out when the AuthKit session has already ended** — expired, or ended in another tab
     or from the WorkOS dashboard. The logout URL then names a session WorkOS no longer has;
     expect the browser on `/sign-in` all the same, not on a WorkOS error page.
   - **An unconfigured `return_to`.** Remove the redirect for a moment and sign out, to see what
     WorkOS really does without it (step 2). That is what Production would do if step 1 were
     missed.

## 5. What still needs a person

- `check:env` does not read the database, so it cannot tell you `workos_home` is unrecorded on a
  self-hosted database; the first owner who turns SSO on is told instead.
- Changing which WorkOS environment a database belongs to — moving a self-hosted deployment from
  one WorkOS account to another — means clearing every link first (§3, for each), then updating
  `workos_home`.

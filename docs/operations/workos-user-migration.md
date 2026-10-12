# Firebase → WorkOS user migration

How existing users move from Firebase Auth to WorkOS and keep signing in with the same password.
One-off, run by the owner at cutover. The design is `.local/workos-auth.md` §6, with §5 (the
linking rules) and PR #100's "For WS-2" notes 6, 9 and 12.

The tool is `scripts/migrate-users-to-workos.ts`. Its rules live in
`packages/db/src/firebase-migration/`, where the `@xecret/db` test suite covers them.

---

## 1. What it does

Three passes, each a dry run unless given `--apply`:

| Pass | What it does |
| --- | --- |
| **import** (default) | Creates one WorkOS user per importable Firebase user. A password user's Firebase scrypt hash goes with it. Each user carries `external_id = firebase uid`. It writes a `firebase_uid → workos_user_id` mapping file next to the export. |
| **`--backfill`** | Runs `UPDATE users SET workos_user_id = $w WHERE firebase_uid = $f AND workos_user_id IS NULL`, row by row. Before that, it re-checks every mapped id against WorkOS. |
| **`--self-test`** | Creates one synthetic user with a hash built exactly the way the import builds one, then signs in as it with the right password and with a wrong one, then deletes it. It proves the WorkOS environment verifies our hashes before any real user is involved. |

### Who is imported

| Firebase user | What happens | Why |
| --- | --- | --- |
| Verified email, has a password | Imported **with** its hash | The same password keeps working. |
| Verified email, Google only | Imported **without** a password | WorkOS attaches their Google credential to this user at their first Google sign-in ([identity linking](https://workos.com/docs/authkit/identity-linking)). That needs Google OAuth in WorkOS, see §2. |
| Verified email, another provider only | Imported without a password | They can use "forgot password", or that provider once WorkOS is configured for it. |
| **Unverified email** | **Skipped** | Plan §6 allows "import without a password, or skip". Skip is the stricter choice. Whoever registered an address they don't own must not end up holding a WorkOS user for it. With a password, that is a pre-account-takeover (PR #100 note 12). Even without one, the real owner later collides with it. Nothing is lost: the Firebase sign-in already refuses unverified addresses, so these people have no xecret account. |
| **Disabled** | **Skipped**, and listed by uid | WorkOS users have no disabled state, so importing would switch the account back on. Decide by hand, see §5. |
| No email (phone or anonymous) | Skipped | WorkOS users are keyed by email. |
| Password fields that do not decode | Skipped, and listed | The import does not turn a working password into a forced reset without anyone noticing. |
| Had Firebase MFA | Imported, and counted | WorkOS cannot import second factors, so they are not migrated. |

Names come from Firebase's `displayName`, falling back to Google's: the first word becomes the
first name and the rest the last name. These fields are for display only.

### Idempotency, and WorkOS users that already exist

Every run looks the user up by `external_id`, then by email, and never modifies or deletes an
existing WorkOS user:

- **Found by `external_id`**: imported by an earlier run, so the user is reused. A re-run creates
  nothing.
- **Found by email, verified, no `external_id`**: someone signed up in WorkOS directly. That user
  is **reused** and mapped, with no password and no `external_id` written. WorkOS has proven they
  own the inbox, which is exactly what the linking pass adopts on (§5 step 2).
- **Found by email, unverified**: a **conflict**, reported and left alone. An unverified WorkOS user
  may carry a password someone else chose.
- **Found by email with another `external_id`**, or found by `external_id` with a different address
  now: a **conflict**, reported and left alone.

PR #100 note 9 asked whether the import can set `external_id = firebase_uid`. **Yes**, through the
Create User API. The backfill uses it as its proof of identity.

---

## 2. Prerequisites (owner)

- [ ] **Firebase CLI signed in as the project owner.** Run `firebase login --reauth`. On
      2026-10-12 the stored login had expired: Google refused the refresh token.
- [ ] **Phase Production has the Firebase hash parameters.** Copy `FIREBASE_SCRYPT_SIGNER_KEY`,
      `FIREBASE_SCRYPT_SALT_SEPARATOR`, `FIREBASE_SCRYPT_ROUNDS` and `FIREBASE_SCRYPT_MEM_COST`
      from Phase Development. Both environments use the same Firebase project, `xecret-management`.
      Until then, the import's dry run says so and `--apply` refuses to import password users.
- [ ] **Phase Production has `WORKOS_API_KEY` and `WORKOS_CLIENT_ID`** (done 2026-10-12).
- [ ] **WorkOS Production authentication settings:**
  - [ ] Email + Password is on.
  - [ ] **Google OAuth uses the Firebase project's own Google OAuth client** (plan §8 Q1): copy
        its client ID and secret from Google Cloud Console into WorkOS, and add WorkOS's redirect
        URI to that client. Without this, Google-only users cannot sign in with Google. They can
        still use "forgot password".
- [ ] **A private directory outside the repository** for the export and the mapping. The export
      holds every user's password hash. The script refuses paths inside the repository.

### The two environments

| WorkOS environment | Client id (pass to `--confirm-client`) | Phase environment | npm script |
| --- | --- | --- | --- |
| Staging | `client_01M36CECEQ1FY9TA1F952FY958` | Development | `npm run phase:migrate-users:staging --` |
| Production | `client_01M36CECX3Z66Q2FYY2FN8WG73` | Production | `npm run phase:migrate-users:production --` |

---

## 3. Safety rules the script enforces

- **Dry run unless `--apply`.** A dry run reads WorkOS (and, for the backfill, the database) and
  writes nothing.
- **The WorkOS environment is verified, not assumed.**
  - A WorkOS API key does not reveal its environment. The current format is `sk_` plus base64 of
    `key_<id>,<secret>`. WorkOS will, however, say whether a key and a client id belong to the same
    environment. Before any other request, the script checks `WORKOS_API_KEY` against
    `WORKOS_CLIENT_ID` with a deliberately invalid code: a matching pair gets `invalid_grant`, a
    mismatched pair `invalid_client`.
  - Every `--apply` must name its target with `--confirm-client`. Type the id from the table above;
    don't copy it from the script's output.
  - A legacy staging key (`sk_test_…`) is refused for `--env production`.
- **A mapping is bound to its environment and client id.** The backfill re-checks every id against
  WorkOS and links a row only if:
  - the WorkOS user exists in the environment in use;
  - its email is verified;
  - and it is provably this Firebase account: `external_id` equals the uid, or, for a reused user,
    the address matches.
- **A staging backfill `--apply` is refused.** Development and Production share one database. A
  Staging id in `users.workos_user_id` sits where the Production id belongs: the real Production
  sign-in then hits a `conflict`, and the backfill, which only fills NULLs, can no longer fix it.
  `--staging-database` overrides this only for a self-hoster whose staging database is separate.
- **The export and the mapping must live outside the repository.**
- **Nothing secret is printed.** Users are named by Firebase uid, xecret user id and WorkOS id. No
  hash, salt, hash parameter, key or address appears in the output, and WorkOS error messages are
  scrubbed of what the request sent.
- **Never forces.**
  - The backfill only fills a NULL.
  - A row a sign-in already linked is reported, never overwritten.
  - `23505` (`users_workos_user_id_unique`: the id is already on another row) and `23514`
    (`users_workos_user_id_format_check`) are reported for a human to resolve.
  - Each row is its own statement, so one refusal doesn't stop the rest.
- **Soft-deleted rows are linked too.** The linking pass refuses a deleted account by identity and
  by address alike, so linking one changes no outcome. It also leaves one fewer row for the
  decommission migration to decide about.

Exit codes: `0` finished with no problems, `1` refused or failed, `2` finished with problems
listed under the summary.

---

## 4. Production cutover

**Order:** deploy the WorkOS sign-in (WS-2) first, then immediately export, import and backfill.
This is the order in plan §6.3.

Deploying first removes the Firebase sign-in, which freezes every Firebase password. If you import
earlier, anyone who changes their Firebase password between the import and the deploy keeps their
*old* password in WorkOS, because a re-run never modifies an existing WorkOS user. The window
between deploy and import is a few minutes. A user who signs in during it simply signs up in
AuthKit: §5 step 2 adopts their account by verified email, and the import then reuses their WorkOS
user.

Run the backfill straight after the import. A sign-in that arrives before the backfill still works
through email adoption, *unless* the database still holds an old address for that person. The
database mirrors Firebase's email only at each Firebase sign-in, so the address can be stale. In
that case a second account is created.

```bash
# Run from the repository root. DIR is a private directory outside the repository.
DIR=/path/to/private/xecret-migration

# 0. Rehearse beforehand: the self-test, then a dry run against a fresh export.
#    The self-test creates and deletes one synthetic user (migration-selftest+…@example.net).
npm run phase:migrate-users:production -- --self-test
firebase auth:export "$DIR/users.json" --format=json --project xecret-management
npm run phase:migrate-users:production -- --export "$DIR/users.json"

# 1. Deploy the WorkOS sign-in (WS-2). Run the deployment-check skill first.

# 2. Export again: Firebase passwords are frozen now.
firebase auth:export "$DIR/users.json" --format=json --project xecret-management

# 3. Import: dry run, read it, then apply.
npm run phase:migrate-users:production -- --export "$DIR/users.json"
npm run phase:migrate-users:production -- --export "$DIR/users.json" \
  --apply --confirm-client client_01M36CECX3Z66Q2FYY2FN8WG73

# 4. Backfill: dry run, read it, then apply.
npm run phase:migrate-users:production -- --backfill --export "$DIR/users.json"
npm run phase:migrate-users:production -- --backfill --export "$DIR/users.json" \
  --apply --confirm-client client_01M36CECX3Z66Q2FYY2FN8WG73
```

The mapping is written to `$DIR/workos-mapping.production.json`, or wherever `--mapping` points. Re-running any step is
safe.

**Then smoke-test** (plan §6.3):

- password sign-in with an imported user's *existing* password;
- Google sign-in for a Google-only user;
- a new sign-up;
- logout and session revocation;
- vault unlock and reset;
- the CLI PKCE flow.

**Afterwards:**

- Delete the export. It holds every password hash.
- Keep the mapping (it holds no secret) until the decommission migration.

---

## 5. Resolving what the output lists

| Problem | What it means | What to do |
| --- | --- | --- |
| `skipped (disabled)` | Not imported. | If that person must stay locked out, soft-delete their xecret row. Otherwise §5 step 2 adopts it when they sign up in WorkOS with the same verified address. The linking pass refuses deleted rows. |
| `conflict (email-held-by-unverified-user)` | Someone started a WorkOS sign-up for that address and never verified it. | Delete that WorkOS user in the dashboard, then re-run the import. |
| `conflict (email-held-by-other-identity)`, `conflict (external-id-email-mismatch)`, `conflict (imported-user-unverified)` | WorkOS holds something that doesn't match this Firebase user. | Investigate in the WorkOS dashboard. Nothing was changed. |
| `skipped (malformed-password)`, or a hash-length error | The export's hash doesn't fit the hash parameters. | Check that the export and the parameters both come from `xecret-management`. |
| backfill: `already linked to …, mapping says …` | A WorkOS sign-in linked the row first. | Compare the two WorkOS users. Nothing was changed. |
| backfill: `would be 23505`, or `23505: … is already on user …` | Another row holds that WorkOS id. Usually a second account created by a sign-in made before the backfill. | Merge by hand. |
| backfill: `mapping entry rejected (…)` | The WorkOS user is missing (wrong environment, or deleted), unverified, or not provably this account. | Re-run the import, or investigate. |
| backfill: `not imported (email-unverified)` | The row stays unlinked. | Nothing. Their first WorkOS sign-in, once verified, adopts it by email (§5 step 2). |
| backfill: `no such Firebase user in the export` | The Firebase account was deleted. | Decide before the decommission migration (0018's warning). |
| `Firebase users with no xecret row` (count) | They never signed in to xecret. | Nothing. Their first WorkOS sign-in creates their account (§5 step 3). |

---

## 6. Staging rehearsal and cleanup

Run the same commands through `npm run phase:migrate-users:staging --` with
`--confirm-client client_01M36CECEQ1FY9TA1F952FY958`. The import and the self-test work in full.

The backfill `--apply` is refused, because the database is shared. Its dry run is safe.

To remove staging users the import created, delete them in the WorkOS dashboard (Staging → Users),
or by id from the mapping's `created` entries:

```bash
curl -X DELETE "https://api.workos.com/user_management/users/<user_id>" \
  -H "Authorization: Bearer $WORKOS_API_KEY"
```

Only delete *Production* users before the backfill has linked them. Once a row holds an id,
deleting that WorkOS user strands the row: the person's next sign-up gets a new id, and §5 reports
a conflict.

⚠ **The shared database and Staging sign-ins.** The linking pass adopts accounts by verified email
(§5 step 2). A sign-in to a local or staging build against WorkOS Staging, made with a real user's
address, therefore writes a *Staging* id onto that real row. That blocks the production link
exactly as a staging backfill would. Test WorkOS Staging sign-ins with addresses that have no row
in the shared database.

Also note that in WorkOS Staging, `example.com` belongs to WorkOS's built-in SSO test
organisation, so every password attempt for an `@example.com` user is answered `sso_required`.
The self-test uses `example.net` for that reason.

---

## 7. Rollback, and when this tooling goes

- **Neither pass touches `firebase_uid`.** Rollback stays what plan §6.5 describes: the column
  and the Firebase project remain until the decommission migration.
- **Undoing a backfill** means setting those rows' `workos_user_id` back to NULL, but only for rows
  no WorkOS sign-in has used since. Do it by hand, with the mapping in front of you.
- **This tooling is deleted in the decommission migration**, together with `users.firebase_uid`:
  `scripts/migrate-users-to-workos.ts`, `packages/db/src/firebase-migration/`, and the
  `migrate:users` / `phase:migrate-users:*` npm scripts.

---

## 8. Verification record (2026-10-12)

- **Self-test on WorkOS Staging, with the project's real hash parameters.** Every step passed:
  - local scrypt reproduces Firebase's published example;
  - WorkOS accepted the PHC hash;
  - the right password authenticated;
  - a wrong password got `invalid_credentials`;
  - the synthetic user was deleted.
- **End to end on Staging with a synthetic export in Firebase's format** (`example.net`, throwaway
  passwords hashed with the real parameters):
  - **Dry run:** 3 to create, 1 reuse, 1 conflict, 3 skipped.
  - **Apply:** created 3. Re-running created 0 and found all 3 by `external_id`.
  - **Sign-in:** imported users signed in with their *original* passwords, and wrong passwords
    were refused. The reused user's Firebase password was rightly not carried over.
  - **Backfill dry run** against the real shared database: read-only, 4 rows.
  - **Backfill `--apply`** against a throwaway PostgreSQL, using every real migration and the
    production driver. It linked 3 rows, including a soft-deleted one. It left a row a sign-in had
    already linked untouched. Re-running was a no-op. `23505` and `23514` were reported, not
    raised, under both PGlite and postgres.js.
  - Every synthetic user was deleted afterwards. WorkOS Staging holds no users.
- **Production, read-only:**
  - the key and client pairing verified;
  - the import's dry run read WorkOS Production;
  - WorkOS Production holds no users.
  - The real export and the Production dry run wait on the prerequisites in §2.

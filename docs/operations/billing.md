# Billing — Dodo Payments (P12)

How xecret takes payment, what an operator sets up before it can, and what to do when it
goes wrong. The code is `apps/web/src/server/billing/`; the plan it was built from is
`.local/plans/v2/01-billing.md` §P12.

> **The rule this whole system is built around:** a secret fetch is never refused for a billing
> reason. Not for a declined card, a cancelled plan, an expired subscription or an allowance ten
> times overspent. Billing changes what the dashboard offers; it never touches the data path
> (`isDataPlaneActive`, `@xecret/core/entitlements`).

---

## 1. How it fits together

```
 owner ──► /app/{org}/settings/billing ──► POST /api/orgs/{org}/billing/checkout ──► Dodo checkout
                                            (records the checkout and its nonce)       │
                                     (the return from checkout grants nothing)         │ pays
                                                                                       ▼
 org_subscriptions ◄── POST /api/billing/webhook ◄──── signed Standard Webhooks ◄──── Dodo
        │                (verify → place → claim → apply the snapshot, in one transaction)
        │
        ├─► entitlements (resolveOrg reads the row it already loads — no extra query)
        ├─► seat sync: membership change writes the debt in its own transaction ──►
        │              Dodo change-plan after the commit (one push per org at a time)
        ├─► usage: fetches counted in the isolate ──► org_usage_counters (≤ 15 s) ──►
        │          Dodo meter (hourly, paid periods only)
        └─► nightly reconciler: our rows and the membership vs Dodo — reports drift, corrects nothing
```

**Dodo is the billing truth; `org_subscriptions` is the access truth (D15).** Nothing on a
request path calls Dodo. Webhooks move our rows towards Dodo; the reconciler tells a human when
they disagree.

| Piece | File | When it runs |
|---|---|---|
| Configuration and catalogue | `billing/config.ts` | every billing request |
| Dodo REST client (plain `fetch`) | `billing/client.ts` | checkout, plan change, portal, seat sync, usage, reconcile |
| Webhook | `billing/webhook.ts`, `handlers/`, `snapshot.ts` | `POST /api/billing/webhook` |
| Owner routes | `billing/service.ts` | `/api/orgs/{org}/billing[/checkout|/change|/portal]` |
| Seat sync | `billing/seats.ts` | after every membership change; retried hourly |
| Usage metering | `billing/usage.ts` | counted per fetch; flushed within 15 s; reported hourly |
| Reminder emails | `billing/reminders.ts`, `mail.ts` | from webhooks, the seat sync and the hourly job |
| Hourly job | `billing/jobs.ts` | Cron `17 * * * *`, after the vault purge |
| Reconciler | `billing/reconcile.ts` | Cron `41 3 * * *` |
| Public "do we take payments?" | `billing/payments-live.ts` | pricing, terms, about, FAQ, features, home |
| Operator tool | `scripts/plan-set.ts` | by hand — trials, overrides, Enterprise |

### How a subscription is placed

A webhook is attached to an organisation by **our own records only**: the subscription id the
row already follows, the checkout session a payment names (`billing_checkouts`), or the
metadata our checkout put on it — the organisation id **and the checkout's random nonce**,
which must be the nonce of an open (unspent, under a week old) checkout of that same
organisation. A Dodo payment link with one of our organisation ids typed into its metadata is
signed by Dodo like anything else; it carries no nonce, so it attaches to nothing and is
raised. Attaching a subscription spends its checkout.

---

## 2. Setting it up — test mode on staging first, live mode on production

**Test mode never runs against production.** A test subscription on the production database
is a row the live deployment can neither bill nor talk to Dodo about; the code refuses to mix
modes (every row records the mode its ids came from, `dodo_mode`), but the only clean
rehearsal is a separate deployment. The public pages say payments are taken only when the
deployment is in **live mode** (`takesLivePayments`), so a staging rehearsal never tells the
public that paying works.

`.local/dodo/dodo-setup.md` is the click-by-click guide. **Where it and this code disagree, the
code is right** and the guide is out of date:

| The guide says | What the code reads | Why |
|---|---|---|
| Six products: Pro, Team, **Scale** × monthly/yearly | **Four**: Pro and Team × monthly/yearly | Scale was withdrawn (`RETIRED_PLANS`). Enterprise is a contract and never sold through checkout. |
| Localized prices for INR, JPY, AUD | Also **EUR** | The pricing page publishes a euro sheet (€9/€6 Pro, €21/€13 Team). Set fixed EUR prices on all four products, or remove the sheet. |
| Prices from `pricing-plan.md` §4 | The pricing page's figures | Pro monthly $8 / yearly $60; Team $19 / $144 — check every currency against `apps/web/src/app/pricing/page.tsx`, which is what customers were shown. |
| Meter with a **free threshold** per product (150 / 500 / 2,000 units) | **Free threshold 0** on every product | The code subtracts the allowance itself (`includedFetchesPerMonth` in `plans.ts`, plus any support override — Pro 200k, Team 1M). A Dodo threshold as well would give it twice. |
| `DODO_METER_SECRET_FETCH` | The meter's **event name** (e.g. `secret_fetch_kilo`) | Usage is reported by event name. `check:env` refuses an `mtr_…` id. |
| Twelve subscribed webhook events | The twelve, **plus** `subscription.updated` and `subscription.past_due` | `subscription.updated` is how a cancellation scheduled for the period end arrives; without it the row learns of it only at the end. |
| A SCIM add-on ($249) | Not sold | SCIM is an Enterprise inclusion since Scale went; nothing reads `DODO_ADDON_SCIM`. |
| Self-host products in Phase | Not read by P12 | `license_key.created` is stored for any product; the licence page is P22. |
| Customer portal return URL `/app/settings/billing` | Set per session to `/app/{org}/settings/billing` | The portal session is created with its own return URL. Any default is fine. |

**Trials are the owner's Dodo-side choice.** Team's 14-day trial is configured on the Dodo
product, and so is whether the checkout requires a card before the trial starts. With a card,
the trial converts by charging it (the owners are emailed three days and one day before); without
one, or when the charge fails, Dodo puts the subscription on hold, the plan keeps working, and
after fourteen days on hold the hourly job moves the organisation to Free (§4). The trial
emails say exactly that, so either choice is described truthfully.

### The variables

All or nothing: with **none** set, payments are off and nothing else changes; with **some**,
every billing route and the webhook answer 503 naming what is missing.

| Name | Home | What |
|---|---|---|
| `DODO_API_KEY` | **secret** — `wrangler secret put` | Developer → API Keys, write permission |
| `DODO_WEBHOOK_SECRET` | **secret** — `wrangler secret put` | the endpoint's signing secret, `whsec_` + base64 — anything else is refused as a half-configuration |
| `DODO_ENVIRONMENT` | var — `wrangler.toml` | `test_mode` (staging) or `live_mode` (production) |
| `DODO_PRODUCT_PRO_MONTHLY` | var | `pdt_…` |
| `DODO_PRODUCT_PRO_YEARLY` | var | `pdt_…` |
| `DODO_PRODUCT_TEAM_MONTHLY` | var | `pdt_…` |
| `DODO_PRODUCT_TEAM_YEARLY` | var | `pdt_…` |
| `DODO_METER_SECRET_FETCH` | var | the meter's event name |
| `DODO_ADDON_SAML` | var, optional | the SAML add-on id |

Put all of them in Phase.dev for the environment, then: the two secrets with
`wrangler secret put <NAME> --env <staging|production>` (from `apps/web/`, pasting from Phase),
and the vars in `[env.<staging|production>.vars]` in `apps/web/wrangler.toml` — the commented
block under production lists them. Product ids are not credentials; committing them is the
same as committing `WORKOS_CLIENT_ID`.

### In order

1. **Staging first.** `[env.staging]` in `wrangler.toml` is a stub with no routes and no
   bindings: give it its own database (never production's), its Hyperdrive, Secrets Store
   and rate-limit bindings, and the `xecret-staging.playxoft.com` route, copied from the
   production block, and apply migrations **0024 and 0025** to that database.
2. Dodo, **test mode**: the four products (per seat, with every currency the pricing page
   shows), Team's trial and its card requirement, the meter (free threshold 0), the SAML add-on
   if you sell it, an API key, the customer portal, and the webhook endpoint
   `https://xecret-staging.playxoft.com/api/billing/webhook` with the events above.
3. Phase.dev → the variables above, test-mode values, in the Phase environment staging is
   deployed from (Development today, as WorkOS's staging values are — see `package.json`'s
   `phase:migrate-users:staging`); `DODO_ENVIRONMENT = "test_mode"` in `[env.staging.vars]`.
4. `phase run --env Development -- npm run check:env` — the billing lines validate with the
   same function the Worker uses.
5. Deploy staging (`npm run deploy -- staging`) and run §3 against it.
6. **Production, live mode**: Dodo's live mode — the same products, meter, add-on, API key,
   portal, and the webhook `https://xecret.playxoft.com/api/billing/webhook`. Phase.dev
   Production gets the live values, `DODO_ENVIRONMENT = "live_mode"` in `[env.production.vars]`.
7. `npm run phase:check-env:production`.
8. **Apply migrations 0024 and 0025** to the production database before deploying (see §5).
9. `npm run phase:check-deploy` — the `billing (group)` line must say every member is in place.
10. Deploy. Confirm both Cron Triggers (`17 * * * *`, `41 3 * * *`) are listed on the Worker,
    and that `/api/internal/scheduled/billing-hourly` and `…/billing-daily` answer 404 from
    outside. Then one real purchase in each currency, refunded.

---

## 3. The test run — on staging, in test mode

On `xecret-staging.playxoft.com`, with a Dodo test card, on a throwaway organisation:

- [ ] Billing screen → choose Team yearly → checkout. Back on the billing screen it says it is
      waiting for the payment, then shows Team within a minute. Dodo's endpoint page shows the
      deliveries answered 200.
- [ ] The audit log shows `billing.checkout_started` and then `plan.changed` (actor
      `Dodo webhook`, no operator).
- [ ] Click "Continue to checkout" twice quickly on a second throwaway organisation: one
      checkout session at Dodo, one `billing.checkout_started`.
- [ ] Create a second organisation with the same owner and buy a plan for it: Dodo shows **two**
      customers for the owner's address, and each organisation's Manage billing opens its own.
- [ ] Invite and accept a member: Dodo's subscription quantity goes up by one, the period end
      does not move, and once the push lands the owners get the "now billed for N seats" email.
      Remove them: it goes down, and the difference shows in the customer's wallet in Dodo.
- [ ] Suspend a member: the quantity does **not** change, and no seat email is sent.
- [ ] Change plan (Team → Pro, yearly → monthly): the preview says "at renewal", nothing is
      charged today. Then invite a member: the quantity does not change at Dodo until the
      period turns (the push waits for the scheduled change; `billing_seat_syncs.last_error` is
      `scheduled_change`), and changes within the hour after it.
- [ ] Fail a payment with Dodo's decline card: status `on_hold`, the red banner says builds are
      unaffected, the owners are emailed once — and `xecret run` against the organisation
      still works.
- [ ] Cancel from Manage billing: the screen says the plan ends at the period end; access is
      unchanged until then.
- [ ] Replay a delivery from Dodo's dashboard: answered 200, nothing changes, one
      `billing_webhook_events` row.
- [ ] Buy through a Dodo **payment link** with `metadata_xecret_org_id` set to the throwaway
      organisation's id: the delivery is answered 200, the organisation stays on Free, and the
      log has "attached to nothing".

### Cleaning up test rows

Staging's database is staging's; nothing needs cleaning there. If a test-mode subscription
ever reached a database that will take live payments (the earlier version of this runbook ran
the test on production), clear it **before** switching that deployment to `live_mode`. Every
such row was written by test-mode webhooks, so it records `dodo_mode = 'test_mode'` — or, from
before migration 0025, no mode at all beside a `sub_…` id the live API does not know (check
each in the Dodo test dashboard first):

```sql
BEGIN;
-- What will change: review before running the rest.
SELECT o.slug, s.plan, s.status, s.dodo_subscription_id, s.dodo_mode
  FROM org_subscriptions s JOIN organizations o ON o.id = s.org_id
 WHERE s.dodo_mode = 'test_mode';

UPDATE organizations SET seat_limit = 5, updated_at = now()
 WHERE id IN (SELECT org_id FROM org_subscriptions WHERE dodo_mode = 'test_mode' AND plan <> 'free');
UPDATE org_subscriptions
   SET plan = 'free', billing_interval = NULL, status = 'active', seats = 1,
       dodo_subscription_id = NULL, dodo_customer_id = NULL, dodo_product_id = NULL,
       dodo_event_at = NULL, dodo_event_id = NULL, dodo_mode = NULL,
       dodo_scheduled_change_at = NULL, dodo_currency = NULL, dodo_billing_country = NULL,
       current_period_start = NULL, current_period_end = NULL, trial_ends_at = NULL,
       cancel_at_period_end = false, renewal_amount_minor = NULL, metered_from = NULL,
       on_hold_since = NULL, limit_overrides = NULL, currency = NULL, billing_country = NULL,
       region_locked_until = NULL, updated_at = now()
 WHERE dodo_mode = 'test_mode';
DELETE FROM billing_seat_syncs
 WHERE org_id NOT IN (SELECT org_id FROM org_subscriptions WHERE dodo_subscription_id IS NOT NULL);
COMMIT;
```

`billing_checkouts`, `billing_webhook_events` and the audit log keep their test rows — they
are records of what happened, and nothing reads a spent test checkout again.

---

## 4. Operating it

### What to alert on

Every line below is logged at `error` and is meant to page somebody or open a ticket:

| Message starts | Meaning | Do |
|---|---|---|
| "A subscription disagrees with Dodo" | The reconciler found drift (`billing.drift_detected` names the fields — `seats` includes the membership no longer matching Dodo's quantity) | Find out *why* before changing either side. Do not "fix" it with `plan:set`. |
| "A second live Dodo subscription arrived" | Two checkouts completed; the customer is paying twice | Refund and cancel the newer one in Dodo. |
| "A live Dodo subscription arrived for an organisation whose plan an operator set" / "A checkout payment arrived for an organisation whose plan an operator set by hand" | Somebody bought over a hand-made grant | Refund it, or move the organisation onto it deliberately. |
| "A signed … names one of our organisations in its metadata but carries no nonce" / "…did not come from an open checkout of its own" | A purchase outside our checkout — a payment link with our metadata typed in, or a replayed nonce | Refund or cancel it in Dodo. Nothing was attached. |
| "…recorded in the other Dodo mode" | A test-mode row on a live deployment, or the reverse | Clear the old mode's rows (§3) before taking payments. |
| "An organisation's Dodo customer is held by another organisation too" | A shared customer from before checkouts forced one per organisation; the portal was refused | Give each organisation its own customer in Dodo and update the rows. |
| "A subscription was on hold for N days and has been ended here" | Fourteen days unpaid: the organisation is on Free | Cancel the subscription in Dodo, or leave it if the customer is about to pay (its next `active` event gives the plan back). |
| "A Dodo subscription is on a product this deployment does not sell" | A `DODO_PRODUCT_*` is wrong, or a product was added in Dodo | Fix the variable; nothing was granted. |
| "Dodo reports a billing country … region-locked" / "billing country is not the country that issued its card" | The PPP guardrail (pricing-plan §4); raised once, when Dodo's report changes | Review the customer in Dodo. Nothing was changed automatically, deliberately. |
| "Dodo refunded a payment" / "A cardholder opened a dispute" | Money moved back, or a chargeback | Respond in Dodo. Access is deliberately unchanged. |
| "A seat change has failed to reach Dodo N times and is no longer retried" | Ten failures: the debt is dead-lettered, raised once | Check the subscription in Dodo; retry by hand (below) once fixed. |
| "A subscription ended for an organisation that still holds the SAML add-on" | The add-on is never removed automatically | Decide; if removing, `plan:set --addon saml --off` and delete its WorkOS connection. |
| "This deployment is missing the DODO_… binding" | Billing is half-configured (a malformed `whsec_` secret counts) | Set the missing variables (check:deploy names them). |

### Seat-sync debts

`billing_seat_syncs` lists organisations whose seat count is still owed to Dodo. The debt is
written **inside the membership change's own transaction** (`addMember`, `removeMember`), for an
organisation Dodo bills, so it exists even if the push after the commit never runs. A push
takes the organisation's lease (`claimed_until`), counts under the debt's `generation` — which
every membership change bumps — and clears the debt only if the generation is unchanged; a
second push that finds the lease held leaves the work to the holder. The hourly job retries
only what is due: past its backoff (`not_before`: 2, 4, 8 … minutes, capped at a day), not
waiting for a scheduled plan change, not leased, not dead-lettered. After ten failures the
debt is dead-lettered and raised once; a new membership change makes it due again.

```sql
SELECT org_id, generation, attempts, last_error, not_before, dead_lettered_at
  FROM billing_seat_syncs ORDER BY queued_at;
-- Retry a dead-lettered one by hand, once the cause is fixed:
UPDATE billing_seat_syncs SET dead_lettered_at = NULL, attempts = 0, not_before = NULL
 WHERE org_id = '…';
```

Seat pushes use Dodo's `prorated_immediately_keep_cycle`: the difference for the time left in
the period is charged when somebody joins, and a seat removed puts the difference in the Dodo
customer's wallet — one customer per organisation — which Dodo applies to the next charges and
never refunds to the card; the period and the renewal date never move.
(`difference_immediately`, which the plan named, resets the billing cycle to the day of every
change.) While a plan change is scheduled for the period end, Dodo refuses any other change
with a 409, so the push waits until an hour after the scheduled date.

### Changing an organisation by hand

`npm run plan:set` still works and is how support grants a trial extension, a fair-use raise or
an Enterprise contract. On an organisation billed through Dodo it refuses `--plan`,
`--interval`, `--seats` and `--status` — Dodo owns those and its next webhook would overwrite
them — unless `--over-dodo` is passed. `--over-dodo` **takes the organisation off its Dodo
subscription**: the provider ids are cleared in the same transaction as the plan
(`detachFromProvider`), and the run prints the subscription id it detached. That subscription
is still live at Dodo — cancel it there, or it keeps billing. Add-ons and `--limit-override`
are always allowed.

### Usage

Fetches are counted in each Worker isolate, per second, and written within fifteen seconds of
the first one waiting — a timer in that fetch's own `waitUntil` — or as soon as fifty are
waiting, never on the response. Each second's count lands in the billing period that covered
it, not the one current when the write lands. An isolate evicted before its timer fires loses
those seconds of counts, and a failed write is dropped rather than retried: the meter can only
ever under-count.

Only periods the subscription paid for are metered: `metered_from` is its activation, or its
trial's end when it had one, and a counter row whose period began earlier — usage on Free, or
during a trial — is never billed. Each thousand fetches past the allowance is reported hourly
as one Dodo event with the id `{orgId}:{periodStart}:{unitIndex}`; Dodo treats an event id as an
idempotency key, so a retried run cannot bill twice. Dodo refuses an event stamped more than an
hour ago, so units still owed for a period that has just ended are reported — once — into the
next one. `org_usage_counters` is the dispute record.

### Deleting an organisation

An organisation Dodo still bills cannot be deleted — directly, or with the account of its last
member — until its subscription is cancelled (Billing → Manage billing). A deleted organisation
would otherwise renew for ever with nobody able to open it.

---

## 5. Database

Migration **0024** (`0024_dodo_billing.sql`): four nullable columns on `org_subscriptions`
(`current_period_start`, `dodo_product_id`, `dodo_event_at`, `renewal_amount_minor`) and four
tables — `billing_checkouts` and `billing_license_keys` (insert-only by grant),
`billing_seat_syncs`, `billing_reminders`.

Migration **0025** (`0025_dodo_billing_hardening.sql`): seven nullable columns on
`org_subscriptions` (`metered_from`, `dodo_mode`, `dodo_event_id`, `on_hold_since`,
`dodo_scheduled_change_at`, `dodo_currency`, `dodo_billing_country`), the checkout nonce and its
consumption on `billing_checkouts` (the application may update those two columns and no
other), the lease, generation, `not_before` and dead-letter columns on `billing_seat_syncs`, the
`plan_ended_unpaid` reminder, and `billing_requests` (idempotency keys, pruned daily). One
backfill: `metered_from` for subscriptions Dodo already bills.

Both are additive; apply them **before** the build that reads them, because every whole-row
query of these tables from that build names the new columns — the billing routes, the webhook,
the jobs, the membership changes, and the check behind deleting an organisation or an account:

```sh
phase run --env Production -- npm run db:migrate
```

---

## 6. What this does not do

- **Enterprise** is a contract and a manual Dodo invoice; it is set with `plan:set`, never
  through checkout.
- **SCIM** is an Enterprise inclusion and is not sold.
- **Plan ceilings are not enforced yet.** The entitlement engine (P11) can refuse the sixth
  project on Free, but no route does: every organisation has been unlimited through pre-alpha,
  and pricing-plan §5 promises thirty days' notice before any limit applies. Turning the
  ceilings on is a separate decision with its own notice.
- **No card or invoice UI.** Dodo's customer portal is it.
- **A subscription ended here after fourteen days on hold is not cancelled at Dodo.** The alert
  says so; a human decides.

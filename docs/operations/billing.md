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

**The Dodo account is shared with the owner's other products**, and Dodo sends every endpoint
every subscribed event type for all of them — most of what reaches the webhook is not ours. An
event that places to nothing of ours is claimed and answered 200, and that is all: no alert, no
audit row, no stored record, no email, and one `debug` line naming the delivery (its row in
`billing_webhook_events` is the trace). A licence key is ours by its product. A refund or a
dispute is **filed** under an organisation only by its payment: the one our `invoice_available`
email named, under the one organisation it named — the only record of a payment this deployment
keeps. The one stranger's event still raised is the one wearing our metadata, above. Two gaps
follow, both accepted:

- **(a) The invoice ledger has holes.** No row is written when no email is claimed: no mailer
  configured, or an organisation with no active owner to mail (both return before the claim),
  or the email effect lost after the payment's own commit. Its rows cascade away with an
  organisation that is hard-deleted. And they are pruned at 400 days, while a chargeback can
  arrive up to 540 days after its payment. A refund on such a payment of ours is raised
  unfiled if its customer is ours (b); a chargeback on one is always silent, because Dodo's
  dispute webhook names no customer at all. Either way Dodo's dashboard still has it. A ledger row written with the payment itself,
  independent of mail, is the follow-up.
- **(b) A customer is not proof.** Our checkouts create a customer per organisation, but the
  other products' checkouts let Dodo reuse a customer by email, so another product's refund can
  carry our customer id. A refund whose customer is ours on a payment we never invoiced (Dodo's
  dispute names no customer) is therefore never filed: it is raised with no organisation named
  and no audit row — "its customer is ours but the payment is not one we invoiced" — for a human
  to look at. An audit row in the wrong organisation is one its owners can read.

**A known limit:** an event of a type this webhook handles that fails its strict schema is
answered 400 with an error line and retried by Dodo — another product's included, instead of
the quiet 200. Dodo's objects have one shape for every product on the account, so this needs
Dodo to change a shape (which would break ours too); a permissive pre-parse that tells ours from
theirs before the strict one is the follow-up.

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
| Meter attached to every paid product | Attached to the **Pro** products only ($0.01 per unit). The **Team** products are plain subscriptions with the 14-day trial and **no meter** | Dodo's dashboard cannot put a trial and a meter on one product — switching a product to usage-based billing silently drops its trial. The trial is the promise (product description, trial emails, §3's hard-gate check), so Team keeps it. Team overage past 1M fetches is still counted, warned about at 80%/100% and reported to Dodo, but Dodo bills nothing for it — a deliberate undercharge, revisited if Dodo ever supports both. |
| `DODO_METER_SECRET_FETCH` | The meter's **event name** (e.g. `secret_fetch_kilo`) | Usage is reported by event name. `check:env` refuses an `mtr_…` id. |
| Twelve subscribed webhook events | The twelve, **plus** `subscription.updated` and `subscription.past_due` | `subscription.updated` is how a cancellation scheduled for the period end arrives; without it the row learns of it only at the end. |
| A SCIM add-on ($249) | Not sold | SCIM is an Enterprise inclusion since Scale went; nothing reads `DODO_ADDON_SCIM`. |
| Self-host products in Phase | Not read by P12 | `license_key.created` is kept only for a product this deployment sells a licence for, and there is none until P22 (`licensedProducts` in `config.ts` is empty). Every licence key that arrives today is another product's on the shared Dodo account: acknowledged, never stored. The licence page is P22. |
| Customer portal return URL `/app/settings/billing` | Set per session to `/app/{org}/settings/billing` | The portal session is created with its own return URL. Any default is fine. |

**Trials are the owner's Dodo-side choice.** Team's 14-day trial is configured on the Dodo
product, and so is whether the checkout requires a card before the trial starts. With a card,
the trial converts by charging it (the owners are emailed three days and one day before); without
one, or when the charge fails, Dodo puts the subscription on hold, the plan keeps working, and
after fourteen days on hold the hourly job moves the organisation to Free (§4). The trial
emails say exactly that, so either choice is described truthfully. An owner who moves up during
the trial (a higher plan, or monthly to yearly) is charged at once — Dodo's
`prorated_immediately` ends the trial and starts a paid period.

**How the row reads a trial** (`readTrial` in `snapshot.ts`, the one statement of it — the
status, the trial end, the period start, `metered_from`, the trial emails, the billing screen and
the reconciler all follow it). The booked end is `created_at` plus `trial_period_days`; during an
untouched trial Dodo's `next_billing_date` *is* the booked end. The trial is over only when **a
payment has moved the next charge more than a day past the booked end** — both at once:

- *A paid upgrade* moves the next charge a month or a year on and stamps `previous_billing_date`
  with its payment: the trial ended at that payment — active, metered from it, no more trial
  emails. The renewals after it keep that end (and `metered_from`) though their own payment dates
  no longer show it.
- *A declined upgrade* is not made (`prevent_change`). Dodo stamps `previous_billing_date` with
  the attempt but leaves the next charge at the booked end, so the trial runs on: trialing, the
  same end, the trial emails, nothing metered. If an owner asked for an upgrade in the hour
  before (from the billing screen, which records the request with its idempotency key), the
  "didn't go through" email says the change has not happened and the trial still ends on its
  date; any other decline — a seat charge, say — gets the ordinary dunning email. Each has its
  own once-a-day slot, so neither can swallow the other.
- *A next charge moved with no payment* — a pause and a resume, or a trial extended in Dodo — is
  the trial running to the new date: the row's trial end, the trial emails and `metered_from`
  follow it. **To extend a trial, move its next billing date in Dodo only while
  `previous_billing_date` still equals `created_at`.** Once Dodo has stamped a charge attempt (a
  declined upgrade does), a moved next charge reads as a paid period and ends the trial at once —
  do not extend that subscription in Dodo.

When Dodo stops reporting `trial_period_days`, the row's own trial end for the same subscription
stands in for the booked one — trusted only where a paid period could have begun at it (Dodo's
next charge at least 25 days on); an end Dodo's dates contradict reads as a trial running to the
next charge. The reconciler compares each row's trial end with the same rule (`trialEnd` drift).
§3 has the staging check — a hard gate before live mode.

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

**The mode and the credentials must come from the same Dodo mode** — test and live share
nothing. `check:env` (without `--offline`) reads one product from the host `DODO_ENVIRONMENT`
names with `DODO_API_KEY`: a 401 there is a key from the other mode (or revoked), a 404 a product
id from the other mode. **`DODO_WEBHOOK_SECRET` cannot be checked that way**: a signing secret
belongs to one endpoint, made in one mode, and nothing Dodo answers to an API key says which. A
live deployment holding the test endpoint's secret passes every check and then refuses every
delivery 401 — so after each deploy that changes a Dodo variable, open the endpoint in Dodo's
dashboard and confirm the next delivery was answered 200 (or send a test event from there).

Put all of them in Phase.dev for the environment, then: the two secrets with
`wrangler secret put <NAME> --env <staging|production>` (from `apps/web/`, pasting from Phase),
and the vars in `[env.<staging|production>.vars]` in `apps/web/wrangler.toml` — the commented
block under production lists them. Product ids are not credentials; committing them is the
same as committing `WORKOS_CLIENT_ID`.

### In order

1. **Staging first.** `[env.staging]` in `wrangler.toml` is a stub with no routes and no
   bindings: give it its own database (never production's), its Hyperdrive, Secrets Store
   and rate-limit bindings, and the `xecret-staging.playxoft.com` route, copied from the
   production block, and apply migrations **0024 to 0027** to that database.
2. Dodo, **test mode**: the four products (per seat, with every currency the pricing page
   shows), Team's trial and its card requirement, the meter (free threshold 0), the SAML add-on
   if you sell it, an API key, the customer portal, and the webhook endpoint
   `https://xecret-staging.playxoft.com/api/billing/webhook` with the events above.
3. Phase.dev → the variables above, test-mode values, in the Phase environment staging is
   deployed from (Development today, as WorkOS's staging values are — see `package.json`'s
   `phase:migrate-users:staging`); `DODO_ENVIRONMENT = "test_mode"` in `[env.staging.vars]`.
4. `phase run --env Development -- npm run check:env` — the billing lines validate with the
   same function the Worker uses, and `DODO key ↔ mode` asks Dodo whether the key and the
   products belong to the mode `DODO_ENVIRONMENT` names (see "The variables").
5. Deploy staging (`npm run deploy -- staging`) and run §3 against it.
6. **Production, live mode** — **not until §3's "Upgrade during a trial" check has passed**
   (a hard gate; see there). Dodo's live mode — the same products, meter, add-on, API key,
   portal, and the webhook `https://xecret.playxoft.com/api/billing/webhook`. Phase.dev
   Production gets the live values, `DODO_ENVIRONMENT = "live_mode"` in `[env.production.vars]`.
7. `npm run phase:check-env:production`.
8. **Apply migrations 0024 to 0027** to the production database before deploying (see §5).
9. `npm run phase:check-deploy` — the `billing (group)` line must say every member is in place.
10. Deploy. Confirm all three Cron Triggers (`17 * * * *`, `*/5 * * * *`, `41 3 * * *`) are listed on the Worker,
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

Round 2 adds what only Dodo itself can answer — record what it does:

- [x] **Upgrade during a trial — a HARD GATE before live payments. Do not switch
      `DODO_ENVIRONMENT` to `live_mode` (§2 step 6) until this check has passed and its answers
      are written down here.**

      **Passed 2026-11-05** on `sub_0NrIFRFuxlB34vvOYZG33` (test mode, the rehearsal organisation). The
      first run FAILED exactly as this check predicts — the declined immediate charge
      (₹15,926.46, `pay_0NrIG0…`) left Dodo on the monthly trial but flipped the row to
      active/metered — and PR #146 implemented the rule below. Re-run under the fix: the row
      stayed trialing through a second declined attempt, and the broken row healed from a fresh
      snapshot (Team · Trial, end restored to the booked Nov 19, `metered_from` back at the
      start). Dodo's `GET` confirmed the premises: `next_billing_date` = `created_at` + 14 days
      (+71 s), `previous_billing_date` stamped by the *failed* attempt, `trial_period_days`
      still 14, status `active` throughout the trial. The gateway artifact stands: the Indian
      test simulator declines every off-session charge, so the paid path is covered by
      `trial-upgrade.test.ts` and the two first-live-charge checks below.

      *What the code does* (§2, "How the row reads a trial"). A trial is over only when a payment
      has moved Dodo's **`next_billing_date` more than a day past the booked trial end**
      (`created_at` plus `trial_period_days`; `TRIAL_OVER_MARGIN_MS`, `readTrial` in
      `snapshot.ts`). A paid upgrade starts a paid period and moves the next charge a month or a
      year on; a declined one is not made and moves it not at all; a next charge moved with no
      payment is the trial running to the new date. (The first run of this check, 2026-11-05,
      failed the earlier rule, which read a `previous_billing_date` later than `created_at` as a
      payment on its own: a declined upgrade moves it to the attempt, and the row ended a trial
      nobody had paid to end — active, metered from the attempt, no more trial emails. That rule
      is gone.)

      *What staging can rehearse: the declined upgrade.* Dodo's Indian test simulator cannot
      take an off-session charge, so on staging **every** immediate charge fails, whatever the
      test card. On a fresh throwaway organisation, start Team's trial (monthly, card mandate) and
      check:
      - Before changing anything, `GET` the subscription from Dodo's API and write down
        `created_at`, `trial_period_days`, `next_billing_date` and `previous_billing_date`.
        **`next_billing_date` minus `created_at` must be `trial_period_days` days (within a
        day), and `previous_billing_date` must equal `created_at`** — the booked end the rule
        is built on, and the "nothing charged yet" it tells a payment from. If either is not so,
        stop: the rule's premise does not hold.
      - Change to Team yearly from the billing screen. The charge is declined. Dodo's dashboard:
        the subscription unchanged — the monthly product, on trial, its `next_billing_date` still
        the booked end.
      - The billing screen: still **Team · Trial**, monthly, "Trial ends" the same date as before.
        The audit log has `billing.payment_failed`, and no `plan.changed` after the activation's.
      - The owners' email: "A payment for … didn't go through", saying the change has not
        happened and the trial still ends on that date — nothing about a hold or retries.
      - `SELECT status, trial_ends_at, metered_from, current_period_start, dodo_scheduled_change_at
        FROM org_subscriptions WHERE org_id = '…'`: `trialing`, the booked end, the booked end,
        the subscription's `created_at` (not the attempt), `NULL`. No `billing_seat_syncs` row.
      - `GET` the subscription again and write down what moved — `previous_billing_date`
        (expected: the attempt) and `trial_period_days` (the code copes either way: a zeroed
        length falls back to the row's own trial end).
      - The trial emails, the meter and the nightly reconcile **cannot be watched on staging**:
        it has no Cron Triggers, and production's Worker, which runs the scheduled jobs against
        the shared database, takes no payments yet — its billing jobs do nothing — and once it
        does, leaves test-mode rows alone. All three read only the row checked above (`status`,
        `trial_ends_at`, `metered_from`), and `trial-upgrade.test.ts` runs them over this very
        sequence: the three-day email arrives, nothing is metered, and the reconcile reports no
        drift.

      *The first run's row.* The organisation the 2026-11-05 run used still holds what the
      earlier rule wrote (active, its trial ended at the declined attempt). This build reads it
      back as a running trial — but only from a fresh snapshot of its subscription, and only
      while no paid period has begun (once one has, an earlier recorded end is kept as the
      trial's history; on staging none ever begins, every charge being declined). On staging a
      row's trial changes only when Dodo sends a `subscription.*` event, and the one this system
      can cause is a quantity change: add a member to that organisation (the seat push sends Dodo
      a change-plan — on staging it is also the seat check below), then confirm in Dodo's
      endpoint log that a `subscription.*` delivery followed, answered 200. Otherwise leave it:
      it is a test-mode row, and the rehearsal is the fresh organisation's.

      *What staging cannot rehearse: the paid upgrade.* The test gateway never completes the
      charge. That path is proven by the tests — `snapshot.test.ts` ("a trial, read from the date
      Dodo charges next") and `trial-upgrade.test.ts`, which replays the whole sequence through
      the checkout and change routes, the signed webhook, the hourly job and the reconciler, for
      both outcomes and for an untouched trial converting at its end — and by the rule's
      construction: a paid period moves the next charge by a whole month or year and stamps its
      payment, a declined one moves the charge by nothing, and the margin is a day. Two live-mode
      checks remain, because staging's gateway takes no off-session charge and so can never show a
      *successful* one: the first real **upgrade during a trial** (the screen shows **active** and
      yearly, no trial emails follow, the next reconcile reports no drift) and the first real
      **natural conversion at a trial's end** (the row turns active at the conversion, is metered
      from the booked end, and no trial emails re-anchor to a later date — the reading of a paid
      period rests on Dodo stamping `previous_billing_date` for it, which only a live charge
      proves).

      Write down the date of the run, the subscription id, and what Dodo's API showed.
- [ ] **A seat added during a trial.** On another fresh organisation on Team's trial — no plan
      change asked for — invite and accept a member. The seat push charges the difference
      (`prorated_immediately_keep_cycle`, `apply_change`) and the test gateway declines every
      off-session charge, so this shows exactly what Dodo does with a mid-trial seat charge.
      Write down: whether Dodo attempts a charge at all (a `payment.failed` delivery), whether
      the quantity changed anyway, whether the subscription went on hold, and what
      `next_billing_date` and `previous_billing_date` became. What the code does with each: a
      `payment.failed` with no upgrade asked for in the hour before gets the ordinary dunning
      email ("will try again… 14 days on hold"), never the "trial goes on" one; a hold shows on
      the billing screen; and a next charge that moved with a payment stamped would end the
      trial — if Dodo does that for a seat, write it down and raise it before live mode.
- [ ] **Yearly usage.** On Pro yearly, the billing screen's usage card says "this month" and
      starts on the billing date's day of this month, not on the year's start.
- [ ] **A withdrawn downgrade.** Schedule Team → Pro for the period end, cancel the scheduled
      change in the customer portal, then invite a member: the quantity goes up within minutes
      (the push asks Dodo, finds no scheduled change and clears `dodo_scheduled_change_at`)
      instead of waiting for the old date.
- [ ] **A push with nothing to change.** With `billing_seat_syncs` holding a debt for an
      organisation whose quantity Dodo already bills (insert one by hand), run the hourly job:
      note the status Dodo answers a change-plan to the same product and quantity with. The code
      treats a 400/422 there as paid when Dodo's subscription shows that quantity — the debt is
      cleared, not retried.

### Cleaning up test rows

Staging's database is staging's; nothing needs cleaning there. If a test-mode subscription
ever reached a database that will take live payments (the earlier version of this runbook ran
the test on production), clear it **before** switching that deployment to `live_mode`. Every
such row was written by test-mode webhooks, so it records `dodo_mode = 'test_mode'` — or, from
before migration 0025, no mode at all beside a `sub_…` or `cus_…` id the live API does not know.
A deployment that has never taken live payments has no live ids, so on it every row with a
provider id and no mode is a test row — but check each in the Dodo test dashboard first; the
`SELECT` below lists both kinds:

```sql
BEGIN;
-- What will change: review before running the rest.
SELECT o.slug, s.plan, s.status, s.dodo_subscription_id, s.dodo_mode
  FROM org_subscriptions s JOIN organizations o ON o.id = s.org_id
 WHERE s.dodo_mode = 'test_mode'
    OR (s.dodo_mode IS NULL
        AND (s.dodo_subscription_id IS NOT NULL OR s.dodo_customer_id IS NOT NULL));

-- Every test row returns to Free's default seats — the same rows the next
-- statement resets. A paid one whatever its ceiling; a Free one only from the 5
-- an ended subscription left it at, so a ceiling support raised is kept, as
-- migration 0033 keeps it.
UPDATE organizations SET seat_limit = 3, updated_at = now()
 WHERE id IN (SELECT org_id FROM org_subscriptions
               WHERE (dodo_mode = 'test_mode'
                      OR (dodo_mode IS NULL
                          AND (dodo_subscription_id IS NOT NULL OR dodo_customer_id IS NOT NULL)))
                 AND plan <> 'free')
    OR (seat_limit = 5
        AND id IN (SELECT org_id FROM org_subscriptions
                    WHERE (dodo_mode = 'test_mode'
                           OR (dodo_mode IS NULL
                               AND (dodo_subscription_id IS NOT NULL OR dodo_customer_id IS NOT NULL)))
                      AND plan = 'free'));
UPDATE org_subscriptions
   SET plan = 'free', billing_interval = NULL, status = 'active', seats = 1,
       dodo_subscription_id = NULL, dodo_customer_id = NULL, dodo_product_id = NULL,
       dodo_event_at = NULL, dodo_event_id = NULL, dodo_mode = NULL,
       dodo_scheduled_change_at = NULL, dodo_currency = NULL, dodo_billing_country = NULL,
       current_period_start = NULL, current_period_end = NULL, trial_ends_at = NULL,
       cancel_at_period_end = false, renewal_amount_minor = NULL, metered_from = NULL,
       on_hold_since = NULL, limit_overrides = NULL, currency = NULL, billing_country = NULL,
       region_locked_until = NULL, updated_at = now()
 WHERE dodo_mode = 'test_mode'
    OR (dodo_mode IS NULL AND (dodo_subscription_id IS NOT NULL OR dodo_customer_id IS NOT NULL));
DELETE FROM billing_seat_syncs
 WHERE org_id NOT IN (SELECT org_id FROM org_subscriptions WHERE dodo_subscription_id IS NOT NULL);
COMMIT;
```

`billing_checkouts`, `billing_webhook_events` and the audit log keep their test rows — they
are records of what happened, and nothing reads a spent test checkout again.

---

## 4. Operating it

### What to alert on

Every line below is logged at `error` and is meant to page somebody or open a ticket. The ones
the hourly job or the reconciler would otherwise repeat every run for as long as the cause
lasts are raised **once** per occasion (the `billing_reminders` ledger, migration 0027) — so a
stuck cause pages once, and a new subscription or product with the same cause pages again:

| Message starts | Meaning | Do |
|---|---|---|
| "A subscription disagrees with Dodo" | The reconciler found drift (`billing.drift_detected` names the fields — `seats` includes the membership no longer matching Dodo's quantity; `trialEnd` is a row whose trial end is not the one Dodo's dates give by §2's rule) | Find out *why* before changing either side. Do not "fix" it with `plan:set`. |
| "A second live Dodo subscription arrived" / "A checkout payment arrived for an organisation still waiting for the subscription another checkout's payment linked" | Two checkouts completed — the second perhaps before the first activated; the first one linked stands | Refund and cancel the newer one in Dodo. |
| "A Dodo subscription event arrived for an organisation whose plan an operator set" / "A checkout payment arrived for an organisation whose plan an operator set by hand" | Somebody bought over a hand-made grant — or an old subscription's event reached a grant written over its id before `plan:set` detached such rows | If the subscription is live, refund it, or move the organisation onto it deliberately. If it was a late event of the old subscription, nothing to do; take the row off the id with `plan:set --over-dodo` and the grant's own flags. |
| "A paid organisation follows a Dodo subscription id with no product recorded" | That same grant over an old subscription's id, found by the reconciler — once per subscription id. The hourly job leaves it alone (it is never ended, held or asked about) and the reconciler does not compare it | Check in Dodo that the subscription is not live, then take the row off the id with `plan:set --over-dodo` and the grant's own flags. |
| "…came from one of our own checkouts, unspent but more than a week old" | A checkout paid after its week; Dodo is retrying (503) | See "Stranded checkouts". |
| "A checkout was paid but its subscription ended at Dodo before it ever activated" | The hourly job found a linked checkout's subscription ended — expired, failed, or cancelled with its period over (the snapshot rules' own "ended") | Check the payment in Dodo and refund it if it was not already. The organisation is on Free and may check out again. |
| "A checkout was paid a day ago but Dodo still has its subscription pending" / "…but Dodo does not know its subscription" | A linked checkout's subscription, a day after its payment, that Dodo has not activated, or answers 404 for; raised once. The row keeps waiting (no new checkout) and is asked about every hour | Look the subscription up in Dodo. Pending: find out why from Dodo, or refund. Unknown: a mistyped id from a by-hand attach, or one from the other Dodo mode — correct the row (see "Stranded checkouts") or refund the payment. |
| "A signed … names one of our organisations in its metadata but carries no nonce" / "…did not come from an open checkout of its own" | A purchase outside our checkout — a payment link with our metadata typed in, or a replayed nonce | Refund or cancel it in Dodo. Nothing was attached. |
| "…recorded in the other Dodo mode" | A test-mode row on a live deployment, or the reverse | Clear the old mode's rows (§3) before taking payments. |
| "An organisation's Dodo customer is held by another organisation too" | A shared customer from before checkouts forced one per organisation; the portal was refused | Give each organisation its own customer in Dodo and update the rows. |
| "A subscription was on hold for N days and has been ended here" | Fourteen days unpaid: the organisation is on Free | Cancel the subscription in Dodo, or leave it if the customer is about to pay (its next `active` event gives the plan back). |
| "A Dodo subscription is on a product this deployment does not sell" | A `DODO_PRODUCT_*` is wrong, or a product was added in Dodo. From a webhook, per delivery; from the hourly job (a stale trial, a stranded checkout), once per subscription and product | Fix the variable; nothing was granted. The hourly job keeps asking, and applies the subscription on its first run after the fix. |
| "Dodo reports a billing country … region-locked" / "billing country is not the country that issued its card" | The PPP guardrail (pricing-plan §4); raised once, when Dodo's report changes | Review the customer in Dodo. Nothing was changed automatically, deliberately. |
| "Dodo refunded a payment" / "A cardholder opened a dispute" | Money moved back, or a chargeback, on a payment we invoiced — filed under its organisation. "…its customer is ours but the payment is not one we invoiced" is filed nowhere: ours with a gap in the invoice ledger, or another product's wearing a customer Dodo reused (§1, gaps (a) and (b)). Another product's refunds and chargebacks otherwise raise nothing | Respond in Dodo. Access is deliberately unchanged. For the unfiled one, find the payment in Dodo first: if it is another product's, there is nothing to do here. |
| "A seat change has failed to reach Dodo N times and is no longer retried" | Ten failures: the debt is dead-lettered, raised once | Check the subscription in Dodo; retry by hand (below) once fixed. |
| "A subscription ended for an organisation that still holds the SAML add-on" | The add-on is never removed automatically | Decide; if removing, `plan:set --addon saml --off` and delete its WorkOS connection. |
| "This deployment is missing the DODO_… binding" | Billing is half-configured (a malformed `whsec_` secret counts) | Set the missing variables (check:deploy names them). |

Event types the webhook does not act on — our own `dispute.won`, `dispute.lost`,
`refund.failed` and `payment.processing` among them — are claimed and logged at `debug` only,
like every other product's events (§1). Dodo's dashboard is the record of those outcomes.

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

Before a push waits for a scheduled plan change, Dodo is asked whether it is still scheduled:
an owner can withdraw a scheduled downgrade in the portal, and no event need say so. One gone at
Dodo is cleared from the row and the push made; a 409 for one the row never heard of waits for
the date Dodo gives. A push Dodo refuses (400/422) while its subscription already shows that
product and quantity is a paid debt — the row takes Dodo's count and nothing is retried.
An activation writes its seat debt inside its own transaction, as a membership change does.

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

**An organisation still on Free whose checkout was paid counts as billed through Dodo too**
(`billedByDodo`): its subscription is linked (`dodo_subscription_id` set, `dodo_event_at` still
null — see "Stranded checkouts") and live at Dodo, and its activation would land over the
change. The same four flags are refused without `--over-dodo`; with it, the run says it took
the organisation off a paid subscription that had not activated yet — cancel or refund it in
Dodo. `--show` reports it as a paid checkout waiting to activate.

**Any row that still carries a provider id is taken off it whenever one of those four flags is
set, whatever its plan** (`operatorBillingEdit`) — without `--over-dodo` for a row on Free that
ended its subscription. A row that returned to Free keeps the id of the subscription it ended
on, so that Dodo's later events still find it; a grant written over that id would have been
ended by a late `cancelled` of the old subscription, or replaced by it coming back. The run says
which subscription it took the row off. As a second lock, nothing automatic touches a paid row
that follows a subscription with no product recorded (no snapshot leaves one behind;
`operatorManaged`): a webhook raises it as operator-managed instead of applying anything, the
hourly job's sweeps leave it out — it is never ended, held or asked about — and the reconciler
reports it once instead of comparing it.

`--limit-override includedFetchesPerMonth=…` (and `--plan`) also raise the allowance recorded
for the organisation's **current usage month** at once, so a raise counts for the month it is
granted in; a month keeps its raise after the override is cleared (see "Usage").

`--until <ISO date>` gives a grant an end (`--until never` takes it away); `--plan free` clears
it. See the next section.

### Complimentary plans and promo codes (the admin page)

Since migration 0035, xecret's own staff can do the commonest of the above from a page:
**`/app/admin`**, reached from the account menu's **Admin** item. Who may open it is
`XECRET_ADMIN_EMAILS` — a Worker secret, from Phase.dev, holding a JSON array
(`["a@example.com"]`) or a comma-separated list of sign-in addresses. The address must be the
one the admin signs in with, and verified; the session must be a browser session with its vault
unlocked; any other signed-in caller gets a 404. Changing the list takes effect on the
next request — `wrangler secret put XECRET_ADMIN_EMAILS --env production` from a Phase shell, as
for every other secret (see `apps/web/wrangler.toml`).

**A complimentary plan** (Organisations tab) is the operator's grant `plan:set` has always
written — a paid plan with no Dodo subscription behind it — with an optional end date and an
optional seat ceiling, through the same rules (`applyPlanGrant` → `operatorBillingEdit`): an
organisation Dodo bills is refused unless the admin ticks "take it off its Dodo subscription",
and then the subscription it was taken off is shown — **cancel it in Dodo**, or it keeps
billing. The admin's reason goes into the organisation's own audit log as `plan.changed`, by
"xecret support" (which admin it was is on the server's log line, by user id — an admin's
address is not shown to customers). The customer's billing screen says
"Complimentary Team plan until …".

**When a grant ends** the hourly job (`runHourlyBillingJob`, first step — it runs even on a
deployment that takes no payments) returns the organisation to Free: one billed seat, Free's seat
ceiling, nobody already seated removed, nothing deleted; add-ons and limit overrides kept. Owners
are emailed a week and a day before (`grant_ending_7d`, `grant_ending_1d`) and when it ends
(`grant_ended`). **While a grant lasts, checkout is refused** (the plan is support-managed): an
owner who wants to keep the plan subscribes once it has ended, or asks for an extension — which
is the same form again, with a later date.

**Promo codes** (Promo codes tab) are of two kinds:

| Kind | What the owner does | What happens | Card |
| --- | --- | --- | --- |
| Free plan (`grant`) | Enters it under "Have a code?" on the billing or plans page | The organisation gets the code's plan for its days (or for good), as a grant — nothing at Dodo | None, ever |
| Discount (`discount`) | Enters it, then checks out | Checkout pre-applies a Dodo discount code — a percentage (up to 100%) or a fixed amount off Pro and/or Team, for N billing periods or every one | Collected by Dodo |

So "free, no card" is a free-plan code; "free, card on file" is a 100% discount for N periods
(the card is charged when the discount runs out); anything else is a discount. Every code can be
limited to a list of addresses, a number of uses and an expiry date. A free-plan code is spent
once per organisation and once per person; a discount's uses are counted by Dodo against the
limit it was created with. A free-plan code is refused on an organisation that was subscribed
before (it still carries the Dodo subscription it ended on, which a late payment must still find)
and while a checkout started in the last day is open — grant those from the Organisations tab.

A discount code is created at Dodo by the page — **restricted to this deployment's own Pro/Team
products**, because the Dodo account is shared with other products — and **Dodo's own code box
is hidden on every checkout** (`allow_discount_code: false`): a code reaches a checkout only by
the server sending it, after checking it is ours, live, for that plan and for that person.
A code made in test mode means nothing to live mode, and the page says which mode each was made
in. Revoking a code stops it at once here and deletes it at Dodo; a subscription that already
has the discount keeps it for the periods it was given, and grants already made keep their dates.

**Do not create discount codes in the Dodo dashboard** for xecret: with the code box hidden,
nothing can apply them, and a code Dodo has but this server does not is a code nobody can audit.

**Before relying on these in live mode, check on staging (test mode)**: a percentage code, a flat
code in USD, and a 100% code — each through a real test checkout — to confirm Dodo charges what
the code says, that the 100% code still asks for a card, and that the subscription activates the
plan through the webhook as any other checkout does. Flat codes in particular: Dodo states the
amount through `currency_options`, which has not been exercised against Dodo yet.

### Usage

Fetches are counted in each Worker isolate, per second, and written within fifteen seconds of
the first one waiting — a timer in that fetch's own `waitUntil` — or as soon as fifty are
waiting, never on the response. Each second's count lands in the billing period that covered
it, not the one current when the write lands. An isolate evicted before its timer fires loses
those seconds of counts, and a failed write is dropped rather than retried: the meter can only
ever under-count.

**A counter row is a month.** A monthly plan's billing period, Free's calendar month, or — on a
yearly plan — a month of its year counted from the billing anniversary (a year that began on 10
March counts 10 March – 10 April, and so on; the 31st becomes the month's last day where there
is none). The allowance is monthly, so a year of fetches is never measured against one month's
allowance.

**Each month records its own allowance** (`included_fetches`, migration 0026): the plan's
`includedFetchesPerMonth` with any support raise, written when the month's first fetch is
counted, raised — never lowered — by a later flush while the month is current, and by
`plan:set`. The meter bills a month past that figure and nothing else: a downgrade at renewal
never re-bills the last month of the old plan at the new plan's allowance, and clearing an
override never re-bills the months it covered. A month with no figure is never billed.

Only periods the subscription paid for are metered: `metered_from` is its activation, or its
trial's end when it had one — the booked end, the new end of a trial extended in Dodo, or the
payment of an upgrade that ended it early (§2; a declined upgrade ends nothing, and moves
nothing), kept through the renewals after it — and a counter row whose period began earlier —
usage on Free, or during a trial — is never billed. While the trial is Dodo's current cycle the
row's period is the trial, from the subscription's creation, so the usage month does not restart
at a declined attempt. Each thousand fetches past the allowance is reported hourly
as one Dodo event with the id `{orgId}:{periodStart}:{unitIndex}`; Dodo treats an event id as an
idempotency key, so a retried run cannot bill twice. Dodo refuses an event stamped more than an
hour ago, so units still owed for a period that has just ended are reported — once — into the
next one. `org_usage_counters` is the dispute record.

### Stranded checkouts

A customer can pay and still be on Free in two ways, and both are caught:

- **The activation never came.** A checkout's first payment links its subscription to the row
  (`dodo_subscription_id` set, `dodo_event_at` still null), and the row refuses another
  checkout — and `plan:set` without `--over-dodo` — while it waits. Half an hour on, the hourly
  job asks Dodo what the subscription is and applies it as a webhook would — the plan, if it is
  live. One that ended first — expired, failed, or cancelled with its period over, by the same
  rule a webhook's snapshot is read with — stops the wait (the owner may check out again) and
  is raised. One Dodo still has pending, or does not know (404), a day after the link is raised
  once and keeps waiting; the job asks about it every hour, so correcting the row, or Dodo
  activating it, ends the wait within the hour. Only rows of the deployment's own Dodo mode (or
  none recorded) are asked about, and all of them are, page by page — the oldest waits never
  crowd out a new one.
- **The checkout was over a week old.** A subscription or payment carrying the nonce of the
  organisation's own checkout, unspent but past its week, is answered 503 with an error line —
  never claimed as a stranger's — so Dodo retries for a day. A payment that names its checkout
  session still links it. If neither happens, attach it by hand — the hourly job then applies
  it within the hour:

```sql
-- The subscription and customer ids from the Dodo dashboard; the mode this deployment runs in.
UPDATE org_subscriptions
   SET dodo_subscription_id = 'sub_…', dodo_customer_id = 'cus_…', dodo_mode = 'live_mode',
       dodo_event_at = NULL, dodo_event_id = NULL, updated_at = now() - interval '1 hour'
 WHERE org_id = '…' AND plan = 'free';
```

### A change that "may have gone through"

A checkout or plan change Dodo did not answer — a timeout, a broken connection, a gateway
timeout — is answered 503 saying it may have gone through, never "nothing was charged". Its
idempotency key stays claimed for a day, so the owner's retry with the same choice is answered
"already being handled" and does not reach Dodo again. If the owner asks: look the subscription
up in Dodo — a change that landed arrives as its webhook, and the billing screen shows it.

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

Migration **0026** (`0026_usage_month_allowance.sql`): `org_usage_counters.included_fetches`,
the allowance each usage month opened with, and its backfill from each organisation's current
plan — the figure the meter used for those months until this build.

Migration **0027** (`0027_billing_alerts_once.sql`): `billing_reminders` accepts three alert
kinds — `alert_unknown_product`, `alert_activation_waiting`, `alert_operator_managed` — so the
alerts the hourly job and the reconciler would repeat are raised once per occasion. Constraint
only. A build before it never writes them; against a database without it, this build's first
such alert fails its insert — the hourly job logs it as a warning or a failed step and carries
on, and that night's reconcile stops there.

All four are additive; apply them **before** the build that reads them, because every whole-row
query of these tables from that build names the new columns — the billing routes, the webhook,
the jobs, the membership changes, and the check behind deleting an organisation or an account:

```sh
phase run --env Production -- npm run db:migrate
```

Migration **0033** (`0033_free_seat_limit.sql`): the Free plan seats three.
`organizations.seat_limit` defaults to 3 instead of 5, and one backfill moves each live Free
organisation from 5 to 3 — only one that carries nothing of a Dodo subscription (no
subscription, customer, product, mode or applied event), has no support override, and whose
seated members plus open invitations fit in three. Every live Free organisation left above 3
— a 5 it declined to move, or any other ceiling somebody set, which it leaves as set — is
reported as a `WARNING` naming it and the reason, which `npm run db:migrate` prints; once its
members are sorted out, an operator can move one by hand with
`UPDATE organizations SET seat_limit = 3, updated_at = now() WHERE id = '<id>';`. Nobody is
removed and no invitation is withdrawn. Its order against the build does not matter: that build
writes 3 wherever it returns an organisation to Free, and the 5 an older build writes when a
subscription ends lands on a row carrying Dodo ids, which the backfill leaves alone. It sets
`lock_timeout` to five seconds for itself: the `ALTER` needs `organizations` exclusively, and
queued behind a long transaction it would hold every request that reads the table behind it.
Past five seconds it fails and rolls back whole; run it again.

Migration **0035** (`0035_plan_grants_and_promo_codes.sql`): complimentary plans and promo
codes. `org_subscriptions.grant_ends_at` and `grant_note` (a CHECK keeps an end date off Free and
off any row Dodo bills), `billing_checkouts.promo_code_id`, the tables `promo_codes` (the
application may insert, and update only `redemptions`, `revoked_at` and `revoked_by`; never
delete) and `promo_code_redemptions` (insert-only), and three reminder kinds (`grant_ending_7d`,
`grant_ending_1d`, `grant_ended`). Additive; apply it **before** the build that reads it — every
whole-row read of `org_subscriptions` from that build names the new columns.

---

## 6. What this does not do

- **Enterprise** is a contract and a manual Dodo invoice; it is set with `plan:set`, never
  through checkout.
- **SCIM** is an Enterprise inclusion and is not sold.
- **Plan ceilings no longer wait for notice.** The owner's decision (2026-11) overrode the
  thirty days pricing-plan §5 had promised — there were no customers yet whom an immediate
  limit could surprise — so every countable ceiling is enforced at creation from the day it is
  published: projects, environments per project, secrets per environment, service tokens, CLI
  devices per person and webhooks, beside the organisation and seat ceilings that already
  were (`docs/architecture/api.md` §3 lists where). Only creation is refused; nothing already
  held past a ceiling is deleted or refused a read. The terms say exactly what a lower plan does
  stop: webhook endpoints are paused on a plan that allows none; new-address read alerts stop
  (nothing recorded, nothing sent) on a plan without them; and any other feature the plan lacks
  keeps working as set but cannot be changed.
- **No card or invoice UI.** Dodo's customer portal is it.
- **A subscription ended here after fourteen days on hold is not cancelled at Dodo.** The alert
  says so; a human decides.

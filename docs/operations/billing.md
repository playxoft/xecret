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
                                                                                       │
                                     (the return from checkout grants nothing)         │ pays
                                                                                       ▼
 org_subscriptions ◄── POST /api/billing/webhook ◄──── signed Standard Webhooks ◄──── Dodo
        │                (verify → claim → apply the snapshot, in one transaction)
        │
        ├─► entitlements (resolveOrg reads the row it already loads — no extra query)
        ├─► seat sync: membership changes ──► Dodo change-plan (after the commit)
        ├─► usage: fetches counted in the isolate ──► org_usage_counters ──► Dodo meter (hourly)
        └─► nightly reconciler: our rows vs Dodo — reports drift, corrects nothing
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
| Usage metering | `billing/usage.ts` | counted per fetch; reported hourly |
| Reminder emails | `billing/reminders.ts`, `mail.ts` | from webhooks and the hourly job |
| Hourly job | `billing/jobs.ts` | Cron `17 * * * *`, after the vault purge |
| Reconciler | `billing/reconcile.ts` | Cron `41 3 * * *` |
| Operator tool | `scripts/plan-set.ts` | by hand — trials, overrides, Enterprise |

---

## 2. Setting it up — test mode first

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

### The variables

All or nothing: with **none** set, payments are off and nothing else changes; with **some**,
every billing route and the webhook answer 503 naming what is missing.

| Name | Home | What |
|---|---|---|
| `DODO_API_KEY` | **secret** — `wrangler secret put` | Developer → API Keys, write permission |
| `DODO_WEBHOOK_SECRET` | **secret** — `wrangler secret put` | the endpoint's signing secret, `whsec_…` |
| `DODO_ENVIRONMENT` | var — `wrangler.toml` | `test_mode` or `live_mode` |
| `DODO_PRODUCT_PRO_MONTHLY` | var | `pdt_…` |
| `DODO_PRODUCT_PRO_YEARLY` | var | `pdt_…` |
| `DODO_PRODUCT_TEAM_MONTHLY` | var | `pdt_…` |
| `DODO_PRODUCT_TEAM_YEARLY` | var | `pdt_…` |
| `DODO_METER_SECRET_FETCH` | var | the meter's event name |
| `DODO_ADDON_SAML` | var, optional | the SAML add-on id |

Put all of them in Phase.dev for the environment, then: the two secrets with
`wrangler secret put <NAME> --env production` (from `apps/web/`, pasting from Phase), and the
vars in `[env.production.vars]` in `apps/web/wrangler.toml` — the commented block there lists
them. Product ids are not credentials; committing them is the same as committing
`WORKOS_CLIENT_ID`.

### In order

1. Dodo, **test mode**: the four products (per seat, with every currency the pricing page
   shows), Team's 14-day trial, the meter (free threshold 0), the SAML add-on if you sell it,
   an API key, the customer portal, and the webhook endpoint
   `https://xecret.playxoft.com/api/billing/webhook` with the events above.
2. Phase.dev → the variables above, test-mode values.
3. `npm run phase:check-env:production` — the billing lines validate with the same function the
   Worker uses.
4. **Apply migration 0024** to the database before deploying (see §5).
5. `npm run phase:check-deploy` — the `billing (group)` line must say every member is in place.
6. Deploy. Then confirm both Cron Triggers (`17 * * * *`, `41 3 * * *`) are listed on the
   Worker, and that `/api/internal/scheduled/billing-hourly` and `…/billing-daily` answer 404
   from outside.
7. The test run (§3).
8. Going live: repeat 1–5 with live-mode values and `DODO_ENVIRONMENT = "live_mode"`, then one
   real purchase in each currency, refunded.

---

## 3. The test run

In test mode, with a Dodo test card, on a throwaway organisation:

- [ ] Billing screen → choose Team yearly → checkout. Back on the billing screen it says it is
      waiting for the payment, then shows Team within a minute. Dodo's endpoint page shows the
      deliveries answered 200.
- [ ] The audit log shows `billing.checkout_started` and then `plan.changed` (actor
      `Dodo webhook`, no operator).
- [ ] Invite and accept a member: Dodo's subscription quantity goes up by one, and the owners
      get the "now billed for N seats" email. Remove them: it goes down.
- [ ] Suspend a member: the quantity does **not** change.
- [ ] Change plan (Team → Pro, yearly → monthly): the preview says "at renewal", nothing is
      charged today.
- [ ] Fail a payment with Dodo's decline card: status `on_hold`, the red banner says builds are
      unaffected, the owners are emailed once — and `xecret run` against the organisation
      still works.
- [ ] Cancel from Manage billing: the screen says the plan ends at the period end; access is
      unchanged until then.
- [ ] Replay a delivery from Dodo's dashboard: answered 200, nothing changes, one
      `billing_webhook_events` row.

---

## 4. Operating it

### What to alert on

Every line below is logged at `error` and is meant to page somebody or open a ticket:

| Message starts | Meaning | Do |
|---|---|---|
| "A subscription disagrees with Dodo" | The reconciler found drift (`billing.drift_detected` names the fields) | Find out *why* before changing either side. Do not "fix" it with `plan:set`. |
| "A second live Dodo subscription arrived" | Two checkouts completed; the customer is paying twice | Refund and cancel the newer one in Dodo. |
| "A live Dodo subscription arrived for an organisation whose plan an operator set" | Somebody bought over a hand-made grant | Refund it, or move the organisation onto it deliberately. |
| "A Dodo subscription is on a product this deployment does not sell" | A `DODO_PRODUCT_*` is wrong, or a product was added in Dodo | Fix the variable; nothing was granted. |
| "Dodo reports a billing country … region-locked" / "billing country is not the country that issued its card" | The PPP guardrail (pricing-plan §4) | Review the customer in Dodo. Nothing was changed automatically, deliberately. |
| "Dodo refunded a payment" / "A cardholder opened a dispute" | Money moved back, or a chargeback | Respond in Dodo. Access is deliberately unchanged. |
| "A seat change has failed to reach Dodo six times" | The organisation is billed for a seat count its membership no longer has | Check the subscription in Dodo; the hourly job keeps retrying. |
| "A subscription ended for an organisation that still holds the SAML add-on" | The add-on is never removed automatically | Decide; if removing, `plan:set --addon saml --off` and delete its WorkOS connection. |
| "This deployment is missing the DODO_… binding" | Billing is half-configured | Set the missing variables (check:deploy names them). |

### Seat-sync debts

`billing_seat_syncs` lists organisations whose seat count is still owed to Dodo. The hourly job
retries each with backoff, always pushing the count as it is *then*. To see them:

```sql
SELECT org_id, attempts, last_error, last_attempt_at FROM billing_seat_syncs ORDER BY queued_at;
```

### Changing an organisation by hand

`npm run plan:set` still works and is how support grants a trial extension, a fair-use raise or
an Enterprise contract. On an organisation billed through Dodo it refuses `--plan`,
`--interval`, `--seats` and `--status` — Dodo owns those and its next webhook would overwrite
them — unless `--over-dodo` is passed. Add-ons and `--limit-override` are always allowed.

### Usage

Fetches are counted in each Worker isolate and written every 15 seconds or 50 fetches, from
`waitUntil`, never on the response. An isolate evicted between writes loses its last few
seconds of counts: the meter can only ever under-count. Each thousand fetches past the
allowance is reported hourly as one Dodo event with the id `{orgId}:{periodStart}:{unitIndex}`;
Dodo ignores a repeated id, so a retried run cannot bill twice. `org_usage_counters` is the
dispute record.

### Deleting an organisation

An organisation Dodo still bills cannot be deleted — directly, or with the account of its last
member — until its subscription is cancelled (Billing → Manage billing). A deleted organisation
would otherwise renew for ever with nobody able to open it.

---

## 5. Database

Migration **0024** (`0024_dodo_billing.sql`): four nullable columns on `org_subscriptions`
(`current_period_start`, `dodo_product_id`, `dodo_event_at`, `renewal_amount_minor`) and four
tables — `billing_checkouts` and `billing_license_keys` (insert-only by grant),
`billing_seat_syncs`, `billing_reminders`. Additive; apply it **before** the build that reads
it, because every whole-row query of `org_subscriptions` from that build names the new columns —
the billing routes, the webhook, the jobs, and the check behind deleting an organisation or an
account:

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

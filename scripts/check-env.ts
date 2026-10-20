#!/usr/bin/env -S npx tsx
/**
 * Validates the deployment's configuration before anything depends on it.
 *
 *   phase run --env Development -- npm run check:env     # local / staging values
 *   phase run --env Production -- npm run check:env      # production's
 *   … -- npm run check:env -- --offline                  # skip the one network call
 *
 * Run it under the environment you are about to deploy: it checks whatever
 * values are in the shell, and `phase run` alone means `.phase.json`'s default,
 * which is Development.
 *
 * Every check here corresponds to a misconfiguration that is silent until it is
 * expensive. A root key of the wrong length surfaces as a decryption failure on
 * a customer's request; a WorkOS cookie password a few characters short sends
 * every sign-in to the sign-in page's "unavailable" error, which the user
 * cannot act on and the operator has to trace back to a binding. Both are a
 * line or two to catch here.
 *
 * It reads values but never prints them. Where a value must be shown to be
 * useful — a client id, a key version — it is one that is already public.
 *
 * Two checks make a network call: asking WorkOS whether the API key and the
 * client id belong together (see `checkWorkosPairing`), and asking Dodo
 * whether its key and products belong to the mode `DODO_ENVIRONMENT` names
 * (`checkDodoPairing`). `--offline` skips both.
 */

import { parseRootKeyMaterial } from '../packages/core/src/crypto/key-provider.ts';
import { MIN_STATE_SECRET_LENGTH } from '../packages/core/src/auth/oauth-state.ts';
import {
  BillingMisconfiguredError,
  billingSetup,
  isWebhookSecret,
} from '../apps/web/src/server/billing/config.ts';

interface Result {
  name: string;
  ok: boolean;
  detail: string;
}

const results: Result[] = [];

function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
}

function required(name: string): string | null {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    check(name, false, 'not set');
    return null;
  }
  return value;
}

function checkRootKeys(): void {
  const raw = required('XECRET_ROOT_KEYS');
  if (raw === null) return;

  const versionRaw = process.env['XECRET_ROOT_KEY_VERSION'] ?? '1';
  const version = Number(versionRaw);

  if (!Number.isInteger(version) || version < 1) {
    check('XECRET_ROOT_KEY_VERSION', false, `"${versionRaw}" is not a positive integer`);
    return;
  }

  try {
    // The same parser the Worker uses, so a value that passes here cannot fail
    // there for a reason this script did not consider.
    const material = parseRootKeyMaterial(raw, version);
    const versions = [...material.keys.keys()].sort((a, b) => a - b);

    check(
      'XECRET_ROOT_KEYS',
      true,
      `${material.keys.size} key(s), version(s) ${versions.join(', ')}, current ${material.currentVersion}`,
    );
    check('XECRET_ROOT_KEY_VERSION', true, `${version} — present in the key map`);
  } catch (error) {
    // InvalidRootKeyMaterialError messages are structural ("wrong length",
    // "not valid base64url") and never echo key material, so this is safe.
    check('XECRET_ROOT_KEYS', false, error instanceof Error ? error.message : 'unknown error');
  }
}

/**
 * The identity provider, WorkOS (docs/adr/0010-workos-as-identity-provider.md).
 *
 * All three values are required: without any one of them nobody can sign in,
 * and the sign-in routes send the browser to the sign-in page's "unavailable"
 * error rather than guess. Shape is checked here because each one fails
 * *later* otherwise — a malformed client id as a redirect AuthKit refuses, a
 * short cookie password on the first sign-in, a key that is not a key as an
 * outage that reads like WorkOS's.
 *
 * Which WorkOS environment the key belongs to is not read from the key: WorkOS
 * has issued `sk_test_…`, `sk_live_…` and plain `sk_…` keys, and this
 * deployment's Production key is the last kind, so a prefix rule would warn on
 * the correct production key or pass a wrong one. Whether the key and the
 * client id *belong together* is asked of WorkOS instead —
 * {@link checkWorkosPairing}.
 */
function checkWorkos(): void {
  const clientId = required('WORKOS_CLIENT_ID');
  if (clientId !== null) {
    const ok = /^client_[0-9A-Za-z]+$/.test(clientId);
    // Printed when well-formed: it is in every authorization URL a browser is
    // sent to, and seeing it is how an operator notices it names the wrong
    // WorkOS environment. Not printed when malformed, which is when it is most
    // likely to be something else pasted into the wrong field.
    check(
      'WORKOS_CLIENT_ID',
      ok,
      ok ? `"${clientId}"` : 'not a WorkOS client id — expected `client_` and letters and digits',
    );
  }

  const apiKey = required('WORKOS_API_KEY');
  if (apiKey !== null) {
    // `sk_` and nothing more — see above. Enough to tell a secret key from the
    // client id or a publishable value pasted into the wrong field.
    const ok = apiKey.startsWith('sk_');
    check(
      'WORKOS_API_KEY',
      ok,
      ok
        ? 'set — whether it belongs with the client id is asked of WorkOS below'
        : 'not a WorkOS secret key — expected `sk_…`',
    );
  }

  const cookiePassword = required('WORKOS_COOKIE_PASSWORD');
  if (cookiePassword !== null) {
    if (cookiePassword.length < MIN_STATE_SECRET_LENGTH) {
      check(
        'WORKOS_COOKIE_PASSWORD',
        false,
        `shorter than ${MIN_STATE_SECRET_LENGTH} characters — the sign-in routes refuse it`,
      );
    } else if (cookiePassword === apiKey) {
      // Not a theoretical mistake: deriving this from the API key was once on
      // the table. Two credentials that are one value are one credential: a
      // leak of the key would also let its holder mint the state cookie that
      // binds a sign-in to a browser.
      check(
        'WORKOS_COOKIE_PASSWORD',
        false,
        'the same value as WORKOS_API_KEY — it must be an independent random value',
      );
    } else {
      check('WORKOS_COOKIE_PASSWORD', true, `set, ${MIN_STATE_SECRET_LENGTH}+ characters`);
    }
  }
}

function checkDatabase(): void {
  const app = process.env['DATABASE_URL'];
  const migration = process.env['MIGRATION_DATABASE_URL'];

  if (!app) {
    check('DATABASE_URL', false, 'not set');
    return;
  }

  const roleOf = (url: string | undefined): string | null => {
    if (!url) return null;
    try {
      const { username } = new URL(url);
      return username === '' ? null : decodeURIComponent(username);
    } catch {
      return null;
    }
  };

  const appRole = roleOf(app);
  const migrationRole = roleOf(migration);

  if (appRole !== null && appRole === migrationRole) {
    check(
      'DATABASE_URL',
      false,
      `connects as "${appRole}", the same role as MIGRATION_DATABASE_URL — ` +
        'the application would run with rights to drop tables and erase the audit log',
    );
    return;
  }

  check('DATABASE_URL', true, `connects as "${appRole ?? 'unknown'}"`);

  if (migration) {
    check('MIGRATION_DATABASE_URL', true, `connects as "${migrationRole ?? 'unknown'}"`);
  }
}

/**
 * Email, which is optional — so this reports rather than fails.
 *
 * A deployment without a mail provider works: the invitation flow says so, and
 * nothing else in the product sends anything. What is *not* fine is a
 * half-configuration, where a token is set but the from-address is missing, or
 * a token from the EU region is pointed at the default host. Both produce a
 * failure whose message says nothing about the cause, which is exactly what a
 * preflight check exists to prevent.
 */
function checkEmail(): void {
  const token = process.env['ZEPTOMAIL_TOKEN'];
  const from = process.env['ZEPTOMAIL_FROM_ADDRESS'];
  const apiUrl = process.env['ZEPTOMAIL_API_URL'];

  if (!token && !from) {
    check(
      'ZEPTOMAIL_TOKEN',
      true,
      'not set — email is optional; invitations answer 200 with `sent: false` and a reason',
    );
    return;
  }

  if (!token || !from) {
    check(
      token ? 'ZEPTOMAIL_FROM_ADDRESS' : 'ZEPTOMAIL_TOKEN',
      false,
      'half-configured: set both the token and the from-address, or neither',
    );
    return;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) {
    check('ZEPTOMAIL_FROM_ADDRESS', false, `"${from}" is not an email address`);
    return;
  }

  // The token itself is never printed. Its length is enough to distinguish "set
  // to something plausible" from "set to a placeholder".
  check('ZEPTOMAIL_TOKEN', token.length > 20, token.length > 20 ? 'set' : 'suspiciously short');
  check('ZEPTOMAIL_FROM_ADDRESS', true, from);

  if (apiUrl) {
    let host: string;
    try {
      host = new URL(apiUrl).host;
    } catch {
      check('ZEPTOMAIL_API_URL', false, 'not a valid URL');
      return;
    }
    check('ZEPTOMAIL_API_URL', host.endsWith('zeptomail.com') || host.includes('zeptomail'), host);
    return;
  }

  check(
    'ZEPTOMAIL_API_URL',
    true,
    'not set — using api.zeptomail.com. An EU or India account must set this',
  );
}

/**
 * Log shipping, which is optional for the same reason email is.
 *
 * A self-hoster has Cloudflare's own log tail and no reason to sign up for
 * anything, so an absent token is reported rather than failed. The two failures
 * worth catching here are the ones that produce a 401 with no explanation:
 *
 *  - a regional source token pointed at the shared ingest host, which is the
 *    same class of mistake as ZeptoMail's regional endpoint;
 *  - an ingest URL that is not a Better Stack host at all, which usually means
 *    somebody pasted the dashboard URL instead of the ingest one.
 *
 * The log threshold is checked too: a typo there is silent, and "we turned
 * debug on during the incident and saw nothing" is a bad thing to discover
 * during an incident.
 */
function checkLogging(): void {
  const token = process.env['BETTERSTACK_SOURCE_TOKEN'];
  const url = process.env['BETTERSTACK_INGEST_URL'];
  const level = process.env['XECRET_LOG_LEVEL'];

  if (level) {
    const allowed = ['debug', 'info', 'warn', 'error'];
    check(
      'XECRET_LOG_LEVEL',
      allowed.includes(level),
      allowed.includes(level) ? level : `"${level}" is not one of ${allowed.join(', ')}`,
    );
  }

  if (!token) {
    check(
      'BETTERSTACK_SOURCE_TOKEN',
      true,
      'not set — log shipping is optional; lines still go to the Cloudflare log tail',
    );
    return;
  }

  // The token itself is never printed. Its length distinguishes "set to
  // something plausible" from "set to a placeholder".
  check(
    'BETTERSTACK_SOURCE_TOKEN',
    token.length > 12,
    token.length > 12 ? 'set' : 'suspiciously short',
  );

  if (!url) {
    check(
      'BETTERSTACK_INGEST_URL',
      true,
      'not set — using in.logs.betterstack.com. A source created after mid-2024 has its own ' +
        '<id>.betterstackdata.com host and answers 401 without it',
    );
    return;
  }

  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    check('BETTERSTACK_INGEST_URL', false, 'not a valid URL');
    return;
  }

  check(
    'BETTERSTACK_INGEST_URL',
    host.includes('betterstack') || host.includes('betterstackdata'),
    host.includes('betterstack')
      ? host
      : `${host} is not a Better Stack host — the ingest URL is not the dashboard URL`,
  );
}

/**
 * Payments through Dodo (P12), which are optional — and all or nothing.
 *
 * None of the variables: billing is off, which is right for a self-hoster and
 * for this deployment until Dodo is set up, so it is reported rather than
 * failed. Some of them: the deployment answers 503 on every billing route and
 * on the webhook, so it fails here first. Validated by the same function the
 * Worker uses, so a value that passes here cannot fail there for a reason this
 * script did not consider.
 *
 * No network call here: whether the key and the products belong to the mode
 * is asked of Dodo by `checkDodoPairing`, below, unless `--offline`.
 */
function checkBilling(): void {
  try {
    const setup = billingSetup(process.env as never);
    if (setup.state === 'disabled') {
      check(
        'DODO_API_KEY',
        true,
        'not set — payments are off; plans are whatever `npm run plan:set` writes',
      );
      return;
    }
    const { config } = setup;
    check('DODO_ENVIRONMENT', true, config.mode);
    // Lengths and shapes only: the key and the secret are never printed.
    check(
      'DODO_API_KEY',
      config.apiKey.length >= 16,
      config.apiKey.length >= 16 ? 'set' : 'suspiciously short',
    );
    // `whsec_` and base64 of the key — what the verifying library decodes.
    // `billingSetup` already refuses anything else (as a half-configuration,
    // below); said here too so a passing run says what was checked.
    check(
      'DODO_WEBHOOK_SECRET',
      isWebhookSecret(config.webhookSecret),
      isWebhookSecret(config.webhookSecret)
        ? 'set (whsec_ + base64)'
        : 'not a Standard Webhooks secret — expected `whsec_` and base64, from the endpoint’s Overview tab',
    );
    // Product ids are not credentials, and seeing them is how an operator
    // notices a live id in a test-mode deployment.
    for (const entry of config.catalog) {
      check(
        `DODO_PRODUCT_${entry.plan.toUpperCase()}_${entry.interval.toUpperCase()}`,
        true,
        entry.productId,
      );
    }
    check('DODO_METER_SECRET_FETCH', true, `event name "${config.meterEventName}"`);
    check(
      'DODO_ADDON_SAML',
      true,
      config.samlAddonId ??
        'not set — the SAML add-on is granted by hand (`plan:set --addon saml`)',
    );
  } catch (cause) {
    if (cause instanceof BillingMisconfiguredError) {
      for (const problem of cause.problems) {
        check(problem.split(' ')[0] ?? 'DODO_*', false, `half-configured: ${problem}`);
      }
      return;
    }
    throw cause;
  }
}

/**
 * Asks WorkOS whether the API key and the client id in this shell belong to the
 * same WorkOS environment — the pairing a key's format cannot tell you.
 *
 * It presents a deliberately bogus authorization code with both. WorkOS checks
 * the client credentials before the code: a matching pair gets as far as the
 * code and answers `invalid_grant`; a key and a client id from different
 * environments (or a revoked key) are refused as `invalid_client` / 401 before
 * the code is looked at. Observed in all four Staging/Production pairings
 * (PR #113). Nothing is created, and the code can never be valid.
 *
 * Anything else — no answer, a 5xx, a shape not seen before — fails the check
 * with what came back, rather than passing a pairing nobody confirmed.
 */
async function checkWorkosPairing(): Promise<void> {
  const clientId = process.env['WORKOS_CLIENT_ID'];
  const apiKey = process.env['WORKOS_API_KEY'];
  // The shape checks above already reported anything missing or malformed.
  if (
    !clientId ||
    !apiKey ||
    !/^client_[0-9A-Za-z]+$/.test(clientId) ||
    !apiKey.startsWith('sk_')
  ) {
    return;
  }

  const name = 'WORKOS key ↔ client';
  let status: number;
  let error: string | undefined;
  try {
    const response = await fetch('https://api.workos.com/user_management/authenticate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: apiKey,
        grant_type: 'authorization_code',
        code: 'xecret-check-env-pairing-probe',
      }),
      signal: AbortSignal.timeout(10_000),
    });
    status = response.status;
    const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
    error =
      typeof body.error === 'string'
        ? body.error
        : typeof body.code === 'string'
          ? body.code
          : undefined;
  } catch (cause) {
    check(
      name,
      false,
      `could not ask WorkOS (${cause instanceof Error ? cause.message : String(cause)}) — rerun ` +
        'with network access, or with --offline to skip this one check',
    );
    return;
  }

  if (error === 'invalid_grant') {
    check(name, true, `the key belongs to ${clientId}'s WorkOS environment`);
  } else if (error === 'invalid_client' || status === 401) {
    check(
      name,
      false,
      `WorkOS refused this key for ${clientId} — the API key and the client id are from ` +
        'different WorkOS environments, or the key was revoked',
    );
  } else {
    check(
      name,
      false,
      `unexpected answer from WorkOS (HTTP ${status}, ${error ?? 'no error code'})`,
    );
  }
}

/**
 * Asks Dodo whether `DODO_API_KEY` belongs to the mode `DODO_ENVIRONMENT`
 * names, and whether the products do — the pairing nothing about a key's
 * format says. Dodo's test and live modes share nothing: a key is issued in
 * one, and the products, the meter and the webhook endpoint are made in one.
 * A deployment whose `DODO_ENVIRONMENT` and key disagree would send owners to
 * checkouts that fail, or take money in the mode nothing here reads.
 *
 * It reads one product (`GET /products/{id}`, Pro monthly) from the host of
 * the named mode: read-only, nothing is created. 200 is a key, a mode and a
 * product that belong together; 401 or 403 is a key from the other mode (or
 * a revoked one); 404 is a key of this mode and a product id from the other.
 *
 * **What this cannot check:** `DODO_WEBHOOK_SECRET`. A signing secret belongs
 * to one webhook endpoint, made in one mode, and nothing Dodo answers to an
 * API key says which — so a live deployment holding the test endpoint's
 * secret (or the reverse) passes here and refuses every delivery 401. The
 * first delivery after the deploy is that check (docs/operations/billing.md,
 * "The variables"): Dodo's endpoint page shows it answered 200.
 */
async function checkDodoPairing(): Promise<void> {
  let config: Extract<ReturnType<typeof billingSetup>, { state: 'enabled' }>['config'];
  try {
    const setup = billingSetup(process.env as never);
    if (setup.state === 'disabled') return;
    config = setup.config;
  } catch {
    // `checkBilling` reports the half-configuration.
    return;
  }

  const name = 'DODO key ↔ mode';
  const product = config.catalog.find(
    (entry) => entry.plan === 'pro' && entry.interval === 'monthly',
  )!;
  let status: number;
  try {
    const response = await fetch(
      `${config.baseUrl}/products/${encodeURIComponent(product.productId)}`,
      {
        headers: { authorization: `Bearer ${config.apiKey}`, accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      },
    );
    status = response.status;
    // Not read: a product is not a secret, but nothing here needs it.
    await response.body?.cancel().catch(() => undefined);
  } catch (cause) {
    check(
      name,
      false,
      `could not ask Dodo (${cause instanceof Error ? cause.message : String(cause)}) — rerun ` +
        'with network access, or with --offline to skip this one check',
    );
    return;
  }

  if (status === 200) {
    check(name, true, `the key reads ${product.productId} in ${config.mode}`);
  } else if (status === 401 || status === 403) {
    check(
      name,
      false,
      `Dodo's ${config.mode} host refused this key — it is from the other mode (test and live ` +
        'keys are separate), or it was revoked. DODO_ENVIRONMENT and DODO_API_KEY must come from ' +
        'the same Dodo mode',
    );
  } else if (status === 404) {
    check(
      name,
      false,
      `the key works in ${config.mode}, but ${product.productId} is not a product there — ` +
        'the DODO_PRODUCT_* ids are from the other mode, or mistyped',
    );
  } else {
    check(name, false, `unexpected answer from Dodo (HTTP ${status})`);
  }
  check(
    'DODO webhook ↔ mode',
    true,
    `not checkable here — confirm the first delivery after the deploy is answered 200 ` +
      `(the secret must be the ${config.mode} endpoint's)`,
  );
}

async function main(): Promise<void> {
  checkDatabase();
  checkRootKeys();
  checkWorkos();
  if (!process.argv.includes('--offline')) await checkWorkosPairing();
  checkEmail();
  checkLogging();
  checkBilling();
  if (!process.argv.includes('--offline')) await checkDodoPairing();

  const width = Math.max(...results.map((r) => r.name.length));
  const failed = results.filter((r) => !r.ok).length;

  console.warn('');
  for (const result of results) {
    console.warn(`${result.ok ? '✅' : '❌'}  ${result.name.padEnd(width)}  ${result.detail}`);
  }

  if (failed > 0) {
    console.error(
      `\n${failed} problem(s). See .env.example for what each variable is, and ` +
        'docs/operations/database-setup.md for the database ones.\n',
    );
    process.exit(1);
  }

  console.warn('\nConfiguration is valid.\n');
}

// Called rather than awaited at the top level: the root package.json has no
// `"type": "module"`, so tsx transpiles to CJS, where top-level await is a
// syntax error.
void main();

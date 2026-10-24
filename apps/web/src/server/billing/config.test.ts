import { describe, expect, it } from 'vitest';
import type { Bindings } from '../bindings';
import { MissingBindingError } from '../bindings';
import {
  BillingMisconfiguredError,
  billingSetup,
  catalogEntryFor,
  DODO_BASE_URL,
  isWebhookSecret,
  productFor,
  REQUIRED_BILLING_VARIABLES,
  takesLivePayments,
} from './config';

/**
 * Billing's configuration is all or nothing (P12). None of it: payments are
 * off and nothing else changes. Some of it: a loud 503 naming what is missing,
 * never a checkout that half-works.
 */

/**
 * Fixtures that name themselves, so the secret scan (and a reader) can tell them
 * from a real key — see `.gitleaks.toml`. The webhook secret is built at run
 * time: a Standard Webhooks secret is base64 after `whsec_`.
 */
const WEBHOOK_SECRET = `whsec_${btoa('example-not-a-real-key-32-bytes!')}`;

const COMPLETE = {
  DODO_API_KEY: 'dodo-example-not-a-real-key',
  DODO_WEBHOOK_SECRET: WEBHOOK_SECRET,
  DODO_ENVIRONMENT: 'test_mode',
  DODO_PRODUCT_PRO_MONTHLY: 'pdt_pro_m',
  DODO_PRODUCT_PRO_YEARLY: 'pdt_pro_y',
  DODO_PRODUCT_TEAM_MONTHLY: 'pdt_team_m',
  DODO_PRODUCT_TEAM_YEARLY: 'pdt_team_y',
  DODO_METER_SECRET_FETCH: 'secret_fetch_kilo',
} as const;

const env = (over: Record<string, string | undefined> = {}) =>
  ({ XECRET_ENV: 'production', XECRET_PUBLIC_URL: 'https://x', ...over }) as unknown as Bindings;

describe('billingSetup', () => {
  it('is off when nothing is set — a self-hoster, or this deployment before Dodo', () => {
    expect(billingSetup(env())).toEqual({ state: 'disabled' });
    // Blank values are absences, as everywhere else in the bindings.
    expect(billingSetup(env({ DODO_API_KEY: '  ', DODO_ENVIRONMENT: '' }))).toEqual({
      state: 'disabled',
    });
  });

  it('reads a complete configuration into the catalogue it sells from', () => {
    const setup = billingSetup(env(COMPLETE));
    expect(setup.state).toBe('enabled');
    if (setup.state !== 'enabled') return;
    expect(setup.config.baseUrl).toBe(DODO_BASE_URL.test_mode);
    expect(setup.config.meterEventName).toBe('secret_fetch_kilo');
    expect(setup.config.samlAddonId).toBeNull();
    expect(productFor(setup.config, 'team', 'yearly')).toBe('pdt_team_y');
    expect(catalogEntryFor(setup.config, 'pdt_pro_m')).toEqual({
      plan: 'pro',
      interval: 'monthly',
      productId: 'pdt_pro_m',
    });
    expect(catalogEntryFor(setup.config, 'pdt_selfhost_50')).toBeNull();
  });

  it('points live mode at the live host', () => {
    const setup = billingSetup(env({ ...COMPLETE, DODO_ENVIRONMENT: 'live_mode' }));
    expect(setup.state === 'enabled' && setup.config.baseUrl).toBe(DODO_BASE_URL.live_mode);
  });

  it('refuses a half-configuration, naming every missing variable', () => {
    for (const missing of REQUIRED_BILLING_VARIABLES) {
      const partial: Record<string, string | undefined> = { ...COMPLETE, [missing]: undefined };
      let thrown: unknown;
      try {
        billingSetup(env(partial));
      } catch (cause) {
        thrown = cause;
      }
      expect(thrown, missing).toBeInstanceOf(BillingMisconfiguredError);
      // A missing binding — so the route wrapper answers 503 and logs the name.
      expect(thrown).toBeInstanceOf(MissingBindingError);
      expect((thrown as BillingMisconfiguredError).binding).toContain(missing);
    }
  });

  it('treats the optional add-on alone as a half-configuration too', () => {
    expect(() => billingSetup(env({ DODO_ADDON_SAML: 'adn_saml' }))).toThrow(
      BillingMisconfiguredError,
    );
  });

  it('refuses an environment that is neither test nor live', () => {
    expect(() => billingSetup(env({ ...COMPLETE, DODO_ENVIRONMENT: 'live' }))).toThrow(
      /DODO_ENVIRONMENT/,
    );
  });

  it('refuses the meter id where the meter event name belongs', () => {
    expect(() => billingSetup(env({ ...COMPLETE, DODO_METER_SECRET_FETCH: 'mtr_abc123' }))).toThrow(
      /DODO_METER_SECRET_FETCH/,
    );
    expect(() => billingSetup(env({ ...COMPLETE, DODO_METER_SECRET_FETCH: 'has spaces' }))).toThrow(
      /DODO_METER_SECRET_FETCH/,
    );
  });

  it('refuses one product named by two variables — a webhook could not say what was bought', () => {
    expect(() =>
      billingSetup(
        env({ ...COMPLETE, DODO_PRODUCT_TEAM_YEARLY: COMPLETE.DODO_PRODUCT_PRO_YEARLY }),
      ),
    ).toThrow(/two variables name one product/);
  });

  it('never puts a credential in the error it throws', () => {
    try {
      billingSetup(env({ ...COMPLETE, DODO_ENVIRONMENT: 'nope' }));
    } catch (cause) {
      const text = `${(cause as Error).message} ${(cause as BillingMisconfiguredError).binding}`;
      expect(text).not.toContain(COMPLETE.DODO_API_KEY);
      expect(text).not.toContain(COMPLETE.DODO_WEBHOOK_SECRET);
    }
  });

  it('carries the SAML add-on when one is named', () => {
    const setup = billingSetup(env({ ...COMPLETE, DODO_ADDON_SAML: ' adn_saml ' }));
    expect(setup.state === 'enabled' && setup.config.samlAddonId).toBe('adn_saml');
  });

  it('refuses a webhook secret that is not whsec_ and base64 — every delivery would fail 401', () => {
    for (const bad of [
      'example-not-a-real-key',
      'whsec_',
      'whsec_not base64!',
      `whsec_${btoa('short')}`,
      `whsec_${btoa('example-not-a-real-key-32-bytes!').slice(1)}`,
    ]) {
      expect(() => billingSetup(env({ ...COMPLETE, DODO_WEBHOOK_SECRET: bad })), bad).toThrow(
        /DODO_WEBHOOK_SECRET \(not whsec_ followed by base64\)/,
      );
      expect(isWebhookSecret(bad), bad).toBe(false);
    }
    expect(isWebhookSecret(WEBHOOK_SECRET)).toBe(true);
  });
});

describe('takesLivePayments', () => {
  it('is true only for a complete configuration in live mode', () => {
    expect(takesLivePayments(env({ ...COMPLETE, DODO_ENVIRONMENT: 'live_mode' }))).toBe(true);
    // A staging rehearsal in test mode never tells the public that paying works.
    expect(takesLivePayments(env(COMPLETE))).toBe(false);
    expect(takesLivePayments(env())).toBe(false);
    // Half-configured: false, never a throw on a public page.
    expect(takesLivePayments(env({ DODO_API_KEY: 'x' }))).toBe(false);
  });
});

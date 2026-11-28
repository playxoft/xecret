import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { OverrideListResponse } from './override-crypto';

/**
 * "My overrides", rendered to static markup with what the API would answer
 * handed to the data hook — a server render runs no effects.
 *
 * What is pinned: the card is drawn only once the member has an override here
 * (or the list failed, which is not the same answer as "none"), and nothing at
 * all while the list is on its way; the set dialog, which is now how the first
 * one is set, explains the plan, the vault and the environment's mode before it
 * offers a field to type into.
 */

const resource = vi.hoisted(() => ({
  data: null as unknown,
  error: null as unknown,
  paths: [] as (string | null)[],
}));

const vault = vi.hoisted(() => ({ unlocked: false }));

vi.mock('@/app/(dashboard)/_lib/use-api-resource', () => ({
  useApiResource: (path: string | null) => {
    resource.paths.push(path);
    return {
      data: path === null ? null : resource.data,
      error: path === null ? null : resource.error,
      loading: false,
      reload: async () => {},
    };
  },
}));

vi.mock('@/components/vault', () => ({
  // Never a real key: the card only asks whether there is one.
  useVaultKeys: () => (vault.unlocked ? { stand: 'in' } : null),
}));

vi.mock('next/navigation', () => ({ usePathname: () => '/app/acme/api/development' }));

const { Dialog, Toaster } = await import('@/components/ui');
const { OverridesCard, overridesCardShown, setOverrideGate, SetOverrideStep } =
  await import('./overrides-card');

const PATH = '/api/orgs/acme/projects/api/environments/development/overrides';

function list(over: Partial<OverrideListResponse> = {}): OverrideListResponse {
  return { overrides: [], canSet: true, upgradeTo: null, ...over };
}

const ONE = list({
  overrides: [
    // A stand-in blob: nothing here is opened.
    { name: 'DATABASE_URL', ciphertext: 'xk2.gcm.stand-in', updatedAt: '2026-11-20T10:00:00.000Z' },
  ],
});

function renderCard(encryptionMode: string | null = 'e2ee'): string {
  return renderToStaticMarkup(
    createElement(
      Toaster,
      null,
      createElement(OverridesCard, {
        orgSlug: 'acme',
        orgId: 'org-1',
        projectId: 'api',
        envSlug: 'development',
        environmentId: 'env-1',
        encryptionMode,
        setting: null,
        onSettingChange: () => {},
      }),
    ),
  );
}

beforeEach(() => {
  resource.data = null;
  resource.error = null;
  resource.paths = [];
  vault.unlocked = false;
});

describe('whether the card is drawn', () => {
  it('only once there is an override in it', () => {
    expect(overridesCardShown({ encryptionMode: 'e2ee', data: ONE, error: null })).toBe(true);
    expect(overridesCardShown({ encryptionMode: 'e2ee', data: list(), error: null })).toBe(false);
  });

  it('not while the list is on its way, so nothing flashes up and vanishes', () => {
    expect(overridesCardShown({ encryptionMode: 'e2ee', data: null, error: null })).toBe(false);
    expect(overridesCardShown({ encryptionMode: null, data: null, error: null })).toBe(false);
  });

  it('when the list failed, because that is not the same answer as none', () => {
    expect(overridesCardShown({ encryptionMode: 'e2ee', data: null, error: new Error('x') })).toBe(
      true,
    );
  });

  it('never for an environment no override can exist in', () => {
    expect(overridesCardShown({ encryptionMode: 'server', data: ONE, error: null })).toBe(false);
  });
});

describe('the card, rendered', () => {
  it('is absent with no overrides', () => {
    resource.data = list();
    const html = renderCard();
    expect(html).not.toContain('My overrides');
    expect(html).not.toContain('Only you, and only on your machine');
    // Still read, though: the list is what decides, and the dialog needs it.
    expect(resource.paths).toContain(PATH);
  });

  it('is absent, skeleton and all, while the list loads', () => {
    expect(renderCard()).not.toContain('My overrides');
    expect(renderCard()).not.toContain('aria-busy');
  });

  it('is drawn with one, naming it', () => {
    resource.data = ONE;
    const html = renderCard();
    expect(html).toContain('My overrides');
    expect(html).toContain('DATABASE_URL');
    expect(html).toContain('aria-label="Remove your override for DATABASE_URL"');
  });

  it('is drawn with the failure when the list could not be read', () => {
    resource.error = new Error('offline');
    const html = renderCard();
    expect(html).toContain('My overrides');
    expect(html).toContain('Your overrides could not be loaded');
    expect(html).toContain('Try again');
  });

  it('is absent, and asks for nothing, in a server-mode environment', () => {
    const html = renderCard('server');
    expect(html).not.toContain('My overrides');
    expect(resource.paths).toEqual([null]);
  });

  it('keeps a downgraded organisation’s overrides on screen, saying why none can be added', () => {
    resource.data = { ...ONE, canSet: false, upgradeTo: 'pro' };
    vault.unlocked = true;
    const html = renderCard();
    expect(html).toContain('DATABASE_URL');
    // "Set an override" is drawn locked, saying which plan allows another.
    expect(html).toMatch(
      /<button[^>]*aria-disabled="true"[^>]*data-plan-locked=""[^>]*>(?:(?!<\/button>)[\s\S])*Set an override/,
    );
    expect(html).toContain('Personal overrides are on Pro and above.');
    expect(html).not.toContain('Replace your override');
  });

  it('offers another, and a replacement, once the vault is open', () => {
    resource.data = ONE;
    vault.unlocked = true;
    const html = renderCard();
    expect(html).toContain('Set an override');
    expect(html).toContain('aria-label="Replace your override for DATABASE_URL"');
  });
});

describe('what stands between the member and setting one', () => {
  const base = {
    encryptionMode: 'e2ee' as string | null,
    data: list() as OverrideListResponse | null,
    error: null as unknown,
    vaultUnlocked: true,
    keyStateRead: true,
  };

  it('nothing, with the plan, the vault and the key state all in place', () => {
    expect(setOverrideGate(base)).toEqual({ kind: 'ready' });
  });

  it('the plan, before the vault', () => {
    expect(
      setOverrideGate({
        ...base,
        data: list({ canSet: false, upgradeTo: 'pro' }),
        vaultUnlocked: false,
      }),
    ).toEqual({ kind: 'plan', upgradeTo: 'pro' });
  });

  it('a locked vault', () => {
    expect(setOverrideGate({ ...base, vaultUnlocked: false })).toEqual({ kind: 'locked' });
  });

  it('the list, which carries the plan answer', () => {
    expect(setOverrideGate({ ...base, data: null })).toEqual({ kind: 'loading' });
    const error = new Error('offline');
    expect(setOverrideGate({ ...base, data: null, error })).toEqual({ kind: 'error', error });
  });

  it('the environment’s mode, first of all', () => {
    expect(setOverrideGate({ ...base, encryptionMode: 'server' })).toEqual({ kind: 'server' });
    expect(setOverrideGate({ ...base, encryptionMode: null })).toEqual({ kind: 'reading' });
  });

  it('the key state this browser encrypts under', () => {
    expect(setOverrideGate({ ...base, keyStateRead: false })).toEqual({ kind: 'reading' });
  });
});

/** The set dialog's body, inside a bare `Dialog` root — the content would portal. */
function renderStep(gate: Parameters<typeof SetOverrideStep>[0]['gate']): string {
  return renderToStaticMarkup(
    createElement(
      Dialog,
      { open: true },
      createElement(SetOverrideStep, {
        gate,
        initialName: '',
        envSlug: 'development',
        existingNames: [],
        onRetry: () => {},
        onCancel: () => {},
        onSave: async () => {},
      }),
    ),
  );
}

describe('the set dialog', () => {
  it('is the form once nothing stands in the way', () => {
    const html = renderStep({ kind: 'ready' });
    expect(html).toContain('Set an override');
    expect(html).toContain('<textarea');
    expect(html).toContain('placeholder="DATABASE_URL"');
    expect(html).toMatch(/<button[^>]*type="submit"/);
  });

  it('shows the plan that unlocks it, with nothing to type', () => {
    const html = renderStep({ kind: 'plan', upgradeTo: 'pro' });
    expect(html).toContain('Personal overrides are on Pro and above.');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('type="submit"');
  });

  it('asks for the vault before anything can be encrypted', () => {
    const html = renderStep({ kind: 'locked' });
    expect(html).toContain('Unlock your vault first');
    expect(html).not.toContain('<textarea');
  });

  it('says why a server-mode environment has none', () => {
    expect(renderStep({ kind: 'server' })).toContain(
      'Personal overrides need end-to-end encryption',
    );
  });

  it('waits, rather than refusing, while the list is read', () => {
    const html = renderStep({ kind: 'loading' });
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('<textarea');
  });

  it('explains what an override is, to somebody who has never seen the card', () => {
    expect(renderStep({ kind: 'locked' })).toContain('Only you, and only on your machine');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What an environment screen decides about the key state it has just read —
 * the downgrade check above all — through the function the hook renders.
 *
 * ── The attack these are about ──
 * Before project addresses named the id, this browser filed its mode pins under
 * the project's slug, and before organisation addresses did, under the
 * organisation's slug too. On a cold load of the new address the shell's trail
 * is what carries them to the ids, and nothing makes the trail land first: a
 * server that wanted the downgrade answers the key state at once, holds the
 * trail back, and a page that judged the answer then would pin `server` under
 * an address that had never been pinned. So the screen reads the slugs for
 * itself, and waits for them, before it believes a `server` answer.
 */

const answers = vi.hoisted(() => new Map<string, () => Promise<unknown>>());
const asked = vi.hoisted(() => [] as string[]);

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn((path: string) => {
        asked.push(path);
        const answer = answers.get(path);
        if (answer === undefined) return Promise.reject(new Error(`unexpected GET ${path}`));
        return answer();
      }),
    },
  };
});

const { readEnvironmentKeyState } = await import('./use-environment-keys');
const { modePinKey } = await import('./pins');

const ORG_ID = '018f3f6a-0000-7000-8000-0000000000a1';
const PROJECT_ID = '018f3f6a-0000-7000-8000-0000000000f2';
const ENVIRONMENT_ID = '018f3f6a-0000-7000-8000-0000000000b1';
const TARGET = { orgId: ORG_ID, projectId: PROJECT_ID, envSlug: 'production' };
const KEYS_PATH = `/api/orgs/${ORG_ID}/projects/${PROJECT_ID}/environments/production/keys`;
const PROJECT_PATH = `/api/orgs/${ORG_ID}/projects/${PROJECT_ID}`;
const ORG_PATH = `/api/orgs/${ORG_ID}`;
const BOOK = 'xecret.pins.mode.v1';

function keysAnswer(encryptionMode: 'server' | 'e2ee') {
  return {
    keys: {
      encryptionMode,
      environmentId: ENVIRONMENT_ID,
      activeEdk: null,
      myGrant: null,
      ehkExists: false,
      pendingGrants: null,
      needsRotation: null,
      missingGrants: null,
      currentMaxSecretVersion: 0,
    },
  };
}

/** A project read that answers only after a delay — a trail held back. */
function slowly<T>(value: T, ms = 10): () => Promise<T> {
  return () => new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

let store: Map<string, string>;

beforeEach(() => {
  answers.clear();
  asked.length = 0;
  store = new Map();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The book as a browser left it before ids: production pinned, under both slugs. */
function pinnedUnderTheSlug(): void {
  store.set(
    BOOK,
    JSON.stringify({
      'mode:acme/api/production': { mode: 'e2ee', firstSeen: '2026-01-01T00:00:00Z' },
    }),
  );
}

/** And as one left it after project ids, before organisation ids. */
function pinnedUnderTheOrganisationSlug(): void {
  store.set(
    BOOK,
    JSON.stringify({
      [`mode:acme/${PROJECT_ID}/production`]: {
        mode: 'e2ee',
        firstSeen: '2026-01-01T00:00:00Z',
      },
    }),
  );
}

function book(): Record<string, { mode: string }> {
  return JSON.parse(store.get(BOOK) ?? '{}') as Record<string, { mode: string }>;
}

function read() {
  return readEnvironmentKeyState(TARGET, null, new AbortController().signal);
}

describe('a server answer on an id address with no pin of its own', () => {
  it('is refused as a downgrade when the slugs the browser pinned say e2ee, however late they arrive', async () => {
    pinnedUnderTheSlug();
    answers.set(KEYS_PATH, async () => keysAnswer('server'));
    // The shell's trail never lands in this test at all; the screen's own reads
    // of the organisation and the project are slow. The decision waits.
    answers.set(ORG_PATH, slowly({ organization: { id: ORG_ID, slug: 'acme' } }));
    answers.set(PROJECT_PATH, slowly({ project: { id: PROJECT_ID, slug: 'api' } }));

    expect(await read()).toMatchObject({ status: 'unavailable', reason: 'downgraded' });
    expect(asked).toEqual([KEYS_PATH, ORG_PATH, PROJECT_PATH]);
    // The pin went to the id the page reads under, so the next load refuses
    // without asking again.
    expect(book()[modePinKey(TARGET)]?.mode).toBe('e2ee');
    expect(await read()).toMatchObject({ reason: 'downgraded' });
  });

  it('is refused when only the organisation was filed by slug, even if the server misnames it', async () => {
    pinnedUnderTheOrganisationSlug();
    answers.set(KEYS_PATH, async () => keysAnswer('server'));
    answers.set(ORG_PATH, async () => ({ organization: { id: ORG_ID, slug: 'not-acme' } }));
    answers.set(PROJECT_PATH, async () => ({ project: { id: PROJECT_ID, slug: 'api' } }));

    expect(await read()).toMatchObject({ status: 'unavailable', reason: 'downgraded' });
    expect(book()[modePinKey(TARGET)]?.mode).toBe('e2ee');
  });

  it('is an error, never server, when the project cannot be read', async () => {
    pinnedUnderTheSlug();
    answers.set(KEYS_PATH, async () => keysAnswer('server'));
    answers.set(ORG_PATH, async () => ({ organization: { id: ORG_ID, slug: 'acme' } }));
    answers.set(PROJECT_PATH, () => Promise.reject(new Error('held back')));

    expect(await read()).toMatchObject({ status: 'error' });
    expect(book()[modePinKey(TARGET)]).toBeUndefined();
  });

  it('is an error, never server, when the organisation cannot be read', async () => {
    pinnedUnderTheSlug();
    answers.set(KEYS_PATH, async () => keysAnswer('server'));
    answers.set(ORG_PATH, () => Promise.reject(new Error('held back')));
    answers.set(PROJECT_PATH, async () => ({ project: { id: PROJECT_ID, slug: 'api' } }));

    expect(await read()).toMatchObject({ status: 'error' });
    expect(book()[modePinKey(TARGET)]).toBeUndefined();
  });

  it('is believed, and pinned, when no older pin says otherwise', async () => {
    answers.set(KEYS_PATH, async () => keysAnswer('server'));
    answers.set(ORG_PATH, async () => ({ organization: { id: ORG_ID, slug: 'acme' } }));
    answers.set(PROJECT_PATH, async () => ({ project: { id: PROJECT_ID, slug: 'api' } }));

    expect(await read()).toMatchObject({ status: 'server' });
    expect(book()[modePinKey(TARGET)]?.mode).toBe('server');
  });
});

it('never reads the project for an e2ee answer, which is pinned as it stands', async () => {
  answers.set(KEYS_PATH, async () => keysAnswer('e2ee'));

  // No vault in this test, so it stops at "locked", which is beside the point:
  // what matters is the requests it did not make.
  expect(await read()).toMatchObject({ status: 'unavailable' });
  expect(asked).toEqual([KEYS_PATH]);
  expect(book()[modePinKey(TARGET)]?.mode).toBe('e2ee');
});

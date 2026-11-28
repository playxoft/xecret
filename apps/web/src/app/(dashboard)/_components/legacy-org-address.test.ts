import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, isValidElement } from 'react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiError } from '@/lib/api';
import type { OrganizationResponse } from '@/components/projects/types';

/**
 * An old organisation address — `/app/acme/…`, from before organisations were
 * named by id, out of a bookmark, an email or a link an older CLI printed —
 * arriving at the page it always meant.
 *
 * Laid out as `legacy-project-address.test.ts` is, for the same three layers:
 * which addresses take the redirect (the organisation's layout, by shape, on
 * the server), where it goes and what it carries (`leaveLegacyOrgAddress`,
 * pure), and what is drawn meanwhile (static markup). The `router.replace` is
 * an effect, which this suite has no DOM to run; it is the function tested
 * below, then the router with its answer.
 */

const ORG_ID = vi.hoisted(() => '0193f2a1-0000-7000-8000-00000000a001');
const PROJECT_ID = '0193f2a1-7c3e-7d2a-9b1f-2a3b4c5d6e7f';

const resource = vi.hoisted(() => ({
  current: { data: null, error: null } as {
    data: OrganizationResponse | null;
    error: unknown;
  },
  asked: [] as (string | null)[],
}));

const session = vi.hoisted(() => ({
  organizations: [] as { id: string; slug: string; name: string }[],
}));

vi.mock('../_lib/use-api-resource', () => ({
  useApiResource: (path: string | null) => {
    resource.asked.push(path);
    return {
      data: path === null ? null : resource.current.data,
      error: path === null ? null : resource.current.error,
      loading: path !== null && resource.current.data === null && resource.current.error === null,
      reload: async () => {},
    };
  },
}));

vi.mock('./session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session')>()),
  useSession: () => ({ organizations: session.organizations }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  useParams: () => ({ orgId: 'acme' }),
  usePathname: () => '/app/acme',
}));

const { LegacyOrgAddress, leaveLegacyOrgAddress, legacyOrgRedirect } =
  await import('./legacy-org-address');
const { modeIsAllowed, modePinKey, readModePins, recordModePin } =
  await import('@/components/envkeys/pins');
const organizationLayout = await import('../app/[orgId]/layout');

beforeEach(() => {
  resource.current = { data: null, error: null };
  resource.asked = [];
  session.organizations = [];
});

/** What the layout returns for these params, without rendering it. */
async function layoutFor(orgId: string): Promise<ReactElement<Record<string, unknown>>> {
  const children = createElement('main', null, 'the page');
  const element = await organizationLayout.default({
    children,
    params: Promise.resolve({ orgId }),
  } as never);
  if (!isValidElement(element)) throw new Error('the layout returned no element');
  return element as ReactElement<Record<string, unknown>>;
}

describe('which organisation addresses take the redirect', () => {
  it('sends a slug in the organisation segment to the redirect, for every page beneath', async () => {
    const element = await layoutFor('acme');
    expect(element.type).toBe(LegacyOrgAddress);
    expect(element.props).toEqual({ orgSlug: 'acme' });
  });

  it('draws the page itself for an id', async () => {
    const element = await layoutFor(ORG_ID);
    expect(element.type).toBe('main');
  });

  it('treats only the canonical spelling as an id', async () => {
    // Uppercase is no id the system issues: it is looked up as a slug, and
    // answered "not found" by the same request any unknown slug gets.
    const element = await layoutFor(ORG_ID.toUpperCase());
    expect(element.type).toBe(LegacyOrgAddress);
  });
});

describe('where an old organisation address is sent', () => {
  const at = (pathname: string, search = '', hash = '') => ({ pathname, search, hash });

  it('is the same page under the id: the rest of the path, the query and the fragment kept', () => {
    expect(
      legacyOrgRedirect(at('/app/acme/settings/billing', '?checkout=returned', '#plans'), {
        id: ORG_ID,
      }),
    ).toBe(`/app/${ORG_ID}/settings/billing?checkout=returned#plans`);
    expect(legacyOrgRedirect(at(`/app/acme/${PROJECT_ID}/production`), { id: ORG_ID })).toBe(
      `/app/${ORG_ID}/${PROJECT_ID}/production`,
    );
    // An address old enough to name the project by slug too keeps it, for the
    // project's own redirect on the next page.
    expect(legacyOrgRedirect(at('/app/acme/payments-api/production'), { id: ORG_ID })).toBe(
      `/app/${ORG_ID}/payments-api/production`,
    );
  });

  it('is nowhere when the answer is not an id, whatever the server said', () => {
    for (const id of ['javascript:alert(1)', '../../evil', ORG_ID.toUpperCase(), '', 'acme']) {
      expect(legacyOrgRedirect(at('/app/acme/members'), { id }), id).toBeNull();
    }
  });
});

/**
 * Leaving an old organisation address carries the mode pins this browser
 * filed under the slug to the id, for every project and environment — from the
 * slug in the URL, which is the spelling they were filed under, and not merely
 * from whatever slug the server answered. The pins are what refuse an
 * e2ee→server downgrade, so a carry that missed would be a downgrade let
 * through by the very redirect meant to preserve them.
 */
describe('the pins an old organisation address leaves behind', () => {
  function memoryStorage(): Storage {
    const map = new Map<string, string>();
    return {
      get length() {
        return map.size;
      },
      clear: () => map.clear(),
      getItem: (key) => map.get(key) ?? null,
      key: (index) => [...map.keys()][index] ?? null,
      removeItem: (key) => map.delete(key),
      setItem: (key, value) => void map.set(key, value),
    } as Storage;
  }

  const at = { pathname: `/app/acme/${PROJECT_ID}/production`, search: '', hash: '' };
  const idKey = modePinKey({ orgId: ORG_ID, projectId: PROJECT_ID, envSlug: 'production' });

  it('carries every pin under the slug to the id, and the downgrade is still refused', () => {
    const storage = memoryStorage();
    recordModePin(`mode:acme/${PROJECT_ID}/production`, 'e2ee', storage);
    recordModePin('mode:acme/api/staging', 'e2ee', storage);

    const next = leaveLegacyOrgAddress({
      location: at,
      orgSlug: 'acme',
      found: { id: ORG_ID, slug: 'acme' },
      storage,
    });

    expect(next).toBe(`/app/${ORG_ID}/${PROJECT_ID}/production`);
    const pins = readModePins(storage);
    expect(modeIsAllowed(pins, idKey, 'server').allowed).toBe(false);
    // Another project, still by slug: moved to the organisation's id, for the
    // project's own carry to finish.
    expect(pins[`mode:${ORG_ID}/api/staging`]?.mode).toBe('e2ee');
  });

  it('holds when the server answers a different slug than the one in the URL', () => {
    const storage = memoryStorage();
    recordModePin(`mode:acme/${PROJECT_ID}/production`, 'e2ee', storage);

    leaveLegacyOrgAddress({
      location: at,
      orgSlug: 'acme',
      found: { id: ORG_ID, slug: 'not-the-slug-you-pinned' },
      storage,
    });

    expect(modeIsAllowed(readModePins(storage), idKey, 'server').allowed).toBe(false);
  });

  it('holds for a slug typed in another case', () => {
    const storage = memoryStorage();
    recordModePin(`mode:acme/${PROJECT_ID}/production`, 'e2ee', storage);

    leaveLegacyOrgAddress({
      location: { ...at, pathname: `/app/ACME/${PROJECT_ID}/production` },
      orgSlug: 'ACME',
      found: { id: ORG_ID, slug: 'acme' },
      storage,
    });

    expect(modeIsAllowed(readModePins(storage), idKey, 'server').allowed).toBe(false);
  });

  it('carries nothing when the answer is not an id, and goes nowhere', () => {
    const storage = memoryStorage();
    recordModePin(`mode:acme/${PROJECT_ID}/production`, 'e2ee', storage);
    const before = storage.getItem('xecret.pins.mode.v1');

    expect(
      leaveLegacyOrgAddress({
        location: at,
        orgSlug: 'acme',
        found: { id: 'not-an-id', slug: 'acme' },
        storage,
      }),
    ).toBeNull();
    expect(storage.getItem('xecret.pins.mode.v1')).toBe(before);
  });
});

describe('the page an old organisation address shows for a moment', () => {
  it('finds a membership by its slug without asking the server, in any case', () => {
    session.organizations = [{ id: ORG_ID, slug: 'acme', name: 'Acme' }];

    const html = renderToStaticMarkup(createElement(LegacyOrgAddress, { orgSlug: 'ACME' }));

    expect(html).toContain('Opening this organisation at its current address');
    expect(resource.asked).toEqual([null]);
    // The slug is never drawn: the page says what it is doing, not where from.
    expect(html).not.toContain('ACME');
  });

  it('asks the server when the slug names none of the viewer’s memberships', () => {
    renderToStaticMarkup(createElement(LegacyOrgAddress, { orgSlug: 'acme' }));
    expect(resource.asked).toEqual(['/api/orgs/acme']);
  });

  it('is the ordinary not-found when the slug names nothing this viewer can read', () => {
    resource.current = {
      data: null,
      error: new ApiError({
        status: 404,
        code: 'not_found',
        message: 'Not found.',
        requestId: 'req_1',
      }),
    };
    const html = renderToStaticMarkup(createElement(LegacyOrgAddress, { orgSlug: 'ghost' }));

    expect(html).not.toContain('Opening this organisation');
    expect(html).toContain('req_1');
  });
});

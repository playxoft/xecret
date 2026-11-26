import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, isValidElement } from 'react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiError } from '@/lib/api';
import type { ProjectResponse } from '@/components/projects/types';

/**
 * An old project address — `/app/{org}/{projectSlug}/…`, from before project
 * pages were named by id — arriving at the page it always meant.
 *
 * Three layers, each tested where it can be. Which addresses take the redirect
 * at all is the pages' decision, made by shape on the server, and is asserted
 * on the element each page returns. Where the redirect goes is
 * `legacyProjectRedirect`, pure, and asserted directly. What is drawn while the
 * slug is being looked up, and when it names nothing, is rendered to static
 * markup.
 *
 * ── The gap, stated ──
 * The `router.replace` itself happens in an effect, and this suite has no DOM
 * to run one in — the same gap `projects-screen.test.ts` names. The effect is
 * two calls: the function tested below, then the router with its answer.
 */

const resource = vi.hoisted(() => ({
  current: { data: null, error: null } as { data: ProjectResponse | null; error: unknown },
}));

vi.mock('../_lib/use-api-resource', () => ({
  useApiResource: () => ({
    data: resource.current.data,
    error: resource.current.error,
    loading: resource.current.data === null && resource.current.error === null,
    reload: async () => {},
  }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  useParams: () => ({ orgSlug: 'acme' }),
  usePathname: () => '/app/acme/payments-api/production',
}));

const { LegacyProjectAddress, leaveLegacyAddress, legacyProjectRedirect } =
  await import('./legacy-project-address');
const { modeIsAllowed, modePinKey, readModePins, recordModePin } =
  await import('@/components/envkeys/pins');
const { ProjectScreen } = await import('./project-screen');
const { EnvironmentScreen } = await import('./environment-screen');
const { EnvironmentSettingsScreen } = await import('./environment-settings-screen');
const projectPage = await import('../app/[orgSlug]/[projectId]/page');
const environmentPage = await import('../app/[orgSlug]/[projectId]/[envSlug]/page');
const settingsPage = await import('../app/[orgSlug]/[projectId]/[envSlug]/settings/page');

const PROJECT_ID = '0193f2a1-7c3e-7d2a-9b1f-2a3b4c5d6e7f';

beforeEach(() => {
  resource.current = { data: null, error: null };
});

/** What a page component returns for these params, without rendering it. */
async function pageFor(
  page: (props: never) => Promise<unknown>,
  params: Record<string, string>,
): Promise<ReactElement<Record<string, unknown>>> {
  const element = await page({ params: Promise.resolve(params) } as never);
  if (!isValidElement(element)) throw new Error('the page returned no element');
  return element as ReactElement<Record<string, unknown>>;
}

describe('which project addresses take the redirect', () => {
  it('sends a slug in the project segment to the redirect, on every project page', async () => {
    const params = { orgSlug: 'acme', projectId: 'payments-api', envSlug: 'production' };

    for (const page of [projectPage.default, environmentPage.default, settingsPage.default]) {
      const element = await pageFor(page, params);
      expect(element.type).toBe(LegacyProjectAddress);
      expect(element.props).toEqual({ orgSlug: 'acme', projectSlug: 'payments-api' });
    }
  });

  it('opens the screen itself for an id, naming the project by it', async () => {
    const params = { orgSlug: 'acme', projectId: PROJECT_ID, envSlug: 'production' };

    const project = await pageFor(projectPage.default, params);
    expect(project.type).toBe(ProjectScreen);
    expect(project.props).toMatchObject({ orgSlug: 'acme', projectId: PROJECT_ID });

    const environment = await pageFor(environmentPage.default, params);
    expect(environment.type).toBe(EnvironmentScreen);
    expect(environment.props).toMatchObject({ projectId: PROJECT_ID, envSlug: 'production' });

    const settings = await pageFor(settingsPage.default, params);
    expect(settings.type).toBe(EnvironmentSettingsScreen);
    expect(settings.props).toMatchObject({ projectId: PROJECT_ID, envSlug: 'production' });
  });

  it('treats only the canonical spelling as an id', async () => {
    // Uppercase is no id the system issues — it is looked up as a slug, and
    // answered "not found" by the same request any unknown slug gets.
    const element = await pageFor(projectPage.default, {
      orgSlug: 'acme',
      projectId: PROJECT_ID.toUpperCase(),
    });
    expect(element.type).toBe(LegacyProjectAddress);
  });
});

describe('where an old address is sent', () => {
  const at = (pathname: string, search = '', hash = '') => ({ pathname, search, hash });

  it('is the same page under the id: environment, sub-path, query and fragment kept', () => {
    expect(
      legacyProjectRedirect(
        at('/app/acme/payments-api/production/settings', '?from=digest', '#read-alerts'),
        { id: PROJECT_ID },
      ),
    ).toBe(`/app/acme/${PROJECT_ID}/production/settings?from=digest#read-alerts`);
    expect(legacyProjectRedirect(at('/app/acme/payments-api'), { id: PROJECT_ID })).toBe(
      `/app/acme/${PROJECT_ID}`,
    );
  });

  it('is nowhere when the answer is not an id, whatever the server said', () => {
    for (const id of ['javascript:alert(1)', '../../evil', PROJECT_ID.toUpperCase(), '', 'api']) {
      expect(legacyProjectRedirect(at('/app/acme/payments-api'), { id }), id).toBeNull();
    }
  });
});

/**
 * Leaving an old address carries the mode pins this browser filed under the
 * slug to the id — from the slug in the URL, which is the spelling the pins
 * were filed under, and not merely from whatever slug the server answered.
 */
describe('the pins an old address leaves behind', () => {
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

  const at = { pathname: '/app/acme/api/production', search: '', hash: '' };
  const idKey = modePinKey({ orgSlug: 'acme', projectId: PROJECT_ID, envSlug: 'production' });

  it('holds when the server answers a different slug than the one in the URL', () => {
    const storage = memoryStorage();
    recordModePin('mode:acme/api/production', 'e2ee', storage);

    // A lying API: the right id, a slug that matches no pin. Carried from the
    // server's slug alone, the copy would do nothing and the id page would be
    // at first contact.
    const next = leaveLegacyAddress({
      location: at,
      orgSlug: 'acme',
      projectSlug: 'api',
      found: { id: PROJECT_ID, slug: 'not-the-slug-you-pinned' },
      storage,
    });

    expect(next).toBe(`/app/acme/${PROJECT_ID}/production`);
    expect(modeIsAllowed(readModePins(storage), idKey, 'server').allowed).toBe(false);
  });

  it('holds for a slug typed in another case, through the server’s spelling', () => {
    const storage = memoryStorage();
    recordModePin('mode:acme/api/production', 'e2ee', storage);

    leaveLegacyAddress({
      location: { ...at, pathname: '/app/acme/API/production' },
      orgSlug: 'acme',
      projectSlug: 'API',
      found: { id: PROJECT_ID, slug: 'api' },
      storage,
    });

    expect(modeIsAllowed(readModePins(storage), idKey, 'server').allowed).toBe(false);
  });

  it('carries nothing when the answer is not an id, and goes nowhere', () => {
    const storage = memoryStorage();
    recordModePin('mode:acme/api/production', 'e2ee', storage);
    const before = storage.getItem('xecret.pins.mode.v1');

    expect(
      leaveLegacyAddress({
        location: at,
        orgSlug: 'acme',
        projectSlug: 'api',
        found: { id: 'not-an-id', slug: 'api' },
        storage,
      }),
    ).toBeNull();
    expect(storage.getItem('xecret.pins.mode.v1')).toBe(before);
  });
});

describe('the page an old address shows for a moment', () => {
  it('says it is opening the project while the slug is looked up', () => {
    const html = renderToStaticMarkup(
      createElement(LegacyProjectAddress, { orgSlug: 'acme', projectSlug: 'payments-api' }),
    );

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Opening this project at its current address');
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
    const html = renderToStaticMarkup(
      createElement(LegacyProjectAddress, { orgSlug: 'acme', projectSlug: 'ghost' }),
    );

    expect(html).not.toContain('Opening this project');
    expect(html).toContain('req_1');
  });
});

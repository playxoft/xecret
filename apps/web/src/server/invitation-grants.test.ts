import { beforeEach, describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '@xecret/core/ids';
import type { Database } from '@xecret/db';
import { ApiError } from './errors';

/**
 * The invitation's access selection, on its way from slugs to a stored seed.
 *
 * ── Why the level has to survive this step ──
 * `resolveInvitationGrants` is the only thing between the invite dialog and the
 * `initial_grants` snapshot, and the snapshot is what acceptance reads: a level
 * dropped here is a level nobody can recover, because the dialog is long gone
 * by the time anybody notices the invitee joined at the wrong one. The
 * fallback matters just as much in the other direction — an *absent* level must
 * stay absent rather than becoming an explicit one, because absence is what
 * makes acceptance fall back to the invited role's default, and every
 * invitation issued before levels were selectable relies on it.
 *
 * Only the two slug lookups are stubbed. What is under test is the mapping, the
 * de-duplication and the positional field errors — none of which the database
 * has an opinion about.
 */

const repository = vi.hoisted(() => ({
  findProjectBySlug: vi.fn(),
  findEnvironmentBySlug: vi.fn(),
}));

vi.mock('@xecret/db/repositories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xecret/db/repositories')>()),
  ...repository,
}));

const { resolveInvitationGrants } = await import('./members-service');

const ORG_ID = uuidv7();
const PROJECT_ID = uuidv7();
const OTHER_PROJECT_ID = uuidv7();
const STAGING_ID = uuidv7();
const PRODUCTION_ID = uuidv7();

const PROJECT_IDS: Readonly<Record<string, string>> = {
  api: PROJECT_ID,
  billing: OTHER_PROJECT_ID,
};

const ENVIRONMENT_IDS: Readonly<Record<string, string>> = {
  staging: STAGING_ID,
  production: PRODUCTION_ID,
};

/** Stands in for a database nothing here reads. */
const db = {} as Database;

beforeEach(() => {
  vi.clearAllMocks();

  repository.findProjectBySlug.mockImplementation((_db: unknown, _orgId: string, slug: string) =>
    Promise.resolve(slug in PROJECT_IDS ? { id: PROJECT_IDS[slug], slug } : undefined),
  );
  repository.findEnvironmentBySlug.mockImplementation(
    (_db: unknown, _orgId: string, _projectId: string, slug: string) =>
      Promise.resolve(slug in ENVIRONMENT_IDS ? { id: ENVIRONMENT_IDS[slug], slug } : undefined),
  );
});

async function rejection(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (cause) {
    if (cause instanceof ApiError) return cause;
    throw cause;
  }
  throw new Error('expected the operation to fail, but it succeeded');
}

describe('resolving an invitation’s access selection', () => {
  it('carries each selection’s level onto its seed', async () => {
    const seeds = await resolveInvitationGrants(db, ORG_ID, [
      { projectSlug: 'api', environmentSlug: 'staging', accessLevel: 'write' },
      { projectSlug: 'api', environmentSlug: 'production', accessLevel: 'read' },
    ]);

    expect(seeds).toEqual([
      { projectId: PROJECT_ID, environmentId: STAGING_ID, accessLevel: 'write' },
      { projectId: PROJECT_ID, environmentId: PRODUCTION_ID, accessLevel: 'read' },
    ]);
  });

  it('keeps an explicit no-access selection, which is a denial rather than a blank', async () => {
    // `none` is representable on purpose: it is what an inviter carving one
    // environment out of an otherwise-granted project selects, and acceptance
    // writes it as the row that outranks the project beside it.
    const seeds = await resolveInvitationGrants(db, ORG_ID, [
      { projectSlug: 'api', environmentSlug: null, accessLevel: 'read' },
      { projectSlug: 'api', environmentSlug: 'production', accessLevel: 'none' },
    ]);

    expect(seeds).toEqual([
      { projectId: PROJECT_ID, environmentId: null, accessLevel: 'read' },
      { projectId: PROJECT_ID, environmentId: PRODUCTION_ID, accessLevel: 'none' },
    ]);
  });

  it('omits the key entirely when the caller named no level', async () => {
    // Not `accessLevel: undefined`: this seed becomes a jsonb snapshot, and an
    // explicit `undefined` would serialise to a key acceptance then reads as a
    // stated level rather than as the absence that means "use the role default".
    const [seed] = await resolveInvitationGrants(db, ORG_ID, [
      { projectSlug: 'api', environmentSlug: 'staging' },
    ]);

    expect(seed).toEqual({ projectId: PROJECT_ID, environmentId: STAGING_ID });
    expect(Object.hasOwn(seed!, 'accessLevel')).toBe(false);
  });

  it('resolves a whole-project selection to a null environment', async () => {
    const seeds = await resolveInvitationGrants(db, ORG_ID, [
      { projectSlug: 'billing', environmentSlug: null, accessLevel: 'admin' },
    ]);

    expect(seeds).toEqual([
      { projectId: OTHER_PROJECT_ID, environmentId: null, accessLevel: 'admin' },
    ]);
  });

  it('keeps the first of two selections naming the same scope', async () => {
    // De-duplication is what stops one scope arriving twice at acceptance, where
    // "last seed wins" would make the outcome depend on the order a form
    // happened to serialise its rows in.
    const seeds = await resolveInvitationGrants(db, ORG_ID, [
      { projectSlug: 'api', environmentSlug: 'staging', accessLevel: 'read' },
      { projectSlug: 'api', environmentSlug: 'staging', accessLevel: 'admin' },
    ]);

    expect(seeds).toEqual([
      { projectId: PROJECT_ID, environmentId: STAGING_ID, accessLevel: 'read' },
    ]);
  });

  it('reads each project once however many of its environments are selected', async () => {
    await resolveInvitationGrants(db, ORG_ID, [
      { projectSlug: 'api', environmentSlug: 'staging', accessLevel: 'read' },
      { projectSlug: 'api', environmentSlug: 'production', accessLevel: 'read' },
    ]);

    expect(repository.findProjectBySlug).toHaveBeenCalledTimes(1);
  });

  it('names the position of a bad selection and never echoes the slug', async () => {
    // This API does not echo request input. The dialog can point at the row from
    // the index alone, and an unknown slug is not repeated back to a caller who
    // may have been probing for one.
    const error = await rejection(() =>
      resolveInvitationGrants(db, ORG_ID, [
        { projectSlug: 'api', environmentSlug: 'staging', accessLevel: 'read' },
        { projectSlug: 'ghost', environmentSlug: null, accessLevel: 'read' },
      ]),
    );

    expect(error.code).toBe('validation_failed');
    expect(error.fields?.[0]?.field).toBe('grants[1].projectSlug');
    expect(JSON.stringify(error.fields)).not.toContain('ghost');
  });

  it('refuses an environment that is not in the project it was named with', async () => {
    const error = await rejection(() =>
      resolveInvitationGrants(db, ORG_ID, [
        { projectSlug: 'api', environmentSlug: 'nowhere', accessLevel: 'read' },
      ]),
    );

    expect(error.code).toBe('validation_failed');
    expect(error.fields?.[0]?.field).toBe('grants[0].environmentSlug');
  });
});

import { describe, expect, it } from 'vitest';
import type { ZodMiniType } from 'zod/mini';
import { ORGANIZATION_NAME_MAX_LENGTH, truncateName } from '@xecret/core/validation';
import type {
  EnvironmentRecord,
  Organization,
  ProjectListItem,
  ProjectRecord,
} from '@xecret/db/repositories';
import { ApiError } from './errors';
import { parseQuery, parseWith } from './http';
import {
  assertSlugImmutable,
  confirmationMatches,
  destructiveRequestSchema,
  environmentCreateSchema,
  environmentPatchSchema,
  NAME_MAX_LENGTH,
  organizationCreateSchema,
  organizationLimitReached,
  ORGANIZATIONS_PER_ACCOUNT_LIMIT,
  organizationPatchSchema,
  pageQuerySchema,
  projectCreateSchema,
  projectPatchSchema,
  resolveEnvironmentSlug,
  resolveProjectSlug,
  toEnvironment,
  toOrganization,
  toProject,
  toProjectListItem,
} from './schemas/resources';

/**
 * Tests for the organisation, project and environment routes.
 *
 * **What these prove.** Everything a request is judged by before it reaches the
 * database: the schemas that decide whether a body is acceptable, the slug
 * derivation that decides what a project will be called for the rest of its
 * life, the pagination boundaries, the destructive-action confirmation, and the
 * response shapes that decide what a client is told. All of it is pure, so it is
 * exercised here for real rather than through a mock that would only assert that
 * the test author remembered how the code works.
 *
 * **What they cannot prove, and what integration coverage must.** There is no
 * database and no Cloudflare runtime in this process, so the handlers themselves
 * are not invoked. Specifically still uncovered:
 *
 *  - that every handler resolves through `tenancy.ts` and calls `authorize`
 *    before it reads or writes — the tenancy chain and the authorization
 *    decision are tested in `packages/db` and `packages/core` respectively, but
 *    their *use* by these routes is a property of the wiring;
 *  - that a project and its three default environments commit or roll back as
 *    one, which is a property of the transaction, not of any function in it;
 *  - that a cross-tenant slug answers 404 rather than 403 end to end;
 *  - that every mutation and every denial lands in `audit_logs` with the right
 *    `org_id`;
 *  - that the rate limiter is consulted before the database on every mutation.
 *
 * Those need a real Postgres and a real request. They are not simulated here,
 * because a fake database would prove only that the fake agrees with the test.
 */

function rejected<T>(schema: ZodMiniType<T>, value: unknown): ApiError {
  let thrown: unknown;
  try {
    parseWith(schema, value);
  } catch (cause) {
    thrown = cause;
  }

  expect(thrown).toBeInstanceOf(ApiError);
  return thrown as ApiError;
}

function failingFields<T>(schema: ZodMiniType<T>, value: unknown): string[] {
  return (rejected(schema, value).fields ?? []).map((problem) => problem.field);
}

function query(search: string): Request {
  return new Request(`https://xecret.playxoft.com/api/orgs/acme/projects${search}`);
}

describe('organisation creation schema', () => {
  it('accepts a name, which is the whole of the body', () => {
    expect(parseWith(organizationCreateSchema, { name: 'Acme' })).toEqual({ name: 'Acme' });
  });

  it('trims, so a name typed with a trailing space is stored without one', () => {
    expect(parseWith(organizationCreateSchema, { name: '  Acme  ' })).toEqual({ name: 'Acme' });
  });

  it('refuses a name that is empty, blank, or past the organisation ceiling', () => {
    expect(failingFields(organizationCreateSchema, { name: '' })).toEqual(['name']);
    expect(failingFields(organizationCreateSchema, { name: '   ' })).toEqual(['name']);
    expect(
      failingFields(organizationCreateSchema, {
        name: 'x'.repeat(ORGANIZATION_NAME_MAX_LENGTH + 1),
      }),
    ).toEqual(['name']);
    expect(
      parseWith(organizationCreateSchema, { name: 'x'.repeat(ORGANIZATION_NAME_MAX_LENGTH) }).name,
    ).toHaveLength(ORGANIZATION_NAME_MAX_LENGTH);
  });

  /**
   * The browser caps the input at the same number. Enforcing it here too is what
   * makes it a rule rather than a suggestion — a limit only the form knows about
   * holds until somebody uses `curl`.
   */
  it('holds an organisation to a shorter name than a project, on both endpoints', () => {
    const overLong = 'x'.repeat(ORGANIZATION_NAME_MAX_LENGTH + 1);

    expect(failingFields(organizationCreateSchema, { name: overLong })).toEqual(['name']);
    expect(failingFields(organizationPatchSchema, { name: overLong })).toEqual(['name']);
    // The same string is fine for a project, whose names are rendered where
    // there is room for them.
    expect(parseWith(projectCreateSchema, { name: overLong }).name).toBe(overLong);
    expect(ORGANIZATION_NAME_MAX_LENGTH).toBeLessThan(NAME_MAX_LENGTH);
  });

  it('requires the name, rather than inventing one', () => {
    expect(failingFields(organizationCreateSchema, {})).toEqual(['name']);
  });

  /**
   * The dashboard always sends one, having shown it to the user and checked it.
   * An organisation slug is permanent, so the identifier somebody is stuck with
   * must be one they saw and agreed to — not one the server picked because a
   * stranger they cannot see already held the obvious name.
   */
  it('accepts the slug the user chose', () => {
    expect(parseWith(organizationCreateSchema, { name: 'Acme', slug: 'acme-eu' })).toEqual({
      name: 'Acme',
      slug: 'acme-eu',
    });
  });

  /** Absent, the server derives and uniquifies — for API callers and sign-up. */
  it('accepts a name alone, because the slug is derived when it is absent', () => {
    expect(parseWith(organizationCreateSchema, { name: 'Acme' })).toEqual({ name: 'Acme' });
  });

  it('applies the same slug rules the rest of the product does', () => {
    for (const slug of ['Acme', 'acme corp', 'acme_corp', '-acme', 'acme-', 'acme--corp', '']) {
      const fields = failingFields(organizationCreateSchema, { name: 'Acme', slug });
      expect(fields.length, slug).toBeGreaterThan(0);
      expect(new Set(fields), slug).toEqual(new Set(['slug']));
    }
  });

  // Reserved slugs would shadow an application route for every tenant, not just
  // the one that claimed it. `availability` is among them precisely because the
  // endpoint this form calls lives at `/api/orgs/availability`.
  it('refuses a reserved slug, including the availability endpoint own name', () => {
    for (const slug of ['settings', 'api', 'availability', 'members']) {
      expect(failingFields(organizationCreateSchema, { name: 'Acme', slug }), slug).toEqual([
        'slug',
      ]);
    }
  });

  it('rejects an unrecognised field without naming it back to the caller', () => {
    const error = rejected(organizationCreateSchema, { name: 'Acme', ownerId: 'someone-else' });

    expect(error.code).toBe('validation_failed');
    expect(JSON.stringify(error.toBody('req-1'))).not.toContain('ownerId');
  });
});

/**
 * The refusal itself. Which callers reach it, and after which other gates, is
 * asserted against the real handler in `app/api/orgs/orgs-routes.test.ts`.
 */
describe('the organisation limit', () => {
  it('answers 409, the same status the product’s other quota answers', () => {
    const error = organizationLimitReached();

    // Not 403: the caller's permissions are fine, and the identical request
    // succeeds once they delete one. `mapMembershipError` maps `seatLimit` the
    // same way, and two quotas answering differently would make the rule look
    // like a permissions problem to anybody reading a client's error handling.
    expect(error.code).toBe('conflict');
    expect(error.status).toBe(409);
  });

  it('states the number, because it is the only actionable thing left to say', () => {
    expect(organizationLimitReached().message).toContain(String(ORGANIZATIONS_PER_ACCOUNT_LIMIT));
  });

  // A limit somebody meets while working normally is a limit that will be raised
  // by whoever is on support that day. This one exists to stop a script, and the
  // number should read that way.
  it('sits far above the one or two organisations a real account holds', () => {
    expect(ORGANIZATIONS_PER_ACCOUNT_LIMIT).toBeGreaterThanOrEqual(5);
    expect(Number.isInteger(ORGANIZATIONS_PER_ACCOUNT_LIMIT)).toBe(true);
  });
});

describe('project creation schema', () => {
  it('accepts the body a dashboard actually sends', () => {
    expect(
      parseWith(projectCreateSchema, {
        name: 'Billing API',
        slug: 'billing-api',
        description: 'Everything that talks to Stripe.',
      }),
    ).toEqual({
      name: 'Billing API',
      slug: 'billing-api',
      description: 'Everything that talks to Stripe.',
    });
  });

  it('accepts a name alone, because the slug is derived when it is absent', () => {
    expect(parseWith(projectCreateSchema, { name: 'Billing API' })).toEqual({
      name: 'Billing API',
    });
  });

  // A reserved slug would shadow an application route for every tenant, not just
  // the one that claimed it.
  it('refuses a reserved slug', () => {
    expect(failingFields(projectCreateSchema, { name: 'Settings', slug: 'settings' })).toEqual([
      'slug',
    ]);
    expect(failingFields(projectCreateSchema, { name: 'API', slug: 'api' })).toEqual(['slug']);
  });

  it('enforces the slug pattern rather than accepting anything URL-safe', () => {
    for (const slug of ['Billing API', 'billing_api', '-billing', 'billing-', 'billing--api', '']) {
      const fields = failingFields(projectCreateSchema, { name: 'Billing', slug });

      // A set, because the empty string fails both the length rule and the
      // pattern — two problems about one field, which is the honest report.
      expect(fields.length).toBeGreaterThan(0);
      expect(new Set(fields)).toEqual(new Set(['slug']));
    }
  });

  it('refuses a name that is empty, blank, or longer than a label should be', () => {
    expect(failingFields(projectCreateSchema, { name: '' })).toEqual(['name']);
    expect(failingFields(projectCreateSchema, { name: '   ' })).toEqual(['name']);
    expect(failingFields(projectCreateSchema, { name: 'x'.repeat(NAME_MAX_LENGTH + 1) })).toEqual([
      'name',
    ]);
    expect(parseWith(projectCreateSchema, { name: 'x'.repeat(NAME_MAX_LENGTH) }).name).toHaveLength(
      NAME_MAX_LENGTH,
    );
  });

  it('accepts a null description, which is how a description is cleared', () => {
    expect(parseWith(projectPatchSchema, { description: null })).toEqual({ description: null });
  });

  // The rejected key is a string a stranger chose. Nothing derived from a request
  // body reaches a response body in this product.
  it('rejects an unrecognised field without naming it back to the caller', () => {
    const error = rejected(projectCreateSchema, { name: 'Billing', createdBy: 'someone-else' });

    expect(error.code).toBe('validation_failed');
    expect(JSON.stringify(error.toBody('req-1'))).not.toContain('createdBy');
  });
});

describe('patch schemas', () => {
  it('refuses a patch that changes nothing, rather than writing a meaningless update', () => {
    for (const schema of [organizationPatchSchema, projectPatchSchema, environmentPatchSchema]) {
      expect(rejected(schema, {}).code).toBe('validation_failed');
    }
  });

  // The slug field passes validation on purpose: the handler then refuses it with
  // a message that explains why, which a generic "unrecognised key" would not.
  it('lets a slug through the schema so the handler can refuse it precisely', () => {
    expect(parseWith(projectPatchSchema, { slug: 'renamed' })).toEqual({ slug: 'renamed' });
    expect(parseWith(organizationPatchSchema, { slug: 'renamed' })).toEqual({ slug: 'renamed' });
    expect(parseWith(environmentPatchSchema, { slug: 'renamed' })).toEqual({ slug: 'renamed' });
  });

  /**
   * A name from an identity provider can be longer than an organisation name may
   * be, and a sign-up that failed for that reason would be an unrecoverable first
   * impression. So the *invented* name is shortened; a typed one is refused.
   */
  it('shortens an invented name to fit, preferring a word boundary', () => {
    expect(truncateName('Nitheesh Kumar Ramakrishnan', ORGANIZATION_NAME_MAX_LENGTH)).toBe(
      'Nitheesh Kumar',
    );
    // No usable boundary: a mid-word cut beats leaving one character behind.
    expect(truncateName('Extraordinarilylongname', 12)).toBe('Extraordinar');
    // Already short enough — returned as-is, merely trimmed.
    expect(truncateName('  Acme  ', ORGANIZATION_NAME_MAX_LENGTH)).toBe('Acme');
    // And whatever it produces is something the API will accept.
    expect(
      parseWith(organizationCreateSchema, {
        name: truncateName('A Very Long Organisation Name Indeed', ORGANIZATION_NAME_MAX_LENGTH),
      }).name.length,
    ).toBeLessThanOrEqual(ORGANIZATION_NAME_MAX_LENGTH);
  });

  it('accepts the fields that can genuinely change', () => {
    expect(parseWith(organizationPatchSchema, { name: 'Acme Inc' })).toEqual({ name: 'Acme Inc' });
    expect(parseWith(projectPatchSchema, { name: 'Billing', description: null })).toEqual({
      name: 'Billing',
      description: null,
    });
    expect(parseWith(environmentPatchSchema, { isProduction: true, sortOrder: 3 })).toEqual({
      isProduction: true,
      sortOrder: 3,
    });
  });
});

describe('environment creation schema', () => {
  it('permits an underscore in an environment slug, which a project slug refuses', () => {
    expect(parseWith(environmentCreateSchema, { name: 'EU West', slug: 'staging_eu' }).slug).toBe(
      'staging_eu',
    );
    expect(failingFields(projectCreateSchema, { name: 'EU West', slug: 'staging_eu' })).toEqual([
      'slug',
    ]);
  });

  it('bounds the sort order so it cannot overflow the integer column into a 500', () => {
    expect(failingFields(environmentCreateSchema, { name: 'Dev', sortOrder: 2 ** 31 })).toEqual([
      'sortOrder',
    ]);
    expect(failingFields(environmentCreateSchema, { name: 'Dev', sortOrder: -1 })).toEqual([
      'sortOrder',
    ]);
    expect(failingFields(environmentCreateSchema, { name: 'Dev', sortOrder: 1.5 })).toEqual([
      'sortOrder',
    ]);
    expect(parseWith(environmentCreateSchema, { name: 'Dev', sortOrder: 0 }).sortOrder).toBe(0);
  });

  it('requires a name, since there is nothing else to derive a slug from', () => {
    expect(failingFields(environmentCreateSchema, { slug: 'staging' })).toEqual(['name']);
  });
});

describe('slug immutability', () => {
  it('refuses an attempt to change a slug and explains what would break', () => {
    expect(() => assertSlugImmutable({ slug: 'renamed' }, 'project')).toThrowError(ApiError);

    try {
      assertSlugImmutable({ slug: 'renamed' }, 'project');
    } catch (cause) {
      const failure = cause as ApiError;
      expect(failure.code).toBe('bad_request');
      expect(failure.message).toContain('.xecret.yaml');
    }
  });

  // The presence of the field is the attempt. A null or an empty string is not a
  // caller declining to rename — it is a caller renaming it to nothing.
  it('refuses a null or empty slug for the same reason', () => {
    expect(() => assertSlugImmutable({ slug: null }, 'organisation')).toThrowError(ApiError);
    expect(() => assertSlugImmutable({ slug: '' }, 'environment')).toThrowError(ApiError);
  });

  it('says nothing about a patch that does not mention the slug', () => {
    expect(() => assertSlugImmutable({ name: 'Billing' }, 'project')).not.toThrow();
    expect(() => assertSlugImmutable({}, 'project')).not.toThrow();
  });
});

describe('slug derivation', () => {
  it('derives a usable slug from the names people actually type', () => {
    expect(resolveProjectSlug({ name: 'Billing API' })).toBe('billing-api');
    expect(resolveProjectSlug({ name: '  Payments   v2  ' })).toBe('payments-v2');
    expect(resolveProjectSlug({ name: 'Café Service' })).toBe('cafe-service');
    expect(resolveProjectSlug({ name: 'ACME / Internal' })).toBe('acme-internal');
  });

  it('prefers the slug the caller chose over one derived from the name', () => {
    expect(resolveProjectSlug({ name: 'Billing API', slug: 'billing' })).toBe('billing');
  });

  // Inventing an identifier for a name that yields nothing would put a slug in
  // the user's URLs and CI configuration that they never chose and cannot change.
  it('refuses a name that normalises to nothing instead of inventing an identifier', () => {
    for (const name of ['🎉🎉', '---', '...', '？']) {
      let thrown: unknown;
      try {
        resolveProjectSlug({ name });
      } catch (cause) {
        thrown = cause;
      }

      expect((thrown as ApiError).code).toBe('validation_failed');
      expect((thrown as ApiError).fields?.[0]?.field).toBe('slug');
    }
  });

  it('refuses a name whose derived slug would be reserved', () => {
    let thrown: unknown;
    try {
      resolveProjectSlug({ name: 'Settings' });
    } catch (cause) {
      thrown = cause;
    }

    expect((thrown as ApiError).fields?.[0]?.message).toContain('reserved');
  });

  // The reserved list guards application routes, which environments are nested
  // far beneath — so `settings` is a perfectly good environment name.
  it('applies the reserved list to projects but not to environments', () => {
    expect(resolveEnvironmentSlug({ name: 'Settings' })).toBe('settings');
    expect(resolveEnvironmentSlug({ name: 'EU West' })).toBe('eu-west');
  });
});

describe('pagination', () => {
  it('defaults to the first page and the shared default page size', () => {
    expect(parseQuery(query(''), pageQuerySchema)).toEqual({ page: 1, pageSize: 50 });
  });

  it('reads the numbers out of a query string, where everything is a string', () => {
    expect(parseQuery(query('?page=3&pageSize=10'), pageQuerySchema)).toEqual({
      page: 3,
      pageSize: 10,
    });
  });

  it('refuses a page below one, a fractional page, and a page that is not a number', () => {
    for (const search of ['?page=0', '?page=-1', '?page=1.5', '?page=abc', '?page=']) {
      expect(() => parseQuery(query(search), pageQuerySchema)).toThrowError(ApiError);
    }
  });

  it('refuses a page size past the ceiling rather than quietly clamping it', () => {
    expect(parseQuery(query('?pageSize=200'), pageQuerySchema).pageSize).toBe(200);
    expect(() => parseQuery(query('?pageSize=201'), pageQuerySchema)).toThrowError(ApiError);
    expect(() => parseQuery(query('?pageSize=0'), pageQuerySchema)).toThrowError(ApiError);
  });

  // Unlike a body, a query string is not a contract: a cache-busting parameter
  // must not fail the request.
  it('ignores a query parameter it does not recognise', () => {
    expect(parseQuery(query('?page=2&_=1736500000'), pageQuerySchema).page).toBe(2);
  });
});

describe('destructive confirmation', () => {
  it('matches only the slug of the thing being destroyed', () => {
    expect(confirmationMatches('billing-api', 'billing-api')).toBe(true);
    expect(confirmationMatches('billing-api', 'billing')).toBe(false);
    expect(confirmationMatches('billing-api', 'billing-api-2')).toBe(false);
  });

  it('treats an absent or empty confirmation as no confirmation at all', () => {
    expect(confirmationMatches('billing-api', undefined)).toBe(false);
    expect(confirmationMatches('billing-api', '')).toBe(false);
    expect(confirmationMatches('billing-api', '   ')).toBe(false);
  });

  // A guard against a misclick, not against an attacker — who can read the slug
  // anyway. Failing on a pasted trailing space would only teach people to retry.
  it('forgives the whitespace and casing a paste introduces', () => {
    expect(confirmationMatches('billing-api', '  billing-api  ')).toBe(true);
    expect(confirmationMatches('billing-api', 'Billing-API')).toBe(true);
  });

  // The schema admits an empty body; which routes *require* the field is the
  // handler's call. Today that is deleting an organisation, and deleting a
  // project that holds a production environment.
  it('accepts a request with no body at all, so only the routes that need one demand it', () => {
    expect(parseWith(destructiveRequestSchema, undefined)).toEqual({});
    expect(parseWith(destructiveRequestSchema, { confirm: 'billing-api' })).toEqual({
      confirm: 'billing-api',
    });
    expect(rejected(destructiveRequestSchema, { force: true }).code).toBe('validation_failed');
  });
});

describe('response shapes', () => {
  const organization: Organization = {
    id: '0198c0de-0000-7000-8000-000000000001',
    name: 'Acme',
    slug: 'acme',
    seatLimit: 5,
    createdBy: '0198c0de-0000-7000-8000-00000000000a',
    createdAt: new Date('2026-01-01T10:00:00.000Z'),
    updatedAt: new Date('2026-02-01T10:00:00.000Z'),
    deletedAt: null,
  };

  const project: ProjectRecord = {
    id: '0198c0de-0000-7000-8000-000000000002',
    orgId: organization.id,
    name: 'Billing API',
    slug: 'billing-api',
    description: null,
    createdBy: organization.createdBy,
    createdAt: new Date('2026-01-02T10:00:00.000Z'),
    updatedAt: new Date('2026-02-02T10:00:00.000Z'),
    deletedAt: null,
  };

  const environment: EnvironmentRecord = {
    id: '0198c0de-0000-7000-8000-000000000003',
    projectId: project.id,
    name: 'Production',
    slug: 'production',
    isProduction: true,
    sortOrder: 2,
    createdAt: new Date('2026-01-03T10:00:00.000Z'),
    updatedAt: new Date('2026-02-03T10:00:00.000Z'),
    deletedAt: null,
  };

  // A slug is scoped to its parent, so a path built from slugs carries the whole
  // tenancy chain. Publishing an id invites a caller to address a resource
  // without one.
  it('addresses a project and an environment by slug, never by id', () => {
    expect(Object.hasOwn(toProject(project), 'id')).toBe(false);
    expect(Object.hasOwn(toProject(project), 'orgId')).toBe(false);
    expect(Object.hasOwn(toEnvironment(environment), 'id')).toBe(false);
    expect(Object.hasOwn(toEnvironment(environment), 'projectId')).toBe(false);
  });

  it('never serialises deleted_at, so a hidden row cannot be rendered as a live one', () => {
    const deleted: ProjectRecord = { ...project, deletedAt: new Date() };
    expect(Object.hasOwn(toProject(deleted), 'deletedAt')).toBe(false);
    expect(
      Object.hasOwn(toEnvironment({ ...environment, deletedAt: new Date() }), 'deletedAt'),
    ).toBe(false);
  });

  it('renders every timestamp as an ISO string, not as a driver Date', () => {
    expect(toProject(project).createdAt).toBe('2026-01-02T10:00:00.000Z');
    expect(toEnvironment(environment).updatedAt).toBe('2026-02-03T10:00:00.000Z');
    expect(toOrganization(organization, 'owner').createdAt).toBe('2026-01-01T10:00:00.000Z');
  });

  it('reports the caller’s role, and reports its absence honestly', () => {
    expect(toOrganization(organization, 'admin').role).toBe('admin');
    // A service token holds no membership; `null` says so rather than implying a
    // role it does not have.
    expect(toOrganization(organization, null).role).toBeNull();
  });

  it('carries the environment count the listing query aggregated', () => {
    const item: ProjectListItem = { ...project, environmentCount: 3 };
    expect(toProjectListItem(item)).toMatchObject({ slug: 'billing-api', environmentCount: 3 });
  });

  it('keeps the production flag and the display order a client sorts by', () => {
    expect(toEnvironment(environment)).toMatchObject({
      slug: 'production',
      isProduction: true,
      sortOrder: 2,
    });
  });
});

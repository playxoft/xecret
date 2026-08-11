/**
 * Every address the dashboard uses: the pages a person navigates to, and the API
 * routes behind them.
 *
 * The two halves live together because they have to agree. `/app/{org}/{project}`
 * and `/api/orgs/{org}/projects/{project}` name the same resource, and a screen
 * that reads one while linking to the other produces a 404 nobody notices until
 * somebody's slug is interesting.
 *
 * Two rules:
 *
 *  1. **Every segment is encoded.** Slugs and secret names are pattern-bound
 *     (`^[a-z0-9]+(?:-[a-z0-9]+)*$`, `^[A-Za-z_][A-Za-z0-9_]*$`), so encoding is
 *     a no-op for every value that can legitimately arrive — which is precisely
 *     why it is unconditional rather than "where needed". The day a value gets
 *     here from a path that did not validate it, this is what keeps it inside
 *     its own segment.
 *  2. **A secret name may appear in a path; a secret value may not.** Not in a
 *     path, not in a query string, not in a fragment. A URL is logged by every
 *     proxy on the way, kept in browser history, and sent in `Referer`. The
 *     reveal endpoint answers with a body, and the body is the only place a
 *     plaintext value is ever permitted to exist.
 *
 * API builders return paths that already start with `/api/`, which `lib/api.ts`
 * passes through untouched. That makes the same string usable both as an
 * argument to `api.get()` and as the `href` of a download link.
 *
 * This is the dashboard's address book, so it lives with the dashboard routes
 * and is imported by their feature components in `components/projects` and
 * `components/secrets`. The alternative — each feature interpolating its own
 * paths — is how a client ends up calling `/api/org/…` in one place and
 * `/api/orgs/…` in another.
 */

const segment = encodeURIComponent;

/** Pages. Everything under `/app` requires a session. */
export const appPath = {
  root: (): string => '/app',
  org: (org: string): string => `/app/${segment(org)}`,
  orgSettings: (org: string): string => `/app/${segment(org)}/settings`,
  project: (org: string, project: string): string => `${appPath.org(org)}/${segment(project)}`,
  environment: (org: string, project: string, env: string): string =>
    `${appPath.project(org, project)}/${segment(env)}`,
  environmentSettings: (org: string, project: string, env: string): string =>
    `${appPath.environment(org, project, env)}/settings`,
  account: (): string => '/app/settings/account',
} as const;

/** API routes, as documented in `docs/architecture/api.md` §4. */
export const apiPath = {
  me: (): string => '/api/auth/me',
  sessions: (): string => '/api/auth/sessions',
  orgs: (): string => '/api/orgs',
  org: (org: string): string => `/api/orgs/${segment(org)}`,
  projects: (org: string): string => `${apiPath.org(org)}/projects`,
  project: (org: string, project: string): string => `${apiPath.projects(org)}/${segment(project)}`,
  environments: (org: string, project: string): string =>
    `${apiPath.project(org, project)}/environments`,
  environment: (org: string, project: string, env: string): string =>
    `${apiPath.environments(org, project)}/${segment(env)}`,
  secrets: (org: string, project: string, env: string): string =>
    `${apiPath.environment(org, project, env)}/secrets`,
  secret: (org: string, project: string, env: string, name: string): string =>
    `${apiPath.secrets(org, project, env)}/${segment(name)}`,
  secretVersions: (org: string, project: string, env: string, name: string): string =>
    `${apiPath.secret(org, project, env, name)}/versions`,
  secretRestore: (org: string, project: string, env: string, name: string): string =>
    `${apiPath.secret(org, project, env, name)}/restore`,
  import: (org: string, project: string, env: string): string =>
    `${apiPath.environment(org, project, env)}/import`,
  export: (org: string, project: string, env: string): string =>
    `${apiPath.environment(org, project, env)}/export`,
} as const;

/**
 * Appends a query string, dropping absent values.
 *
 * The result is a plain string rather than `api`'s `query` option because these
 * paths are used as effect dependencies: an object literal is a new identity on
 * every render, and a fetch keyed on one re-runs forever.
 */
export function withQuery(
  path: string,
  params: Readonly<Record<string, string | number | undefined>>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }
  const serialised = search.toString();
  return serialised.length > 0 ? `${path}?${serialised}` : path;
}

/**
 * Which organisation, project and environment the current URL is about.
 *
 * Derived from the path rather than from a context that each page has to
 * populate, so the shell knows where it is before any request has resolved —
 * which is what lets the sidebar and breadcrumbs render during the first load
 * rather than appearing a beat later.
 *
 * `settings` is unambiguous at both places it appears. At the first position it
 * is `/app/settings/account`, and no organisation can shadow it because
 * `settings` is in the reserved slug list; at the second it is the organisation
 * settings page, and no project can shadow it for the same reason.
 */
export interface DashboardLocation {
  orgSlug: string | null;
  projectSlug: string | null;
  envSlug: string | null;
  /** `/app/settings/**` — scoped to the person, not to an organisation. */
  isAccountArea: boolean;
}

export function parseDashboardPath(pathname: string): DashboardLocation {
  const [root, first, second, third] = pathname.split('/').filter(Boolean);
  const empty: DashboardLocation = {
    orgSlug: null,
    projectSlug: null,
    envSlug: null,
    isAccountArea: false,
  };

  if (root !== 'app' || first === undefined) return empty;
  if (first === 'settings') return { ...empty, isAccountArea: true };

  return {
    orgSlug: decodeURIComponent(first),
    projectSlug: second === undefined || second === 'settings' ? null : decodeURIComponent(second),
    envSlug: third === undefined || second === 'settings' ? null : decodeURIComponent(third),
    isAccountArea: false,
  };
}

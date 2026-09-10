/**
 * The organisation, project and environment payloads, as the API returns them.
 *
 * These mirror `src/server/schemas/resources.ts` exactly, and are restated here
 * rather than imported from it because that module pulls in zod schemas, the
 * repository types and the error helpers — server code that has no business in a
 * browser bundle. The duplication is bounded (three flat records of scalars) and
 * the direction of drift is safe: a field added on the server is simply not
 * rendered until it is added here, whereas a field *removed* on the server
 * surfaces as `undefined` in the one screen that reads it.
 */

import type { OrgRole } from '@xecret/core/authz';

export interface Organization {
  id: string;
  name: string;
  slug: string;
  /** `null` only for a service token, which never reaches the dashboard. */
  role: OrgRole | null;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  name: string;
  slug: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectListItem extends Project {
  environmentCount: number;
}

export interface Environment {
  name: string;
  slug: string;
  isProduction: boolean;
  sortOrder: number;
  /**
   * `'e2ee'` or `'server'`.
   *
   * Published on the listing deliberately, so a client never discovers the mode
   * by sending a plaintext to an environment that cannot accept one — or, in the
   * token dialog's case, by minting a credential that turns out to need a key.
   * Typed as `string` rather than a union because the set closes when the
   * migration completes, and a client that hard-codes today's two values would
   * have to be redeployed to learn a third.
   */
  encryptionMode: string;
  createdAt: string;
  updatedAt: string;
}

/** `GET …/environments/{envSlug}` adds the count; the listing does not. */
export interface EnvironmentDetail extends Environment {
  secretCount: number;
}

export interface OrganizationResponse {
  organization: Organization;
}

export interface ProjectListResponse {
  projects: readonly ProjectListItem[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface ProjectResponse {
  project: Project;
  environments: readonly Environment[];
}

export interface EnvironmentResponse {
  environment: EnvironmentDetail;
}

export interface CreateProjectResponse {
  project: Project;
  environments: readonly Environment[];
}

export interface CreateEnvironmentResponse {
  environment: Environment;
}

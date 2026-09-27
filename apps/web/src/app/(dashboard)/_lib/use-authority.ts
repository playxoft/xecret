'use client';

import { useMemo } from 'react';

import type { AccessLevel } from '@xecret/core/authz';
import { apiPath } from './paths';
import { useApiResource } from './use-api-resource';

/** The body of `GET /api/orgs/{orgSlug}/authority`, as far as the dialogs read it. */
export interface AuthorityResponse {
  grantable: readonly { projectSlug: string; environmentSlug: string; accessLevel: AccessLevel }[];
}

/**
 * The most the viewer could grant on one environment, or `undefined` when that
 * is not known — still loading, failed, or an environment created after the
 * answer arrived. `undefined` means "offer everything and let the server
 * decide", never "offer nothing": a dialog that locked every level while a
 * request was in flight would read as a permissions problem that is not there.
 */
export type GrantableLevel = (
  projectSlug: string,
  environmentSlug: string,
) => AccessLevel | undefined;

/**
 * What the viewer may grant where, for the dialogs that hand out access — the
 * member access panel, the project members dialog, and the invite dialog.
 *
 * Each level is `grantableAccessLevel` as the server computed it for the
 * viewer — the same measure the grant routes refuse by — so a level control
 * drawn from it offers exactly the levels a write could succeed with. It
 * decides what is drawn, never what is permitted.
 *
 * Pass `null` to ask nothing, for a viewer who manages nobody.
 */
export function useGrantable(orgSlug: string | null): GrantableLevel {
  const authority = useApiResource<AuthorityResponse>(
    orgSlug === null ? null : apiPath.authority(orgSlug),
  );

  return useMemo(() => {
    const levels = new Map(
      (authority.data?.grantable ?? []).map((entry) => [
        `${entry.projectSlug}/${entry.environmentSlug}`,
        entry.accessLevel,
      ]),
    );
    return (projectSlug: string, environmentSlug: string) =>
      levels.get(`${projectSlug}/${environmentSlug}`);
  }, [authority.data]);
}

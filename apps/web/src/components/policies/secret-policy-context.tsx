'use client';

import { createContext, use } from 'react';
import type { ReactNode } from 'react';

import type { SecretPolicy } from '@xecret/core/policy';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
import { useApiResource } from '@/app/(dashboard)/_lib/use-api-resource';
import type { ApiResource } from '@/app/(dashboard)/_lib/use-api-resource';
import type { OrgPoliciesResponse } from './types';

/**
 * The organisation's policies, read once per screen.
 *
 * Every member may read them — the clients enforce the value rules before they
 * encrypt, so every client that writes needs the rulebook — and a screen that
 * writes secrets reads them once, at the top, rather than per row: a table of
 * sixty rows asking sixty times would be sixty requests for one answer.
 */
export function useOrgPolicies(orgSlug: string): ApiResource<OrgPoliciesResponse> {
  return useApiResource<OrgPoliciesResponse>(apiPath.policies(orgSlug));
}

/**
 * The secret policy, handed down to every editor on the screen.
 *
 * A context rather than a prop because the editors that need it are four
 * components deep and in three different places — a stored row's value field,
 * a new row, a compared environment's cell — and threading one value through
 * every layer between would be a prop most of them only pass along. Each caller
 * supplies its own `isProduction`: the policy is the organisation's, but a
 * `production`-scoped one applies to some of the environments on screen and
 * not to others.
 *
 * A screen that reads the organisation's policy supplies `secretPolicyFrom(…)`,
 * which is a stand-in while it loads or when it could not be read — and a value
 * written against either stand-in is refused, naming why (review round 1, M5).
 * `null`, the default, is "no policy applies": a component rendered outside any
 * screen that reads one.
 */
const SecretPolicyContext = createContext<SecretPolicy | null>(null);

export function SecretPolicyProvider({
  policy,
  children,
}: {
  policy: SecretPolicy | null;
  children: ReactNode;
}) {
  return <SecretPolicyContext value={policy}>{children}</SecretPolicyContext>;
}

export function useSecretPolicy(): SecretPolicy | null {
  return use(SecretPolicyContext);
}

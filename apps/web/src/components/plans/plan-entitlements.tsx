'use client';

import { createContext, use, useCallback, useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import type { LimitedResource, PlanFeatures } from '@xecret/core/entitlements';

import { apiPath, appPath } from '@/app/(dashboard)/_lib/paths';
import { useApiResource } from '@/app/(dashboard)/_lib/use-api-resource';
import { controlPlaneBlock, featureBlock, limitBlock, organizationCreateBlock } from './plan-gate';
import type { EntitlementsResponse, OrgEntitlements, PlanBlock } from './plan-gate';

/**
 * The organisation's plan, read once by the dashboard shell and shared from
 * here with every lock below it.
 *
 * ── One request per organisation, and never on a timer ──
 * The shell mounts this for the organisation it is describing, so the answer is
 * read when that changes and not on every navigation between its pages. It is
 * read again only when something says it may have moved:
 *
 *  - a screen that creates or deletes something the answer counts (a project,
 *    a token, a webhook, an invitation) calls `refresh` once it has;
 *  - a locked control that is pressed calls `recheck`, so a lock that has gone
 *    stale (a plan bought in another tab, a project deleted by a colleague)
 *    lets the press through rather than explaining a limit that is gone;
 *  - the window coming back into focus, at most once a minute
 *    (`FOCUS_RECHECK_MS`), for the same tab left open across a purchase.
 *
 * Nothing asks on a timer. The database the API reads is on a plan where a
 * poll from every open tab would be the largest load the product put on it.
 *
 * ── A convenience, never an authority ──
 * Like the session's `authority`, this decides which controls are drawn
 * locked. It never decides what is allowed: every write past a ceiling is still
 * refused by the server. Until the answer arrives, and if it cannot be read,
 * nothing is locked, which is the direction to be wrong in: the worst case is a
 * button that answers with a refusal, as every button did before.
 */
export interface PlanView {
  /** `null` until the first answer, and whenever it could not be read. */
  entitlements: OrgEntitlements | null;
  /** Whether the viewer is an owner, who may buy a plan (`billing.manage`). */
  owner: boolean;
  /** The organisation's plans page, where an owner upgrades. */
  plansHref: string;
  /** Re-reads the answer, after a change to something it counts. */
  refresh: () => void;
  /**
   * Re-reads the answer and resolves once it is in state: what a locked
   * control asks when it is pressed, before it explains itself.
   */
  recheck: () => Promise<void>;
}

/** The least time between two reads the window regaining focus may cause. */
export const FOCUS_RECHECK_MS = 60_000;

/**
 * Whether the window coming back into view re-reads the plan: only when it is
 * visible, and only once a minute at most however often focus comes and goes.
 */
export function rechecksOnFocus(lastReadAt: number, now: number, hidden: boolean): boolean {
  return !hidden && now - lastReadAt >= FOCUS_RECHECK_MS;
}

const PlanContext = createContext<PlanView | null>(null);

/**
 * Shares a plan view with the locks below it. Used by the shell, through
 * `PlanEntitlementsProvider`, and by render tests, which hand it a fixed one.
 */
export function PlanViewProvider({ value, children }: { value: PlanView; children: ReactNode }) {
  return <PlanContext value={value}>{children}</PlanContext>;
}

/** Reads the organisation's entitlements and shares them. Mounted by the dashboard shell. */
export function PlanEntitlementsProvider({
  orgId,
  owner,
  children,
}: {
  /**
   * The id of the organisation the shell describes, or `null` where it
   * describes none, which reads nothing.
   */
  orgId: string | null;
  owner: boolean;
  children: ReactNode;
}) {
  const resource = useApiResource<EntitlementsResponse>(
    orgId === null ? null : apiPath.entitlements(orgId),
  );
  const reload = resource.reload;
  const refresh = useCallback(() => {
    void reload();
  }, [reload]);
  const recheck = useCallback(() => reload(), [reload]);
  const entitlements = resource.data?.entitlements ?? null;

  // When the answer was last read, for the focus re-read's once-a-minute rule.
  // Moved by every answer, whatever asked for it.
  const readAt = useRef(0);
  useEffect(() => {
    if (entitlements !== null) readAt.current = Date.now();
  }, [entitlements]);

  useEffect(() => {
    if (orgId === null) return;
    const onFocus = () => {
      const now = Date.now();
      if (!rechecksOnFocus(readAt.current, now, document.visibilityState === 'hidden')) return;
      readAt.current = now;
      void reload();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [orgId, reload]);

  const value = useMemo<PlanView>(
    () => ({
      entitlements,
      owner,
      plansHref: orgId === null ? '/pricing' : appPath.orgPlans(orgId),
      refresh,
      recheck,
    }),
    [entitlements, owner, orgId, refresh, recheck],
  );

  return <PlanViewProvider value={value}>{children}</PlanViewProvider>;
}

/**
 * The plan view, or `null` outside the shell. A lock with no view behind it
 * draws nothing, so a component rendered anywhere else behaves as it always
 * did.
 */
export function usePlanView(): PlanView | null {
  return use(PlanContext);
}

/**
 * The lock on adding `adding` more `resource` to `current`, or `null` when it
 * fits or nothing is known yet. `current` comes from the screen when the
 * ceiling is counted within something the screen lists (environments in a
 * project, secrets in an environment), and from `useOrgUsage` otherwise.
 */
export function usePlanLimit(
  resource: LimitedResource,
  current: number | null,
  adding = 1,
): PlanBlock | null {
  const view = usePlanView();
  if (view?.entitlements == null || current === null) return null;
  return limitBlock(view.entitlements, resource, current, adding);
}

/** The lock on a capability the plan may not include, or `null`. */
export function usePlanFeature(feature: keyof PlanFeatures): PlanBlock | null {
  const view = usePlanView();
  if (view?.entitlements == null) return null;
  return featureBlock(view.entitlements, feature);
}

/** The lock on every write while the organisation's control plane is closed, or `null`. */
export function useControlPlaneLock(): PlanBlock | null {
  const view = usePlanView();
  if (view?.entitlements == null) return null;
  return controlPlaneBlock(view.entitlements);
}

/** The lock on creating another organisation from this account, or `null`. */
export function useOrganizationCreateLock(): PlanBlock | null {
  const view = usePlanView();
  if (view?.entitlements == null) return null;
  return organizationCreateBlock(view.entitlements);
}

/** What the organisation holds of each organisation-wide ceiling, or `null`. */
export function useOrgUsage(): OrgEntitlements['usage'] | null {
  return usePlanView()?.entitlements?.usage ?? null;
}

/** Re-reads the plan after a change it counts. A no-op outside the shell. */
export function useRefreshPlan(): () => void {
  const view = usePlanView();
  return view?.refresh ?? noop;
}

function noop(): void {}

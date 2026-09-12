'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '@/lib/api';
import { PageHeader } from '@/components/layout';
import { Button, SettingsIcon } from '@/components/ui';
import {
  EnvKeyUnavailableState,
  NeedsRotationBanner,
  PendingSharesBanner,
  RotationDialog,
  useEnvironmentKeys,
} from '@/components/envkeys';
import { EnvironmentBadge } from '@/components/projects/environment-badge';
import { EnvironmentSwitcher } from '@/components/projects/environment-switcher';
import type { ProjectResponse } from '@/components/projects/types';
import { ExportDialog } from '@/components/secrets/export-dialog';
import { ImportDialog } from '@/components/secrets/import-dialog';
import { SecretTable, SecretTableSkeleton } from '@/components/secrets/secret-table';
import type { SecretListResponse, SecretSummary } from '@/components/secrets/types';
import { apiPath, appPath, withQuery } from '../_lib/paths';
import { useApiResource } from '../_lib/use-api-resource';
import { ErrorState } from './resource-states';
import { isOrgAdmin, useOrganization } from './session';

/** The API clamps `limit` to 200. Most environments arrive in one request. */
const PAGE_SIZE = 200;

export function EnvironmentScreen({
  orgSlug,
  projectSlug,
  envSlug,
}: {
  orgSlug: string;
  projectSlug: string;
  envSlug: string;
}) {
  // One request answers two questions: what this environment is, and what its
  // siblings are for the switcher. Asking `…/environments/{envSlug}` instead
  // would give a secret count this screen can already see, and would still need
  // a second call to populate the switcher.
  const project = useApiResource<ProjectResponse>(apiPath.project(orgSlug, projectSlug));
  const environment = project.data?.environments.find((entry) => entry.slug === envSlug);

  const secrets = useSecretList(orgSlug, projectSlug, envSlug);

  const organization = useOrganization(orgSlug);

  /**
   * This environment's key state, and the IO that follows from it.
   *
   * Read here rather than inside the table because three different things need
   * it: the table (to read and write values), the banners above it (to say why
   * it cannot), and the rotation dialog. Fetching it in each would give them
   * three answers that can disagree about whether a rotation has landed.
   */
  const keys = useEnvironmentKeys({
    orgSlug,
    orgId: organization?.id ?? null,
    projectSlug,
    envSlug,
  });

  const [rotating, setRotating] = useState(false);

  const io = keys.state.status === 'open' || keys.state.status === 'server' ? keys.state.io : null;
  const material = keys.state.status === 'open' ? keys.state.material : null;
  const keyState =
    keys.state.status === 'open' || keys.state.status === 'server' ? keys.state.keys : null;
  // Admins only: `pendingGrants` is `null` for a caller who may not see who is
  // waiting, which is the same answer as "nobody is".
  const pendingCount = keyState?.pendingGrants?.length ?? 0;

  /**
   * Whether to offer the rotation button.
   *
   * The coarse half of the answer, and deliberately so: rotation is
   * `environment.update`, which a per-project grant can also confer, and only
   * the server knows those. Showing the button to somebody the server will
   * refuse is a worse failure than hiding it from somebody who could — the
   * dialog reads the recipient list first and would fail there instead, after
   * they had read the whole ceremony.
   */
  const canRotate = organization !== null && isOrgAdmin(organization.role);

  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);

  /**
   * How many times something outside the table has written to this environment.
   *
   * The import dialog lives here rather than in the table, and it can overwrite
   * existing values. The table needs to hear about that: see `externalWrites` on
   * `SecretTable` for what a write it cannot see does to the values it is
   * holding decrypted.
   */
  const [externalWrites, setExternalWrites] = useState(0);

  /**
   * The environments shift-clicked in the switcher, shown beside this one's
   * values.
   *
   * Held by slug rather than by object, so it survives the project reloading
   * underneath it, and reset on every change of environment: "compare dev with
   * staging" does not mean "compare production with staging" once you have
   * navigated to production, and silently carrying the set across would put
   * staging's values on production's page without anybody asking.
   */
  const [compared, setCompared] = useState<readonly string[]>([]);
  const [comparedFor, setComparedFor] = useState(envSlug);
  if (comparedFor !== envSlug) {
    setComparedFor(envSlug);
    if (compared.length > 0) setCompared([]);
  }

  const comparedSet = useMemo(() => new Set(compared), [compared]);

  // Ordered by the project's own `sort_order` rather than by the order they
  // were clicked, so dev sits above staging sits above production however the
  // comparison was assembled.
  const comparedEnvironments = useMemo(
    () => (project.data?.environments ?? []).filter((entry) => comparedSet.has(entry.slug)),
    [project.data, comparedSet],
  );

  function toggleCompared(slug: string) {
    setCompared((current) =>
      current.includes(slug) ? current.filter((entry) => entry !== slug) : [...current, slug],
    );
  }

  const isProduction = environment?.isProduction ?? false;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={environment?.name ?? envSlug}
        // The slug and the display name differ by more than case for most
        // environments, so the heading waits for the project rather than
        // rewriting itself a beat later. The badge waits with it: `isProduction`
        // is false until the same request lands.
        titleLoading={project.data === null && project.error === null}
        badge={<EnvironmentBadge isProduction={isProduction} />}
        description={
          isProduction
            ? 'Production is deny-by-default: only admins and members with an explicit grant can read these values.'
            : 'Values are masked until you reveal them, and every reveal is recorded in the audit log.'
        }
        actions={
          <>
            {project.data !== null && project.data.environments.length > 1 ? (
              // Capsules rather than a dropdown. Comparing a value across
              // environments is the most repeated act on this screen, and a
              // dropdown costs two clicks and hides its options until the first.
              <EnvironmentSwitcher
                environments={project.data.environments}
                currentSlug={envSlug}
                href={(slug) => appPath.environment(orgSlug, projectSlug, slug)}
                onCompare={toggleCompared}
                comparing={comparedSet}
              />
            ) : null}

            {/* Import and export moved into the table's own toolbar, beside the
                controls that also act on this environment's secrets. What is
                left here acts on the *environment*, which is what the page
                heading is about. */}
            <Button variant="ghost" size="icon" asChild>
              <Link
                href={appPath.environmentSettings(orgSlug, projectSlug, envSlug)}
                aria-label={`Settings for ${environment?.name ?? envSlug}`}
              >
                <SettingsIcon className="size-4" />
              </Link>
            </Button>
          </>
        }
      />

      {/* The key banners sit above the table rather than replacing it: the
          names are plaintext in both modes, so a person waiting for a key share
          should still see what they are waiting for. */}
      {keyState?.needsRotation === true ? (
        <NeedsRotationBanner canRotate={canRotate} onRotate={() => setRotating(true)} />
      ) : null}

      {material !== null && pendingCount > 0 ? (
        <PendingSharesBanner
          target={{ orgSlug, projectSlug, envSlug }}
          material={material}
          pendingCount={pendingCount}
          onShared={keys.reload}
        />
      ) : null}

      {keys.state.status === 'unavailable' ? (
        <EnvKeyUnavailableState
          reason={keys.state.reason}
          onRetry={keys.reload}
          target={{ orgSlug, environmentId: keys.state.keys.environmentId }}
        />
      ) : null}

      {project.error !== null ? (
        <ErrorState subject="this project" error={project.error} onRetry={project.reload} />
      ) : secrets.error !== null ? (
        <ErrorState subject="this environment" error={secrets.error} onRetry={secrets.reload} />
      ) : secrets.data === null ? (
        <SecretTableSkeleton />
      ) : (
        <SecretTable
          orgSlug={orgSlug}
          orgId={organization?.id ?? ''}
          projectSlug={projectSlug}
          envSlug={envSlug}
          isProduction={isProduction}
          io={io}
          // Empty until the project resolves. The table reads these only for
          // `isProduction` — which decides what gets confirmed — so an empty list
          // is the safe premise to start from.
          environments={project.data?.environments ?? []}
          comparedEnvironments={comparedEnvironments}
          onStopComparing={() => setCompared([])}
          externalWrites={externalWrites}
          secrets={secrets.data}
          onLoadMore={secrets.loadMore}
          loadingMore={secrets.loadingMore}
          loadMoreError={secrets.loadMoreError}
          onChanged={secrets.reload}
          onImport={() => setImporting(true)}
          onExport={() => setExporting(true)}
        />
      )}

      <ImportDialog
        orgSlug={orgSlug}
        projectSlug={projectSlug}
        envSlug={envSlug}
        isProduction={isProduction}
        io={io}
        open={importing}
        onOpenChange={setImporting}
        onImported={() => {
          setExternalWrites((current) => current + 1);
          secrets.reload();
        }}
      />

      <ExportDialog
        orgSlug={orgSlug}
        projectSlug={projectSlug}
        envSlug={envSlug}
        isProduction={isProduction}
        io={io}
        open={exporting}
        onOpenChange={setExporting}
      />

      {material !== null ? (
        <RotationDialog
          target={{ orgSlug, projectSlug, envSlug }}
          material={material}
          environmentName={environment?.name ?? envSlug}
          isProduction={isProduction}
          open={rotating}
          onOpenChange={setRotating}
          // Re-reads the key state, which opens the new grant through the
          // ordinary path. The table's decrypted snapshot goes with it: every
          // value it holds was opened under the key that has just been retired.
          onRotated={() => {
            keys.reload();
            setExternalWrites((current) => current + 1);
          }}
        />
      ) : null}
    </div>
  );
}

interface SecretList {
  data: readonly SecretSummary[] | null;
  error: unknown;
  loadingMore: boolean;
  /**
   * Why the last "next page" failed, or `null`.
   *
   * Separate from `error`, which replaces the whole table with a retry state.
   * That is right for a first page nobody could read and wrong for a second: the
   * rows already on screen are still good, and losing them — along with every
   * staged change the table was holding — over a transient 429 on page two is a
   * far worse failure than the missing rows. The table reports this one beside
   * the sentinel instead, and stops asking until somebody presses Retry.
   */
  loadMoreError: unknown;
  /** `null` once every page has been read. */
  loadMore: (() => void) | null;
  reload: () => void;
}

/**
 * The masked listing, one page at a time.
 *
 * Pages accumulate rather than replace, because the table filters and sorts what
 * it has been given: paging in place would make "sort by name" mean "sort this
 * page by name", which is a different and much less useful promise.
 *
 * `nextCursor` is treated as opaque, exactly as §5 of the contract requires. It
 * happens to be a page number today; a client that did arithmetic on it would
 * break the day the listing becomes a true keyset cursor, which the audit log
 * has already had to do.
 */
interface SecretListState {
  /** The environment this page set belongs to. `null` before the first response. */
  path: string | null;
  items: readonly SecretSummary[] | null;
  cursor: string | null;
  error: unknown;
  /** From the last `loadMore`; see `SecretList.loadMoreError`. */
  loadMoreError: unknown;
}

function useSecretList(orgSlug: string, projectSlug: string, envSlug: string): SecretList {
  const [state, setState] = useState<SecretListState>({
    path: null,
    items: null,
    cursor: null,
    error: null,
    loadMoreError: null,
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const path = apiPath.secrets(orgSlug, projectSlug, envSlug);

  useEffect(() => {
    const controller = new AbortController();

    // No state is cleared here: writing to state synchronously inside an effect
    // cascades a render, and the outcome already carries the environment it
    // describes, so a result for a different one is discarded below rather than
    // shown for a frame under the wrong heading.
    api
      .get<SecretListResponse>(withQuery(path, { limit: PAGE_SIZE }), {
        signal: controller.signal,
      })
      .then((response) => {
        if (controller.signal.aborted) return;
        setState({
          path,
          items: response.data,
          cursor: response.nextCursor,
          error: null,
          loadMoreError: null,
        });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setState({ path, items: null, cursor: null, error: cause, loadMoreError: null });
      });

    return () => controller.abort();
  }, [path, attempt]);

  const describesCurrentEnvironment = state.path === path;
  const cursor = describesCurrentEnvironment ? state.cursor : null;

  const loadMore = useCallback(() => {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);

    api
      .get<SecretListResponse>(withQuery(path, { limit: PAGE_SIZE, cursor }))
      .then((response) => {
        setState((current) =>
          // Guarded: the user can navigate to another environment while a page
          // is in flight, and appending to that one's list would show rows that
          // belong somewhere else.
          current.path === path
            ? {
                path,
                items: [...(current.items ?? []), ...response.data],
                cursor: response.nextCursor,
                error: null,
                loadMoreError: null,
              }
            : current,
        );
        setLoadingMore(false);
      })
      .catch((cause: unknown) => {
        // Reported beside the sentinel rather than as this screen's `error`,
        // which would replace the table — and every staged change in it — with
        // a retry state over a transient failure on page two. The cursor is
        // kept, so the offer of more survives; what stops is the table asking
        // for it on its own. See `SecretList.loadMoreError`.
        setState((current) =>
          current.path === path ? { ...current, loadMoreError: cause } : current,
        );
        setLoadingMore(false);
      });
  }, [path, cursor, loadingMore]);

  return {
    data: describesCurrentEnvironment ? state.items : null,
    error: describesCurrentEnvironment ? state.error : null,
    loadMoreError: describesCurrentEnvironment ? state.loadMoreError : null,
    loadingMore,
    loadMore: cursor === null ? null : loadMore,
    reload: useCallback(() => setAttempt((current) => current + 1), []),
  };
}

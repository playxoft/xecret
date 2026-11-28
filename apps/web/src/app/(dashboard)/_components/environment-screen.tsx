'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '@/lib/api';
import { pluralize } from '@/lib/format';
import { PageHeader } from '@/components/layout';
import {
  Badge,
  Button,
  ChevronDownIcon,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  HistoryIcon,
  LayersIcon,
  SettingsIcon,
  UserIcon,
} from '@/components/ui';
import { PromoteDialog } from '@/components/changes/promote-dialog';
import { RestorePointDialog } from '@/components/changes/restore-point-dialog';
import {
  EncryptionUpgradePanel,
  EnvKeyUnavailableState,
  NeedsRotationBanner,
  PendingSharesBanner,
  RotationDialog,
  useEnvironmentKeys,
} from '@/components/envkeys';
import { OverridesCard } from '@/components/overrides/overrides-card';
import { secretPolicyFrom } from '@/components/policies/policy-checks';
import { SecretPolicyProvider, useOrgPolicies } from '@/components/policies/secret-policy-context';
import { EnvironmentBadge } from '@/components/projects/environment-badge';
import { EnvironmentSwitcher } from '@/components/projects/environment-switcher';
import type { ProjectResponse } from '@/components/projects/types';
import { ExportDialog } from '@/components/secrets/export-dialog';
import { ImportDialog } from '@/components/secrets/import-dialog';
import { SecretTable, SecretTableSkeleton } from '@/components/secrets/secret-table';
import type { SecretListResponse, SecretSummary } from '@/components/secrets/types';
import { useOpenedNotes } from '@/components/secrets/use-opened-notes';
import { apiPath, appPath, withQuery } from '../_lib/paths';
import { listingAfterFailure } from '../_lib/secret-listing';
import type { SecretListState } from '../_lib/secret-listing';
import { useApiResource } from '../_lib/use-api-resource';
import { ErrorState } from './resource-states';
import { canAdminister, useOrganization } from './session';

/** The API clamps `limit` to 200. Most environments arrive in one request. */
const PAGE_SIZE = 200;

export function EnvironmentScreen({
  orgId,
  projectId,
  envSlug,
}: {
  orgId: string;
  projectId: string;
  envSlug: string;
}) {
  // One request answers two questions: what this environment is, and what its
  // siblings are for the switcher. Asking `…/environments/{envSlug}` instead
  // would give a secret count this screen can already see, and would still need
  // a second call to populate the switcher.
  const project = useApiResource<ProjectResponse>(apiPath.project(orgId, projectId));
  const environment = project.data?.environments.find((entry) => entry.slug === envSlug);

  const secrets = useSecretList(orgId, projectId, envSlug);

  const organization = useOrganization(orgId);

  /**
   * This environment's key state, and the IO that follows from it.
   *
   * Read here rather than inside the table because three different things need
   * it: the table (to read and write values), the banners above it (to say why
   * it cannot), and the rotation dialog. Fetching it in each would give them
   * three answers that can disagree about whether a rotation has landed.
   */
  const keys = useEnvironmentKeys({
    orgId,
    projectId,
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
   * The listing the table renders: the masked one, with each note readable.
   *
   * In an end-to-end encrypted environment a note arrives only as `encNote`,
   * and the table reads `note` — so this is the step that makes a saved note
   * show up as saved. See `use-opened-notes.ts`.
   */
  const { secrets: listing, remember: rememberNotes } = useOpenedNotes(secrets.data, io);

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
  const canRotate = canAdminister(organization, 'environment.update');

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
   * The environments chosen in the switcher's Compare menu, shown beside this
   * one's values.
   *
   * Held by slug rather than by object, so it survives the project reloading
   * underneath it, and reset on every change of environment: "compare dev with
   * staging" does not mean "compare production with staging" once you have
   * navigated to production, and silently carrying the set across would put
   * staging's values on production's page without anybody asking.
   */
  const [compared, setCompared] = useState<readonly string[]>([]);
  const [comparedFor, setComparedFor] = useState(envSlug);
  /**
   * How many compared cells hold a value typed and not yet saved, as the table
   * — which owns those editors — reports it.
   */
  const [unsavedCompared, setUnsavedCompared] = useState(0);
  /**
   * A removal held while the discard is confirmed: the comparison it would
   * leave, and the names of what it closes — taken when it was asked, so the
   * question does not reword itself under the reader.
   */
  const [pendingCompared, setPendingCompared] = useState<{
    next: readonly string[];
    closing: string;
  } | null>(null);
  /**
   * The personal-override dialog's name — `''` for a new one — or `null`.
   *
   * Held here because the "My overrides" card is drawn only once there is an
   * override to show, so the first one is set from this screen's menu; the
   * card's own buttons open the same dialog through the same state. Closed on a
   * change of environment with the rest, so a value typed for staging can never
   * be saved as production's.
   */
  const [overrideFor, setOverrideFor] = useState<string | null>(null);
  if (comparedFor !== envSlug) {
    setComparedFor(envSlug);
    if (compared.length > 0) setCompared([]);
    if (pendingCompared !== null) setPendingCompared(null);
    if (overrideFor !== null) setOverrideFor(null);
  }

  const comparedSet = useMemo(() => new Set(compared), [compared]);

  // Ordered by the project's own `sort_order` rather than by the order they
  // were clicked, so dev sits above staging sits above production however the
  // comparison was assembled.
  const comparedEnvironments = useMemo(
    () => (project.data?.environments ?? []).filter((entry) => comparedSet.has(entry.slug)),
    [project.data, comparedSet],
  );

  /**
   * Every change the switcher makes to the comparison, asked first when it
   * takes an environment *off* while a compared cell holds unsaved work.
   *
   * Closing an environment unmounts its cells, and a credential typed into one
   * and not yet saved goes with them. It can take more than its own column:
   * a row for a key only that environment holds goes too, with whatever was
   * typed into this environment's cell in it. Which rows those are is the
   * table's business, so any unsaved compared cell is reason enough to ask —
   * the table's own "Show only …" button asks on the same rule. Adding an
   * environment unmounts nothing, and never asks.
   */
  function changeCompared(next: readonly string[]) {
    const drops = compared.some((slug) => !next.includes(slug));
    if (drops && unsavedCompared > 0) {
      const closing = comparedEnvironments
        .filter((entry) => !next.includes(entry.slug))
        .map((entry) => entry.name)
        .join(' and ');
      setPendingCompared({ next, closing });
      return;
    }
    setCompared(next);
  }

  function toggleCompared(slug: string) {
    changeCompared(
      compared.includes(slug) ? compared.filter((entry) => entry !== slug) : [...compared, slug],
    );
  }

  const isProduction = environment?.isProduction ?? false;

  /**
   * The organisation's secret policy (P19 §8), read once for the whole screen.
   *
   * Every editor below — a stored row, a new row, a compared cell, the import
   * — asks it before it encrypts, so it is read here and handed down rather
   * than fetched per row. Until it lands, or when it cannot be read, a write
   * that carries a value is refused saying so (review round 1, M5): the value
   * rules live only in the clients, and saving without them is skipping them.
   * A rename or a note still saves — the server asks the name rule itself.
   */
  const policies = useOrgPolicies(orgId);
  const secretPolicy = secretPolicyFrom(policies);

  /**
   * What this environment inherits from (P19 §1), by name where the listing has
   * it. The table below shows this environment's *own* values — an inherited
   * one belongs to the parent and is edited there — so the heading is where a
   * reader learns that `xecret run` will hand their process more than the rows
   * on this page.
   */
  const parentSlug = environment?.parent ?? null;
  const parentEnvironment =
    parentSlug === null
      ? undefined
      : project.data?.environments.find((entry) => entry.slug === parentSlug);

  const [promoting, setPromoting] = useState(false);
  const [restoringPoint, setRestoringPoint] = useState(false);
  /** The key state's own facts, in every state that has them — an unavailable one included. */
  const keyFacts =
    keys.state.status === 'open' ||
    keys.state.status === 'server' ||
    keys.state.status === 'unavailable'
      ? keys.state.keys
      : null;
  /**
   * Promotion and point-in-time restore are re-encryptions performed here, in
   * this browser, under this environment's key — so they are offered exactly
   * when that key is open. Who may *apply* them is the server's to decide.
   */
  const canChangeInBulk = material !== null && organization !== null;

  /**
   * Offered in every end-to-end encrypted environment — the only kind an
   * override exists for. The plan, the vault and the key state are the
   * dialog's to explain, so somebody who cannot set one yet finds out why
   * rather than finding nothing.
   */
  const offersOverride = keyFacts?.encryptionMode === 'e2ee';

  /** A write this table did not make — see `externalWrites`. */
  function wroteElsewhere() {
    setExternalWrites((current) => current + 1);
    secrets.reload();
  }

  return (
    <SecretPolicyProvider policy={secretPolicy}>
      <div className="flex flex-col gap-6">
        <PageHeader
          title={environment?.name ?? envSlug}
          // The slug and the display name differ by more than case for most
          // environments, so the heading waits for the project rather than
          // rewriting itself a beat later. The badge waits with it: `isProduction`
          // is false until the same request lands.
          titleLoading={project.data === null && project.error === null}
          badge={
            <>
              <EnvironmentBadge isProduction={isProduction} />
              {parentSlug !== null ? (
                <Link
                  href={appPath.environment(orgId, projectId, parentSlug)}
                  title={`${environment?.name ?? envSlug} inherits every value it does not set itself from ${parentEnvironment?.name ?? parentSlug}. xecret run resolves the chain; this page lists only this environment's own values.`}
                  className="rounded-full"
                >
                  <Badge tone="accent">
                    <LayersIcon aria-hidden="true" className="size-3.5" />
                    Inherits from {parentEnvironment?.name ?? parentSlug}
                  </Badge>
                </Link>
              ) : null}
            </>
          }
          description={
            <>
              {isProduction
                ? 'Production is deny-by-default: only admins and members with an explicit grant can read these values.'
                : 'Values are masked until you reveal them, and every reveal is recorded in the audit log.'}
              {parentSlug !== null
                ? ` It inherits from ${parentEnvironment?.name ?? parentSlug}: the rows below are its own values, and anything it does not set comes from there when it is read.`
                : ''}
            </>
          }
          actions={
            <>
              {canChangeInBulk || offersOverride ? (
                // Two acts on the whole environment, behind one control: both
                // rewrite many secrets at once, both preview before they write,
                // and neither is something a person reaches for every day. And
                // one act on nobody's values but yours, set apart beneath them.
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="secondary" size="sm">
                      <HistoryIcon className="size-4" />
                      Changes
                      <ChevronDownIcon aria-hidden="true" className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    {canChangeInBulk ? (
                      <>
                        <DropdownMenuItem onSelect={() => setPromoting(true)}>
                          <LayersIcon className="size-4" />
                          Promote from another environment…
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setRestoringPoint(true)}>
                          <HistoryIcon className="size-4" />
                          Restore to a point in time…
                        </DropdownMenuItem>
                      </>
                    ) : null}
                    {/* Where the first override is set, now that the card it
                        used to be set from is drawn only once one exists.
                        Labelled, because everything above it changes what the
                        whole team reads and this changes what nobody else does. */}
                    {offersOverride ? (
                      <>
                        {canChangeInBulk ? <DropdownMenuSeparator /> : null}
                        <DropdownMenuLabel>Only for you</DropdownMenuLabel>
                        <DropdownMenuItem onSelect={() => setOverrideFor('')}>
                          <UserIcon className="size-4" />
                          Set a personal override…
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}

              {/* Import and export moved into the table's own toolbar, beside the
                controls that also act on this environment's secrets. What is
                left here acts on the *environment*, which is what the page
                heading is about. */}
              <Button variant="ghost" size="icon" asChild>
                <Link
                  href={appPath.environmentSettings(orgId, projectId, envSlug)}
                  aria-label={`Settings for ${environment?.name ?? envSlug}`}
                >
                  <SettingsIcon className="size-4" />
                </Link>
              </Button>
            </>
          }
        />

        {project.data !== null && project.data.environments.length > 1 ? (
          // Capsules rather than a dropdown. Comparing a value across
          // environments is the most repeated act on this screen, and a
          // dropdown costs two clicks and hides its options until the first.
          //
          // A strip of its own under the heading rather than a cluster in its
          // actions: while a comparison is open it says which environment is
          // on screen and which are beside it, in words, and that sentence
          // needs room the header's action cluster, sharing a line with the
          // title, does not have. Only as wide as its contents, though — see
          // "Compact" in the switcher.
          <EnvironmentSwitcher
            environments={project.data.environments}
            currentSlug={envSlug}
            href={(slug) => appPath.environment(orgId, projectId, slug)}
            onCompare={toggleCompared}
            comparing={comparedSet}
            onStopComparing={() => changeCompared([])}
          />
        ) : null}

        {/* The key banners sit above the table rather than replacing it: the
          names are plaintext in both modes, so a person waiting for a key share
          should still see what they are waiting for. */}
        {keyState?.needsRotation === true ? (
          <NeedsRotationBanner canRotate={canRotate} onRotate={() => setRotating(true)} />
        ) : null}

        {material !== null && pendingCount > 0 ? (
          <PendingSharesBanner
            target={{ orgId, projectId, envSlug }}
            material={material}
            pendingCount={pendingCount}
            onShared={keys.reload}
          />
        ) : null}

        {/* A `server`-mode environment, to somebody who may manage it: what the
          server can read here, and the upgrade — run without asking when the
          environment is empty (see `encryption-upgrade-panel.tsx`). After it
          lands, the key state is re-read and the listing with it, so the table
          switches to the end-to-end encrypted IO and the notes it now opens. */}
        {keys.state.status === 'server' ? (
          <EncryptionUpgradePanel
            target={{ orgId, projectId, envSlug }}
            environmentName={environment?.name ?? envSlug}
            isProduction={isProduction}
            canManage={canRotate}
            placement="banner"
            onUpgraded={() => {
              keys.reload();
              secrets.reload();
            }}
          />
        ) : null}

        {keys.state.status === 'unavailable' ? (
          <EnvKeyUnavailableState
            reason={keys.state.reason}
            onRetry={keys.reload}
            target={{ orgId, environmentId: keys.state.keys.environmentId }}
          />
        ) : null}

        {project.error !== null ? (
          <ErrorState subject="this project" error={project.error} onRetry={project.reload} />
        ) : secrets.error !== null ? (
          <ErrorState subject="this environment" error={secrets.error} onRetry={secrets.reload} />
        ) : listing === null ? (
          <SecretTableSkeleton />
        ) : (
          <SecretTable
            orgId={orgId}
            projectId={projectId}
            envSlug={envSlug}
            isProduction={isProduction}
            io={io}
            // Empty until the project resolves. The table reads these only for
            // `isProduction` — which decides what gets confirmed — so an empty list
            // is the safe premise to start from.
            environments={project.data?.environments ?? []}
            comparedEnvironments={comparedEnvironments}
            // Already asked: the table's own button confirms before it calls this.
            onStopComparing={() => setCompared([])}
            onComparedUnsavedChange={setUnsavedCompared}
            externalWrites={externalWrites}
            secrets={listing}
            onLoadMore={secrets.loadMore}
            loadingMore={secrets.loadingMore}
            loadMoreError={secrets.loadMoreError}
            onChanged={secrets.reload}
            onNotesWritten={rememberNotes}
            onImport={() => setImporting(true)}
            onExport={() => setExporting(true)}
          />
        )}

        <ImportDialog
          orgId={orgId}
          projectId={projectId}
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
          orgId={orgId}
          projectId={projectId}
          projectSlug={project.data?.project.slug ?? null}
          envSlug={envSlug}
          isProduction={isProduction}
          io={io}
          // P19 §9: refused before anything is pulled where the policy says so,
          // and told what a download from here leaves out (P19 §1).
          plaintextExport={environment?.plaintextExport ?? 'allowed'}
          inheritsFrom={parentSlug}
          templateCount={
            secrets.data?.filter((secret) => secret.valueType === 'template').length ?? 0
          }
          open={exporting}
          onOpenChange={setExporting}
        />

        {/* The switcher's way out of a comparison, when it would discard a
          value typed into a compared cell — the same question the table's own
          "Show only …" asks, raised here because the switcher is not inside
          the table. */}
        {pendingCompared !== null ? (
          <ConfirmDialog
            open
            onOpenChange={(open) => (open ? undefined : setPendingCompared(null))}
            title={`Stop comparing with ${pendingCompared.closing}?`}
            description={`${pluralize(unsavedCompared, 'value')} you have not saved ${
              unsavedCompared === 1 ? 'is' : 'are'
            } open in the compared cells, and closing ${pendingCompared.closing} can discard ${
              unsavedCompared === 1 ? 'it' : 'them'
            }. Save first to keep ${unsavedCompared === 1 ? 'it' : 'them'}.`}
            confirmLabel="Close anyway"
            cancelLabel="Keep comparing"
            onConfirm={() => {
              setCompared(pendingCompared.next);
              setPendingCompared(null);
            }}
          />
        ) : null}

        {/* The person's own values for this environment (P19 §2), below the
          shared ones: they change what one machine runs and nothing anybody
          else reads, so they come after the table everybody shares. Drawn
          only once there is one; the set dialog it owns is always mounted. */}
        <OverridesCard
          orgId={orgId}
          projectId={projectId}
          envSlug={envSlug}
          environmentId={keyFacts?.environmentId ?? null}
          encryptionMode={keyFacts?.encryptionMode ?? null}
          setting={overrideFor}
          onSettingChange={setOverrideFor}
        />

        {material !== null &&
        organization !== null &&
        environment !== undefined &&
        project.data !== null ? (
          <PromoteDialog
            orgId={orgId}
            projectId={projectId}
            target={environment}
            environments={project.data.environments}
            open={promoting}
            onOpenChange={setPromoting}
            onPromoted={wroteElsewhere}
          />
        ) : null}

        {material !== null && organization !== null ? (
          <RestorePointDialog
            orgId={orgId}
            projectId={projectId}
            envSlug={envSlug}
            environmentName={environment?.name ?? envSlug}
            isProduction={isProduction}
            material={material}
            open={restoringPoint}
            onOpenChange={setRestoringPoint}
            onRestored={wroteElsewhere}
          />
        ) : null}

        {material !== null ? (
          <RotationDialog
            target={{ orgId, projectId, envSlug }}
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
    </SecretPolicyProvider>
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
 *
 * The state's shape, and what a failed re-read does to rows already on screen,
 * live in `_lib/secret-listing.ts`.
 */
function useSecretList(orgId: string, projectId: string, envSlug: string): SecretList {
  const [state, setState] = useState<SecretListState>({
    path: null,
    items: null,
    cursor: null,
    error: null,
    loadMoreError: null,
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const path = apiPath.secrets(orgId, projectId, envSlug);

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
        // Not a plain replace: a re-read refused because the session locked
        // keeps the rows on screen, and the staged edits in the table with them.
        setState((current) => listingAfterFailure(current, path, cause));
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

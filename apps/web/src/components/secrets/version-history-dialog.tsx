'use client';

import { useEffect, useState } from 'react';

import { api, errorMessage, isApiError } from '@/lib/api';
import { formatAbsoluteTime, formatRelativeTime, toIsoString } from '@/lib/format';
import { apiPath, withQuery } from '@/app/(dashboard)/_lib/paths';
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Skeleton,
  useToast,
} from '@/components/ui';
import { Actor } from './actor';
import type { SecretRestoreResponse, SecretVersion, SecretVersionListResponse } from './types';

export interface VersionHistoryDialogProps {
  orgSlug: string;
  projectSlug: string;
  envSlug: string;
  isProduction: boolean;
  secretName: string;
  /**
   * Dismissal. There is no `open` prop: the caller mounts this only while the
   * drawer is showing, which is what gives each open a clean slate.
   */
  onOpenChange: (open: boolean) => void;
  onRestored: () => void;
}

/** One request is enough for any history a person will read in one sitting. */
const PAGE_SIZE = 100;

/**
 * A secret's history, as a drawer beside the table.
 *
 * ── Metadata only, and that is the feature ──
 * There is no value column here and there is no way to add one, because
 * `GET …/secrets/{name}/versions` selects no ciphertext at all. Rendering this
 * panel is therefore not a decryption opportunity even for someone who holds
 * every permission — which matters because a rotated secret is usually still
 * live: the gap between "rotated in xecret" and "revoked at the provider" is
 * measured in weeks for most teams. A history that returned old values would be
 * handing out working credentials through a screen everybody reasons about as an
 * archive.
 *
 * Recovering an old value therefore goes through Restore, which re-encrypts it
 * as a new current version and writes `secret.rotated` to the audit log. Reading
 * the past is always an act with a record.
 *
 * A drawer rather than a centred modal: the row it describes stays visible
 * behind it, which is what stops somebody restoring a version of the secret
 * above the one they meant.
 */
export function VersionHistoryDialog({
  orgSlug,
  projectSlug,
  envSlug,
  isProduction,
  secretName,
  onOpenChange,
  onRestored,
}: VersionHistoryDialogProps) {
  const { toast } = useToast();
  const [versions, setVersions] = useState<readonly SecretVersion[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [restoring, setRestoring] = useState<SecretVersion | null>(null);

  const path = withQuery(apiPath.secretVersions(orgSlug, projectSlug, envSlug, secretName), {
    limit: PAGE_SIZE,
  });

  // Nothing is written to state synchronously here: this component is mounted
  // only while the drawer is open — the caller unmounts it on close — so each
  // open already starts from the initial state, and every write below happens in
  // a promise callback rather than in the effect body.
  useEffect(() => {
    const controller = new AbortController();

    api
      .get<SecretVersionListResponse>(path, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        setVersions(response.data);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause);
      });

    return () => controller.abort();
  }, [path]);

  async function restore(version: SecretVersion) {
    const result = await api.post<SecretRestoreResponse>(
      apiPath.secretRestore(orgSlug, projectSlug, envSlug, secretName),
      { version: version.version },
    );

    toast(
      result.secret.status === 'unchanged'
        ? {
            variant: 'info',
            title: `${secretName} already holds that value`,
            description: `Version ${version.version} matches the current one, so no version was appended.`,
          }
        : {
            variant: 'success',
            title: `Restored ${secretName} to the value from version ${version.version}`,
            description: `It is now version ${result.secret.version}.`,
          },
    );

    setRestoring(null);
    onOpenChange(false);
    onRestored();
  }

  return (
    <>
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent
          // Anchored to the trailing edge and full height. The primitive is
          // centred by default, so every positioning utility here is an
          // override; `cn` resolves the conflicting pairs in this file's favour.
          className="top-0 right-0 bottom-0 left-auto h-dvh max-h-dvh w-full max-w-md translate-x-0 translate-y-0 rounded-none border-y-0 border-r-0 sm:max-w-lg"
        >
          <DialogHeader>
            <DialogTitle className="font-mono">{secretName}</DialogTitle>
            <DialogDescription>
              Every version ever written, newest first. Values are not shown here and are not
              available from this endpoint.
            </DialogDescription>
          </DialogHeader>

          <DialogBody>
            {error !== null ? (
              <Alert tone="danger" title="Could not load the history">
                <p>{errorMessage(error)}</p>
                {isApiError(error) && error.requestId ? (
                  <p className="mt-1.5 text-xs">
                    Request id: <code className="font-mono select-all">{error.requestId}</code>
                  </p>
                ) : null}
              </Alert>
            ) : versions === null ? (
              <div aria-busy="true" aria-label="Loading version history" className="space-y-3">
                {Array.from({ length: 4 }, (_, index) => (
                  <Skeleton key={index} className="h-14 w-full" />
                ))}
              </div>
            ) : versions.length === 0 ? (
              <p className="text-fg-muted text-sm">This secret has no recorded versions.</p>
            ) : (
              <ol className="flex flex-col gap-2">
                {versions.map((version) => (
                  <li
                    key={version.version}
                    className="border-line bg-canvas-inset flex items-start gap-3 rounded-lg border p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-fg font-mono text-sm font-medium">
                          v{version.version}
                        </span>
                        {version.current ? <Badge tone="accent">Current</Badge> : null}
                      </div>
                      <p className="text-fg-muted mt-1 text-[0.8125rem] leading-5">
                        <time
                          dateTime={toIsoString(version.createdAt)}
                          title={formatAbsoluteTime(version.createdAt)}
                        >
                          {formatRelativeTime(version.createdAt)}
                        </time>{' '}
                        by <Actor userId={version.createdBy} />
                      </p>
                      <p className="text-fg-subtle mt-0.5 font-mono text-xs">{version.algorithm}</p>
                    </div>

                    {version.current ? null : (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setRestoring(version)}
                        aria-label={`Restore ${secretName} to the value from version ${version.version}`}
                      >
                        Restore
                      </Button>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>

      {restoring !== null && isProduction ? (
        <ConfirmDialog
          strength="production"
          confirmPhrase={secretName}
          open
          onOpenChange={(next) => (next ? undefined : setRestoring(null))}
          title={`Restore ${secretName} to version ${restoring.version}?`}
          description="Whatever reads this secret in production will pick the old value up on its next deploy."
          confirmLabel="Restore this version"
          confirmVariant="primary"
          onConfirm={() => restore(restoring)}
        >
          <RestoreNote version={restoring.version} />
        </ConfirmDialog>
      ) : restoring !== null ? (
        <ConfirmDialog
          open
          onOpenChange={(next) => (next ? undefined : setRestoring(null))}
          title={`Restore ${secretName} to version ${restoring.version}?`}
          description="The current value stays in the history; this appends the old one as a new version."
          confirmLabel="Restore this version"
          confirmVariant="primary"
          onConfirm={() => restore(restoring)}
        >
          <RestoreNote version={restoring.version} />
        </ConfirmDialog>
      ) : null}
    </>
  );
}

function RestoreNote({ version }: { version: number }) {
  return (
    <Alert tone="info" title="History is never rewritten">
      Version {version} stays exactly where it is. Its value is decrypted and encrypted again as a
      new version, and the restore is written to the audit log.
    </Alert>
  );
}

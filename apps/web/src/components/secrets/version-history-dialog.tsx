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
  SecretValue,
  Skeleton,
  useToast,
} from '@/components/ui';
import { Actor } from './actor';
import type {
  RevealedSecretVersion,
  SecretRestoreResponse,
  SecretVersion,
  SecretVersionListResponse,
} from './types';

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
 * ── The listing is metadata only; a reveal is one version at a time ──
 * `GET …/secrets/{name}/versions` selects no ciphertext at all, and that has not
 * changed. It matters because a rotated secret is usually still live — the gap
 * between "rotated in xecret" and "revoked at the provider" is measured in weeks
 * for most teams — so a *listing* that carried values would hand out a page of
 * working credentials in one request, through a screen everybody reasons about
 * as an archive.
 *
 * The eye beside each row is a different act, and is built as one. It calls
 * `GET …/versions/{version}`, which decrypts exactly that version and writes a
 * `secret.revealed` record naming it. Reading the past therefore stays
 * deliberate, one version at a time, and always recorded — which is the property
 * the metadata-only listing was protecting, kept while offering the thing it
 * appeared to forbid.
 *
 * Restore is still how an old value is put *back*: it re-encrypts it as a new
 * current version and writes to the audit log.
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

  /**
   * Decrypts one historical version.
   *
   * Not memoised, and never cached after the first call. `SecretValue` invokes
   * it on every reveal and every copy, and each invocation must reach the
   * server — caching would make the audit trail claim one read of an old
   * production credential where the user performed six.
   */
  async function revealVersion(version: number): Promise<string> {
    const response = await api.get<RevealedSecretVersion>(
      apiPath.secretVersion(orgSlug, projectSlug, envSlug, secretName, version),
    );
    return response.secret.value;
  }

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
              Every version ever written, newest first. Revealing one decrypts that version and is
              recorded in the audit log — an old value often still works at the provider.
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
                    className="border-line bg-canvas-inset flex flex-col gap-2 rounded-lg border p-3"
                  >
                    <div className="flex items-start gap-3">
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
                          by{' '}
                          <Actor
                            userId={version.createdBy}
                            serviceTokenId={version.createdByServiceTokenId}
                          />
                        </p>
                        <p className="text-fg-subtle mt-0.5 font-mono text-xs">
                          {version.algorithm}
                        </p>
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
                    </div>

                    {/* The same masked field the table uses, and therefore the
                        same auto-hide, the same blur handling, and the same
                        copy-without-rendering. Its reveal targets *this*
                        version, so the audit record names the version rather
                        than saying only that the secret was read. */}
                    <SecretValue
                      name={`${secretName} version ${version.version}`}
                      onReveal={() => revealVersion(version.version)}
                    />
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

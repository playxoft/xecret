'use client';

import { useState } from 'react';

import { formatAbsoluteTime } from '@/lib/format';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
} from '@/components/ui';
import { useOrganization } from '@/app/(dashboard)/_components/session';
import { EnvKeyUnavailableState } from './env-key-notice';
import type { EnvironmentRef } from './env-keys';
import { PendingSharesBanner } from './pending-shares';
import { RotationDialog } from './rotation-dialog';
import { useEnvironmentKeys } from './use-environment-keys';

/**
 * The environment's key, on its settings page.
 *
 * ── Why rotation lives here as well as in the banner ──
 * The banner on the environment screen fires on `needsRotation` — after somebody
 * has lost access — and it is the case that matters most. But rotation is also a
 * routine hygiene act: a laptop was stolen, a contractor's engagement ended
 * without their account being removed yet, a quarter turned over. A control that
 * only appeared after a revocation would make the deliberate version of the same
 * act something an administrator had to manufacture a revocation to reach.
 *
 * ── What the card says when it cannot say much ──
 * A `server`-mode environment has no client key at all, and this renders the one
 * sentence that explains why the rest of the card is absent rather than an empty
 * panel. That state is a migration artefact — `server` mode is not a choice a
 * client can make — so the copy says so rather than offering a switch.
 */
export function EnvironmentKeyCard({
  orgSlug,
  projectSlug,
  envSlug,
  environmentName,
  isProduction,
  canManage,
}: EnvironmentRef & {
  environmentName: string;
  isProduction: boolean;
  /** Rotation is `environment.update`. Everyone else reads the state only. */
  canManage: boolean;
}) {
  const organization = useOrganization(orgSlug);
  const keys = useEnvironmentKeys({
    orgSlug,
    orgId: organization?.id ?? null,
    projectSlug,
    envSlug,
  });
  const [rotating, setRotating] = useState(false);

  const material = keys.state.status === 'open' ? keys.state.material : null;
  const keyState =
    keys.state.status === 'open' || keys.state.status === 'server' ? keys.state.keys : null;
  const pendingCount = keyState?.pendingGrants?.length ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Encryption key</CardTitle>
        <CardDescription>
          The key this environment&apos;s values are encrypted under. It exists only in the browsers
          of the people who hold a grant on it — never on the server.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {keys.state.status === 'loading' ? (
          <Skeleton className="h-16 w-full" />
        ) : keys.state.status === 'error' ? (
          <Alert tone="danger" title="Could not read this environment’s key state">
            <p>Reload the page and try again.</p>
          </Alert>
        ) : keys.state.status === 'server' ? (
          <Alert tone="info" title="This environment uses server-side encryption">
            <p>
              Its values are encrypted with a key the server unwraps, which predates end-to-end
              encryption. There is no client-held key to rotate, and no way to switch an existing
              environment over — create a new one and move the values across.
            </p>
          </Alert>
        ) : keys.state.status === 'unavailable' ? (
          <EnvKeyUnavailableState reason={keys.state.reason} onRetry={keys.reload} />
        ) : (
          <>
            <dl className="grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-fg-subtle text-sm">Key version</dt>
                <dd className="text-fg font-mono text-sm">
                  {keys.state.keys.activeEdk?.version ?? '—'}
                </dd>
              </div>
              <div>
                <dt className="text-fg-subtle text-sm">Highest secret version stored</dt>
                <dd className="text-fg font-mono text-sm">
                  {keys.state.keys.currentMaxSecretVersion}
                </dd>
              </div>
            </dl>

            {keys.state.keys.needsRotation ? (
              <Alert tone="warning" title="A revocation here is only half done">
                <p>
                  Somebody&apos;s grant was deleted and the key they held has not been replaced. The
                  copy they already have still opens anything written from now on.
                </p>
              </Alert>
            ) : null}

            {material !== null && pendingCount > 0 ? (
              <PendingSharesBanner
                target={{ orgSlug, projectSlug, envSlug }}
                material={material}
                pendingCount={pendingCount}
                onShared={keys.reload}
              />
            ) : null}

            {canManage && material !== null ? (
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="secondary" onClick={() => setRotating(true)}>
                  Rotate the key
                </Button>
                <p className="text-fg-subtle text-sm">
                  Generates a new key and re-shares it with everyone still entitled to it. Existing
                  values stay readable.
                </p>
              </div>
            ) : null}
          </>
        )}
      </CardContent>

      {material !== null ? (
        <RotationDialog
          target={{ orgSlug, projectSlug, envSlug }}
          material={material}
          environmentName={environmentName}
          isProduction={isProduction}
          open={rotating}
          onOpenChange={setRotating}
          onRotated={keys.reload}
        />
      ) : null}
    </Card>
  );
}

/** "Last seen" for a pin, where a card wants to show one. */
export function seenAt(iso: string): string {
  return formatAbsoluteTime(iso);
}

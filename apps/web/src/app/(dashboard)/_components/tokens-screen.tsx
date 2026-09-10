'use client';

import { useState } from 'react';

import { api, errorMessage } from '@/lib/api';
import { formatAbsoluteTime, formatRelativeTime, toIsoString } from '@/lib/format';
import { PageHeader } from '@/components/layout';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  EmptyState,
  KeyIcon,
  PlusIcon,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  useToast,
} from '@/components/ui';
import { LevelPills } from '@/components/members/level-toggle';
import { CreateTokenDialog } from '@/components/tokens/create-token-dialog';
import type {
  CliToken,
  CliTokenListResponse,
  ServiceToken,
  ServiceTokenListResponse,
} from '@/components/tokens/types';
import { apiPath } from '../_lib/paths';
import { useApiResource } from '../_lib/use-api-resource';
import { ErrorState } from './resource-states';
import { isOrgAdmin, useOrganization } from './session';

/**
 * Tokens — the organisation's standing credentials, and your own devices.
 *
 * Two very different lists share the page because "what can act as this
 * organisation without a person present?" is one question:
 *
 *  - **Service tokens** (admins only): the CI credentials, each pinned to one
 *    project and environment. The value is never here — it was shown once at
 *    creation. What is here is everything an operator audits: scope, level,
 *    last use, expiry, revocation.
 *  - **Your devices**: the CLI tokens `xecret login` minted for *you*.
 *    Everyone sees their own, nobody browses anyone else's, and "sign out that
 *    laptop" is one click that takes effect on the laptop's next request.
 */

/**
 * The levels a service token can hold. `admin` is deliberately absent — the
 * authorization engine's service-token allowlist tops out at `write`, so an
 * admin token would carry a level nothing can spend. See `serviceAccessSchema`.
 */
const SERVICE_TOKEN_LEVELS = ['read', 'write'] as const;

export function TokensScreen({ orgSlug }: { orgSlug: string }) {
  const organization = useOrganization(orgSlug);
  const canManage = organization !== null && isOrgAdmin(organization.role);

  const serviceTokens = useApiResource<ServiceTokenListResponse>(
    canManage ? apiPath.serviceTokens(orgSlug) : null,
  );
  const cliTokens = useApiResource<CliTokenListResponse>(apiPath.cliTokens(orgSlug));

  const { toast } = useToast();
  const [creating, setCreating] = useState(false);
  const [revokingService, setRevokingService] = useState<ServiceToken | null>(null);
  const [revokingCli, setRevokingCli] = useState<CliToken | null>(null);
  const [error, setError] = useState<unknown>(null);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Tokens"
        description="Credentials that act without a person present — CI service tokens and your signed-in devices."
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <PlusIcon className="size-4" /> New service token
            </Button>
          ) : undefined
        }
      />

      {error !== null ? (
        <Alert tone="danger" title="That change was not saved">
          {errorMessage(error)}
        </Alert>
      ) : null}

      {canManage ? (
        <section aria-label="Service tokens" className="flex flex-col gap-3">
          <h2 className="text-fg text-sm font-semibold">Service tokens</h2>
          {serviceTokens.error !== null ? (
            <ErrorState
              subject="the service tokens"
              error={serviceTokens.error}
              onRetry={serviceTokens.reload}
            />
          ) : serviceTokens.data === null ? (
            <Skeleton className="h-36 w-full rounded-xl" />
          ) : serviceTokens.data.data.length === 0 ? (
            <EmptyState
              icon={<KeyIcon />}
              title="No service tokens"
              description="Mint one to give CI read access to a single environment — the value is shown exactly once."
              action={
                <Button variant="primary" onClick={() => setCreating(true)}>
                  New service token
                </Button>
              }
            />
          ) : (
            <TableContainer aria-label="Service tokens">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Token</TableHead>
                    <TableHead className="w-44">Scope</TableHead>
                    <TableHead className="w-52">Access</TableHead>
                    <TableHead className="w-32">Last used</TableHead>
                    <TableHead className="w-28">Status</TableHead>
                    <TableHead className="w-24">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {serviceTokens.data.data.map((token) => (
                    <TableRow key={token.id}>
                      <TableCell>
                        <p className="text-fg text-sm font-medium">{token.name}</p>
                        <p className="text-fg-subtle font-mono text-sm">{token.tokenPrefix}…</p>
                      </TableCell>
                      <TableCell className="text-fg-muted text-sm">
                        {token.projectSlug}/{token.environmentSlug}
                      </TableCell>
                      <TableCell>
                        {/* The same capsule the member screens grant with, so
                            one vocabulary covers every level in the product.
                            Static, not a setter: a token's scope is fixed at
                            mint time and cannot be widened afterwards — that
                            is the property that makes its blast radius
                            knowable — so changing one means minting another.
                            `admin` is absent because a service token cannot
                            hold it; see `serviceAccessSchema`. */}
                        <LevelPills
                          level={token.accessLevel}
                          label={`Access for ${token.name}`}
                          levels={SERVICE_TOKEN_LEVELS}
                        />
                      </TableCell>
                      <TableCell className="text-fg-muted text-sm whitespace-nowrap">
                        {token.lastUsedAt === null ? (
                          'never'
                        ) : (
                          <time
                            dateTime={toIsoString(token.lastUsedAt)}
                            title={formatAbsoluteTime(token.lastUsedAt)}
                          >
                            {formatRelativeTime(token.lastUsedAt)}
                          </time>
                        )}
                      </TableCell>
                      <TableCell>
                        <TokenStatus expiresAt={token.expiresAt} revokedAt={token.revokedAt} />
                      </TableCell>
                      <TableCell>
                        {token.revokedAt === null ? (
                          <Button
                            size="sm"
                            variant="danger-outline"
                            aria-label={`Revoke ${token.name}`}
                            onClick={() => setRevokingService(token)}
                          >
                            Revoke
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </section>
      ) : null}

      <section aria-label="Your devices" className="flex flex-col gap-3">
        <Card>
          <CardHeader>
            <CardTitle>Your devices</CardTitle>
            <CardDescription>
              CLI credentials minted by <code className="font-mono">xecret login</code> for your
              account. Revoking one signs that machine out on its next request.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {cliTokens.error !== null ? (
              <ErrorState
                subject="your devices"
                error={cliTokens.error}
                onRetry={cliTokens.reload}
              />
            ) : cliTokens.data === null ? (
              <Skeleton className="h-20 w-full rounded-lg" />
            ) : cliTokens.data.data.length === 0 ? (
              <p className="text-fg-muted text-sm">
                No devices yet. Run <code className="font-mono">xecret login</code> on a machine and
                it will appear here.
              </p>
            ) : (
              <ul className="flex flex-col">
                {cliTokens.data.data.map((token) => (
                  <li
                    key={token.id}
                    className="border-line-subtle flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 [&:not(:last-child)]:border-b"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-fg truncate text-sm font-medium">
                        {token.name}
                        {token.isCurrent ? (
                          <span className="text-fg-subtle font-normal"> · this device</span>
                        ) : null}
                      </p>
                      <p className="text-fg-subtle text-sm">
                        {token.lastUsedAt === null
                          ? 'never used'
                          : `last used ${formatRelativeTime(token.lastUsedAt)}`}
                      </p>
                    </div>

                    <TokenStatus expiresAt={token.expiresAt} revokedAt={token.revokedAt} />

                    {token.revokedAt === null ? (
                      <Button
                        size="sm"
                        variant="danger-outline"
                        aria-label={`Revoke ${token.name}`}
                        onClick={() => setRevokingCli(token)}
                      >
                        Revoke
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>

      <CreateTokenDialog
        orgSlug={orgSlug}
        open={creating}
        onOpenChange={setCreating}
        onCreated={serviceTokens.reload}
      />

      <ConfirmDialog
        open={revokingService !== null}
        onOpenChange={(open) => {
          if (!open) setRevokingService(null);
        }}
        title={`Revoke ${revokingService?.name ?? 'this token'}?`}
        description="Every pipeline using it fails its next request. This cannot be undone — a replacement means minting a new token."
        confirmLabel="Revoke token"
        onConfirm={async () => {
          if (revokingService === null) return;
          setError(null);
          try {
            await api.delete(apiPath.token(orgSlug, 'service', revokingService.id));
            toast({ variant: 'success', title: `Revoked ${revokingService.name}` });
            setRevokingService(null);
            serviceTokens.reload();
          } catch (cause) {
            setError(cause);
            throw cause;
          }
        }}
      />

      <ConfirmDialog
        open={revokingCli !== null}
        onOpenChange={(open) => {
          if (!open) setRevokingCli(null);
        }}
        title={`Sign out ${revokingCli?.name ?? 'this device'}?`}
        description={
          revokingCli?.isCurrent === true
            ? 'This is the device making this request — its CLI stops working immediately. The browser session is unaffected.'
            : 'That machine’s CLI stops working on its next request. Sign in again there to restore it.'
        }
        confirmLabel="Revoke credential"
        onConfirm={async () => {
          if (revokingCli === null) return;
          setError(null);
          try {
            await api.delete(apiPath.token(orgSlug, 'cli', revokingCli.id));
            toast({ variant: 'success', title: `Revoked ${revokingCli.name}` });
            setRevokingCli(null);
            cliTokens.reload();
          } catch (cause) {
            setError(cause);
            throw cause;
          }
        }}
      />
    </div>
  );
}

/**
 * What state a credential is in, as one chip.
 *
 * All three states are badges now, in the three tones that mean what they say:
 * a live credential is green, a lapsed one amber, a revoked one red. "Active"
 * used to be muted grey text, which made the one row an operator is scanning
 * for — the token that still works — the least visible thing in the column.
 *
 * An expiry is shown *under* the badge rather than instead of it. The two are
 * different facts: "this still works" and "it stops on Friday", and a token
 * with an expiry was previously rendered without ever saying the first.
 */
function TokenStatus({
  expiresAt,
  revokedAt,
}: {
  expiresAt: string | null;
  revokedAt: string | null;
}) {
  if (revokedAt !== null) return <Badge tone="danger">Revoked</Badge>;
  if (expiresAt !== null && hasExpired(expiresAt)) {
    return <Badge tone="warning">Expired</Badge>;
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Badge tone="success">Active</Badge>
      {expiresAt !== null ? (
        <span className="text-fg-subtle text-sm whitespace-nowrap">
          expires{' '}
          <time dateTime={toIsoString(expiresAt)} title={formatAbsoluteTime(expiresAt)}>
            {formatRelativeTime(expiresAt)}
          </time>
        </span>
      ) : null}
    </span>
  );
}

/** "Now" defaults inside the helper — the same convention as `formatRelativeTime`. */
function hasExpired(expiresAt: string, now: Date = new Date()): boolean {
  return new Date(expiresAt).getTime() <= now.getTime();
}

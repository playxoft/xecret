'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';

import { api, errorMessage } from '@/lib/api';
import { formatAbsoluteTime, formatRelativeTime, pluralize, toIsoString } from '@/lib/format';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
import { useApiResource } from '@/app/(dashboard)/_lib/use-api-resource';
import { canAdminister } from '@/app/(dashboard)/_components/session';
import type { SessionOrganization } from '@/app/(dashboard)/_components/session';
import { ChangeError, PlanLock } from '@/components/plans/plan-notice';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  MoreHorizontalIcon,
  PlusIcon,
  Skeleton,
  Switch,
  useToast,
} from '@/components/ui';
import { DeliveriesDialog } from './deliveries-dialog';
import { SigningSecretDialog } from './signing-secret-dialog';
import type { RevealedSigningSecret } from './signing-secret-dialog';
import type {
  DeliveryAttempt,
  Webhook,
  WebhookListResponse,
  WebhookResponse,
  WebhookSecretRotated,
  WebhookTestResponse,
} from './types';
import { WebhookDialog } from './webhook-dialog';
import {
  atWebhookLimit,
  deliveryErrorText,
  eventSummary,
  statusCodeText,
  testOutcomeCopy,
  webhookStateCopy,
} from './webhook-form';

/**
 * The organisation's webhook endpoints, on its settings page (P19 §5).
 *
 * ── Who sees what ──
 * Owners and admins (`org.update`), for reading as much as for writing: an
 * endpoint's URL is routinely a credential in its own right — a chat
 * integration's incoming-webhook URL *is* one — so the list is not a harmless
 * read. Anybody else is told who manages them and nothing is fetched. Even for
 * those who may, the list shows each endpoint's *host*, never its URL; the URL
 * appears only in the edit form, which is opened deliberately.
 *
 * ── What a delivery carries ──
 * Names, slugs, counts and who did it — the audit log's vocabulary — and never a
 * secret value. The card says so where an endpoint is added, because "does this
 * send our secrets to Slack?" is the first question anybody asks.
 *
 * ── The plan ──
 * `webhooks` is a count: Free none, Pro three, Team twenty-five. At the ceiling
 * "New endpoint" gives way to a sentence naming the plan that allows more. An
 * organisation whose plan now allows none keeps every endpoint, *paused* — listed,
 * editable only to switch off or delete, and sent nothing — and the card says so
 * with the plan that would start them again. Switching an endpoint off and
 * deleting one never need a plan; the server refuses everything else on a paused
 * organisation, and that refusal is rendered as a plan notice rather than an
 * error, through `ChangeError`.
 *
 * ── The signing secret ──
 * Shown once, after adding an endpoint and after rotating its secret, and held
 * only in this card's state until the dialog showing it is closed. See
 * `SigningSecretDialog`.
 */
export function WebhooksCard({
  orgSlug,
  organization,
}: {
  orgSlug: string;
  organization: SessionOrganization | null;
}) {
  const mayManage = canAdminister(organization, 'org.update');
  const list = useApiResource<WebhookListResponse>(mayManage ? apiPath.webhooks(orgSlug) : null);
  const [editing, setEditing] = useState<Webhook | 'new' | null>(null);

  const data = list.data;
  const canAdd = data !== null && !data.paused && !atWebhookLimit(data.limit);

  return (
    <Card id="webhooks">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <CardTitle>Webhooks</CardTitle>
          <CardDescription>
            Tell your own systems when a secret changes — a deploy bot, a chat channel, an incident
            tool. Each delivery is a signed POST naming what changed and who changed it, and never
            carries a secret’s value.
          </CardDescription>
        </div>
        {mayManage && canAdd ? (
          <Button variant="secondary" onClick={() => setEditing('new')}>
            <PlusIcon className="size-4" />
            New endpoint
          </Button>
        ) : null}
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {!mayManage ? (
          <p className="text-fg-subtle text-sm">
            Webhooks are managed by the organisation’s owners and admins.
          </p>
        ) : list.error !== null ? (
          <Alert tone="danger" title="The webhooks could not be loaded">
            <p>{errorMessage(list.error)}</p>
            <Button
              variant="secondary"
              size="sm"
              className="mt-2"
              onClick={() => void list.reload()}
            >
              Try again
            </Button>
          </Alert>
        ) : data === null ? (
          <div aria-busy="true" aria-label="Loading webhooks" className="flex flex-col gap-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : (
          <WebhookList
            orgSlug={orgSlug}
            data={data}
            onEdit={(webhook) => setEditing(webhook)}
            onChanged={() => void list.reload()}
            editing={editing}
            onEditingChange={setEditing}
          />
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Rendered once the listing has loaded, so every control starts from what the
 * server holds rather than from a default corrected a render later.
 */
function WebhookList({
  orgSlug,
  data,
  onEdit,
  onChanged,
  editing,
  onEditingChange,
}: {
  orgSlug: string;
  data: WebhookListResponse;
  onEdit: (webhook: Webhook) => void;
  onChanged: () => void;
  editing: Webhook | 'new' | null;
  onEditingChange: (next: Webhook | 'new' | null) => void;
}) {
  const { toast } = useToast();
  const [error, setError] = useState<unknown>(null);
  /** Which endpoint has a request in flight, and which request — one at a time per row. */
  const [busy, setBusy] = useState<{ id: string; action: 'toggle' | 'test' } | null>(null);
  /** The last test each endpoint was sent from this screen, until the list reloads it away. */
  const [tests, setTests] = useState<Readonly<Record<string, DeliveryAttempt>>>({});
  const [revealed, setRevealed] = useState<RevealedSigningSecret | null>(null);
  const [rotating, setRotating] = useState<Webhook | null>(null);
  const [deleting, setDeleting] = useState<Webhook | null>(null);
  const [logFor, setLogFor] = useState<Webhook | null>(null);

  const atLimit = atWebhookLimit(data.limit);

  async function setEnabled(webhook: Webhook, enabled: boolean) {
    if (busy !== null) return;
    setBusy({ id: webhook.id, action: 'toggle' });
    setError(null);
    try {
      // `enabled` alone, so switching off stays the one edit a paused plan
      // allows — see `patchBody` on why the shape of a patch matters.
      await api.patch<WebhookResponse>(apiPath.webhook(orgSlug, webhook.id), { enabled });
      toast({
        variant: 'success',
        title: enabled
          ? `Deliveries to ${webhook.endpointHost} are back on`
          : `Deliveries to ${webhook.endpointHost} are off`,
        ...(enabled && webhook.disabledReason === 'failures'
          ? { description: 'Its run of failures was cleared, so it starts again from nothing.' }
          : {}),
      });
      onChanged();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  }

  async function sendTest(webhook: Webhook) {
    if (busy !== null) return;
    setBusy({ id: webhook.id, action: 'test' });
    setError(null);
    try {
      const { delivery } = await api.post<WebhookTestResponse>(
        apiPath.webhookTest(orgSlug, webhook.id),
      );
      setTests((current) => ({ ...current, [webhook.id]: delivery }));
      const succeeded = delivery.status === 'succeeded';
      const reason = deliveryErrorText(delivery.lastError, delivery.lastStatusCode);
      toast({
        variant: succeeded ? 'success' : 'error',
        title: succeeded
          ? `${webhook.endpointHost} received the test`
          : `${webhook.endpointHost} did not accept the test`,
        ...(succeeded || reason === null ? {} : { description: reason }),
      });
      // The endpoint's last success or failure has just moved.
      onChanged();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {error !== null ? <ChangeError error={error} /> : null}

      {data.paused ? (
        <Alert tone="warning" title="Webhooks are paused">
          <p>
            This organisation’s plan includes no webhooks, so the endpoints below are kept exactly
            as they are and sent nothing. They deliver again the moment the plan includes them.
            Until then each one can still be switched off, have its secret rotated, or be deleted.
          </p>
          <div className="mt-1.5">
            <PlanLock what="Delivering webhooks" upgradeTo={data.upgradeTo} />
          </div>
        </Alert>
      ) : atLimit ? (
        <div className="flex flex-col gap-1">
          <p className="text-fg-subtle text-sm">
            This organisation has {pluralize(data.limit.used, 'endpoint')}, the most its plan
            allows. Delete one to add another.
          </p>
          <PlanLock what="Adding another endpoint" upgradeTo={data.upgradeTo} />
        </div>
      ) : null}

      {data.webhooks.length === 0 ? (
        data.paused ? null : (
          <p className="text-fg-subtle text-sm">
            No endpoints yet. Add one and choose which events it hears about; a test delivery checks
            it end to end before anything real is sent.
          </p>
        )
      ) : (
        <ul className="border-line divide-line-subtle divide-y rounded-lg border">
          {data.webhooks.map((webhook) => (
            <WebhookRow
              key={webhook.id}
              webhook={webhook}
              paused={data.paused}
              busy={busy?.id === webhook.id ? busy.action : null}
              anyBusy={busy !== null}
              lastTest={tests[webhook.id] ?? null}
              onToggle={(enabled) => void setEnabled(webhook, enabled)}
              onTest={() => void sendTest(webhook)}
              onLog={() => setLogFor(webhook)}
              onEdit={() => onEdit(webhook)}
              onRotate={() => setRotating(webhook)}
              onDelete={() => setDeleting(webhook)}
            />
          ))}
        </ul>
      )}

      <WebhookDialog
        orgSlug={orgSlug}
        webhook={editing === 'new' || editing === null ? null : editing}
        open={editing !== null}
        onOpenChange={(open) => (open ? undefined : onEditingChange(null))}
        onCreated={(created) => {
          onEditingChange(null);
          // Straight from the response into the one dialog that shows it.
          setRevealed({
            host: created.webhook.endpointHost,
            secret: created.secret,
            reason: 'created',
          });
          toast({ variant: 'success', title: `Added ${created.webhook.endpointHost}` });
          onChanged();
        }}
        onSaved={(webhook) => {
          toast({ variant: 'success', title: `Saved ${webhook.endpointHost}` });
          onChanged();
        }}
      />

      <SigningSecretDialog revealed={revealed} onClose={() => setRevealed(null)} />

      <DeliveriesDialog orgSlug={orgSlug} webhook={logFor} onClose={() => setLogFor(null)} />

      {rotating !== null ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => (open ? undefined : setRotating(null))}
          title={`Rotate the secret for ${rotating.endpointHost}?`}
          description="A new signing secret is made and the old one stops signing immediately — there is no overlap. Until the receiver has the new one it rejects every delivery, so have it ready to update."
          confirmLabel="Rotate secret"
          confirmVariant="primary"
          onConfirm={async () => {
            // A refusal is thrown back to the dialog, which shows it and stays
            // open; nothing is lost, because nothing was made.
            const { secret } = await api.post<WebhookSecretRotated>(
              apiPath.webhookRotateSecret(orgSlug, rotating.id),
            );
            setRevealed({ host: rotating.endpointHost, secret, reason: 'rotated' });
            setRotating(null);
          }}
        />
      ) : null}

      {deleting !== null ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => (open ? undefined : setDeleting(null))}
          title={`Delete ${deleting.endpointHost}?`}
          description="It stops receiving deliveries at once, and its delivery log is deleted with it. Anything still queued for it is dropped. The audit log keeps that it existed."
          confirmLabel="Delete endpoint"
          onConfirm={async () => {
            await api.delete(apiPath.webhook(orgSlug, deleting.id));
            toast({ variant: 'success', title: `Deleted ${deleting.endpointHost}` });
            setDeleting(null);
            onChanged();
          }}
        />
      ) : null}
    </>
  );
}

function WebhookRow({
  webhook,
  paused,
  busy,
  anyBusy,
  lastTest,
  onToggle,
  onTest,
  onLog,
  onEdit,
  onRotate,
  onDelete,
}: {
  webhook: Webhook;
  /** The plan includes no webhooks. Switching off still works; switching on does not. */
  paused: boolean;
  busy: 'toggle' | 'test' | null;
  anyBusy: boolean;
  lastTest: DeliveryAttempt | null;
  onToggle: (enabled: boolean) => void;
  onTest: () => void;
  onLog: () => void;
  onEdit: () => void;
  onRotate: () => void;
  onDelete: () => void;
}) {
  const state = webhookStateCopy(webhook);
  const switchId = `webhook-${webhook.id}-enabled`;
  // On a paused plan, switching an endpoint back on is refused by the server;
  // the switch says so rather than offering a refusal. Switching off is never
  // blocked.
  const blockedOn = paused && !webhook.enabled;

  return (
    <li className="flex flex-col gap-2 px-3 py-3">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2">
            <span className="text-fg font-mono text-sm font-medium break-all">
              {webhook.endpointHost}
            </span>
            <Badge tone={state.tone}>{state.label}</Badge>
          </p>
          {webhook.description !== null && webhook.description.length > 0 ? (
            <p className="text-fg-muted mt-0.5 text-sm">{webhook.description}</p>
          ) : null}
          <p className="text-fg-subtle mt-0.5 text-sm">{eventSummary(webhook.eventTypes)}</p>
        </div>

        <div className="flex items-center gap-1.5">
          {/* A switch, because flipping it is the act: deliveries stop or start
              the moment it moves. Labelled for a screen reader by the host it
              governs, since "Enabled" repeated down a list names nothing. */}
          <Switch
            id={switchId}
            checked={webhook.enabled}
            disabled={anyBusy || blockedOn}
            aria-busy={busy === 'toggle' || undefined}
            aria-label={`Deliver to ${webhook.endpointHost}`}
            onCheckedChange={onToggle}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={onTest}
            loading={busy === 'test'}
            // A test is allowed on an endpoint that is switched off — that is
            // when somebody most wants to know whether it works again — but not
            // while the plan includes no webhooks, which the server refuses.
            disabled={anyBusy || paused}
            aria-label={`Send a test delivery to ${webhook.endpointHost}`}
          >
            Send test
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onLog}
            aria-label={`Delivery log for ${webhook.endpointHost}`}
          >
            Deliveries
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label={`More for ${webhook.endpointHost}`}
              >
                <MoreHorizontalIcon className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={onEdit}>Edit</DropdownMenuItem>
              <DropdownMenuItem onSelect={onRotate}>Rotate signing secret</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={onDelete}>
                Delete endpoint
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {webhook.state === 'disabled' && webhook.disabledReason === 'failures' ? (
        <Alert tone="danger" title="Switched off after failing for a day">
          <p>
            Deliveries failed {pluralize(webhook.consecutiveFailures, 'time')} in a row
            {webhook.failingSince !== null ? (
              <>
                {' '}
                since{' '}
                <time
                  dateTime={toIsoString(webhook.failingSince)}
                  title={formatAbsoluteTime(webhook.failingSince)}
                >
                  {formatRelativeTime(webhook.failingSince)}
                </time>
              </>
            ) : null}
            , so xecret stopped sending to it. Check the delivery log for why, fix the receiver,
            then switch it back on — its run of failures starts again from nothing.
          </p>
          {!paused ? (
            <Button
              variant="secondary"
              size="sm"
              className="mt-2"
              loading={busy === 'toggle'}
              disabled={anyBusy}
              onClick={() => onToggle(true)}
            >
              Re-enable
            </Button>
          ) : null}
        </Alert>
      ) : null}

      {blockedOn ? (
        <p className="text-fg-subtle text-sm">
          Switching this back on waits for a plan that includes webhooks.
        </p>
      ) : null}

      <DeliveryFacts webhook={webhook} lastTest={lastTest} />
    </li>
  );
}

/** The last success, the last failure, and the test just sent — when there are any. */
function DeliveryFacts({
  webhook,
  lastTest,
}: {
  webhook: Webhook;
  lastTest: DeliveryAttempt | null;
}) {
  const facts: { key: string; node: ReactNode }[] = [];

  if (webhook.lastSuccessAt !== null) {
    facts.push({
      key: 'success',
      node: (
        <>
          Last delivered{' '}
          <time
            dateTime={toIsoString(webhook.lastSuccessAt)}
            title={formatAbsoluteTime(webhook.lastSuccessAt)}
          >
            {formatRelativeTime(webhook.lastSuccessAt)}
          </time>
        </>
      ),
    });
  }
  if (webhook.lastFailureAt !== null) {
    facts.push({
      key: 'failure',
      node: (
        <>
          last failed{' '}
          <time
            dateTime={toIsoString(webhook.lastFailureAt)}
            title={formatAbsoluteTime(webhook.lastFailureAt)}
          >
            {formatRelativeTime(webhook.lastFailureAt)}
          </time>
        </>
      ),
    });
  }

  const testStatus = lastTest === null ? null : testOutcomeCopy(lastTest.status);
  const testReason =
    lastTest === null ? null : deliveryErrorText(lastTest.lastError, lastTest.lastStatusCode);
  const testCode = lastTest === null ? null : statusCodeText(lastTest.lastStatusCode);

  if (facts.length === 0 && lastTest === null) {
    return <p className="text-fg-subtle text-sm">Nothing delivered yet.</p>;
  }

  return (
    <div className="flex flex-col gap-1">
      {facts.length > 0 ? (
        <p className="text-fg-subtle text-sm">
          {facts.map((fact, index) => (
            <span key={fact.key}>
              {index > 0 ? ' · ' : null}
              {fact.node}
            </span>
          ))}
        </p>
      ) : null}
      {lastTest !== null && testStatus !== null ? (
        // Polite, so the outcome of the button just pressed is announced
        // without interrupting; the toast says the same for sighted readers.
        <p role="status" className="text-fg-muted flex flex-wrap items-center gap-2 text-sm">
          Test delivery: <Badge tone={testStatus.tone}>{testStatus.label}</Badge>
          {testCode !== null ? <span>{testCode}</span> : null}
          {testReason !== null && lastTest.status !== 'succeeded' ? (
            <span className="text-fg-subtle">{testReason}</span>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

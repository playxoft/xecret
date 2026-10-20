'use client';

import { errorMessage } from '@/lib/api';
import { formatAbsoluteTime, formatRelativeTime, pluralize, toIsoString } from '@/lib/format';
import { apiPath, withQuery } from '@/app/(dashboard)/_lib/paths';
import { useApiResource } from '@/app/(dashboard)/_lib/use-api-resource';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  RefreshIcon,
  Skeleton,
} from '@/components/ui';
import type { Webhook, WebhookDeliveriesResponse, WebhookDelivery } from './types';
import { deliveryErrorText, deliveryStatusCopy, eventLabel, statusCodeText } from './webhook-form';

/** How much of the log one opening reads. The server's default, stated. */
const DELIVERY_LOG_LIMIT = 50;

/**
 * One endpoint's delivery log, newest first.
 *
 * ── What it can and cannot say ──
 * What happened to each delivery — its status, how many attempts, the
 * receiver's HTTP status and a fixed category for the failure — and the body
 * that was *sent*, which carries names, slugs and counts and never a value. Not
 * what the receiver said back: the server never stores a response body, because
 * it is text a third party wrote and this is the screen it would end up on.
 *
 * Mounted only while open, so the log is read when somebody asks for it rather
 * than for every endpoint the card lists.
 */
export function DeliveriesDialog({
  orgSlug,
  webhook,
  onClose,
}: {
  orgSlug: string;
  webhook: Webhook | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={webhook !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-2xl">
        {webhook !== null ? (
          <DeliveryLog orgSlug={orgSlug} webhook={webhook} onClose={onClose} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function DeliveryLog({
  orgSlug,
  webhook,
  onClose,
}: {
  orgSlug: string;
  webhook: Webhook;
  onClose: () => void;
}) {
  const log = useApiResource<WebhookDeliveriesResponse>(
    withQuery(apiPath.webhookDeliveries(orgSlug, webhook.id), { limit: DELIVERY_LOG_LIMIT }),
  );

  return (
    <>
      <DialogHeader>
        <DialogTitle>Deliveries to {webhook.endpointHost}</DialogTitle>
        <DialogDescription>
          The last {DELIVERY_LOG_LIMIT} deliveries, newest first. A failed one is retried for about
          two days before it is given up on, and every retry carries the same{' '}
          <code className="font-mono">webhook-id</code>.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-3">
        {log.error !== null ? (
          <Alert tone="danger" title="The delivery log could not be loaded">
            <p>{errorMessage(log.error)}</p>
          </Alert>
        ) : log.data === null ? (
          <div aria-busy="true" aria-label="Loading deliveries" className="flex flex-col gap-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : log.data.deliveries.length === 0 ? (
          <p className="text-fg-subtle text-sm">
            Nothing has been sent to this endpoint yet. Send a test from its row to see one here.
          </p>
        ) : (
          <ul className="border-line divide-line-subtle divide-y rounded-lg border">
            {log.data.deliveries.map((delivery) => (
              <DeliveryEntry key={delivery.id} delivery={delivery} />
            ))}
          </ul>
        )}
      </DialogBody>

      <DialogFooter>
        <Button variant="ghost" onClick={() => void log.reload()} loading={log.loading}>
          <RefreshIcon className="size-4" />
          Refresh
        </Button>
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </DialogFooter>
    </>
  );
}

function DeliveryEntry({ delivery }: { delivery: WebhookDelivery }) {
  const status = deliveryStatusCopy(delivery.status, delivery.attempts);
  const failure = deliveryErrorText(delivery.lastError, delivery.lastStatusCode);
  const code = statusCodeText(delivery.lastStatusCode);

  return (
    <li className="flex flex-col gap-1.5 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-fg text-sm font-medium">{eventLabel(delivery.eventType)}</span>
        <Badge tone={status.tone}>{status.label}</Badge>
        <span className="text-fg-subtle text-sm">
          {pluralize(delivery.attempts, 'attempt')}
          {code === null ? '' : ` · ${code}`}
        </span>
        <span className="flex-1" />
        <time
          className="text-fg-subtle text-sm whitespace-nowrap"
          dateTime={toIsoString(delivery.createdAt)}
          title={formatAbsoluteTime(delivery.createdAt)}
        >
          {formatRelativeTime(delivery.createdAt)}
        </time>
      </div>

      {failure !== null && delivery.status !== 'succeeded' ? (
        <p className="text-fg-muted text-sm leading-5">{failure}</p>
      ) : null}

      {delivery.status === 'pending' && delivery.nextAttemptAt !== null ? (
        <p className="text-fg-subtle text-sm">
          Next attempt{' '}
          <time
            dateTime={toIsoString(delivery.nextAttemptAt)}
            title={formatAbsoluteTime(delivery.nextAttemptAt)}
          >
            {formatRelativeTime(delivery.nextAttemptAt)}
          </time>
          .
        </p>
      ) : null}

      {/* Closed by default: fifty JSON bodies open at once is a page nobody can
          scan, and the status line above is what most visits are for. */}
      <details className="group">
        <summary className="text-fg-subtle hover:text-fg cursor-pointer text-sm select-none">
          Body sent
        </summary>
        <pre className="border-line bg-canvas-inset text-fg mt-1.5 max-h-56 overflow-auto rounded-md border px-3 py-2 font-mono text-xs leading-5 break-all whitespace-pre-wrap">
          {delivery.body}
        </pre>
        {delivery.bodyTruncated ? (
          <p className="text-fg-subtle mt-1 text-sm">
            Shortened for the log — the receiver was sent the whole body.
          </p>
        ) : null}
      </details>
    </li>
  );
}

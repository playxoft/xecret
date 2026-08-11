'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { api, errorMessage, isApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { pluralize } from '@/lib/format';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
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
  Field,
  FileTextIcon,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  useToast,
} from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import type {
  ImportPlanItem,
  ImportPlanResponse,
  ImportSourceFormat,
  ImportStrategy,
} from './types';

export interface ImportDialogProps {
  orgSlug: string;
  projectSlug: string;
  envSlug: string;
  isProduction: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}

/** Well above any real configuration file, and far below the 1 MB body limit. */
const MAX_FILE_BYTES = 512 * 1024;

/** Long enough that typing settles, short enough that the preview feels live. */
const PREVIEW_DEBOUNCE_MS = 400;

const STRATEGIES: ReadonlyArray<{ value: ImportStrategy; label: string; hint: string }> = [
  {
    value: 'skip',
    label: 'Skip existing',
    hint: 'A name that already exists is left exactly as it is.',
  },
  {
    value: 'overwrite',
    label: 'Overwrite existing',
    hint: 'A name that already exists gets a new version. The old one stays in the history.',
  },
  {
    value: 'rename',
    label: 'Import alongside',
    hint: 'A name that already exists is imported as NAME_2, so nothing is replaced.',
  },
];

const FORMATS: ReadonlyArray<{ value: ImportSourceFormat | 'auto'; label: string }> = [
  { value: 'auto', label: 'Detect automatically' },
  { value: 'dotenv', label: '.env' },
  { value: 'json', label: 'JSON' },
  { value: 'yaml', label: 'YAML' },
  { value: 'shell', label: 'Shell script' },
];

const STATUS_TONE: Readonly<Record<ImportPlanItem['status'], BadgeTone>> = {
  create: 'success',
  overwrite: 'warning',
  rename: 'accent',
  skip: 'neutral',
  unchanged: 'neutral',
  invalid: 'danger',
};

const STATUS_LABEL: Readonly<Record<ImportPlanItem['status'], string>> = {
  create: 'Add',
  overwrite: 'Overwrite',
  rename: 'Rename',
  skip: 'Skip',
  unchanged: 'Unchanged',
  invalid: 'Cannot import',
};

/**
 * Bulk import from a `.env`, JSON, YAML or shell file.
 *
 * ── The file's contents are a pile of credentials ──
 * `content` holds every value in the uploaded file at once. It lives in React
 * state for as long as this dialog is open and nowhere else: not in
 * `localStorage`, not in `sessionStorage` (a "restore my draft" feature would
 * write a hundred production secrets to disk), not in the URL, and not in a
 * `console` call — including on the error path, which is the tempting one.
 *
 * ── The preview is the import ──
 * `dryRun: true` runs the identical server code path — the same parser, the same
 * planner, the same write preparation that computes each value's HMAC — and
 * stops before opening the transaction. So "42 will be added, 3 overwritten"
 * cannot disagree with what happens, because there is no second implementation
 * for it to disagree with.
 *
 * ── The preview has no value column, and must never grow one ──
 * The server does not send values back, in either mode, and that is deliberate:
 * the browser already has the file it just uploaded, so echoing the values would
 * put every secret into the network log, into any proxy that terminates TLS on a
 * corporate network, and into whatever error reporter the dashboard ships with,
 * in exchange for nothing. The columns below are source key, target name, status
 * and note — all of them names and rules.
 */
export function ImportDialog({ open, onOpenChange, ...rest }: ImportDialogProps) {
  const [applying, setApplying] = useState(false);

  return (
    <Dialog open={open} onOpenChange={(next) => (applying ? undefined : onOpenChange(next))}>
      <DialogContent className="max-w-3xl">
        {/* One component down, because Radix unmounts a closed dialog's content.
            That is what drops the uploaded file when the dialog closes: this
            component's state holds every value in it, and an effect that cleared
            it would leave them live for a render longer than necessary. */}
        <ImportBody {...rest} onOpenChange={onOpenChange} onApplyingChange={setApplying} />
      </DialogContent>
    </Dialog>
  );
}

function ImportBody({
  orgSlug,
  projectSlug,
  envSlug,
  isProduction,
  onOpenChange,
  onImported,
  onApplyingChange,
}: Omit<ImportDialogProps, 'open'> & { onApplyingChange: (applying: boolean) => void }) {
  const { toast } = useToast();
  const fileInput = useRef<HTMLInputElement | null>(null);

  const [content, setContent] = useState('');
  const [filename, setFilename] = useState<string | null>(null);
  const [format, setFormat] = useState<ImportSourceFormat | 'auto'>('auto');
  const [strategy, setStrategy] = useState<ImportStrategy>('skip');
  const [dragging, setDragging] = useState(false);

  const [plan, setPlan] = useState<ImportPlanResponse | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<unknown>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<unknown>(null);
  const [applied, setApplied] = useState<ImportPlanResponse | null>(null);

  /**
   * Replaces the file being previewed.
   *
   * The stale plan is discarded here, in the event handler, rather than in the
   * preview effect: a plan describes one particular file, and leaving the
   * previous one on screen while a new one is being parsed would show counts
   * that belong to a document the user has already replaced.
   */
  function setSource(next: string, name: string | null) {
    setContent(next);
    setFilename(name);
    setPlan(null);
    setPlanError(null);
  }

  /** Kept in step with the parent, which blocks dismissal mid-import. */
  function setBusy(busy: boolean) {
    setApplying(busy);
    onApplyingChange(busy);
  }

  const requestBody = useCallback(
    (dryRun: boolean) => ({
      content,
      ...(format === 'auto' ? {} : { format }),
      ...(filename === null ? {} : { filename }),
      strategy,
      dryRun,
    }),
    [content, format, filename, strategy],
  );

  // The dry run is re-requested whenever the file, the format or the strategy
  // changes, debounced so that pasting does not fire one per keystroke. It is
  // rate limited on the server exactly like a write, because a preview parses a
  // megabyte, reads every existing secret and unwraps the environment key.
  useEffect(() => {
    // No synchronous setState here — the plan is cleared by whichever handler
    // changed the inputs, so this effect only ever writes from its callbacks.
    if (applied !== null || content.trim().length === 0) return;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      setPlanning(true);
      setPlanError(null);
      api
        .post<ImportPlanResponse>(
          apiPath.import(orgSlug, projectSlug, envSlug),
          requestBody(true),
          {
            signal: controller.signal,
          },
        )
        .then((response) => {
          if (controller.signal.aborted) return;
          setPlan(response);
          setPlanning(false);
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          setPlan(null);
          setPlanError(cause);
          setPlanning(false);
        });
    }, PREVIEW_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [applied, content, requestBody, orgSlug, projectSlug, envSlug]);

  async function readFile(file: File) {
    if (file.size > MAX_FILE_BYTES) {
      setPlanError(
        new Error(
          `That file is ${Math.round(file.size / 1024)} KB. Import files are limited to ${MAX_FILE_BYTES / 1024} KB.`,
        ),
      );
      return;
    }
    // `File.text()` rather than a FileReader: it returns a promise, it decodes
    // as UTF-8, and it leaves no reader object holding the contents afterwards.
    setSource(await file.text(), file.name);
  }

  async function apply() {
    setBusy(true);
    setApplyError(null);
    try {
      const result = await api.post<ImportPlanResponse>(
        apiPath.import(orgSlug, projectSlug, envSlug),
        requestBody(false),
      );
      // The uploaded file is dropped the instant it is no longer needed. Keeping
      // it so the user could "run it again" would hold every value in memory for
      // as long as the dialog stayed open.
      setContent('');
      setApplied(result);
      setBusy(false);
      toast({
        variant: 'success',
        title: 'Import complete',
        description: `${pluralize(result.counts.create, 'secret')} added, ${result.counts.overwrite} overwritten.`,
      });
      onImported();
    } catch (cause) {
      setBusy(false);
      setApplyError(cause);
    }
  }

  const writes = plan === null ? 0 : plan.counts.create + plan.counts.overwrite;

  return (
    <>
      <DialogHeader>
        {isProduction ? (
          <Badge tone="production" className="mb-1 self-start">
            Production
          </Badge>
        ) : null}
        <DialogTitle>{applied === null ? 'Import secrets' : 'Import complete'}</DialogTitle>
        <DialogDescription>
          {applied === null
            ? 'Drop a .env, JSON, YAML or shell file, or paste its contents. Nothing is written until you apply the preview.'
            : `Imported into ${envSlug}.`}
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex max-h-[65dvh] flex-col gap-4 overflow-y-auto">
        {applied !== null ? (
          <>
            <PlanSummary plan={applied} />
            <PlanTable items={applied.items} />
          </>
        ) : (
          <>
            <div
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                const file = event.dataTransfer.files[0];
                if (file) void readFile(file);
              }}
              className={cn(
                'rounded-xl border border-dashed px-4 py-6 text-center transition-colors',
                dragging ? 'border-accent bg-accent-tint' : 'border-line bg-canvas-inset',
              )}
            >
              <FileTextIcon aria-hidden="true" className="text-fg-subtle mx-auto size-6" />
              <p className="text-fg-muted mt-2 text-sm">
                Drag a file here
                {filename === null ? null : (
                  <>
                    {' '}
                    — currently <span className="text-fg font-mono">{filename}</span>
                  </>
                )}
              </p>
              {/* The visible control is a Button; the input is the real file
                    picker behind it. Both are keyboard reachable — the button
                    forwards the click, and the input keeps its own focus ring —
                    so this is not a drag-only interaction. */}
              <Button
                variant="secondary"
                size="sm"
                className="mt-3"
                onClick={() => fileInput.current?.click()}
              >
                Choose a file
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept=".env,.json,.yaml,.yml,.sh,.txt,text/plain,application/json"
                className="sr-only"
                aria-label="Choose a file to import"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void readFile(file);
                  // Reset so that choosing the same file twice fires a change.
                  event.target.value = '';
                }}
              />
            </div>

            <Field
              label="Or paste the file"
              hint="This never leaves your browser except in the import request itself."
            >
              <Textarea
                value={content}
                onChange={(event) => setSource(event.target.value, null)}
                rows={5}
                placeholder={'DATABASE_URL=postgres://…\nSTRIPE_SECRET_KEY=sk_live_…'}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                className="font-mono"
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Format"
                hint={
                  format === 'auto' && plan !== null
                    ? `Detected as ${FORMATS.find((entry) => entry.value === plan.format)?.label ?? plan.format}.`
                    : 'The file name is weighed above its contents.'
                }
              >
                <Select
                  value={format}
                  onValueChange={(next) => {
                    setFormat(next as ImportSourceFormat | 'auto');
                    setPlan(null);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FORMATS.map((entry) => (
                      <SelectItem key={entry.value} value={entry.value}>
                        {entry.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field
                label="If a name already exists"
                hint={STRATEGIES.find((entry) => entry.value === strategy)?.hint}
              >
                <Select
                  value={strategy}
                  onValueChange={(next) => {
                    setStrategy(next as ImportStrategy);
                    setPlan(null);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STRATEGIES.map((entry) => (
                      <SelectItem key={entry.value} value={entry.value}>
                        {entry.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>

            {planError !== null ? (
              <Alert tone="danger" title="Could not build a preview">
                <p>{errorMessage(planError)}</p>
                {isApiError(planError) && planError.requestId ? (
                  <p className="mt-1.5 text-xs">
                    Request id: <code className="font-mono select-all">{planError.requestId}</code>
                  </p>
                ) : null}
              </Alert>
            ) : planning ? (
              <div aria-busy="true" aria-label="Building the preview" className="space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            ) : plan !== null ? (
              <>
                <PlanSummary plan={plan} />
                {plan.warnings.length > 0 ? (
                  <Alert tone="warning" title={pluralize(plan.warnings.length, 'warning')}>
                    <ul className="space-y-0.5">
                      {plan.warnings.map((warning) => (
                        <li key={`${warning.line}-${warning.message}`}>
                          Line {warning.line}: {warning.message}
                        </li>
                      ))}
                    </ul>
                  </Alert>
                ) : null}
                <PlanTable items={plan.items} />
              </>
            ) : null}

            {applyError !== null ? (
              <Alert tone="danger" title="The import failed">
                <p>{errorMessage(applyError)}</p>
                <p className="mt-1.5">
                  Nothing was written: the whole import runs in one transaction, so it either
                  applies completely or not at all.
                </p>
                {isApiError(applyError) && applyError.requestId ? (
                  <p className="mt-1.5 text-xs">
                    Request id: <code className="font-mono select-all">{applyError.requestId}</code>
                  </p>
                ) : null}
              </Alert>
            ) : null}
          </>
        )}
      </DialogBody>

      <DialogFooter>
        {applied !== null ? (
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={applying}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={apply}
              loading={applying}
              disabled={plan === null || writes === 0}
            >
              {writes === 0 ? 'Nothing to import' : `Import ${pluralize(writes, 'secret')}`}
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
}

/** The one-line answer: how many, and of what kind. */
function PlanSummary({ plan }: { plan: ImportPlanResponse }) {
  const parts: string[] = [];
  if (plan.counts.create > 0) parts.push(`${plan.counts.create} added`);
  if (plan.counts.overwrite > 0) parts.push(`${plan.counts.overwrite} overwritten`);
  if (plan.counts.rename > 0) parts.push(`${plan.counts.rename} renamed`);
  if (plan.counts.unchanged > 0) parts.push(`${plan.counts.unchanged} already up to date`);
  if (plan.counts.skip > 0) parts.push(`${plan.counts.skip} skipped`);
  if (plan.counts.invalid > 0) parts.push(`${plan.counts.invalid} cannot be imported`);

  return (
    // Announced politely so the count is heard as the preview updates, without
    // interrupting whatever the user is typing.
    <p role="status" className="text-fg text-sm leading-6">
      {plan.dryRun ? (
        <>
          <span className="font-medium">{parts.join(', ') || 'Nothing to import'}</span>. Nothing
          has been written yet.
        </>
      ) : (
        <span className="font-medium">{parts.join(', ') || 'Nothing was imported'}.</span>
      )}
    </p>
  );
}

function PlanTable({ items }: { items: readonly ImportPlanItem[] }) {
  if (items.length === 0) {
    return <p className="text-fg-muted text-sm">The file contains no key/value pairs.</p>;
  }

  return (
    <TableContainer aria-label="What this import will do, line by line">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Key in the file</TableHead>
            <TableHead>Secret name</TableHead>
            <TableHead>Result</TableHead>
            <TableHead>Note</TableHead>
          </TableRow>
        </TableHeader>
        {/*
          There is deliberately no value column. The server does not send values
          back in either mode, and it must stay that way: the browser already has
          the file, so displaying the values again would add them to the network
          log, to any TLS-terminating corporate proxy, and to any error reporter,
          and would buy nothing.
        */}
        <TableBody>
          {items.map((item) => (
            <TableRow key={`${item.sourceKey}-${item.name}`}>
              <TableCell className="font-mono text-[0.8125rem] break-all">
                {item.sourceKey}
              </TableCell>
              <TableCell className="font-mono text-[0.8125rem] break-all">
                {item.name === '' ? <span className="text-fg-subtle">—</span> : item.name}
              </TableCell>
              <TableCell>
                <Badge tone={STATUS_TONE[item.status]}>{STATUS_LABEL[item.status]}</Badge>
              </TableCell>
              <TableCell className="text-fg-muted text-[0.8125rem] leading-5">
                {item.note ?? ''}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

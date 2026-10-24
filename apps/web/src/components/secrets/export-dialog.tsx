'use client';

import { useState } from 'react';

import { errorMessage } from '@/lib/api';
import { apiPath, withQuery } from '@/app/(dashboard)/_lib/paths';
import { renderExport } from '@/components/envkeys';
import type { SecretIo } from '@/components/envkeys';
import { withoutReasonPrefix } from '@/components/plans/plan-copy';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  TerminalIcon,
} from '@/components/ui';
import type { ExportFormat } from './types';

export interface ExportDialogProps {
  orgSlug: string;
  projectSlug: string;
  envSlug: string;
  isProduction: boolean;
  /**
   * How this environment's values are read. `null` when its key is unavailable.
   *
   * In `e2ee` mode the download is built here rather than fetched: the export
   * endpoint answers `409 client_side_only`, because formatting takes plaintext
   * and the server has none.
   */
  io: SecretIo | null;
  /**
   * The environment's export policy as its payload states it (P19 §9).
   *
   * Read before anything is pulled, so an environment whose policy disables
   * export is refused without decrypting a single value. The bundle states the
   * policy too, and an `e2ee` export checks that answer as well — it is the
   * fresher of the two if the switch was flipped since this page loaded.
   */
  plaintextExport?: 'allowed' | 'disabled' | undefined;
  /** The slug this environment inherits from, or `null` — for the resolution caveat below. */
  inheritsFrom?: string | null | undefined;
  /** How many of the secrets on screen are templates, for the same caveat. */
  templateCount?: number | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The refusal, worded as the server and the CLI word it, so the three agree.
 *
 * Exported for the screens that refuse before the dialog is even opened.
 */
export function exportDisabledSentence(projectSlug: string, envSlug: string): string {
  return (
    `Plaintext export is disabled for ${projectSlug}/${envSlug} by its environment policy; ` +
    'an owner or admin of the organisation can change it in the environment’s settings.'
  );
}

/** The file extension each format gets, matching what the server names its download. */
const EXTENSION: Readonly<Record<ExportFormat, string>> = {
  env: 'env',
  json: 'json',
  yaml: 'yaml',
  shell: 'sh',
  docker: 'env',
};

const FORMATS: ReadonlyArray<{ value: ExportFormat; label: string; hint: string }> = [
  { value: 'env', label: '.env', hint: 'KEY=value, one per line. What most tools read.' },
  { value: 'json', label: 'JSON', hint: 'A flat object of string values.' },
  { value: 'yaml', label: 'YAML', hint: 'A flat mapping.' },
  { value: 'shell', label: 'Shell', hint: 'export KEY=value, ready to source.' },
  { value: 'docker', label: 'Docker', hint: 'KEY=value for docker run --env-file.' },
];

/**
 * Downloads an environment as a file.
 *
 * ── The warning is the point of this dialog ──
 * Everything the rest of the product does becomes untrue the moment these bytes
 * land on a disk. The file is not encrypted at rest, it outlives the session
 * that produced it, it gets picked up by Time Machine and Dropbox and whatever
 * else indexes a home directory, it is attached to a ticket, and — most often —
 * it is committed. None of that is visible to xecret, and no access grant can be
 * revoked afterwards, because the copy is no longer ours. The audit log records
 * that an export happened and then loses the trail completely.
 *
 * It exists anyway, because a team that cannot export will paste values into
 * Slack one at a time, which is strictly worse and entirely unaudited. So the
 * capability is offered and the trade is stated plainly, with the safer option
 * named rather than implied.
 *
 * ── Why the download is a link, in `server` mode ──
 * `api.get` parses JSON, and an export is a file. More importantly, a real
 * `<a download>` hands the response straight to the browser's download
 * machinery: the plaintext never becomes a JavaScript string, never sits in this
 * page's heap, and never passes through a blob URL that would outlive it. The
 * URL itself carries only slugs and a format — no value has ever gone into one.
 *
 * ── And why it cannot be, in `e2ee` mode ──
 * There is nothing at the other end of that link: the export endpoint answers
 * `409 client_side_only`, because rendering `.env` or YAML takes plaintext and
 * the server holds none. So the values are pulled, decrypted here, and formatted
 * with `@xecret/core/format` — the same module the Worker runs, so the file is
 * byte-identical. The document does become a JavaScript string and does pass
 * through a blob URL, which is a real concession; it is bounded by revoking the
 * URL as soon as the click has been dispatched, and it is the only way to
 * produce a file from values only this browser can read.
 */
export function ExportDialog({ open, onOpenChange, ...target }: ExportDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* One component down, because Radix unmounts a closed dialog's content.
            The acknowledgement below therefore has to be given again every time
            this is opened, which is the whole point of asking for it. */}
        <ExportBody {...target} onOpenChange={onOpenChange} />
      </DialogContent>
    </Dialog>
  );
}

function ExportBody({
  orgSlug,
  projectSlug,
  envSlug,
  isProduction,
  io,
  plaintextExport = 'allowed',
  inheritsFrom = null,
  templateCount = 0,
  onOpenChange,
}: Omit<ExportDialogProps, 'open'>) {
  const [format, setFormat] = useState<ExportFormat>('env');
  const [acknowledged, setAcknowledged] = useState(false);
  const [building, setBuilding] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /**
   * Set when the bundle itself said export is disabled — the switch was flipped
   * after this page loaded. Overrides the payload's older answer.
   */
  const [refusedByBundle, setRefusedByBundle] = useState(false);

  const clientSide = io?.mode === 'e2ee';
  const href = withQuery(apiPath.export(orgSlug, projectSlug, envSlug), { format });
  const selected = FORMATS.find((entry) => entry.value === format);
  const disabled = plaintextExport === 'disabled' || refusedByBundle;
  /**
   * Whether the file would hold less than `xecret run` resolves (P19 §1).
   *
   * The dashboard reads and writes an environment's *own* values; resolving a
   * chain of parents and the references in templates is the CLI's, which opens
   * every layer's key on the machine that runs the process. So a download from
   * here is this environment's rows exactly as stored — templates as their
   * text, nothing inherited — and an environment that relies on either is told
   * so before the file exists, with the command that writes the resolved one.
   */
  const partial = inheritsFrom !== null || templateCount > 0;

  if (disabled) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Export is disabled here</DialogTitle>
          <DialogDescription>
            This environment’s policy keeps its values out of files.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <Alert tone="info" title="Plaintext export is disabled">
            <p>{exportDisabledSentence(projectSlug, envSlug)}</p>
            <p className="mt-2">
              <code className="text-fg font-mono">xecret run</code> is unaffected: it injects these
              values into a process without writing them anywhere.
            </p>
          </Alert>
        </DialogBody>
        <DialogFooter>
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </>
    );
  }

  /**
   * Builds the file here and hands it to the browser's downloader.
   *
   * The blob URL is revoked in the same tick the click is dispatched. The
   * download itself has already taken a reference by then, so revoking does not
   * cancel it — what it does is stop a URL that resolves to every secret in the
   * environment from living for the rest of the page's life, reachable by
   * anything that can read `document`.
   */
  async function downloadLocally() {
    if (io === null || building) return;

    setBuilding(true);
    setProblem(null);

    let url: string | null = null;
    try {
      const pulled = await io.pullEnvironment();
      // The bundle's answer, which is the server's word at this moment: a
      // switch flipped since the page loaded is honoured here, before a single
      // byte of the file exists.
      if (pulled.plaintextExport === 'disabled') {
        setRefusedByBundle(true);
        return;
      }
      const body = renderExport(pulled.plaintexts, format);

      url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${envSlug}.${EXTENSION[format]}`;
      anchor.click();

      onOpenChange(false);
    } catch (cause) {
      // `export_disabled:` and its siblings carry a machine-readable prefix for
      // the clients that branch on it; a person reads the sentence after it.
      setProblem(withoutReasonPrefix(errorMessage(cause)));
    } finally {
      if (url !== null) URL.revokeObjectURL(url);
      setBuilding(false);
    }
  }

  return (
    <>
      <DialogHeader>
        {isProduction ? (
          <Badge tone="production" className="mb-1 self-start">
            Production
          </Badge>
        ) : null}
        <DialogTitle>Export secrets to a file</DialogTitle>
        <DialogDescription>
          Every current value in this environment, decrypted, as a download.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-4">
        <Alert tone="warning" title="A file on disk is not protected by anything">
          <p>
            The download is plaintext. It is not encrypted at rest, it will be backed up and synced
            by whatever indexes your home directory, and it cannot be revoked — once it exists,
            xecret can no longer tell you who has read it.
          </p>
          <p className="mt-2">Delete it as soon as you are done, and never commit it.</p>
        </Alert>

        <Alert tone="info" title="You probably do not need a file">
          <p>
            <code className="text-fg font-mono">xecret run</code> injects these values into a
            process as environment variables and never writes them anywhere:
          </p>
          <pre className="text-fg bg-canvas-inset border-line mt-2 overflow-x-auto rounded-md border px-3 py-2 font-mono text-sm">
            <code>{`xecret run --env ${envSlug} -- npm start`}</code>
          </pre>
          <p className="mt-2 flex items-center gap-1.5">
            <TerminalIcon className="size-3.5 shrink-0" />
            Same values, nothing on disk, and the read is attributed to you in the audit log.
          </p>
        </Alert>

        {partial ? (
          <Alert tone="warning" title="The file holds this environment’s own values only">
            <p>
              {inheritsFrom !== null
                ? `${envSlug} inherits from ${inheritsFrom}, and nothing it inherits is in a download from here. `
                : ''}
              {templateCount > 0
                ? `${templateCount === 1 ? 'One secret is a template' : `${templateCount} secrets are templates`}, written out as the template text with its references unresolved. `
                : ''}
              The CLI resolves both:
            </p>
            <pre className="text-fg bg-canvas-inset border-line mt-2 overflow-x-auto rounded-md border px-3 py-2 font-mono text-sm">
              <code>{`xecret export --env ${envSlug}`}</code>
            </pre>
          </Alert>
        ) : null}

        <Field label="Format" hint={selected?.hint}>
          <Select value={format} onValueChange={(next) => setFormat(next as ExportFormat)}>
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

        {problem !== null ? (
          <Alert tone="danger" title="The export could not be built">
            <p>{problem}</p>
          </Alert>
        ) : null}

        <label className="text-fg-muted flex items-start gap-2.5 text-sm leading-5">
          {/* A native checkbox rather than the Radix primitive: this one gates
                a link, and a link cannot be disabled — only removed. Keeping the
                control and its label in one `<label>` keeps them associated
                without an id to keep in sync. */}
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
            className="accent-accent mt-0.5 size-[1.05rem] shrink-0"
          />
          I understand this writes decrypted secrets to my disk.
        </label>
      </DialogBody>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        {!acknowledged ? (
          <Button variant="primary" disabled>
            Download {selected?.label}
          </Button>
        ) : clientSide ? (
          <Button variant="primary" onClick={downloadLocally} loading={building}>
            Download {selected?.label}
          </Button>
        ) : (
          <Button variant="primary" asChild>
            <a href={href} download onClick={() => onOpenChange(false)}>
              Download {selected?.label}
            </a>
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

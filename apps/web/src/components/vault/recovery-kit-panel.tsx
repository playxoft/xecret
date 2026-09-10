'use client';

import { useEffect, useRef, useState } from 'react';
import type { RecoveryCode } from '@xecret/core/crypto/client';

import {
  Alert,
  Button,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  Field,
  FileTextIcon,
  Input,
} from '@/components/ui';
import {
  downloadEmergencyKit,
  EMERGENCY_KIT_EXPLANATION,
  printEmergencyKit,
} from './emergency-kit';

/**
 * The screen that shows five recovery codes, once.
 *
 * ── Once, and this is the only time ──
 * The server holds a wrap addressed by each code's hash and nothing that could
 * reproduce the code itself, so this render is the last time these strings will
 * ever be legible to anybody. Every affordance here exists because of that:
 * download and print produce something that outlives the tab, and the
 * confirmation field below refuses to let somebody click past a screen they did
 * not read.
 *
 * Used by all three moments a kit is issued — the setup ceremony, a completed
 * recovery, and a deliberate regeneration — because they are the same screen
 * with the same stakes, and a "you have already done this once" variant would be
 * the one where the download button was quietly dropped.
 */

export interface RecoveryKitPanelProps {
  email: string;
  codes: readonly RecoveryCode[];
  issuedAt: Date;
  /** Whether a download or print has completed. Owned by the parent, which gates on it. */
  saved: boolean;
  onSaved: () => void;
  /**
   * The code the confirmation asks for, or `null` to omit the confirmation
   * entirely — which is right where there is nothing to gate, such as the
   * security screen showing a freshly reissued kit inside a dialog the user has
   * to close anyway.
   */
  promptedCode?: RecoveryCode | null;
  typedCode?: string;
  onTypedCode?: (value: string) => void;
  /** The gate's complaint, from `kitConfirmationProblem`. Shown after a failed attempt. */
  problem?: string | null;
}

export function RecoveryKitPanel({
  email,
  codes,
  issuedAt,
  saved,
  onSaved,
  promptedCode = null,
  typedCode = '',
  onTypedCode,
  problem = null,
}: RecoveryKitPanelProps) {
  const [printFailed, setPrintFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  const kit = { email, issuedAt, codes };

  // Held in a ref and cleared on unmount, the way `CopyButton` does it: this
  // panel is dismissed by the step it gates, so a bare `setTimeout` outlives it
  // and fires into a component that is gone — and a second click within the two
  // seconds would otherwise inherit the first click's timer and drop the
  // "Copied" state early.
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(codes.map((code) => code.displayForm).join('\n'));
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied; the codes are on screen and selectable
      // either way, so fail quietly. Nothing about the value is logged.
      setCopied(false);
    }
  }
  const promptedIndex = promptedCode === null ? -1 : codes.indexOf(promptedCode);

  function download() {
    downloadEmergencyKit(kit);
    setPrintFailed(false);
    onSaved();
  }

  function print() {
    // Only counts as saved if the window actually opened. A popup blocker that
    // silently satisfied the gate would be the worst possible failure here.
    if (printEmergencyKit(kit)) {
      setPrintFailed(false);
      onSaved();
    } else {
      setPrintFailed(true);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Alert tone="warning" title="You’ll only see these codes once">
        {EMERGENCY_KIT_EXPLANATION}
      </Alert>

      <ol className="border-line bg-canvas-inset flex flex-col gap-1 rounded-lg border p-4">
        {codes.map((code, index) => (
          <li key={code.displayForm} className="flex items-center gap-3">
            <span aria-hidden="true" className="text-fg-subtle w-4 shrink-0 text-sm tabular-nums">
              {index + 1}
            </span>
            {/* `select-all` so a click selects the whole code rather than one
                hyphen-separated group, which is how a partial paste happens.
                A code is 31 characters and never wraps, which is wider than the
                column on a small phone — so it scrolls inside its own row
                (`min-w-0` is what lets the flex item shrink below its content)
                rather than bursting the bordered box and putting a horizontal
                scrollbar on the whole lock screen. */}
            <code className="text-fg min-w-0 flex-1 overflow-x-auto font-mono text-sm tracking-wide whitespace-nowrap select-all sm:text-base">
              {code.displayForm}
            </code>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={download}>
          <DownloadIcon className="size-4" />
          Download Emergency Kit
        </Button>
        <Button variant="secondary" onClick={print}>
          <FileTextIcon className="size-4" />
          Print
        </Button>
        {/* Copy is offered and deliberately does *not* satisfy the gate: a
            clipboard is overwritten by the next thing anybody copies, and the
            failure it causes surfaces months later. See `emergency-kit.ts`. */}
        <Button variant="secondary" onClick={() => void copyAll()}>
          {copied ? (
            <CheckIcon className="text-success-text size-4" />
          ) : (
            <CopyIcon className="size-4" />
          )}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>

      {printFailed ? (
        <Alert tone="danger" title="The print window did not open">
          Your browser blocked it. Allow pop-ups for this site and try again, or download the kit
          instead.
        </Alert>
      ) : null}

      {saved ? (
        <p className="text-success-text text-sm">
          Saved. Keep it somewhere you would keep a passport — not in the password manager your
          xecret sign-in already protects.
        </p>
      ) : promptedCode !== null && onTypedCode !== undefined ? (
        <Field
          label={`Or type code ${promptedIndex + 1} back to confirm you have it`}
          hint="Hyphens, spacing and capitals do not matter."
          error={problem}
        >
          <Input
            value={typedCode}
            onChange={(event) => onTypedCode(event.target.value)}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            className="font-mono tracking-wide"
            placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-C"
          />
        </Field>
      ) : null}
    </div>
  );
}

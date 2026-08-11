'use client';

import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/cn';
import { Button } from './button';
import { CheckIcon, CopyIcon } from './icons';

export interface CopyButtonProps {
  /**
   * The text to copy, or a function that produces it.
   *
   * Never use this for a secret value — `SecretValue` exists for that, and it
   * routes every copy through the audited reveal endpoint. This is for
   * non-sensitive strings: commands, slugs, request ids.
   */
  value: string;
  /** Completes the button's accessible name: "Copy {label}". */
  label: string;
  className?: string;
}

export function CopyButton({ value, label, className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access is denied outside a secure context and in some
      // embedded browsers. The text is on screen and selectable either way,
      // so this fails quietly rather than raising an error the user cannot act
      // on. Nothing about the value is logged.
      setCopied(false);
    }
  }

  return (
    <Button
      size="icon"
      variant="ghost"
      className={cn('size-7', className)}
      onClick={() => void copy()}
      aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
    >
      {copied ? (
        <CheckIcon className="text-success-text size-3.5" />
      ) : (
        <CopyIcon className="size-3.5" />
      )}
    </Button>
  );
}

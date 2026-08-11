'use client';

import type { Ref, TextareaHTMLAttributes } from 'react';

import { cn } from '@/lib/cn';
import { useFieldControl } from './field';
import { INPUT_BASE } from './input';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  ref?: Ref<HTMLTextAreaElement>;
}

export function Textarea({ className, rows = 4, ref, ...props }: TextareaProps) {
  const fieldProps = useFieldControl();

  return (
    <textarea
      {...fieldProps}
      ref={ref}
      rows={rows}
      className={cn(
        INPUT_BASE,
        // Only vertical resizing: a horizontally resizable textarea can be
        // dragged outside its dialog, and these hold pasted .env files where
        // line wrapping is what makes them readable.
        'resize-y px-3 py-2 leading-6',
        className,
      )}
      {...props}
    />
  );
}

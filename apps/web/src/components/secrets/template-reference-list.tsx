'use client';

import { Tooltip } from '@/components/ui';
import { readTemplate } from './template-references';

/**
 * The references a template holds, under the box it is being typed into.
 *
 * Only for a template that parses: a syntax error is already printed under the
 * same box by the value field's own shape check, in the parser's words, and a
 * second message saying the same thing would only push the row taller.
 *
 * Each reference is a chip, written exactly as it appears in the text, with
 * where it resolves on hover — so the person checks the list the write will
 * declare against the one they meant, one glance per reference. The chips are
 * names, never values: a template's text is the secret here, and nothing about
 * what any reference resolves *to* is known to this browser until `xecret run`
 * resolves it.
 */
export function TemplateReferenceList({ value, valueType }: { value: string; valueType: string }) {
  const reading = readTemplate(value, valueType);
  if (reading.kind !== 'references') return null;

  if (reading.references.length === 0) {
    return (
      <p className="text-fg-subtle text-sm leading-5">
        No references yet. Write <code className="font-mono">{'${KEY}'}</code>,{' '}
        <code className="font-mono">{'${environment.KEY}'}</code> or{' '}
        <code className="font-mono">{'${project.environment.KEY}'}</code>; write{' '}
        <code className="font-mono">{'$${'}</code> for a literal{' '}
        <code className="font-mono">{'${'}</code>.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="References in this template">
      <span className="text-fg-subtle text-sm">Refers to</span>
      {reading.references.map((entry) => (
        <Tooltip key={entry.written} content={entry.where}>
          <span className="border-accent-line bg-accent-tint text-accent-text inline-flex rounded-md border px-1.5 py-0.5 font-mono text-xs">
            {entry.written}
            <span className="sr-only"> — {entry.where}</span>
          </span>
        </Tooltip>
      ))}
    </div>
  );
}

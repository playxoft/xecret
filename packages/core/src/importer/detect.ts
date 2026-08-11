import { isBlankOrComment, splitSourceLines } from './dotenv';
import type { ImportFormat } from './types';

/**
 * Guessing the format of a dropped file.
 *
 * The guess only ever preselects the format picker — the user can always
 * override it — so the confidence matters as much as the format itself. A `low`
 * result should make the UI ask rather than assume.
 */

export type DetectionConfidence = 'high' | 'medium' | 'low';

export interface FormatDetection {
  format: ImportFormat;
  confidence: DetectionConfidence;
  /** Short, safe to display: names the evidence, never quotes file content. */
  reason: string;
}

/**
 * Extension-first, because a filename is a statement of intent: someone who
 * named a file `config.yaml` knows what is in it, and content sniffing a YAML
 * file that happens to open with `{` would overrule them for no reason.
 */
export function detectFormat(filename: string, content: string): FormatDetection {
  const byName = detectByFilename(filename);
  if (byName !== null) return byName;

  const meaningful = splitSourceLines(content)
    .filter((line) => !isBlankOrComment(line))
    .map((line) => line.trim());

  const first = meaningful[0];
  if (first === undefined) {
    return { format: 'dotenv', confidence: 'low', reason: 'The file is empty.' };
  }

  if (first.startsWith('{') || first.startsWith('[')) {
    return { format: 'json', confidence: 'medium', reason: 'The file starts with a JSON value.' };
  }

  if (meaningful.some((line) => /^export\s+[A-Za-z_][A-Za-z0-9_]*=/.test(line))) {
    return {
      format: 'shell',
      confidence: 'medium',
      reason: 'The file contains export statements.',
    };
  }

  if (meaningful.some((line) => /^[A-Za-z_][A-Za-z0-9_.-]*:(\s|$)/.test(line))) {
    return { format: 'yaml', confidence: 'medium', reason: 'The file contains key: value pairs.' };
  }

  if (meaningful.some((line) => /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line))) {
    return { format: 'dotenv', confidence: 'medium', reason: 'The file contains KEY=value pairs.' };
  }

  return {
    format: 'dotenv',
    confidence: 'low',
    reason: 'No format could be identified; .env is the most common.',
  };
}

function detectByFilename(filename: string): FormatDetection | null {
  // Accept a path as well as a bare name — a drag-and-drop payload can carry
  // either, and `webkitRelativePath` carries directories.
  const name = (filename.split(/[/\\]/).pop() ?? '').toLowerCase();

  if (name.endsWith('.json')) {
    return { format: 'json', confidence: 'high', reason: 'The file name ends in .json.' };
  }

  if (name.endsWith('.yaml') || name.endsWith('.yml')) {
    return { format: 'yaml', confidence: 'high', reason: 'The file name ends in .yaml.' };
  }

  // `.envrc` is direnv, which is a shell script, so it must be tested before
  // the `.env` prefix rule below claims it.
  if (name === '.envrc' || /\.(sh|bash|zsh)$/.test(name)) {
    return { format: 'shell', confidence: 'high', reason: 'The file name is a shell script.' };
  }

  // `.env`, `.env.local`, `.env.production.local`, `production.env`, `env.example`.
  if (name === '.env' || name.startsWith('.env.') || /(^|\.)env(\.|$)/.test(name)) {
    return {
      format: 'dotenv',
      confidence: 'high',
      reason: 'The file name identifies a .env file.',
    };
  }

  return null;
}

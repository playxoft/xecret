/**
 * Shared types for the import engine.
 *
 * Every parser — `.env`, JSON, YAML, shell — produces a `ParseResult`, and
 * `buildImportPlan` turns one into the preview the import modal renders. The
 * split is deliberate: parsers know a file format and nothing about secret
 * naming rules, the planner knows the naming and conflict rules and nothing
 * about file formats. Adding a source format is therefore a new parser and no
 * changes anywhere else.
 */

export type ImportFormat = 'dotenv' | 'json' | 'yaml' | 'shell';

export interface ParsedEntry {
  /** The key exactly as it appears in the source, before any normalisation. */
  key: string;
  value: string;
  /** 1-based line in the source, for error reporting in the UI. */
  line: number;
}

/**
 * A problem that did not stop the import.
 *
 * A warning message may name a key, a line, or a type — never a value. Warnings
 * are rendered in the browser, attached to support tickets, and pasted into
 * issue reports, so anything that reaches this string has effectively been
 * published.
 */
export interface ParseWarning {
  line: number;
  message: string;
}

export interface ParseResult {
  entries: ParsedEntry[];
  warnings: ParseWarning[];
}

/** What to do with a source key whose target name already exists. */
export type ConflictStrategy = 'skip' | 'overwrite' | 'rename';

export type ImportItemStatus = 'create' | 'overwrite' | 'skip' | 'rename' | 'invalid';

export interface ImportItem {
  sourceKey: string;
  /** Normalised, valid secret name. Empty only when `status` is `invalid`. */
  targetName: string;
  value: string;
  status: ImportItemStatus;
  /**
   * Populated when status is `invalid`, when the name was changed, or when a
   * conflict — not the source file — decided the outcome. Safe to display.
   */
  note?: string | undefined;
}

export interface ImportPlan {
  items: ImportItem[];
  warnings: ParseWarning[];
  counts: Record<ImportItemStatus, number>;
}

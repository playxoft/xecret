import { parseAllDocuments } from 'yaml';
import type { DocumentOptions, ParseOptions, SchemaOptions, ToJSOptions } from 'yaml';
import { flattenTree } from './json';
import type { ParseResult, ParseWarning } from './types';

/**
 * YAML config importer.
 *
 * Flattening and scalar coercion are imported from the JSON parser, not
 * reimplemented, so the same document in either format yields the same secrets.
 * What is specific to YAML is getting the *parse* right, because YAML has more
 * ways to surprise you than any other format here.
 */

const PARSE_OPTIONS: ParseOptions & DocumentOptions & SchemaOptions = {
  /**
   * YAML 1.2, explicitly. Under 1.1 — still the default in PyYAML and in plenty
   * of tooling — the bare word `NO` resolves to boolean false and `08` is an
   * invalid octal. A file with `region: NO` would import the country Norway as
   * `false`. 1.2 leaves both as the strings they look like.
   */
  version: '1.2',
  /**
   * Merge keys (`<<: *defaults`) are a 1.1 feature and off by default under
   * 1.2, but they are ubiquitous in the CI and Compose files people import
   * from, and resolving one is what the author plainly meant.
   */
  merge: true,
  /**
   * No custom tag resolvers. This parser will not construct anything but the
   * core schema's plain data, so a `!!python/object` or similar tag in an
   * uploaded file resolves to a string and is reported, never executed.
   */
  customTags: [],
  /** Problems are surfaced as warnings in the result, never written to stderr. */
  logLevel: 'silent',
};

const TO_JS_OPTIONS: ToJSOptions = {
  /**
   * Bounds alias expansion — the "billion laughs" attack, where a few hundred
   * bytes of nested aliases expand to gigabytes and take the process with them.
   * Expansion happens in `toJS`, not in the parse, which is why the bound lives
   * here. The library's default is the same value; stating it means a change to
   * that default cannot quietly remove the bound.
   */
  maxAliasCount: 100,
};

export function parseYaml(content: string): ParseResult {
  // A blank file is empty, not malformed. Without this the "no key/value pairs"
  // path below would report a document that does not exist.
  if (content.trim() === '') return { entries: [], warnings: [] };

  try {
    return parseDocuments(content);
  } catch (error) {
    // `yaml` reports malformed input through `doc.errors` rather than by
    // throwing, so this catches the cases it does not anticipate: an alias
    // count that only becomes apparent during expansion, a stack exhausted by
    // pathological nesting, or a future version of the library changing its
    // contract. "A parser for user-supplied files never throws" is not a
    // guarantee worth delegating to a dependency.
    return { entries: [], warnings: [documentWarning(error)] };
  }
}

function parseDocuments(content: string): ParseResult {
  const documents = parseAllDocuments(content, PARSE_OPTIONS);
  const first = documents[0];
  if (first === undefined) {
    return { entries: [], warnings: [{ line: 1, message: 'The document is empty.' }] };
  }

  const warnings: ParseWarning[] = [];
  for (const problem of [...first.errors, ...first.warnings]) {
    warnings.push({ line: problem.linePos?.[0].line ?? 1, message: problem.message });
  }

  /**
   * A duplicate key is a YAML error, not a last-wins situation. `.env` has a
   * universal convention for duplicates; YAML has none, so picking one of the
   * two values would be a guess — and the wrong guess silently imports the
   * wrong password. The whole document is rejected so the user fixes the file.
   */
  if (first.errors.length > 0) return { entries: [], warnings };

  if (documents.length > 1) {
    // Only the first document is imported, so say so. Parsing several documents
    // into one flat namespace would need a merge rule that YAML does not define.
    warnings.push({
      line: 1,
      message: `The file contains ${documents.length} YAML documents. Only the first was imported.`,
    });
  }

  // Aliases are expanded here, not during the parse, so this is where a
  // document that survived parsing can still blow the alias budget.
  const flattened = flattenTree(first.toJS(TO_JS_OPTIONS) as unknown);
  return { entries: flattened.entries, warnings: [...warnings, ...flattened.warnings] };
}

function documentWarning(error: unknown): ParseWarning {
  const message = error instanceof Error ? error.message : String(error);
  return { line: 1, message: `The file is not valid YAML: ${message}` };
}

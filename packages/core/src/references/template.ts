import { SECRET_NAME_MAX_LENGTH, SECRET_NAME_PATTERN } from '../validation/secret-name';
import { SLUG_MAX_LENGTH, SLUG_PATTERN } from '../validation/slug';

/**
 * The reference syntax: one secret's value pointing at another (P19 §1).
 *
 *     ${KEY}                 KEY, as the environment being read sees it
 *     ${env.KEY}             KEY in environment `env` of the same project
 *     ${project.env.KEY}     KEY in environment `env` of project `project`
 *     $${                    a literal `${`
 *
 * ── Why the syntax is only ever read from a template ──
 * Values are end-to-end encrypted (ADR 0009), so the server never sees one and
 * cannot tell whether a stored value contains `${…}`. Interpreting that text in
 * every value would silently change the meaning of secrets written long before
 * this feature existed — a shell snippet holding `${HOME}`, a connection string
 * that happens to contain the characters. So references are interpreted only in
 * a secret whose declared value type is `template`, and every writer of a
 * template states, in plaintext beside the ciphertext, exactly which references
 * the value contains. A secret of any other type is literal text, for ever.
 *
 * ── What a parse error may say ──
 * The offset and the rule, never the value. This module runs on plaintext, in a
 * browser and in the CLI, and an error message is the easiest place in a system
 * for a credential to escape into a log.
 *
 * The grammar is deliberately strict — no whitespace, no defaults, no nesting —
 * because a template is read by three implementations (this one, the Go CLI,
 * and the server's graph checker working from the declared list) and every
 * convenience is one more thing the three can disagree about.
 */

/** How many references one hop may follow before resolution gives up. */
export const MAX_REFERENCE_DEPTH = 5;

/**
 * How many ancestors an environment may have.
 *
 * Five, like the reference depth: each ancestor is one more grant to open and one
 * more layer of ciphertext on the hottest path in the product, and a chain past
 * five is a configuration nobody can hold in their head.
 */
export const MAX_INHERITANCE_DEPTH = 5;

/** How many distinct references one template may declare. */
export const MAX_REFERENCES_PER_SECRET = 50;

/**
 * One reference, as written in a template.
 *
 * `project` without `environment` is unrepresentable: the parser produces one,
 * two or three parts, and a two-part reference names an environment.
 */
export interface SecretReference {
  /** The project's slug. Absent means "the project of the secret holding this". */
  readonly project?: string | undefined;
  /** The environment's slug. Absent means "the environment being read". */
  readonly environment?: string | undefined;
  /** The secret's name. */
  readonly name: string;
}

export type TemplateSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'reference'; readonly reference: SecretReference };

/** Why a template could not be parsed. Never carries any part of the value. */
export class TemplateSyntaxError extends Error {
  constructor(
    message: string,
    /** The UTF-16 offset of the `${` that could not be read. */
    readonly offset: number,
  ) {
    super(message);
    this.name = 'TemplateSyntaxError';
  }
}

/**
 * Splits a template into literal text and references.
 *
 * Adjacent text is merged, so a template with no references parses to at most
 * one text segment — which is what lets a renderer treat "no references" and
 * "all text" as the same case.
 */
export function parseTemplate(value: string): TemplateSegment[] {
  const segments: TemplateSegment[] = [];
  let text = '';
  let index = 0;

  const flushText = (): void => {
    if (text !== '') segments.push({ kind: 'text', text });
    text = '';
  };

  while (index < value.length) {
    const char = value[index];

    // `$${` is the escape for a literal `${`. Checked before the reference case
    // so that `$${KEY}` is the text `${KEY}` rather than `$` followed by a
    // reference — the one ordering in which the escape means anything.
    if (char === '$' && value[index + 1] === '$' && value[index + 2] === '{') {
      text += '${';
      index += 3;
      continue;
    }

    if (char === '$' && value[index + 1] === '{') {
      const close = value.indexOf('}', index + 2);
      if (close === -1) {
        throw new TemplateSyntaxError(
          'A reference is opened with "${" and never closed with "}". Write "$${" for a literal "${".',
          index,
        );
      }

      const reference = parseReferenceBody(value.slice(index + 2, close), index);
      flushText();
      segments.push({ kind: 'reference', reference });
      index = close + 1;
      continue;
    }

    text += char;
    index += 1;
  }

  flushText();
  return segments;
}

function parseReferenceBody(body: string, offset: number): SecretReference {
  const parts = body.split('.');
  const invalid = (): TemplateSyntaxError =>
    new TemplateSyntaxError(
      'A reference must be ${KEY}, ${environment.KEY} or ${project.environment.KEY}, using ' +
        'slugs and a secret name with no spaces. Write "$${" for a literal "${".',
      offset,
    );

  if (parts.length < 1 || parts.length > 3) throw invalid();

  const name = parts[parts.length - 1] ?? '';
  if (name.length > SECRET_NAME_MAX_LENGTH || !SECRET_NAME_PATTERN.test(name)) throw invalid();

  const slugs = parts.slice(0, -1);
  for (const slug of slugs) {
    if (slug.length > SLUG_MAX_LENGTH || !SLUG_PATTERN.test(slug)) throw invalid();
  }

  if (slugs.length === 2) return { project: slugs[0], environment: slugs[1], name };
  if (slugs.length === 1) return { environment: slugs[0], name };
  return { name };
}

/**
 * Every distinct reference in a template, in order of first appearance.
 *
 * What a writer declares beside the ciphertext, and what a reader checks the
 * decrypted template against: the two lists must be the same set, or the
 * template is refused at read time rather than resolved against a graph the
 * server never validated.
 */
export function templateReferences(value: string): SecretReference[] {
  const seen = new Set<string>();
  const references: SecretReference[] = [];

  for (const segment of parseTemplate(value)) {
    if (segment.kind !== 'reference') continue;
    const key = referenceKey(segment.reference);
    if (seen.has(key)) continue;
    seen.add(key);
    references.push(segment.reference);
  }

  if (references.length > MAX_REFERENCES_PER_SECRET) {
    throw new TemplateSyntaxError(
      `A template may hold at most ${MAX_REFERENCES_PER_SECRET} distinct references.`,
      0,
    );
  }

  return references;
}

/**
 * A reference's identity: `project.environment.NAME`, `environment.NAME` or
 * `NAME` — exactly the text between the braces, which is unambiguous because
 * neither a slug nor a name may contain a dot.
 */
export function referenceKey(reference: SecretReference): string {
  if (reference.project !== undefined && reference.environment !== undefined) {
    return `${reference.project}.${reference.environment}.${reference.name}`;
  }
  if (reference.environment !== undefined) return `${reference.environment}.${reference.name}`;
  return reference.name;
}

/** The reference as it is written in a template, braces and all. */
export function formatReference(reference: SecretReference): string {
  return `\${${referenceKey(reference)}}`;
}

/**
 * Whether two reference lists name the same set.
 *
 * Order and duplicates are ignored: the declaration is a set, and a client that
 * happened to list them in a different order has declared the same thing.
 */
export function sameReferenceSet(
  a: readonly SecretReference[],
  b: readonly SecretReference[],
): boolean {
  const left = new Set(a.map(referenceKey));
  const right = new Set(b.map(referenceKey));
  if (left.size !== right.size) return false;
  for (const key of left) if (!right.has(key)) return false;
  return true;
}

/**
 * Re-escapes literal text so it survives a round trip through `parseTemplate`.
 *
 * Every `${` in the text becomes `$${`. Used when a renderer needs to write a
 * template back out from its segments.
 */
export function escapeTemplateText(text: string): string {
  // A function, not a replacement string: in a replacement string `$$` means
  // one dollar, so the obvious '$${' would write back exactly the '${' it
  // replaced, and the escape would silently do nothing.
  return text.replaceAll('${', () => '$${');
}

/**
 * XML well-formedness, checked without a parser dependency.
 *
 * ── Why hand-written ──
 * There is no `DOMParser` in a Worker, and pulling a full XML parser into the
 * bundle to answer one yes/no question about a config value is the wrong trade:
 * every byte here is shipped to the browser as well, because the same check runs
 * in the dashboard so a value is rejected before it is sent rather than after.
 *
 * ── What this promises, and what it does not ──
 * It checks **well-formedness**, in the XML 1.0 sense: one root element, every
 * start tag closed by a matching end tag in the right order, attributes quoted
 * and not repeated, and the special constructs (comments, CDATA, processing
 * instructions, the prolog and a `DOCTYPE`) closed properly.
 *
 * It does **not** check validity against a DTD or a schema, does not resolve
 * entities, and does not verify that a declared encoding matches the bytes. A
 * document this accepts is one a conforming parser will parse; it is not
 * necessarily one the consuming application will like. Every message below says
 * "well-formed" rather than "valid" for exactly that reason.
 */

/** Where a document stopped being well-formed, and why. */
export interface XmlProblem {
  message: string;
  /** 1-based, so it reads the way an editor's gutter does. */
  line: number;
}

/** Loosely XML's `Name` production: enough to reject `<1foo>` and `<a b>`. */
const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[A-Za-z0-9_:.-]/;

/**
 * Returns the first thing wrong with `source`, or `null` when it is well-formed.
 *
 * A single-pass scanner over the raw string. It deliberately does not build a
 * tree: the answer is a boolean and a reason, and materialising a document only
 * to discard it would be the expensive half of parsing done for nothing.
 */
export function checkXmlWellFormed(source: string): XmlProblem | null {
  const text = source.trim();
  if (text.length === 0) return { message: 'XML document is empty.', line: 1 };

  // Line numbers are resolved only when something is wrong — at most once per
  // document — so the scan itself carries no per-character bookkeeping. Counting
  // incrementally instead would have to account for every region the scanner
  // skips wholesale (comments, CDATA, a DOCTYPE subset), and getting one of
  // those wrong silently reports the wrong line rather than failing.
  const at = (offset: number): number => lineOf(text, offset);
  const fail = (message: string, offset: number): XmlProblem => ({ message, line: at(offset) });

  const stack: { name: string; offset: number }[] = [];
  let index = 0;
  let sawRoot = false;
  let rootClosed = false;

  while (index < text.length) {
    const open = text.indexOf('<', index);

    // Character data, either between two constructs or trailing the document.
    const gap = text.slice(index, open === -1 ? text.length : open);
    if (stack.length === 0 && gap.trim().length > 0) {
      return fail(
        sawRoot
          ? 'Text is not allowed after the root element.'
          : 'Text is not allowed before the root element.',
        index,
      );
    }
    if (open === -1) break;

    index = open;

    if (text.startsWith('<!--', index)) {
      const end = text.indexOf('-->', index + 4);
      if (end === -1) return fail('A comment is never closed.', index);
      index = end + 3;
      continue;
    }

    if (text.startsWith('<![CDATA[', index)) {
      const end = text.indexOf(']]>', index + 9);
      if (end === -1) return fail('A CDATA section is never closed.', index);
      index = end + 3;
      continue;
    }

    // `<?xml …?>` and any other processing instruction.
    if (text.startsWith('<?', index)) {
      const end = text.indexOf('?>', index + 2);
      if (end === -1) return fail('A processing instruction is never closed.', index);
      index = end + 2;
      continue;
    }

    // `<!DOCTYPE …>`, including a bracketed internal subset.
    if (text.startsWith('<!', index)) {
      const end = skipDeclaration(text, index);
      if (end === -1) return fail('A declaration is never closed.', index);
      index = end;
      continue;
    }

    const closing = text.startsWith('</', index);
    const tag = readTag(text, index);
    if (tag === null) return fail('A tag is never closed with “>”.', index);

    if (closing) {
      const expected = stack.pop();
      if (expected === undefined) {
        return fail(`Closing tag </${tag.name}> has no matching opening tag.`, index);
      }
      if (expected.name !== tag.name) {
        return fail(`Expected </${expected.name}> but found </${tag.name}>.`, index);
      }
      if (stack.length === 0) rootClosed = true;
      index = tag.end;
      continue;
    }

    if (rootClosed && stack.length === 0) {
      return fail('An XML document may only have one root element.', index);
    }

    const problem = describeTagProblem(tag);
    if (problem !== null) return fail(problem, index);

    sawRoot = true;
    if (!tag.selfClosing) stack.push({ name: tag.name, offset: index });
    index = tag.end;
  }

  const unclosed = stack[stack.length - 1];
  if (unclosed !== undefined) {
    return fail(`<${unclosed.name}> is never closed.`, unclosed.offset);
  }
  if (!sawRoot) return { message: 'XML document has no root element.', line: 1 };

  return null;
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  const limit = Math.min(offset, text.length);
  for (let i = 0; i < limit; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

interface Tag {
  name: string;
  /** Raw text between the name and the closing angle bracket. */
  attributes: string;
  selfClosing: boolean;
  /** Index just past the closing angle bracket. */
  end: number;
}

/**
 * Reads one tag starting at `<`.
 *
 * Quote-aware: a `>` inside an attribute value does not end the tag, which is
 * the whole difference between this and `indexOf('>')` — and the reason a URL
 * with a query string in an attribute does not produce a spurious error.
 */
function readTag(text: string, start: number): Tag | null {
  let at = start + (text.startsWith('</', start) ? 2 : 1);

  const nameStart = at;
  while (at < text.length && NAME_CHAR.test(text[at] as string)) at += 1;
  const name = text.slice(nameStart, at);

  const bodyStart = at;
  let quote: string | null = null;

  while (at < text.length) {
    const char = text[at] as string;

    if (quote !== null) {
      if (char === quote) quote = null;
      at += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      at += 1;
      continue;
    }

    if (char === '>') {
      const body = text.slice(bodyStart, at);
      const trimmed = body.trimEnd();
      const selfClosing = trimmed.endsWith('/');
      return {
        name,
        attributes: selfClosing ? trimmed.slice(0, -1) : body,
        selfClosing,
        end: at + 1,
      };
    }

    at += 1;
  }

  return null;
}

/** Name and attribute checks, applied to opening tags only. */
function describeTagProblem(tag: Tag): string | null {
  if (tag.name.length === 0 || !NAME_START.test(tag.name[0] as string)) {
    return 'Element names must start with a letter or underscore.';
  }

  const attributes = tag.attributes;
  const seen = new Set<string>();
  let at = 0;

  // A scanner rather than a global regex: the attribute list has to be consumed
  // left to right with nothing left over, and "did the pattern cover the whole
  // string?" is a question a `matchAll` loop cannot answer without stitching the
  // gaps back together by hand.
  while (at < attributes.length) {
    const char = attributes[at] as string;
    if (/\s/.test(char)) {
      at += 1;
      continue;
    }

    if (!NAME_START.test(char)) {
      return `<${tag.name}> has an attribute that is not well-formed.`;
    }

    const nameStart = at;
    while (at < attributes.length && NAME_CHAR.test(attributes[at] as string)) at += 1;
    const name = attributes.slice(nameStart, at);

    while (at < attributes.length && /\s/.test(attributes[at] as string)) at += 1;

    if (attributes[at] !== '=') {
      return `Attribute "${name}" needs a quoted value, as ${name}="…".`;
    }
    at += 1;

    while (at < attributes.length && /\s/.test(attributes[at] as string)) at += 1;

    const quote = attributes[at];
    if (quote !== '"' && quote !== "'") {
      return `Attribute "${name}" needs a quoted value, as ${name}="…".`;
    }

    const close = attributes.indexOf(quote, at + 1);
    if (close === -1) return `The value of attribute "${name}" is never closed.`;
    at = close + 1;

    if (seen.has(name)) return `Attribute "${name}" appears twice on <${tag.name}>.`;
    seen.add(name);
  }

  return null;
}

/**
 * Skips `<!DOCTYPE …>`, including a bracketed internal subset.
 *
 * Returns the index just past the closing `>`, or -1 when it is never closed.
 * The subset is skipped wholesale rather than parsed: entity declarations inside
 * it are exactly the construct this checker promises nothing about.
 */
function skipDeclaration(text: string, start: number): number {
  let at = start + 2;
  let depth = 0;

  while (at < text.length) {
    const char = text[at];
    if (char === '[') depth += 1;
    else if (char === ']') depth -= 1;
    else if (char === '>' && depth <= 0) return at + 1;
    at += 1;
  }

  return -1;
}

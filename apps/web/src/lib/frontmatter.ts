/**
 * The `---`-delimited header on every markdown file in this repository.
 *
 * A deliberately small parser rather than a YAML dependency: the fields are
 * fixed, the files are ours, and the shapes it accepts are `key: value` and
 * `key: [a, b, c]`. Anything else in a frontmatter block is a mistake that
 * should be noticed, so it throws rather than guessing.
 *
 * Shared by the documentation under `public/docs` and the blog under
 * `public/blog`. It lived inside the documentation loader until the blog
 * needed the same header; two copies of a parser is two definitions of what a
 * valid file looks like, and the second one always drifts.
 *
 * Every function here takes a `source` label — `docs/quickstart.md` — so that
 * a malformed file names itself in the build error rather than making somebody
 * grep for which of forty files broke.
 */

export type FrontmatterData = Record<string, string[]>;

export function parseFrontmatter(
  raw: string,
  source: string,
): { data: FrontmatterData; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) {
    throw new Error(`${source} has no frontmatter block.`);
  }

  const data: FrontmatterData = {};

  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;

    const separator = line.indexOf(':');
    if (separator === -1) {
      throw new Error(`${source} frontmatter line is not "key: value": ${line}`);
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();

    data[key] = value.startsWith('[')
      ? value
          .slice(1, value.endsWith(']') ? -1 : undefined)
          .split(',')
          .map(unquote)
          .filter((entry) => entry !== '')
      : [unquote(value)];
  }

  return { data, body: raw.slice(match[0].length) };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return /^(['"]).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

/** A field the file must carry. Throws at build time if it does not. */
export function required(data: FrontmatterData, key: string, source: string): string {
  const value = data[key]?.[0];
  if (!value) throw new Error(`${source} is missing frontmatter "${key}".`);
  return value;
}

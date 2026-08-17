/**
 * A deliberately small syntax highlighter for documentation code samples.
 *
 * ── Why not Shiki, Prism, or highlight.js ─────────────────────────────────
 * Every documentation page is prerendered, so highlighting runs at build time
 * — but the module that performs it is still linked into the Worker bundle,
 * which Cloudflare caps at 10 MB and this project budgets at 6 MB
 * (`scripts/check-bundle-size.mjs`). Shiki carries megabytes of TextMate
 * grammars and a WASM regex engine; highlight.js is ~1 MB with its languages.
 * Spending a fifth of the entire application's size budget on colouring code
 * samples is not a trade this product can make.
 *
 * What is here instead is ~200 lines covering the eight languages the
 * documentation actually uses. It is a lexer, not a parser: it will not
 * understand a nested template literal containing a comment. For `xecret run
 * -- npm run dev` and a twelve-line YAML job, that limit never shows.
 *
 * ── The safety rule ───────────────────────────────────────────────────────
 * Nothing here emits input it has not escaped. The scanner matches against the
 * *raw* source and escapes each fragment as it is appended, so there is no
 * window in which an unescaped `<` sits in the output buffer. Highlighting
 * escaped HTML instead — the usual shortcut — is how `&amp;` becomes a
 * "number" and how an injection eventually lands.
 */

/** A token class. Each maps to a `.tok-*` rule in `docs.css`. */
type TokenClass =
  | 'comment'
  | 'string'
  | 'number'
  | 'keyword'
  | 'literal'
  | 'prop'
  | 'type'
  | 'var'
  | 'flag'
  | 'section';

/**
 * A rule's pattern may not contain a capturing group.
 *
 * The scanner identifies which rule matched by the index of the first defined
 * group in the match, so one stray `(…)` inside a pattern silently shifts every
 * rule after it. Use `(?:…)` throughout.
 */
interface Rule {
  readonly cls: TokenClass;
  readonly pattern: string;
}

const STRING_SQ = String.raw`'(?:[^'\\\n]|\\.)*'`;
const STRING_DQ = String.raw`"(?:[^"\\\n]|\\.)*"`;
const NUMBER = String.raw`\b(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b`;
const NUMBER_SIGNED = String.raw`-?\b(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b`;

const SHELL_KEYWORDS =
  'if|then|elif|else|fi|for|while|until|do|done|case|esac|function|return|export|source|local|set|cd|echo|exit';

const JS_KEYWORDS =
  'import|export|from|as|default|const|let|var|function|return|async|await|class|extends|implements|interface|type|enum|new|this|super|if|else|for|while|do|switch|case|break|continue|try|catch|finally|throw|typeof|instanceof|in|of|delete|void|yield|satisfies|readonly|public|private|protected|static';

const GO_KEYWORDS =
  'package|import|func|return|var|const|type|struct|interface|map|chan|go|defer|select|if|else|for|range|switch|case|default|break|continue|fallthrough|goto';

const SQL_KEYWORDS =
  'SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP|ORDER|BY|LIMIT|OFFSET|CREATE|ALTER|DROP|TABLE|INDEX|GRANT|REVOKE|ROLE|VALUES|SET|INTO|AND|OR|NOT|NULL|AS|RETURNING';

/**
 * Ordered: whatever matches first at a given position wins, so comments and
 * strings must precede anything that could match inside one.
 */
const RULES: Record<string, readonly Rule[]> = {
  bash: [
    { cls: 'comment', pattern: String.raw`#[^\n]*` },
    { cls: 'string', pattern: `${STRING_DQ}|${STRING_SQ}` },
    { cls: 'var', pattern: String.raw`\$\{[^}\n]*\}|\$[A-Za-z_][A-Za-z0-9_]*` },
    { cls: 'flag', pattern: String.raw`(?<=\s)--?[A-Za-z][\w-]*` },
    { cls: 'keyword', pattern: String.raw`\b(?:${SHELL_KEYWORDS})\b` },
    { cls: 'number', pattern: NUMBER },
  ],

  json: [
    // A quoted string followed by a colon is a key, not a value. This rule must
    // come first or every key is coloured as a plain string.
    { cls: 'prop', pattern: `${STRING_DQ}(?=\\s*:)` },
    { cls: 'string', pattern: STRING_DQ },
    { cls: 'literal', pattern: String.raw`\b(?:true|false|null)\b` },
    { cls: 'number', pattern: NUMBER_SIGNED },
  ],

  yaml: [
    { cls: 'comment', pattern: String.raw`#[^\n]*` },
    { cls: 'string', pattern: `${STRING_DQ}|${STRING_SQ}` },
    // A key is the first word on its line, optionally after a list dash.
    // JavaScript permits a variable-length lookbehind, which is what keeps the
    // indentation out of the coloured span.
    { cls: 'prop', pattern: String.raw`(?<=^[ \t]*(?:-[ \t]+)?)[A-Za-z_][\w.-]*(?=\s*:)` },
    { cls: 'var', pattern: String.raw`\$\{\{[^}]*\}\}|\$\{[^}\n]*\}` },
    { cls: 'literal', pattern: String.raw`\b(?:true|false|null|yes|no|on|off)\b` },
    { cls: 'number', pattern: NUMBER },
  ],

  javascript: [
    { cls: 'comment', pattern: String.raw`//[^\n]*|/\*[\s\S]*?\*/` },
    { cls: 'string', pattern: '`(?:[^`\\\\]|\\\\.)*`|' + `${STRING_DQ}|${STRING_SQ}` },
    { cls: 'keyword', pattern: String.raw`\b(?:${JS_KEYWORDS})\b` },
    { cls: 'literal', pattern: String.raw`\b(?:true|false|null|undefined)\b` },
    { cls: 'type', pattern: String.raw`\b[A-Z][A-Za-z0-9_]*\b` },
    { cls: 'prop', pattern: String.raw`(?<=\.)[a-zA-Z_$][\w$]*` },
    { cls: 'number', pattern: NUMBER },
  ],

  go: [
    { cls: 'comment', pattern: String.raw`//[^\n]*|/\*[\s\S]*?\*/` },
    { cls: 'string', pattern: '`[^`]*`|' + `${STRING_DQ}|${STRING_SQ}` },
    { cls: 'keyword', pattern: String.raw`\b(?:${GO_KEYWORDS})\b` },
    { cls: 'literal', pattern: String.raw`\b(?:true|false|nil|iota)\b` },
    { cls: 'type', pattern: String.raw`\b(?:string|int|int64|bool|error|byte|rune|float64)\b` },
    { cls: 'number', pattern: NUMBER },
  ],

  // .env files, and the `ini`/`toml` shapes that read the same way.
  dotenv: [
    { cls: 'comment', pattern: String.raw`#[^\n]*` },
    { cls: 'section', pattern: String.raw`^\[[^\]\n]+\]` },
    { cls: 'prop', pattern: String.raw`^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*(?=\s*=)` },
    { cls: 'string', pattern: `${STRING_DQ}|${STRING_SQ}` },
    { cls: 'var', pattern: String.raw`\$\{[^}\n]*\}|\$[A-Za-z_][A-Za-z0-9_]*` },
  ],

  dockerfile: [
    { cls: 'comment', pattern: String.raw`#[^\n]*` },
    { cls: 'string', pattern: `${STRING_DQ}|${STRING_SQ}` },
    // Instructions are the first word on a line, and only there — `run` inside
    // a shell command is not one.
    {
      cls: 'keyword',
      pattern: String.raw`^(?:FROM|RUN|CMD|LABEL|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL)\b`,
    },
    { cls: 'flag', pattern: String.raw`(?<=\s)--[A-Za-z][\w-]*` },
    { cls: 'var', pattern: String.raw`\$\{[^}\n]*\}|\$[A-Za-z_][A-Za-z0-9_]*` },
  ],

  http: [
    { cls: 'comment', pattern: String.raw`#[^\n]*` },
    {
      cls: 'keyword',
      pattern: String.raw`^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b`,
    },
    { cls: 'prop', pattern: String.raw`^[A-Za-z][A-Za-z-]*(?=:\s)` },
    { cls: 'string', pattern: STRING_DQ },
    { cls: 'literal', pattern: String.raw`\bHTTP/\d(?:\.\d)?\b` },
    { cls: 'number', pattern: NUMBER },
  ],

  sql: [
    { cls: 'comment', pattern: String.raw`--[^\n]*` },
    { cls: 'string', pattern: STRING_SQ },
    { cls: 'keyword', pattern: String.raw`\b(?:${SQL_KEYWORDS})\b` },
    { cls: 'number', pattern: NUMBER },
  ],
};

/** Fence languages the documentation writes, mapped to the rule set that fits. */
const ALIASES: Record<string, keyof typeof RULES> = {
  bash: 'bash',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  json: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  js: 'javascript',
  jsx: 'javascript',
  ts: 'javascript',
  tsx: 'javascript',
  javascript: 'javascript',
  typescript: 'javascript',
  go: 'go',
  golang: 'go',
  env: 'dotenv',
  dotenv: 'dotenv',
  ini: 'dotenv',
  toml: 'dotenv',
  properties: 'dotenv',
  http: 'http',
  sql: 'sql',
  dockerfile: 'dockerfile',
  docker: 'dockerfile',
  makefile: 'bash',
  make: 'bash',
};

/**
 * How a fence's language is written on the block, where the tag it was written
 * with is not what a reader would recognise — `ts` as TypeScript, `env` as
 * `.env`, `sh` as shell.
 *
 * A module constant beside `ALIASES` and `RULES`, for the same reason they are:
 * this table is fixed, and building all twenty-two entries inside
 * `languageLabel` rebuilt it once per code fence, on every documentation page,
 * to perform one lookup.
 */
const LABELS: Record<string, string> = {
  bash: 'bash',
  sh: 'shell',
  shell: 'shell',
  console: 'shell',
  js: 'JavaScript',
  jsx: 'JSX',
  ts: 'TypeScript',
  tsx: 'TSX',
  json: 'JSON',
  jsonc: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  go: 'Go',
  env: '.env',
  dotenv: '.env',
  http: 'HTTP',
  sql: 'SQL',
  toml: 'TOML',
  ini: 'INI',
  dockerfile: 'Dockerfile',
  docker: 'Dockerfile',
  makefile: 'Makefile',
  make: 'Makefile',
  text: 'text',
  txt: 'text',
};

/**
 * A table's own entry for a key, never one it inherited.
 *
 * `LABELS` and `ALIASES` are object literals, so both inherit from
 * `Object.prototype`, and the key they are asked for is whatever an author
 * typed after three backticks. A fence tagged `constructor` reads the `Object`
 * function out of that prototype instead of `undefined`; `??` never fires,
 * because a function is not nullish; and `languageLabel` returns it.
 * `markdown.ts` then hands that function to `escapeHtml`, which calls
 * `.replace` on it and throws `value.replace is not a function`. Every
 * documentation page is prerendered, so what that costs is `next build`, for a
 * fence tag nobody would look at twice. `__proto__` is the same hole with a
 * worse payload — the getter hands back the prototype object itself.
 *
 * `RULES` is indexed directly below because its key is not the author's: it is
 * a value `ALIASES` declares, and every one of those names a rule set here.
 */
function ownEntry<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The label shown on a code block, or null when the fence named no language. */
export function languageLabel(lang: string | undefined): string | null {
  if (!lang) return null;
  return ownEntry(LABELS, lang.toLowerCase()) ?? lang;
}

/**
 * Returns HTML-escaped code with `<span class="tok-*">` wrappers.
 *
 * An unknown language is escaped and returned unhighlighted, which is the right
 * answer for a diagram or a directory tree in a fenced block.
 */
export function highlight(code: string, lang: string | undefined): string {
  const alias = lang ? ownEntry(ALIASES, lang.toLowerCase()) : undefined;
  const rules = alias === undefined ? undefined : RULES[alias];
  if (!rules) return escapeHtml(code);

  const scanner = new RegExp(rules.map((rule) => `(${rule.pattern})`).join('|'), 'gm');

  let out = '';
  let cursor = 0;

  for (const match of code.matchAll(scanner)) {
    const index = match.index;
    // `matchAll` on a pattern that can match empty would loop; none here can,
    // but a zero-length match would still produce an empty span for nothing.
    if (match[0] === '') continue;

    // Group n+1 belongs to rule n, and exactly one of them is defined.
    const rule = rules.find((_, n) => match[n + 1] !== undefined);
    if (!rule) continue;

    out += escapeHtml(code.slice(cursor, index));
    out += `<span class="tok-${rule.cls}">${escapeHtml(match[0])}</span>`;
    cursor = index + match[0].length;
  }

  out += escapeHtml(code.slice(cursor));
  return out;
}

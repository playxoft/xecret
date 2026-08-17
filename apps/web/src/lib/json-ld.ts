/**
 * Serialising structured data into a `<script type="application/ld+json">`.
 *
 * `JSON.stringify` produces valid JSON, and inside a `<script>` element valid
 * JSON is not enough. The HTML tokenizer is not reading JSON: it scans the
 * element's text for `</script`, and the first one it finds ends the block —
 * including one sitting in the middle of a string, where JSON says it is just
 * two characters of a sentence. A page whose structured data quotes a document
 * saying `</script><script>…` therefore closes the data block and opens a real
 * one, in a prerendered HTML file, with the payload already in place before any
 * JavaScript has run.
 *
 * That is not a theoretical route into this application's pages. The FAQ's
 * answers are extracted from rendered markdown and entity-decoded on the way,
 * so `&lt;/script&gt;` written in a `.md` file — which contains no tag at all,
 * and which the renderer is right to escape — becomes a literal `</script>` by
 * the time it reaches here. So do a frontmatter `title` and `description`.
 *
 * Escaping `<` is the whole of the fix: every sequence the tokenizer reacts to
 * inside a script element (`</script`, `<!--`) begins with one, and `<` is
 * the same character to every JSON parser, so a crawler reads exactly what was
 * written. `>` and `&` follow it not because this context needs them but
 * because the next one might: they cost two replacements and remove the need
 * for whoever moves this string to have been right about where it landed.
 */
export function jsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

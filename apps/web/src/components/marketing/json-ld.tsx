/**
 * A `schema.org` graph, serialised into the page.
 *
 * Every public page emits one of these. Wrapping it in a component rather than
 * writing the `<script>` at each call site is not tidiness: it puts the
 * justification for `dangerouslySetInnerHTML` in one place, where it can be
 * checked, instead of in eight places where it would be copied.
 *
 * `JSON.stringify` is what makes this safe. The graph is built from module
 * constants and repository content, and stringify escapes the result into
 * valid JSON — but the one sequence it does not escape is `</script>` inside a
 * string, which would close this element early and turn the rest of the graph
 * into markup. So that sequence is broken here, as it must be for any JSON
 * embedded in HTML.
 */
export function JsonLd({ data }: { data: unknown }) {
  const json = JSON.stringify(data).replace(/<\//g, '<\\/');

  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}

/**
 * Wraps a list of schema objects into the `@graph` every page publishes,
 * pointing at the site-wide `Organization` and `WebSite` emitted by the root
 * layout rather than restating them.
 */
export function graph(...nodes: unknown[]) {
  return { '@context': 'https://schema.org', '@graph': nodes };
}

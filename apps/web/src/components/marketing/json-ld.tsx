import { jsonLd } from '@/lib/json-ld';

/**
 * A `schema.org` graph, serialised into the page.
 *
 * Every public page emits one of these. Wrapping it in a component rather than
 * writing the `<script>` at each call site is not tidiness: it puts the
 * justification for `dangerouslySetInnerHTML` in one place, where it can be
 * checked, instead of in eight places where it would be copied.
 *
 * The escaping itself lives in `lib/json-ld.ts` and is deliberately not
 * repeated here. This component started with its own one-line escape — break
 * `</` and nothing else — which is enough for the sequence everybody thinks of
 * and misses `<!--`, the other thing the HTML tokenizer reacts to inside a
 * script element. Two escapers for one hazard is how the weaker one ends up on
 * the page that needed the stronger one; `/docs` already called the shared
 * function, so the component came to it rather than the other way round.
 */
export function JsonLd({ data }: { data: unknown }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(data) }} />;
}

/**
 * Wraps a list of schema objects into the `@graph` every page publishes,
 * pointing at the site-wide `Organization` and `WebSite` emitted by the root
 * layout rather than restating them.
 */
export function graph(...nodes: unknown[]) {
  return { '@context': 'https://schema.org', '@graph': nodes };
}

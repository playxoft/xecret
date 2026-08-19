/**
 * Watch an element until it is first scrolled into view, then stop.
 *
 * Both scroll-triggered things on the public site want the same three
 * behaviours and had each written their own: fire once, disconnect, and do
 * something sensible where `IntersectionObserver` does not exist. The third is
 * the one worth centralising — the fallback is not "no animation", it is
 * "show the content", and a version of this that got it wrong would leave a
 * panel blank forever on older Safari and in anything headless.
 *
 * ── Why `rootMargin` and not `threshold` ──
 * A ratio threshold is a trap for an element that can be taller than the
 * viewport: the ratio is `visible / total`, so a panel three times the window
 * height can never report more than 0.33 however hard the reader stares at it,
 * and a `threshold: 0.5` on it simply never fires. Expressing "far enough in
 * to count" as a negative `rootMargin` — a band inset from the viewport edges
 * — is independent of the element's own size, so it behaves the same at 400%
 * zoom on a 320px window as it does on a desktop.
 *
 * @param element The element to watch.
 * @param onEnter Called at most once, when the element first meets `options`.
 * @param options Passed to the observer. Defaults to firing as soon as any
 *   part of the element crosses the viewport edge.
 * @returns A cleanup function; safe to call whether or not the callback ran.
 */
export function observeOnce(
  element: Element,
  onEnter: () => void,
  options: IntersectionObserverInit = {},
): () => void {
  // No observer — older Safari, jsdom, anything headless. The gate is the
  // optional part; the content behind it is not, so the caller is told to
  // proceed rather than left waiting for an event that can never arrive.
  if (typeof IntersectionObserver !== 'function') {
    onEnter();
    return () => {};
  }

  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    onEnter();
    observer.disconnect();
  }, options);

  observer.observe(element);
  return () => observer.disconnect();
}

/**
 * Is this element already on screen, right now?
 *
 * Asked once, synchronously, before an observer is set up — which an observer
 * cannot answer for you: its first callback reports the current state whether
 * the element was on screen at load or has just been scrolled to, and those
 * two cases deserve opposite treatment when a server-rendered element is about
 * to be animated. See the `plan` note in `install-guide.tsx`.
 *
 * Deliberately lenient — any pixel on screen counts. It is asked in order to
 * decide whether blanking something would be destructive, and the cost of a
 * false negative there is erasing what somebody is reading, while the cost of
 * a false positive is only that an animation does not play. An earlier version
 * took an inset so this could be asked as strictly as an `observeOnce` band;
 * it was the wrong knob, because matching the two is not the goal.
 */
export function isInViewport(element: Element): boolean {
  const box = element.getBoundingClientRect();
  const height = window.innerHeight || document.documentElement.clientHeight;
  const width = window.innerWidth || document.documentElement.clientWidth;
  return box.top < height && box.bottom > 0 && box.left < width && box.right > 0;
}

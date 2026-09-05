'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { armLeaveGuard, interceptedHref, isPlainLeftClick } from './leave-guard';

import { ConfirmDialog } from './confirm-dialog';

/**
 * Stands between unsaved work and every way of walking away from it.
 *
 * ── Why this is not just `beforeunload` ──
 * `beforeunload` catches a reload, a closed tab and a typed URL, and nothing
 * else. Inside the app almost every departure is a client-side navigation —
 * clicking another environment in the switcher, a project in the sidebar, the
 * breadcrumb back to the organisation, the Back button — and the browser has no
 * idea any of that happened. So there are three guards here doing three
 * different jobs, and the two in-app ones are where the friendly message lives:
 * the browser's own dialog is fixed text no site has been able to customise for
 * a decade.
 *
 * ── Links ──
 * A capture-phase listener on the document, so it runs before `next/link`'s own
 * click handler and can stop the navigation before the router has started one.
 * It only speaks for a plain left click on a same-origin anchor going somewhere
 * else: a modified click (new tab), a download, an external link, an in-page
 * anchor and anything already handled are all left alone — a new tab does not
 * take the unsaved work anywhere.
 *
 * The App Router has no navigation-blocking API to use instead. `Link` takes an
 * `onNavigate` that can `preventDefault()`, but that is per-link and would mean
 * every anchor in the product opting in to a rule that belongs to one screen.
 *
 * ── Back, and the decoy ──
 * `popstate` cannot be cancelled: by the time it fires the browser has already
 * moved and the router has already begun rendering the previous route. The only
 * way to be *asked* first is to make sure the entry Back lands on is this page
 * again — so the first time there is something to lose, this pushes a second
 * history entry pointing at the URL the user is already on.
 *
 * Back then consumes that decoy and lands on an identical URL: the router
 * re-renders the same route, nothing on screen changes, no component unmounts
 * and no staged work is touched. The handler immediately pushes the decoy back
 * on — so Back is armed again for the next press — and asks the question. Answer
 * "leave" and it goes back two entries, which is the one the user was reaching
 * for; answer "stay" and the stack is exactly where it started.
 *
 * ── What the decoy costs, and how it is paid back ──
 * A duplicate entry on the history stack. Left there, it would turn one Back
 * press after the work is saved into a press that appears to do nothing. So it
 * is spent rather than abandoned: once there is nothing to protect, a Back press
 * that consumes the decoy is followed through with a second `back()`, and a link
 * click *replaces* the decoy instead of pushing on top of it. Either way the
 * stack ends up as though the decoy had never existed.
 *
 * It is armed once and never re-armed while this stays mounted. Arming and
 * disarming as the work comes and goes would write to the history API on every
 * keystroke that happened to stage or un-stage a change, and `history.back()` is
 * asynchronous — a change typed while a disarming pop was still in flight would
 * leave the ref and the real stack disagreeing about what is on it.
 *
 * And it is not armed at all where there is nothing behind this page — a tab
 * opened straight onto the environment from a bookmark or a link. Back is
 * already a no-op there, or a departure from the site that `beforeunload`
 * catches, and a decoy would turn a dead button into a live one that asks a
 * question and then goes nowhere.
 */
export interface UnsavedChangesGuardProps {
  /** Whether there is anything to lose. Everything here is inert when false. */
  when: boolean;
  /** What the dialog calls the work — "3 unsaved changes". */
  description: string;
  /**
   * Whether the batch is going out right now.
   *
   * `when` stays true for the whole of a save — the rows are still pending
   * until each one lands — so without this the dialog told a user watching
   * eight of twenty writes succeed that nothing had been written yet.
   */
  writing?: boolean | undefined;
}

/** Where the user was going when they were stopped. */
type Departure = { kind: 'link'; href: string } | { kind: 'back' };

export function UnsavedChangesGuard({
  when,
  description,
  writing = false,
}: UnsavedChangesGuardProps) {
  const router = useRouter();
  const [pending, setPending] = useState<Departure | null>(null);

  /**
   * The latest-ref pattern, so the listeners below can be registered once and
   * still read the current answer. Re-registering them on every change of
   * `when` would be harmless; re-registering them on every change of a *ref*
   * is not possible, and both listeners need to read `decoyArmed` as well.
   */
  const armed = useRef(when);
  // Written in an effect with no dependency list rather than during render —
  // the same latest-ref pattern `ValueField` uses, and the only one React
  // sanctions for keeping a ref in step with a prop.
  useEffect(() => {
    armed.current = when;
  });

  /** Whether this page is sitting on a decoy entry it pushed. */
  const decoy = useRef(false);
  /** Whether the decoy has been attempted at all — see the effect that pushes it. */
  const considered = useRef(false);
  /** Set while this component is itself driving the history, so it ignores the pop. */
  const unwinding = useRef(false);

  // Reload, tab close, typed URL, external link. The browser shows its own
  // wording and ignores ours — passing a string here has done nothing in any
  // current browser for years — so the only job is to say that the page is not
  // ready to go. `preventDefault` is the spec's way of asking; `returnValue` is
  // what older engines still read.
  useEffect(() => {
    if (!when) return;

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      // Except when this component is the one navigating. Answering "leave and
      // lose them" and then being asked "leave site?" by the browser is the same
      // question twice, and the second one is the one nobody can act on.
      if (unwinding.current) return;
      event.preventDefault();
      // Non-empty deliberately: the legacy path is specified to fire only when
      // `returnValue` is *not* the empty string, so assigning one asks the older
      // engines this line exists for precisely nothing. The text is never shown.
      event.returnValue = 'unsaved';
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [when]);

  // The decoy, pushed the first time there is anything to lose. Same URL, and
  // the router's own history state is carried over rather than replaced: this
  // entry has to be indistinguishable from the one under it, because landing on
  // it must not look like a navigation.
  useEffect(() => {
    if (!when || considered.current) return;
    considered.current = true;

    // Asked *before* pushing. `history.back()` moves the pointer, it does not
    // remove the entry, so pushing a decoy and then retracting it left a
    // duplicate-URL entry sitting forward of the user with the Forward button
    // newly lit — pressing it landed on the decoy and appeared to do nothing.
    // `length` counts the current entry, so nothing behind means exactly one.
    if (window.history.length < 2) return;

    window.history.pushState(window.history.state, '', window.location.href);

    decoy.current = true;
  }, [when]);

  useEffect(() => {
    const onPopState = () => {
      // A pop this component asked for. It has already decided what it means.
      // Checked first, before the decoy: the follow-through below clears the
      // decoy *and then* pops, so a flag read after that guard would never be
      // cleared and would swallow the user's next Back press.
      if (unwinding.current) {
        unwinding.current = false;
        decoy.current = false;
        return;
      }

      if (!decoy.current) return;

      // The decoy has just been consumed by a Back press.
      decoy.current = false;

      if (!armed.current) {
        // Nothing left to protect — the work was saved or discarded. The press
        // was meant for the entry *behind* the decoy, so finish the job rather
        // than leaving the user on a page that did not appear to move.
        unwinding.current = true;
        window.history.back();
        return;
      }

      // Put it back, so this press can be undone and the next one is caught
      // too, and ask the question.
      decoy.current = true;
      window.history.pushState(window.history.state, '', window.location.href);
      setPending({ kind: 'back' });
    };

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (!armed.current && !decoy.current) return;
      // The two rules this decision rests on live in `leave-guard.ts`, pure and
      // tested; what stays here is the DOM the rules need answers about.
      if (!isPlainLeftClick(event)) return;

      const target = event.target;
      if (!(target instanceof Element)) return;

      const anchor = target.closest('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;

      const href = interceptedHref(
        {
          href: anchor.href,
          hasDownload: anchor.hasAttribute('download'),
          target: anchor.target,
        },
        window.location.href,
      );
      if (href === null) return;

      // `preventDefault` alone. `Link` checks `defaultPrevented` before routing
      // (verified in next@16.3.3, `client/app-dir/link.js`), so stopping the
      // event as well bought nothing and cost a great deal: this listener is on
      // `document` in the capture phase, so `stopPropagation` keeps the click
      // from ever reaching React’s root. Radix menu items select on a
      // React `onClick`, so an environment chosen from the switcher’s overflow
      // menu never selected and the menu stayed open — modal, focus-trapped, and
      // `pointer-events: none` on the body — behind the dialog asking about it.
      event.preventDefault();
      if (armed.current) {
        setPending({ kind: 'link', href });
        return;
      }

      // Nothing to protect, but this page is standing on the decoy — a
      // duplicate of the entry beneath it. Replacing it rather than pushing on
      // top of it is what leaves the stack looking as though the decoy had never
      // been there; pushing would cost the user a Back press that goes nowhere.
      decoy.current = false;
      router.replace(href);
    };

    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [router]);

  // Derived rather than stored: saving or discarding while the dialog is open
  // answers the question it was asking, and leaving it up over a table with
  // nothing pending would ask the user to decide about work that no longer
  // exists.
  //
  // The destination has to go with it. Radix is not told when a controlled
  // `open` falls to false, so `onOpenChange` does not fire and nothing else
  // clears it — and a kept destination is not inert, it is waiting. The save
  // that closed this dialog leaves it armed; the next character typed turns
  // `when` back on, and the dialog returns unbidden over a fresh edit offering
  // to throw it away and follow a link clicked minutes ago. For a `back` it is
  // worse: `go(-2)` against history nobody remembers.
  const [guarding, setGuarding] = useState(when);
  if (guarding !== when) {
    setGuarding(when);
    if (!when) setPending(null);
  }

  const asking = when && pending !== null;

  useEffect(() => {
    if (!when) return;
    return armLeaveGuard((href) => setPending({ kind: 'link', href }));
  }, [when]);

  function leave() {
    const destination = pending;
    setPending(null);
    if (destination === null) return;

    if (destination.kind === 'back') {
      // Two, not one: the decoy was pushed back on when the press was caught, so
      // the entry the user was reaching for is behind both of them.
      unwinding.current = true;
      window.history.go(-2);
      return;
    }

    // `replace`, for the same reason as in the click handler: this page is
    // standing on the decoy, and the new page belongs where the decoy is.
    if (decoy.current) {
      decoy.current = false;
      router.replace(destination.href);
      return;
    }

    router.push(destination.href);
  }

  return (
    <ConfirmDialog
      open={asking}
      onOpenChange={(open) => (open ? undefined : setPending(null))}
      title="You have unsaved changes"
      description={
        writing
          ? `${description} Some of them are being written right now — leaving does not stop the rest, and you will not see how it ended.`
          : `${description} Leaving this page now throws them away — nothing has been written yet.`
      }
      confirmLabel="Leave and lose them"
      cancelLabel="Stay on this page"
      onConfirm={leave}
    />
  );
}

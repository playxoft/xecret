'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';
import { CopyButton } from '@/components/ui/copy-button';
import { ArrowRightIcon, TerminalIcon } from '@/components/ui/icons';

/**
 * The install guide: four ways onto the machine, each typed out.
 *
 * Same rule as the hero's `CliDemo`, and for the same reason — every line that
 * is not a command is real output, copied from the source that prints it:
 *
 *   - `downloading…` / `verifying checksum…` / `installed …` are the `say`
 *     calls in `scripts/install-cli.sh`;
 *   - `credential store: OS keychain` and `signed in as …, organisation …`
 *     are `xecret doctor`'s checks, from `cli/cmd/xecret/doctor.go`;
 *   - the version line is `buildinfo.String()`;
 *   - the two login lines are the same ones the hero already shows.
 *
 * Only the values are illustrative — the organisation, the email, the version
 * and the commit — exactly as in the hero. An install page that showed output
 * the installer does not print would be the one lie on the page whose whole
 * job is to be checkable.
 *
 * Deliberately not a `<Tabs>` from `components/ui`: that is Radix, and this is
 * a prerendered public page that should not pull the dashboard's dependency
 * for one row of four buttons. The tab pattern itself is here in full —
 * roving tabindex, arrow keys, Home/End — because that is what the row is,
 * and half a tab pattern is worse than none.
 *
 * Reduced motion is a first-class path, not a degradation: the transcript
 * renders whole and the type-out never starts.
 */

type Line =
  | { kind: 'command'; text: string }
  | { kind: 'success'; text: string }
  | { kind: 'info'; text: string }
  | { kind: 'comment'; text: string }
  /** A file being shown rather than a session — the Dockerfile. */
  | { kind: 'file'; text: string }
  | { kind: 'blank' };

interface Channel {
  id: string;
  /** The tab's label. */
  label: string;
  /** What the panel is showing — a shell, or a filename. */
  source: string;
  /**
   * The footer's action, for the two channels whose transcript cannot carry
   * one itself. Every `command` line already has its own copy button, so
   * macOS and Linux need nothing here — a second button copying the same
   * string is just a second thing to read.
   *
   * Docker's panel is a file rather than a session, so the unit worth copying
   * is the whole snippet; Windows has no text to hand over at all — its
   * install is "download this archive" — so it links to the releases page.
   */
  copy?: { value: string; label: string };
  link?: { href: string; label: string };
  /**
   * Where the credential ends up, in this platform's own words. A sentence per
   * channel rather than one template with the destination slotted in: Docker
   * has no keyring at all, and the shared tail ("never in a dotfile") is
   * nonsense on the one channel that never stores a credential.
   */
  note: ReactNode;
  script: readonly Line[];
}

/** The tail three of the four channels share. */
function KeychainNote({ where }: { where: string }) {
  return (
    <>
      The credential lives in <span className="text-fg-muted">{where}</span> — never in a dotfile
      you might commit or sync.
    </>
  );
}

const VERSION = 'v1.2.0';
const COMMIT = '9f3c1ab';
const BUILT = '2026-08-16';

function buildChannels(installUrl: string, releasesUrl: string): readonly Channel[] {
  const DOCKERFILE = [
    'FROM alpine:3 AS xecret',
    'RUN apk add --no-cache curl \\',
    ` && curl -fsSL ${installUrl} | sh`,
    '',
    'FROM node:22-slim',
    'COPY --from=xecret /usr/local/bin/xecret /usr/local/bin/xecret',
  ];

  return [
    {
      id: 'macos',
      label: 'macOS',
      source: 'zsh',
      note: <KeychainNote where="the macOS Keychain" />,
      script: [
        { kind: 'command', text: 'brew install playxoft/tap/xecret' },
        { kind: 'command', text: 'xecret login' },
        { kind: 'info', text: 'Opening your browser to approve this device…' },
        { kind: 'success', text: 'Signed in as dev@acme.dev (organisation acme)' },
        { kind: 'command', text: 'xecret doctor' },
        { kind: 'success', text: 'credential store: OS keychain' },
        { kind: 'success', text: 'signed in as dev@acme.dev, organisation acme' },
      ],
    },
    {
      id: 'linux',
      label: 'Linux & WSL',
      source: 'bash',
      note: <KeychainNote where="Secret Service, your desktop keyring" />,
      script: [
        { kind: 'command', text: `curl -fsSL ${installUrl} | sh` },
        { kind: 'info', text: `downloading xecret ${VERSION} for linux/amd64…` },
        { kind: 'info', text: 'verifying checksum…' },
        { kind: 'info', text: 'installed /usr/local/bin/xecret' },
        { kind: 'command', text: 'xecret login' },
        { kind: 'info', text: 'Opening your browser to approve this device…' },
        { kind: 'success', text: 'Signed in as dev@acme.dev (organisation acme)' },
      ],
    },
    {
      id: 'windows',
      label: 'Windows',
      source: 'PowerShell',
      link: { href: releasesUrl, label: 'Releases' },
      note: <KeychainNote where="Windows Credential Manager" />,
      script: [
        { kind: 'comment', text: '# Unzip the windows_amd64 archive from the releases' },
        { kind: 'comment', text: '# page and put xecret.exe on your PATH' },
        { kind: 'command', text: 'xecret version' },
        {
          kind: 'info',
          text: `xecret ${VERSION} (commit ${COMMIT}, built ${BUILT}, windows/amd64, go1.24.0)`,
        },
        { kind: 'command', text: 'xecret login' },
        { kind: 'info', text: 'Opening your browser to approve this device…' },
        { kind: 'success', text: 'Signed in as dev@acme.dev (organisation acme)' },
      ],
    },
    {
      id: 'docker',
      label: 'Docker',
      source: 'Dockerfile',
      copy: { value: DOCKERFILE.join('\n'), label: 'the Dockerfile snippet' },
      note: (
        <>
          No credential on the image at all: CI passes a{' '}
          <span className="text-fg-muted">scoped service token</span> as XECRET_TOKEN, and the
          keyring is never touched.
        </>
      ),
      // Built from the same array the copy button hands over, so the panel and
      // the clipboard cannot drift apart.
      script: DOCKERFILE.map((text) =>
        text === '' ? ({ kind: 'blank' } as const) : ({ kind: 'file', text } as const),
      ),
    },
  ] as const;
}

/**
 * Milliseconds per typed character.
 *
 * Faster than the hero's 45ms, deliberately. The hero's transcript is the
 * first thing on the page and has the whole screen to itself, so it can take
 * its time; this one is four sections down, in front of a reader who has
 * already decided to look for their own platform and wants the line, not the
 * performance. Under a second for the longest command here.
 */
const TICK_MS = 20;
/**
 * Ticks a finished command or an output line stays current before the next.
 *
 * Raised as the tick shrank: dwell is counted in ticks, so halving `TICK_MS`
 * alone would have halved the pause between output lines too, and those are
 * read rather than watched.
 */
const DWELL_TICKS = 9;

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function hasIntersectionObserver(): boolean {
  return typeof IntersectionObserver === 'function';
}

function subscribeReducedMotion(callback: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener('change', callback);
  return () => query.removeEventListener('change', callback);
}

interface Progress {
  line: number;
  ticks: number;
}

export interface InstallGuideProps {
  /** `/install.sh` on this deployment — the page passes it so that the origin
   *  is resolved on the server and `lib/site` stays out of the client bundle. */
  installUrl: string;
  /** The releases page, for the one platform without a one-line install. */
  releasesUrl: string;
  className?: string;
}

export function InstallGuide({ installUrl, releasesUrl, className }: InstallGuideProps) {
  const channels = useMemo(() => buildChannels(installUrl, releasesUrl), [installUrl, releasesUrl]);

  // The server snapshot says "reduced", so prerendering — and any visitor
  // without JavaScript — gets the complete transcript rather than an empty
  // terminal waiting for an animation that will never run.
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => true,
  );

  const [active, setActive] = useState(0);
  const [progress, setProgress] = useState<Progress>({ line: 0, ticks: 0 });
  const [seen, setSeen] = useState(false);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const panelRef = useRef<HTMLDivElement>(null);

  // The hero's demo can start on mount because it is on screen at load. This
  // one is four sections down, so a timer that starts on mount plays to nobody
  // and the reader arrives at the last frame of an animation they never saw.
  // It waits to be looked at.
  useEffect(() => {
    const element = panelRef.current;
    if (!element || !hasIntersectionObserver()) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setSeen(true);
          observer.disconnect();
        }
      },
      // A third of the panel, so the type-out begins once it is genuinely in
      // view rather than as its top edge clips the fold.
      { threshold: 0.33 },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const channel = channels[active] as Channel;
  const script = channel.script;

  /** This run intends to type the transcript out rather than print it. */
  const willAnimate = !reducedMotion;
  // An environment with no observer — older Safari, anything headless — never
  // gets a "seen" event, so it counts as having seen it. The gate is the
  // optional part; the transcript is not, and a panel that stayed blank
  // forever would be the one failure mode worth avoiding here.
  const observed = seen || !hasIntersectionObserver();
  /** …and is doing so now, the panel having been scrolled to. */
  const animating = willAnimate && observed;
  const finished = progress.line >= script.length;

  useEffect(() => {
    if (!animating || finished) return;

    const timer = setInterval(() => {
      setProgress((current) => {
        const line = script[current.line];
        if (line === undefined) return current;

        const lifetime =
          line.kind === 'command'
            ? line.text.length + DWELL_TICKS
            : line.kind === 'blank'
              ? 1
              : DWELL_TICKS;

        if (current.ticks < lifetime) {
          return { line: current.line, ticks: current.ticks + 1 };
        }
        return { line: current.line + 1, ticks: 0 };
      });
    }, TICK_MS);

    return () => clearInterval(timer);
  }, [animating, finished, script]);

  function selectTab(index: number) {
    setActive(index);
    // Replaying from the top is the point of switching: the reader picked this
    // tab to watch *this* install happen, not to arrive at its last frame.
    setProgress({ line: 0, ticks: 0 });
  }

  /** Arrow keys move between tabs and activate as they go, which is the
   *  expected behaviour for a tab set whose panels are already loaded. */
  function onTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = channels.length - 1;
    const next =
      event.key === 'ArrowRight'
        ? index === last
          ? 0
          : index + 1
        : event.key === 'ArrowLeft'
          ? index === 0
            ? last
            : index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;

    if (next === null) return;
    event.preventDefault();
    selectTab(next);
    tabRefs.current[next]?.focus();
  }

  // Until the media query has answered, and whenever motion is reduced, the
  // whole transcript is shown — the animated version is the optional extra.
  //
  // Note this asks `willAnimate`, not `animating`: between hydration and the
  // panel being scrolled to, the run *intends* to animate and is simply
  // waiting, so the transcript is empty rather than complete. Asking
  // `animating` here would print the whole thing and then wipe it the moment
  // the observer fired.
  const visibleCount = willAnimate ? progress.line : script.length;
  const done = visibleCount >= script.length;

  return (
    <div
      ref={panelRef}
      className={cn(
        'border-line bg-surface shadow-raised overflow-hidden rounded-xl border',
        className,
      )}
    >
      {/* The tab row doubles as the terminal's title bar — one strip rather
          than a row of pills above a separate window, which would read as two
          controls for one thing. */}
      <div
        role="tablist"
        aria-label="Platform"
        className="border-line-subtle bg-canvas-inset flex flex-wrap items-center gap-1 border-b px-2 py-2"
      >
        {channels.map((entry, index) => (
          <button
            key={entry.id}
            ref={(node) => {
              tabRefs.current[index] = node;
            }}
            type="button"
            role="tab"
            id={`install-tab-${entry.id}`}
            aria-selected={index === active}
            aria-controls="install-panel"
            // Roving tabindex: one stop for the whole row, then arrow keys.
            tabIndex={index === active ? 0 : -1}
            onClick={() => selectTab(index)}
            onKeyDown={(event) => onTabKeyDown(event, index)}
            className={cn(
              'focus-visible:ring-accent-line rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none',
              index === active
                ? 'bg-surface text-fg shadow-raised'
                : 'text-fg-subtle hover:text-fg-muted',
            )}
          >
            {entry.label}
          </button>
        ))}

        <span className="text-fg-disabled ml-auto hidden items-center gap-1.5 pr-1 text-xs sm:flex">
          <TerminalIcon className="size-3.5" />
          {channel.source}
        </span>
      </div>

      <div
        role="tabpanel"
        id="install-panel"
        aria-labelledby={`install-tab-${channel.id}`}
        // The height is held by the longest transcript so that switching tabs
        // does not resize the panel and shove the rest of the page around.
        className="flex min-h-[11.5rem] flex-col gap-0.5 px-4 py-3.5 font-mono text-sm leading-6"
      >
        {script.slice(0, visibleCount).map((line, index) => (
          <TranscriptLine key={index} line={line} partial={null} />
        ))}
        {animating && !done && script[progress.line] !== undefined ? (
          <TranscriptLine line={script[progress.line] as Line} partial={progress.ticks} />
        ) : null}
      </div>

      {/* The payoff line. It changes with the tab because the answer does:
          the same command puts the credential in three different places, and
          naming the one the reader's own machine will use is worth more than
          a generic promise about "secure storage". */}
      <div className="border-line-subtle bg-canvas-inset/60 flex flex-wrap items-center gap-x-3 gap-y-2 border-t px-4 py-2.5">
        <p className="text-fg-subtle min-w-0 flex-1 text-xs leading-5">{channel.note}</p>

        {channel.copy ? (
          <CopyButton value={channel.copy.value} label={channel.copy.label} />
        ) : channel.link ? (
          <a
            href={channel.link.href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-fg-muted hover:text-fg inline-flex shrink-0 items-center gap-1 text-xs font-medium transition-colors"
          >
            {channel.link.label}
            <ArrowRightIcon className="size-3" />
          </a>
        ) : null}
      </div>
    </div>
  );
}

function TranscriptLine({ line, partial }: { line: Line; partial: number | null }) {
  if (line.kind === 'blank') return <span aria-hidden="true">&nbsp;</span>;

  if (line.kind === 'command') {
    const text = partial === null ? line.text : line.text.slice(0, partial);
    return (
      // The copy control sits in a gutter at the right edge rather than
      // trailing each command, so the buttons line up in one column instead of
      // stepping in and out with the length of the line above.
      //
      // It appears only once the line has finished typing — a button beside
      // half a command would copy the whole thing, which is not what it looks
      // like it does — and it is `size-6` to match `leading-6` exactly, so
      // arriving costs no reflow.
      <span className="flex items-start gap-2">
        <span className="text-fg min-w-0 flex-1 break-all">
          <span className="text-fg-subtle select-none">$ </span>
          {text}
          {partial !== null ? (
            <span
              aria-hidden="true"
              className="bg-fg-muted ml-px inline-block h-[1.1em] w-[0.55em] translate-y-[0.2em]"
            />
          ) : null}
        </span>
        {partial === null ? (
          <CopyButton
            value={line.text}
            label={line.text}
            className="text-fg-disabled hover:text-fg-muted size-6 shrink-0"
          />
        ) : null}
      </span>
    );
  }

  // Everything else appears whole once its dwell begins; a cursor mid-word
  // would claim it was typed by the user, which it was not.
  if (partial === 0) return null;

  if (line.kind === 'success') {
    return (
      <span className="text-fg-muted break-all">
        <span className="text-success-text">✓ </span>
        {line.text}
      </span>
    );
  }
  if (line.kind === 'comment') {
    return <span className="text-fg-subtle break-all">{line.text}</span>;
  }
  if (line.kind === 'file') {
    // `whitespace-pre-wrap` rather than the default: this is the only kind
    // whose leading space carries meaning — the continuation of a `RUN` is
    // indented under it — and HTML would otherwise collapse it away and print
    // a Dockerfile nobody writes.
    return <span className="text-fg break-all whitespace-pre-wrap">{line.text}</span>;
  }
  return <span className="text-fg-muted break-all">{line.text}</span>;
}

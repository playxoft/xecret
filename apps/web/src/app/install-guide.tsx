'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';
import { isInViewport, observeOnce } from '@/lib/observe-once';
import { CopyButton } from '@/components/ui/copy-button';
import { ArrowRightIcon, TerminalIcon } from '@/components/ui/icons';
import { Transcript, useReducedMotion, useTypeOut } from './transcript';
import type { Line } from './transcript';

/**
 * The install guide: four ways onto the machine, each typed out.
 *
 * The transcript engine, the line renderer and the reduced-motion store live
 * in `transcript.tsx`, shared with the hero's `CliDemo`. What is here is what
 * is particular to this panel: the four channels, the tab set, and the rule
 * about when a type-out may start.
 *
 * Same standing rule as the hero — every line that is not a command is real
 * output, copied from the source that prints it:
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

/**
 * The container image, not `curl | sh` inside a builder stage.
 *
 * GoReleaser already publishes a multi-arch `ghcr.io/playxoft/xecret` manifest
 * (`cli/.goreleaser.yaml`) carrying the same static binary the installer would
 * have fetched, so copying from it is two lines instead of six, spends no
 * `apk add` and no network fetch per build, and — the part that matters for a
 * tool selling reproducible installs — pins a version. The builder-stage form
 * passed no `XECRET_VERSION`, so `install-cli.sh` resolved "latest" at build
 * time and the same Dockerfile produced a different binary on every rebuild.
 *
 * Kept in step with the same snippet in `public/docs/install.md`.
 */
const DOCKERFILE = [
  `FROM ghcr.io/playxoft/xecret:${VERSION} AS xecret`,
  '',
  'FROM node:22-slim',
  'COPY --from=xecret /usr/local/bin/xecret /usr/local/bin/xecret',
];

function buildChannels(installUrl: string, releasesUrl: string): readonly Channel[] {
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

/**
 * Far enough in to count as "the reader is looking at it".
 *
 * A band inset a quarter of the viewport from the top and bottom edges, rather
 * than a ratio of the panel. A ratio is a trap here: `visible / total` for an
 * element taller than the window can never reach a threshold like 0.33, so at
 * the WCAG reflow target — 320px wide at 400% zoom, where every command line
 * wraps three ways — a `threshold` gate would simply never fire and the panel
 * would stay blank forever. See `observeOnce`.
 */
const START_MARGIN = { rootMargin: '-25% 0px -25% 0px', threshold: 0 };

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
  const reducedMotion = useReducedMotion();

  const [active, setActive] = useState(0);
  const [started, setStarted] = useState(false);
  /**
   * Was this panel already on the reader's screen when the page hydrated?
   *
   * `null` until the first effect answers it. It decides whether there is an
   * animation at all, and it cannot be answered by the observer: the
   * observer's first callback reports the current state either way, so
   * "already here" and "just scrolled to" look identical to it.
   *
   * Why it matters: the server renders the transcript whole — that is what
   * makes the panel correct without JavaScript. If the reader can already see
   * that transcript when hydration lands, switching into type-out mode empties
   * a panel they are looking at and retypes it in front of them. So a panel
   * that arrives on screen keeps what the server drew, and only a panel that
   * is still below the fold — where blanking it costs the reader nothing — is
   * allowed to type.
   */
  const [visibleAtMount, setVisibleAtMount] = useState<boolean | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = panelRef.current;
    if (!element) return;

    if (isInViewport(element)) {
      setVisibleAtMount(true);
      return;
    }

    setVisibleAtMount(false);
    // The hero's demo can start on mount because it is on screen at load. This
    // one is four sections down, so a timer that starts on mount plays to
    // nobody and the reader arrives at the last frame of an animation they
    // never saw. It waits to be looked at.
    return observeOnce(element, () => setStarted(true), START_MARGIN);
  }, []);

  const channel = channels[active] as Channel;

  // Settled on the first render after hydration and never flipped again: this
  // is what is on screen, and changing it mid-life is what a wipe is.
  // `visibleAtMount === false` is deliberate — `null` means the effect has not
  // run, and until it has, the whole transcript stays up.
  const enabled = !reducedMotion && visibleAtMount === false;

  const typeOut = useTypeOut(channel.script, {
    tickMs: TICK_MS,
    dwellTicks: DWELL_TICKS,
    enabled,
    // …and the clock only runs once the panel has been scrolled to.
    running: enabled && started,
  });

  /** The longest of the four, so switching tabs never resizes the panel. */
  const longestScript = useMemo(
    () => Math.max(...channels.map((entry) => entry.script.length)),
    [channels],
  );

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
    setActive(next);
    tabRefs.current[next]?.focus();
  }

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
          controls for one thing.

          The strip is the flex container and the tablist sits inside it, not
          the other way round: `role="tablist"` may only own elements with
          `role="tab"`, and the source label at the right end is neither. With
          it as a sibling, a screen reader walking the tablist finds four tabs
          and counts them as four. */}
      <div className="border-line-subtle bg-canvas-inset flex items-center gap-1 border-b px-2 py-2">
        <div role="tablist" aria-label="Platform" className="flex flex-wrap items-center gap-1">
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
              onClick={() => setActive(index)}
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
        </div>

        <span className="text-fg-disabled ml-auto hidden items-center gap-1.5 pr-1 text-xs sm:flex">
          <TerminalIcon className="size-3.5" />
          {channel.source}
        </span>
      </div>

      <Transcript
        script={channel.script}
        typeOut={typeOut}
        minLines={longestScript}
        copyable
        role="tabpanel"
        id="install-panel"
        aria-labelledby={`install-tab-${channel.id}`}
        // Docker's panel is built entirely from `file` lines, so it contains no
        // copy button and no other focusable child — without this, a keyboard
        // user tabs straight past it and cannot scroll it where it overflows.
        tabIndex={0}
      />

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

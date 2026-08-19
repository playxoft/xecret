'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';
import { isInViewport, observeOnce } from '@/lib/observe-once';
import { CopyButton } from '@/components/ui/copy-button';
import { ArrowRightIcon, TerminalIcon } from '@/components/ui/icons';
import { Transcript, prefersReducedMotion, useTypeOut } from './transcript';
import { nextTabIndex, transcriptGates } from './transcript-model';
import type { Line, TranscriptPlan } from './transcript-model';

/**
 * The install guide: four ways onto the machine, each typed out.
 *
 * The transcript engine, the line renderer and the reduced-motion read live in
 * `transcript.tsx`, shared with the hero's `CliDemo`. What is here is what is
 * particular to this panel: the four channels, the tab set, and the rule about
 * when a type-out may start.
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

/** The tail two of the four channels share. */
function KeychainNote({ where }: { where: string }) {
  return (
    <>
      The credential lives in <span className="text-fg-muted">{where}</span> — never in a dotfile
      you might commit or sync.
    </>
  );
}

/**
 * The release tag, and the same tag without its `v`.
 *
 * Two constants because the toolchain uses both and they are not
 * interchangeable. `install-cli.sh` prints the git tag as-is (`downloading
 * xecret v1.2.0 …`), while everything GoReleaser templates from `{{ .Version }}`
 * — the archive name, the container tags, and the `buildinfo.Version` stamped
 * into the binary — carries the tag with the leading `v` stripped. The repo
 * says so itself at `scripts/install-cli.sh`: "Archive names carry the version
 * without the leading v". Using one form for both is how the Docker tab ends
 * up telling a reader to pull an image that was never published.
 */
const VERSION_TAG = 'v1.2.0';
const VERSION = '1.2.0';
const COMMIT = '9f3c1ab';
const BUILT = '2026-08-16';
/** `cli/go.mod` is `go 1.25.0` and both workflows pin 1.25. */
const GO_VERSION = 'go1.25.5';

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
 * Kept in step with the same snippet in `public/docs/install.md` and
 * `public/docs/guides/docker.md`.
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
      // Not a `KeychainNote`: on Linux the keyring is the *usual* case rather
      // than the guaranteed one. `cli/internal/keyring` falls back to a 0600
      // file when no Secret Service is reachable — which is every headless box
      // and most WSL setups, the two environments this tab is named for — and
      // `xecret doctor` reports it as `0600 file at ~/.xecret/credentials.json
      // (no system keyring)`. Every other surface in the repo carries that
      // caveat; the landing page must not be the one that promises otherwise.
      note: (
        <>
          The credential lives in <span className="text-fg-muted">Secret Service</span>, your
          desktop keyring — or, on a headless box with none, a{' '}
          <span className="text-fg-muted">0600 file</span> that{' '}
          <span className="text-fg-muted">xecret doctor</span> names for you.
        </>
      ),
      script: [
        { kind: 'command', text: `curl -fsSL ${installUrl} | sh` },
        { kind: 'info', text: `downloading xecret ${VERSION_TAG} for linux/amd64…` },
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
          text: `xecret ${VERSION} (commit ${COMMIT}, built ${BUILT}, windows/amd64, ${GO_VERSION})`,
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
 * Faster than the hero's, deliberately. The hero's transcript is the first
 * thing on the page and has the whole screen to itself, so it can take its
 * time; this one is four sections down, in front of a reader who has already
 * decided to look for their own platform and wants the line, not the
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
 *
 * The two questions below are deliberately *not* asked with the same
 * strictness, and the asymmetry runs one way on purpose. "Is the reader
 * looking at it?" — the question that decides whether blanking the panel is
 * destructive — is asked leniently: any pixel on screen counts, because the
 * cost of getting it wrong is erasing a transcript somebody is reading. "Has
 * it arrived?" — which only ever starts an animation on a panel already
 * confirmed to be off screen — is asked with the band.
 *
 * Making the two match, by asking the first one strictly too, looks tidier and
 * is worse: a panel sitting four fifths of the way down the viewport is
 * plainly visible but not yet in the middle band, so it would be planned as a
 * type-out and the reader would watch the server's transcript vanish. The
 * failure mode of leniency is only that a panel with a sliver showing at load
 * never animates, which costs nothing anyone can see.
 *
 * There is no gap between them for this panel: one that fails the lenient
 * test is entirely off screen, and reaching the reader from there means
 * scrolling through the band. That holds because the panel is taller than a
 * quarter of any plausible viewport and has five sections and a footer below
 * it. Reuse the pattern for something short at the very end of a document and
 * check it again — an element under `0.25h` tall with nothing after it can sit
 * below the fold at rest and never reach the band, and would stay blank.
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

  const [active, setActive] = useState(0);
  const [started, setStarted] = useState(false);
  /**
   * What this run intends to do with the transcript, settled once on mount and
   * never revisited.
   *
   *   - `print`   — render it whole and leave it alone. Reduced motion, and
   *                 the server's own answer, so it is the initial value.
   *   - `type`    — the panel is below the fold, so blanking it costs the
   *                 reader nothing and it may type when scrolled to.
   *   - `settled` — the panel was already on screen at hydration, so what the
   *                 server drew stays; but the reader may still ask for an
   *                 animation by choosing a tab.
   *
   * Latched rather than derived, because it decides *what is on screen*. The
   * motion preference is a live media query, so reading it through a
   * subscription would let a reader who turns "Reduce motion" off mid-page
   * empty a transcript they were part-way through. The panel's position cannot
   * be asked of an observer at all: its first callback reports the current
   * state whether the panel was there at load or has just been scrolled to,
   * and those two want opposite treatment.
   *
   * Why position matters: the server renders the transcript whole — that is
   * what makes the panel correct without JavaScript. If the reader can already
   * see it when hydration lands, switching into type-out mode empties a panel
   * they are looking at and retypes it in front of them.
   *
   * One state rather than three booleans so the effect commits its decision in
   * a single update; a sequence of `setState` calls in an effect body is a
   * cascade of renders, and the lint rule that says so is right.
   */
  const [plan, setPlan] = useState<TranscriptPlan>('print');
  /**
   * Has the reader picked a tab themselves?
   *
   * This is what re-enables the animation under `settled`. The rule above
   * protects the transcript the *server* drew; once the reader chooses a
   * different platform there is nothing of the server's left to protect, and
   * replaying from the top is the whole point of the choice — they picked that
   * tab to watch this install happen, not to arrive at its last frame. It
   * deliberately cannot revive the animation under `print`, which is where
   * reduced motion lands.
   */
  const [interacted, setInteracted] = useState(false);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = panelRef.current;
    if (!element || prefersReducedMotion()) return;

    if (isInViewport(element)) {
      setPlan('settled');
      return;
    }

    setPlan('type');
    // The hero's demo can start on mount because it is on screen at load. This
    // one is four sections down, so a timer that starts on mount plays to
    // nobody and the reader arrives at the last frame of an animation they
    // never saw. It waits to be looked at.
    return observeOnce(element, () => setStarted(true), START_MARGIN);
  }, []);

  const channel = channels[active] as Channel;

  const { enabled, running } = transcriptGates(plan, interacted, started);
  const typeOut = useTypeOut(channel.script, {
    tickMs: TICK_MS,
    dwellTicks: DWELL_TICKS,
    enabled,
    running,
  });

  /** The longest of the four, so the panel does not resize as lines arrive. */
  const longestScript = useMemo(
    () => Math.max(...channels.map((entry) => entry.script.length)),
    [channels],
  );

  function selectTab(index: number) {
    // Re-activating the tab that is already open is not the reader choosing a
    // different platform, and must not be treated as one: under `settled` it
    // would flip `enabled` with the script unchanged, so `useTypeOut` would
    // not reset — it would simply stop printing the transcript that is on
    // screen and retype it from an untouched `progress`. Reachable by a stray
    // tap on the active tab, and by `Home` or `End` when focus is already on
    // the first or last one.
    if (index === active) return;
    setActive(index);
    setInteracted(true);
  }

  /** Arrow keys move between tabs and activate as they go, which is the
   *  expected behaviour for a tab set whose panels are already loaded. */
  function onTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = nextTabIndex(event.key, index, channels.length - 1);
    if (next === null) return;
    event.preventDefault();
    selectTab(next);
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
              onClick={() => selectTab(index)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
              // No `focus-visible:outline-none` and no ring of its own. The
              // application draws one focus treatment in `globals.css`, whose
              // note says in terms that a component must not add
              // `outline-none` — Tailwind's utilities layer outranks the base
              // rule, so doing it here silently deletes the indicator. What it
              // replaced it with was `--accent-line`, which is 1.16:1 against
              // this strip: on a row whose selected tab is already filled,
              // that left keyboard focus with nothing to show for itself.
              className={cn(
                'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                index === active
                  ? 'bg-surface text-fg shadow-raised'
                  : 'text-fg-subtle hover:text-fg-muted',
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {/* `aria-hidden` because it is the one piece of per-tab furniture that
            cannot live inside the panel without moving it out of the title
            bar, and a screen reader has better sources for the same fact: the
            tab is named "Docker", and the transcript below either opens with a
            `$` prompt or does not. `text-fg-subtle`, not `text-fg-disabled` —
            that token is documented as deliberately below AA and exempt only
            because it marks disabled controls, which this is not. */}
        <span
          aria-hidden="true"
          className="text-fg-subtle ml-auto hidden items-center gap-1.5 pr-1 text-xs sm:flex"
        >
          <TerminalIcon className="size-3.5" />
          {channel.source}
        </span>
      </div>

      {/* The panel is the transcript *and* the line under it. Everything that
          changes with the tab has to be inside the element the tabs' own
          `aria-controls` names, or following that relationship dead-ends: the
          Windows transcript would tell a reader to go to the releases page
          while the link to it sat outside, and Docker's panel would be a file
          with its copy button somewhere else entirely.

          Keyed on the channel so the subtree is rebuilt per tab. Without it,
          React reuses the copy button at each index across scripts, and one
          clicked on macOS keeps its two-second "Copied" state — claiming, on
          the Linux tab, to have copied a command it never saw. */}
      <div
        key={channel.id}
        role="tabpanel"
        id="install-panel"
        aria-labelledby={`install-tab-${channel.id}`}
        // Unconditional, which the APG allows and which this panel needs.
        // The strict reading — a tab stop only when there is nothing focusable
        // inside — cannot be applied to content that changes: a command's copy
        // button appears only once its line has finished typing, so the
        // condition flips about a second in, and removing `tabindex` from an
        // element that currently holds focus drops that focus to `<body>` and
        // sends the reader's next Tab back to the top of the document. A
        // redundant stop is a smaller cost than that, and than the window
        // where the panel is skipped entirely.
        tabIndex={0}
      >
        <Transcript script={channel.script} typeOut={typeOut} minLines={longestScript} copyable />

        {/* The payoff line. It changes with the tab because the answer does:
            the same command puts the credential in three different places, and
            naming the one the reader's own machine will use is worth more than
            a generic promise about "secure storage". */}
        <div className="border-line-subtle bg-canvas-inset/60 flex flex-wrap items-center gap-x-3 gap-y-2 border-t px-4 py-2.5">
          {/* Two lines' worth of floor. The notes are not the same length —
              Linux has to carry the keyring's fallback — so without it the
              footer is one line on three tabs and two on the fourth, and the
              panel changes height on switch after all the trouble the
              transcript above goes to not to. */}
          <p className="text-fg-subtle min-h-10 min-w-0 flex-1 text-xs leading-5">{channel.note}</p>

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
    </div>
  );
}

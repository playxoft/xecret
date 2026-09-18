package main

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/playxoft/xecret/cli/internal/api"
	"github.com/playxoft/xecret/cli/internal/buildinfo"
	"github.com/playxoft/xecret/cli/internal/notice"
	"github.com/playxoft/xecret/cli/internal/output"
)

// The upgrade notice: three lines on stderr, after a command has finished,
// when the server this CLI was already talking to names a newer release.
//
// ── Why this exists ──
// A stale binary is not a cosmetic problem in this product. A CLI older than
// `feat(cli): decrypt on this side of the wire` has no end-to-end path at all:
// asked for a secret in an e2ee environment it receives ciphertext, finds no
// plaintext field to read, prints an empty line and exits **0**. `doctor`
// reports every check green, because every check it knows about is. Nothing in
// the product told the user their reader was too old until they noticed a
// deploy had gone out with an empty credential in it.
//
// ── What it is not ──
// It is not a version check. `api/advertised.go` holds the whole mechanism:
// the server volunteers a header, and this reads a reply that had already
// arrived. No request is made, and none is skipped.
//
// ── The four silences ──
// Each is a case where a notice is worse than nothing, and each is a reason and
// not a preference:
//
//   - **Not a terminal.** stderr redirected means it is being captured, and a
//     notice in a captured stream is a line in a log file that nobody will act
//     on and some parser may choke on.
//   - **Under XECRET_TOKEN.** A CI job cannot upgrade itself. The nudge would
//     land in every build log for ever and reach nobody who can act on it — and
//     the person who *can* act on it runs the CLI on their own machine, where
//     they will see it.
//   - **Once a day, per version.** The second time you are told something you
//     already decided about is the first time it is noise.
//   - **XECRET_NO_UPGRADE_NOTICE.** Somebody who has said "stop" is owed a way
//     to make it stop that is not "downgrade your server".
//
// A fifth silence needs no flag: a deployment that sends no header produces no
// notice, so an old server, a self-hoster who would rather not, and every
// offline path are all quiet by construction.
//
// ── Why after, and why stderr ──
// After the command, because the thing the user asked for is the thing they
// should see first, and because a command that fails should fail with its own
// error at the bottom of the screen rather than a suggestion about versions.
// stderr, because stdout is results: `secrets get --plain` and `pull` write raw
// values there, and a notice on stdout would land inside `$(xecret secrets get
// …)` and be deployed as part of a credential.
func maybeShowUpgradeNotice(printer *output.Printer) {
	latest := api.Advertised()
	if latest == nil {
		return
	}
	if !upgradeNoticeAllowed() {
		return
	}
	// A development build reports a `git describe` version that is ahead of the
	// last release and is still not one. Telling somebody who just built from
	// main that they are out of date is both wrong and the fastest way to teach
	// them to ignore this.
	if buildIsDevelopment() {
		return
	}
	if compareVersions(strings.TrimPrefix(currentRelease(), "v"), latest.Version) >= 0 {
		return
	}

	now := time.Now()
	if !notice.ShouldShowUpgrade(latest.Version, now) {
		return
	}

	writeUpgradeNotice(printer, latest)
	notice.RecordUpgradeShown(latest.Version, now)
}

// What this build is, and where it is running — the three facts the decision
// turns on that a test process cannot otherwise arrange.
//
// Under `go test` stderr is always a pipe and the binary always reports a
// development version, so without these seams the interesting half of
// [maybeShowUpgradeNotice] is unreachable: every case would either skip or
// assert the suppression rather than the behaviour. A skipped test in CI is not
// coverage, and this is the one path in the CLI whose failure is silence.
var (
	stderrIsTerminal   = output.StderrIsTerminal
	currentRelease     = buildinfo.Release
	buildIsDevelopment = buildinfo.IsDevelopment
)

// upgradeNoticeAllowed covers the three silences that are about the
// environment rather than the versions.
func upgradeNoticeAllowed() bool {
	if strings.TrimSpace(os.Getenv("XECRET_NO_UPGRADE_NOTICE")) != "" {
		return false
	}
	if serviceTokenFromEnv() != "" {
		return false
	}
	return stderrIsTerminal()
}

// writeUpgradeNotice renders the three lines.
//
// A blank line first, because this follows output the user was reading and
// needs to be visibly not part of it. The headline is indented under the
// version for the same reason a bullet is indented: it belongs to the line
// above, and at a glance the eye can skip both.
func writeUpgradeNotice(printer *output.Printer, latest *api.AdvertisedRelease) {
	fmt.Fprintln(printer.Err, "")
	printer.Noticef("xecret %s is available (you have %s)", latest.Version, currentRelease())

	if headline := strings.TrimSpace(latest.Headline); headline != "" {
		for _, line := range wrapNotice(headline, 66) {
			fmt.Fprintf(printer.Err, "  %s\n", printer.Dim(line))
		}
	}
	fmt.Fprintf(printer.Err, "  %s\n", printer.Dim("Upgrade: xecret upgrade"))
}

// wrapNotice breaks a headline on word boundaries at width columns.
//
// The headline comes from the server, so its length is not this binary's to
// assume. An unwrapped line that runs past the terminal edge is the difference
// between a notice somebody reads and one they scroll past — and a server that
// sent a very long one should still produce something legible rather than
// something that reflows into the prompt.
func wrapNotice(text string, width int) []string {
	words := strings.Fields(text)
	if len(words) == 0 {
		return nil
	}

	lines := []string{}
	current := words[0]
	for _, word := range words[1:] {
		if len(current)+1+len(word) > width {
			lines = append(lines, current)
			current = word
			continue
		}
		current += " " + word
	}
	return append(lines, current)
}

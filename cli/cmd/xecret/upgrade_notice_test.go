package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/playxoft/xecret/cli/internal/api"
	"github.com/playxoft/xecret/cli/internal/notice"
	"github.com/playxoft/xecret/cli/internal/output"
)

// A printer whose streams are buffers, so a test can read what a person would
// have seen. `terminal` stands in for the stderr-is-a-terminal test, which no
// test process can satisfy.
func noticePrinter() (*output.Printer, *bytes.Buffer, *bytes.Buffer) {
	out, errOut := &bytes.Buffer{}, &bytes.Buffer{}
	return &output.Printer{Out: out, Err: errOut}, out, errOut
}

// The notice names the newer version, argues for it, and says what to type.
//
// Asserted together because all three are the point: a notice carrying only the
// version is the sentence every tool prints and everybody ignores, and one
// without a remedy makes the reader go looking.
func TestUpgradeNoticeCarriesVersionHeadlineAndRemedy(t *testing.T) {
	printer, stdout, stderr := noticePrinter()

	writeUpgradeNotice(printer, &api.AdvertisedRelease{
		Version:  "9.9.9",
		Headline: "Reads end-to-end encrypted environments.",
	})

	shown := stderr.String()
	for _, want := range []string{"9.9.9", "Reads end-to-end encrypted environments.", "xecret upgrade"} {
		if !strings.Contains(shown, want) {
			t.Errorf("the notice does not mention %q:\n%s", want, shown)
		}
	}
	if !strings.Contains(shown, currentRelease()) {
		t.Errorf("the notice does not say which version is installed:\n%s", shown)
	}

	// The rule the whole package exists under. `secrets get --plain` and `pull`
	// write raw values to stdout, and a notice landing in `$(xecret secrets get
	// …)` would be deployed as part of a credential.
	if stdout.Len() != 0 {
		t.Errorf("the notice reached stdout, where values are: %q", stdout.String())
	}
}

// A server that names a version without arguing for it still produces a usable
// notice, rather than a blank line where the headline would be.
func TestUpgradeNoticeSurvivesAMissingHeadline(t *testing.T) {
	printer, _, stderr := noticePrinter()

	writeUpgradeNotice(printer, &api.AdvertisedRelease{Version: "9.9.9"})

	shown := stderr.String()
	if !strings.Contains(shown, "9.9.9") || !strings.Contains(shown, "xecret upgrade") {
		t.Errorf("a headline-less notice lost its other lines:\n%s", shown)
	}
	for _, line := range strings.Split(strings.Trim(shown, "\n"), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		if strings.TrimSpace(strings.TrimPrefix(line, "  ")) == "" {
			t.Errorf("an empty headline line was printed:\n%q", shown)
		}
	}
}

// A long headline wraps instead of running off the edge of the terminal. The
// server owns that string, so its length is not this binary's to assume.
func TestUpgradeNoticeWrapsALongHeadline(t *testing.T) {
	long := strings.TrimSpace(strings.Repeat("a reason to upgrade ", 12))

	lines := wrapNotice(long, 66)
	if len(lines) < 2 {
		t.Fatalf("a %d-character headline was not wrapped: %v", len(long), lines)
	}
	for _, line := range lines {
		if len(line) > 66 {
			t.Errorf("line runs to %d columns: %q", len(line), line)
		}
	}
	// Wrapping must not lose or invent words.
	if strings.Join(lines, " ") != long {
		t.Errorf("wrapping changed the text:\n%q\n%q", strings.Join(lines, " "), long)
	}
}

func TestWrapNoticeHandlesEmptyText(t *testing.T) {
	if lines := wrapNotice("   ", 66); len(lines) != 0 {
		t.Errorf("blank text produced %d line(s): %v", len(lines), lines)
	}
}

// ── The silences ──

// A CI job cannot upgrade itself, and the notice would land in every build log
// for ever.
func TestUpgradeNoticeIsSilentUnderAServiceToken(t *testing.T) {
	t.Setenv("XECRET_TOKEN", "xct_live_ci")
	t.Setenv("XECRET_NO_UPGRADE_NOTICE", "")

	if upgradeNoticeAllowed() {
		t.Error("the notice would print inside a CI job")
	}
}

// Somebody who has said stop is owed a way to make it stop.
func TestUpgradeNoticeHonoursTheOptOut(t *testing.T) {
	t.Setenv("XECRET_TOKEN", "")
	t.Setenv("XECRET_NO_UPGRADE_NOTICE", "1")

	if upgradeNoticeAllowed() {
		t.Error("XECRET_NO_UPGRADE_NOTICE did not silence the notice")
	}
}

// Under `go test` stderr is a pipe, which is the same condition as a redirected
// stream — so the terminal gate alone refuses, and that is what this pins.
func TestUpgradeNoticeIsSilentWhenStderrIsNotATerminal(t *testing.T) {
	t.Setenv("XECRET_TOKEN", "")
	t.Setenv("XECRET_NO_UPGRADE_NOTICE", "")

	if upgradeNoticeAllowed() {
		t.Error("the notice would print into a redirected stderr")
	}
}

// A server that says nothing produces no notice — the silence an old server, a
// self-hoster who would rather not, and every offline path all rely on.
func TestUpgradeNoticeIsSilentWhenNothingWasAdvertised(t *testing.T) {
	api.ForgetAdvertised()
	t.Cleanup(api.ForgetAdvertised)

	printer, _, stderr := noticePrinter()
	maybeShowUpgradeNotice(printer)

	if stderr.Len() != 0 {
		t.Errorf("a notice appeared with nothing advertised: %q", stderr.String())
	}
}

// ── The once-a-day rule ──

// The first sighting shows; a second on the same day does not; a newer release
// shows again immediately, because that is new information rather than a
// repetition.
func TestUpgradeIsShownOnceADayAndAgainForANewerRelease(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("USERPROFILE", t.TempDir())

	day := time.Date(2026, 9, 17, 9, 0, 0, 0, time.UTC)

	if !notice.ShouldShowUpgrade("0.2.0", day) {
		t.Fatal("the first sighting of a release was suppressed")
	}
	notice.RecordUpgradeShown("0.2.0", day)

	if notice.ShouldShowUpgrade("0.2.0", day.Add(3*time.Hour)) {
		t.Error("the same release was offered twice in one day")
	}
	if !notice.ShouldShowUpgrade("0.2.0", day.AddDate(0, 0, 1)) {
		t.Error("an ignored release was not raised again the next day")
	}
	if !notice.ShouldShowUpgrade("0.3.0", day.Add(3*time.Hour)) {
		t.Error("a newer release waited for tomorrow")
	}
}

func TestShouldShowUpgradeRefusesABlankVersion(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("USERPROFILE", t.TempDir())

	if notice.ShouldShowUpgrade("", time.Now()) {
		t.Error("a blank version was treated as a release")
	}
}

// ── The whole path, composed ──

// Stands a test where a person would: a terminal at stderr, an isolated home,
// no CI token and no opt-out. Everything the composition test needs except the
// versions themselves.
func asAPersonAtATerminal(t *testing.T) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("USERPROFILE", t.TempDir())
	t.Setenv("XECRET_TOKEN", "")
	t.Setenv("XECRET_NO_UPGRADE_NOTICE", "")

	realTerminal, realRelease, realDevelopment := stderrIsTerminal, currentRelease, buildIsDevelopment
	stderrIsTerminal = func() bool { return true }
	currentRelease = func() string { return "0.1.2" }
	buildIsDevelopment = func() bool { return false }
	t.Cleanup(func() {
		stderrIsTerminal, currentRelease, buildIsDevelopment = realTerminal, realRelease, realDevelopment
	})

	api.ForgetAdvertised()
	t.Cleanup(api.ForgetAdvertised)
}

// noteAdvertisedForTest gets a release into this process the way a real one
// arrives: off the headers of an ordinary reply to an ordinary request.
//
// Deliberately not a test-only setter exported from the api package. Going
// through the wire means the header names, the parsing and the recording are all
// inside what these tests cover, so a rename on either side fails here rather
// than shipping a notice that never appears.
func noteAdvertisedForTest(t *testing.T, version, headline string) {
	t.Helper()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("x-xecret-cli-latest", version)
		w.Header().Set("x-xecret-cli-headline", headline)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"organizations":[]}`))
	}))
	t.Cleanup(server.Close)

	if _, err := api.New(server.URL, "xct_live_abc", userAgent()).
		Organizations(context.Background()); err != nil {
		t.Fatalf("seeding the advertised release: %v", err)
	}
	if api.Advertised() == nil {
		t.Fatal("the fake server's headers were not picked up")
	}
}

// A release newer than this build produces the notice once, and the second
// command that day says nothing.
//
// This is the one test that runs the whole decision: what the server
// advertised, the environment gates, the version comparison, the once-a-day
// state, and the writing. The pieces each have their own case above; this pins
// that they are wired to one another in the right order.
func TestANewerReleaseIsAnnouncedOnceAndThenIsQuiet(t *testing.T) {
	asAPersonAtATerminal(t)
	noteAdvertisedForTest(t, "999.0.0", "A reason to upgrade.")

	printer, _, stderr := noticePrinter()
	maybeShowUpgradeNotice(printer)
	if !strings.Contains(stderr.String(), "999.0.0") {
		t.Fatalf("a newer release was not announced:\n%s", stderr.String())
	}

	printer, _, second := noticePrinter()
	maybeShowUpgradeNotice(printer)
	if second.Len() != 0 {
		t.Errorf("the same release was announced twice in one day: %q", second.String())
	}
}

// A server advertising a release this build already has, or an older one, says
// nothing at all.
func TestAnOlderOrEqualReleaseIsNeverAnnounced(t *testing.T) {
	asAPersonAtATerminal(t)
	noteAdvertisedForTest(t, "0.0.1", "You are already past this.")

	printer, _, stderr := noticePrinter()
	maybeShowUpgradeNotice(printer)

	if stderr.Len() != 0 {
		t.Errorf("an older release was announced: %q", stderr.String())
	}
}

// Somebody who just built from main is not told their build is out of date.
// The version is ahead of the last release and is still not one.
func TestADevelopmentBuildIsNeverToldItIsOutOfDate(t *testing.T) {
	asAPersonAtATerminal(t)
	currentRelease = func() string { return "0.1.2-81-gaaebe31" }
	buildIsDevelopment = func() bool { return true }
	noteAdvertisedForTest(t, "999.0.0", "A reason to upgrade.")

	printer, _, stderr := noticePrinter()
	maybeShowUpgradeNotice(printer)

	if stderr.Len() != 0 {
		t.Errorf("a development build was told to upgrade: %q", stderr.String())
	}
}

// A suppressed notice must not mark itself shown, or the one day it is allowed
// to appear is the one day it is skipped.
func TestASuppressedNoticeIsNotRecordedAsShown(t *testing.T) {
	asAPersonAtATerminal(t)
	t.Setenv("XECRET_NO_UPGRADE_NOTICE", "1")
	noteAdvertisedForTest(t, "999.0.0", "A reason to upgrade.")

	printer, _, stderr := noticePrinter()
	maybeShowUpgradeNotice(printer)
	if stderr.Len() != 0 {
		t.Fatalf("the opt-out did not silence the notice: %q", stderr.String())
	}

	if !notice.ShouldShowUpgrade("999.0.0", time.Now()) {
		t.Error("a notice nobody saw was recorded as shown")
	}
}

package buildinfo

import (
	"net/url"
	"strings"
	"testing"
)

func TestStringIncludesVersionAndPlatform(t *testing.T) {
	got := String()

	if !strings.HasPrefix(got, "xecret ") {
		t.Errorf("version line should start with the binary name, got %q", got)
	}
	if !strings.Contains(got, Version) {
		t.Errorf("version line should contain the version %q, got %q", Version, got)
	}
	if !strings.Contains(got, "go1.") {
		t.Errorf("version line should report the Go runtime, got %q", got)
	}
}

// The default API URL is compiled into every distributed binary. A malformed or
// plain-HTTP value would ship to every user and could not be corrected without
// a new release, so it is asserted rather than assumed.
func TestDefaultAPIURLIsWellFormedHTTPS(t *testing.T) {
	u, err := url.Parse(DefaultAPIURL)
	if err != nil {
		t.Fatalf("DefaultAPIURL is not a valid URL: %v", err)
	}
	if u.Scheme != "https" {
		t.Errorf("DefaultAPIURL must use https, got %q", u.Scheme)
	}
	if u.Host == "" {
		t.Error("DefaultAPIURL must have a host")
	}
	if strings.HasSuffix(DefaultAPIURL, "/") {
		t.Error("DefaultAPIURL must not have a trailing slash; paths are joined onto it")
	}
}

// `upgrade` decides what to tell somebody from this, and the answer it must
// never get wrong is "you are out of date" said to a build made from a commit
// ahead of the last release. A `git describe` version is a number, sorts above
// the tag it descends from, and is still not a release.
func TestIsDevelopmentRecognisesEveryUnreleasedShape(t *testing.T) {
	development := []string{
		"",
		"dev",
		"(devel)",
		"v0.1.1-6-g183987e",
		"v0.1.1-6-g183987e-dirty",
		"0.1.1-dirty",
	}
	for _, version := range development {
		if !developmentVersion(version) {
			t.Errorf("%q is not a released version", version)
		}
	}

	released := []string{"0.1.1", "v0.1.1", "v1.2.3", "1.0.0-rc.1", "v2.0.0-beta.2"}
	for _, version := range released {
		if developmentVersion(version) {
			t.Errorf("%q is a release and must not be reported as a development build", version)
		}
	}
}

// The three accessors answer for the unstamped defaults as well as for a
// stamped build, because a binary that cannot say what it is is the one case
// where the version line still has to say something.
func TestVersionDetailsAreNeverEmpty(t *testing.T) {
	if Release() == "" {
		t.Error("Release() must always name something")
	}
	if Revision() == "" {
		t.Error("Revision() must always name something")
	}
	if BuiltAt() == "" {
		t.Error("BuiltAt() must always name something")
	}
	if got := String(); !strings.Contains(got, Release()) {
		t.Errorf("the version line should carry the resolved version, got %q", got)
	}
}

// `-dirty` says "this binary was built from a tree that is not the commit it
// names". A release is not that case: GoReleaser checks the tree is clean and
// then runs `go mod tidy` and `go vet`, either of which can rewrite go.sum, so
// `vcs.modified` on a release build reports GoReleaser's own housekeeping. An
// archive published as 0.1.1 must not say it came from somebody's working copy.
func TestCommitForNeverCallsAReleaseDirty(t *testing.T) {
	const release = "183987e0c1de4b7a9f0c2d1e5a6b7c8d9e0f1a2b"

	if got := commitFor(release, "", true); got != "183987e" {
		t.Errorf("a stamped release commit = %q, want the abbreviated commit and no -dirty", got)
	}
	// The same forty characters are what the ldflag actually carries, and one
	// field that is 7 characters locally and 40 in a release cannot be compared
	// by eye.
	if got := commitFor(release, "", false); len(got) != 7 {
		t.Errorf("a stamped commit should be abbreviated like every other, got %q", got)
	}
}

// The other half: a commit read from the binary's own VCS record is exactly the
// case `-dirty` exists for.
func TestCommitForMarksAnUncommittedLocalBuild(t *testing.T) {
	const revision = "abcdef1234567890abcdef1234567890abcdef12"

	if got := commitFor("none", revision, true); got != "abcdef1-dirty" {
		t.Errorf("an uncommitted local build = %q, want abcdef1-dirty", got)
	}
	if got := commitFor("none", revision, false); got != "abcdef1" {
		t.Errorf("a clean local build = %q, want abcdef1", got)
	}
	if got := commitFor("none", "", true); got != "none" {
		t.Errorf("a build with no VCS record at all = %q, want none", got)
	}
}

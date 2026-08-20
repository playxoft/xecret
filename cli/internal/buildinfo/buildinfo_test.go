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

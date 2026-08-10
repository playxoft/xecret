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

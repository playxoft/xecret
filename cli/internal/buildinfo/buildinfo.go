// Package buildinfo carries version metadata stamped in at link time.
package buildinfo

import (
	"fmt"
	"regexp"
	"runtime"
	"runtime/debug"
	"strings"
	"sync"
)

// These are set via -ldflags at release time by GoReleaser, and by
// `npm run cli:build` for a local build. The defaults are what a bare
// `go build` produces, and are filled in from the binary's embedded VCS stamp
// by resolve() below rather than shown as-is.
var (
	Version = "dev"
	Commit  = "none"
	Date    = "unknown"
)

// DefaultAPIURL is the xecret instance the CLI talks to unless overridden by
// the XECRET_API_URL environment variable or a .xecret.yaml file.
//
// This value is compiled into every distributed binary. Changing it after
// release breaks every installed CLI, so it is deliberately a constant rather
// than something to edit casually. See docs/adr/0004-cli-language-go.md.
const DefaultAPIURL = "https://xecret.playxoft.com"

/*
Where the numbers come from, in the order they are trusted.

 1. **`-ldflags` at link time.** A release sets all three from the tag being
    built; `npm run cli:build` sets Version from `git describe`.
 2. **The binary's own build stamp.** `go build` records the module version,
    the commit and its timestamp in the executable (`runtime/debug`), and
    `go install …@v0.1.1` records a real module version where no ldflag exists
    at all. Reading it costs nothing and turns "commit none, built unknown"
    into the two facts somebody debugging actually asked for.
 3. **The defaults**, which now mean "this build carries no VCS information" —
    a `-buildvcs=false` build, or a source tree that is not a checkout.

The distinction that has to survive all three is *release or not*, because
`upgrade` decides what to tell the user from it. A `git describe` version is a
number and still not a release, so it is recognised as such by shape rather
than by asking whether the string happens to equal "dev".
*/

// describedByGit matches what `git describe --tags --dirty` appends to the
// most recent tag: how many commits have landed since, the abbreviated commit,
// and whether the tree was clean. A tag alone — what a release is built from —
// deliberately does not match.
var describedByGit = regexp.MustCompile(`-\d+-g[0-9a-f]{7,}(-dirty)?$`)

type details struct {
	version string
	commit  string
	date    string
}

var resolved = sync.OnceValue(resolve)

func resolve() details {
	found := details{version: Version, commit: Commit, date: Date}

	info, ok := debug.ReadBuildInfo()
	if !ok {
		return found
	}

	// "(devel)" is what a working tree reports, which is exactly what Version
	// already says. A real module version is not: it means this binary came
	// from `go install …@version`, where nothing runs ldflags and the default
	// would otherwise claim a tagged build is a development one.
	if found.version == "dev" && info.Main.Version != "" && info.Main.Version != "(devel)" {
		found.version = info.Main.Version
	}

	modified := false
	for _, setting := range info.Settings {
		switch setting.Key {
		case "vcs.revision":
			if found.commit == "none" && setting.Value != "" {
				found.commit = abbreviate(setting.Value)
			}
		case "vcs.time":
			if found.date == "unknown" && setting.Value != "" {
				found.date = setting.Value
			}
		case "vcs.modified":
			modified = setting.Value == "true"
		}
	}

	// An uncommitted tree is not the commit it sits on, and a bug report that
	// names a commit which does not contain the code that produced it costs
	// more than the seven characters this adds.
	if modified && found.commit != "none" && !strings.HasSuffix(found.commit, "-dirty") {
		found.commit += "-dirty"
	}

	return found
}

func abbreviate(revision string) string {
	if len(revision) > 7 {
		return revision[:7]
	}
	return revision
}

// Release is the version this binary reports: a tag for a release, a
// `git describe` for a local build, and "dev" for one with no VCS stamp at all.
func Release() string { return resolved().version }

// Revision is the commit this binary was built from, suffixed `-dirty` when
// the tree had uncommitted changes. "none" when the build carries no stamp.
func Revision() string { return resolved().commit }

// BuiltAt is when the source was committed (release builds: when it was
// built), RFC 3339. "unknown" when the build carries no stamp.
func BuiltAt() string { return resolved().date }

// IsDevelopment reports whether this binary is something other than a released
// build — which `upgrade` must know before it tells somebody they are out of
// date. A `git describe` version is a number and still not a release.
func IsDevelopment() bool { return developmentVersion(Release()) }

// developmentVersion is the rule on its own, so it can be checked against the
// shapes a release actually produces without rebuilding a binary per case.
func developmentVersion(version string) bool {
	return version == "" ||
		version == "dev" ||
		version == "(devel)" ||
		strings.HasSuffix(version, "-dirty") ||
		describedByGit.MatchString(version)
}

// String returns a human-readable version line.
func String() string {
	return fmt.Sprintf("xecret %s (commit %s, built %s, %s/%s, %s)",
		Release(), Revision(), BuiltAt(), runtime.GOOS, runtime.GOARCH, runtime.Version())
}

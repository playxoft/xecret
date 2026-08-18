package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/playxoft/xecret/cli/internal/buildinfo"
)

// Checking for a newer CLI.
//
// Three decisions worth stating, because each is the opposite of what a lot of
// tools do:
//
//  1. **Nothing checks in the background.** No command phones anywhere to see
//     whether it is current. A version check is a request describing which
//     machine runs which build of a secret-management client, and making it a
//     side effect of `xecret run` would mean shipping that telemetry from
//     inside every CI job in the world. It happens when it is asked for.
//  2. **The request goes to GitHub, not to the xecret server.** Releases live
//     there. Routing it through the deployment would tell a self-hoster's
//     server about every developer's binary for no benefit.
//  3. **It does not replace the binary.** Every published archive is
//     checksummed and cosign-signed, and `scripts/install-cli.sh` verifies the
//     checksum before unpacking. A self-updater that downloaded over itself
//     would either repeat that verification badly or skip it — and a secret
//     manager that silently overwrites its own executable is exactly the
//     supply-chain shape nobody should accept. This prints the command to run.
const releasesEndpoint = "https://api.github.com/repos/playxoft/xecret/releases/latest"

func cmdUpgrade(args []string) error {
	flags := flag.NewFlagSet("upgrade", flag.ContinueOnError)
	jsonMode := flags.Bool("json", false, "machine-readable output")
	if err := flags.Parse(args); err != nil {
		return err
	}

	a := newApp(*jsonMode)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	latest, err := latestRelease(ctx)
	if err != nil {
		return err
	}

	current := strings.TrimPrefix(buildinfo.Version, "v")
	published := strings.TrimPrefix(latest.TagName, "v")
	development := current == "dev" || current == ""

	if *jsonMode {
		return a.printer.WriteJSON(map[string]any{
			"current":     buildinfo.Version,
			"latest":      latest.TagName,
			"upToDate":    !development && compareVersions(current, published) >= 0,
			"development": development,
			"releaseUrl":  latest.HTMLURL,
		})
	}

	switch {
	case development:
		a.printer.Infof("This is a development build (%s). The latest release is %s.",
			buildinfo.Version, latest.TagName)
	case compareVersions(current, published) >= 0:
		a.printer.Successf("xecret %s is the latest release.", buildinfo.Version)
		return nil
	default:
		a.printer.Warnf("xecret %s is out of date — %s is available.", buildinfo.Version, latest.TagName)
	}

	installBase, _ := a.deploymentOrigin()

	fmt.Fprintln(a.printer.Out, "")
	fmt.Fprintln(a.printer.Out, "  # Homebrew")
	fmt.Fprintln(a.printer.Out, "  brew upgrade playxoft/tap/xecret")
	fmt.Fprintln(a.printer.Out, "")
	fmt.Fprintln(a.printer.Out, "  # anywhere else — the installer verifies the SHA-256 before unpacking")
	fmt.Fprintln(a.printer.Out, "  curl -fsSL "+installBase+"/install.sh | sh")
	fmt.Fprintln(a.printer.Out, "")
	a.printer.Infof("Release notes: %s", latest.HTMLURL)
	return nil
}

type release struct {
	TagName string `json:"tag_name"`
	HTMLURL string `json:"html_url"`
}

// latestRelease asks GitHub what the newest published release is.
//
// Deliberately not built on the api.Client: that type attaches the bearer
// token to every request it makes, and this request goes to a third party.
// Nothing about the caller's credential belongs in it.
func latestRelease(ctx context.Context) (*release, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, releasesEndpoint, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("User-Agent", userAgent())

	response, err := (&http.Client{Timeout: 15 * time.Second}).Do(request)
	if err != nil {
		return nil, errors.New("could not reach github.com to check for a newer release")
	}
	defer response.Body.Close()

	if response.StatusCode == http.StatusNotFound {
		return nil, errors.New("no published release yet — you are running a pre-release build")
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		// Most often GitHub's unauthenticated rate limit, which is per IP and
		// resets within the hour. Worth naming rather than reporting a bare 403.
		return nil, fmt.Errorf("github.com answered %d; if this is a rate limit, it resets within the hour",
			response.StatusCode)
	}

	var latest release
	// 1 MB is far past any release payload and stops a redirected request from
	// making the CLI buffer without limit.
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&latest); err != nil {
		return nil, errors.New("could not read the release list from github.com")
	}
	if latest.TagName == "" {
		return nil, errors.New("github.com did not name a latest release")
	}
	return &latest, nil
}

// compareVersions orders two dotted numeric versions: negative when a is
// older, zero when they match, positive when a is newer.
//
// Not a full semver implementation. It compares the numeric fields and treats
// any pre-release suffix as older than the release it precedes, which is the
// only comparison this command makes — and a version string that does not
// parse compares as older, so the honest failure is "you are told to upgrade",
// never "you are told you are current" when nobody knows.
func compareVersions(a, b string) int {
	fieldsA, preA := splitVersion(a)
	fieldsB, preB := splitVersion(b)

	for i := 0; i < 3; i++ {
		if fieldsA[i] != fieldsB[i] {
			if fieldsA[i] < fieldsB[i] {
				return -1
			}
			return 1
		}
	}

	switch {
	case preA == preB:
		return 0
	case preA != "" && preB == "":
		// 1.2.0-rc.1 precedes 1.2.0.
		return -1
	case preA == "" && preB != "":
		return 1
	case preA < preB:
		return -1
	default:
		return 1
	}
}

// splitVersion reads major, minor and patch, plus whatever pre-release suffix
// followed. Missing or unparseable fields read as -1, which sorts below every
// real version.
func splitVersion(version string) ([3]int, string) {
	numbers := [3]int{-1, -1, -1}

	core, pre, _ := strings.Cut(strings.TrimPrefix(version, "v"), "-")
	for i, field := range strings.SplitN(core, ".", 3) {
		if i > 2 {
			break
		}
		parsed, err := strconv.Atoi(strings.TrimSpace(field))
		if err != nil {
			break
		}
		numbers[i] = parsed
	}
	return numbers, pre
}

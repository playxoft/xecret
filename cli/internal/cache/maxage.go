package cache

import (
	"fmt"
	"os"
	"strings"
	"time"
)

// How old an offline copy may be before this machine stops serving it.
//
// ── Why an unbounded cache is a revocation bypass ──
//
// The cache is written to survive an outage, and the outage it was written for
// lasts an afternoon. Nothing in it expires, though, so a laptop that pulled an
// environment in March and has run `--offline` ever since is still injecting
// March's values — and, more to the point, is still holding a *grant*. A key
// rotation is how access is taken away in this product: the environment gets a
// new data key, the departing principal is not sealed a grant to it, and every
// value written afterwards is unreadable to them. That works perfectly against
// the API and not at all against a file. The old grant opens the old ciphertext
// for as long as the file exists, so an unbounded cache turns "revoked in
// March" into "revoked whenever this machine next reaches the network".
//
// A bound does not fix that — it puts a ceiling on it. Seven days is the
// default because it is longer than any outage this product has cause to
// survive and shorter than a notice period; a machine that has not reached the
// deployment in a week is a machine whose access nobody has been able to
// confirm.
//
// ── Why it is overridable, and why the override is loud ──
//
// An air-gapped build host is a real thing, and a bound that cannot be raised
// would make this binary unusable on one. So it can be raised — and raising it
// prints the trade-off in the words above, because the person who sets
// `--max-cache-age 90d` in a CI script is not the person who will later ask why
// a rotation did not take effect.

// DefaultMaxAge is how long an offline copy is served for without being asked.
const DefaultMaxAge = 7 * 24 * time.Hour

// MaxAgeEnv raises or lowers the bound for a machine rather than for a command.
const MaxAgeEnv = "XECRET_CACHE_MAX_AGE"

// ResolveMaxAge reads the bound from the flag, then the environment, then the
// default, and reports whether it came from one of the first two.
//
// The grammar is `time.ParseDuration`'s plus a `d` suffix for days, which is the
// unit a week-long bound is actually spoken in — the same accommodation
// `--since` makes for the audit log. `0` disables the bound outright and counts
// as an override, so it is announced like any other.
func ResolveMaxAge(flagValue string) (time.Duration, bool, error) {
	if trimmed := strings.TrimSpace(flagValue); trimmed != "" {
		age, err := parseMaxAge("--max-cache-age", trimmed)
		return age, true, err
	}
	if trimmed := strings.TrimSpace(os.Getenv(MaxAgeEnv)); trimmed != "" {
		age, err := parseMaxAge(MaxAgeEnv, trimmed)
		return age, true, err
	}
	return DefaultMaxAge, false, nil
}

func parseMaxAge(source, value string) (time.Duration, error) {
	if rest, found := strings.CutSuffix(value, "d"); found {
		if hours, err := time.ParseDuration(rest + "h"); err == nil {
			return checkedMaxAge(source, value, hours*24)
		}
	}
	duration, err := time.ParseDuration(value)
	if err != nil {
		return 0, fmt.Errorf("could not read %s %q as a duration (12h, 7d, or 0 for no bound)", source, value)
	}
	return checkedMaxAge(source, value, duration)
}

func checkedMaxAge(source, value string, duration time.Duration) (time.Duration, error) {
	if duration < 0 {
		return 0, fmt.Errorf("%s counts forwards from when the copy was written, so %q must not be negative",
			source, value)
	}
	return duration, nil
}

// TooOld reports whether an entry is past the bound. A bound of zero is no
// bound at all, which is what `--max-cache-age 0` asks for.
func (e *Entry) TooOld(maxAge time.Duration, now time.Time) bool {
	if maxAge <= 0 {
		return false
	}
	return now.Sub(e.FetchedAt) > maxAge
}

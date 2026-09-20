// Package notice remembers what the user has already been told, so that a
// reminder stays a reminder and does not become noise.
//
// One file, `~/.xecret/notices.json`, holding a version string and a date. It
// is deliberately *not* under `cache.Dir()`: `xecret cache clear` and `logout`
// wipe that directory, and neither is a request to be nagged again.
//
// Nothing here is secret — it is a version number and a day — but the file is
// written 0600 through a temporary file and a rename, exactly as the cache and
// the mode pin are. A half-written state file reads as "never told them", and
// the failure mode of that is showing a notice twice, which is the direction
// this should fail in.
package notice

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"github.com/playxoft/xecret/cli/internal/keyring"
)

const upgradeFile = "notices.json"

// state is the whole file. A struct rather than a bare string because the next
// thing anybody adds here is a second kind of notice, and a map keyed on a
// field name is how that arrives without a migration.
type state struct {
	// UpgradeVersion is the release the user was last told about.
	UpgradeVersion string `json:"upgradeVersion,omitempty"`
	// UpgradeShownOn is the day it was last shown, as YYYY-MM-DD in local time.
	//
	// A date and not a timestamp: "once a day" should mean what a person means
	// by it. A timestamp with a 24 h window makes the notice drift later each
	// day until it lands in the middle of an afternoon's work, and it makes the
	// test assert on a clock instead of on a decision.
	UpgradeShownOn string `json:"upgradeShownOn,omitempty"`
}

// ShouldShowUpgrade reports whether to show a notice for version today, and is
// the only place that decision is made.
//
// It says yes when the version is one the user has not been told about, or when
// they were told about it on an earlier day. So a user who ignores the notice
// sees it once a day; a user who was told about 0.2.0 yesterday and finds 0.3.0
// today is told straight away, because a newer release is new information.
func ShouldShowUpgrade(version string, now time.Time) bool {
	if version == "" {
		return false
	}

	current := read()
	if current.UpgradeVersion != version {
		return true
	}
	return current.UpgradeShownOn != day(now)
}

// RecordUpgradeShown notes that the notice for version was shown today.
//
// Returns nothing. A failure to write means the user is told again tomorrow —
// or, at worst, on the next command — and that is not worth a word of output on
// a command that did something else entirely and succeeded at it.
func RecordUpgradeShown(version string, now time.Time) {
	_ = write(state{UpgradeVersion: version, UpgradeShownOn: day(now)})
}

func day(now time.Time) string { return now.Format("2006-01-02") }

func path() string { return filepath.Join(keyring.ConfigDir(), upgradeFile) }

// read returns the zero state for every failure. A corrupt or unreadable file
// means "they have not been told", which shows one extra notice rather than
// silencing one that was due.
func read() state {
	raw, err := os.ReadFile(path())
	if err != nil {
		return state{}
	}

	var current state
	if err := json.Unmarshal(raw, &current); err != nil {
		return state{}
	}
	return current
}

func write(next state) error {
	encoded, err := json.Marshal(next)
	if err != nil {
		return err
	}

	dir := keyring.ConfigDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}

	tmp, err := os.CreateTemp(dir, ".notices-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())

	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(encoded); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path())
}

package api

import "sync"

// What the server said about CLI releases, picked up off replies this process
// was already receiving.
//
// ── Why this is not a version check ──
// `cmd/xecret/upgrade.go` states the rule: nothing in this CLI phones anywhere
// to ask whether it is current, because that request would describe which
// machine runs which build of a secret-management client, and as a side effect
// of `xecret run` it would ship out of every CI job in the world. Reading two
// headers off a response that had already arrived asks nobody anything. Delete
// this file and not one byte of network traffic changes.
//
// The server volunteers it — see `apps/web/src/lib/cli-release.ts` — so a
// deployment that says nothing produces no notice, which is the correct
// behaviour for an old server, a self-hoster who would rather not, and every
// offline path.
//
// ── Why package state ──
// A `Client` is built per command and thrown away, sometimes more than one per
// invocation (`login` builds an unauthenticated client, then an authenticated
// one), while the notice is rendered once at the end of `dispatch`, which holds
// no client at all. Threading a value from every construction site up to `main`
// would touch every command to carry something no command uses.
//
// This is a single-shot process: one invocation, one exit. The mutex is for the
// commands that fan out concurrent requests (`pull`, `run`), not for any
// lifetime that outlives the command.
type AdvertisedRelease struct {
	// Version is the release the server recommends, e.g. "0.2.0". Never has a
	// leading "v" — the server sends plain dotted numbers.
	Version string
	// Headline is one line on why it is worth having. May be empty: a server
	// can name a version without arguing for it, and the notice renders fine
	// with just the number.
	Headline string
}

const (
	latestHeader   = "x-xecret-cli-latest"
	headlineHeader = "x-xecret-cli-headline"
)

var (
	advertisedMu sync.Mutex
	advertised   *AdvertisedRelease
)

// noteAdvertised records what a response said, if it said anything.
//
// Last writer wins, and no call site cares: within one invocation every
// response comes from the same deployment, so the values agree. A blank version
// is ignored rather than stored, so a server that sets the headline alone
// cannot produce a notice recommending no version at all.
func noteAdvertised(version, headline string) {
	if version == "" {
		return
	}

	advertisedMu.Lock()
	defer advertisedMu.Unlock()
	advertised = &AdvertisedRelease{Version: version, Headline: headline}
}

// Advertised returns what this process was told, or nil if nothing was.
func Advertised() *AdvertisedRelease {
	advertisedMu.Lock()
	defer advertisedMu.Unlock()
	return advertised
}

// ForgetAdvertised clears the record. For tests, which share a process and
// would otherwise inherit whatever an earlier case's fake server advertised.
func ForgetAdvertised() {
	advertisedMu.Lock()
	defer advertisedMu.Unlock()
	advertised = nil
}

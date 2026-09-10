package cache

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// Trust-on-first-use pinning for an environment's encryption mode.
//
// ── The attack ──
//
// Every read and write below branches on what `GET …/keys` said the mode is. A
// `server`-mode environment is transported in plaintext by design: the server
// holds the key, so `xecret set` sends a value and `xecret run` receives one.
// That is correct for an environment that really is in that mode, and it is a
// disclosure for one that is not.
//
// Nothing in the response authenticates the mode. It is a column, not a signed
// statement, and there is no key it is bound to — so a malicious or compromised
// deployment that flips an environment from `e2ee` to `server` collects every
// value written afterwards, in the clear, while every command reports success.
// The CLI is the worse half of that: `xecret run` injects what it is given into
// a child process with nothing on screen, and a CI job does it unattended.
//
// ── What closes it, and what it costs ──
//
// Continuity. Once this machine has seen an environment answer `e2ee`, a later
// `server` answer is refused with the reasoning printed rather than obeyed. The
// `server` → `e2ee` direction pins forward and is never refused: that is the
// migration, and it takes capability away from the server.
//
// The pin is a file, so a `--no-cache` run neither writes nor gains one, and an
// attacker who can already write to this machine's config directory can remove
// it — as they could remove the credential beside it. The guarantee is exactly
// "the answer changed since the last time this machine looked", which is a
// sentence a person can act on, and it is the same guarantee the dashboard's
// `pins.ts` offers for public keys.
//
// The remedy is deliberately `xecret cache clear`, which is also how a genuine
// migration back to server-side encryption is accepted — after asking whoever
// runs the deployment, which is the point.

// modeFile is where the pins live: one small JSON object beside the cache
// files, removed by `Clear` along with them.
const modeFile = "modes.json"

// ErrModeDowngrade is a server reporting `server` for an environment this
// machine has seen as `e2ee`.
var ErrModeDowngrade = errors.New("this environment is no longer reporting end-to-end encryption")

// ErrPlaintextRefused is the offline half of the same pin: a plaintext cache
// file left over from before an environment was migrated, for an environment the
// pin now says is `e2ee`.
//
// The live path already refuses a `server` answer for such an environment. The
// offline path had no equivalent — it tried the encrypted copy, missed, and fell
// through to whatever plaintext file was still lying there from before the
// migration. That file is exactly what the migration removed the server's
// ability to produce, and serving it out of a cache re-creates the disclosure
// locally, quietly, on a command whose whole purpose is to run unattended.
var ErrPlaintextRefused = errors.New("this environment is end-to-end encrypted and has no offline copy this machine can read")

// PinnedMode returns the mode this machine last recorded for a scope, or "".
//
// Every failure reads as "no pin": an unreadable or corrupt file means this
// machine has no record, which is the true statement and permits the answer
// rather than blocking every command behind a file nobody can explain.
func PinnedMode(scope Scope) string {
	return readModes()[modeKey(scope)]
}

// PinMode records the mode a successful request reported.
//
// Only ever upward. A `server` pin is replaced by `e2ee`; an `e2ee` pin is never
// replaced here, because the only way it could be is the transition
// [CheckMode] exists to refuse — and a function that could quietly erase the pin
// that would have stopped it is a hole in the same shape as the one this closes.
func PinMode(scope Scope, mode string) error {
	if mode != "server" && mode != "e2ee" {
		return fmt.Errorf("unknown encryption mode %q", mode)
	}

	modes := readModes()
	key := modeKey(scope)
	if current := modes[key]; current == mode || current == "e2ee" {
		return nil
	}

	modes[key] = mode
	return writeModes(modes)
}

// CheckMode refuses a downgrade, and says why.
//
// The error carries the whole argument rather than a code, because the person
// reading it has to make a judgement no program can make for them: either this
// deployment genuinely migrated the environment back — which an administrator
// can confirm — or the answer did not come from this deployment, in which case
// clearing the pin is precisely what an attacker needs.
func CheckMode(scope Scope, mode string) error {
	if mode != "server" || PinnedMode(scope) != "e2ee" {
		return nil
	}

	return fmt.Errorf(
		"%w.\n"+
			"  This machine has read %s/%s as end-to-end encrypted before. A 'server' answer means\n"+
			"  values would travel in plaintext, so nothing will be read or written until it is\n"+
			"  explained.\n"+
			"  If an administrator confirms the environment really was migrated back, accept it with\n"+
			"  'xecret cache clear'. If nobody can confirm it, do not: clearing the pin is exactly\n"+
			"  what a substituted answer needs to succeed",
		ErrModeDowngrade, scope.Project, scope.Environment,
	)
}

// modeKey identifies a scope without naming it.
//
// The same digest the cache files use, for the same reason: slugs never appear
// in a directory listing. Deliberately *not* keyed on any id the server chose —
// a deployment willing to lie about the mode would file its lie under a fresh id
// and miss the pin entirely, so the key is what this process asked for.
func modeKey(scope Scope) string {
	unpinned := scope
	unpinned.Encrypted = false
	digest := sha256.Sum256([]byte(aad(unpinned)))
	return hex.EncodeToString(digest[:12])
}

func modePath() string { return filepath.Join(Dir(), modeFile) }

func readModes() map[string]string {
	raw, err := os.ReadFile(modePath())
	if err != nil {
		return map[string]string{}
	}

	var modes map[string]string
	if err := json.Unmarshal(raw, &modes); err != nil || modes == nil {
		return map[string]string{}
	}
	return modes
}

func writeModes(modes map[string]string) error {
	// encoding/json sorts map keys, so the file is stable across writes and a
	// diff of it — which an operator debugging this will produce — shows only
	// what changed.
	encoded, err := json.Marshal(modes)
	if err != nil {
		return err
	}

	if err := os.MkdirAll(Dir(), 0o700); err != nil {
		return err
	}

	// Write-then-rename, 0600 from birth, exactly as the cache files are: this
	// holds no secret, but a half-written pin file that reads as "no pin" is a
	// protection that silently switches itself off.
	tmp, err := os.CreateTemp(Dir(), ".modes-*")
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
	return os.Rename(tmp.Name(), modePath())
}

// Package cred persists the CLI's identity: which deployment it talks to, as
// whom, in which organisation. The token inside is the only secret; the rest
// exists so `whoami` and every API path can be answered without a network
// round trip.
package cred

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/playxoft/xecret/cli/internal/ids"
	"github.com/playxoft/xecret/cli/internal/keyring"
)

// storeKey is the single slot credentials live under. One login at a time:
// `xecret login` replaces, `xecret logout` clears. Multiple simultaneous
// accounts is a feature the config file format deliberately does not invite.
const storeKey = "credentials"

// ErrNotLoggedIn is the uniform "run xecret login first" signal.
var ErrNotLoggedIn = errors.New("not signed in. Run 'xecret login' first")

// Credentials is everything `xecret login` establishes.
//
// ── How the organisation is named ──
//
// By its id. The id is what every resource path addresses (see [Credentials.OrgRef])
// and what every secret ciphertext binds into its AAD, and it is the one name an
// organisation has that is unique and can never change. Its name is free text,
// shared by as many organisations as care to use it, and is kept for output
// alone.
//
// The slug an organisation was once addressed by is still stored, unseen. A
// credential written before ids were the key holds nothing else, and keeps
// working by it until the id is filled in on first use; a binary from before
// the change, run after a downgrade, reads nothing else; and the offline copies
// and mode pins those builds filed under the slug are found through it.
type Credentials struct {
	// APIURL is the deployment origin the token belongs to. Stored so a
	// self-hoster's login sticks without exporting XECRET_API_URL forever.
	APIURL string `json:"apiUrl"`
	// Token is the bearer credential. Never printed, never logged.
	Token string `json:"token"`
	// OrgSlug is the organisation's legacy slug, a hidden alias. See the type's
	// comment for the three things that still need it; nothing prints it.
	OrgSlug string `json:"orgSlug"`
	// Email identifies the account for `whoami` and the logout message.
	Email string `json:"email"`
	// UserID and OrgID are the two AAD components a member's decryption path
	// needs and cannot derive from anything else: every private-key wrap binds
	// the user id, every secret ciphertext binds the org id. OrgID is also the
	// organisation's primary name, the one every API path uses.
	//
	// Recorded at login so the steady state costs no extra request. Empty on a
	// credential written by an older build, which the commands that need them
	// fill in on first use rather than refusing.
	UserID string `json:"userId,omitempty"`
	OrgID  string `json:"orgId,omitempty"`
	// OrgName is the organisation's display name, as the server last reported
	// it. Output only: it is neither unique nor permanent, so nothing is ever
	// looked up by it.
	OrgName string `json:"orgName,omitempty"`
}

// OrgRef is how every API path names this credential's organisation: its id
// once known, and until then the legacy slug, which the API accepts too.
func (c *Credentials) OrgRef() string {
	if c.OrgID != "" {
		return c.OrgID
	}
	return c.OrgSlug
}

// NamesOrg reports whether ref, an organisation reference as a path or a
// `.xecret.yaml` holds one, is this credential's organisation: by its id, or by
// the legacy slug that is its alias.
//
// An id is compared in its canonical lowercase spelling and otherwise exactly.
// A slug is compared without regard to case, as the server compares it: slugs
// are `citext`, so `Acme` and `acme` name the same organisation there, and
// must here too.
func (c *Credentials) NamesOrg(ref string) bool {
	if ref == "" {
		return false
	}
	if id, ok := ids.Canonical(ref); ok {
		return c.OrgID != "" && id == c.OrgID
	}
	return SameSlug(ref, c.OrgSlug)
}

// IsOrg reports whether an organisation the server listed, with this id and
// slug, is this credential's. The id decides whenever this credential holds
// one; the slug, compared without regard to case, answers only for a
// credential that holds nothing else.
func (c *Credentials) IsOrg(id, slug string) bool {
	if c.OrgID != "" {
		return id == c.OrgID
	}
	return SameSlug(slug, c.OrgSlug)
}

// SameSlug reports whether two legacy slugs name the same organisation: both
// present, and equal without regard to case, because the column they come from
// is `citext`. Never for an id, which is compared exactly.
func SameSlug(a, b string) bool {
	return a != "" && b != "" && strings.EqualFold(a, b)
}

// OrgLabel is the organisation as output names it: by its name, or by its id
// when no name is known. Never by the slug. Empty only for a credential an
// older build wrote, before it recorded either.
func (c *Credentials) OrgLabel() string {
	if c.OrgName != "" {
		return c.OrgName
	}
	return c.OrgID
}

// Save stores credentials, replacing any previous login.
func Save(store keyring.Store, credentials Credentials) error {
	payload, err := json.Marshal(credentials)
	if err != nil {
		return err
	}
	if err := store.Set(storeKey, string(payload)); err != nil {
		return fmt.Errorf("storing credentials: %w", err)
	}
	return nil
}

// Load returns the stored credentials, or ErrNotLoggedIn.
func Load(store keyring.Store) (*Credentials, error) {
	payload, err := store.Get(storeKey)
	if err != nil {
		if keyring.IsNotFound(err) {
			return nil, ErrNotLoggedIn
		}
		return nil, fmt.Errorf("reading credentials: %w", err)
	}

	var credentials Credentials
	if err := json.Unmarshal([]byte(payload), &credentials); err != nil {
		return nil, errors.New("stored credentials are corrupt. Run 'xecret login' again")
	}
	if credentials.Token == "" || credentials.APIURL == "" {
		return nil, ErrNotLoggedIn
	}
	return &credentials, nil
}

// Clear removes stored credentials. Absent counts as cleared.
func Clear(store keyring.Store) error {
	err := store.Delete(storeKey)
	if err != nil && !keyring.IsNotFound(err) {
		return fmt.Errorf("removing credentials: %w", err)
	}
	return nil
}

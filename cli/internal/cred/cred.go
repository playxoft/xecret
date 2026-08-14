// Package cred persists the CLI's identity: which deployment it talks to, as
// whom, in which organisation. The token inside is the only secret; the rest
// exists so `whoami` and every API path can be answered without a network
// round trip.
package cred

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/playxoft/xecret/cli/internal/keyring"
)

// storeKey is the single slot credentials live under. One login at a time:
// `xecret login` replaces, `xecret logout` clears. Multiple simultaneous
// accounts is a feature the config file format deliberately does not invite.
const storeKey = "credentials"

// ErrNotLoggedIn is the uniform "run xecret login first" signal.
var ErrNotLoggedIn = errors.New("not signed in — run 'xecret login' first")

// Credentials is everything `xecret login` establishes.
type Credentials struct {
	// APIURL is the deployment origin the token belongs to. Stored so a
	// self-hoster's login sticks without exporting XECRET_API_URL forever.
	APIURL string `json:"apiUrl"`
	// Token is the bearer credential. Never printed, never logged.
	Token string `json:"token"`
	// OrgSlug scopes every resource path; the token is pinned to it server-side.
	OrgSlug string `json:"orgSlug"`
	// Email identifies the account for `whoami` and the logout message.
	Email string `json:"email"`
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
		return nil, errors.New("stored credentials are corrupt — run 'xecret login' again")
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

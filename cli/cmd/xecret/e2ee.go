package main

import (
	"context"
	"errors"
	"fmt"

	"github.com/playxoft/xecret/cli/internal/api"
	"github.com/playxoft/xecret/cli/internal/cache"
	"github.com/playxoft/xecret/cli/internal/cred"
	"github.com/playxoft/xecret/cli/internal/e2ee"
	"github.com/playxoft/xecret/cli/internal/envkeys"
)

// The dual-mode seam: one place that decides how this process holds a key, so
// no command has to.
//
// Every read and write below branches on what the *API returned*, never on a
// flag and never on a guess. A `server`-mode environment behaves exactly as it
// did before — the server decrypts, the CLI transports bytes — and an `e2ee` one
// decrypts here. An environment that changes mode changes behaviour on the next
// command, with no configuration to update.

// principal resolves how this process opens grants.
//
// Two shapes, and the difference is where the key comes from. A service token
// carries its X25519 scalar in its own token string, so this costs nothing. A
// login opens its user's private key with the User Key the browser handed over,
// which costs one request for the vault material.
func (a *app) principal(
	ctx context.Context,
	client *api.Client,
	credentials *cred.Credentials,
) (*envkeys.Principal, error) {
	if a.usingServiceToken() {
		if a.tokenScope == nil {
			return nil, errors.New("the service token has not been introspected")
		}
		return envkeys.ServicePrincipal(serviceTokenFromEnv(), a.tokenScope)
	}

	// A credential written before this build carries no ids. Filled in on first
	// use rather than refused: the alternative is telling somebody who is signed
	// in to sign in again for a field they never knew existed.
	if credentials.UserID == "" || credentials.OrgID == "" {
		if err := a.backfillIdentity(ctx, client, credentials); err != nil {
			return nil, err
		}
	}

	return envkeys.MemberPrincipal(ctx, client, a.store, credentials.UserID, credentials.OrgID)
}

// backfillIdentity records the ids a pre-Phase-4 login never stored.
func (a *app) backfillIdentity(
	ctx context.Context,
	client *api.Client,
	credentials *cred.Credentials,
) error {
	me, err := client.FetchMe(ctx)
	if err != nil {
		return err
	}

	credentials.UserID = me.User.ID
	for _, organization := range me.Organizations {
		if organization.Slug == credentials.OrgSlug {
			credentials.OrgID = organization.ID
		}
	}
	if credentials.UserID == "" || credentials.OrgID == "" {
		return errors.New("this deployment did not identify the account; upgrade the server")
	}

	// Saved so the next command does not repeat the round trip. A failure to
	// persist is not fatal — the ids are correct in memory for this command.
	if err := cred.Save(a.store, *credentials); err != nil {
		a.printer.Warnf("could not record this account's identity for next time: %v", err)
	}
	return nil
}

// cacheScope is the identity a mode pin and an offline copy are filed under.
func cacheScope(credentials *cred.Credentials, resolved scope) cache.Scope {
	return cache.Scope{
		Host:        credentials.APIURL,
		Org:         resolved.Org,
		Project:     resolved.Project,
		Environment: resolved.Environment,
	}
}

// checkMode refuses a server that has stopped reporting end-to-end encryption
// for an environment, and records the answer when it accepts it.
//
// Two pins, and they close different halves of the same hole:
//
//   - A **service token that carries a key half** is itself the statement that
//     this environment was end-to-end encrypted when the token was minted, in a
//     string the server cannot edit after the fact. That is the only pin CI ever
//     gets — a runner is ephemeral and writes no files — and it is the strongest
//     one available anywhere, so it is checked first.
//   - Otherwise the offline cache's mode book answers, on the trust-on-first-use
//     terms `cache/mode.go` sets out.
//
// Recording is skipped under a service token for the reason `run` gives about
// the cache generally: a CI credential must leave nothing behind on a runner it
// does not own.
func (a *app) checkMode(credentials *cred.Credentials, resolved scope, mode string) error {
	if a.usingServiceToken() {
		parsed, err := e2ee.SplitServiceToken(serviceTokenFromEnv())
		if err == nil {
			defer parsed.Zeroize()
			if parsed.PrivateKey != nil && mode != "e2ee" {
				return fmt.Errorf(
					"%w.\n"+
						"  XECRET_TOKEN carries an environment key, which is only minted for an\n"+
						"  end-to-end encrypted environment — so a 'server' answer means either the\n"+
						"  environment was migrated back or this is not the deployment that issued\n"+
						"  the token. Confirm with an administrator before re-issuing it",
					cache.ErrModeDowngrade,
				)
			}
		}
		return nil
	}

	key := cacheScope(credentials, resolved)
	if err := cache.CheckMode(key, mode); err != nil {
		return err
	}
	if err := cache.PinMode(key, mode); err != nil {
		// A pin that could not be written degrades to first contact next time,
		// which over-permits once rather than failing a command over a file.
		a.printer.Warnf("could not record this environment's encryption mode: %v", err)
	}
	return nil
}

// openEnvironment turns a pull into the flat name→value map the rest of the CLI
// speaks, whichever mode the environment is in.
//
// For an `e2ee` environment the bundle's own key state is what opens it — never
// a second `GET …/keys`, because a rotation landing between the two reads would
// hand this process a key for the wrong version and a decryption failure with no
// explanation.
func (a *app) openEnvironment(
	ctx context.Context,
	client *api.Client,
	credentials *cred.Credentials,
	pulled *api.Pulled,
) (map[string]string, error) {
	if pulled.Bundle == nil {
		return nil, errors.New("this environment is not end-to-end encrypted")
	}

	principal, err := a.principal(ctx, client, credentials)
	if err != nil {
		return nil, err
	}
	defer principal.Close()

	return envkeys.DecryptBundle(pulled.Bundle, principal)
}

// openKeys opens an environment's key state on its own, for the write paths and
// for `secrets get`, which do not pull every value.
func (a *app) openKeys(
	ctx context.Context,
	client *api.Client,
	credentials *cred.Credentials,
	resolved scope,
) (*envkeys.Material, error) {
	keys, err := client.EnvironmentKeyState(ctx, resolved.Org, resolved.Project, resolved.Environment)
	if err != nil {
		return nil, err
	}
	// Before the mode is believed. A `server` answer sends this command down the
	// plaintext path, which is correct for an environment that is in that mode
	// and a disclosure for one that is not — see `cache/mode.go`.
	if err := a.checkMode(credentials, resolved, keys.EncryptionMode); err != nil {
		return nil, err
	}
	if keys.EncryptionMode != "e2ee" {
		return nil, nil
	}

	principal, err := a.principal(ctx, client, credentials)
	if err != nil {
		return nil, err
	}
	defer principal.Close()

	return envkeys.Open(*keys, principal)
}

// e2eeHint turns the two errors a user can act on into instructions.
//
// Everything else keeps its own words: a decryption failure is deliberately
// uniform (spec §5.2) and inventing a cause for it here would be inventing one.
func e2eeHint(err error) string {
	switch {
	case errors.Is(err, envkeys.ErrNoUserKey):
		return "Run 'xecret login' to hand this machine a vault key."
	case errors.Is(err, envkeys.ErrNoGrant):
		return "Ask a teammate to share this environment's key from the dashboard."
	case errors.Is(err, envkeys.ErrRotatedAway):
		return "Only the current version of a secret survives a key rotation."
	}
	return ""
}

// withE2eeHint appends the instruction, when there is one to append.
func withE2eeHint(err error) error {
	if hint := e2eeHint(err); hint != "" {
		return fmt.Errorf("%w. %s", err, hint)
	}
	return err
}

// exportDocument produces the file `export` writes, in whichever mode the
// environment is in.
//
// The server refuses to export an end-to-end encrypted environment — it holds no
// key to render one with — so that path pulls the bundle and renders locally.
// The audit record is a `secret.read` from the pull rather than the export's own
// action, which is a difference worth knowing when reading an audit log: the
// distinction the two endpoints exist to draw survives only where the server can
// still see the values.
func (a *app) exportDocument(
	ctx context.Context,
	client *api.Client,
	credentials *cred.Credentials,
	resolved scope,
	format string,
) ([]byte, error) {
	document, err := client.Export(ctx, resolved.Org, resolved.Project, resolved.Environment, format)
	if err == nil {
		return document, nil
	}

	apiErr, ok := api.AsError(err)
	if !ok || apiErr.Status != 409 {
		return nil, err
	}

	pulled, pullErr := client.Pull(ctx, resolved.Org, resolved.Project, resolved.Environment, format)
	if pullErr != nil {
		return nil, pullErr
	}
	if pulled.Bundle == nil {
		// The export refused for a reason that was not the encryption mode, and
		// the pull did not disagree. The original refusal is the honest answer.
		return nil, err
	}

	secrets, openErr := a.openEnvironment(ctx, client, credentials, pulled)
	if openErr != nil {
		return nil, withE2eeHint(openErr)
	}
	return formatSecrets(secrets, format)
}

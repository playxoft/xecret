package main

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/playxoft/xecret/cli/internal/api"
	"github.com/playxoft/xecret/cli/internal/cache"
	"github.com/playxoft/xecret/cli/internal/config"
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

// principal resolves how this process opens grants, for the organisation the
// scope addresses.
//
// Two shapes, and the difference is where the key comes from. A service token
// carries its X25519 scalar in its own token string, so this costs nothing. A
// login opens its user's private key with the User Key the browser handed over,
// which costs one request for the vault material.
//
// The principal's OrgID is the scope's organisation, not necessarily the
// credential's: a `.xecret.yaml` can name another one, and every ciphertext in
// it binds that organisation's id. A principal carrying the credential's id
// there would fail to open anything, and would seal every write to an AAD no
// reader in that organisation could verify.
func (a *app) principal(
	ctx context.Context,
	client *api.Client,
	credentials *cred.Credentials,
	resolved scope,
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
	if credentials.UserID == "" {
		if err := a.backfillIdentity(ctx, client, credentials); err != nil {
			return nil, err
		}
	}
	orgID, _, err := a.orgIdentity(ctx, client, credentials, resolved, true)
	if err != nil {
		return nil, err
	}

	return envkeys.MemberPrincipal(ctx, client, a.store, credentials.UserID, orgID)
}

// offlinePrincipal resolves the same identity from what this machine holds,
// making no request.
//
// For the two paths that have no network by definition: `--offline`, and the
// fallback a network failure lands on. A service token needs nothing either way
// — its scalar is in its own token string — but it never reaches here, because
// `run` refuses `--offline` under one and forces `--no-cache` for it.
//
// A login that predates the stored wraps fails here with an error saying one
// online command fixes it for ever, which is the true statement: the hand-off
// gave this machine the User Key and nothing else, and the wrap it opens was
// fetched fresh on every command until now.
func (a *app) offlinePrincipal(credentials *cred.Credentials, resolved scope) (*envkeys.Principal, error) {
	if a.usingServiceToken() {
		if a.tokenScope == nil {
			return nil, errors.New("the service token has not been introspected")
		}
		return envkeys.ServicePrincipal(serviceTokenFromEnv(), a.tokenScope)
	}
	orgID, _, err := a.orgIdentity(context.Background(), nil, credentials, resolved, true)
	if err != nil {
		return nil, err
	}
	return envkeys.OfflineMemberPrincipal(a.store, credentials.UserID, orgID)
}

// backfillIdentity records what an older login never stored: the user's id
// (before Phase 4), and the organisation's id and name (before organisation
// ids replaced slugs). Such a credential has been addressing the API by its
// slug, and does from here on by the id.
func (a *app) backfillIdentity(
	ctx context.Context,
	client *api.Client,
	credentials *cred.Credentials,
) error {
	me, err := a.fetchMe(ctx, client)
	if err != nil {
		return err
	}

	a.recordIdentity(credentials, me)
	if credentials.UserID == "" || credentials.OrgID == "" {
		return errors.New("this deployment did not identify the account; upgrade the server")
	}
	return nil
}

// recordIdentity adopts what GET /api/auth/me says into the credential and,
// when that changed anything, saves it so the next command does not repeat
// the round trip. A failure to persist is not fatal: the ids are correct in
// memory for this command.
func (a *app) recordIdentity(credentials *cred.Credentials, me *api.Me) {
	if !adoptIdentity(credentials, me) {
		return
	}
	if err := cred.Save(a.store, *credentials); err != nil {
		a.printer.Warnf("could not record this account's identity for next time: %v", err)
	}
}

// adoptIdentity fills in what a credential is missing from GET /api/auth/me,
// and reports whether anything changed.
func adoptIdentity(credentials *cred.Credentials, me *api.Me) bool {
	changed := false
	if credentials.UserID == "" && me.User.ID != "" {
		credentials.UserID = me.User.ID
		changed = true
	}
	if adoptOrganization(credentials, me.Organizations) {
		changed = true
	}
	return changed
}

// adoptOrganization finds the credential's organisation in a listing of its
// memberships (by id once it has one, by slug before) and fills in its id and
// slug where missing. The name is refreshed rather than filled: it is free
// text that can be edited, and the stored copy exists only to be printed.
func adoptOrganization(credentials *cred.Credentials, organizations []api.Organization) bool {
	for _, organization := range organizations {
		if !credentials.IsOrg(organization.ID, organization.Slug) {
			continue
		}
		changed := false
		if credentials.OrgID == "" && organization.ID != "" {
			credentials.OrgID = organization.ID
			changed = true
		}
		if credentials.OrgSlug == "" && organization.Slug != "" {
			credentials.OrgSlug = organization.Slug
			changed = true
		}
		if organization.Name != "" && organization.Name != credentials.OrgName {
			credentials.OrgName = organization.Name
			changed = true
		}
		return changed
	}
	return false
}

// orgIdentity names the organisation a scope addresses in the two ways the
// end-to-end paths need it: the id every one of its ciphertexts binds into its
// AAD, and the legacy slugs this machine may have filed mode pins and offline
// copies under before ids were the key.
//
// client nil means offline: only what this machine holds is consulted, and
// nothing is fetched. Online, at most one GET /api/auth/me is made in an
// invocation, and only for what cannot be known locally: the id of a
// credential from before organisation ids, when needID says the caller is
// about to bind it into an AAD, or anything about an organisation other than
// the credential's that a `.xecret.yaml` names, including the slug this
// machine would need to find that organisation's older pins.
//
// The error concerns the id alone. The slugs are best effort: past what the
// credential and the file hold, the server is their only source, and a server
// that wanted to hide one could as easily name a different one.
func (a *app) orgIdentity(
	ctx context.Context,
	client *api.Client,
	credentials *cred.Credentials,
	resolved scope,
	needID bool,
) (string, []string, error) {
	if a.usingServiceToken() {
		if a.tokenScope == nil {
			return "", nil, errors.New("the service token has not been introspected")
		}
		organization := a.tokenScope.Organization
		return organization.ID, []string{organization.Slug}, nil
	}

	if resolved.inCredentialOrg(credentials) {
		// A credential from before ids keeps its pins and copies under the slug
		// until something needs the id; from then on they are found under the
		// id and carried from the slug, so asking early would buy nothing but a
		// request.
		if credentials.OrgID == "" && client != nil && needID {
			if err := a.backfillIdentity(ctx, client, credentials); err != nil {
				return "", []string{credentials.OrgSlug}, err
			}
		}
		// Offline under a credential that predates ids, this is "", and the
		// key read that follows says what one online command fixes.
		return credentials.OrgID, []string{credentials.OrgSlug, resolved.OrgSlug}, nil
	}

	// Another organisation: the one the directory's .xecret.yaml names.
	id, slugs := resolved.OrgID, []string{resolved.OrgSlug}
	var lookupErr error
	if client != nil && (id == "" || resolved.OrgSlug == "") {
		me, err := a.fetchMe(ctx, client)
		if err == nil {
			a.recordIdentity(credentials, me)
			for _, organization := range me.Organizations {
				if (id != "" && organization.ID == id) || (id == "" && organization.Slug == resolved.OrgSlug) {
					id = organization.ID
					slugs = append(slugs, organization.Slug)
					break
				}
			}
		}
		lookupErr = err
	}
	if id != "" {
		return id, slugs, nil
	}

	source := resolved.orgSource
	if source == "" {
		source = config.Filename
	}
	switch {
	case client == nil:
		return "", slugs, fmt.Errorf(
			"%s names its organisation by a legacy slug, which cannot be resolved to an id offline; "+
				"rerun 'xecret init' to pin it by id", source)
	case lookupErr != nil:
		return "", slugs, fmt.Errorf("could not resolve the organisation %s names: %w", source, lookupErr)
	}
	return "", slugs, fmt.Errorf(
		"you are not a member of the organisation %s names; 'xecret orgs' lists the ones you are in", source)
}

// cacheScope is the identity a mode pin and an offline copy are filed under:
// the organisation by its id, carrying every legacy slug this machine knows for
// it, so that what a slug-keyed build filed is still found (see cache.Scope).
//
// client nil means offline, and nothing is fetched. A scope whose id this
// machine does not hold yet (a credential that predates ids, until a command
// needs the id and records it) is filed under the slug, as every scope was
// before.
func (a *app) cacheScope(
	ctx context.Context,
	client *api.Client,
	credentials *cred.Credentials,
	resolved scope,
) cache.Scope {
	id, slugs, _ := a.orgIdentity(ctx, client, credentials, resolved, false)
	org := id
	if org == "" {
		org = resolved.Org
	}
	return cache.Scope{
		Host:        credentials.APIURL,
		Org:         org,
		Project:     resolved.Project,
		Environment: resolved.Environment,
		LegacyOrgs:  slugs,
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
//
// The pin is looked up under the organisation's id and under every legacy slug
// known for it (see cacheScope), so a pin a slug-keyed build recorded still
// refuses, and is recorded under the id from then on.
func (a *app) checkMode(
	ctx context.Context,
	client *api.Client,
	credentials *cred.Credentials,
	resolved scope,
	mode string,
) error {
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

	key := a.cacheScope(ctx, client, credentials, resolved)
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
	resolved scope,
	pulled *api.Pulled,
) (map[string]string, error) {
	if pulled.Bundle == nil {
		return nil, errors.New("this environment is not end-to-end encrypted")
	}

	principal, err := a.principal(ctx, client, credentials, resolved)
	if err != nil {
		return nil, err
	}
	defer principal.Close()

	return envkeys.DecryptBundle(pulled.Bundle, principal)
}

// keyState reads an environment's key state and pins the mode it reported.
//
// Split out from [app.openKeys] for the paths that need to know *which mode* an
// environment is in without needing to open anything — clearing a note is the
// case: it sends a null, and which field that null goes in depends on the mode
// while nothing about it depends on a key. Opening a grant to answer that would
// refuse the operation for somebody who has access and no grant, over a
// requirement the operation does not have.
func (a *app) keyState(
	ctx context.Context,
	client *api.Client,
	credentials *cred.Credentials,
	resolved scope,
) (*api.EnvironmentKeys, error) {
	keys, err := client.EnvironmentKeyState(ctx, resolved.Org, resolved.Project, resolved.Environment)
	if err != nil {
		return nil, err
	}
	// Before the mode is believed. A `server` answer sends this command down the
	// plaintext path, which is correct for an environment that is in that mode
	// and a disclosure for one that is not — see `cache/mode.go`.
	if err := a.checkMode(ctx, client, credentials, resolved, keys.EncryptionMode); err != nil {
		return nil, err
	}
	return keys, nil
}

// openKeys opens an environment's key state on its own, for the write paths and
// for `secrets get`, which do not pull every value.
func (a *app) openKeys(
	ctx context.Context,
	client *api.Client,
	credentials *cred.Credentials,
	resolved scope,
) (*envkeys.Material, error) {
	_, material, err := a.openKeyState(ctx, client, credentials, resolved)
	return material, err
}

// openKeyState is [app.openKeys] that also hands back the key state it opened,
// for the one write that needs something else the state says: `secrets set`
// asks whether the environment is production, because the organisation's
// secret policy may govern production only. Reading it from the same response
// costs nothing, and reading it from a second one would be a second answer.
//
// material is nil for a server-mode environment, as it always has been.
func (a *app) openKeyState(
	ctx context.Context,
	client *api.Client,
	credentials *cred.Credentials,
	resolved scope,
) (*api.EnvironmentKeys, *envkeys.Material, error) {
	keys, err := a.keyState(ctx, client, credentials, resolved)
	if err != nil {
		return nil, nil, err
	}
	if keys.EncryptionMode != "e2ee" {
		return keys, nil, nil
	}

	principal, err := a.principal(ctx, client, credentials, resolved)
	if err != nil {
		return nil, nil, err
	}
	defer principal.Close()

	material, err := envkeys.Open(*keys, principal)
	if err != nil {
		return nil, nil, err
	}
	return keys, material, nil
}

// e2eeHint turns the errors a user can act on into instructions.
//
// Everything else keeps its own words: a decryption failure is deliberately
// uniform (spec §5.2) and inventing a cause for it here would be inventing one.
func e2eeHint(err error) string {
	// First, because a bundle whose every failing row names a retired key
	// satisfies errors.Is for ErrRotatedAway and would otherwise collect a second
	// sentence beneath the list it already prints — one that answers a narrower
	// question than the one the user is looking at.
	var bundleErr *envkeys.BundleError
	if errors.As(err, &bundleErr) {
		return ""
	}

	switch {
	case errors.Is(err, envkeys.ErrNoUserKey):
		return "Run 'xecret login' to hand this machine a vault key."
	case errors.Is(err, envkeys.ErrNoVaultWraps):
		return "Run any xecret command with the API reachable once; this machine keeps what it needs afterwards."
	case errors.Is(err, envkeys.ErrNoGrant):
		return "Ask a teammate to share this environment's key from the dashboard."
	case errors.Is(err, envkeys.ErrRotatedAway):
		// Not "expected and unfixable", which is what this used to imply. A
		// rotation re-seals the *current* value of every secret to the new key,
		// so a current row still naming the retired key means the rotation has
		// not reached it — and writing the value again repairs that row for
		// everybody. It is only the older versions in the history that are gone
		// for good, because nothing re-encrypts those and the retired key was
		// never stored anywhere.
		return "If this is a secret's current value, run 'xecret secrets set' on it to store it under the " +
			"environment's current key. Earlier versions written under a retired key cannot be recovered."
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
	if ok && apiErr.Status == 403 && strings.HasPrefix(apiErr.Message, "export_disabled:") {
		return nil, exportDisabledError(resolved, nil)
	}
	if !ok || apiErr.Status != 409 {
		return nil, err
	}

	pulled, pullErr := client.Pull(ctx, resolved.Org, resolved.Project, resolved.Environment, format)
	if pullErr != nil {
		return nil, pullErr
	}
	// Before anything is decrypted. The server cannot refuse this half — the
	// pull is the same endpoint `run` reads through — so it says what the policy
	// is, and the refusal is this process's to make.
	if pulled.ExportDisabled() {
		return nil, exportDisabledError(resolved, pulled.ExportRefusedBy())
	}
	if pulled.Bundle == nil {
		// The export refused for a reason that was not the encryption mode, and
		// the pull did not disagree. The original refusal is the honest answer.
		return nil, err
	}

	secrets, openErr := a.openEnvironment(ctx, client, credentials, resolved, pulled)
	if openErr != nil {
		return nil, withE2eeHint(openErr)
	}
	return formatSecrets(secrets, format)
}

// exportDisabledError is the refusal `pull` and `export` give when the
// environment's policy disables a plaintext copy (P19 §3), in either mode.
//
// ── Why the client enforces a rule about the client ──
//
// For an end-to-end encrypted environment there is nobody else who can. The
// server serves the same ciphertext to `run` as to `pull`, because the bundle
// is the bundle, and only this process ever holds the plaintext that would be
// written out. So the policy travels with the bundle and this is where it is
// honoured. A modified client can ignore it, and nothing here pretends
// otherwise: the policy removes the sanctioned path to a `.env` file, which is
// what stops the accidental copy, and it cannot stop somebody determined who
// can already run a process with the values in its environment.
//
// A fresh error rather than the server's 403 wrapped: the hint that error would
// collect — "ask an admin to review your access" — sends somebody to ask for
// access they already have.
//
// ── Naming the environment that refused ──
//
// A resolved pull is refused when any environment it draws values from
// disables export — a parent, or one a template reaches into — and a message
// naming only the environment pulled would send its admins to a setting that
// is already "allowed". refusedBy is what the bundle says about each one; when
// it names environments other than the one pulled, so does the message. Empty
// (an older server, or a server-mode pull) falls back to the environment
// pulled, which is then the one that refused.
func exportDisabledError(resolved scope, refusedBy []string) error {
	pulled := resolved.Project + "/" + resolved.Environment
	var others []string
	for _, name := range refusedBy {
		if name != pulled {
			others = append(others, name)
		}
	}
	if len(others) == 0 {
		return fmt.Errorf(
			"plaintext export is disabled for %s by its environment policy; an owner or admin of the "+
				"organisation can change it in the environment's settings. 'xecret run' is unaffected.",
			pulled)
	}
	return fmt.Errorf(
		"plaintext export is disabled for %s: it reads values from %s, whose environment policy "+
			"disables plaintext export; an owner or admin of the organisation can change it in that "+
			"environment's settings. 'xecret run' is unaffected.",
		pulled, strings.Join(others, ", "))
}

// noteUnappliedOverrides says, on stderr, when the person running `pull` or
// `export` has personal overrides in this environment — because neither command
// applies them, and a `.env` file that quietly holds the shared value where its
// author expected their own is a surprise discovered at the worst moment.
//
// Best effort, and only for a login: a service token has no overrides and must
// never call the endpoint, and a failure of any kind — an older server, a
// network blip — costs the user nothing but this line.
func (a *app) noteUnappliedOverrides(ctx context.Context, client *api.Client, resolved scope) {
	if a.usingServiceToken() {
		return
	}
	overrides, err := client.Overrides(ctx, resolved.Org, resolved.Project, resolved.Environment)
	if err != nil || len(overrides) == 0 {
		return
	}
	a.printer.Warnf(
		"%d personal override(s) are set for this environment and are not in this output; 'xecret run' applies them.",
		len(overrides))
}

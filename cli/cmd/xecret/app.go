package main

import (
	"context"
	"fmt"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/playxoft/xecret/cli/internal/api"
	"github.com/playxoft/xecret/cli/internal/buildinfo"
	"github.com/playxoft/xecret/cli/internal/config"
	"github.com/playxoft/xecret/cli/internal/cred"
	"github.com/playxoft/xecret/cli/internal/e2ee"
	"github.com/playxoft/xecret/cli/internal/ids"
	"github.com/playxoft/xecret/cli/internal/keyring"
	"github.com/playxoft/xecret/cli/internal/output"
)

// app carries what every command needs: where output goes and where
// credentials live. Built per command so `--json` can shape it.
type app struct {
	printer *output.Printer
	store   keyring.Store
	// tokenScope is the introspected pin of XECRET_TOKEN — which organisation,
	// project and environment the CI credential is locked to. Fetched once per
	// invocation, the first time the credential is used.
	tokenScope *api.TokenSelf
	// me is GET /api/auth/me, fetched at most once per invocation by whichever
	// helper first needs to know something only it can say (see fetchMe).
	me        *api.Me
	meErr     error
	meFetched bool
}

// fetchMe is GET /api/auth/me, made at most once per invocation however many
// helpers want an answer from it. A failure is remembered as well: the callers
// that use it for a best-effort answer should not each pay for the same
// failure again.
func (a *app) fetchMe(ctx context.Context, client *api.Client) (*api.Me, error) {
	if !a.meFetched {
		a.me, a.meErr = client.FetchMe(ctx)
		a.meFetched = true
	}
	return a.me, a.meErr
}

func newApp(jsonMode bool) *app {
	printer := output.New(jsonMode)
	return &app{
		printer: printer,
		store:   keyring.Open(printer.Warnf),
	}
}

// serviceTokenFromEnv is the CI credential, when one is set. XECRET_TOKEN
// bypasses the keyring entirely: a build container has no keychain, no
// browser, and no business writing credential files that outlive the job.
func serviceTokenFromEnv() string {
	return strings.TrimSpace(os.Getenv("XECRET_TOKEN"))
}

func (a *app) usingServiceToken() bool { return serviceTokenFromEnv() != "" }

// apiBase resolves which deployment `login` should talk to. Order: the flag,
// the environment, the compiled-in default. Everything after login uses the
// URL stored with the credential instead, so a self-hoster logs in once.
// XECRET_TOKEN has no stored credential, so it resolves the same way login
// does — set XECRET_API_URL beside it for a self-hosted deployment.
func apiBase(flagValue string) string {
	if flagValue != "" {
		return strings.TrimRight(flagValue, "/")
	}
	if env := os.Getenv("XECRET_API_URL"); env != "" {
		return strings.TrimRight(env, "/")
	}
	return buildinfo.DefaultAPIURL
}

func userAgent() string {
	return fmt.Sprintf("xecret-cli/%s (%s/%s)", buildinfo.Release(), runtime.GOOS, runtime.GOARCH)
}

// client returns an authenticated API client. XECRET_TOKEN, when set, wins
// over any stored login — CI must behave identically on a machine that
// happens to have a developer's credential in its keychain — and otherwise
// the stored login is used, or the uniform "log in first" error.
func (a *app) client() (*api.Client, *cred.Credentials, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return a.clientFor(ctx)
}

// clientFor is client() under the caller's deadline, for commands that budget
// their own probes. `doctor` needs it: the introspection below is a network
// call, and one that ran on its own private 30 s clock would silently blow the
// budget doctor advertises for each check.
func (a *app) clientFor(ctx context.Context) (*api.Client, *cred.Credentials, error) {
	if token := serviceTokenFromEnv(); token != "" {
		return a.serviceClient(ctx, token)
	}

	credentials, err := cred.Load(a.store)
	if err != nil {
		return nil, nil, err
	}
	return api.New(credentials.APIURL, credentials.Token, userAgent()), credentials, nil
}

// serviceClient builds a client around XECRET_TOKEN and introspects it once.
//
// The introspection is not optional plumbing: a service token is pinned to an
// organisation, project and environment it cannot name — the pin is stored
// server-side, and nothing in the token string says what it is.
// `/api/tokens/self` answers with exactly the credential's own scope, which
// then fills every gap a missing `.xecret.yaml` leaves: the organisation by its
// id, and the project and environment by the identifiers paths use. One extra
// request per invocation, and CI needs zero configuration beyond the token
// itself.
//
// ── The seam: this is where the key half stops ──
//
// A service token is two halves (spec §13.1). The second is the X25519 scalar
// that opens every secret in the environment, and it is transport-forbidden:
// putting it in an Authorization header would hand it to this server, to its
// access logs, to every proxy in between and to any error report along the way.
// The server refuses such a token outright rather than helpfully splitting it,
// so a client that sends the whole string is not merely careless — it does not
// work at all.
//
// So the split happens here, once, at the only point where the two halves are
// still one string: the client is built around the auth half and the returned
// credential carries the auth half, while the scalar reaches `envkeys` by being
// re-read from the environment, in-process, by the one function that needs it.
// A token this build cannot parse is passed through unchanged — it is not a
// service token of either known shape, so there is no key half to strip, and the
// server is the right place for that answer.
func (a *app) serviceClient(ctx context.Context, token string) (*api.Client, *cred.Credentials, error) {
	base := apiBase("")

	authToken := authHalfOf(token)
	client := api.New(base, authToken, userAgent())

	if a.tokenScope == nil {
		self, err := client.TokenSelf(ctx)
		if err != nil {
			return nil, nil, err
		}
		a.tokenScope = self
	}

	return client, &cred.Credentials{
		APIURL:  base,
		Token:   authToken,
		OrgID:   a.tokenScope.Organization.ID,
		OrgName: a.tokenScope.Organization.Name,
		OrgSlug: a.tokenScope.Organization.Slug,
	}, nil
}

// authHalfOf is the transmittable half of a service token, and the whole of
// anything else. See serviceClient.
func authHalfOf(token string) string {
	parsed, err := e2ee.SplitServiceToken(token)
	if err != nil {
		return token
	}
	// The scalar was copied out of the token string to be decoded; this is the
	// only copy this function made, and nothing here needs it.
	defer parsed.Zeroize()
	return parsed.AuthToken
}

// storedCredentials returns the saved login when there is one, and nil
// otherwise. For the places where a credential sharpens an answer but is not
// required to give one — which deployment `upgrade` should name, for instance.
func (a *app) storedCredentials() *cred.Credentials {
	credentials, err := cred.Load(a.store)
	if err != nil {
		return nil
	}
	return credentials
}

// deploymentOrigin is the deployment this machine talks to, and why — the
// question behind "it is pointing at the wrong server", and behind any command
// that prints a URL for the user to act on.
//
// Under XECRET_TOKEN it deliberately ignores the stored login: a service token
// resolves through apiBase(""), so a developer credential that happens to sit
// in this machine's keychain must not answer for a CI job's deployment. That
// also means the keyring is not touched at all in CI.
func (a *app) deploymentOrigin() (base, reason string) {
	if a.usingServiceToken() {
		return resolvedAPIBase(nil)
	}
	return resolvedAPIBase(a.storedCredentials())
}

// scope is the resolved (org, project, environment) triple every secret
// command operates in.
type scope struct {
	// Org is how API paths name the organisation: its id whenever this process
	// holds one, and otherwise a legacy slug, which the API accepts too.
	Org string
	// OrgID is the organisation's id when it is known without asking, which is
	// every case but a credential from before organisation ids.
	// [app.orgIdentity] completes that one, and is what every end-to-end path
	// reads the AAD's orgId from.
	OrgID string
	// OrgSlug is the legacy slug this process holds for the organisation, if
	// any. Never printed: it is consulted only to find what slug-keyed builds
	// filed offline.
	OrgSlug string

	Project     string
	Environment string
}

// resolveScope combines the credential's organisation with the project and
// environment from flags or .xecret.yaml — flags win, so a one-off
// `--environment production` does not require editing the file. Under
// XECRET_TOKEN, whatever is still unresolved falls back to the token's own
// pin, so a bare `xecret run` works in CI with no file at all. A flag naming
// anything outside the pin still goes to the server, which refuses it — the
// pin is enforced there, never merely assumed here.
//
// ── Which organisation ──
//
// Always the credential's: the one `xecret login` approved, or `xecret orgs
// use` chose since. A `.xecret.yaml` names a project *inside* that
// organisation and never moves a command to another one. The file is
// committed to a repository, and a repository belongs to whoever can push to
// it: a file that could choose the organisation would let a repository in one
// organisation point `xecret run`, `import` or `secrets set` at another,
// reading its secrets into this code or writing into it, for anybody who
// happens to be a member of both. So when the file's `organization` is not
// the selected one, the command is refused before anything is read or
// written (see checkFileOrganization), and switching is left to `xecret orgs
// use`, which a person runs on purpose. A file with no organisation, which is
// every file written before init recorded one, resolves as it always did.
//
// Under XECRET_TOKEN the token's own organisation is used whatever the file
// says. The server would refuse a path into any other, and says so; this only
// warns first.
func (a *app) resolveScope(credentials *cred.Credentials, projectFlag, envFlag string) (scope, error) {
	resolved := scope{
		Org:         credentials.OrgRef(),
		OrgID:       credentials.OrgID,
		OrgSlug:     credentials.OrgSlug,
		Project:     strings.TrimSpace(projectFlag),
		Environment: strings.TrimSpace(envFlag),
	}

	if resolved.Project != "" && resolved.Environment != "" {
		return resolved, nil
	}

	cwd, err := os.Getwd()
	if err != nil {
		return scope{}, err
	}

	path, fileConfig, findErr := config.Find(cwd)
	if findErr == nil {
		if resolved.Project == "" {
			if err := a.checkFileOrganization(credentials, fileConfig, path); err != nil {
				return scope{}, err
			}
			resolved.Project = fileConfig.Project
		}
		if resolved.Environment == "" {
			resolved.Environment = fileConfig.Environment
		}
	}

	if a.tokenScope != nil {
		if resolved.Project == "" {
			resolved.Project = a.tokenScope.Project.Slug
		}
		if resolved.Environment == "" {
			resolved.Environment = a.tokenScope.Environment.Slug
		}
	}

	if resolved.Project == "" || resolved.Environment == "" {
		if findErr != nil {
			return scope{}, findErr
		}
		return scope{}, fmt.Errorf("no project or environment resolved — pass --project/--environment or run 'xecret init'")
	}
	return resolved, nil
}

// fileOrgLookupTimeout bounds the one request checkFileOrganization may make
// to put names to a mismatch. It runs on the way to a refusal, or for a
// credential from before organisation ids, and must not keep anybody waiting.
const fileOrgLookupTimeout = 5 * time.Second

// checkFileOrganization refuses a `.xecret.yaml` whose organisation is not
// the one this credential has selected. See resolveScope for why the file
// never gets to choose.
//
// The comparison is by id, exactly, and by legacy slug without regard to case
// ([cred.Credentials.NamesOrg]). Only when that cannot settle it, because the
// credential predates organisation ids and holds a slug while the file holds
// an id, or because the two plainly differ and the refusal should name both,
// is GET /api/auth/me asked, once and briefly. A credential it identifies is
// recorded, as every command records one. If it cannot be asked, an id the
// credential cannot confirm is refused rather than trusted: being refused once
// costs a rerun when the network is back, and trusting it is the hole this
// closes.
func (a *app) checkFileOrganization(credentials *cred.Credentials, file *config.Config, path string) error {
	if file.Organization == "" || credentials.NamesOrg(file.Organization) {
		return nil
	}
	if a.usingServiceToken() {
		a.printer.Warnf(
			"%s names a different organisation from the one XECRET_TOKEN is pinned to; the token's is used.", path)
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), fileOrgLookupTimeout)
	defer cancel()
	client := api.New(credentials.APIURL, credentials.Token, userAgent())
	me, err := a.fetchMe(ctx, client)
	if err == nil {
		a.recordIdentity(credentials, me)
		if credentials.NamesOrg(file.Organization) {
			return nil
		}
	}

	var named *api.Organization
	if err == nil {
		named = findOrganization(me.Organizations, file.Organization)
	}
	return fileOrganizationRefusal(path, credentials, named)
}

// findOrganization is the membership an organisation reference names: by id,
// exactly once canonical, or by legacy slug without regard to case.
func findOrganization(organizations []api.Organization, ref string) *api.Organization {
	id, isID := ids.Canonical(ref)
	for i := range organizations {
		organization := &organizations[i]
		if isID && organization.ID == id {
			return organization
		}
		if !isID && cred.SameSlug(organization.Slug, ref) {
			return organization
		}
	}
	return nil
}

// fileOrganizationRefusal says which two organisations disagree, by name with
// the id beside it because names are not unique, and what to do about it.
// named is the file's organisation among this account's memberships, or nil
// when it is not one of them or could not be looked up.
func fileOrganizationRefusal(path string, credentials *cred.Credentials, named *api.Organization) error {
	current := "the organisation you are signed in to"
	if credentials.OrgName != "" || credentials.OrgID != "" {
		current = organisationLine(credentials.OrgName, credentials.OrgID)
	}

	if named == nil {
		return fmt.Errorf(
			"%s is for an organisation other than the one you are using, %s, and it is not one of "+
				"yours that this machine could look up. Nothing was read or written. Run 'xecret orgs' to "+
				"see the organisations you are in, and 'xecret init' to point this directory at a project in "+
				"the one you are using",
			path, current)
	}
	return fmt.Errorf(
		"%s is for the organisation %s, but you are using %s. Nothing was read or written. "+
			"If you meant to work in %s, run 'xecret orgs use %s' first",
		path, organisationLine(named.Name, named.ID), current, named.Name, named.ID)
}

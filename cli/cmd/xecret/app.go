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
// server-side as ids, and every API path speaks slugs. `/api/tokens/self`
// answers with exactly the credential's own scope, which then fills every gap
// a missing `.xecret.yaml` leaves. One extra request per invocation, and CI
// needs zero configuration beyond the token itself.
func (a *app) serviceClient(ctx context.Context, token string) (*api.Client, *cred.Credentials, error) {
	base := apiBase("")
	client := api.New(base, token, userAgent())

	if a.tokenScope == nil {
		self, err := client.TokenSelf(ctx)
		if err != nil {
			return nil, nil, err
		}
		a.tokenScope = self
	}

	return client, &cred.Credentials{
		APIURL:  base,
		Token:   token,
		OrgSlug: a.tokenScope.Organization.Slug,
	}, nil
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
	Org         string
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
func (a *app) resolveScope(credentials *cred.Credentials, projectFlag, envFlag string) (scope, error) {
	resolved := scope{
		Org:         credentials.OrgSlug,
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

	_, fileConfig, findErr := config.Find(cwd)
	if findErr == nil {
		if resolved.Project == "" {
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

package main

import (
	"fmt"
	"os"
	"runtime"
	"strings"

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
}

func newApp(jsonMode bool) *app {
	printer := output.New(jsonMode)
	return &app{
		printer: printer,
		store:   keyring.Open(printer.Warnf),
	}
}

// apiBase resolves which deployment `login` should talk to. Order: the flag,
// the environment, the compiled-in default. Everything after login uses the
// URL stored with the credential instead, so a self-hoster logs in once.
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
	return fmt.Sprintf("xecret-cli/%s (%s/%s)", buildinfo.Version, runtime.GOOS, runtime.GOARCH)
}

// client returns an authenticated API client, or the uniform "log in first"
// error.
func (a *app) client() (*api.Client, *cred.Credentials, error) {
	credentials, err := cred.Load(a.store)
	if err != nil {
		return nil, nil, err
	}
	return api.New(credentials.APIURL, credentials.Token, userAgent()), credentials, nil
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
// `--environment production` does not require editing the file.
func resolveScope(credentials *cred.Credentials, projectFlag, envFlag string) (scope, error) {
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

	_, fileConfig, err := config.Find(cwd)
	if err != nil {
		if resolved.Project == "" || resolved.Environment == "" {
			return scope{}, err
		}
		return resolved, nil
	}

	if resolved.Project == "" {
		resolved.Project = fileConfig.Project
	}
	if resolved.Environment == "" {
		resolved.Environment = fileConfig.Environment
	}
	return resolved, nil
}

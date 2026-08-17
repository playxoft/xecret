package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/playxoft/xecret/cli/internal/api"
	"github.com/playxoft/xecret/cli/internal/buildinfo"
	"github.com/playxoft/xecret/cli/internal/cache"
	"github.com/playxoft/xecret/cli/internal/config"
	"github.com/playxoft/xecret/cli/internal/cred"
	"github.com/playxoft/xecret/cli/internal/keyring"
)

// probeTimeout is the budget for one network probe. Each gets its own: sharing
// a single deadline across both meant a slow server could spend it all on the
// reachability check and leave the credential check to fail instantly with
// "context deadline exceeded" — printed as "the stored credential was refused",
// which is the one diagnosis that sends a user with a working credential off to
// re-authenticate.
const probeTimeout = 15 * time.Second

// credentialRefused reports whether err is the server *judging* the credential
// rather than failing to answer about it. Only 401 and 403 are a judgement: a
// 429, a 500 or a dropped connection say nothing about whether the token is
// still good, and telling someone to log in again over one of those is the
// mistake this whole check exists to avoid.
func credentialRefused(err error) bool {
	apiErr, ok := api.AsError(err)
	return ok && (apiErr.Status == 401 || apiErr.Status == 403)
}

// doctorCheck is one verdict. The JSON carries these rather than only the raw
// values, because the question `xecret doctor --json | jq` exists to answer is
// "did anything fail?" — and an outcome expressed solely as a missing key is
// indistinguishable from a server too old to have the endpoint.
type doctorCheck struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
}

const (
	statusOK   = "ok"
	statusWarn = "warn"
	statusFail = "fail"
	statusInfo = "info"
)

// glyph is the column the human output leads with.
func glyph(status string) string {
	switch status {
	case statusOK:
		return "✓"
	case statusWarn:
		return "!"
	case statusFail:
		return "✗"
	default:
		return ""
	}
}

// cmdDoctor answers "why is this machine not doing what I expect?" without
// anybody having to describe their setup down a support channel.
//
// Every check is read-only and none of them prints a credential: the keyring
// probe writes and deletes a value of its own rather than reading the stored
// token, the config check prints slugs, and the reachability check calls the
// one endpoint that needs no authentication. What the output does contain is
// paths, hostnames and a decision trail — enough to paste into an issue.
func cmdDoctor(args []string) error {
	flags := flag.NewFlagSet("doctor", flag.ContinueOnError)
	jsonMode := flags.Bool("json", false, "machine-readable output")
	if err := flags.Parse(args); err != nil {
		return err
	}

	a := newApp(*jsonMode)
	report := map[string]any{"cli": buildinfo.String()}

	var checks []doctorCheck
	say := func(status, name, format string, values ...any) {
		checks = append(checks, doctorCheck{
			Name:   name,
			Status: status,
			OK:     status != statusFail,
			Detail: fmt.Sprintf(format, values...),
		})
	}

	say(statusInfo, "cli", "%s", buildinfo.String())

	// ── Credentials ────────────────────────────────────────────────────────
	serviceToken := serviceTokenFromEnv() != ""
	report["serviceToken"] = serviceToken

	backend, keyringErr := probeKeyring()
	report["keyring"] = backend
	if keyringErr != nil {
		say(statusFail, "credentialStore", "credential store: unusable (%v)", keyringErr)
	} else {
		say(statusOK, "credentialStore", "credential store: %s", backend)
	}

	var credentials *cred.Credentials
	switch {
	case serviceToken:
		say(statusOK, "signedIn", "XECRET_TOKEN is set — the keychain and the offline cache are both bypassed")
	default:
		loaded, err := cred.Load(a.store)
		if errors.Is(err, cred.ErrNotLoggedIn) {
			say(statusFail, "signedIn", "not signed in — run 'xecret login'")
		} else if err != nil {
			say(statusFail, "signedIn", "stored credential unreadable: %v", err)
		} else {
			credentials = loaded
			say(statusOK, "signedIn", "signed in as %s, organisation %s", loaded.Email, loaded.OrgSlug)
			report["email"] = loaded.Email
			report["organization"] = loaded.OrgSlug
		}
	}

	// ── Which deployment, and why ──────────────────────────────────────────
	base, reason := resolvedAPIBase(credentials)
	report["apiUrl"] = base
	report["apiUrlSource"] = reason
	say(statusInfo, "apiUrl", "server: %s (%s)", base, reason)

	// ── Reachability ───────────────────────────────────────────────────────
	reachCtx, cancelReach := context.WithTimeout(context.Background(), probeTimeout)
	deployed, reachErr := api.New(base, "", userAgent()).ServerVersion(reachCtx)
	cancelReach()
	if reachErr != nil {
		say(statusFail, "serverReachable", "cannot reach the server: %v", reachErr)
	} else {
		report["serverVersion"] = deployed.Version
		say(statusOK, "serverReachable", "server reachable — %s %s (commit %s)",
			deployed.Name, deployed.Version, deployed.Commit)
	}

	// ── Does the credential still work? ────────────────────────────────────
	// Only a 401 or a 403 means the credential was judged and found wanting.
	// Everything else — a timeout, a 429, a 500 — leaves the question open, and
	// is reported as unanswered rather than as a revocation. This applies to
	// the service-token path too: the introspection request that a.clientFor
	// makes is a network call like any other, and it fails the same ways.
	if credentials != nil || serviceToken {
		credCtx, cancelCred := context.WithTimeout(context.Background(), probeTimeout)
		client, resolved, clientErr := a.clientFor(credCtx)
		switch {
		case clientErr != nil && credentialRefused(clientErr):
			say(statusFail, "credentialAccepted", "the credential was refused: %v", clientErr)
		case clientErr != nil:
			say(statusWarn, "credentialAccepted",
				"could not check the credential — the server did not answer: %v", clientErr)
		case serviceToken:
			pin := a.tokenScope
			say(statusOK, "credentialAccepted", "service token %q is live, pinned to %s/%s/%s",
				pin.Token.Name, pin.Organization.Slug, pin.Project.Slug, pin.Environment.Slug)
		default:
			switch _, meErr := client.FetchMe(credCtx); {
			case meErr == nil:
				say(statusOK, "credentialAccepted", "credential accepted by %s", resolved.APIURL)
			case credentialRefused(meErr):
				say(statusFail, "credentialAccepted",
					"the stored credential was refused: %v — run 'xecret login' again, it may have been revoked from the dashboard",
					meErr)
			default:
				say(statusWarn, "credentialAccepted",
					"could not check the credential — the server did not answer: %v", meErr)
			}
		}
		cancelCred()
	}

	// ── Where this directory points ────────────────────────────────────────
	if cwd, err := os.Getwd(); err == nil {
		path, file, findErr := config.Find(cwd)
		if findErr != nil {
			say(statusWarn, "config", "no %s above %s — pass --project/--environment, or run 'xecret init'",
				config.Filename, cwd)
		} else {
			report["configPath"] = path
			report["project"] = file.Project
			report["environment"] = file.Environment
			say(statusOK, "config", "%s → %s/%s", path, file.Project, file.Environment)
		}
	}

	// ── Offline cache ──────────────────────────────────────────────────────
	entries, cacheErr := cachedFiles()
	report["cacheDir"] = cache.Dir()
	report["cachedEnvironments"] = entries
	switch {
	case cacheErr != nil:
		say(statusWarn, "offlineCache", "offline cache: %s is unreadable (%v)", cache.Dir(), cacheErr)
	case entries == 0:
		say(statusInfo, "offlineCache", "offline cache: empty (%s)", cache.Dir())
	default:
		say(statusOK, "offlineCache", "offline cache: %d environment(s) in %s", entries, cache.Dir())
	}

	failed := 0
	for _, check := range checks {
		if !check.OK {
			failed++
		}
	}
	report["checks"] = checks
	report["ok"] = failed == 0

	if *jsonMode {
		if err := a.printer.WriteJSON(report); err != nil {
			return err
		}
	} else {
		for _, check := range checks {
			fmt.Fprintln(a.printer.Out,
				strings.TrimRight(fmt.Sprintf("%-4s %s", glyph(check.Status), check.Detail), " "))
		}
	}

	// A diagnostic that reports four failures and exits 0 is a diagnostic a
	// container start-up script cannot use: `xecret doctor || exit 1` would let
	// a missing credential through, to surface later as an unexplained auth
	// error from inside the application. Warnings do not count — an absent
	// .xecret.yaml is a fact about this directory, not a broken machine.
	if failed > 0 {
		return fmt.Errorf("%d of %d checks failed", failed, len(checks))
	}
	return nil
}

// probeKeyring finds out which store this machine actually gives us, by using
// it. Nothing else can answer the question: the system keyring may exist and
// still refuse to unlock, and the fallback engages per operation.
//
// The probe value is a fixed string under its own key, written and immediately
// deleted. It is never the credential.
func probeKeyring() (string, error) {
	fellBack := false
	store := keyring.Open(func(string, ...any) { fellBack = true })

	const probeKey = "doctor-probe"
	if err := store.Set(probeKey, "ok"); err != nil {
		return "unavailable", err
	}
	value, err := store.Get(probeKey)
	_ = store.Delete(probeKey)
	if err != nil {
		return "unavailable", err
	}
	if value != "ok" {
		return "unavailable", errors.New("the store did not return what was written")
	}

	if fellBack || os.Getenv("XECRET_KEYRING") == "file" {
		return fmt.Sprintf("0600 file at %s (no system keyring)", filepath.Join(keyring.ConfigDir(), "credentials.json")), nil
	}
	return "OS keychain", nil
}

// resolvedAPIBase repeats the resolution every command does, and says which
// step won — the question behind most "it is talking to the wrong server"
// reports.
func resolvedAPIBase(credentials *cred.Credentials) (base, reason string) {
	if env := strings.TrimRight(os.Getenv("XECRET_API_URL"), "/"); env != "" {
		return env, "from XECRET_API_URL"
	}
	if credentials != nil && credentials.APIURL != "" {
		return credentials.APIURL, "stored with the credential at login"
	}
	return buildinfo.DefaultAPIURL, "compiled-in default"
}

// cachedFiles counts the encrypted offline copies without opening any.
func cachedFiles() (int, error) {
	items, err := os.ReadDir(cache.Dir())
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	count := 0
	for _, item := range items {
		if !item.IsDir() {
			count++
		}
	}
	return count, nil
}

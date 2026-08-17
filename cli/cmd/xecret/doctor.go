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

	lines := []string{}
	say := func(status, format string, values ...any) {
		lines = append(lines, fmt.Sprintf("%-4s %s", status, fmt.Sprintf(format, values...)))
	}

	say("", "%s", buildinfo.String())

	// ── Credentials ────────────────────────────────────────────────────────
	serviceToken := serviceTokenFromEnv() != ""
	report["serviceToken"] = serviceToken

	backend, keyringErr := probeKeyring()
	report["keyring"] = backend
	if keyringErr != nil {
		say("✗", "credential store: unusable (%v)", keyringErr)
	} else {
		say("✓", "credential store: %s", backend)
	}

	var credentials *cred.Credentials
	switch {
	case serviceToken:
		say("✓", "XECRET_TOKEN is set — the keychain and the offline cache are both bypassed")
	default:
		loaded, err := cred.Load(a.store)
		if errors.Is(err, cred.ErrNotLoggedIn) {
			say("✗", "not signed in — run 'xecret login'")
		} else if err != nil {
			say("✗", "stored credential unreadable: %v", err)
		} else {
			credentials = loaded
			say("✓", "signed in as %s, organisation %s", loaded.Email, loaded.OrgSlug)
			report["email"] = loaded.Email
			report["organization"] = loaded.OrgSlug
		}
	}

	// ── Which deployment, and why ──────────────────────────────────────────
	base, reason := resolvedAPIBase(credentials)
	report["apiUrl"] = base
	report["apiUrlSource"] = reason
	say("", "server: %s (%s)", base, reason)

	// ── Reachability ───────────────────────────────────────────────────────
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	deployed, err := api.New(base, "", userAgent()).ServerVersion(ctx)
	if err != nil {
		say("✗", "cannot reach the server: %v", err)
	} else {
		report["serverVersion"] = deployed.Version
		say("✓", "server reachable — %s %s (commit %s)", deployed.Name, deployed.Version, deployed.Commit)
	}

	// ── Does the credential still work? ────────────────────────────────────
	if credentials != nil || serviceToken {
		client, resolved, clientErr := a.client()
		if clientErr != nil {
			say("✗", "credential unusable: %v", clientErr)
		} else if serviceToken {
			pin := a.tokenScope
			say("✓", "service token %q is live, pinned to %s/%s/%s",
				pin.Token.Name, pin.Organization.Slug, pin.Project.Slug, pin.Environment.Slug)
		} else if _, meErr := client.FetchMe(ctx); meErr != nil {
			say("✗", "the stored credential was refused: %v", meErr)
			say("", "     run 'xecret login' again — it may have been revoked from the dashboard")
		} else {
			say("✓", "credential accepted by %s", resolved.APIURL)
		}
	}

	// ── Where this directory points ────────────────────────────────────────
	cwd, err := os.Getwd()
	if err == nil {
		path, file, findErr := config.Find(cwd)
		if findErr != nil {
			say("!", "no %s above %s — pass --project/--environment, or run 'xecret init'",
				config.Filename, cwd)
		} else {
			report["configPath"] = path
			report["project"] = file.Project
			report["environment"] = file.Environment
			say("✓", "%s → %s/%s", path, file.Project, file.Environment)
		}
	}

	// ── Offline cache ──────────────────────────────────────────────────────
	entries, cacheErr := cachedFiles()
	report["cacheDir"] = cache.Dir()
	report["cachedEnvironments"] = entries
	switch {
	case cacheErr != nil:
		say("!", "offline cache: %s is unreadable (%v)", cache.Dir(), cacheErr)
	case entries == 0:
		say("", "offline cache: empty (%s)", cache.Dir())
	default:
		say("✓", "offline cache: %d environment(s) in %s", entries, cache.Dir())
	}

	if *jsonMode {
		return a.printer.WriteJSON(report)
	}
	for _, line := range lines {
		fmt.Fprintln(a.printer.Out, strings.TrimRight(line, " "))
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

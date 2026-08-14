package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"time"

	"github.com/playxoft/xecret/cli/internal/api"
	"github.com/playxoft/xecret/cli/internal/cache"
	"github.com/playxoft/xecret/cli/internal/run"
)

// cmdRun is the golden path: fetch, inject, exec, forward, propagate.
//
// Availability logic, stated once: the API is authoritative; the encrypted
// cache answers only when the API *cannot* — network failure or a 5xx — and
// never when it *will not*. A 401/403/404 is a decision, and decisions
// (revocation above all) are not softened by a local file.
func cmdRun(args []string) error {
	flags := flag.NewFlagSet("run", flag.ContinueOnError)
	offline := flags.Bool("offline", false, "use the encrypted offline cache without calling the API")
	noCache := flags.Bool("no-cache", false, "neither read nor refresh the offline cache")
	projectFlag, envFlag := scopedFlags(flags)
	if err := flags.Parse(splitBeforeDashDash(args)); err != nil {
		return err
	}

	child := childArgv(args, flags.Args())
	if len(child) == 0 {
		return errors.New("no command given — usage: xecret run -- <command> [args]")
	}
	if *offline && *noCache {
		return errors.New("--offline and --no-cache contradict each other")
	}

	a := newApp(false)
	client, credentials, err := a.client()
	if err != nil {
		return err
	}
	resolved, err := resolveScope(credentials, *projectFlag, *envFlag)
	if err != nil {
		return err
	}

	scopeKey := cache.Scope{
		Host:        credentials.APIURL,
		Org:         resolved.Org,
		Project:     resolved.Project,
		Environment: resolved.Environment,
	}

	secrets, err := fetchSecrets(a, client, resolved, scopeKey, *offline, *noCache)
	if err != nil {
		return err
	}

	code, err := run.Exec(context.Background(), child, secrets)
	if err != nil {
		return err
	}
	if code != 0 {
		return exitCodeError{code: code}
	}
	return nil
}

func fetchSecrets(
	a *app,
	client *api.Client,
	resolved scope,
	scopeKey cache.Scope,
	offline, noCache bool,
) (map[string]string, error) {
	if offline {
		return readCache(a, scopeKey, errors.New("--offline was passed"))
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	document, err := client.Pull(ctx, resolved.Org, resolved.Project, resolved.Environment, "json")
	if err != nil {
		// Only unavailability falls back; see the header comment.
		if !noCache && api.IsNetworkError(err) {
			a.printer.Warnf("could not reach the API: %v", err)
			return readCache(a, scopeKey, err)
		}
		return nil, err
	}

	// The JSON pull document is a flat, sorted name→value object.
	var secrets map[string]string
	if err := json.Unmarshal(document, &secrets); err != nil {
		return nil, errors.New("the server's pull response could not be read")
	}

	if !noCache {
		if writeErr := cache.Write(a.store, scopeKey, secrets, time.Now()); writeErr != nil {
			// Cache maintenance must never fail the run it exists to protect.
			a.printer.Warnf("could not refresh the offline cache: %v", writeErr)
		}
	}
	return secrets, nil
}

// readCache serves the offline copy, loudly. The warning carries the age
// because a week-old DATABASE_URL that fails to connect should be a
// ten-second diagnosis, not an afternoon.
func readCache(a *app, scopeKey cache.Scope, cause error) (map[string]string, error) {
	entry, err := cache.Read(a.store, scopeKey)
	if err != nil {
		if errors.Is(err, cache.ErrMiss) {
			return nil, fmt.Errorf(
				"the API is unreachable (%v) and no offline copy exists yet — a successful 'xecret run' creates one",
				cause,
			)
		}
		return nil, err
	}

	a.printer.Warnf("using the encrypted offline cache from %s ago (%d secrets).",
		entry.Age(time.Now()), len(entry.Secrets))
	a.printer.Warnf("values may be stale; they refresh on the next successful run.")
	return entry.Secrets, nil
}

// splitBeforeDashDash returns the arguments before a literal "--", which are
// the CLI's own flags. Everything after belongs to the child verbatim —
// including flags that would otherwise be parsed as ours.
func splitBeforeDashDash(args []string) []string {
	for i, arg := range args {
		if arg == "--" {
			return args[:i]
		}
	}
	return args
}

// childArgv recovers the child's argv. With a "--" the answer is exact;
// without one, flag parsing already stopped at the first non-flag, so the
// remainder is the command.
func childArgv(args, remainder []string) []string {
	for i, arg := range args {
		if arg == "--" {
			return args[i+1:]
		}
	}
	return remainder
}

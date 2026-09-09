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
	"github.com/playxoft/xecret/cli/internal/cred"
	"github.com/playxoft/xecret/cli/internal/envkeys"
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
	if a.usingServiceToken() {
		// The offline cache exists so a developer's laptop survives an outage.
		// A CI credential must never leave one behind: a runner is ephemeral,
		// a shared runner is worse, and a cache that outlives a token's
		// revocation would be a revocation bypass in a directory nobody audits.
		if *offline {
			return errors.New("--offline needs a cached login session, and XECRET_TOKEN never writes one")
		}
		*noCache = true
	}
	client, credentials, err := a.client()
	if err != nil {
		return err
	}
	resolved, err := a.resolveScope(credentials, *projectFlag, *envFlag)
	if err != nil {
		return err
	}

	scopeKey := cache.Scope{
		Host:        credentials.APIURL,
		Org:         resolved.Org,
		Project:     resolved.Project,
		Environment: resolved.Environment,
	}

	secrets, err := fetchSecrets(a, client, credentials, resolved, scopeKey, *offline, *noCache)
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

// fetchSecrets produces the environment `run` injects, from whichever of the
// three sources can answer: the API, the API's e2ee bundle opened locally, or
// the offline cache.
//
// The offline scope is not known until the mode is: an end-to-end encrypted
// environment caches its ciphertext under a different name from a server-mode
// one, so that the two can never be read as each other. `--offline` therefore
// tries both, most-secure first.
func fetchSecrets(
	a *app,
	client *api.Client,
	credentials *cred.Credentials,
	resolved scope,
	scopeKey cache.Scope,
	offline, noCache bool,
) (map[string]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	if offline {
		return readAnyCache(ctx, a, client, credentials, scopeKey, errors.New("--offline was passed"))
	}

	pulled, err := client.Pull(ctx, resolved.Org, resolved.Project, resolved.Environment, "json")
	if err != nil {
		// Only unavailability falls back; see the header comment.
		if !noCache && api.IsNetworkError(err) {
			a.printer.Warnf("could not reach the API: %v", err)
			return readAnyCache(ctx, a, client, credentials, scopeKey, err)
		}
		return nil, err
	}

	if pulled.Bundle != nil {
		return openBundle(ctx, a, client, credentials, scopeKey, pulled.Bundle, noCache)
	}

	// The JSON pull document is a flat, sorted name→value object.
	var secrets map[string]string
	if err := json.Unmarshal(pulled.Document, &secrets); err != nil {
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

// openBundle decrypts an e2ee pull and, unless asked not to, caches the
// ciphertext it came from.
//
// The bundle is cached *before* it is decrypted, and re-serialised rather than
// summarised, because what makes the offline copy useful is that it is the same
// bytes the server sent — including the sealed grant, without which the
// ciphertext is unopenable next time too.
func openBundle(
	ctx context.Context,
	a *app,
	client *api.Client,
	credentials *cred.Credentials,
	scopeKey cache.Scope,
	bundle *api.EnvironmentBundle,
	noCache bool,
) (map[string]string, error) {
	principal, err := a.principal(ctx, client, credentials)
	if err != nil {
		return nil, err
	}
	defer principal.Close()

	secrets, err := envkeys.DecryptBundle(bundle, principal)
	if err != nil {
		return nil, err
	}

	if !noCache {
		scopeKey.Encrypted = true
		if encoded, marshalErr := json.Marshal(bundle); marshalErr == nil {
			if writeErr := cache.WriteBundle(a.store, scopeKey, encoded, time.Now()); writeErr != nil {
				a.printer.Warnf("could not refresh the offline cache: %v", writeErr)
			}
		}
	}
	return secrets, nil
}

// readAnyCache serves whichever offline copy exists.
//
// The encrypted one is tried first because an environment that has ever been
// end-to-end encrypted should not silently fall back to a stale plaintext copy
// from before the migration — that copy is exactly the thing the migration
// removed.
func readAnyCache(
	ctx context.Context,
	a *app,
	client *api.Client,
	credentials *cred.Credentials,
	scopeKey cache.Scope,
	cause error,
) (map[string]string, error) {
	encryptedScope := scopeKey
	encryptedScope.Encrypted = true

	entry, err := cache.Read(a.store, encryptedScope)
	if err == nil {
		return openCachedBundle(ctx, a, client, credentials, entry)
	}
	if !errors.Is(err, cache.ErrMiss) {
		return nil, err
	}
	return readCache(a, scopeKey, cause)
}

// openCachedBundle decrypts a cached bundle, which needs the same key material a
// live one does — the cache holds none of it.
func openCachedBundle(
	ctx context.Context,
	a *app,
	client *api.Client,
	credentials *cred.Credentials,
	entry *cache.Entry,
) (map[string]string, error) {
	var bundle api.EnvironmentBundle
	if err := json.Unmarshal(entry.Bundle, &bundle); err != nil {
		return nil, errors.New("the offline copy is corrupt — run 'xecret cache clear'")
	}

	principal, err := a.principal(ctx, client, credentials)
	if err != nil {
		return nil, err
	}
	defer principal.Close()

	secrets, err := envkeys.DecryptBundle(&bundle, principal)
	if err != nil {
		return nil, err
	}

	a.printer.Warnf(
		"using the offline copy from %s (%d secrets), decrypted locally.",
		entry.FetchedAt.Local().Format("2006-01-02 15:04"), len(secrets),
	)
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

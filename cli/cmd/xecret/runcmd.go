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
	maxCacheAge := flags.String("max-cache-age", "",
		"how old an offline copy may be before it is refused (default 7d; 0 for no bound)")
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

	policy := cachePolicy{offline: *offline, noCache: *noCache}
	age, overridden, err := cache.ResolveMaxAge(*maxCacheAge)
	if err != nil {
		return err
	}
	policy.maxAge, policy.ageOverridden = age, overridden

	a := newApp(false)
	if a.usingServiceToken() {
		// The offline cache exists so a developer's laptop survives an outage.
		// A CI credential must never leave one behind: a runner is ephemeral,
		// a shared runner is worse, and a cache that outlives a token's
		// revocation would be a revocation bypass in a directory nobody audits.
		if policy.offline {
			return errors.New("--offline needs a cached login session, and XECRET_TOKEN never writes one")
		}
		policy.noCache = true
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

	secrets, err := fetchSecrets(a, client, credentials, resolved, scopeKey, policy)
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

// cachePolicy is everything `run`'s flags say about the offline copy, in one
// value — because they are read together at every point that consults it, and a
// run of same-typed positional parameters at a call site is how one of them ends
// up in the wrong slot.
type cachePolicy struct {
	// offline serves from the cache without calling the API at all.
	offline bool
	// noCache neither reads nor refreshes it.
	noCache bool
	// maxAge is how old a copy may be before it is refused. See
	// cache.ResolveMaxAge for what the bound is for.
	maxAge time.Duration
	// ageOverridden records that the bound came from a flag or the environment,
	// which is what makes the warning worth printing.
	ageOverridden bool
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
	policy cachePolicy,
) (map[string]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	if policy.offline {
		return readAnyCache(a, credentials, scopeKey, policy, errors.New("--offline was passed"))
	}

	pulled, err := client.Pull(ctx, resolved.Org, resolved.Project, resolved.Environment, "json")
	if err != nil {
		// Only unavailability falls back; see the header comment.
		if !policy.noCache && api.IsNetworkError(err) {
			a.printer.Warnf("could not reach the API: %v", err)
			return readAnyCache(a, credentials, scopeKey, policy, err)
		}
		return nil, err
	}

	if pulled.Bundle != nil {
		if err := a.checkMode(credentials, resolved, "e2ee"); err != nil {
			return nil, err
		}
		return openBundle(ctx, a, client, credentials, scopeKey, pulled, policy)
	}

	// A plaintext document means the server says this environment is
	// server-mode, and `run` is about to inject what it contains into a child
	// process with nothing on screen. That is correct for an environment which
	// really is in that mode; for one this machine has read as end-to-end
	// encrypted it is a downgrade, and it is refused here rather than obeyed —
	// see `cache/mode.go`.
	if err := a.checkMode(credentials, resolved, "server"); err != nil {
		return nil, err
	}

	// The JSON pull document is a flat, sorted name→value object.
	var secrets map[string]string
	if err := json.Unmarshal(pulled.Document, &secrets); err != nil {
		return nil, errors.New("the server's pull response could not be read")
	}

	if !policy.noCache {
		if writeErr := cache.Write(a.store, scopeKey, secrets, time.Now()); writeErr != nil {
			// Cache maintenance must never fail the run it exists to protect.
			a.printer.Warnf("could not refresh the offline cache: %v", writeErr)
		}
	}
	return secrets, nil
}

// openBundle caches an e2ee pull and then decrypts it.
//
// **That order, and those bytes.** The copy written is `pulled.Raw` — the
// response body as it arrived — rather than a re-marshalling of the parsed
// struct, and it is written before anything tries to open it. Both halves matter
// for the same case: an environment in the middle of a rotation, where some row
// still names the retired key and the decrypt therefore fails. Caching after the
// decrypt would leave that environment's offline copy frozen at whatever it was
// before the rotation started, for exactly as long as the rotation takes to
// finish — which is the window in which somebody is most likely to lose their
// network and need it. Re-marshalling would silently drop any field this build
// does not know about, and there is no key anywhere that could put it back.
//
// A cache write that fails is a warning, never a failure: the run this exists to
// protect is the one happening now.
func openBundle(
	ctx context.Context,
	a *app,
	client *api.Client,
	credentials *cred.Credentials,
	scopeKey cache.Scope,
	pulled *api.Pulled,
	policy cachePolicy,
) (map[string]string, error) {
	if !policy.noCache && len(pulled.Raw) > 0 {
		encryptedScope := scopeKey
		encryptedScope.Encrypted = true
		if writeErr := cache.WriteBundle(a.store, encryptedScope, pulled.Raw, time.Now()); writeErr != nil {
			a.printer.Warnf("could not refresh the offline cache: %v", writeErr)
		}

		// The pre-migration plaintext copy, if this machine still has one. A
		// successful e2ee read is the proof that it is obsolete, and leaving it
		// on disk leaves values from before the migration where an older binary
		// — or anybody who can read the directory — will still find them.
		if forgetErr := cache.Forget(scopeKey); forgetErr != nil {
			a.printer.Warnf("could not remove the pre-migration offline copy: %v", forgetErr)
		}
	}

	principal, err := a.principal(ctx, client, credentials)
	if err != nil {
		return nil, err
	}
	defer principal.Close()

	return envkeys.DecryptBundle(pulled.Bundle, principal)
}

// readAnyCache serves whichever offline copy exists.
//
// The encrypted one is tried first, and once the mode pin says `e2ee` it is the
// *only* one: an environment that has been migrated has no legitimate plaintext
// copy, so a plaintext file for it is a leftover from before, and serving it is
// the disclosure the migration removed the server's ability to commit — see
// `cache/mode.go`. The refusal names the remedy rather than falling through
// quietly, because falling through quietly is what this used to do.
//
// Nothing here touches the network. That is not incidental: this is the path
// `--offline` takes and the path a network failure lands on, so a request made
// from inside it would be a request made in exactly the two situations where
// there is nobody to answer it.
func readAnyCache(
	a *app,
	credentials *cred.Credentials,
	scopeKey cache.Scope,
	policy cachePolicy,
	cause error,
) (map[string]string, error) {
	encryptedScope := scopeKey
	encryptedScope.Encrypted = true

	entry, err := cache.Read(a.store, encryptedScope)
	if err == nil {
		if ageErr := a.checkCacheAge(entry, policy); ageErr != nil {
			return nil, ageErr
		}
		return openCachedBundle(a, credentials, entry)
	}
	if !errors.Is(err, cache.ErrMiss) {
		return nil, err
	}

	if cache.PinnedMode(scopeKey) == "e2ee" {
		return nil, fmt.Errorf(
			"%w (%v).\n"+
				"  This machine has read %s/%s as end-to-end encrypted, so the plaintext copy beside it\n"+
				"  predates that migration and will not be served. Run 'xecret run' once with the API\n"+
				"  reachable to write an encrypted one",
			cache.ErrPlaintextRefused, cause, scopeKey.Project, scopeKey.Environment,
		)
	}
	return a.readCache(scopeKey, policy, cause)
}

// checkCacheAge applies the bound, and says what raising it costs.
//
// The warning is printed on the way past rather than at the point the bound was
// chosen, because the person who set `XECRET_CACHE_MAX_AGE` in a CI image and
// the person reading this run's output are usually not the same person, and only
// one of them is present.
func (a *app) checkCacheAge(entry *cache.Entry, policy cachePolicy) error {
	if !entry.TooOld(policy.maxAge, time.Now()) {
		if policy.ageOverridden && entry.TooOld(cache.DefaultMaxAge, time.Now()) {
			a.printer.Warnf(
				"serving an offline copy %s old, past the %s default, because the bound was raised.",
				entry.Age(time.Now()), cache.DefaultMaxAge)
			a.printer.Warnf(
				"a key rotation revokes access going forward, and an old cached bundle carries the grant " +
					"it was rotated away from — so every day of this is a day that revocation is deferred.")
		}
		return nil
	}

	return fmt.Errorf(
		"%w: this copy is %s old and the bound is %s.\n"+
			"  The bound exists because a key rotation only takes access away from somebody who reaches\n"+
			"  the API — a cached bundle carries the grant the rotation replaced, and serving it defers\n"+
			"  the revocation for as long as the file lasts.\n"+
			"  Reach the deployment once to refresh it, or raise the bound with --max-cache-age",
		cache.ErrTooOld, entry.Age(time.Now()), policy.maxAge,
	)
}

// openCachedBundle decrypts a cached bundle, which needs the same key material a
// live one does — the cache holds none of it, and none of it is fetched here.
func openCachedBundle(
	a *app,
	credentials *cred.Credentials,
	entry *cache.Entry,
) (map[string]string, error) {
	var bundle api.EnvironmentBundle
	if err := json.Unmarshal(entry.Bundle, &bundle); err != nil {
		return nil, errors.New("the offline copy is corrupt — run 'xecret cache clear'")
	}

	principal, err := a.offlinePrincipal(credentials)
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
func (a *app) readCache(scopeKey cache.Scope, policy cachePolicy, cause error) (map[string]string, error) {
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
	if ageErr := a.checkCacheAge(entry, policy); ageErr != nil {
		return nil, ageErr
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

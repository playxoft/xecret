package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"golang.org/x/term"

	"github.com/playxoft/xecret/cli/internal/api"
	"github.com/playxoft/xecret/cli/internal/auth"
	"github.com/playxoft/xecret/cli/internal/cache"
	"github.com/playxoft/xecret/cli/internal/cred"
	"github.com/playxoft/xecret/cli/internal/e2ee"
	"github.com/playxoft/xecret/cli/internal/envkeys"
)

// loginTimeout bounds how long the CLI waits for the browser. Long enough to
// find a phone for 2FA; short enough that an abandoned attempt dies.
const loginTimeout = 5 * time.Minute

// cmdLogin: the OAuth-style loopback + PKCE flow against xecret's own server
// — never Firebase directly. The browser does the identity work; this
// process only ever holds the verifier and, at the end, the token.
func cmdLogin(args []string) error {
	flags := flag.NewFlagSet("login", flag.ContinueOnError)
	apiURL := flags.String("api-url", "", "xecret deployment to log in to (default "+apiBase("")+")")
	deviceName := flags.String("name", "", "device name shown on the consent screen and in the dashboard (default: hostname)")
	passphrase := flags.Bool("passphrase", false,
		"skip the browser: unlock this machine's vault key from your master passphrase")
	if err := parseFlagsOnly(flags, args); err != nil {
		return err
	}

	a := newApp(false)

	if *passphrase {
		return a.unlockWithPassphrase()
	}
	if a.usingServiceToken() {
		// Logging in would succeed and then be ignored: client() prefers the
		// environment credential. Saying so now beats a support ticket later.
		a.printer.Warnf("XECRET_TOKEN is set; every command will keep using it until it is unset.")
	}
	base := apiBase(*apiURL)

	device := *deviceName
	if device == "" {
		hostname, err := os.Hostname()
		if err != nil || hostname == "" {
			device = "unnamed device"
		} else {
			device = hostname
		}
	}

	if existing, err := cred.Load(a.store); err == nil {
		a.printer.Infof("Currently signed in as %s — a successful login will replace that credential.", existing.Email)
	}

	verifier, err := auth.GenerateVerifier()
	if err != nil {
		return err
	}
	state, err := auth.GenerateState()
	if err != nil {
		return err
	}

	// The hand-off keypair (spec 13.2). A CLI token acts as its user, and that
	// user's environment grants are sealed to a public key whose private half is
	// wrapped under the User Key — so a login that ended here would authenticate
	// perfectly and decrypt nothing. The consent screen seals the User Key to
	// this public half; the private half never leaves this process and is wiped
	// on the way out, whichever way the login goes.
	handoff, err := e2ee.GenerateHandoffKey()
	if err != nil {
		return err
	}
	defer handoff.Close()

	listener, err := auth.Listen(state)
	if err != nil {
		return err
	}
	defer listener.Close()

	challenge := auth.Challenge(verifier)
	authorizeURL := auth.AuthorizeURL(
		base, challenge, device, state, listener.Port(), handoff.PublicKeyB64Url,
	)

	a.printer.Infof("Opening your browser to approve this device…")
	a.printer.Infof("If it does not open, visit:\n\n  %s\n", authorizeURL)
	_ = auth.OpenBrowser(authorizeURL)

	ctx, cancel := context.WithTimeout(context.Background(), loginTimeout)
	defer cancel()

	callback, err := listener.Wait(ctx)
	if err != nil {
		return err
	}

	client := api.New(base, "", userAgent())
	result, err := client.ExchangeCode(ctx, callback.Code, verifier)
	if err != nil {
		if apiErr, ok := api.AsError(err); ok && apiErr.Code == "unauthenticated" {
			return errors.New("the login could not be completed — the approval may have expired. Run 'xecret login' again")
		}
		return err
	}

	// The token is live from here. Everything below can fail without costing the
	// login — it costs the ability to decrypt, which is reported and recoverable
	// by running the command again, whereas discarding a minted token is not.
	if err := cred.Save(a.store, cred.Credentials{
		APIURL:  base,
		Token:   result.Token,
		OrgSlug: result.Organization.Slug,
		Email:   result.User.Email,
	}); err != nil {
		return err
	}

	a.printer.Successf(
		"Signed in as %s (organisation %s)",
		a.printer.Bold(result.User.Email),
		result.Organization.Slug,
	)

	if err := a.acceptHandoff(ctx, base, result.Token, challenge, callback.Handoff, handoff); err != nil {
		a.printer.Warnf("%v", err)
		a.printer.Warnf(
			"end-to-end encrypted environments will not open on this machine until that succeeds.",
		)
	}

	a.printer.Infof("This device appears as %q in the dashboard and can be revoked there.", device)
	return nil
}

// acceptHandoff opens the sealed User Key and records it, with the ids that make
// it usable.
//
// Failure is a warning rather than an error, and the distinction is the point: a
// login without a hand-off is a working login for every server-mode environment
// and for every command that does not decrypt. Turning it into a failure would
// leave the user with a minted, saved token and a message saying the login did
// not work.
func (a *app) acceptHandoff(
	ctx context.Context,
	base, token, challenge, blob string,
	key *e2ee.HandoffKey,
) error {
	// The stored key belongs to whoever just signed in. Removing the previous one
	// first means a failure below leaves no key at all rather than the last
	// account's — which would decrypt nothing and explain nothing.
	if err := envkeys.ForgetUserKey(a.store); err != nil {
		return err
	}

	if blob == "" {
		return errors.New(
			"the consent screen did not hand over a vault key — it may be an older deployment",
		)
	}

	userKey, err := key.Open(blob, challenge)
	if err != nil {
		return fmt.Errorf("the vault key handed over by the browser could not be opened: %w", err)
	}
	defer e2ee.ZeroizeKey(userKey)

	// The ids are fetched rather than assumed: orgId binds every secret's AAD and
	// userId binds the private-key wrap, and a slug is neither of them.
	client := api.New(base, token, userAgent())
	me, err := client.FetchMe(ctx)
	if err != nil {
		return fmt.Errorf("reading this account's identity: %w", err)
	}

	credentials, err := cred.Load(a.store)
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
	if err := cred.Save(a.store, *credentials); err != nil {
		return err
	}

	if err := envkeys.StoreUserKey(a.store, userKey); err != nil {
		return err
	}

	a.printer.Infof("Vault key stored — end-to-end encrypted environments will open on this machine.")
	return nil
}

// cmdLogout revokes server-side first, then destroys everything local. The
// order matters: a logout that only deleted local state would leave a live
// credential nobody can see.
func cmdLogout(args []string) error {
	flags := flag.NewFlagSet("logout", flag.ContinueOnError)
	if err := parseFlagsOnly(flags, args); err != nil {
		return err
	}

	a := newApp(false)
	if a.usingServiceToken() {
		// `logout` revokes the device credential and wipes the cache. A CI
		// token is neither: it was minted in the dashboard and is revoked
		// there. Guessing which of the two credentials the user meant would
		// get one of them wrong.
		return errors.New("XECRET_TOKEN is set — unset it first; service tokens are revoked from the dashboard")
	}

	credentials, err := cred.Load(a.store)
	if errors.Is(err, cred.ErrNotLoggedIn) {
		// Still wipe the cache: files may survive a lost credential.
		if err := cache.Clear(a.store); err != nil {
			return err
		}
		if err := envkeys.ForgetUserKey(a.store); err != nil {
			return err
		}
		a.printer.Infof("Not signed in; nothing to revoke.")
		return nil
	}
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	client := api.New(credentials.APIURL, credentials.Token, userAgent())
	if revokeErr := client.RevokeSelf(ctx); revokeErr != nil {
		// The local wipe proceeds regardless — but the user must know the
		// server-side credential may still be alive.
		a.printer.Warnf("could not revoke the credential on the server: %v", revokeErr)
		a.printer.Warnf("revoke this device from the dashboard to be safe.")
	}

	if err := cred.Clear(a.store); err != nil {
		return err
	}
	if err := cache.Clear(a.store); err != nil {
		return err
	}
	// The vault key is the thing that decrypts. Leaving it behind after a logout
	// would make the cache wipe the only erasure that happened, and the next
	// person at this machine would still hold the User Key of the last one.
	if err := envkeys.ForgetUserKey(a.store); err != nil {
		return err
	}

	a.printer.Successf("Signed out %s — credential revoked, vault key and offline cache wiped.", credentials.Email)
	return nil
}

// cmdWhoami answers "which account is this machine using?" from the server,
// so a revoked token reads as signed out rather than as its stale identity.
func cmdWhoami(args []string) error {
	flags := flag.NewFlagSet("whoami", flag.ContinueOnError)
	jsonMode := flags.Bool("json", false, "machine-readable output")
	if err := parseFlagsOnly(flags, args); err != nil {
		return err
	}

	a := newApp(*jsonMode)
	client, credentials, err := a.client()
	if err != nil {
		return err
	}

	if a.usingServiceToken() {
		// A service token is nobody; /api/auth/me would refuse it. Its
		// introspected pin is the whole of its identity, so that is the answer.
		pin := a.tokenScope
		if a.printer.JSON {
			return a.printer.WriteJSON(map[string]any{
				"credential":   "serviceToken",
				"token":        pin.Token.Name,
				"accessLevel":  pin.Token.AccessLevel,
				"organization": pin.Organization.Slug,
				"project":      pin.Project.Slug,
				"environment":  pin.Environment.Slug,
				"apiUrl":       credentials.APIURL,
			})
		}
		fmt.Fprintf(a.printer.Out, "Credential     service token %q (%s)\n", pin.Token.Name, pin.Token.AccessLevel)
		fmt.Fprintf(a.printer.Out, "Organisation   %s\n", pin.Organization.Slug)
		fmt.Fprintf(a.printer.Out, "Project        %s\n", pin.Project.Slug)
		fmt.Fprintf(a.printer.Out, "Environment    %s\n", pin.Environment.Slug)
		fmt.Fprintf(a.printer.Out, "Server         %s\n", credentials.APIURL)
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	me, err := client.FetchMe(ctx)
	if err != nil {
		return err
	}

	device := ""
	if me.Credential.Name != nil {
		device = *me.Credential.Name
	}

	if a.printer.JSON {
		return a.printer.WriteJSON(map[string]any{
			"email":        me.User.Email,
			"organization": credentials.OrgSlug,
			"device":       device,
			"apiUrl":       credentials.APIURL,
		})
	}

	fmt.Fprintf(a.printer.Out, "Signed in as   %s\n", me.User.Email)
	fmt.Fprintf(a.printer.Out, "Organisation   %s\n", credentials.OrgSlug)
	if device != "" {
		fmt.Fprintf(a.printer.Out, "This device    %s\n", device)
	}
	fmt.Fprintf(a.printer.Out, "Server         %s\n", credentials.APIURL)
	return nil
}

// unlockWithPassphrase is the headless half of `xecret login`.
//
// ── What it is for ──
// A machine with no browser cannot complete the consent flow, and a machine that
// completed it before a vault reset holds a key that no longer opens anything.
// Both need the same thing: the User Key, derived here rather than handed over.
//
// ── What it is not ──
// It is not a way to sign in. It needs an existing credential, because the vault
// material it reads is served to that credential and to nothing else. What it
// replaces is the *hand-off*, not the login.
//
// ── Nothing is sent ──
// The passphrase becomes a Stretched Key here, the Stretched Key becomes a wrap
// key here, and the wrap opens here. This makes exactly one request — a GET for
// the wraps, which are useless without the passphrase — and posts no verifier:
// a CLI token is not subject to the server's lock gate, so there is nothing a
// verifier would unlock and no reason to hand one over. The prohibition in the
// specification is absolute, and this path keeps it trivially.
func (a *app) unlockWithPassphrase() error {
	if a.usingServiceToken() {
		return errors.New(
			"XECRET_TOKEN is a service token, which has no vault — its key travels in the token itself",
		)
	}

	credentials, err := cred.Load(a.store)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	client := api.New(credentials.APIURL, credentials.Token, userAgent())

	vault, err := client.Vault(ctx)
	if err != nil {
		return err
	}
	if vault.Material == nil {
		return errors.New("this account has no vault; set one up in the dashboard first")
	}

	// Fetched before the prompt, so a machine that cannot reach the server says
	// so before asking somebody to type their master passphrase into it.
	if err := a.backfillIdentity(ctx, client, credentials); err != nil {
		return err
	}

	entered, err := readPassphrase(a)
	if err != nil {
		return err
	}

	salt, err := e2ee.DecodeSalt(vault.Material.KdfSalt)
	if err != nil {
		return err
	}

	// Argon2id at the server's stated parameters — validated first, because a
	// client that runs a memory-hard KDF with unvalidated server-supplied costs
	// can be made to allocate arbitrary memory by a hostile one.
	a.printer.Infof("Deriving your key…")
	stretched, err := e2ee.DeriveStretchedKey(entered, salt, vault.Material.KdfParams)
	if err != nil {
		return err
	}
	defer e2ee.ZeroizeKey(stretched)

	wrapKey, err := e2ee.DerivePassphraseWrapKey(stretched)
	if err != nil {
		return err
	}
	defer e2ee.ZeroizeKey(wrapKey)

	userKey, err := e2ee.UnwrapUserKey(wrapKey, vault.Material.PassphraseWrap, e2ee.WrapContext{
		UserID: credentials.UserID,
		Kind:   e2ee.WrapPassphrase,
	})
	if err != nil {
		// A wrong passphrase, a wrap row swapped with another account's, and a
		// tampered blob are one outcome here, and should be: the honest message
		// is that the vault did not open.
		return errors.New("that passphrase did not open your vault")
	}
	defer e2ee.ZeroizeKey(userKey)

	// Proof rather than assumption. Unwrapping the private key uses a different
	// AAD under the same User Key, so a success here means the key that was
	// stored is the key that opens grants — not merely one that satisfied the
	// first GCM tag it met.
	privateKey, err := e2ee.UnwrapPrivateKey(
		userKey, vault.Material.EncPrivateKeyEnc, credentials.UserID, e2ee.PurposeEncryption)
	if err != nil {
		return errors.New("your vault opened but its private key did not; the record may be damaged")
	}
	e2ee.ZeroizeKey(privateKey)

	if err := envkeys.StoreUserKey(a.store, userKey); err != nil {
		return err
	}

	a.printer.Successf("Vault key stored for %s.", credentials.Email)
	a.printer.Infof("End-to-end encrypted environments will now open on this machine.")
	return nil
}

// readPassphrase takes the master passphrase without echoing it, and without
// ever accepting it from a flag.
//
// A flag would put it in the shell history, in the process table, and in every
// CI log that prints its own command line. A pipe is accepted because a headless
// box may have no terminal at all, and refusing one would leave that machine
// with no way in — but it is the caller's job to feed that pipe from something
// better than a file.
func readPassphrase(a *app) (string, error) {
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		data, err := io.ReadAll(os.Stdin)
		if err != nil {
			return "", errors.New("could not read the passphrase from stdin")
		}
		entered := strings.TrimSuffix(strings.TrimSuffix(string(data), "\n"), "\r")
		if entered == "" {
			return "", errors.New("stdin was empty — pipe the passphrase in, or run interactively for a prompt")
		}
		return entered, nil
	}

	fmt.Fprint(a.printer.Err, "Master passphrase (input hidden): ")
	raw, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprintln(a.printer.Err)
	if err != nil {
		return "", errors.New("could not read the passphrase from the terminal")
	}
	if len(raw) == 0 {
		return "", errors.New("no passphrase entered")
	}
	return string(raw), nil
}

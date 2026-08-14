package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/playxoft/xecret/cli/internal/api"
	"github.com/playxoft/xecret/cli/internal/auth"
	"github.com/playxoft/xecret/cli/internal/cache"
	"github.com/playxoft/xecret/cli/internal/cred"
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
	if err := flags.Parse(args); err != nil {
		return err
	}

	a := newApp(false)
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

	listener, err := auth.Listen(state)
	if err != nil {
		return err
	}
	defer listener.Close()

	authorizeURL := auth.AuthorizeURL(base, auth.Challenge(verifier), device, state, listener.Port())

	a.printer.Infof("Opening your browser to approve this device…")
	a.printer.Infof("If it does not open, visit:\n\n  %s\n", authorizeURL)
	_ = auth.OpenBrowser(authorizeURL)

	ctx, cancel := context.WithTimeout(context.Background(), loginTimeout)
	defer cancel()

	code, err := listener.Wait(ctx)
	if err != nil {
		return err
	}

	client := api.New(base, "", userAgent())
	result, err := client.ExchangeCode(ctx, code, verifier)
	if err != nil {
		if apiErr, ok := api.AsError(err); ok && apiErr.Code == "unauthenticated" {
			return errors.New("the login could not be completed — the approval may have expired. Run 'xecret login' again")
		}
		return err
	}

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
	a.printer.Infof("This device appears as %q in the dashboard and can be revoked there.", device)
	return nil
}

// cmdLogout revokes server-side first, then destroys everything local. The
// order matters: a logout that only deleted local state would leave a live
// credential nobody can see.
func cmdLogout(args []string) error {
	flags := flag.NewFlagSet("logout", flag.ContinueOnError)
	if err := flags.Parse(args); err != nil {
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

	a.printer.Successf("Signed out %s — credential revoked, offline cache wiped.", credentials.Email)
	return nil
}

// cmdWhoami answers "which account is this machine using?" from the server,
// so a revoked token reads as signed out rather than as its stale identity.
func cmdWhoami(args []string) error {
	flags := flag.NewFlagSet("whoami", flag.ContinueOnError)
	jsonMode := flags.Bool("json", false, "machine-readable output")
	if err := flags.Parse(args); err != nil {
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

package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"time"
)

const tokensUsage = `Usage:
  xecret tokens list             [--kind cli|service] [--json]
  xecret tokens revoke <ID>      [--kind cli|service] [--yes]

'xecret tokens' with no argument prints this. With a flag first — 'xecret tokens
--json' — it lists, as the other resource commands do.

'cli' tokens are devices — the credentials 'xecret login' writes. The listing is
your own devices only: a CLI token acts as its user and confers nothing of its
own, so your device list is yours in the same way your session list is.

'service' tokens are the CI credentials behind XECRET_TOKEN. They belong to the
organisation rather than to a person, and revoking one takes the same authority
that could have minted it.

Minting a service token is deliberately not here. The server requires a browser
session for it — a token that could mint another token would turn one leaked
credential into a permanent foothold, so the chain has to start with a person.
Create them at <server>/settings/tokens.
`

func cmdTokens(args []string) error {
	switch subcommand(args, "help") {
	case "list":
		return tokensList(listArgs(args))
	case "revoke":
		return tokensRevoke(args[1:])
	case "create":
		// Answered here rather than by the server's 403, because the reason is
		// a design decision and the fix is a URL.
		return errors.New(
			"service tokens are created in the dashboard, under Settings → Tokens — minting one requires a browser session")
	case "help":
		_, _ = io.WriteString(os.Stdout, tokensUsage)
		return nil
	default:
		return fmt.Errorf("unknown tokens subcommand %q — run 'xecret tokens help'", args[0])
	}
}

func tokensList(args []string) error {
	flags := flag.NewFlagSet("tokens list", flag.ContinueOnError)
	jsonMode := flags.Bool("json", false, "machine-readable output")
	kind := flags.String("kind", "", "cli | service (default: both)")
	if err := parseFlagsOnly(flags, args); err != nil {
		return err
	}
	if err := checkKind(*kind, true); err != nil {
		return err
	}

	a := newApp(*jsonMode)
	client, credentials, err := a.client()
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	result := map[string]any{}

	if *kind != "service" {
		// A service token has no devices, and the endpoint says so with a 403.
		// Under XECRET_TOKEN the device half is skipped rather than failed:
		// asking for "both" in CI should not be an error.
		if a.usingServiceToken() && *kind == "" {
			a.printer.Infof("Skipping devices — a service token has none.")
		} else {
			tokens, listErr := client.CliTokens(ctx, credentials.OrgSlug)
			if listErr != nil {
				return listErr
			}
			result["cli"] = tokens

			if !a.printer.JSON {
				rows := make([][]string, len(tokens))
				for i, token := range tokens {
					rows[i] = []string{token.ID, token.Name, tokenState(token.RevokedAt, token.ExpiresAt, token.IsCurrent), lastUsed(token.LastUsedAt)}
				}
				a.printer.Infof("%s", a.printer.Bold("Devices"))
				a.printer.Table([]string{"id", "name", "state", "last used"}, rows)
			}
		}
	}

	if *kind != "cli" {
		tokens, listErr := client.ServiceTokens(ctx, credentials.OrgSlug)
		if listErr != nil {
			return listErr
		}
		result["service"] = tokens

		if !a.printer.JSON {
			rows := make([][]string, len(tokens))
			for i, token := range tokens {
				rows[i] = []string{
					token.ID,
					token.Name,
					token.ProjectSlug + "/" + token.EnvironmentSlug,
					token.AccessLevel,
					tokenState(token.RevokedAt, token.ExpiresAt, false),
					lastUsed(token.LastUsedAt),
				}
			}
			a.printer.Infof("%s", a.printer.Bold("Service tokens"))
			a.printer.Table([]string{"id", "name", "scope", "access", "state", "last used"}, rows)
		}
	}

	if a.printer.JSON {
		return a.printer.WriteJSON(result)
	}
	return nil
}

func tokensRevoke(args []string) error {
	flags := flag.NewFlagSet("tokens revoke", flag.ContinueOnError)
	kind := flags.String("kind", "", "cli | service")
	yes := flags.Bool("yes", false, "skip the confirmation prompt")
	positional, err := parseFlags(flags, args)
	if err != nil {
		return err
	}
	tokenID, err := oneArgument(positional, "a token id — 'xecret tokens list' shows them")
	if err != nil {
		return err
	}
	if err := checkKind(*kind, false); err != nil {
		return err
	}

	a := newApp(false)
	client, credentials, err := a.client()
	if err != nil {
		return err
	}

	if err := confirmDestructive(a, *yes, tokenID,
		fmt.Sprintf("Revoke %s token %s? Anything using it stops working at once.", *kind, tokenID)); err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := client.RevokeToken(ctx, credentials.OrgSlug, *kind, tokenID); err != nil {
		return err
	}
	// Idempotent server-side: revoking an already-dead token succeeds without
	// writing a second audit record, so this message is true either way.
	a.printer.Successf("Revoked. The next request carrying that token fails authentication.")
	return nil
}

// checkKind validates --kind. `allowEmpty` is true for the listing, where the
// absent flag means both, and false for revocation, where the server addresses
// the two kinds through different paths and cannot guess.
func checkKind(kind string, allowEmpty bool) error {
	switch kind {
	case "cli", "service":
		return nil
	case "":
		if allowEmpty {
			return nil
		}
		return errors.New("pass --kind cli or --kind service — the two are revoked through different paths")
	default:
		return fmt.Errorf("unknown kind %q — use cli or service", kind)
	}
}

// tokenState collapses the three timestamps into the one word a reader wants.
func tokenState(revokedAt, expiresAt *string, isCurrent bool) string {
	if revokedAt != nil {
		return "revoked"
	}
	if expiresAt != nil {
		if expiry, err := time.Parse(time.RFC3339, *expiresAt); err == nil && expiry.Before(time.Now()) {
			return "expired"
		}
	}
	if isCurrent {
		return "active (this device)"
	}
	return "active"
}

func lastUsed(at *string) string {
	if at == nil {
		return "never"
	}
	return shortTime(*at)
}

package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"strings"
	"time"

	"github.com/playxoft/xecret/cli/internal/api"
)

// cmdAudit reads the organisation's audit log.
//
// Owners and admins hold `audit.read`; developers deliberately do not, because
// the log spans projects a developer cannot see and records every denial anyone
// ever received. A 403 here is the policy working, not a missing flag.
//
// The server clamps the range to ninety days and reports the window it really
// scanned. That window is printed rather than assumed: a query for "the last
// year" that quietly answered for three months would be worse than useless
// during an incident.
func cmdAudit(args []string) error {
	flags := flag.NewFlagSet("audit", flag.ContinueOnError)
	jsonMode := flags.Bool("json", false, "machine-readable output")
	action := flags.String("action", "", "one action, e.g. secret.revealed")
	projectFlag := flags.String("project", "", "restrict to one project")
	envFlag := flags.String("environment", "", "restrict to one environment (needs --project)")
	outcome := flags.String("outcome", "", "success | denied | error")
	since := flags.String("since", "", "where the window starts, e.g. 24h, 7d (or an RFC 3339 timestamp)")
	until := flags.String("until", "", "where the window ends, same spellings as --since; defaults to now")
	limit := flags.Int("limit", 50, "how many events to read")
	if err := parseFlagsOnly(flags, args); err != nil {
		return err
	}

	switch *outcome {
	case "", "success", "denied", "error":
	default:
		return fmt.Errorf("unknown outcome %q — use success, denied or error", *outcome)
	}
	if *envFlag != "" && *projectFlag == "" {
		return errors.New("--environment narrows a project — pass --project too")
	}
	if *limit < 1 {
		return errors.New("--limit must be at least 1")
	}

	from, err := resolveSince(*since)
	if err != nil {
		return err
	}
	// Both edges go through the same resolver. Forwarding --until raw meant the
	// two flags accepted different syntaxes: a value --since re-formats into
	// RFC 3339 (an offset timestamp, "7d") reached the server verbatim as
	// --until and was rejected by a schema that only takes UTC RFC 3339.
	to, err := resolveUntil(*until)
	if err != nil {
		return err
	}
	if err := checkWindow(from, to); err != nil {
		return err
	}

	a := newApp(*jsonMode)
	client, credentials, err := a.client()
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	page, err := client.Audit(ctx, credentials.OrgSlug, api.AuditFilter{
		Action:          *action,
		ProjectSlug:     *projectFlag,
		EnvironmentSlug: *envFlag,
		Outcome:         *outcome,
		From:            from,
		To:              to,
		Limit:           *limit,
	})
	if err != nil {
		return err
	}

	if a.printer.JSON {
		return a.printer.WriteJSON(page)
	}

	if len(page.Events) == 0 {
		a.printer.Infof("No matching events between %s and %s.",
			shortTime(page.Window.From), shortTime(page.Window.To))
		return nil
	}

	rows := make([][]string, len(page.Events))
	for i, event := range page.Events {
		rows[i] = []string{
			shortTime(event.CreatedAt),
			event.Action,
			event.Outcome,
			actorLabel(event),
			auditSubject(event),
		}
	}
	a.printer.Table([]string{"when", "action", "outcome", "actor", "subject"}, rows)

	a.printer.Infof("Window scanned: %s → %s (the server clamps this to 90 days).",
		shortTime(page.Window.From), shortTime(page.Window.To))
	if page.Truncated {
		a.printer.Warnf("more events matched than --limit %d asked for; this is not the whole story.", *limit)
	}
	return nil
}

// maxWindowDays bounds a relative window. The multiplication that turns days
// into hours overflows time.Duration a little past a century, and an overflowed
// duration negates — which would silently produce an edge in the *future* and
// an empty result reported as "no matching events". The server clamps to ninety
// days anyway, so anything beyond ten years is already a typo.
const maxWindowDays = 3650

// resolveSince turns "24h" or "7d" into a timestamp, and normalises an RFC 3339
// value to UTC. Empty means "let the server decide", which is its own
// ninety-day clamp.
func resolveSince(value string) (string, error) { return resolveWindowEdge("--since", value) }

// resolveUntil reads the far edge of the window with the same grammar, so a
// spelling that works for one flag works for the other. A relative value counts
// backwards from now, as it does for --since: `--until 1h` means "up to an hour
// ago".
func resolveUntil(value string) (string, error) { return resolveWindowEdge("--until", value) }

func resolveWindowEdge(flagName, value string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", nil
	}

	// A day is not a unit time.ParseDuration knows, and it is the one people
	// reach for here.
	if rest, found := strings.CutSuffix(trimmed, "d"); found {
		if days, err := time.ParseDuration(rest + "h"); err == nil {
			if days <= 0 || days > maxWindowDays*time.Hour {
				return "", relativeWindowError(flagName, value)
			}
			return time.Now().Add(-days * 24).UTC().Format(time.RFC3339), nil
		}
	}
	if duration, err := time.ParseDuration(trimmed); err == nil {
		// A negative duration would put the edge ahead of now, and the server
		// would answer honestly with nothing at all.
		if duration <= 0 {
			return "", relativeWindowError(flagName, value)
		}
		return time.Now().Add(-duration).UTC().Format(time.RFC3339), nil
	}
	if parsed, err := time.Parse(time.RFC3339, trimmed); err == nil {
		return parsed.UTC().Format(time.RFC3339), nil
	}
	return "", fmt.Errorf("could not read %s %q as a duration (24h, 7d) or an RFC 3339 timestamp", flagName, value)
}

func relativeWindowError(flagName, value string) error {
	return fmt.Errorf("%s counts backwards from now, so %q must be positive and no longer than %d days",
		flagName, value, maxWindowDays)
}

// checkWindow refuses a range that cannot contain anything, rather than letting
// the server answer it honestly.
//
// clampAuditRange collapses a backwards range to a single instant, so `--since
// 1h --until 24h` and `--since 2030-01-01T00:00:00Z` both come back empty and
// are printed as "No matching events" — a sentence that reads as a fact about
// the log when it is really a fact about the question.
//
// The timestamps are echoed as the UTC the server will see, not as local time:
// the user typed one of these, and answering in a different zone reads as a
// third value neither side mentioned. An absent --until means now, and an
// absent --since leaves the whole thing to the server's own ninety-day clamp.
func checkWindow(from, to string) error {
	if from == "" {
		return nil
	}
	start, err := time.Parse(time.RFC3339, from)
	if err != nil {
		return nil
	}

	// Nothing has been recorded after now, whatever the far edge says, so this
	// catches a window that is well-ordered but entirely in the future.
	if start.After(time.Now()) {
		return fmt.Errorf("--since %s is in the future, and nothing has happened yet", from)
	}

	if to == "" {
		return nil
	}
	end, err := time.Parse(time.RFC3339, to)
	if err != nil {
		return nil
	}
	if start.After(end) {
		return fmt.Errorf("--since %s is after --until %s, so the window is empty", from, to)
	}
	return nil
}

// actorLabel names who did it. The label the server resolved when it has one —
// an email or a token name — and the actor kind when the account has since
// been deleted, which is exactly when the record matters most.
func actorLabel(event api.AuditEvent) string {
	if event.ActorLabel != nil && *event.ActorLabel != "" {
		return *event.ActorLabel
	}
	return event.ActorType
}

// auditSubject reads the parts of `metadata` that say what was acted on. The
// map is deliberately untyped in the client — the shape varies by action — so
// this picks the handful of keys that are worth a column and formats whatever
// it finds.
func auditSubject(event api.AuditEvent) string {
	parts := make([]string, 0, 3)
	for _, key := range []string{"projectSlug", "environmentSlug", "secretName"} {
		if value, ok := event.Metadata[key].(string); ok && value != "" {
			parts = append(parts, value)
		}
	}
	if len(parts) == 0 {
		if event.ResourceType != nil {
			return *event.ResourceType
		}
		return "—"
	}
	return strings.Join(parts, "/")
}

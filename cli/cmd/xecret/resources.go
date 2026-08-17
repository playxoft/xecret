package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/playxoft/xecret/cli/internal/cred"
	"github.com/playxoft/xecret/cli/internal/output"
)

// The resources every secret hangs off: organisations, projects, environments,
// and the people who can reach them.
//
// Each command keeps its bare form — `xecret projects` — as the listing it has
// always been, and adds subcommands beside it. A flag in the first position
// still means "list, with this flag", so no existing invocation changes
// meaning.

const projectsUsage = `Usage:
  xecret projects [list]   [--json]
  xecret projects create   <NAME> [--slug SLUG] [--description TEXT]
  xecret projects delete   <SLUG> [--yes]

Creating a project also creates its default environments — development, staging
and production — each with its own encryption key, in one transaction.
`

const environmentsUsage = `Usage:
  xecret environments [list]   [--json] [--project SLUG]
  xecret environments create   <NAME> [--slug SLUG] [--production] [--project SLUG]
  xecret environments delete   <SLUG> [--yes] [--project SLUG]

An environment is created with its encryption key in the same transaction. One
without a key could not hold a secret and could not be repaired from inside the
product, so the two are never separate.
`

const orgsUsage = `Usage:
  xecret orgs [list]  [--json]
  xecret orgs use     <SLUG>

Your credential works in every organisation you are a member of; 'use' chooses
which one the other commands address, and is stored beside the token. It makes
no network change and revokes nothing — switching back is another 'use'.
`

func cmdProjects(args []string) error {
	switch subcommand(args) {
	case "list":
		return projectsList(listArgs(args))
	case "create":
		return projectsCreate(args[1:])
	case "delete":
		return projectsDelete(args[1:])
	case "help":
		_, _ = io.WriteString(os.Stdout, projectsUsage)
		return nil
	default:
		return fmt.Errorf("unknown projects subcommand %q — run 'xecret projects help'", args[0])
	}
}

func cmdEnvironments(args []string) error {
	switch subcommand(args) {
	case "list":
		return environmentsList(listArgs(args))
	case "create":
		return environmentsCreate(args[1:])
	case "delete":
		return environmentsDelete(args[1:])
	case "help":
		_, _ = io.WriteString(os.Stdout, environmentsUsage)
		return nil
	default:
		return fmt.Errorf("unknown environments subcommand %q — run 'xecret environments help'", args[0])
	}
}

func cmdOrgs(args []string) error {
	switch subcommand(args) {
	case "list":
		return orgsList(listArgs(args))
	case "use":
		return orgsUse(args[1:])
	case "help":
		_, _ = io.WriteString(os.Stdout, orgsUsage)
		return nil
	default:
		return fmt.Errorf("unknown orgs subcommand %q — run 'xecret orgs help'", args[0])
	}
}

// subcommand classifies the first argument. No argument, or one that is a
// flag, means the listing this command has always been.
func subcommand(args []string) string {
	if len(args) == 0 || strings.HasPrefix(args[0], "-") {
		if len(args) > 0 && (args[0] == "-h" || args[0] == "--help") {
			return "help"
		}
		return "list"
	}
	switch args[0] {
	case "list", "create", "delete", "use":
		return args[0]
	case "help":
		return "help"
	}
	return args[0]
}

// listArgs strips a leading explicit "list" so both spellings share a parser.
func listArgs(args []string) []string {
	if len(args) > 0 && args[0] == "list" {
		return args[1:]
	}
	return args
}

func projectsList(args []string) error {
	flags := flag.NewFlagSet("projects list", flag.ContinueOnError)
	jsonMode := flags.Bool("json", false, "machine-readable output")
	if err := flags.Parse(args); err != nil {
		return err
	}

	a := newApp(*jsonMode)
	client, credentials, err := a.client()
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	projects, err := client.Projects(ctx, credentials.OrgSlug)
	if err != nil {
		return err
	}

	if a.printer.JSON {
		return a.printer.WriteJSON(projects)
	}

	if len(projects) == 0 {
		a.printer.Infof("No projects yet. Create one with 'xecret projects create <name>'.")
		return nil
	}

	rows := make([][]string, len(projects))
	for i, project := range projects {
		rows[i] = []string{project.Slug, project.Name, fmt.Sprint(project.EnvironmentCount)}
	}
	a.printer.Table([]string{"slug", "name", "environments"}, rows)
	return nil
}

func projectsCreate(args []string) error {
	flags := flag.NewFlagSet("projects create", flag.ContinueOnError)
	jsonMode := flags.Bool("json", false, "machine-readable output")
	slug := flags.String("slug", "", "permanent identifier (default: derived from the name)")
	description := flags.String("description", "", "what the project is for")
	positional, err := parseFlags(flags, args)
	if err != nil {
		return err
	}
	name, err := oneArgument(positional, "a project name")
	if err != nil {
		return err
	}

	a := newApp(*jsonMode)
	client, credentials, err := a.client()
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	created, err := client.CreateProject(ctx, credentials.OrgSlug, name, *slug, *description)
	if err != nil {
		return err
	}

	if a.printer.JSON {
		return a.printer.WriteJSON(created)
	}

	environments := make([]string, len(created.Environments))
	for i, environment := range created.Environments {
		environments[i] = environment.Slug
	}
	a.printer.Successf("Created project %s with %s.",
		a.printer.Bold(created.Project.Slug), strings.Join(environments, ", "))
	// The slug is what goes in .xecret.yaml and in CI, and it cannot be changed
	// afterwards — worth seeing once, at the moment it is settled.
	a.printer.Infof("Point this directory at it with 'xecret init --project %s --environment %s'.",
		created.Project.Slug, firstOr(environments, "development"))
	return nil
}

func projectsDelete(args []string) error {
	flags := flag.NewFlagSet("projects delete", flag.ContinueOnError)
	yes := flags.Bool("yes", false, "skip the confirmation prompt")
	positional, err := parseFlags(flags, args)
	if err != nil {
		return err
	}
	slug, err := oneArgument(positional, "a project slug")
	if err != nil {
		return err
	}

	a := newApp(false)
	client, credentials, err := a.client()
	if err != nil {
		return err
	}

	if err := confirmDestructive(a, *yes, slug,
		fmt.Sprintf("Delete project %s and every environment and secret under it?", slug)); err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	if err := client.DeleteProject(ctx, credentials.OrgSlug, slug, slug); err != nil {
		return err
	}
	a.printer.Successf("Deleted project %s. The delete is soft — an operator can still recover it.", slug)
	return nil
}

func environmentsList(args []string) error {
	flags := flag.NewFlagSet("environments list", flag.ContinueOnError)
	jsonMode := flags.Bool("json", false, "machine-readable output")
	projectFlag := flags.String("project", "", "project slug (default: .xecret.yaml)")
	if err := flags.Parse(args); err != nil {
		return err
	}

	a := newApp(*jsonMode)
	client, credentials, err := a.client()
	if err != nil {
		return err
	}

	// The environment half of the scope is irrelevant here; "-" placates the
	// resolver without requiring a .xecret.yaml when --project is given.
	resolved, err := a.resolveScope(credentials, *projectFlag, "-")
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	environments, err := client.Environments(ctx, resolved.Org, resolved.Project)
	if err != nil {
		return err
	}

	if a.printer.JSON {
		return a.printer.WriteJSON(environments)
	}

	rows := make([][]string, len(environments))
	for i, environment := range environments {
		production := ""
		if environment.IsProduction {
			production = "yes"
		}
		rows[i] = []string{environment.Slug, environment.Name, production}
	}
	a.printer.Table([]string{"slug", "name", "production"}, rows)
	return nil
}

func environmentsCreate(args []string) error {
	flags := flag.NewFlagSet("environments create", flag.ContinueOnError)
	jsonMode := flags.Bool("json", false, "machine-readable output")
	slug := flags.String("slug", "", "identifier used in --environment and .xecret.yaml")
	isProduction := flags.Bool("production", false, "treat this environment as production")
	projectFlag := flags.String("project", "", "project slug (default: .xecret.yaml)")
	positional, err := parseFlags(flags, args)
	if err != nil {
		return err
	}
	name, err := oneArgument(positional, "an environment name")
	if err != nil {
		return err
	}

	a := newApp(*jsonMode)
	client, credentials, err := a.client()
	if err != nil {
		return err
	}
	resolved, err := a.resolveScope(credentials, *projectFlag, "-")
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	environment, err := client.CreateEnvironment(
		ctx, resolved.Org, resolved.Project, name, *slug, *isProduction)
	if err != nil {
		return err
	}

	if a.printer.JSON {
		return a.printer.WriteJSON(environment)
	}
	a.printer.Successf("Created environment %s in %s.",
		a.printer.Bold(environment.Slug), resolved.Project)
	if environment.IsProduction {
		a.printer.Infof("Marked production: reads are narrower, and deleting it will ask you to type the slug.")
	}
	return nil
}

func environmentsDelete(args []string) error {
	flags := flag.NewFlagSet("environments delete", flag.ContinueOnError)
	yes := flags.Bool("yes", false, "skip the confirmation prompt")
	projectFlag := flags.String("project", "", "project slug (default: .xecret.yaml)")
	positional, err := parseFlags(flags, args)
	if err != nil {
		return err
	}
	slug, err := oneArgument(positional, "an environment slug")
	if err != nil {
		return err
	}

	a := newApp(false)
	client, credentials, err := a.client()
	if err != nil {
		return err
	}
	resolved, err := a.resolveScope(credentials, *projectFlag, "-")
	if err != nil {
		return err
	}

	if err := confirmDestructive(a, *yes, slug,
		fmt.Sprintf("Delete environment %s of %s and every secret in it?", slug, resolved.Project)); err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	if err := client.DeleteEnvironment(ctx, resolved.Org, resolved.Project, slug, slug); err != nil {
		return err
	}
	a.printer.Successf("Deleted environment %s. The delete is soft — the key still unwraps what was in it.", slug)
	return nil
}

func orgsList(args []string) error {
	flags := flag.NewFlagSet("orgs list", flag.ContinueOnError)
	jsonMode := flags.Bool("json", false, "machine-readable output")
	if err := flags.Parse(args); err != nil {
		return err
	}

	a := newApp(*jsonMode)
	if a.usingServiceToken() {
		return errors.New("a service token is pinned to one organisation — 'xecret whoami' names it")
	}

	client, credentials, err := a.client()
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	organizations, err := client.Organizations(ctx)
	if err != nil {
		return err
	}

	if a.printer.JSON {
		return a.printer.WriteJSON(organizations)
	}

	rows := make([][]string, len(organizations))
	for i, organization := range organizations {
		current := ""
		if organization.Slug == credentials.OrgSlug {
			current = "current"
		}
		rows[i] = []string{organization.Slug, organization.Name, organization.Role, current}
	}
	a.printer.Table([]string{"slug", "name", "role", ""}, rows)
	return nil
}

// orgsUse changes which organisation the stored credential addresses.
//
// Purely local: a CLI token authenticates as its user, and the server settles
// membership per request against whichever organisation the path names — so
// this rewrites one field beside the token and nothing else. It is checked
// against the server's own list first, because "you are not a member" is a
// better answer now than a 404 on the next command.
func orgsUse(args []string) error {
	flags := flag.NewFlagSet("orgs use", flag.ContinueOnError)
	positional, err := parseFlags(flags, args)
	if err != nil {
		return err
	}
	slug, err := oneArgument(positional, "an organisation slug")
	if err != nil {
		return err
	}

	a := newApp(false)
	if a.usingServiceToken() {
		return errors.New("XECRET_TOKEN is pinned to one organisation server-side; unset it to switch")
	}

	client, credentials, err := a.client()
	if err != nil {
		return err
	}
	if credentials.OrgSlug == slug {
		a.printer.Infof("Already using %s.", slug)
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	organizations, err := client.Organizations(ctx)
	if err != nil {
		return err
	}
	for _, organization := range organizations {
		if organization.Slug != slug {
			continue
		}
		updated := *credentials
		updated.OrgSlug = organization.Slug
		if err := cred.Save(a.store, updated); err != nil {
			return err
		}
		a.printer.Successf("Now using %s (%s).", a.printer.Bold(organization.Slug), organization.Role)
		a.printer.Infof("A .xecret.yaml naming a project from another organisation will stop resolving.")
		return nil
	}
	return fmt.Errorf("you are not a member of %q — 'xecret orgs' lists the ones you are in", slug)
}

// cmdMembers lists who is in the organisation. Read-only on purpose:
// inviting, suspending and changing a role are browser-session acts
// server-side, so a `members add` here could only ever print a 403.
func cmdMembers(args []string) error {
	flags := flag.NewFlagSet("members", flag.ContinueOnError)
	jsonMode := flags.Bool("json", false, "machine-readable output")
	if err := flags.Parse(args); err != nil {
		return err
	}

	a := newApp(*jsonMode)
	client, credentials, err := a.client()
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	members, seats, err := client.Members(ctx, credentials.OrgSlug)
	if err != nil {
		return err
	}

	if a.printer.JSON {
		return a.printer.WriteJSON(map[string]any{"members": members, "seats": seats})
	}

	rows := make([][]string, len(members))
	for i, member := range members {
		you := ""
		if member.IsYou {
			you = "you"
		}
		rows[i] = []string{member.Email, member.Role, member.Status, you}
	}
	a.printer.Table([]string{"email", "role", "status", ""}, rows)
	if seats != nil {
		a.printer.Infof("%d of %d seats used, %d invitation(s) outstanding.",
			seats.Used, seats.Limit, seats.PendingInvitations)
	}
	return nil
}

// confirmDestructive asks the user to type the slug back. A guard against a
// misclick, not against an attacker — anyone who can run the command can also
// read the slug. Refused outright without a terminal, so a script that forgot
// --yes cannot hang on a prompt nobody will answer.
func confirmDestructive(a *app, yes bool, expected, question string) error {
	if yes {
		return nil
	}
	if !output.StdoutIsTerminal() {
		return errors.New("refusing to delete without confirmation — pass --yes in scripts")
	}
	fmt.Fprintf(a.printer.Err, "%s Type %q to confirm: ", question, expected)
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil || strings.TrimSpace(line) != expected {
		return errors.New("confirmation did not match; nothing deleted")
	}
	return nil
}

// oneArgument takes exactly one positional argument, or explains what was
// wanted. Deliberately not `oneName`, which enforces the secret-name pattern.
func oneArgument(positional []string, what string) (string, error) {
	if len(positional) != 1 || strings.TrimSpace(positional[0]) == "" {
		return "", fmt.Errorf("expected %s", what)
	}
	return strings.TrimSpace(positional[0]), nil
}

func firstOr(values []string, fallback string) string {
	if len(values) == 0 {
		return fallback
	}
	return values[0]
}

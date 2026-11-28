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

	"github.com/playxoft/xecret/cli/internal/api"
	"github.com/playxoft/xecret/cli/internal/cred"
	"github.com/playxoft/xecret/cli/internal/ids"
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
  xecret projects delete   <PROJECT-ID> [--yes]

A project is named by its Project ID, e.g. payments-api: chosen when the
project is created, unique within the organisation, and never changed.

There is no 'create' here. A project arrives with its default environments
(development, staging and production), each end-to-end encrypted under a key
generated in the creator's browser and sealed to them, and no client outside a
browser implements that sealing. Create projects in the dashboard.
`

const environmentsUsage = `Usage:
  xecret environments [list]   [--json] [--project PROJECT-ID]
  xecret environments delete   <SLUG> [--yes] [--project PROJECT-ID]

There is no 'create' here either, for the reason 'xecret projects help' gives:
an environment is inseparable from its encryption key, and that key is generated
in a browser and sealed to its creator. Create environments in the dashboard.
`

const orgsUsage = `Usage:
  xecret orgs [list]  [--json]
  xecret orgs use     <ORGANISATION-ID | NAME>

Your credential works in every organisation you are a member of; 'use' chooses
which one the other commands address, and is stored beside the token. It makes
no network change and revokes nothing: switching back is another 'use'.

An organisation is named by its id, which 'xecret orgs' lists. Its name works
too, ignoring case, when no other organisation you belong to has the same one.

A directory whose .xecret.yaml names an organisation keeps using that one,
whichever is chosen here.
`

func cmdProjects(args []string) error {
	switch subcommand(args, "list") {
	case "list":
		return projectsList(listArgs(args))
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
	switch subcommand(args, "list") {
	case "list":
		return environmentsList(listArgs(args))
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
	switch subcommand(args, "list") {
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

// subcommand classifies the first argument, shared by every command that has
// subcommands so the rule is one rule rather than one per switch.
//
// A leading flag always means the listing — `xecret projects --json`, and
// equally `xecret tokens --json`, which used to be an "unknown subcommand"
// purely because that command hand-rolled its own dispatch. `bare` is what an
// empty argument list means, and differs on purpose: for projects,
// environments and orgs the bare form has always been the listing, while
// `secrets` and `tokens` print their usage, which is long enough to be worth
// reading before anything is written.
func subcommand(args []string, bare string) string {
	if len(args) == 0 {
		return bare
	}
	switch args[0] {
	case "help", "--help", "-h":
		return "help"
	}
	if strings.HasPrefix(args[0], "-") {
		return "list"
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
	if err := parseFlagsOnly(flags, args); err != nil {
		return err
	}

	a := newApp(*jsonMode)
	client, credentials, err := a.client()
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	projects, err := client.Projects(ctx, credentials.OrgRef())
	if err != nil {
		return err
	}

	if a.printer.JSON {
		return a.printer.WriteJSON(projects)
	}

	if len(projects) == 0 {
		a.printer.Infof("No projects yet. Create one in the dashboard — a project's environment keys are generated in your browser, which this CLI cannot do.")
		return nil
	}

	rows := make([][]string, len(projects))
	for i, project := range projects {
		rows[i] = []string{project.Slug, project.Name, fmt.Sprint(project.EnvironmentCount)}
	}
	a.printer.Table([]string{"project id", "name", "environments"}, rows)
	return nil
}

func projectsDelete(args []string) error {
	flags := flag.NewFlagSet("projects delete", flag.ContinueOnError)
	yes := flags.Bool("yes", false, "skip the confirmation prompt")
	positional, err := parseFlags(flags, args)
	if err != nil {
		return err
	}
	slug, err := oneArgument(positional, "a Project ID")
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

	if err := client.DeleteProject(ctx, credentials.OrgRef(), slug, slug); err != nil {
		return err
	}
	a.printer.Successf("Deleted project %s. The delete is soft — an operator can still recover it.", slug)
	return nil
}

func environmentsList(args []string) error {
	flags := flag.NewFlagSet("environments list", flag.ContinueOnError)
	jsonMode := flags.Bool("json", false, "machine-readable output")
	projectFlag := flags.String("project", "", projectFlagHelp)
	if err := parseFlagsOnly(flags, args); err != nil {
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

func environmentsDelete(args []string) error {
	flags := flag.NewFlagSet("environments delete", flag.ContinueOnError)
	yes := flags.Bool("yes", false, "skip the confirmation prompt")
	projectFlag := flags.String("project", "", projectFlagHelp)
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
	if err := parseFlagsOnly(flags, args); err != nil {
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
	// The listing is the server's own word on the credential's organisation,
	// so a credential from before organisation ids learns its id here too.
	if adoptOrganization(credentials, organizations) {
		if err := cred.Save(a.store, *credentials); err != nil {
			a.printer.Warnf("could not record this organisation's id for next time: %v", err)
		}
	}

	// An organisation is listed by its id and its name. The slug the server
	// still sends is not passed on: nothing should be built on it any more.
	type listedOrganization struct {
		ID      string `json:"id"`
		Name    string `json:"name"`
		Role    string `json:"role"`
		Current bool   `json:"current"`
	}
	listed := make([]listedOrganization, len(organizations))
	rows := make([][]string, len(organizations))
	for i, organization := range organizations {
		isCurrent := credentials.IsOrg(organization.ID, organization.Slug)
		listed[i] = listedOrganization{
			ID: organization.ID, Name: organization.Name, Role: organization.Role, Current: isCurrent,
		}
		current := ""
		if isCurrent {
			current = "current"
		}
		rows[i] = []string{organization.Name, organization.ID, organization.Role, current}
	}

	if a.printer.JSON {
		return a.printer.WriteJSON(listed)
	}
	a.printer.Table([]string{"name", "id", "role", ""}, rows)
	return nil
}

// orgsUse changes which organisation the stored credential addresses.
//
// Purely local: a CLI token authenticates as its user, and the server settles
// membership per request against whichever organisation the path names — so
// this rewrites the fields beside the token that name it, and nothing else. It
// is checked against the server's own list first, because "you are not a
// member" is a better answer now than a 404 on the next command.
func orgsUse(args []string) error {
	flags := flag.NewFlagSet("orgs use", flag.ContinueOnError)
	positional, err := parseFlags(flags, args)
	if err != nil {
		return err
	}
	ref, err := oneArgument(positional, "an organisation's id or name; 'xecret orgs' lists them")
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
	if id, ok := ids.Canonical(ref); ((ok && id == credentials.OrgID) || ref == credentials.OrgSlug) &&
		credentials.OrgLabel() != "" {
		a.printer.Infof("Already using %s.", credentials.OrgLabel())
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	organizations, err := client.Organizations(ctx)
	if err != nil {
		return err
	}
	organization, err := chooseOrganization(organizations, ref)
	if err != nil {
		return err
	}

	if credentials.IsOrg(organization.ID, organization.Slug) {
		if adoptOrganization(credentials, organizations) {
			if err := cred.Save(a.store, *credentials); err != nil {
				a.printer.Warnf("could not record this organisation's id for next time: %v", err)
			}
		}
		a.printer.Infof("Already using %s.", organization.Name)
		return nil
	}
	updated := *credentials
	updated.OrgID = organization.ID
	updated.OrgName = organization.Name
	// The slug is kept beside the id, unseen: an older binary run after a
	// downgrade addresses the organisation by nothing else, and this one finds
	// what such a build filed offline through it.
	updated.OrgSlug = organization.Slug
	if err := cred.Save(a.store, updated); err != nil {
		return err
	}
	a.printer.Successf("Now using %s (%s).", a.printer.Bold(organization.Name), organization.Role)
	a.printer.Infof("A .xecret.yaml that names its organisation keeps using it; an older one with no " +
		"organisation now resolves in this one.")
	return nil
}

// chooseOrganization picks the membership `orgs use` was pointed at.
//
// In order: the id, exactly; then a legacy slug, exactly, which is what every
// script written before ids passes and is accepted without being advertised;
// then the name, ignoring case, when exactly one membership has it. Names are
// free text and not unique, so a name two organisations share is not guessed
// between: the refusal lists each with its id, which is the unambiguous thing
// to pass instead. The slug is tried before the name so that an old script's
// argument can never be captured by another organisation that happens to be
// called the same thing.
func chooseOrganization(organizations []api.Organization, ref string) (api.Organization, error) {
	if id, ok := ids.Canonical(ref); ok {
		for _, organization := range organizations {
			if organization.ID == id {
				return organization, nil
			}
		}
	}
	for _, organization := range organizations {
		if organization.Slug != "" && organization.Slug == ref {
			return organization, nil
		}
	}

	var named []api.Organization
	for _, organization := range organizations {
		if strings.EqualFold(organization.Name, ref) {
			named = append(named, organization)
		}
	}
	switch len(named) {
	case 1:
		return named[0], nil
	case 0:
		return api.Organization{}, fmt.Errorf(
			"you are not a member of an organisation with the id or name %q; 'xecret orgs' lists the ones you are in",
			ref)
	}

	var choices strings.Builder
	for _, organization := range named {
		fmt.Fprintf(&choices, "\n  %s  %s (%s)", organization.ID, organization.Name, organization.Role)
	}
	return api.Organization{}, fmt.Errorf(
		"%d of your organisations are called %q; run 'xecret orgs use' with the id of the one you mean:%s",
		len(named), ref, choices.String())
}

// cmdMembers lists who is in the organisation. Read-only on purpose:
// inviting, suspending and changing a role are browser-session acts
// server-side, so a `members add` here could only ever print a 403.
func cmdMembers(args []string) error {
	flags := flag.NewFlagSet("members", flag.ContinueOnError)
	jsonMode := flags.Bool("json", false, "machine-readable output")
	if err := parseFlagsOnly(flags, args); err != nil {
		return err
	}

	a := newApp(*jsonMode)
	client, credentials, err := a.client()
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	members, seats, err := client.Members(ctx, credentials.OrgRef())
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

// confirmDestructive asks the user to type the name back. A guard against a
// misclick, not against an attacker — anyone who can run the command can also
// read the name. Refused outright without a terminal, so a script that forgot
// --yes cannot hang on a prompt nobody will answer.
//
// The terminal test is on *stdin*, the stream the answer is read from. Stdout
// is where the caller's redirection usually lands, and it says nothing about
// whether anybody is there to type.
func confirmDestructive(a *app, yes bool, expected, question string) error {
	if yes {
		return nil
	}
	if !output.StdinIsTerminal() {
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

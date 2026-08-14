package main

import (
	"context"
	"flag"
	"fmt"
	"time"
)

// cmdProjects lists the organisation's projects.
func cmdProjects(args []string) error {
	flags := flag.NewFlagSet("projects", flag.ContinueOnError)
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
		a.printer.Infof("No projects yet. Create one in the dashboard: %s", credentials.APIURL)
		return nil
	}

	rows := make([][]string, len(projects))
	for i, project := range projects {
		rows[i] = []string{project.Slug, project.Name, fmt.Sprint(project.EnvironmentCount)}
	}
	a.printer.Table([]string{"slug", "name", "environments"}, rows)
	return nil
}

// cmdEnvironments lists the current (or named) project's environments.
func cmdEnvironments(args []string) error {
	flags := flag.NewFlagSet("environments", flag.ContinueOnError)
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

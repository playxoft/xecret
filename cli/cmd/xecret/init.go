package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/playxoft/xecret/cli/internal/api"
	"github.com/playxoft/xecret/cli/internal/config"
	"github.com/playxoft/xecret/cli/internal/output"
)

// cmdInit writes .xecret.yaml in the current directory.
//
// Both slugs are validated against the server before anything is written —
// a config file that 404s on first use is worse than an extra round trip
// here. Interactively, the same listings drive the picker.
func cmdInit(args []string) error {
	flags := flag.NewFlagSet("init", flag.ContinueOnError)
	projectFlag := flags.String("project", "", "project slug (skips the prompt)")
	envFlag := flags.String("environment", "", "environment slug (skips the prompt)")
	force := flags.Bool("force", false, "overwrite an existing "+config.Filename)
	if err := flags.Parse(args); err != nil {
		return err
	}

	a := newApp(false)
	client, credentials, err := a.client()
	if err != nil {
		return err
	}
	org := credentials.OrgSlug

	cwd, err := os.Getwd()
	if err != nil {
		return err
	}
	target := filepath.Join(cwd, config.Filename)
	if _, statErr := os.Stat(target); statErr == nil && !*force {
		return errors.New(config.Filename + " already exists here — pass --force to replace it")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	interactive := output.StdoutIsTerminal()

	projects, err := client.Projects(ctx, org)
	if err != nil {
		return err
	}
	if len(projects) == 0 {
		return errors.New("this organisation has no projects yet — create one in the dashboard first")
	}

	projectSlug := strings.TrimSpace(*projectFlag)
	if projectSlug == "" {
		if !interactive {
			return errors.New("no terminal to prompt on — pass --project and --environment")
		}
		names := make([]string, len(projects))
		slugs := make([]string, len(projects))
		for i, project := range projects {
			names[i] = fmt.Sprintf("%s (%s)", project.Name, project.Slug)
			slugs[i] = project.Slug
		}
		projectSlug, err = choose(a, "Project", names, slugs)
		if err != nil {
			return err
		}
	} else if !containsProject(projects, projectSlug) {
		return fmt.Errorf("no project with slug %q — run 'xecret projects' to list them", projectSlug)
	}

	environments, err := client.Environments(ctx, org, projectSlug)
	if err != nil {
		return err
	}
	if len(environments) == 0 {
		return errors.New("that project has no environments — create one in the dashboard first")
	}

	envSlug := strings.TrimSpace(*envFlag)
	if envSlug == "" {
		if !interactive {
			return errors.New("no terminal to prompt on — pass --project and --environment")
		}
		names := make([]string, len(environments))
		slugs := make([]string, len(environments))
		for i, environment := range environments {
			label := fmt.Sprintf("%s (%s)", environment.Name, environment.Slug)
			if environment.IsProduction {
				label += "  ⚠ production"
			}
			names[i] = label
			slugs[i] = environment.Slug
		}
		envSlug, err = choose(a, "Environment", names, slugs)
		if err != nil {
			return err
		}
	} else if !containsEnvironment(environments, envSlug) {
		return fmt.Errorf("no environment with slug %q — run 'xecret environments --project %s'", envSlug, projectSlug)
	}

	if err := config.Write(target, config.Config{Project: projectSlug, Environment: envSlug}); err != nil {
		return err
	}

	a.printer.Successf("Wrote %s — project %s, environment %s.", config.Filename, projectSlug, envSlug)
	a.printer.Infof("The file holds slugs only, never secrets; commit it.")
	return nil
}

// choose prints a numbered list and reads a selection — a number or a slug.
func choose(a *app, label string, names, slugs []string) (string, error) {
	fmt.Fprintf(a.printer.Err, "\n%s:\n", label)
	for i, name := range names {
		fmt.Fprintf(a.printer.Err, "  %2d. %s\n", i+1, name)
	}
	fmt.Fprintf(a.printer.Err, "Choose 1-%d: ", len(names))

	reader := bufio.NewReader(os.Stdin)
	line, err := reader.ReadString('\n')
	if err != nil {
		return "", errors.New("no selection made")
	}
	answer := strings.TrimSpace(line)

	if index, convErr := strconv.Atoi(answer); convErr == nil {
		if index >= 1 && index <= len(slugs) {
			return slugs[index-1], nil
		}
		return "", fmt.Errorf("%d is not between 1 and %d", index, len(slugs))
	}
	for _, slug := range slugs {
		if slug == answer {
			return slug, nil
		}
	}
	return "", fmt.Errorf("%q is neither a listed number nor a slug", answer)
}

func containsProject(projects []api.Project, slug string) bool {
	for _, project := range projects {
		if project.Slug == slug {
			return true
		}
	}
	return false
}

func containsEnvironment(environments []api.Environment, slug string) bool {
	for _, environment := range environments {
		if environment.Slug == slug {
			return true
		}
	}
	return false
}

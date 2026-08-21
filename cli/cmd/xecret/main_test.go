package main

import (
	"strings"
	"testing"
)

func TestDispatchKnownCommands(t *testing.T) {
	for _, args := range [][]string{
		{},
		{"version"},
		{"--version"},
		{"-v"},
		{"help"},
		{"--help"},
		{"-h"},
	} {
		if code := dispatch(args); code != 0 {
			t.Errorf("dispatch(%v) exited %d, want 0", args, code)
		}
	}
}

func TestDispatchUnknownCommandFails(t *testing.T) {
	// The error text (which points at 'xecret help') goes to stderr; the
	// contract this test can hold is the exit code.
	if code := dispatch([]string{"definitely-not-a-command"}); code == 0 {
		t.Fatal("expected a non-zero exit for an unknown command")
	}
}

func TestSplitBeforeDashDash(t *testing.T) {
	args := []string{"--offline", "--", "npm", "run", "dev", "--", "extra"}

	before := splitBeforeDashDash(args)
	if len(before) != 1 || before[0] != "--offline" {
		t.Errorf("flags before -- = %v, want [--offline]", before)
	}

	child := childArgv(args, nil)
	want := []string{"npm", "run", "dev", "--", "extra"}
	if len(child) != len(want) {
		t.Fatalf("childArgv = %v, want %v", child, want)
	}
	for i := range want {
		if child[i] != want[i] {
			t.Fatalf("childArgv = %v, want %v", child, want)
		}
	}
}

func TestChildArgvWithoutDashDash(t *testing.T) {
	remainder := []string{"npm", "run", "dev"}
	child := childArgv([]string{"npm", "run", "dev"}, remainder)
	if len(child) != 3 || child[0] != "npm" {
		t.Errorf("childArgv without -- = %v, want the remainder", child)
	}
}

// The rule the rest of this binary now follows applies to the two commands that
// parse nothing at all as well. `xecret version --json` printed the prose line
// and exited 0, so a script asking for machine-readable output got prose and no
// way to tell.
func TestVersionAndHelpRefuseArguments(t *testing.T) {
	for _, args := range [][]string{
		{"version", "extra"},
		{"version", "--json"},
		{"help", "nonsense"},
		{"help", "pull"},
	} {
		if code := dispatch(args); code == 0 {
			t.Errorf("dispatch(%v) exited 0; an argument nobody reads must be refused", args)
		}
	}
}

// `xecret help pull` is a reasonable thing to type, and the reply worth giving
// is the form that works rather than the general help it used to print.
func TestHelpForOneCommandPointsAtThatCommand(t *testing.T) {
	err := unexpectedHelpArgument("pull")
	if err == nil {
		t.Fatal("an argument to 'help' must be refused")
	}
	if want := "xecret pull --help"; !strings.Contains(err.Error(), want) {
		t.Errorf("the reply should name %q, got %q", want, err)
	}

	// A word that names no command gets no second command to run.
	err = unexpectedHelpArgument("nonsense")
	if err == nil {
		t.Fatal("an argument to 'help' must be refused")
	}
	if strings.Contains(err.Error(), "xecret nonsense") {
		t.Errorf("a word that names no command must not be offered as one, got %q", err)
	}
}

// An error that tells somebody what to run next is only worth printing if what
// it names works. `xecret help version` used to answer with `xecret version
// --help`, which fails in exactly the same way for exactly the same reason —
// `version` parses no flags — so following the advice landed on a second copy
// of the first refusal. Whatever this points at must exit 0.
func TestHelpNeverPointsAtACommandThatWillAlsoFail(t *testing.T) {
	for _, command := range completionTree {
		err := unexpectedHelpArgument(command.Name)
		if err == nil {
			t.Fatalf("'xecret help %s' must be refused", command.Name)
		}
		if !strings.Contains(err.Error(), "--help") {
			continue // Pointed at the command list instead, which always works.
		}
		if code := dispatch([]string{command.Name, "--help"}); code != 0 {
			t.Errorf("'help %s' advises 'xecret %s --help', which exits %d",
				command.Name, command.Name, code)
		}
	}
}

// `xecret cache clear --help` erased the cache once. It goes through the shared
// refusal now, so this pins both halves: --help describes and does not delete,
// and a stray word is refused rather than discarded.
func TestCacheClearStillDescribesItselfRatherThanRunning(t *testing.T) {
	for _, args := range [][]string{{"cache", "clear", "--help"}, {"cache", "clear", "-h"}} {
		if code := dispatch(args); code != 0 {
			t.Errorf("dispatch(%v) exited %d; --help is not a failure", args, code)
		}
	}
	if code := dispatch([]string{"cache", "clear", "nonsense"}); code == 0 {
		t.Error("'cache clear' must refuse an argument it has nothing to do with")
	}
}

package main

import (
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

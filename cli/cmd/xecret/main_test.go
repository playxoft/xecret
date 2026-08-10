package main

import (
	"strings"
	"testing"
)

func TestRunKnownCommands(t *testing.T) {
	for _, args := range [][]string{
		{},
		{"version"},
		{"--version"},
		{"-v"},
		{"help"},
		{"--help"},
		{"-h"},
	} {
		if err := run(args); err != nil {
			t.Errorf("run(%v) returned an unexpected error: %v", args, err)
		}
	}
}

func TestRunUnknownCommandErrors(t *testing.T) {
	err := run([]string{"definitely-not-a-command"})
	if err == nil {
		t.Fatal("expected an error for an unknown command")
	}
	// A good error names the problem and the next step. Asserted because CLI
	// error quality is a product requirement here, not a nicety.
	if got := err.Error(); !strings.Contains(got, "xecret help") {
		t.Errorf("error should point the user at 'xecret help', got %q", got)
	}
}

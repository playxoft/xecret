package run

import (
	"slices"
	"testing"
)

func TestMergeEnvInjectedValueWins(t *testing.T) {
	base := []string{"PATH=/usr/bin", "DATABASE_URL=stale", "HOME=/home/dev"}
	merged := MergeEnv(base, map[string]string{"DATABASE_URL": "fresh", "NEW_KEY": "v"})

	if slices.Contains(merged, "DATABASE_URL=stale") {
		t.Error("a stale exported value must not survive injection")
	}
	if !slices.Contains(merged, "DATABASE_URL=fresh") {
		t.Error("the injected value is missing")
	}
	if !slices.Contains(merged, "NEW_KEY=v") || !slices.Contains(merged, "PATH=/usr/bin") {
		t.Errorf("merge lost entries: %v", merged)
	}
}

func TestMergeEnvIsDeterministic(t *testing.T) {
	extra := map[string]string{"B": "2", "A": "1", "C": "3"}
	first := MergeEnv(nil, extra)
	second := MergeEnv(nil, extra)
	if !slices.Equal(first, second) {
		t.Error("merge order must not depend on map iteration")
	}
	if !slices.IsSorted(first) {
		t.Errorf("injected entries should be sorted, got %v", first)
	}
}

func TestExecRefusesEmptyArgv(t *testing.T) {
	code, err := Exec(t.Context(), nil, nil)
	if err == nil || code != 2 {
		t.Fatalf("empty argv: code=%d err=%v", code, err)
	}
}

func TestExecReportsCommandNotFound(t *testing.T) {
	code, err := Exec(t.Context(), []string{"xecret-test-definitely-missing-binary"}, nil)
	if err == nil || code != 127 {
		t.Fatalf("missing binary: code=%d err=%v", code, err)
	}
}

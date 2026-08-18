//go:build !windows

package run

import (
	"os"
	"path/filepath"
	"testing"
)

// TestExecInjectsIntoChildEnvironment proves the injection path end to end
// with a real child: the value goes in through the environment and comes out
// through a file the child writes — never through argv or this test's stdout.
func TestExecInjectsIntoChildEnvironment(t *testing.T) {
	outFile := filepath.Join(t.TempDir(), "captured")

	code, err := Exec(
		t.Context(),
		[]string{"sh", "-c", `printf '%s' "$XECRET_TEST_VALUE" > "$XECRET_TEST_OUT"`},
		map[string]string{
			"XECRET_TEST_VALUE": "injected-value",
			"XECRET_TEST_OUT":   outFile,
		},
	)
	if err != nil || code != 0 {
		t.Fatalf("Exec: code=%d err=%v", code, err)
	}

	captured, err := os.ReadFile(outFile)
	if err != nil {
		t.Fatal(err)
	}
	if string(captured) != "injected-value" {
		t.Errorf("child saw %q", captured)
	}
}

func TestExecPropagatesExitCode(t *testing.T) {
	code, err := Exec(t.Context(), []string{"sh", "-c", "exit 7"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if code != 7 {
		t.Errorf("exit code = %d, want 7 — CI depends on this being exact", code)
	}
}

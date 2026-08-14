// Package run spawns the child process for `xecret run` with secrets in its
// environment — and nowhere else.
//
// The injection path is: server decrypts → HTTPS → process memory → child
// environment. No temporary file, no argv, no shell. The child is executed
// directly (no `sh -c`), so nothing re-tokenises the command line and no
// secret can leak through shell history or `ps` output.
package run

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"os/signal"
	"sort"
	"strings"
)

// Exec runs argv with extra injected into its environment, forwarding
// signals, and returns the child's exit code.
//
// Injected values override inherited ones of the same name: the point of
// `xecret run` is that xecret is the source of truth for configuration, and
// an already-exported stale DATABASE_URL silently winning over the managed
// one is the bug this line exists to prevent.
func Exec(ctx context.Context, argv []string, extra map[string]string) (int, error) {
	if len(argv) == 0 {
		return 2, errors.New("no command given — usage: xecret run -- <command> [args]")
	}

	path, err := exec.LookPath(argv[0])
	if err != nil {
		return 127, errors.New("command not found: " + argv[0])
	}

	cmd := exec.CommandContext(ctx, path, argv[1:]...)
	cmd.Env = MergeEnv(os.Environ(), extra)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	// Relay every relayable signal. Ctrl-C reaches the child through the
	// terminal's process group already; this covers signals sent to the CLI
	// specifically (kill, a supervisor, a CI runner's shutdown).
	signals := make(chan os.Signal, 4)
	signal.Notify(signals, forwardedSignals()...)
	defer signal.Stop(signals)

	if err := cmd.Start(); err != nil {
		return 126, errors.New("could not start " + argv[0])
	}

	done := make(chan struct{})
	go func() {
		for {
			select {
			case sig := <-signals:
				_ = cmd.Process.Signal(sig)
			case <-done:
				return
			}
		}
	}()

	waitErr := cmd.Wait()
	close(done)

	if waitErr == nil {
		return 0, nil
	}
	var exitErr *exec.ExitError
	if errors.As(waitErr, &exitErr) {
		// Propagate the child's code exactly — including the 128+signal form
		// ProcessState reports on Unix — so CI sees what the child did.
		return exitErr.ExitCode(), nil
	}
	return 1, waitErr
}

// MergeEnv overlays extra onto base ("KEY=VALUE" pairs), replacing collisions.
// Deterministic order keeps behaviour reproducible across runs.
func MergeEnv(base []string, extra map[string]string) []string {
	merged := make([]string, 0, len(base)+len(extra))
	for _, pair := range base {
		name, _, ok := strings.Cut(pair, "=")
		if !ok {
			continue
		}
		if _, shadowed := extra[name]; shadowed {
			continue
		}
		merged = append(merged, pair)
	}

	names := make([]string, 0, len(extra))
	for name := range extra {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		merged = append(merged, name+"="+extra[name])
	}
	return merged
}

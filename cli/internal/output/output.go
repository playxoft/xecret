// Package output renders CLI results for humans and for machines.
//
// One rule overrides every nicety here: a secret value is never passed to this
// package except by the two commands whose stated purpose is producing one
// (`secrets get --plain` and `pull`), and those write it to stdout themselves,
// raw, without passing through any formatting helper that might also log.
// Everything in this package deals in names, slugs, counts and timestamps.
package output

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
)

// Printer knows where human output and machine output go.
//
// Human-readable text goes to Err (stderr) when it is commentary — progress,
// warnings, hints — and to Out (stdout) when it is the result the user asked
// for. That split is what makes `xecret projects --json | jq` work while the
// human messages stay visible on the terminal.
type Printer struct {
	Out io.Writer
	Err io.Writer
	// JSON switches result rendering from tables to one JSON document.
	JSON  bool
	color bool
}

// New builds a Printer for the process's real streams.
//
// Colour is on only when stdout is a terminal, NO_COLOR is unset (the
// informal standard at no-color.org), and TERM is not "dumb".
func New(jsonMode bool) *Printer {
	return &Printer{
		Out:   os.Stdout,
		Err:   os.Stderr,
		JSON:  jsonMode,
		color: stdoutIsTerminal() && os.Getenv("NO_COLOR") == "" && os.Getenv("TERM") != "dumb",
	}
}

func stdoutIsTerminal() bool {
	info, err := os.Stdout.Stat()
	if err != nil {
		return false
	}
	return info.Mode()&os.ModeCharDevice != 0
}

// StdoutIsTerminal reports whether stdout is a terminal. Exposed for commands
// that change behaviour on where their output lands — the pull warning.
func StdoutIsTerminal() bool { return stdoutIsTerminal() }

// StdinIsTerminal reports whether stdin is a terminal — whether there is a
// person there to answer a prompt.
//
// Deliberately separate from StdoutIsTerminal: the two streams are redirected
// independently, and a confirmation is only answerable if the stream it is
// *read* from is a terminal. Testing stdout instead would refuse to prompt
// under `xecret projects delete web > log` with a user sitting right there,
// and would accept a piped line as consent under `echo web | xecret …`.
func StdinIsTerminal() bool {
	info, err := os.Stdin.Stat()
	if err != nil {
		return false
	}
	return info.Mode()&os.ModeCharDevice != 0
}

const (
	ansiReset = "\x1b[0m"
	ansiBold  = "\x1b[1m"
	ansiDim   = "\x1b[2m"
	ansiRed   = "\x1b[31m"
	ansiGreen = "\x1b[32m"
	ansiAmber = "\x1b[33m"
)

func (p *Printer) paint(code, text string) string {
	if !p.color {
		return text
	}
	return code + text + ansiReset
}

// Successf prints a confirmation to stderr — commentary, not a result.
func (p *Printer) Successf(format string, args ...any) {
	fmt.Fprintf(p.Err, "%s %s\n", p.paint(ansiGreen, "✓"), fmt.Sprintf(format, args...))
}

// Warnf prints a warning to stderr.
func (p *Printer) Warnf(format string, args ...any) {
	fmt.Fprintf(p.Err, "%s %s\n", p.paint(ansiAmber, "!"), fmt.Sprintf(format, args...))
}

// Infof prints progress commentary to stderr.
func (p *Printer) Infof(format string, args ...any) {
	fmt.Fprintf(p.Err, "%s\n", fmt.Sprintf(format, args...))
}

// Errorf prints a failure to stderr.
func (p *Printer) Errorf(format string, args ...any) {
	fmt.Fprintf(p.Err, "%s %s\n", p.paint(ansiRed, "✗"), fmt.Sprintf(format, args...))
}

// WriteJSON renders v to stdout as indented JSON. The machine result path.
func (p *Printer) WriteJSON(v any) error {
	encoder := json.NewEncoder(p.Out)
	encoder.SetIndent("", "  ")
	encoder.SetEscapeHTML(false)
	return encoder.Encode(v)
}

// Table renders rows in aligned columns to stdout. Headers are upper-cased and
// dimmed; alignment is plain spaces so the output survives a pipe.
func (p *Printer) Table(headers []string, rows [][]string) {
	widths := make([]int, len(headers))
	for i, h := range headers {
		widths[i] = len(h)
	}
	for _, row := range rows {
		for i, cell := range row {
			if i < len(widths) && len(cell) > widths[i] {
				widths[i] = len(cell)
			}
		}
	}

	var b strings.Builder
	for i, h := range headers {
		pad(&b, strings.ToUpper(h), widths[i], i == len(headers)-1)
	}
	fmt.Fprintln(p.Out, p.paint(ansiDim, strings.TrimRight(b.String(), " ")))

	for _, row := range rows {
		b.Reset()
		for i, cell := range row {
			if i < len(widths) {
				pad(&b, cell, widths[i], i == len(row)-1)
			}
		}
		fmt.Fprintln(p.Out, strings.TrimRight(b.String(), " "))
	}
}

func pad(b *strings.Builder, text string, width int, last bool) {
	b.WriteString(text)
	if !last {
		for i := len(text); i < width+2; i++ {
			b.WriteByte(' ')
		}
	}
}

// Bold returns text emboldened when colour is on.
func (p *Printer) Bold(text string) string { return p.paint(ansiBold, text) }

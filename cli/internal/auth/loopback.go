package auth

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// ErrDenied is returned when the person at the browser clicked Deny.
var ErrDenied = errors.New("access was denied on the consent screen")

// Listener is the loopback server waiting for the consent screen's redirect.
type Listener struct {
	listener net.Listener
	state    string
	results  chan callbackResult
	server   *http.Server
}

type callbackResult struct {
	code string
	err  error
}

// Listen binds an ephemeral port on 127.0.0.1 — loopback only, never
// 0.0.0.0: nothing off this machine has any business reaching the callback.
func Listen(state string) (*Listener, error) {
	tcp, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("could not open a local port for the login callback: %w", err)
	}

	l := &Listener{
		listener: tcp,
		state:    state,
		// Buffered so the HTTP handler can deliver without waiting on the
		// receiver, whatever order the two run in.
		results: make(chan callbackResult, 1),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/callback", l.handleCallback)
	l.server = &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}

	go func() { _ = l.server.Serve(tcp) }()

	return l, nil
}

// Port is what the consent screen needs to build the redirect.
func (l *Listener) Port() int {
	return l.listener.Addr().(*net.TCPAddr).Port
}

// Close tears the listener down. Safe to call more than once.
func (l *Listener) Close() {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = l.server.Shutdown(ctx)
}

// Wait blocks until the browser delivers an outcome or ctx expires.
func (l *Listener) Wait(ctx context.Context) (string, error) {
	select {
	case <-ctx.Done():
		return "", errors.New(
			"timed out waiting for approval in the browser — run 'xecret login' to try again",
		)
	case result := <-l.results:
		return result.code, result.err
	}
}

func (l *Listener) handleCallback(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()

	// A callback carrying the wrong state was not produced by this login. It
	// is answered and ignored — the flow keeps waiting for the real one, so a
	// stray or malicious local request cannot cancel a login it did not start.
	if subtle.ConstantTimeCompare([]byte(query.Get("state")), []byte(l.state)) != 1 {
		http.Error(w, "This response does not belong to the current login attempt.", http.StatusBadRequest)
		return
	}

	if query.Get("error") != "" {
		respondPage(w, "Access denied", "You can close this tab. Nothing was authorized.")
		l.deliver(callbackResult{err: ErrDenied})
		return
	}

	code := query.Get("code")
	if code == "" {
		http.Error(w, "The callback is missing its code.", http.StatusBadRequest)
		return
	}

	respondPage(w, "You're signed in", "Return to your terminal — you can close this tab.")
	l.deliver(callbackResult{code: code})
}

func (l *Listener) deliver(result callbackResult) {
	select {
	case l.results <- result:
	default:
		// A second valid callback after the first: nothing to do with it.
	}
}

func respondPage(w http.ResponseWriter, title, body string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	// Static text only — nothing request-derived is interpolated, so the page
	// cannot be used to reflect content.
	fmt.Fprintf(w, `<!doctype html>
<html><head><meta charset="utf-8"><title>xecret</title>
<style>
  body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0b0d10;color:#e6e8eb}
  main{text-align:center;padding:2rem}
  h1{font-size:1.25rem;margin:0 0 .5rem}
  p{color:#9aa3ad;margin:0}
</style></head>
<body><main><h1>%s</h1><p>%s</p></main></body></html>`, title, body)
}

// AuthorizeURL builds the consent-screen address the browser opens.
func AuthorizeURL(base, challenge, device, state string, port int) string {
	values := url.Values{
		"challenge": {challenge},
		"port":      {fmt.Sprint(port)},
		"device":    {device},
		"state":     {state},
	}
	return strings.TrimRight(base, "/") + "/cli/authorize?" + values.Encode()
}

// OpenBrowser makes a best-effort attempt to open url in the default browser.
// Failure is not an error worth stopping for — the URL is printed either way.
func OpenBrowser(url string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", url).Start()
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	default:
		return exec.Command("xdg-open", url).Start()
	}
}

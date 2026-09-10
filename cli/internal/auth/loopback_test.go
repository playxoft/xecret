package auth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

func callbackGet(t *testing.T, port int, query string) *http.Response {
	t.Helper()
	response, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/callback?%s", port, query))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { response.Body.Close() })
	return response
}

func TestCallbackDeliversTheCode(t *testing.T) {
	listener, err := Listen("expected-state")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	response := callbackGet(t, listener.Port(), "state=expected-state&code=xac_live_abc")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("callback answered %d", response.StatusCode)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	callback, err := listener.Wait(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if callback.Code != "xac_live_abc" {
		t.Errorf("delivered code %q", callback.Code)
	}
	if callback.Handoff != "" {
		t.Errorf("invented a hand-off nobody sent: %q", callback.Handoff)
	}
}

// TestWrongStateIsIgnoredNotFatal: a stray or hostile local request must
// neither complete nor cancel the login — the flow keeps waiting for the
// response that carries the state this process generated.
func TestWrongStateIsIgnoredNotFatal(t *testing.T) {
	listener, err := Listen("expected-state")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	response := callbackGet(t, listener.Port(), "state=attacker-guess&code=stolen")
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("wrong state answered %d, want 400", response.StatusCode)
	}

	// The real callback still works afterwards.
	callbackGet(t, listener.Port(), "state=expected-state&code=real-code")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	callback, err := listener.Wait(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if callback.Code != "real-code" {
		t.Errorf("the wrong-state request influenced the outcome: %q", callback.Code)
	}
}

// TestHandoffRidesTheCallback: the sealed User Key arrives on the same redirect
// as the code (spec 13.2), as a query parameter rather than a fragment — a
// fragment is never transmitted, which is exactly why one would be useless
// against an HTTP listener.
func TestHandoffRidesTheCallback(t *testing.T) {
	listener, err := Listen("expected-state")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	const wrap = "xk2.x25519.QUJDREVGRw"
	callbackGet(t, listener.Port(), "state=expected-state&code=xac_live_abc&handoff="+wrap)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	callback, err := listener.Wait(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if callback.Handoff != wrap {
		t.Errorf("hand-off = %q, want %q", callback.Handoff, wrap)
	}
}

// TestAuthorizeURLOmitsAnAbsentHandoff: a CLI that does not ask for one gets the
// flow it always had, and the consent screen must not see an empty parameter and
// try to seal to it.
func TestAuthorizeURLOmitsAnAbsentHandoff(t *testing.T) {
	with := AuthorizeURL("https://xecret.dev/", "challenge", "laptop", "state", 52310, "PUBKEY")
	if !strings.Contains(with, "handoff=PUBKEY") {
		t.Errorf("hand-off key missing from %q", with)
	}

	without := AuthorizeURL("https://xecret.dev/", "challenge", "laptop", "state", 52310, "")
	if strings.Contains(without, "handoff") {
		t.Errorf("empty hand-off reached the URL: %q", without)
	}
	if !strings.Contains(without, "challenge=challenge") || !strings.Contains(without, "port=52310") {
		t.Errorf("the rest of the request did not survive: %q", without)
	}
}

func TestDenialIsReported(t *testing.T) {
	listener, err := Listen("expected-state")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	callbackGet(t, listener.Port(), "state=expected-state&error=access_denied")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := listener.Wait(ctx); !errors.Is(err, ErrDenied) {
		t.Fatalf("want ErrDenied, got %v", err)
	}
}

func TestWaitTimesOut(t *testing.T) {
	listener, err := Listen("expected-state")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := listener.Wait(ctx); err == nil {
		t.Fatal("an abandoned login must time out, not hang forever")
	}
}

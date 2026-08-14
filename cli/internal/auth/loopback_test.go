package auth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
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
	code, err := listener.Wait(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if code != "xac_live_abc" {
		t.Errorf("delivered code %q", code)
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
	code, err := listener.Wait(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if code != "real-code" {
		t.Errorf("the wrong-state request influenced the outcome: %q", code)
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

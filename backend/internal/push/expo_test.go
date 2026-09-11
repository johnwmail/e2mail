package push

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestExpoSenderPostsTokens(t *testing.T) {
	var gotBody []byte
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotBody, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer srv.Close()

	s := NewExpoSender("test-token")
	s.URL = srv.URL
	err := s.Send([]Message{
		{To: "ExponentPushToken[aaa]", Title: "t", Body: "b"},
		{To: "native-fcm-token", Title: "skip"},
	})
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if gotAuth != "Bearer test-token" {
		t.Fatalf("auth %q", gotAuth)
	}
	var msgs []Message
	if err := json.Unmarshal(gotBody, &msgs); err != nil {
		t.Fatalf("body: %v %s", err, gotBody)
	}
	if len(msgs) != 1 || msgs[0].To != "ExponentPushToken[aaa]" {
		t.Fatalf("msgs %+v", msgs)
	}
}

func TestExpoSenderEmptyAndSkip(t *testing.T) {
	s := NewExpoSender("")
	if err := s.Send(nil); err != nil {
		t.Fatal(err)
	}
	if err := s.Send([]Message{{To: "not-expo"}}); err != nil {
		t.Fatal(err)
	}
}

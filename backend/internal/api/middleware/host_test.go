package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHostAllowlistEmptyPassesThrough(t *testing.T) {
	h := HostAllowlist(nil)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Host = "anything.example.com"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusTeapot {
		t.Fatalf("empty allowlist should pass through, got %d", rec.Code)
	}
}

func TestHostAllowlist(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	h := HostAllowlist([]string{"mail.example.com", "https://Alt.Example.com:443"})(next)

	cases := []struct {
		host string
		want int
	}{
		{"mail.example.com", http.StatusOK},
		{"MAIL.example.com:8080", http.StatusOK}, // 大小寫 + port
		{"mail.example.com.", http.StatusOK},     // 結尾點
		{"alt.example.com", http.StatusOK},       // origin 形式 + port
		{"evil.example.com", http.StatusMisdirectedRequest},
		{"mail.example.com.evil.com", http.StatusMisdirectedRequest},
		{"", http.StatusMisdirectedRequest},
	}
	for _, tc := range cases {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Host = tc.host
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != tc.want {
			t.Errorf("Host %q => %d, want %d", tc.host, rec.Code, tc.want)
		}
	}
}

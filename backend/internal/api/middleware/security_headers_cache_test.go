package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSecurityHeadersAPIResponsesAreNotCached(t *testing.T) {
	h := SecurityHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/mail/messages", nil))
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control on /api = %q, want no-store", got)
	}
}

func TestSecurityHeadersStaticAssetsKeepDefaultCaching(t *testing.T) {
	h := SecurityHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/assets/index.js", nil))
	if got := rec.Header().Get("Cache-Control"); got != "" {
		t.Fatalf("Cache-Control on static asset = %q, want unset", got)
	}
}

func TestSecurityHeadersSetsHSTS(t *testing.T) {
	h := SecurityHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if got := rec.Header().Get("Strict-Transport-Security"); got != "max-age=31536000" {
		t.Fatalf("Strict-Transport-Security = %q, want max-age=31536000", got)
	}
}

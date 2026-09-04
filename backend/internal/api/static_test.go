package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestStaticHandlerSetsContentSecurityPolicy(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()

	staticHandler().ServeHTTP(rec, req)

	csp := rec.Header().Get("Content-Security-Policy")
	for _, directive := range []string{
		"default-src 'self'",
		"object-src 'none'",
		"frame-ancestors 'self'",
		"script-src 'self'",
		"connect-src 'self'",
	} {
		if !strings.Contains(csp, directive) {
			t.Errorf("CSP %q does not contain %q", csp, directive)
		}
	}
}

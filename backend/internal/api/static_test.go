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

func TestStaticHandlerRejectsSecretAndTraversalPaths(t *testing.T) {
	for _, p := range []string{
		"/.env",
		"/.git/config",
		"/root/.ssh/key",
		"/../../../../root/.ssh/key",
		"/%2e%2e/%2e%2e/root/.ssh/key",
		"/wp-login.php",
		"/backup.sql",
	} {
		req := httptest.NewRequest(http.MethodGet, p, nil)
		rec := httptest.NewRecorder()
		staticHandler().ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Errorf("GET %s status = %d, want 404", p, rec.Code)
		}
	}
}

func TestIsSPARoute(t *testing.T) {
	yes := []string{"settings", "mail/inbox", "threads"}
	for _, p := range yes {
		if !isSPARoute(p) {
			t.Errorf("isSPARoute(%q) = false, want true", p)
		}
	}
	no := []string{".env", ".git/config", "root/.ssh/key", "wp-login.php", "x.key", "robots.txt", "assets/index.js"}
	for _, p := range no {
		if isSPARoute(p) {
			t.Errorf("isSPARoute(%q) = true, want false", p)
		}
	}
}

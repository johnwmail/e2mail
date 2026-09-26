package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestIPRateLimiterScopesAndSeparatesClients(t *testing.T) {
	limiter := NewIPRateLimiter()
	now := time.Now()
	for i := 0; i < 2; i++ {
		if ok, _ := limiter.allow("api", "192.0.2.1", 2, time.Minute, now); !ok {
			t.Fatalf("request %d unexpectedly rejected", i+1)
		}
	}
	if ok, retry := limiter.allow("api", "192.0.2.1", 2, time.Minute, now); ok || retry <= 0 {
		t.Fatalf("third request = (%v, %v), want rejection with retry delay", ok, retry)
	}
	if ok, _ := limiter.allow("mail", "192.0.2.1", 2, time.Minute, now); !ok {
		t.Fatal("different scope should have a separate limit")
	}
	if ok, _ := limiter.allow("api", "192.0.2.2", 2, time.Minute, now); !ok {
		t.Fatal("different client should have a separate limit")
	}
}

func TestIPRateLimiterMiddlewareReturns429AndRetryAfter(t *testing.T) {
	limiter := NewIPRateLimiter()
	h := limiter.Middleware("login", 1, time.Minute)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	for i, want := range []int{http.StatusNoContent, http.StatusTooManyRequests} {
		req := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
		req.RemoteAddr = "192.0.2.10:12345"
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Fatalf("request %d status = %d, want %d", i+1, rec.Code, want)
		}
		if i == 1 && rec.Header().Get("Retry-After") == "" {
			t.Fatal("rate limited response missing Retry-After")
		}
	}
}

func TestIPRateLimiterDoesNotTrustForwardedIPFromDirectPeer(t *testing.T) {
	limiter := NewIPRateLimiter()
	h := CapturePeerAddr(limiter.Middleware("api", 1, time.Minute)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})))

	for i, forwarded := range []string{"198.51.100.1", "198.51.100.2"} {
		req := httptest.NewRequest(http.MethodGet, "/api/server-config", nil)
		req.RemoteAddr = "203.0.113.7:12345"
		req.Header.Set("X-Forwarded-For", forwarded)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		want := http.StatusNoContent
		if i == 1 {
			want = http.StatusTooManyRequests
		}
		if rec.Code != want {
			t.Fatalf("request %d status = %d, want %d", i+1, rec.Code, want)
		}
	}
}

func TestIPRateLimiterUsesForwardedIPFromLoopbackProxy(t *testing.T) {
	limiter := NewIPRateLimiter()
	h := CapturePeerAddr(limiter.Middleware("api", 1, time.Minute)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})))

	for _, forwarded := range []string{"192.0.2.1", "192.0.2.2"} {
		req := httptest.NewRequest(http.MethodGet, "/api/server-config", nil)
		req.RemoteAddr = "127.0.0.1:8080"
		req.Header.Set("X-Forwarded-For", forwarded)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("forwarded client %s status = %d, want %d", forwarded, rec.Code, http.StatusNoContent)
		}
	}
}

func TestIPRateLimiterWindowExpires(t *testing.T) {
	limiter := NewIPRateLimiter()
	now := time.Now()
	if ok, _ := limiter.allow("api", "192.0.2.1", 1, time.Minute, now); !ok {
		t.Fatal("first request unexpectedly rejected")
	}
	if ok, _ := limiter.allow("api", "192.0.2.1", 1, time.Minute, now.Add(time.Minute)); !ok {
		t.Fatal("request in a new window should be allowed")
	}
}

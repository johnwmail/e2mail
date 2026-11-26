package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	chimiddleware "github.com/go-chi/chi/v5/middleware"
)

// TestClientIPIgnoresSpoofedForwardedForBehindRealIP 模擬 router.go 實際中介層順序
// （CapturePeerAddr → chi RealIP）。RealIP 會把 RemoteAddr 改寫成 XFF，但
// ClientIP 必須仍然返回 socket peer，否則登入／2FA 限流 key 可被偽造繞過。
func TestClientIPIgnoresSpoofedForwardedForBehindRealIP(t *testing.T) {
	var got string
	h := CapturePeerAddr(chimiddleware.RealIP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = ClientIP(r)
	})))

	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
	req.RemoteAddr = "198.51.100.7:50000" // 真實 socket peer（非 loopback）
	req.Header.Set("X-Forwarded-For", "10.0.0.1")
	req.Header.Set("X-Real-IP", "10.0.0.2")

	h.ServeHTTP(httptest.NewRecorder(), req)

	if got != "198.51.100.7" {
		t.Fatalf("ClientIP = %q, want socket peer 198.51.100.7 (spoofed headers must be ignored)", got)
	}
}

// TestClientIPTrustsForwardedForFromLoopbackProxy 同機反向代理（loopback peer）
// 仍然可以透過 X-Forwarded-For 取得真實用戶 IP。
func TestClientIPTrustsForwardedForFromLoopbackProxy(t *testing.T) {
	var got string
	h := CapturePeerAddr(chimiddleware.RealIP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = ClientIP(r)
	})))

	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
	req.RemoteAddr = "127.0.0.1:50000"
	req.Header.Set("X-Forwarded-For", "203.0.113.9")

	h.ServeHTTP(httptest.NewRecorder(), req)

	if got != "203.0.113.9" {
		t.Fatalf("ClientIP = %q, want forwarded client 203.0.113.9 from loopback proxy", got)
	}
}

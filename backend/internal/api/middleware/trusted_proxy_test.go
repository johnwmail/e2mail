package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func withTrustedProxies(t *testing.T, entries ...string) {
	t.Helper()
	nets, invalid := ParseTrustedProxies(entries)
	if len(invalid) != 0 {
		t.Fatalf("unexpected invalid entries: %v", invalid)
	}
	SetTrustedProxies(nets)
	t.Cleanup(func() { SetTrustedProxies(nil) })
}

func clientIPFor(t *testing.T, peer, xff string) string {
	t.Helper()
	var got string
	h := CapturePeerAddr(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = ClientIP(r)
	}))
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
	req.RemoteAddr = peer
	if xff != "" {
		req.Header.Set("X-Forwarded-For", xff)
	}
	h.ServeHTTP(httptest.NewRecorder(), req)
	return got
}

// Docker bridge 網關（非 loopback）配置為可信代理後，應採信 XFF。
func TestTrustedCIDRProxyHonorsForwardedFor(t *testing.T) {
	withTrustedProxies(t, "172.17.0.1")
	if got := clientIPFor(t, "172.17.0.1:50000", "203.0.113.5"); got != "203.0.113.5" {
		t.Fatalf("ClientIP = %q, want 203.0.113.5", got)
	}
}

// 未配置為可信嘅非 loopback peer，即使有 XFF 都要忽略。
func TestUntrustedPeerIgnoresForwardedFor(t *testing.T) {
	withTrustedProxies(t, "172.17.0.1")
	if got := clientIPFor(t, "198.51.100.9:50000", "203.0.113.5"); got != "198.51.100.9" {
		t.Fatalf("ClientIP = %q, want socket peer 198.51.100.9", got)
	}
}

// 多層代理鏈：由右至左跳過可信代理，取第一個非可信 IP；左邊偽造值無效。
func TestTrustedProxyChainSkipsTrustedHops(t *testing.T) {
	withTrustedProxies(t, "172.17.0.0/16")
	got := clientIPFor(t, "172.17.0.1:50000", "10.10.10.10, 203.0.113.5, 172.17.0.9")
	if got != "203.0.113.5" {
		t.Fatalf("ClientIP = %q, want 203.0.113.5", got)
	}
}

// 無效 XFF 項目 fail closed：退回 socket peer。
func TestTrustedProxyInvalidXFFFallsBackToPeer(t *testing.T) {
	withTrustedProxies(t, "172.17.0.1")
	if got := clientIPFor(t, "172.17.0.1:50000", "203.0.113.5, garbage"); got != "172.17.0.1" {
		t.Fatalf("ClientIP = %q, want peer 172.17.0.1", got)
	}
}

func TestParseTrustedProxiesReportsInvalid(t *testing.T) {
	nets, invalid := ParseTrustedProxies([]string{"10.0.0.0/8", "not-an-ip", "2001:db8::1", "", "10.1.2.3/99"})
	if len(nets) != 2 {
		t.Fatalf("valid nets = %d, want 2", len(nets))
	}
	if len(invalid) != 2 || invalid[0] != "not-an-ip" || invalid[1] != "10.1.2.3/99" {
		t.Fatalf("invalid = %v", invalid)
	}
}

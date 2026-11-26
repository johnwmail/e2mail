package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// nginx 預設 proxy_add_x_forwarded_for 會將真實 client 附加到尾部：
// 客戶端自帶 "spoof" → XFF 變成 "spoof, real"。必須取最右邊嘅 real，
// 否則所有用戶都會退回共用 loopback key（全站被鎖死）。
func TestClientIPUsesRightmostForwardedForFromLoopbackProxy(t *testing.T) {
	cases := map[string]string{
		"198.51.100.7":             "198.51.100.7",
		"192.0.2.1, 198.51.100.7":  "198.51.100.7",
		"10.9.9.9,  198.51.100.7 ": "198.51.100.7",
		"":                         "127.0.0.1",
		"not-an-ip":                "127.0.0.1",
		"198.51.100.7, not-an-ip":  "127.0.0.1",
	}
	for xff, want := range cases {
		var got string
		h := CapturePeerAddr(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			got = ClientIP(r)
		}))
		req := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
		req.RemoteAddr = "127.0.0.1:50000"
		if xff != "" {
			req.Header.Set("X-Forwarded-For", xff)
		}
		h.ServeHTTP(httptest.NewRecorder(), req)
		if got != want {
			t.Errorf("XFF %q: ClientIP = %q, want %q", xff, got, want)
		}
	}
}

// 非 loopback peer 時，任何 XFF 都唔可以影響 client IP。
func TestClientIPIgnoresForwardedForFromNonLoopbackPeerMultiValue(t *testing.T) {
	var got string
	h := CapturePeerAddr(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = ClientIP(r)
	}))
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
	req.RemoteAddr = "198.51.100.200:50000"
	req.Header.Set("X-Forwarded-For", "192.0.2.1, 203.0.113.9")
	h.ServeHTTP(httptest.NewRecorder(), req)
	if got != "198.51.100.200" {
		t.Fatalf("ClientIP = %q, want socket peer 198.51.100.200", got)
	}
}

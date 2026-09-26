package middleware

import (
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
)

// HostAllowlist 只回應清單內嘅 Host（忽略大小寫同 port；可填 host 或完整 origin）。
// 空清單 = 不限制（保持舊行為）。唔存在嘅 Host 一律回 421 Misdirected Request，
// 令掃描器／錯配 DNS 唔會攞到 SPA。
//
// 只睇 r.Host（唔信 X-Forwarded-Host，避免被客戶端偽造繞過）。反向代理
// (relayd/nginx) 要保留原本 Host header 傳去 backend。
func HostAllowlist(allowed []string) func(http.Handler) http.Handler {
	set := make(map[string]struct{}, len(allowed))
	for _, h := range allowed {
		if n := normalizeHost(h); n != "" {
			set[n] = struct{}{}
		}
	}
	if len(set) == 0 {
		return func(next http.Handler) http.Handler { return next }
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			host := normalizeHost(r.Host)
			if host == "" {
				rejectHost(w, r)
				return
			}
			if _, ok := set[host]; !ok {
				rejectHost(w, r)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// normalizeHost 抽出純 hostname：去除 scheme、port、結尾點，轉小寫。
func normalizeHost(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if strings.Contains(raw, "://") {
		if u, err := url.Parse(raw); err == nil && u.Host != "" {
			raw = u.Host
		}
	}
	raw = strings.ToLower(raw)
	if h, _, err := net.SplitHostPort(raw); err == nil {
		raw = h
	}
	raw = strings.Trim(raw, "[]")
	return strings.TrimSuffix(raw, ".")
}

func rejectHost(w http.ResponseWriter, r *http.Request) {
	log.Printf("[HOST] rejected Host=%q path=%q remote=%s", r.Host, r.URL.Path, r.RemoteAddr)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusMisdirectedRequest) // 421
	_, _ = w.Write([]byte("421 Misdirected Request\n"))
}

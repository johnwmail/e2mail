package middleware

import (
	"context"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/johnwmail/e2mail/backend/pkg/response"
)

const maxRateLimitKeys = 10_000

type peerAddrContextKey struct{}

type requestWindow struct {
	started  time.Time
	lastSeen time.Time
	count    int
}

// IPRateLimiter applies bounded, in-memory fixed-window limits per source IP.
// It is intended for the single-instance deployment; multi-instance deployments
// should enforce shared limits at a trusted edge or shared store.
type IPRateLimiter struct {
	mu        sync.Mutex
	entries   map[string]requestWindow
	lastSweep time.Time
}

func NewIPRateLimiter() *IPRateLimiter {
	return &IPRateLimiter{entries: make(map[string]requestWindow)}
}

// CapturePeerAddr preserves the socket peer before middleware.RealIP rewrites
// RemoteAddr from forwarding headers. Rate limits only trust X-Forwarded-For
// when that peer is loopback (the documented same-host relayd/nginx setup).
func CapturePeerAddr(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		peer := parseRemoteIP(r.RemoteAddr)
		ctx := context.WithValue(r.Context(), peerAddrContextKey{}, peer)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// Middleware limits requests by scope and source IP. Each scope has its own
// counter, so a limit for a costly endpoint does not consume the general API
// allowance.
func (l *IPRateLimiter) Middleware(scope string, maxRequests int, window time.Duration) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			allowed, retryAfter := l.allow(scope, ClientIP(r), maxRequests, window, time.Now())
			if !allowed {
				seconds := int(retryAfter.Round(time.Second).Seconds())
				if seconds < 1 {
					seconds = 1
				}
				w.Header().Set("Retry-After", strconv.Itoa(seconds))
				response.Error(w, http.StatusTooManyRequests, "too many requests; try again later")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func (l *IPRateLimiter) allow(scope, ip string, maxRequests int, window time.Duration, now time.Time) (bool, time.Duration) {
	if maxRequests <= 0 || window <= 0 {
		return true, 0
	}
	key := scope + "\x00" + ip

	l.mu.Lock()
	defer l.mu.Unlock()

	if now.Sub(l.lastSweep) >= time.Minute {
		for existingKey, entry := range l.entries {
			if now.Sub(entry.lastSeen) > 10*time.Minute {
				delete(l.entries, existingKey)
			}
		}
		l.lastSweep = now
	}

	entry, exists := l.entries[key]
	if !exists {
		if len(l.entries) >= maxRateLimitKeys {
			return false, time.Minute
		}
		entry = requestWindow{started: now, lastSeen: now}
	} else if now.Sub(entry.started) >= window {
		entry = requestWindow{started: now, lastSeen: now}
	}
	entry.lastSeen = now
	entry.count++
	l.entries[key] = entry
	if entry.count > maxRequests {
		return false, entry.started.Add(window).Sub(now)
	}
	return true, 0
}

// ClientIP 回傳可信任嘅來源 IP。唔可以直接用 r.RemoteAddr：chi RealIP 會按
// X-Forwarded-For 改寫佢，等於客戶端可自行偽造。只有 socket peer 係 loopback
// （同機反向代理）先會採信 X-Forwarded-For。所有安全相關 key（限流、鎖定）都應用此函式。
func ClientIP(r *http.Request) string {
	peer, _ := r.Context().Value(peerAddrContextKey{}).(string)
	if peer == "" {
		peer = parseRemoteIP(r.RemoteAddr)
	}
	if parsed := net.ParseIP(peer); parsed != nil && isTrustedProxy(parsed) {
		if ip := forwardedClientIP(r.Header.Get("X-Forwarded-For")); ip != "" {
			return ip
		}
	}
	return peer
}

// forwardedClientIP 由右至左掃描 X-Forwarded-For，跳過可信代理，回傳第一個非可信 IP。
// nginx 預設 proxy_add_x_forwarded_for 會將真實 client IP 附加喺尾部，左邊嘅值係客戶端
// 可以偽造嘅，所以唔可以取第一個值。遇到無效項目時回傳 ""（退回 socket peer，fail closed）。
func forwardedClientIP(xff string) string {
	parts := strings.Split(xff, ",")
	leftmostTrusted := ""
	for i := len(parts) - 1; i >= 0; i-- {
		ip := net.ParseIP(strings.TrimSpace(parts[i]))
		if ip == nil {
			return ""
		}
		if !isTrustedProxy(ip) {
			return ip.String()
		}
		leftmostTrusted = ip.String()
	}
	return leftmostTrusted
}

// trustedProxies 保存 TRUSTED_PROXY_CIDRS 解析結果（啟動時設定一次；預設空＝只信任 loopback）。
var trustedProxies atomic.Pointer[[]*net.IPNet]

// ParseTrustedProxies 解析逗號分隔嘅 IP 或 CIDR（例如 "172.17.0.1, 10.0.0.0/8"）。
// 回傳有效網段，以及無效項目（呼叫者應記錄警告）。
func ParseTrustedProxies(entries []string) (nets []*net.IPNet, invalid []string) {
	for _, raw := range entries {
		entry := strings.TrimSpace(raw)
		if entry == "" {
			continue
		}
		if strings.Contains(entry, "/") {
			if _, n, err := net.ParseCIDR(entry); err == nil {
				nets = append(nets, n)
				continue
			}
		} else if ip := net.ParseIP(entry); ip != nil {
			bits := 8 * net.IPv4len
			if ip.To4() == nil {
				bits = 8 * net.IPv6len
			}
			nets = append(nets, &net.IPNet{IP: ip, Mask: net.CIDRMask(bits, bits)})
			continue
		}
		invalid = append(invalid, entry)
	}
	return nets, invalid
}

// SetTrustedProxies 設定可信反向代理網段（只會影響 X-Forwarded-For 採信）。
// loopback 永遠可信；本函式只係新增額外網段。
func SetTrustedProxies(nets []*net.IPNet) {
	trustedProxies.Store(&nets)
}

// isTrustedProxy 判斷 peer 係咪可信代理：loopback，或 TRUSTED_PROXY_CIDRS 內嘅網段。
func isTrustedProxy(ip net.IP) bool {
	if ip.IsLoopback() {
		return true
	}
	list := trustedProxies.Load()
	if list == nil {
		return false
	}
	for _, n := range *list {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

func parseRemoteIP(remote string) string {
	remote = strings.TrimSpace(remote)
	if host, _, err := net.SplitHostPort(remote); err == nil {
		return host
	}
	return strings.Trim(remote, "[]")
}

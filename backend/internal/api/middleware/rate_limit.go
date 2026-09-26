package middleware

import (
	"context"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
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
			allowed, retryAfter := l.allow(scope, clientIP(r), maxRequests, window, time.Now())
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

func clientIP(r *http.Request) string {
	peer, _ := r.Context().Value(peerAddrContextKey{}).(string)
	if peer == "" {
		peer = parseRemoteIP(r.RemoteAddr)
	}
	if parsed := net.ParseIP(peer); parsed != nil && parsed.IsLoopback() {
		forwarded := strings.TrimSpace(r.Header.Get("X-Forwarded-For"))
		if ip := net.ParseIP(forwarded); ip != nil {
			return ip.String()
		}
	}
	return peer
}

func parseRemoteIP(remote string) string {
	remote = strings.TrimSpace(remote)
	if host, _, err := net.SplitHostPort(remote); err == nil {
		return host
	}
	return strings.Trim(remote, "[]")
}

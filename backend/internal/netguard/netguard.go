// Package netguard blocks outbound connections to private, loopback and
// link-local addresses. e2Mail dials IMAP/SMTP/Sieve hosts supplied by the
// user, so without a guard an authenticated user could use the server as an
// SSRF proxy (internal port scanning, cloud metadata, LAN services, …).
package netguard

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

const dialTimeout = 30 * time.Second

// blockedPrefixes are never dialled unless the host is explicitly allow-listed.
var blockedPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"), // CGNAT
	netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("169.254.0.0/16"), // link-local + cloud metadata
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("224.0.0.0/4"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("::/128"),
	netip.MustParsePrefix("::1/128"),
	netip.MustParsePrefix("fc00::/7"),
	netip.MustParsePrefix("fe80::/10"),
	netip.MustParsePrefix("ff00::/8"),
}

// Policy controls outbound destination checks. allowPrivate is only used by
// tests that run fake mail servers on loopback; production always passes false.
type Policy struct {
	allowPrivate bool
}

// NewPolicy builds a policy. Private/loopback/link-local destinations are
// rejected unless allowPrivate is true (tests only).
func NewPolicy(allowPrivate bool) *Policy {
	return &Policy{allowPrivate: allowPrivate}
}

var defaultPolicy atomic.Pointer[Policy]

func init() {
	defaultPolicy.Store(NewPolicy(false))
}

// Default returns the process-wide policy. main() configures it from env.
func Default() *Policy { return defaultPolicy.Load() }

// SetDefault replaces the process-wide policy (nil is ignored).
func SetDefault(p *Policy) {
	if p != nil {
		defaultPolicy.Store(p)
	}
}

// CheckHost rejects private destinations before a connection is attempted.
// Hostnames are resolved; a hostname resolving to any blocked address is
// rejected (rebinding is additionally caught by the dialer's Control hook).
func (p *Policy) CheckHost(ctx context.Context, host string) error {
	host = normalizeHost(host)
	if host == "" {
		return errors.New("outbound host is empty")
	}
	if ip := net.ParseIP(host); ip != nil {
		if p.isBlocked(ip) {
			return blockedError(host)
		}
		return nil
	}

	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return fmt.Errorf("cannot resolve outbound host %q: %w", host, err)
	}
	if len(addrs) == 0 {
		return fmt.Errorf("cannot resolve outbound host %q: no addresses", host)
	}
	for _, addr := range addrs {
		if p.isBlocked(addr.IP) {
			return blockedError(host)
		}
	}
	return nil
}

// DialerFor returns a dialer for host. Non-allow-listed hosts get a Control
// hook that re-checks the address actually being connected to, which closes
// the DNS-rebinding window between CheckHost and the real dial.
func (p *Policy) DialerFor() *net.Dialer {
	d := &net.Dialer{Timeout: dialTimeout}
	if p.allowPrivate {
		return d
	}
	d.Control = p.control
	return d
}

func (p *Policy) control(_, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("netguard: invalid dial address %q: %w", address, err)
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return fmt.Errorf("netguard: unexpected dial address %q", address)
	}
	if p.isBlocked(ip) {
		return blockedError(host)
	}
	return nil
}

func (p *Policy) isBlocked(ip net.IP) bool {
	if p.allowPrivate {
		return false
	}
	addr, ok := netip.AddrFromSlice(ip)
	if !ok {
		return true
	}
	addr = addr.Unmap()
	for _, prefix := range blockedPrefixes {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}

func blockedError(host string) error {
	return fmt.Errorf(
		"outbound connection to %q is blocked (private/loopback/link-local addresses are not allowed)",
		host,
	)
}

func normalizeHost(host string) string {
	host = strings.TrimSpace(strings.ToLower(host))
	host = strings.TrimSuffix(host, ".")
	host = strings.TrimPrefix(host, "[")
	host = strings.TrimSuffix(host, "]")
	return host
}

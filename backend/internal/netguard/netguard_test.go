package netguard

import (
	"context"
	"net"
	"strings"
	"testing"
	"time"
)

func TestIsBlocked(t *testing.T) {
	p := NewPolicy(false, nil)
	blocked := []string{
		"0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254",
		"172.16.0.1", "192.0.0.1", "192.168.1.1", "198.18.0.1", "224.0.0.1",
		"255.255.255.255", "::", "::1", "fc00::1", "fe80::1", "ff02::1",
	}
	for _, raw := range blocked {
		if !p.isBlocked(net.ParseIP(raw)) {
			t.Errorf("isBlocked(%s) = false, want true", raw)
		}
	}

	public := []string{"8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "93.184.216.34"}
	for _, raw := range public {
		if p.isBlocked(net.ParseIP(raw)) {
			t.Errorf("isBlocked(%s) = true, want false", raw)
		}
	}

	allowAll := NewPolicy(true, nil)
	if allowAll.isBlocked(net.ParseIP("127.0.0.1")) {
		t.Error("allowPrivate policy should not block loopback")
	}
}

func TestCheckHostIP(t *testing.T) {
	ctx := context.Background()
	p := NewPolicy(false, nil)

	if err := p.CheckHost(ctx, "127.0.0.1"); err == nil {
		t.Fatal("CheckHost(127.0.0.1) should fail")
	} else if !strings.Contains(err.Error(), "MAIL_ALLOW_PRIVATE_NETWORKS") {
		t.Fatalf("error should explain the override: %v", err)
	}
	if err := p.CheckHost(ctx, "8.8.8.8"); err != nil {
		t.Fatalf("CheckHost(8.8.8.8) = %v", err)
	}
	if err := p.CheckHost(ctx, ""); err == nil {
		t.Fatal("CheckHost(empty) should fail")
	}
}

func TestAllowListBypassesPrivateCheck(t *testing.T) {
	ctx := context.Background()
	p := NewPolicy(false, []string{"LOCALHOST.", "[127.0.0.1]"})

	if err := p.CheckHost(ctx, "localhost"); err != nil {
		t.Fatalf("allow-listed localhost should pass: %v", err)
	}
	if err := p.CheckHost(ctx, "127.0.0.1"); err != nil {
		t.Fatalf("allow-listed 127.0.0.1 should pass: %v", err)
	}
	if err := p.CheckHost(ctx, "127.0.0.2"); err == nil {
		t.Fatal("non-allow-listed loopback should fail")
	}
}

func TestControlRejectsPrivateAddress(t *testing.T) {
	p := NewPolicy(false, nil)
	if err := p.control("tcp", "127.0.0.1:993", nil); err == nil {
		t.Fatal("control should reject loopback")
	}
	if err := p.control("tcp", "8.8.8.8:993", nil); err != nil {
		t.Fatalf("control should allow public address: %v", err)
	}
}

func TestDialerBlocksPrivateAndAllowsAllowListed(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	go func() {
		conn, err := ln.Accept()
		if err == nil {
			_ = conn.Close()
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	blockedDialer := NewPolicy(false, nil).DialerFor("127.0.0.1")
	if _, err := blockedDialer.DialContext(ctx, "tcp", ln.Addr().String()); err == nil {
		t.Fatal("private dial should be blocked")
	}

	allowedDialer := NewPolicy(false, []string{"127.0.0.1"}).DialerFor("127.0.0.1")
	conn, err := allowedDialer.DialContext(ctx, "tcp", ln.Addr().String())
	if err != nil {
		t.Fatalf("allow-listed dial failed: %v", err)
	}
	_ = conn.Close()
}

package imap

import (
	"strings"
	"testing"

	"github.com/johnwmail/e2mail/backend/internal/netguard"
)

func TestNewClientRejectsPrivateHostByDefault(t *testing.T) {
	previous := netguard.Default()
	t.Cleanup(func() { netguard.SetDefault(previous) })
	netguard.SetDefault(netguard.NewPolicy(false, nil))

	_, err := NewClient(ConnectionConfig{
		Host:     "127.0.0.1",
		Port:     993,
		Username: "user",
		Password: "pass",
	})
	if err == nil {
		t.Fatal("NewClient should reject loopback hosts by default")
	}
	if !strings.Contains(err.Error(), "blocked") {
		t.Fatalf("unexpected error: %v", err)
	}
}

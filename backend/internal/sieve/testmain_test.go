package sieve

import (
	"os"
	"testing"

	"github.com/johnwmail/e2mail/backend/internal/netguard"
)

func TestMain(m *testing.M) {
	// Tests use fake Dovecot servers on 127.0.0.1.
	netguard.SetDefault(netguard.NewPolicy(true))
	os.Exit(m.Run())
}

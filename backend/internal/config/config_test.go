package config

import (
	"testing"
)

func TestParseDBBackup(t *testing.T) {
	cases := []struct {
		in     string
		want   DBBackupSchedule
		wantOK bool
	}{
		{"", DBBackupDisable, true},
		{"DISABLE", DBBackupDisable, true},
		{"disable", DBBackupDisable, true},
		{"  Disable  ", DBBackupDisable, true},
		{"DAILY", DBBackupDaily, true},
		{" daily ", DBBackupDaily, true},
		{"WEEKLY", DBBackupWeekly, true},
		{"weekly", DBBackupWeekly, true},
		{"MONTHLY", DBBackupMonthly, true},
		{"monthly", DBBackupMonthly, true},
		{"HOURLY", DBBackupDisable, false},
		{"true", DBBackupDisable, false},
		{"1", DBBackupDisable, false},
		{"YEARLY", DBBackupDisable, false},
	}
	for _, tc := range cases {
		got, ok := ParseDBBackup(tc.in)
		if got != tc.want || ok != tc.wantOK {
			t.Errorf("ParseDBBackup(%q) = (%q, %v), want (%q, %v)", tc.in, got, ok, tc.want, tc.wantOK)
		}
	}
}

func TestLoadDBBackupDefaultDisable(t *testing.T) {
	t.Setenv("DB_BACKUP", "")
	cfg := Load()
	if cfg.DBBackup != DBBackupDisable {
		t.Fatalf("default DBBackup = %q, want DISABLE", cfg.DBBackup)
	}
}

func TestLoadDBBackupSchedules(t *testing.T) {
	t.Run("daily", func(t *testing.T) {
		t.Setenv("DB_BACKUP", "DAILY")
		if got := Load().DBBackup; got != DBBackupDaily {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("weekly", func(t *testing.T) {
		t.Setenv("DB_BACKUP", "weekly")
		if got := Load().DBBackup; got != DBBackupWeekly {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("monthly", func(t *testing.T) {
		t.Setenv("DB_BACKUP", "Monthly")
		if got := Load().DBBackup; got != DBBackupMonthly {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("invalid", func(t *testing.T) {
		t.Setenv("DB_BACKUP", "HOURLY")
		if got := Load().DBBackup; got != DBBackupDisable {
			t.Fatalf("invalid should fall back to DISABLE, got %q", got)
		}
	})
}

func TestWebAuthnDisabledByDefault(t *testing.T) {
	t.Setenv("WEBAUTHN_RP_ID", "")
	t.Setenv("WEBAUTHN_RP_ORIGINS", "")
	cfg := Load()
	if cfg.WebAuthn == nil {
		t.Fatal("WebAuthn config should be non-nil")
	}
	if cfg.WebAuthn.Ready() {
		t.Fatal("WebAuthn should be unready when env unset")
	}
	if cfg.WebAuthn.RPName != "e2Mail" {
		t.Fatalf("default RPName = %q, want e2Mail", cfg.WebAuthn.RPName)
	}
}

func TestLoadWebAuthn(t *testing.T) {
	t.Setenv("WEBAUTHN_RP_ID", "mail.example.com")
	t.Setenv("WEBAUTHN_RP_ORIGINS", " https://mail.example.com/ , https://alt.example.com ")
	t.Setenv("WEBAUTHN_RP_NAME", "e2Mail Test")
	cfg := Load()
	if !cfg.WebAuthn.Ready() {
		t.Fatal("WebAuthn should be ready with full env")
	}
	if cfg.WebAuthn.RPID != "mail.example.com" {
		t.Fatalf("RPID = %q", cfg.WebAuthn.RPID)
	}
	if len(cfg.WebAuthn.RPOrigins) != 2 {
		t.Fatalf("origins = %#v, want 2", cfg.WebAuthn.RPOrigins)
	}
	if cfg.WebAuthn.RPOrigins[0] != "https://mail.example.com" {
		t.Fatalf("origin[0] = %q (trailing slash/space not trimmed)", cfg.WebAuthn.RPOrigins[0])
	}
	if cfg.WebAuthn.RPName != "e2Mail Test" {
		t.Fatalf("RPName = %q", cfg.WebAuthn.RPName)
	}
}

func TestWebAuthnPartialEnvNotReady(t *testing.T) {
	t.Run("only rp id", func(t *testing.T) {
		t.Setenv("WEBAUTHN_RP_ID", "mail.example.com")
		t.Setenv("WEBAUTHN_RP_ORIGINS", "")
		if Load().WebAuthn.Ready() {
			t.Fatal("RP ID alone must not be ready")
		}
	})
	t.Run("only origins", func(t *testing.T) {
		t.Setenv("WEBAUTHN_RP_ID", "")
		t.Setenv("WEBAUTHN_RP_ORIGINS", "https://mail.example.com")
		if Load().WebAuthn.Ready() {
			t.Fatal("origins alone must not be ready")
		}
	})
}

func TestWebAuthnReadyNilSafe(t *testing.T) {
	var w *WebAuthnConfig
	if w.Ready() {
		t.Fatal("nil WebAuthnConfig must not be ready")
	}
}

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

func TestLoadAllowedHosts(t *testing.T) {
	t.Setenv("HTTP_ALLOWED_HOSTS", " mail.example.com , alt.example.com ")
	cfg := Load()
	if len(cfg.AllowedHosts) != 2 || cfg.AllowedHosts[0] != "mail.example.com" || cfg.AllowedHosts[1] != "alt.example.com" {
		t.Fatalf("AllowedHosts = %#v", cfg.AllowedHosts)
	}
	t.Setenv("HTTP_ALLOWED_HOSTS", "")
	if got := Load().AllowedHosts; len(got) != 0 {
		t.Fatalf("empty HTTP_ALLOWED_HOSTS should give no hosts, got %#v", got)
	}
}

func TestLoadMailServerSimpleMode(t *testing.T) {
	for _, key := range []string{
		"MAIL_SERVER", "MAIL_IMAP_HOST", "MAIL_SMTP_HOST", "MAIL_IMAP_PORT", "MAIL_SMTP_PORT",
		"MAIL_ALLOW_INSECURE_TLS", "MAIL_MODE",
	} {
		t.Setenv(key, "")
	}

	t.Setenv("MAIL_SERVER", "example.com")
	cfg := Load()
	if cfg.DefaultIMAPHost != "example.com" || cfg.DefaultSMTPHost != "example.com" {
		t.Fatalf("MAIL_SERVER should fill both hosts: %q / %q", cfg.DefaultIMAPHost, cfg.DefaultSMTPHost)
	}
	if cfg.DefaultIMAPPort != 993 || cfg.DefaultSMTPPort != 587 {
		t.Fatalf("unexpected default ports: %d / %d", cfg.DefaultIMAPPort, cfg.DefaultSMTPPort)
	}
	if !cfg.HasFixedServers() {
		t.Fatal("MAIL_SERVER should lock the login server by default")
	}
	if len(cfg.LoginAllowedDomains) != 1 || cfg.LoginAllowedDomains[0] != "example.com" {
		t.Fatalf("auto allowed domain = %#v", cfg.LoginAllowedDomains)
	}
	if cfg.LoginDomainAllowed("abc@not-example.com") {
		t.Fatal("auto-derived domain must reject a different email domain")
	}
	if !cfg.LoginDomainAllowed("abc@example.com") {
		t.Fatal("auto-derived domain must allow the matching email domain")
	}

	t.Setenv("MAIL_IMAP_HOST", "imap.example.com")
	cfg = Load()
	if cfg.DefaultIMAPHost != "imap.example.com" || cfg.DefaultSMTPHost != "example.com" {
		t.Fatalf("MAIL_IMAP_HOST override failed: %q / %q", cfg.DefaultIMAPHost, cfg.DefaultSMTPHost)
	}

	t.Setenv("MAIL_MODE", "prefill")
	cfg = Load()
	if cfg.HasFixedServers() {
		t.Fatal("MAIL_MODE=prefill must not lock the login server")
	}
	if len(cfg.LoginAllowedDomains) != 0 {
		t.Fatalf("prefill mode should not auto-derive a domain: %#v", cfg.LoginAllowedDomains)
	}
}

func TestMailServerDomainWithOperationalHostOverride(t *testing.T) {
	for _, key := range []string{
		"MAIL_SERVER", "MAIL_IMAP_HOST", "MAIL_SMTP_HOST", "MAIL_MODE", "MAIL_ALLOWED_DOMAINS",
	} {
		t.Setenv(key, "")
	}
	t.Setenv("MAIL_SERVER", "example.com")
	t.Setenv("MAIL_IMAP_HOST", "mail.example.com")
	t.Setenv("MAIL_SMTP_HOST", "smtp.example.com")

	cfg := Load()
	if cfg.DefaultIMAPHost != "mail.example.com" || cfg.DefaultSMTPHost != "smtp.example.com" {
		t.Fatalf("operational host override failed: %q / %q", cfg.DefaultIMAPHost, cfg.DefaultSMTPHost)
	}
	if len(cfg.LoginAllowedDomains) != 1 || cfg.LoginAllowedDomains[0] != "example.com" {
		t.Fatalf("allowed domain = %#v, want example.com", cfg.LoginAllowedDomains)
	}
	if !cfg.LoginDomainAllowed("abc@example.com") {
		t.Fatal("@example.com should be allowed")
	}
	if cfg.LoginDomainAllowed("abc@mail.example.com") {
		t.Fatal("the operational subdomain must not become the login domain")
	}
}

func TestLegacyMailEnvIgnored(t *testing.T) {
	for _, key := range []string{
		"MAIL_SERVER", "MAIL_IMAP_HOST", "MAIL_SMTP_HOST", "MAIL_IMAP_PORT", "MAIL_SMTP_PORT",
		"MAIL_ALLOW_INSECURE_TLS", "MAIL_SIEVE_HOST", "MAIL_SIEVE_PORT", "MAIL_SIEVE_USE_TLS",
		"MAIL_SIEVE_ALLOW_INSECURE_TLS", "MAIL_MODE", "MAIL_ALLOWED_DOMAINS",
	} {
		t.Setenv(key, "")
	}
	t.Setenv("DEFAULT_IMAP_HOST", "legacy-imap.example")
	t.Setenv("DEFAULT_IMAP_PORT", "1993")
	t.Setenv("DEFAULT_SMTP_HOST", "legacy-smtp.example")
	t.Setenv("DEFAULT_SMTP_PORT", "1587")
	t.Setenv("DEFAULT_ALLOW_INSECURE_TLS", "true")
	t.Setenv("DEFAULT_SIEVE_HOST", "legacy-sieve.example")
	t.Setenv("DEFAULT_SIEVE_PORT", "14190")
	t.Setenv("DEFAULT_SIEVE_USE_TLS", "false")
	t.Setenv("DEFAULT_SIEVE_ALLOW_INSECURE_TLS", "true")
	t.Setenv("LOGIN_ALLOWED_DOMAINS", "legacy.example")

	cfg := Load()
	if cfg.DefaultIMAPHost != "" || cfg.DefaultSMTPHost != "" || cfg.DefaultSieveHost != "" {
		t.Fatalf("legacy hosts must be ignored: %#v", cfg)
	}
	if cfg.DefaultIMAPPort != 993 || cfg.DefaultSMTPPort != 587 || cfg.DefaultSievePort != 4190 {
		t.Fatalf("legacy ports must be ignored: %d/%d/%d", cfg.DefaultIMAPPort, cfg.DefaultSMTPPort, cfg.DefaultSievePort)
	}
	if cfg.DefaultAllowInsecureTLS || cfg.DefaultSieveAllowInsecureTLS || !cfg.DefaultSieveUseTLS {
		t.Fatal("legacy TLS flags must be ignored")
	}
	if len(cfg.LoginAllowedDomains) != 0 {
		t.Fatalf("legacy domain env must be ignored: %#v", cfg)
	}
}

func TestMailEnvAdvancedOverrides(t *testing.T) {
	for _, key := range []string{
		"MAIL_SERVER", "MAIL_IMAP_HOST", "MAIL_SMTP_HOST", "MAIL_IMAP_PORT", "MAIL_SMTP_PORT",
		"MAIL_ALLOW_INSECURE_TLS", "MAIL_SIEVE_HOST", "MAIL_SIEVE_PORT", "MAIL_SIEVE_USE_TLS",
		"MAIL_SIEVE_ALLOW_INSECURE_TLS", "MAIL_MODE",
	} {
		t.Setenv(key, "")
	}
	t.Setenv("MAIL_SERVER", "mail.example.com")
	t.Setenv("MAIL_IMAP_PORT", "1993")
	t.Setenv("MAIL_SMTP_PORT", "1587")
	t.Setenv("MAIL_ALLOW_INSECURE_TLS", "true")
	t.Setenv("MAIL_SIEVE_HOST", "sieve.example.com")
	t.Setenv("MAIL_SIEVE_PORT", "14190")
	t.Setenv("MAIL_SIEVE_USE_TLS", "false")
	t.Setenv("MAIL_SIEVE_ALLOW_INSECURE_TLS", "true")
	t.Setenv("MAIL_MODE", "prefill")

	cfg := Load()
	if cfg.DefaultIMAPHost != "mail.example.com" || cfg.DefaultSMTPHost != "mail.example.com" {
		t.Fatalf("MAIL_SERVER hosts = %q / %q", cfg.DefaultIMAPHost, cfg.DefaultSMTPHost)
	}
	if cfg.DefaultIMAPPort != 1993 || cfg.DefaultSMTPPort != 1587 {
		t.Fatalf("ports = %d / %d", cfg.DefaultIMAPPort, cfg.DefaultSMTPPort)
	}
	if !cfg.DefaultAllowInsecureTLS {
		t.Fatal("MAIL_ALLOW_INSECURE_TLS not parsed")
	}
	if cfg.DefaultSieveHost != "sieve.example.com" || cfg.DefaultSievePort != 14190 ||
		cfg.DefaultSieveUseTLS || !cfg.DefaultSieveAllowInsecureTLS {
		t.Fatalf("Sieve config = %#v", cfg)
	}
	if cfg.HasFixedServers() {
		t.Fatal("MAIL_MODE=prefill must not lock the login server")
	}
	if len(cfg.LoginAllowedDomains) != 0 {
		t.Fatalf("prefill mode should not auto-derive a domain: %#v", cfg.LoginAllowedDomains)
	}

	t.Setenv("MAIL_MODE", "bogus")
	cfg = Load()
	if !cfg.HasFixedServers() {
		t.Fatal("invalid MAIL_MODE should fall back to auto (locked with both hosts)")
	}
}

func TestExplicitAllowedDomainNotDuplicatedByServer(t *testing.T) {
	for _, key := range []string{
		"MAIL_SERVER", "MAIL_IMAP_HOST", "MAIL_SMTP_HOST", "MAIL_MODE", "MAIL_ALLOWED_DOMAINS",
	} {
		t.Setenv(key, "")
	}
	t.Setenv("MAIL_SERVER", "wonghome.net")
	t.Setenv("MAIL_ALLOWED_DOMAINS", "wonghome.net")

	cfg := Load()
	if len(cfg.LoginAllowedDomains) != 1 || cfg.LoginAllowedDomains[0] != "wonghome.net" {
		t.Fatalf("allowed domains = %#v, want exactly [wonghome.net]", cfg.LoginAllowedDomains)
	}
}

func TestHasFixedServers(t *testing.T) {
	cases := []struct {
		name string
		cfg  ServerConfig
		want bool
	}{
		{"none", ServerConfig{}, false},
		{"imap only", ServerConfig{DefaultIMAPHost: "imap.example.com"}, false},
		{"smtp only", ServerConfig{DefaultSMTPHost: "smtp.example.com"}, false},
		{"both", ServerConfig{DefaultIMAPHost: "imap.example.com", DefaultSMTPHost: "smtp.example.com"}, true},
		{"both prefill", ServerConfig{DefaultIMAPHost: "imap.example.com", DefaultSMTPHost: "smtp.example.com", MailMode: "prefill"}, false},
		{"both locked", ServerConfig{DefaultIMAPHost: "imap.example.com", DefaultSMTPHost: "smtp.example.com", MailMode: "locked"}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.cfg.HasFixedServers(); got != tc.want {
				t.Fatalf("HasFixedServers() = %v, want %v", got, tc.want)
			}
		})
	}
	var nilCfg *ServerConfig
	if nilCfg.HasFixedServers() {
		t.Fatal("nil config must not report fixed servers")
	}
}

func TestLoginAllowedDomains(t *testing.T) {
	t.Setenv("MAIL_ALLOWED_DOMAINS", " EXAMPLE.COM , @example.com. ")
	cfg := Load()
	if len(cfg.LoginAllowedDomains) != 2 ||
		cfg.LoginAllowedDomains[0] != "example.com" ||
		cfg.LoginAllowedDomains[1] != "example.com" {
		t.Fatalf("LoginAllowedDomains = %#v", cfg.LoginAllowedDomains)
	}

	for _, email := range []string{"abc@example.com", "ABC@EXAMPLE.COM", "x@example.com"} {
		if !cfg.LoginDomainAllowed(email) {
			t.Errorf("LoginDomainAllowed(%q) = false, want true", email)
		}
	}
	for _, email := range []string{"abc@not-example.com", "abc", "", "abc@"} {
		if cfg.LoginDomainAllowed(email) {
			t.Errorf("LoginDomainAllowed(%q) = true, want false", email)
		}
	}

	t.Setenv("MAIL_ALLOWED_DOMAINS", "")
	if !Load().LoginDomainAllowed("any@example.org") {
		t.Fatal("empty allow-list must allow any domain")
	}

	var nilCfg *ServerConfig
	if !nilCfg.LoginDomainAllowed("any@example.org") {
		t.Fatal("nil config must allow any domain")
	}
}

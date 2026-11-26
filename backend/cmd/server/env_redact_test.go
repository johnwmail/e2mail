package main

import "testing"

func TestIsSensitiveEnvKey(t *testing.T) {
	sensitive := []string{
		"SESSION_SECRET", "LDAP_ROOT_PW", "DOCKER_PASSWORD", "MY_API_TOKEN",
		"db_key", "SOMETHING_PRIVATE", "ldap_bind_password", "SECRET_KEY",
	}
	for _, k := range sensitive {
		if !isSensitiveEnvKey(k) {
			t.Errorf("%s should be treated as sensitive", k)
		}
	}

	normal := []string{"PORT", "DATA_DIR", "MAIL_IMAP_HOST", "SESSION_TTL_HOURS", "COOKIE_SECURE", "REQUIRE_2FA", "HOME"}
	for _, k := range normal {
		if isSensitiveEnvKey(k) {
			t.Errorf("%s should NOT be redacted", k)
		}
	}
}

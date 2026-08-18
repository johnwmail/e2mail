package auth

import (
	"strings"
	"testing"
	"time"

	"github.com/pquerna/otp/totp"
)

func TestGenerateAndValidateTOTP(t *testing.T) {
	secret := GenerateSecret()
	if len(secret) < 16 {
		t.Fatalf("secret too short: %d", len(secret))
	}

	key, err := GenerateKey("test@example.com", secret)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	if key.URL() == "" {
		t.Fatal("otpauth URL is empty")
	}

	// otpauth URI 入面嘅 secret 必須等於原始 base32 secret，
	// 否則 Google Authenticator / oathtool 用 URI secret 計出嘅 code 會唔 match
	if key.Secret() != secret {
		t.Fatalf("otpauth URI secret %q != original %q (double-encoded?)", key.Secret(), secret)
	}

	// 產生一個有效 code 並驗證
	code, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatalf("GenerateCode: %v", err)
	}
	if !ValidateCode(secret, code) {
		t.Fatal("valid TOTP code rejected")
	}
	if ValidateCode(secret, "000000") {
		t.Fatal("invalid TOTP code accepted")
	}
}

func TestBackupCodes(t *testing.T) {
	plain, hashed := GenerateBackupCodes()
	if len(plain) != BackupCodeCount || len(hashed) != BackupCodeCount {
		t.Fatalf("unexpected counts: plain=%d hashed=%d", len(plain), len(hashed))
	}
	if plain[0] == plain[1] {
		t.Fatal("backup codes should be unique")
	}

	idx := ValidateBackupCode(plain[0], hashed)
	if idx != 0 {
		t.Fatalf("expected idx 0, got %d", idx)
	}
	if ValidateBackupCode("AAAAA-BBBBB", hashed) != -1 {
		t.Fatal("invalid backup code accepted")
	}
}

func TestGeneratedBackupCodeFormat(t *testing.T) {
	for i := 0; i < 50; i++ {
		plain, _ := GenerateBackupCodes()
		if len(plain) != BackupCodeCount {
			t.Fatalf("unexpected count %d", len(plain))
		}
		for _, code := range plain {
			if !IsBackupCodeShape(code) {
				t.Fatalf("generated code %q is not in expected shape", code)
			}
			for _, ch := range code {
				if ch == '-' {
					continue
				}
				if !strings.ContainsRune(BackupCodeCharset, ch) {
					t.Fatalf("code %q contains invalid char %q", code, ch)
				}
			}
		}
	}
}

func TestValidateBackupCodeNormalizesInput(t *testing.T) {
	plain, hashed := GenerateBackupCodes()
	cases := []string{
		strings.ToLower(plain[0]),
		"  " + plain[0] + "  ",
	}
	for _, c := range cases {
		if ValidateBackupCode(c, hashed) != 0 {
			t.Fatalf("backup code %q should validate against %q", c, plain[0])
		}
	}
}

func TestHashCodeStable(t *testing.T) {
	if HashCode("ABC-123") != HashCode("abc-123") {
		t.Fatal("HashCode should be case-insensitive and trim input")
	}
	if HashCode("ABC-123") == HashCode("ABC-124") {
		t.Fatal("different codes must hash differently")
	}
}

func TestFormatCode(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"Abc-123", "ABC123"},
		{" abc def ", "ABCDEF"},
		{"!!!", ""},
		{"", ""},
	}
	for _, c := range cases {
		if got := FormatCode(c.in); got != c.want {
			t.Errorf("FormatCode(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestIsBackupCodeShape(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"ABCDE-12345", true},
		{"ABCDE12345", true},
		{"abcde-12345", true},
		{"abcde-1234", false},
		{"", false},
		{"!!!!-!!!!!", false},
	}
	for _, c := range cases {
		if got := IsBackupCodeShape(c.in); got != c.want {
			t.Errorf("IsBackupCodeShape(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}
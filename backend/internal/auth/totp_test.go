package auth

import (
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
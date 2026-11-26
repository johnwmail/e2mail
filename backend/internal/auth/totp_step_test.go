package auth

import (
	"testing"
	"time"

	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
)

// ValidateCodeStep 應回傳該 code 所屬嘅 time step（unix/30），供重放防護使用。
func TestValidateCodeStepReturnsMatchedStep(t *testing.T) {
	key, err := totp.Generate(totp.GenerateOpts{Issuer: Issuer, AccountName: "u@example.com"})
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	now := time.Unix(1_700_000_000, 0)
	code, err := totp.GenerateCodeCustom(key.Secret(), now, totp.ValidateOpts{Period: 30, Digits: otp.DigitsSix, Algorithm: otp.AlgorithmSHA1})
	if err != nil {
		t.Fatalf("generate code: %v", err)
	}

	step, ok := ValidateCodeStep(key.Secret(), code, now)
	if !ok {
		t.Fatal("valid code rejected")
	}
	if want := now.Unix() / 30; step != want {
		t.Fatalf("step = %d, want %d", step, want)
	}
}

// 前一個時間窗（±1）內嘅 code 仍然有效，並回傳該窗口嘅 step。
func TestValidateCodeStepAcceptsPreviousWindow(t *testing.T) {
	key, err := totp.Generate(totp.GenerateOpts{Issuer: Issuer, AccountName: "u@example.com"})
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	now := time.Unix(1_700_000_000, 0)
	prev := now.Add(-30 * time.Second)
	code, err := totp.GenerateCodeCustom(key.Secret(), prev, totp.ValidateOpts{Period: 30, Digits: otp.DigitsSix, Algorithm: otp.AlgorithmSHA1})
	if err != nil {
		t.Fatalf("generate code: %v", err)
	}

	step, ok := ValidateCodeStep(key.Secret(), code, now)
	if !ok {
		t.Fatal("previous-window code should be accepted for clock skew")
	}
	if want := prev.Unix() / 30; step != want {
		t.Fatalf("step = %d, want %d", step, want)
	}
}

func TestValidateCodeStepRejectsInvalidAndEmpty(t *testing.T) {
	if _, ok := ValidateCodeStep("", "123456", time.Now()); ok {
		t.Fatal("empty secret must be rejected")
	}
	if _, ok := ValidateCodeStep("JBSWY3DPEHPK3PXP", "", time.Now()); ok {
		t.Fatal("empty code must be rejected")
	}
}

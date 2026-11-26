package middleware

import (
	"testing"

	"github.com/johnwmail/e2mail/backend/internal/crypto"
	"github.com/johnwmail/e2mail/backend/internal/session"
	"github.com/johnwmail/e2mail/backend/internal/storage"
)

func newLazyAuthCtx(t *testing.T) *AuthContext {
	t.Helper()
	dek, err := crypto.GenerateDEK()
	if err != nil {
		t.Fatalf("GenerateDEK: %v", err)
	}
	encA, err := crypto.Encrypt(dek, []byte("pass-a"))
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	encB, err := crypto.Encrypt(dek, []byte("pass-b"))
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	sess := &session.Session{Accounts: []storage.Account{
		{ID: "a", IsDefault: true, EncIMAPPassword: encA},
		{ID: "b", EncIMAPPassword: encB},
	}}
	return &AuthContext{Session: sess, DEK: dek}
}

// 唔應該喺登入／每個請求時先解密全部帳號；只有實際取用時先解密。
func TestPasswordForDecryptsOnDemandOnly(t *testing.T) {
	ctx := newLazyAuthCtx(t)
	if len(ctx.Passwords) != 0 {
		t.Fatalf("passwords decrypted eagerly: %v", ctx.Passwords)
	}

	if p, ok := ctx.PasswordFor("b"); !ok || p != "pass-b" {
		t.Fatalf("PasswordFor(b) = %q, %v", p, ok)
	}
	if _, cached := ctx.Passwords["a"]; cached {
		t.Fatal("account a should not be decrypted when only b was requested")
	}
	if p, ok := ctx.PasswordFor("b"); !ok || p != "pass-b" {
		t.Fatal("cached value should be returned on second call")
	}
}

func TestPasswordForUnknownAccount(t *testing.T) {
	ctx := newLazyAuthCtx(t)
	if p, ok := ctx.PasswordFor("missing"); ok || p != "" {
		t.Fatalf("unknown account returned %q, %v", p, ok)
	}
	var nilCtx *AuthContext
	if p, ok := nilCtx.PasswordFor("a"); ok || p != "" {
		t.Fatal("nil context must return empty")
	}
}

func TestGetCurrentAccountPasswordLazy(t *testing.T) {
	ctx := newLazyAuthCtx(t)
	acc := &ctx.Session.Accounts[0]
	if got := GetCurrentAccountPassword(ctx, acc); got != "pass-a" {
		t.Fatalf("GetCurrentAccountPassword = %q, want pass-a", got)
	}
}

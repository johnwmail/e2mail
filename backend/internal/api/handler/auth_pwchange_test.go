package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/johnwmail/e2mail/backend/internal/api/middleware"
	"github.com/johnwmail/e2mail/backend/internal/auth"
	"github.com/johnwmail/e2mail/backend/internal/config"
	"github.com/johnwmail/e2mail/backend/internal/crypto"
	"github.com/johnwmail/e2mail/backend/internal/ldap"
	"github.com/johnwmail/e2mail/backend/internal/session"
	"github.com/johnwmail/e2mail/backend/internal/storage"
)

type fakeChanger struct {
	dnString    string
	bindErr     error
	changeErr   error
	verifyCalls int
	changedTo   []string
}

func (f *fakeChanger) UserDN(email string) (string, error) {
	if f.dnString != "" {
		return f.dnString, nil
	}
	return "uid=" + email + ",ou=people,dc=test", nil
}

func (f *fakeChanger) VerifyUserBind(userDN, password string) error {
	f.verifyCalls++
	return f.bindErr
}

func (f *fakeChanger) ChangePassword(userDN, newPassword string) error {
	if f.changeErr == nil {
		f.changedTo = append(f.changedTo, newPassword)
	}
	return f.changeErr
}

// setupChangePassword 建立真實 SQLite + Memory session，模拟首登入後狀態
func setupChangePassword(t *testing.T, oldPass string, changer *fakeChanger) (*AuthHandler, *middleware.AuthContext) {
	t.Helper()
	h := newTestAuthHandler(t)
	h.cfg = &config.ServerConfig{
		LDAP: &config.LDAPConfig{
			Enabled: true, URL: "ldaps://ldap.test:636",
			RootDN: "cn=root,dc=test", RootPW: "rootpw",
			UserDNTemplate: "uid=%s,ou=people,dc=test",
		},
	}
	if changer != nil {
		h.SetPasswordChanger(changer)
	}

	owner := "alice@test.com"
	_, dek, err := h.resolveCredential(owner, oldPass) // 建立 salt + wrapped DEK（如首登入）
	if err != nil {
		t.Fatalf("resolveCredential: %v", err)
	}

	acc := &storage.Account{
		UserEmail:       owner,
		Label:           owner,
		Email:           owner,
		IMAPHost:        "127.0.0.1",
		IMAPPort:        1,
		Username:        owner,
		EncIMAPPassword: oldPass,
		EncSMTPPassword: oldPass,
		IsDefault:       true,
	}
	if err := h.encryptAccountPasswords(acc, dek); err != nil {
		t.Fatal(err)
	}
	if err := h.storage.CreateAccount(acc); err != nil {
		t.Fatal(err)
	}

	sess := &session.Session{ID: "pwtest-sess", Email: owner, Accounts: []storage.Account{*acc}}
	authCtx := &middleware.AuthContext{
		Session:   sess,
		DEK:       dek,
		Passwords: map[string]string{acc.ID: oldPass},
	}
	t.Cleanup(func() {
		h.idleMgr.StopSessionListeners(sess.ID)
		h.poolMgr.DestroySessionPools(sess.ID)
	})
	return h, authCtx
}

func pwCtx(authCtx *middleware.AuthContext) context.Context {
	return context.WithValue(context.Background(), middleware.AuthContextKey, authCtx)
}

func pwBody(old, nw, confirm string) map[string]string {
	return map[string]string{"oldPassword": old, "newPassword": nw, "confirmPassword": confirm}
}

func TestChangePassword_NotEnabled(t *testing.T) {
	h, authCtx := setupChangePassword(t, "OldPass123", nil) // no changer
	w := call(t, h.ChangePassword, pwCtx(authCtx), pwBody("OldPass123", "NewPass123", "NewPass123"))
	if w.Code != http.StatusForbidden {
		t.Fatalf("code = %d, want 403", w.Code)
	}
}

func TestChangePassword_Validation(t *testing.T) {
	f := &fakeChanger{}
	h, authCtx := setupChangePassword(t, "OldPass123", f)
	cases := []struct {
		name string
		body map[string]string
	}{
		{"mismatch confirm", pwBody("OldPass123", "NewPass123", "Other12345")},
		{"too short", pwBody("OldPass123", "abc", "abc")},
		{"same as old", pwBody("OldPass123", "OldPass123", "OldPass123")},
		{"empty old", pwBody("", "NewPass123", "NewPass123")},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			w := call(t, h.ChangePassword, pwCtx(authCtx), c.body)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("code = %d, want 400 (%s)", w.Code, c.name)
			}
		})
	}
	if f.verifyCalls != 0 || len(f.changedTo) != 0 {
		t.Fatal("no LDAP calls expected for invalid requests")
	}
}

func TestChangePassword_OldPasswordWrong(t *testing.T) {
	f := &fakeChanger{bindErr: fmt.Errorf("%w: bind failed", ldap.ErrInvalidCredentials)}
	h, authCtx := setupChangePassword(t, "OldPass123", f)

	w := call(t, h.ChangePassword, pwCtx(authCtx), pwBody("WrongPass999", "NewPass123", "NewPass123"))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("code = %d, want 401", w.Code)
	}
	if len(f.changedTo) != 0 {
		t.Fatal("must not touch LDAP after failed verify")
	}
	// DB 憑證仍可用舊密碼解開
	cred, _ := h.storage.GetUserCredential(authCtx.Session.Email)
	if _, err := crypto.Decrypt(crypto.DeriveMasterKey("OldPass123", cred.Salt), cred.WrappedDEK); err != nil {
		t.Fatalf("old credential should remain intact: %v", err)
	}
}

func TestChangePassword_LDAPUnreachable(t *testing.T) {
	f := &fakeChanger{bindErr: errors.New("dial tcp: connect: refused")}
	h, authCtx := setupChangePassword(t, "OldPass123", f)
	w := call(t, h.ChangePassword, pwCtx(authCtx), pwBody("OldPass123", "NewPass123", "NewPass123"))
	if w.Code != http.StatusBadGateway {
		t.Fatalf("code = %d, want 502", w.Code)
	}
}

func TestChangePassword_LDAPModifyFails(t *testing.T) {
	f := &fakeChanger{changeErr: errors.New("ldap modify: unwilling to perform")}
	h, authCtx := setupChangePassword(t, "OldPass123", f)

	w := call(t, h.ChangePassword, pwCtx(authCtx), pwBody("OldPass123", "NewPass123", "NewPass123"))
	if w.Code != http.StatusBadGateway {
		t.Fatalf("code = %d, want 502", w.Code)
	}
	// 本地完全未改：新密碼解唔到 DEK，舊密碼仍然解得到
	cred, _ := h.storage.GetUserCredential(authCtx.Session.Email)
	if _, err := crypto.Decrypt(crypto.DeriveMasterKey("NewPass123", cred.Salt), cred.WrappedDEK); err == nil {
		t.Fatal("DEK must NOT have been re-wrapped with new password")
	}
	if _, err := crypto.Decrypt(crypto.DeriveMasterKey("OldPass123", cred.Salt), cred.WrappedDEK); err != nil {
		t.Fatalf("old password must still unwrap DEK: %v", err)
	}
}

func TestChangePassword_Success(t *testing.T) {
	f := &fakeChanger{}
	const oldPass, newPass = "OldPass123", "NewPass123!"
	h, authCtx := setupChangePassword(t, oldPass, f)

	w := call(t, h.ChangePassword, pwCtx(authCtx), pwBody(oldPass, newPass, newPass))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200 (body %s)", w.Code, w.Body.String())
	}
	ok, data := decodeStandard(t, w)
	if !ok {
		t.Fatalf("success=false: %s", w.Body.String())
	}
	var resp struct {
		Changed bool `json:"changed"`
	}
	if err := json.Unmarshal(data, &resp); err != nil || !resp.Changed {
		t.Fatalf("bad payload: %s", string(data))
	}

	owner := authCtx.Session.Email

	// 1. LDAP 端收到新密碼
	if len(f.changedTo) != 1 || f.changedTo[0] != newPass {
		t.Fatalf("LDAP writes = %v", f.changedTo)
	}

	// 2. 本地 DEK 已 re-wrap：新密碼解到、舊密碼解唔到
	cred, err := h.storage.GetUserCredential(owner)
	if err != nil || cred == nil {
		t.Fatalf("GetUserCredential: %v", err)
	}
	unwrapped, err := crypto.Decrypt(crypto.DeriveMasterKey(newPass, cred.Salt), cred.WrappedDEK)
	if err != nil || string(unwrapped) != string(authCtx.DEK) {
		t.Fatalf("new password must unwrap same DEK: %v", err)
	}
	if _, err := crypto.Decrypt(crypto.DeriveMasterKey(oldPass, cred.Salt), cred.WrappedDEK); err == nil {
		t.Fatal("old password must no longer unwrap DEK")
	}

	// 3. 帳號儲存密碼已更新（DB + 記憶體 session）
	dbAcc, err := h.storage.GetAccount(owner, authCtx.Session.Accounts[0].ID)
	if err != nil || dbAcc == nil {
		t.Fatalf("GetAccount: %v", err)
	}
	pass, err := crypto.Decrypt(authCtx.DEK, dbAcc.EncIMAPPassword)
	if err != nil || string(pass) != newPass {
		t.Fatalf("stored imap password not updated: %q %v", pass, err)
	}
	if authCtx.Passwords[dbAcc.ID] != newPass {
		t.Fatalf("session password map stale: %v", authCtx.Passwords)
	}
}

func TestChangePassword_RateLimited(t *testing.T) {
	f := &fakeChanger{bindErr: fmt.Errorf("%w: x", ldap.ErrInvalidCredentials)}
	h, authCtx := setupChangePassword(t, "OldPass123", f)
	authCtx.Session.ID = "ratelimit-sess"

	for i := 0; i < pwChangeMaxFailures; i++ {
		w := call(t, h.ChangePassword, pwCtx(authCtx), pwBody("bad", "NewPass123", "NewPass123"))
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d: code = %d, want 401", i, w.Code)
		}
	}
	w := call(t, h.ChangePassword, pwCtx(authCtx), pwBody("bad", "NewPass123", "NewPass123"))
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("code = %d, want 429", w.Code)
	}
}

func TestAttemptLimiter_WindowExpires(t *testing.T) {
	l := auth.NewAttemptLimiter()
	for i := 0; i < 5; i++ {
		l.RecordFailure("k")
	}
	if !l.Blocked("k", 5, time.Millisecond) {
		t.Fatal("should be blocked right after failures")
	}
	time.Sleep(10 * time.Millisecond)
	if l.Blocked("k", 5, time.Millisecond) {
		t.Fatal("should unblock after window")
	}
}

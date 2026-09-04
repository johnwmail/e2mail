package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/pquerna/otp/totp"
	"github.com/johnwmail/e2mail/backend/internal/api/middleware"
	"github.com/johnwmail/e2mail/backend/internal/auth"
	"github.com/johnwmail/e2mail/backend/internal/imap"
	"github.com/johnwmail/e2mail/backend/internal/session"
	"github.com/johnwmail/e2mail/backend/internal/storage"
)

func newTestAuthHandler(t *testing.T) *AuthHandler {
	t.Helper()
	store, err := session.NewMemoryStore(10*time.Minute, nil)
	if err != nil {
		t.Fatalf("NewMemoryStore: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	storageStore, err := storage.NewSQLiteStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewSQLiteStore: %v", err)
	}
	t.Cleanup(func() { _ = storageStore.Close() })

	return NewAuthHandler(store, storageStore, imap.NewPoolManager(), imap.NewIdleManager(), nil, 10*time.Minute)
}

func sessionContext(email string) context.Context {
	ctx := context.WithValue(context.Background(), middleware.SessionContextKey, &session.Session{Email: email})
	return ctx
}

func call(t *testing.T, h func(w http.ResponseWriter, r *http.Request), ctx context.Context, body any) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatalf("encode body: %v", err)
		}
	}
	r := httptest.NewRequest(http.MethodPost, "/", &buf)
	if ctx != nil {
		r = r.WithContext(ctx)
	}
	w := httptest.NewRecorder()
	h(w, r)
	return w
}

func decodeStandard(t *testing.T, w *httptest.ResponseRecorder) (bool, json.RawMessage) {
	t.Helper()
	var resp struct {
		Success bool            `json:"success"`
		Data    json.RawMessage `json:"data"`
		Error   string          `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid JSON %q: %v", w.Body.String(), err)
	}
	return resp.Success, resp.Data
}

func twoFASetupData(t *testing.T, data json.RawMessage) TwoFASetupResponse {
	t.Helper()
	var r TwoFASetupResponse
	if err := json.Unmarshal(data, &r); err != nil {
		t.Fatalf("decode setup data: %v", err)
	}
	return r
}

func twoFAEnableData(t *testing.T, data json.RawMessage) (bool, []string) {
	t.Helper()
	var r struct {
		Enabled     bool     `json:"enabled"`
		BackupCodes []string `json:"backupCodes"`
	}
	if err := json.Unmarshal(data, &r); err != nil {
		t.Fatalf("decode enable data: %v", err)
	}
	return r.Enabled, r.BackupCodes
}

// enable2FA 完整走 setup -> enable 流程，回傳 secret
func enable2FA(t *testing.T, h *AuthHandler, ctx context.Context) string {
	t.Helper()
	w := call(t, h.TwoFASetup, ctx, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("TwoFASetup status = %d, body %s", w.Code, w.Body.String())
	}
	_, data := decodeStandard(t, w)
	setup := twoFASetupData(t, data)

	code, err := totp.GenerateCode(setup.Secret, time.Now())
	if err != nil {
		t.Fatalf("GenerateCode: %v", err)
	}
	w = call(t, h.TwoFAEnable, ctx, TwoFAEnableRequest{Secret: setup.Secret, Code: code})
	if w.Code != http.StatusOK {
		t.Fatalf("TwoFAEnable status = %d, body %s", w.Code, w.Body.String())
	}
	return setup.Secret
}

func TestTwoFASetup(t *testing.T) {
	h := newTestAuthHandler(t)
	ctx := sessionContext("test@example.com")

	w := call(t, h.TwoFASetup, ctx, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	ok, data := decodeStandard(t, w)
	if !ok {
		t.Fatalf("expected success, body %s", w.Body.String())
	}
	setup := twoFASetupData(t, data)
	if setup.Secret == "" || setup.OTPAuthURL == "" {
		t.Fatalf("secret/otpauth empty: %+v", setup)
	}
	if setup.Issuer != auth.Issuer {
		t.Fatalf("issuer = %q, want %q", setup.Issuer, auth.Issuer)
	}
	if setup.Account != "test@example.com" {
		t.Fatalf("account = %q", setup.Account)
	}
}

func TestTwoFASetupUnauthorized(t *testing.T) {
	h := newTestAuthHandler(t)
	w := call(t, h.TwoFASetup, nil, nil)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

func TestTwoFAEnableWrongCode(t *testing.T) {
	h := newTestAuthHandler(t)
	ctx := sessionContext("test@example.com")

	w := call(t, h.TwoFAEnable, ctx, TwoFAEnableRequest{Secret: "SOME-SECRET", Code: "000000"})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

func TestTwoFAEnableMissingFields(t *testing.T) {
	h := newTestAuthHandler(t)
	ctx := sessionContext("test@example.com")

	w := call(t, h.TwoFAEnable, ctx, TwoFAEnableRequest{})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestTwoFAFullFlow(t *testing.T) {
	h := newTestAuthHandler(t)
	ctx := sessionContext("test@example.com")

	// 初始未啟用
	w := call(t, h.TwoFAStatus, ctx, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	_, data := decodeStandard(t, w)
	var st TwoFAStatusResponse
	if err := json.Unmarshal(data, &st); err != nil {
		t.Fatalf("decode status: %v", err)
	}
	if st.Enabled {
		t.Fatal("2FA should start disabled")
	}

	secret := enable2FA(t, h, ctx)

	// 啟用後：enable 回傳 10 個備份碼、status enabled、再 setup 會被拒
	code, _ := totp.GenerateCode(secret, time.Now())
	w = call(t, h.TwoFAEnable, ctx, TwoFAEnableRequest{Secret: secret, Code: code})
	if w.Code != http.StatusOK {
		t.Fatalf("re-enable status = %d, body %s", w.Code, w.Body.String())
	}
	_, data = decodeStandard(t, w)
	enabled, codes := twoFAEnableData(t, data)
	if !enabled || len(codes) != auth.BackupCodeCount {
		t.Fatalf("enabled=%v codes=%d, want true / %d", enabled, len(codes), auth.BackupCodeCount)
	}

	w = call(t, h.TwoFASetup, ctx, nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("setup while enabled status = %d, want 400", w.Code)
	}

	w = call(t, h.TwoFAStatus, ctx, nil)
	_, data = decodeStandard(t, w)
	if err := json.Unmarshal(data, &st); err != nil {
		t.Fatalf("decode status: %v", err)
	}
	if !st.Enabled {
		t.Fatal("2FA should now be enabled")
	}

	// 停用：錯誤 code → 401
	w = call(t, h.TwoFADisable, ctx, TwoFAEnableRequest{Secret: secret, Code: "000000"})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("disable with wrong code = %d, want 401", w.Code)
	}

	// 正確 code → 停用成功，status 轉為 disabled
	code, _ = totp.GenerateCode(secret, time.Now())
	w = call(t, h.TwoFADisable, ctx, TwoFAEnableRequest{Secret: secret, Code: code})
	if w.Code != http.StatusOK {
		t.Fatalf("disable status = %d, body %s", w.Code, w.Body.String())
	}

	w = call(t, h.TwoFAStatus, ctx, nil)
	_, data = decodeStandard(t, w)
	if err := json.Unmarshal(data, &st); err != nil {
		t.Fatalf("decode status: %v", err)
	}
	if st.Enabled {
		t.Fatal("2FA should be disabled after disable")
	}
}

func TestTwoFADisableNotEnabled(t *testing.T) {
	h := newTestAuthHandler(t)
	ctx := sessionContext("test@example.com")
	w := call(t, h.TwoFADisable, ctx, TwoFAEnableRequest{Code: "123456"})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestTwoFARegenerateBackupCodes(t *testing.T) {
	h := newTestAuthHandler(t)
	ctx := sessionContext("test@example.com")

	secret := enable2FA(t, h, ctx)
	before, err := h.storage.GetTwoFA("test@example.com")
	if err != nil || before == nil {
		t.Fatalf("GetTwoFA: %v / %v", before, err)
	}
	oldHashes := before.BackupHashes
	if len(oldHashes) != auth.BackupCodeCount {
		t.Fatalf("initial hashes = %d", len(oldHashes))
	}

	code, _ := totp.GenerateCode(secret, time.Now())
	w := call(t, h.TwoFARegenerateBackupCodes, ctx, TwoFARegenerateRequest{Code: code})
	if w.Code != http.StatusOK {
		t.Fatalf("regenerate status = %d, body %s", w.Code, w.Body.String())
	}
	_, data := decodeStandard(t, w)
	var reg TwoFARegenerateResponse
	if err := json.Unmarshal(data, &reg); err != nil {
		t.Fatalf("decode regenerate: %v", err)
	}
	if len(reg.BackupCodes) != auth.BackupCodeCount {
		t.Fatalf("backup codes = %d, want %d", len(reg.BackupCodes), auth.BackupCodeCount)
	}

	after, _ := h.storage.GetTwoFA("test@example.com")
	if len(after.BackupHashes) != auth.BackupCodeCount {
		t.Fatalf("hashes after regenerate = %d", len(after.BackupHashes))
	}
	// 舊 backup code 唔應該再 match
	if auth.ValidateBackupCode(auth.HashCode(reg.BackupCodes[0]), oldHashes) >= 0 {
		t.Fatal("regenerated code should not match old hashes")
	}
}

func TestTwoFARegenerateWrongCode(t *testing.T) {
	h := newTestAuthHandler(t)
	ctx := sessionContext("test@example.com")
	enable2FA(t, h, ctx)

	w := call(t, h.TwoFARegenerateBackupCodes, ctx, TwoFARegenerateRequest{Code: "000000"})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

func TestVerify2FAWithTOTP(t *testing.T) {
	h := newTestAuthHandler(t)

	secret := auth.GenerateSecret()
	plain, hashed := auth.GenerateBackupCodes()
	_ = plain
	if err := h.storage.SaveTwoFA(&storage.TwoFA{
		OwnerEmail:   "user@example.com",
		Secret:       secret,
		BackupHashes: hashed,
	}); err != nil {
		t.Fatalf("SaveTwoFA: %v", err)
	}

	challenge := h.pendingLogin.Create(&auth.PendingLogin{
		Email: "user@example.com", Password: "pw",
		IMAPHost: "imap.example.com", SMTPHost: "smtp.example.com",
		IMAPPort: 993, SMTPPort: 587,
	})

	code, _ := totp.GenerateCode(secret, time.Now())
	w := call(t, h.Verify2FA, nil, Verify2FARequest{Challenge: challenge, Code: code})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}

	// challenge 已消耗
	if h.pendingLogin.Get(challenge) != nil {
		t.Fatal("challenge should be consumed after successful verify")
	}
}

func TestVerify2FAWithBackupCodeConsumesIt(t *testing.T) {
	h := newTestAuthHandler(t)

	secret := auth.GenerateSecret()
	plain, hashed := auth.GenerateBackupCodes()
	if err := h.storage.SaveTwoFA(&storage.TwoFA{
		OwnerEmail:   "user@example.com",
		Secret:       secret,
		BackupHashes: hashed,
	}); err != nil {
		t.Fatalf("SaveTwoFA: %v", err)
	}

	challenge := h.pendingLogin.Create(&auth.PendingLogin{
		Email: "user@example.com", Password: "pw",
		IMAPHost: "imap.example.com", SMTPHost: "smtp.example.com",
		IMAPPort: 993, SMTPPort: 587,
	})

	w := call(t, h.Verify2FA, nil, Verify2FARequest{Challenge: challenge, Code: plain[0]})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}

	// backup code 已消耗：hashes 少一個
	tf, _ := h.storage.GetTwoFA("user@example.com")
	if len(tf.BackupHashes) != auth.BackupCodeCount-1 {
		t.Fatalf("hashes after backup use = %d, want %d", len(tf.BackupHashes), auth.BackupCodeCount-1)
	}
	if auth.ValidateBackupCode(plain[0], tf.BackupHashes) >= 0 {
		t.Fatal("used backup code should no longer validate")
	}
}

func TestVerify2FAInvalidCode(t *testing.T) {
	h := newTestAuthHandler(t)
	secret := auth.GenerateSecret()
	if err := h.storage.SaveTwoFA(&storage.TwoFA{
		OwnerEmail:   "user@example.com",
		Secret:       secret,
		BackupHashes: []string{},
	}); err != nil {
		t.Fatalf("SaveTwoFA: %v", err)
	}

	challenge := h.pendingLogin.Create(&auth.PendingLogin{
		Email: "user@example.com", Password: "pw",
		IMAPHost: "imap.example.com", SMTPHost: "smtp.example.com",
		IMAPPort: 993, SMTPPort: 587,
	})

	w := call(t, h.Verify2FA, nil, Verify2FARequest{Challenge: challenge, Code: "000000"})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
	pl := h.pendingLogin.Get(challenge)
	if pl == nil || pl.FailedAttempts != 1 {
		t.Fatalf("FailedAttempts = %+v, want 1", pl)
	}
}

func TestVerify2FAUnknownChallenge(t *testing.T) {
	h := newTestAuthHandler(t)
	w := call(t, h.Verify2FA, nil, Verify2FARequest{Challenge: "nope", Code: "123456"})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

func TestVerify2FAWhenNotEnabled(t *testing.T) {
	h := newTestAuthHandler(t)
	challenge := h.pendingLogin.Create(&auth.PendingLogin{Email: "user@example.com"})
	w := call(t, h.Verify2FA, nil, Verify2FARequest{Challenge: challenge, Code: "123456"})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

func TestLoginRateLimited(t *testing.T) {
	h := newTestAuthHandler(t)
	for i := 0; i < loginMaxIP; i++ {
		h.pwLimiter.RecordFailure("login:ip:192.0.2.1")
	}
	w := call(t, h.Login, nil, LoginRequest{
		Email: "a@b.com", Password: "x", IMAPHost: "imap.example.com", SMTPHost: "smtp.example.com",
	})
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429 body=%s", w.Code, w.Body.String())
	}
}
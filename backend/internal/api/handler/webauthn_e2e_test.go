package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/descope/virtualwebauthn"

	"github.com/johnwmail/e2mail/backend/internal/auth"
)

const (
	e2eRPID     = "example.com"
	e2eRPOrigin = "https://example.com"
	e2eRPName   = "e2Mail"
	e2eEmail    = "passkey@example.com"
)

func e2eRP() virtualwebauthn.RelyingParty {
	return virtualwebauthn.RelyingParty{Name: e2eRPName, ID: e2eRPID, Origin: e2eRPOrigin}
}

// doRaw 送出 raw JSON body（attestation / assertion），唔會再 encode 多層
func doRaw(t *testing.T, handler http.HandlerFunc, ctx context.Context, target, raw string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, target, strings.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	if ctx != nil {
		req = req.WithContext(ctx)
	}
	rec := httptest.NewRecorder()
	handler(rec, req)
	return rec
}

func decodeBegin(t *testing.T, w *httptest.ResponseRecorder) (string, string) {
	t.Helper()
	success, data := decodeStandard(t, w)
	if !success {
		t.Fatalf("begin failed (%d): %s", w.Code, w.Body.String())
	}
	var resp struct {
		Challenge string          `json:"challenge"`
		PublicKey json.RawMessage `json:"publicKey"`
	}
	if err := json.Unmarshal(data, &resp); err != nil {
		t.Fatalf("decode begin: %v", err)
	}
	if resp.Challenge == "" || len(resp.PublicKey) == 0 {
		t.Fatalf("incomplete begin response: %s", data)
	}
	return resp.Challenge, string(resp.PublicKey)
}

// TestWebAuthnE2ERegisterThenLogin 用 virtual authenticator 走完整個
// register → login ceremony（經真正嘅 HTTP handlers 同 go-webauthn）。
func TestWebAuthnE2ERegisterThenLogin(t *testing.T) {
	h := newTestAuthHandlerWithWebAuthn(t)
	ctx := sessionContext(e2eEmail)
	rp := e2eRP()
	authenticator := virtualwebauthn.NewAuthenticator()
	cred := virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2)

	// ---- 1. 註冊 ----
	beginRec := doRaw(t, h.WebAuthnRegisterBegin, ctx, "/", "")
	ceremonyID, optionsJSON := decodeBegin(t, beginRec)

	attestationOpts, err := virtualwebauthn.ParseAttestationOptions(optionsJSON)
	if err != nil {
		t.Fatalf("ParseAttestationOptions: %v\noptions=%s", err, optionsJSON)
	}
	if attestationOpts.RelyingPartyID != e2eRPID {
		t.Fatalf("rp id = %q, want %q", attestationOpts.RelyingPartyID, e2eRPID)
	}
	attestationResponse := virtualwebauthn.CreateAttestationResponse(rp, authenticator, cred, *attestationOpts)

	finishRec := doRaw(
		t, h.WebAuthnRegisterFinish, ctx,
		"/2fa/webauthn/register/finish?challenge="+ceremonyID+"&name=E2E+key",
		attestationResponse,
	)
	if finishRec.Code != http.StatusOK {
		t.Fatalf("register finish status = %d: %s", finishRec.Code, finishRec.Body.String())
	}

	stored, err := h.storage.ListWebAuthnCredentials(e2eEmail)
	if err != nil || len(stored) != 1 {
		t.Fatalf("stored credentials = %d, err %v", len(stored), err)
	}
	if stored[0].Name != "E2E key" {
		t.Fatalf("stored name = %q", stored[0].Name)
	}

	// authenticator 記住呢個 credential 以便之後 assertion
	authenticator.AddCredential(cred)

	// ---- 2. 登入第二階段 ----
	pendingID := h.pendingLogin.Create(&auth.PendingLogin{
		Email:      e2eEmail,
		Username:   e2eEmail,
		Password:   "master-password",
		IMAPHost:   "127.0.0.1",
		IMAPPort:   1,
		IMAPUseTLS: true,
		SMTPHost:   "127.0.0.1",
		SMTPPort:   587,
		SMTPUseTLS: true,
	})

	loginBeginRec := call(t, h.WebAuthnLoginBegin, nil, map[string]string{"challenge": pendingID})
	loginCeremonyID, assertionOptionsJSON := decodeBegin(t, loginBeginRec)

	assertionOpts, err := virtualwebauthn.ParseAssertionOptions(assertionOptionsJSON)
	if err != nil {
		t.Fatalf("ParseAssertionOptions: %v\noptions=%s", err, assertionOptionsJSON)
	}
	found := authenticator.FindAllowedCredential(*assertionOpts)
	if found == nil {
		t.Fatal("virtual authenticator found no allowed credential")
	}
	assertionResponse := virtualwebauthn.CreateAssertionResponse(rp, authenticator, *found, *assertionOpts)

	verifyRec := doRaw(
		t, h.WebAuthnLoginVerify, nil,
		"/auth/webauthn/verify?challenge="+loginCeremonyID,
		assertionResponse,
	)
	if verifyRec.Code != http.StatusOK {
		t.Fatalf("login verify status = %d: %s", verifyRec.Code, verifyRec.Body.String())
	}

	// completeLogin 應該已建立 session 並回傳 token
	success, data := decodeStandard(t, verifyRec)
	if !success {
		t.Fatalf("login verify not successful: %s", verifyRec.Body.String())
	}
	var res LoginResponse
	if err := json.Unmarshal(data, &res); err != nil {
		t.Fatalf("decode LoginResponse: %v", err)
	}
	if res.Token == "" {
		t.Fatalf("no session token in response: %s", data)
	}
	if _, err := h.store.Get(res.Token); err != nil {
		t.Fatalf("session not found in store: %v", err)
	}
}

// TestWebAuthnE2EWrongChallenge 確認冇對應 ceremony 嘅 challenge 會失敗
func TestWebAuthnE2EWrongChallenge(t *testing.T) {
	h := newTestAuthHandlerWithWebAuthn(t)
	ctx := sessionContext(e2eEmail)
	rp := e2eRP()
	authenticator := virtualwebauthn.NewAuthenticator()
	cred := virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2)

	// 註冊一個 credential
	ceremonyID, optionsJSON := decodeBegin(t, doRaw(t, h.WebAuthnRegisterBegin, ctx, "/", ""))
	attestationOpts, err := virtualwebauthn.ParseAttestationOptions(optionsJSON)
	if err != nil {
		t.Fatalf("ParseAttestationOptions: %v", err)
	}
	resp := virtualwebauthn.CreateAttestationResponse(rp, authenticator, cred, *attestationOpts)
	if rec := doRaw(t, h.WebAuthnRegisterFinish, ctx, "/2fa/webauthn/register/finish?challenge="+ceremonyID, resp); rec.Code != http.StatusOK {
		t.Fatalf("register finish = %d: %s", rec.Code, rec.Body.String())
	}

	// 重用同一個 challenge（已消耗）→ 應失敗
	if rec := doRaw(t, h.WebAuthnRegisterFinish, ctx, "/2fa/webauthn/register/finish?challenge="+ceremonyID, resp); rec.Code == http.StatusOK {
		t.Fatal("reused (single-use) challenge must not succeed")
	}

	// 未存在嘅 ceremony → 401
	rec := doRaw(t, h.WebAuthnLoginVerify, nil, "/auth/webauthn/verify?challenge=does-not-exist", "{}")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unknown ceremony status = %d, want 401", rec.Code)
	}
}

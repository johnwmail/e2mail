package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/johnwmail/e2mail/backend/internal/api/middleware"
	"github.com/johnwmail/e2mail/backend/internal/auth"
	"github.com/johnwmail/e2mail/backend/internal/config"
	"github.com/johnwmail/e2mail/backend/internal/session"
	"github.com/johnwmail/e2mail/backend/internal/storage"
)

func newTestAuthHandlerWithWebAuthn(t *testing.T) *AuthHandler {
	t.Helper()
	h := newTestAuthHandler(t)
	h.cfg = &config.ServerConfig{
		WebAuthn: &config.WebAuthnConfig{
			RPID:      "example.com",
			RPName:    "e2Mail",
			RPOrigins: []string{"https://example.com"},
		},
	}
	svc, err := auth.NewWebAuthnService("example.com", "e2Mail", []string{"https://example.com"})
	if err != nil {
		t.Fatalf("NewWebAuthnService: %v", err)
	}
	h.SetWebAuthnService(svc)
	return h
}

func TestWebAuthnRegisterBeginDisabled(t *testing.T) {
	h := newTestAuthHandler(t) // cfg nil, service nil
	w := call(t, h.WebAuthnRegisterBegin, sessionContext("a@b.c"), nil)
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", w.Code)
	}
}

func TestWebAuthnRegisterBegin(t *testing.T) {
	h := newTestAuthHandlerWithWebAuthn(t)
	w := call(t, h.WebAuthnRegisterBegin, sessionContext("a@b.c"), nil)
	success, data := decodeStandard(t, w)
	if !success {
		t.Fatalf("begin registration failed: %s", w.Body.String())
	}
	var resp struct {
		Challenge string          `json:"challenge"`
		PublicKey json.RawMessage `json:"publicKey"`
	}
	if err := json.Unmarshal(data, &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Challenge == "" {
		t.Fatal("challenge empty")
	}
	if !bytes.Contains(resp.PublicKey, []byte(`"challenge"`)) {
		t.Fatalf("publicKey missing challenge: %s", resp.PublicKey)
	}
}

func TestWebAuthnList(t *testing.T) {
	h := newTestAuthHandlerWithWebAuthn(t)
	if err := h.storage.CreateWebAuthnCredential(&storage.WebAuthnCredential{
		OwnerEmail:     "a@b.c",
		CredentialID:   "AQID",
		Name:           "My Phone",
		CredentialJSON: `{"id":"AQID","publicKey":"BAUG"}`,
	}); err != nil {
		t.Fatalf("seed credential: %v", err)
	}

	w := call(t, h.WebAuthnList, sessionContext("a@b.c"), nil)
	success, data := decodeStandard(t, w)
	if !success {
		t.Fatalf("list failed: %s", w.Body.String())
	}
	var resp struct {
		Credentials []webAuthnCredentialDTO `json:"credentials"`
	}
	if err := json.Unmarshal(data, &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(resp.Credentials) != 1 || resp.Credentials[0].ID != "AQID" || resp.Credentials[0].Name != "My Phone" {
		t.Fatalf("unexpected list: %+v", resp.Credentials)
	}

	// 唔可以見到其他 owner 嘅 passkey
	w = call(t, h.WebAuthnList, sessionContext("other@x.com"), nil)
	_, data = decodeStandard(t, w)
	_ = json.Unmarshal(data, &resp)
	if len(resp.Credentials) != 0 {
		t.Fatalf("other owner saw %d credentials", len(resp.Credentials))
	}
}

func TestWebAuthnRenameAndDelete(t *testing.T) {
	h := newTestAuthHandlerWithWebAuthn(t)
	if err := h.storage.CreateWebAuthnCredential(&storage.WebAuthnCredential{
		OwnerEmail:     "a@b.c",
		CredentialID:   "AQID",
		Name:           "Old",
		CredentialJSON: `{"id":"AQID","publicKey":"BAUG"}`,
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	r := chi.NewRouter()
	r.Patch("/2fa/webauthn/{id}", h.WebAuthnRename)
	r.Delete("/2fa/webauthn/{id}", h.WebAuthnDelete)

	do := func(method, url string, body any) *httptest.ResponseRecorder {
		var buf bytes.Buffer
		if body != nil {
			_ = json.NewEncoder(&buf).Encode(body)
		}
		req := httptest.NewRequest(method, url, &buf)
		req = req.WithContext(context.WithValue(context.Background(), middleware.SessionContextKey, &session.Session{Email: "a@b.c"}))
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec
	}

	// rename
	rec := do(http.MethodPatch, "/2fa/webauthn/AQID", map[string]string{"name": "New Name"})
	if rec.Code != http.StatusOK {
		t.Fatalf("rename status = %d (%s)", rec.Code, rec.Body.String())
	}
	got, _ := h.storage.GetWebAuthnCredential("a@b.c", "AQID")
	if got == nil || got.Name != "New Name" {
		t.Fatalf("name not updated: %+v", got)
	}

	// rename unknown -> 404
	if rec := do(http.MethodPatch, "/2fa/webauthn/nope", map[string]string{"name": "x"}); rec.Code != http.StatusNotFound {
		t.Fatalf("rename unknown status = %d, want 404", rec.Code)
	}

	// delete
	if rec := do(http.MethodDelete, "/2fa/webauthn/AQID", nil); rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d (%s)", rec.Code, rec.Body.String())
	}
	if got, _ := h.storage.GetWebAuthnCredential("a@b.c", "AQID"); got != nil {
		t.Fatal("credential still present after delete")
	}
}

func TestWebAuthnLoginBeginUnknownChallenge(t *testing.T) {
	h := newTestAuthHandlerWithWebAuthn(t)
	w := call(t, h.WebAuthnLoginBegin, nil, map[string]string{"challenge": "does-not-exist"})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

func TestWebAuthnLoginBeginDisabled(t *testing.T) {
	h := newTestAuthHandler(t)
	w := call(t, h.WebAuthnLoginBegin, nil, map[string]string{"challenge": "x"})
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", w.Code)
	}
}

func TestWebAuthnLoginVerifyMissingChallenge(t *testing.T) {
	h := newTestAuthHandlerWithWebAuthn(t)
	w := call(t, h.WebAuthnLoginVerify, nil, nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

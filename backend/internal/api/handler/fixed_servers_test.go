package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/johnwmail/e2mail/backend/internal/config"
)

func TestApplyFixedServersOverridesClientValues(t *testing.T) {
	h := &AuthHandler{cfg: &config.ServerConfig{
		DefaultIMAPHost:         "imap.example.com",
		DefaultIMAPPort:         993,
		DefaultSMTPHost:         "smtp.example.com",
		DefaultSMTPPort:         587,
		DefaultAllowInsecureTLS: false,
	}}
	req := LoginRequest{
		IMAPHost:             "evil.internal",
		IMAPPort:             1,
		IMAPAllowInsecureTLS: true,
		SMTPHost:             "evil.internal",
		SMTPPort:             25,
		SMTPAllowInsecureTLS: true,
	}

	h.applyFixedServers(&req)

	if req.IMAPHost != "imap.example.com" || req.IMAPPort != 993 {
		t.Errorf("IMAP = %s:%d, want imap.example.com:993", req.IMAPHost, req.IMAPPort)
	}
	if req.SMTPHost != "smtp.example.com" || req.SMTPPort != 587 {
		t.Errorf("SMTP = %s:%d, want smtp.example.com:587", req.SMTPHost, req.SMTPPort)
	}
	if req.IMAPAllowInsecureTLS || req.SMTPAllowInsecureTLS {
		t.Error("fixed servers must use the deployment TLS policy")
	}
}

func TestApplyFixedServersNoopWhenOnlyOneHostConfigured(t *testing.T) {
	h := &AuthHandler{cfg: &config.ServerConfig{DefaultIMAPHost: "imap.example.com"}}
	req := LoginRequest{IMAPHost: "custom.example", IMAPPort: 143, SMTPHost: "smtp.example", SMTPPort: 587}

	h.applyFixedServers(&req)

	if req.IMAPHost != "custom.example" || req.SMTPHost != "smtp.example" {
		t.Fatalf("incomplete defaults must not lock the form: %#v", req)
	}
}

func TestServerConfigReportsFixedServers(t *testing.T) {
	h := NewServerConfigHandler(&config.ServerConfig{
		DefaultIMAPHost: "imap.example.com",
		DefaultIMAPPort: 993,
		DefaultSMTPHost: "smtp.example.com",
		DefaultSMTPPort: 587,
	})
	rec := httptest.NewRecorder()
	h.Get(rec, httptest.NewRequest(http.MethodGet, "/api/server-config", nil))

	var body struct {
		Success bool `json:"success"`
		Data    struct {
			FixedServers bool `json:"fixedServers"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !body.Success || !body.Data.FixedServers {
		t.Fatalf("fixedServers missing: %s", rec.Body.String())
	}
}

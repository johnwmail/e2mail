package handler

import (
	"testing"

	"github.com/johnwmail/e2mail/backend/internal/config"
)

// 客戶端傳入 allowInsecureTls=true 在伺服器策略為 false 時必須被忽略。
func TestApplyTLSPolicyIgnoresClientInsecureFlagWhenServerDisallows(t *testing.T) {
	h := &AuthHandler{cfg: &config.ServerConfig{DefaultAllowInsecureTLS: false}}
	req := LoginRequest{IMAPAllowInsecureTLS: true, SMTPAllowInsecureTLS: true}

	h.applyTLSPolicy(&req)

	if req.IMAPAllowInsecureTLS || req.SMTPAllowInsecureTLS {
		t.Fatal("client-supplied insecure TLS flag must be ignored when server policy disallows it")
	}
}

// 伺服器策略允許時，旗標跟隨伺服器設定（唔係客戶端）。
func TestApplyTLSPolicyFollowsServerPolicy(t *testing.T) {
	h := &AuthHandler{cfg: &config.ServerConfig{DefaultAllowInsecureTLS: true}}
	req := LoginRequest{IMAPAllowInsecureTLS: false, SMTPAllowInsecureTLS: false}

	h.applyTLSPolicy(&req)

	if !req.IMAPAllowInsecureTLS || !req.SMTPAllowInsecureTLS {
		t.Fatal("insecure TLS flags should follow the server policy when it is enabled")
	}
}

// cfg 缺失時必須保守處理（不允許）。
func TestApplyTLSPolicyNilConfigIsStrict(t *testing.T) {
	h := &AuthHandler{}
	req := LoginRequest{IMAPAllowInsecureTLS: true, SMTPAllowInsecureTLS: true}

	h.applyTLSPolicy(&req)

	if req.IMAPAllowInsecureTLS || req.SMTPAllowInsecureTLS {
		t.Fatal("nil config must default to strict TLS verification")
	}
}
